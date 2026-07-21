import { describe, expect, it } from "vitest";
import { avgTurnoverCost, minMargin } from "../src/config.js";
import type { Reservation, TurnoverCost } from "../src/core/types.js";
import { generateMockReservations } from "../src/sources/mockReservations.js";
import {
  checkWindow,
  estimateTurnover,
  findBooking,
  gapNightReport,
  median,
  runGapNightCheck,
  type GapNightData,
} from "../src/tools/gapNightCheck.js";

const res = (id: string, propertyId: string, checkin: string, checkout: string): Reservation => ({
  reservation_id: id,
  property_id: propertyId,
  checkin,
  checkout,
  nights: 2,
  gross_revenue: 200,
});

const cost = (id: string, cleaning: number, travel: number, laundry: number): TurnoverCost => ({
  reservation_id: id,
  cleaning_cost: cleaning,
  travel_cost: travel,
  laundry_cost: laundry,
});

const DATE = "2026-08-15";
const W = checkWindow(DATE);

/** Planin esimerkkiluvut: vaihto 70 + matka 23 + kate 25 → lattia 118 €. */
const baseData = (over: Partial<GapNightData> = {}): GapNightData => ({
  reservations: [res("r1", "p1", "2026-08-10", "2026-08-12")],
  costRows: [cost("r1", 55, 23, 15)],
  from: W.from,
  to: W.to,
  minMargin: 25,
  manualAvg: 70,
  ...over,
});

describe("config-helperit", () => {
  it("minMargin: oletus 25, env-arvo voittaa", () => {
    expect(minMargin({} as NodeJS.ProcessEnv)).toBe(25);
    expect(minMargin({ MIN_MARGIN: "40" } as NodeJS.ProcessEnv)).toBe(40);
  });

  it("minMargin: kelvoton arvo kaatuu selkeästi", () => {
    expect(() => minMargin({ MIN_MARGIN: "abc" } as NodeJS.ProcessEnv)).toThrow(/MIN_MARGIN/);
    expect(() => minMargin({ MIN_MARGIN: "-5" } as NodeJS.ProcessEnv)).toThrow(/MIN_MARGIN/);
  });

  it("avgTurnoverCost: oletus 70, kelvoton kaatuu", () => {
    expect(avgTurnoverCost({} as NodeJS.ProcessEnv)).toBe(70);
    expect(avgTurnoverCost({ AVG_TURNOVER_COST: "85" } as NodeJS.ProcessEnv)).toBe(85);
    expect(() => avgTurnoverCost({ AVG_TURNOVER_COST: "x" } as NodeJS.ProcessEnv)).toThrow(
      /AVG_TURNOVER_COST/,
    );
  });
});

describe("checkWindow", () => {
  it("laskee ikkunan [date−45, date+15]", () => {
    expect(checkWindow("2026-08-15")).toEqual({ from: "2026-07-01", to: "2026-08-30" });
  });

  it("kaatuu selkeästi virheelliseen päivämäärään", () => {
    expect(() => checkWindow("15.8.2026")).toThrow(/YYYY-MM-DD/);
  });
});

describe("median", () => {
  it("pariton, parillinen ja tyhjä", () => {
    expect(median([70])).toBe(70);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("estimateTurnover", () => {
  it("mediaani cleaning+laundry ja travel erikseen", () => {
    const rows = [cost("a", 55, 23, 15), cost("b", 60, 10, 20), cost("c", 40, 30, 10)];
    // cleaning+laundry: [70, 80, 50] → 70; travel: [23, 10, 30] → 23
    expect(estimateTurnover(rows, 99)).toEqual({
      turnover: 70,
      travel: 23,
      fromRows: true,
      rowCount: 3,
    });
  });

  it("ilman rivejä manual-keskiarvo, matka 0", () => {
    expect(estimateTurnover([], 70)).toEqual({
      turnover: 70,
      travel: 0,
      fromRows: false,
      rowCount: 0,
    });
  });
});

describe("findBooking", () => {
  const r = res("r1", "p1", "2026-08-14", "2026-08-17");

  it("löytää yön kattavan varauksen; checkout-päivä on vapaa", () => {
    expect(findBooking([r], "p1", "2026-08-14")?.reservation_id).toBe("r1");
    expect(findBooking([r], "p1", "2026-08-16")?.reservation_id).toBe("r1");
    expect(findBooking([r], "p1", "2026-08-17")).toBeUndefined(); // checkout eksklusiivinen
    expect(findBooking([r], "p1", "2026-08-13")).toBeUndefined();
  });

  it("ei sekoita kohteita keskenään", () => {
    expect(findBooking([r], "p2", "2026-08-15")).toBeUndefined();
  });
});

describe("gapNightReport", () => {
  it("SKIP kun ehdokashinta alle lattian (planin esimerkki)", () => {
    const out = gapNightReport("p1", DATE, baseData({ candidatePrice: 96 }));
    expect(out).toContain("Floor €118 (turnover 70 + travel 23 + margin 25)");
    expect(out).toContain("candidate price €96");
    expect(out).toContain("→ SKIP — filling yields");
    expect(out).toContain("-€22"); // 96 − 118 = −22
  });

  it("FILL kun ehdokashinta yli lattian", () => {
    const out = gapNightReport("p1", DATE, baseData({ candidatePrice: 150 }));
    expect(out).toContain("→ FILL — filling yields +€32");
  });

  it("FILL kun ehdokashinta täsmälleen lattialla", () => {
    const out = gapNightReport("p1", DATE, baseData({ candidatePrice: 118 }));
    expect(out).toContain("→ FILL — filling yields +€0");
  });

  it("recommendedPrice toimii WH-suosituksena kun candidatea ei ole (askel 3 -kytkentä)", () => {
    const out = gapNightReport(
      "p1",
      DATE,
      baseData({ recommendedPrice: 130, whKeyPresent: true }),
    );
    expect(out).toContain("WH recommendation €130");
    expect(out).toContain("→ FILL — filling yields +€12");
  });

  it("candidate_price voittaa WH-suosituksen", () => {
    const out = gapNightReport(
      "p1",
      DATE,
      baseData({ candidatePrice: 96, recommendedPrice: 130 }),
    );
    expect(out).toContain("candidate price €96");
    expect(out).toContain("→ SKIP");
  });

  it("varattu päivä → kertoo varauksen eikä anna verdiktiä", () => {
    const data = baseData({
      reservations: [res("r1", "p1", "2026-08-10", "2026-08-12"), res("r2", "p1", "2026-08-14", "2026-08-17")],
      candidatePrice: 96,
    });
    const out = gapNightReport("p1", DATE, data);
    expect(out).toContain("Not a gap night — booking r2 (2026-08-14 – 2026-08-17) covers the night of 2026-08-15");
    expect(out).not.toMatch(/→ (FILL|SKIP)/);
  });

  it("tuntematon kohde → virhe joka listaa tunnetut kohteet (max 10)", () => {
    const reservations = Array.from({ length: 12 }, (_, i) =>
      res(`r${i}`, `p${String(i + 1).padStart(2, "0")}`, "2026-08-01", "2026-08-03"),
    );
    let message = "";
    try {
      gapNightReport("ei-ole", DATE, baseData({ reservations }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('Property "ei-ole" not found');
    expect(message).toContain("p01");
    expect(message).toContain("p10");
    expect(message).not.toContain("p11");
    expect(message).toContain("10 of 12");
    expect(message).toContain("property_id");
  });

  it("tyhjä varausdata → selkeä virhe", () => {
    expect(() => gapNightReport("p1", DATE, baseData({ reservations: [] }))).toThrow(
      /No reservations/,
    );
  });

  it("ilman hintaa ja ilman WH-avainta → pelkkä lattia + candidate_price-ohje", () => {
    const out = gapNightReport("p1", DATE, baseData());
    expect(out).toContain("Floor €118");
    expect(out).toContain("Provide candidate_price");
    expect(out).not.toMatch(/→ (FILL|SKIP)/);
  });

  it("WH-avain ilman hintaa → rehellinen viesti kytkennästä", () => {
    const out = gapNightReport("p1", DATE, baseData({ whKeyPresent: true }));
    expect(out).toContain("Floor €118");
    expect(out).toContain("The WH price recommendation will be wired in once the WH reservation adapter is ready — provide candidate_price");
  });

  it("ilman kustannusrivejä → manual-keskiarvo näkyy vaihtoarviossa", () => {
    const out = gapNightReport("p1", DATE, baseData({ costRows: [], candidatePrice: 100 }));
    expect(out).toContain("no cost rows → manual average €70");
    expect(out).toContain("Floor €95 (turnover 70 + travel 0 + margin 25)"); // 70 + 0 + 25
    expect(out).toContain("→ FILL — filling yields +€5");
  });
});

describe("runGapNightCheck (env injektoitu, mock-data + manual-kustannukset)", () => {
  const env = {} as NodeJS.ProcessEnv;

  /** Onko yö varattu, kun mock generoidaan samalla ikkunalla jonka tool laskee. */
  const isBooked = (propertyId: string, date: string): boolean => {
    const w = checkWindow(date);
    return Boolean(findBooking(generateMockReservations(w.from, w.to), propertyId, date));
  };

  // Mock-generaattori on ikkunariippumaton (kiinteä kalenteri + kiinteä
  // siemen) → kuvio on deterministinen; haetaan sopiva kohde+päivä datasta.
  const MOCK_PROPERTIES = [
    "demo-1br-01",
    "demo-1br-02",
    "demo-1br-03",
    "demo-2br-04",
    "demo-2br-05",
    "demo-2br-06",
    "demo-3br-07",
    "demo-3br-08",
  ];

  const findMockDate = (wantBooked: boolean): { property_id: string; date: string } => {
    for (let d = 1; d <= 28; d++) {
      const date = `2026-08-${String(d).padStart(2, "0")}`;
      for (const property_id of MOCK_PROPERTIES) {
        if (isBooked(property_id, date) === wantBooked) return { property_id, date };
      }
    }
    throw new Error("mock-datasta ei löytynyt sopivaa päivää");
  };

  it("tuntematon kohde → virhe listaa demo-kohteet", async () => {
    await expect(
      runGapNightCheck({ property_id: "tuntematon", date: DATE }, env),
    ).rejects.toThrow(/demo-1br-01/);
  });

  it("varattu päivä → Not a gap night", async () => {
    const { property_id, date } = findMockDate(true);
    const out = await runGapNightCheck({ property_id, date }, env);
    expect(out).toContain("Not a gap night");
    expect(out).toContain(property_id);
  });

  it("aukkoyö ilman hintaa → lattia €95 (manual 70 + matka 0 + kate 25) + ohje", async () => {
    const { property_id, date } = findMockDate(false);
    const out = await runGapNightCheck({ property_id, date }, env);
    expect(out).toContain("Floor €95 (turnover 70 + travel 0 + margin 25)");
    expect(out).toContain("Provide candidate_price");
  });

  it("aukkoyö + candidate_price → FILL/SKIP lattiaa vasten", async () => {
    const { property_id, date } = findMockDate(false);
    const fill = await runGapNightCheck({ property_id, date, candidate_price: 200 }, env);
    expect(fill).toContain("→ FILL");
    const skip = await runGapNightCheck({ property_id, date, candidate_price: 90 }, env);
    expect(skip).toContain("→ SKIP");
  });

  it("README-esimerkki: demo-1br-01 2026-06-23 on aukkoyö myös gap-checkin omassa ikkunassa", async () => {
    // Sama päivä näkyy aukkona analyze_portfolion kesäkuu-ikkunassa —
    // porautumispolku analyysistä aukkoon ei saa katketa (ikkunariippumattomuus).
    const out = await runGapNightCheck({ property_id: "demo-1br-01", date: "2026-06-23" }, env);
    expect(out).not.toContain("Not a gap night");
    expect(out).toContain("Floor €95"); // manual 70 + matka 0 + kate 25
  });

  it("kelvoton MIN_MARGIN kaatuu selkeästi", async () => {
    const { property_id, date } = findMockDate(false);
    await expect(
      runGapNightCheck({ property_id, date }, { MIN_MARGIN: "paljon" } as NodeJS.ProcessEnv),
    ).rejects.toThrow(/MIN_MARGIN/);
  });
});

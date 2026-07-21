import { describe, expect, it } from "vitest";
import { analyzePortfolio } from "../src/core/calc.js";
import { simulateFillGaps, simulateMinStayUplift } from "../src/core/simulate.js";
import type { Reservation, TurnoverCost } from "../src/core/types.js";
import { csvSource } from "../src/sources/csv.js";
import { manualSource } from "../src/sources/manual.js";
import { generateMockReservations } from "../src/sources/mockReservations.js";
import { countTurnovers, formatComparison } from "../src/tools/compareStrategies.js";

const res = (
  id: string,
  property: string,
  checkin: string,
  checkout: string,
  nights: number,
  gross: number,
): Reservation => ({
  reservation_id: id,
  property_id: property,
  checkin,
  checkout,
  nights,
  gross_revenue: gross,
});

const cost = (id: string, cleaning: number, travel = 0, laundry = 0): TurnoverCost => ({
  reservation_id: id,
  cleaning_cost: cleaning,
  travel_cost: travel,
  laundry_cost: laundry,
});

const costMap = (...costs: TurnoverCost[]) => new Map(costs.map((c) => [c.reservation_id, c]));

// Fixtuuri: 10 yön jakso [2026-07-01, 2026-07-11)
//   p1: r1 4 yötä (400 €), r2 2 yötä (200 €), r3 2 yötä (200 €)
//       → ADR = 800/8 = 100 €, varatut yöt 1.–4. + 7.–10. → aukot 5.7. ja 6.7.
//       → kustannusrivien totalit 100/60/80 → mediaani 80 €
//   p2: r4 10 yötä (1 500 €) → täynnä, ei aukkoja
const FROM = "2026-07-01";
const TO = "2026-07-11";
const fixture = () => ({
  reservations: [
    res("r1", "p1", "2026-07-01", "2026-07-05", 4, 400),
    res("r2", "p1", "2026-07-07", "2026-07-09", 2, 200),
    res("r3", "p1", "2026-07-09", "2026-07-11", 2, 200),
    res("r4", "p2", "2026-07-01", "2026-07-11", 10, 1500),
  ],
  costs: costMap(cost("r1", 70, 20, 10), cost("r2", 40, 10, 10), cost("r3", 60, 10, 10), cost("r4", 70, 10, 10)),
});

describe("simulateFillGaps", () => {
  it("lisää täsmälleen aukkoyön varauksen per aukko oikeilla arvoilla", () => {
    const { reservations, costs } = fixture();
    const sim = simulateFillGaps(reservations, costs, FROM, TO);

    expect(sim.reservations).toHaveLength(6); // 4 alkuperäistä + 2 aukkoa
    const gaps = sim.reservations.filter((r) => r.reservation_id.startsWith("gap-"));
    expect(gaps.map((g) => g.reservation_id).sort()).toEqual([
      "gap-p1-2026-07-05",
      "gap-p1-2026-07-06",
    ]);
    // synteettinen varaus: 1 yö, hinta ADR × (1 − 40/100) = 100 × 0,6 = 60 €
    expect(gaps[0]).toEqual({
      reservation_id: "gap-p1-2026-07-05",
      property_id: "p1",
      checkin: "2026-07-05",
      checkout: "2026-07-06",
      nights: 1,
      gross_revenue: 60,
    });
  });

  it("antaa aukkoyölle kohteen kustannusrivien mediaanin (koko summa cleaning_costiin)", () => {
    const { reservations, costs } = fixture();
    const sim = simulateFillGaps(reservations, costs, FROM, TO);

    expect(sim.costs.size).toBe(6);
    // p1:n totalit 100/60/80 → mediaani 80
    expect(sim.costs.get("gap-p1-2026-07-05")).toEqual({
      reservation_id: "gap-p1-2026-07-05",
      cleaning_cost: 80,
      travel_cost: 0,
      laundry_cost: 0,
    });
  });

  it("kunnioittaa discountPct-optiota", () => {
    const { reservations, costs } = fixture();
    const sim = simulateFillGaps(reservations, costs, FROM, TO, { discountPct: 20 });
    expect(sim.reservations.find((r) => r.reservation_id === "gap-p1-2026-07-05")!.gross_revenue).toBeCloseTo(80);
  });

  it("ei lisää mitään täynnä olevalle kohteelle", () => {
    const { reservations, costs } = fixture();
    const sim = simulateFillGaps(reservations, costs, FROM, TO);
    expect(sim.reservations.some((r) => r.reservation_id.startsWith("gap-p2"))).toBe(false);
  });

  it("ohittaa kohteen jonka varaukset eivät osu jaksolle", () => {
    const { reservations, costs } = fixture();
    reservations.push(res("r5", "p3", "2026-06-01", "2026-06-05", 4, 300));
    costs.set("r5", cost("r5", 50));
    const sim = simulateFillGaps(reservations, costs, FROM, TO);
    // r5 säilyy sellaisenaan, mutta p3:lle ei synny synteettisiä öitä (ei ADR:ää jaksolta)
    expect(sim.reservations).toContain(reservations[4]);
    expect(sim.reservations.some((r) => r.reservation_id.startsWith("gap-p3"))).toBe(false);
  });

  it("ei mutatoi inputteja", () => {
    const { reservations, costs } = fixture();
    const beforeRes = structuredClone(reservations);
    const beforeCosts = structuredClone([...costs.entries()]);
    const sim = simulateFillGaps(reservations, costs, FROM, TO);
    expect(reservations).toEqual(beforeRes);
    expect([...costs.entries()]).toEqual(beforeCosts);
    expect(sim.reservations).not.toBe(reservations);
    expect(sim.costs).not.toBe(costs);
  });

  it("tuottaa käsin lasketut totalit analyysissä", () => {
    const { reservations, costs } = fixture();
    const base = analyzePortfolio(reservations, costs, FROM, TO);
    // baseline: brutto 2 300, kustannukset 100+60 (r3/r4 checkout 11.7. = to → ei jaksolla),
    // netto 2 140, 18/20 yötä → 107 €/yö, käyttöaste 90 %
    expect(base.totals.gross).toBe(2300);
    expect(base.totals.costs).toBe(160);
    expect(base.totals.net_per_available_night).toBeCloseTo(107);
    expect(base.totals.occupancy_pct).toBeCloseTo(90);

    const sim = simulateFillGaps(reservations, costs, FROM, TO);
    const a = analyzePortfolio(sim.reservations, sim.costs, FROM, TO);
    // + 2 × 60 € bruttoa, + 2 × 80 € kustannuksia (molempien aukkojen checkout jaksolla)
    // → brutto 2 420, kust. 320, netto 2 100 → 105 €/yö, käyttöaste 100 %
    expect(a.totals.gross).toBeCloseTo(2420);
    expect(a.totals.costs).toBe(320);
    expect(a.totals.net).toBeCloseTo(2100);
    expect(a.totals.net_per_available_night).toBeCloseTo(105);
    expect(a.totals.occupancy_pct).toBe(100);
    // demon ydin pienoiskoossa: käyttöaste +10 pp, netto/yö −2 €
    expect(a.totals.net).toBeLessThan(base.totals.net);
    // aukkotäytöt 60 € − 80 € = −20 €/kpl → vuoto kasvaa 40 €
    expect(a.leak_eur).toBeCloseTo(base.leak_eur + 40);
  });

  it("ei täytä jakson viimeistä yötä — kustannus jäisi jakson ulkopuolelle", () => {
    // p3: varaus 1.–10.7., ainoa aukko on jakson viimeinen yö 10.7.
    // Sen täytön checkout olisi 11.7. == to → analyysi laskisi tuoton mutta
    // ei kustannusta eikä vuotoa → yö jätetään täyttämättä (symmetria).
    const reservations = [res("r1", "p3", "2026-07-01", "2026-07-10", 9, 900)];
    const costs = costMap(cost("r1", 80, 10, 10));
    const sim = simulateFillGaps(reservations, costs, FROM, TO);
    expect(sim.reservations).toHaveLength(1);
    expect(sim.costs.size).toBe(1);
    const base = analyzePortfolio(reservations, costs, FROM, TO);
    const a = analyzePortfolio(sim.reservations, sim.costs, FROM, TO);
    expect(a.totals.net).toBe(base.totals.net);
    expect(a.leak_eur).toBe(base.leak_eur);
  });

  it("täyttää aukot myös kohteelle jonka ainoan varauksen checkout == from (sama sääntö kuin analyysissä)", () => {
    // checkout == from: 0 yötä jaksolla mutta vaihto jaksolla → analyysi näkee
    // kohteen periodNights aukkoyöllä, joten myös simulaatio täyttää ne.
    const reservations = [res("r1", "p4", "2026-06-27", "2026-07-01", 4, 400)];
    const costs = costMap(cost("r1", 80));
    const sim = simulateFillGaps(reservations, costs, FROM, TO);
    const gaps = sim.reservations.filter((r) => r.reservation_id.startsWith("gap-p4"));
    expect(gaps).toHaveLength(9); // 10 yön jakso − täyttämätön viimeinen yö
  });

  it("hylkää kelvottoman alennuksen ja väärinpäin olevan jakson", () => {
    const { reservations, costs } = fixture();
    expect(() => simulateFillGaps(reservations, costs, FROM, TO, { discountPct: 150 })).toThrow(/discountPct/);
    expect(() => simulateFillGaps(reservations, costs, TO, FROM)).toThrow(/jälkeen/);
  });
});

describe("simulateMinStayUplift", () => {
  it("pudottaa lyhyet varaukset kustannusriveineen ja korottaa loput", () => {
    const { reservations, costs } = fixture();
    const sim = simulateMinStayUplift(reservations, costs, FROM, TO);

    // minStay 3 → r2 ja r3 (2 yötä) pois; r1 ja r4 jäävät +10 %:lla
    expect(sim.reservations.map((r) => r.reservation_id)).toEqual(["r1", "r4"]);
    expect(sim.reservations[0].gross_revenue).toBeCloseTo(440);
    expect(sim.reservations[1].gross_revenue).toBeCloseTo(1650);
    expect([...sim.costs.keys()].sort()).toEqual(["r1", "r4"]);
    expect(sim.costs.get("r1")).toEqual(costs.get("r1"));
  });

  it("kunnioittaa minStay- ja upliftPct-optioita", () => {
    const { reservations, costs } = fixture();
    const sim = simulateMinStayUplift(reservations, costs, FROM, TO, { minStay: 5, upliftPct: 20 });
    expect(sim.reservations.map((r) => r.reservation_id)).toEqual(["r4"]);
    expect(sim.reservations[0].gross_revenue).toBeCloseTo(1800);
  });

  it("ei mutatoi inputteja", () => {
    const { reservations, costs } = fixture();
    const beforeRes = structuredClone(reservations);
    const sim = simulateMinStayUplift(reservations, costs, FROM, TO);
    expect(reservations).toEqual(beforeRes);
    expect(reservations[0].gross_revenue).toBe(400); // korotus ei vuotanut alkuperäiseen
    expect(sim.reservations[0]).not.toBe(reservations[0]);
  });

  it("tuottaa käsin lasketut totalit analyysissä", () => {
    const { reservations, costs } = fixture();
    const sim = simulateMinStayUplift(reservations, costs, FROM, TO);
    const b = analyzePortfolio(sim.reservations, sim.costs, FROM, TO);
    // brutto 440 + 1 650 = 2 090; kustannukset vain r1 (100); netto 1 990 → 99,5 €/yö
    expect(b.totals.gross).toBeCloseTo(2090);
    expect(b.totals.costs).toBe(100);
    expect(b.totals.net_per_available_night).toBeCloseTo(99.5);
    expect(b.totals.occupancy_pct).toBeCloseTo(70); // 14/20 yötä
  });

  it("hylkää kelvottomat optiot", () => {
    const { reservations, costs } = fixture();
    expect(() => simulateMinStayUplift(reservations, costs, FROM, TO, { minStay: 0 })).toThrow(/minStay/);
    expect(() => simulateMinStayUplift(reservations, costs, FROM, TO, { upliftPct: -100 })).toThrow(/upliftPct/);
  });
});

describe("countTurnovers", () => {
  it("laskee jaksolle osuvat varaukset — myös checkout jakson alussa", () => {
    const { reservations } = fixture();
    expect(countTurnovers(reservations, FROM, TO)).toBe(4);
    // checkout täsmälleen jakson alussa → vaihto osuu jaksolle vaikka öitä ei
    reservations.push(res("r0", "p1", "2026-06-28", "2026-07-01", 3, 300));
    expect(countTurnovers(reservations, FROM, TO)).toBe(5);
    expect(countTurnovers(reservations, "2026-08-01", "2026-08-11")).toBe(0);
  });
});

describe("formatComparison", () => {
  it("renderöi taulukon, delta-lauseet ja jännitteen", () => {
    const { reservations, costs } = fixture();
    const base = analyzePortfolio(reservations, costs, FROM, TO);
    const simA = simulateFillGaps(reservations, costs, FROM, TO);
    const a = analyzePortfolio(simA.reservations, simA.costs, FROM, TO);
    const simB = simulateMinStayUplift(reservations, costs, FROM, TO);
    const b = analyzePortfolio(simB.reservations, simB.costs, FROM, TO);

    const text = formatComparison(
      [
        { label: "Baseline", analysis: base, turnovers: countTurnovers(reservations, FROM, TO) },
        { label: "A: täytä aukkoyöt (ale 40 %)", analysis: a, turnovers: countTurnovers(simA.reservations, FROM, TO) },
        { label: "B: min-stay 3 yötä + hinnat +10 %", analysis: b, turnovers: countTurnovers(simB.reservations, FROM, TO) },
      ],
      FROM,
      TO,
      "manual (testi)",
      "varaukset: fixtuuri",
    );

    expect(text).toContain("## Strategiavertailu 2026-07-01 → 2026-07-11");
    expect(text).toContain("| Skenaario | Brutto | Netto | Netto/yö | Käyttöaste | Vaihdot | Vuoto |");
    expect(text).toContain("**A** nostaa käyttöastetta +10,0 pp mutta netto/yö muuttuu −2 €");
    expect(text).toContain("**B** laskee käyttöastetta");
    // fixtuurissa A: brutto +120 €, netto −40 € → ydinviesti mukana
    expect(text).toContain("bruttoa optimoiva täyttö on nettona tappio");
    expect(text).toContain("**Yhteenveto:** Paras netto/yö: Baseline");
  });
});

describe("demon jännite mock-datalla (40 % ale)", () => {
  const from = "2026-06-01";
  const to = "2026-07-01";

  it("CSV-kustannuksilla täyttö nostaa bruttoa mutta laskee nettoa", async () => {
    const reservations = generateMockReservations(from, to);
    // EI fallbackia: koko vuoden kattava sample-CSV osuu joka id:hin —
    // getCosts heittäisi jos CSV ja mock-portfolio eriytyisivät.
    const costs = await csvSource({ path: "examples/sample-costs.csv" }).getCosts(reservations);
    const base = analyzePortfolio(reservations, costs, from, to);
    const sim = simulateFillGaps(reservations, costs, from, to);
    const a = analyzePortfolio(sim.reservations, sim.costs, from, to);

    // täytön jälkeen vain jakson viimeinen yö voi jäädä aukoksi per kohde
    expect(a.totals.occupancy_pct).toBeGreaterThan(99);
    expect(a.totals.gross).toBeGreaterThan(base.totals.gross);
    expect(a.totals.net).toBeLessThan(base.totals.net); // ← bruttoa optimoiva täyttö on nettona tappio
    expect(a.totals.net_per_available_night).toBeLessThan(base.totals.net_per_available_night);
  });

  it("manual-kustannuksillakin (nollakonfig) täyttö on nettona tappio ja vuoto moninkertaistuu", async () => {
    const reservations = generateMockReservations(from, to);
    const costs = await manualSource({ avgTurnoverCost: 70 }).getCosts(reservations);
    const base = analyzePortfolio(reservations, costs, from, to);
    const sim = simulateFillGaps(reservations, costs, from, to);
    const a = analyzePortfolio(sim.reservations, sim.costs, from, to);

    expect(a.totals.occupancy_pct).toBeGreaterThan(99);
    expect(a.totals.gross).toBeGreaterThan(base.totals.gross);
    expect(a.totals.net).toBeLessThan(base.totals.net); // ← README:n ydinviesti pätee myös nollakonfigilla
    expect(a.leak_eur).toBeGreaterThan(base.leak_eur * 2); // halpojen kohteiden täytöt tappiollisia
  });
});

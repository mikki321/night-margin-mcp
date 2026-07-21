import { describe, expect, it } from "vitest";
import {
  type NightPrice,
  datesToRanges,
  gapNightsByProperty,
  groupConsecutive,
  median,
  proposeGapFloorDecisions,
} from "../src/core/decisions.js";
import type { Reservation, TurnoverCost } from "../src/core/types.js";

const res = (
  id: string,
  property: string,
  checkin: string,
  checkout: string,
  nights: number,
  gross = 100 * nights,
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
const recs = (...entries: [string, number][]): NightPrice[] =>
  entries.map(([stay_date, price]) => ({ stay_date, price }));

const FROM = "2026-08-01";
const TO = "2026-08-11"; // 10 yötä

describe("gapNightsByProperty — sama yömääritelmä kuin calc.ts", () => {
  it("yö kuuluu alkupäivälleen, to on eksklusiivinen", () => {
    // p1 varattu 01–04 ja 06–08 → aukot 04, 05, 08, 09, 10
    const reservations = [
      res("r1", "p1", "2026-08-01", "2026-08-04", 3),
      res("r2", "p1", "2026-08-06", "2026-08-08", 2),
    ];
    const gaps = gapNightsByProperty(reservations, FROM, TO);
    expect(gaps.get("p1")).toEqual([
      "2026-08-04",
      "2026-08-05",
      "2026-08-08",
      "2026-08-09",
      "2026-08-10",
    ]);
  });

  it("jakson yli ulottuva varaus leikataan ikkunaan; täysi kohde ei tuota rivejä", () => {
    const reservations = [res("r1", "p-full", "2026-07-20", "2026-08-20", 31)];
    const gaps = gapNightsByProperty(reservations, FROM, TO);
    expect(gaps.has("p-full")).toBe(false);
  });

  it("kohde jolla ei ole varauksia ikkunassa ei ole mukana (siitä ei tiedetä mitään)", () => {
    const reservations = [res("r1", "p1", "2026-05-01", "2026-05-03", 2)];
    expect(gapNightsByProperty(reservations, FROM, TO).size).toBe(0);
  });

  it("checkout == from tuo kohteen mukaan (sama sisällytyssääntö kuin analyysissä)", () => {
    const reservations = [res("r1", "p1", "2026-07-28", "2026-08-01", 4)];
    const gaps = gapNightsByProperty(reservations, FROM, TO);
    // kaikki 10 yötä aukkoja — varaus ei kata yhtään ikkunan yötä
    expect(gaps.get("p1")).toHaveLength(10);
  });

  it("virheellinen jakso → selkeä virhe", () => {
    expect(() => gapNightsByProperty([], TO, FROM)).toThrow(/must be after the start/);
  });
});

describe("groupConsecutive + datesToRanges", () => {
  it("ryhmittelee peräkkäiset päivät ja jakaa katkokset", () => {
    expect(
      groupConsecutive(["2026-08-04", "2026-08-05", "2026-08-08", "2026-08-09", "2026-08-10"]),
    ).toEqual([
      ["2026-08-04", "2026-08-05"],
      ["2026-08-08", "2026-08-09", "2026-08-10"],
    ]);
  });

  it("kuunvaihde on peräkkäinen", () => {
    expect(groupConsecutive(["2026-08-31", "2026-09-01"])).toEqual([["2026-08-31", "2026-09-01"]]);
  });

  it("datesToRanges: end_date = viimeinen yö + 1 pv (verifioitu WH-muoto)", () => {
    expect(datesToRanges(["2026-12-15"])).toEqual([
      { start_date: "2026-12-15", end_date: "2026-12-16" },
    ]);
    expect(datesToRanges(["2026-08-04", "2026-08-05", "2026-08-08"])).toEqual([
      { start_date: "2026-08-04", end_date: "2026-08-06" },
      { start_date: "2026-08-08", end_date: "2026-08-09" },
    ]);
  });
});

describe("median", () => {
  it("pariton, parillinen ja tyhjä", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("proposeGapFloorDecisions", () => {
  // p1: varattu 01–04 ja 06–08 → aukot 04, 05, 08, 09, 10.
  // Kustannukset: siivous+pyykki mediaani 70+10=80, matka 15 → lattia 80+15+25 = 120.
  const reservations = [
    res("r1", "p1", "2026-08-01", "2026-08-04", 3),
    res("r2", "p1", "2026-08-06", "2026-08-08", 2),
  ];
  const costs = costMap(cost("r1", 70, 15, 10), cost("r2", 70, 15, 10));

  it("ehdottaa vain yöt joilla suositus < lattia; peräkkäiset yhdeksi ehdotukseksi", () => {
    const priceRecsByProperty = new Map([
      [
        "p1",
        recs(
          ["2026-08-04", 100], // < 120 → ehdolle
          ["2026-08-05", 90], // < 120 → ehdolle (peräkkäinen 04:n kanssa)
          ["2026-08-08", 150], // ≥ 120 → ei
          ["2026-08-09", 100], // < 120 → ehdolle (oma jono)
          // 2026-08-10: ei suositusta → ei ehdotusta
        ),
      ],
    ]);
    const proposals = proposeGapFloorDecisions({
      reservations,
      costsById: costs,
      priceRecsByProperty,
      from: FROM,
      to: TO,
      minMargin: 25,
    });

    expect(proposals).toHaveLength(2);
    // järjestys: suurin floor_vs_rec_delta ensin — (120−100)+(120−90)=50 vs 120−100=20
    expect(proposals[0]).toMatchObject({
      property_id: "p1",
      dates: ["2026-08-04", "2026-08-05"],
      floor_price: 120,
      rec_min: 90,
      rec_max: 100,
      protected_nights: 2,
      floor_vs_rec_delta: 50,
    });
    expect(proposals[1]).toMatchObject({
      dates: ["2026-08-09"],
      protected_nights: 1,
      floor_vs_rec_delta: 20,
    });
  });

  it("kaikki suositukset lattian yllä → ei ehdotuksia", () => {
    const priceRecsByProperty = new Map([
      ["p1", recs(["2026-08-04", 200], ["2026-08-05", 121], ["2026-08-08", 300])],
    ]);
    expect(
      proposeGapFloorDecisions({
        reservations,
        costsById: costs,
        priceRecsByProperty,
        from: FROM,
        to: TO,
        minMargin: 25,
      }),
    ).toEqual([]);
  });

  it("lattia pyöristetään YLÖS kokonaiseuroon; vertailu tehdään raakalattialla", () => {
    // yksi kustannusrivi: siivous 70.4 → lattia raw 95.4, floor_price 96
    const oneRes = [res("r1", "p1", "2026-08-01", "2026-08-04", 3)];
    const oneCost = costMap(cost("r1", 70.4));
    const priceRecsByProperty = new Map([
      ["p1", recs(["2026-08-04", 95.4], ["2026-08-05", 95.3])],
    ]);
    const proposals = proposeGapFloorDecisions({
      reservations: oneRes,
      costsById: oneCost,
      priceRecsByProperty,
      from: FROM,
      to: TO,
      minMargin: 25,
    });
    // 95.4 EI ole alle raakalattian (95.4) → vain 95.3 ehdolle
    expect(proposals).toHaveLength(1);
    expect(proposals[0].dates).toEqual(["2026-08-05"]);
    expect(proposals[0].floor_price).toBe(96);
  });

  it("kohde ilman kustannusrivejä ohitetaan (ei lattiaa → ei ehdotusta)", () => {
    const priceRecsByProperty = new Map([["p1", recs(["2026-08-04", 10])]]);
    expect(
      proposeGapFloorDecisions({
        reservations,
        costsById: new Map(),
        priceRecsByProperty,
        from: FROM,
        to: TO,
        minMargin: 25,
      }),
    ).toEqual([]);
  });

  it("kohde ilman hintadataa ohitetaan", () => {
    expect(
      proposeGapFloorDecisions({
        reservations,
        costsById: costs,
        priceRecsByProperty: new Map(),
        from: FROM,
        to: TO,
        minMargin: 25,
      }),
    ).toEqual([]);
  });
});

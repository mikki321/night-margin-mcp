import { describe, expect, it } from "vitest";
import {
  analyzePortfolio,
  gapNightFloor,
  nightsInPeriod,
  overlapNights,
  parseISODate,
  reservationNet,
} from "../src/core/calc.js";
import type { Reservation, TurnoverCost } from "../src/core/types.js";
import { manualSource, parseTiers } from "../src/sources/manual.js";
import { generateMockReservations } from "../src/sources/mockReservations.js";

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

describe("parseISODate — kalenteritarkistus (regressio: 2026-02-30 hyväksyttiin ja tulkittiin hiljaa 2026-03-02:ksi)", () => {
  it("hyväksyy oikeat kalenteripäivät, myös karkauspäivän", () => {
    expect(parseISODate("2026-06-15")).toBe(Date.parse("2026-06-15T00:00:00Z"));
    expect(parseISODate("2024-02-29")).toBe(Date.parse("2024-02-29T00:00:00Z")); // 2024 on karkausvuosi
    expect(parseISODate("2026-12-31")).toBe(Date.parse("2026-12-31T00:00:00Z"));
  });

  it("hylkää olemattomat kalenteripäivät joita V8 pyöräyttäisi eteenpäin", () => {
    expect(() => parseISODate("2026-02-30")).toThrow(/does not exist in the calendar/);
    expect(() => parseISODate("2026-04-31")).toThrow(/does not exist in the calendar/);
    expect(() => parseISODate("2026-02-29")).toThrow(/does not exist in the calendar/); // 2026 EI ole karkausvuosi
  });

  it("hylkää yhä väärän muodon selkeällä virheellä", () => {
    expect(() => parseISODate("2026-13-01")).toThrow(/Invalid date/);
    expect(() => parseISODate("kesäkuu")).toThrow(/Invalid date/);
    expect(() => parseISODate("2026-6-15")).toThrow(/Invalid date/); // ei-nollattu kuukausi ei läpäise round-trippiä
  });
});

describe("nightsInPeriod", () => {
  it("laskee yöt [from, to) -välillä", () => {
    expect(nightsInPeriod("2026-07-01", "2026-07-08")).toBe(7);
    expect(nightsInPeriod("2026-07-01", "2026-07-01")).toBe(0);
  });

  it("hylkää virheellisen päivämäärän", () => {
    expect(() => nightsInPeriod("07/01/2026", "2026-07-08")).toThrow(/Invalid/);
  });
});

describe("overlapNights", () => {
  const r = res("a", "p1", "2026-07-03", "2026-07-07", 4, 400);

  it("varaus kokonaan jakson sisällä", () => {
    expect(overlapNights(r, "2026-07-01", "2026-07-31")).toBe(4);
  });

  it("leikkaa jakson reunoihin", () => {
    expect(overlapNights(r, "2026-07-05", "2026-07-31")).toBe(2);
    expect(overlapNights(r, "2026-07-01", "2026-07-05")).toBe(2);
  });

  it("nolla kun ei osu jaksolle", () => {
    expect(overlapNights(r, "2026-08-01", "2026-08-31")).toBe(0);
  });
});

describe("reservationNet ja gapNightFloor", () => {
  it("netto = brutto − siivous − matka − pyykki", () => {
    expect(reservationNet(res("a", "p", "2026-07-01", "2026-07-03", 2, 200), cost("a", 55, 10, 15))).toBe(120);
  });

  it("aukkoyölattia = vaihto + matka + minimikate", () => {
    expect(gapNightFloor(70, 12, 25)).toBe(107);
  });
});

describe("analyzePortfolio", () => {
  // 10 yön jakso, 2 kohdetta:
  //  p1: 4 yötä à 150 € (netto +530), 1 yö à 60 € (netto −10) → booked 5, gap 5
  //  p2: 6 yötä à 100 € (netto +530) → booked 6, gap 4
  const from = "2026-07-01";
  const to = "2026-07-11";
  const reservations = [
    res("r1", "p1", "2026-07-01", "2026-07-05", 4, 600),
    res("r2", "p1", "2026-07-07", "2026-07-08", 1, 60),
    res("r3", "p2", "2026-07-02", "2026-07-08", 6, 600),
  ];
  const costs = costMap(cost("r1", 70), cost("r2", 70), cost("r3", 70));
  const a = analyzePortfolio(reservations, costs, from, to);

  it("laskee varatut yöt, aukkoyöt ja käytettävissä olevat yöt", () => {
    const p1 = a.properties.find((p) => p.property_id === "p1")!;
    expect(p1.booked_nights).toBe(5);
    expect(p1.gap_nights).toBe(5);
    expect(p1.available_nights).toBe(10);
    expect(a.totals.available_nights).toBe(20);
    expect(a.totals.booked_nights).toBe(11);
  });

  it("laskee netton ja netto/yö:n", () => {
    // p1: gross 660 − costs 140 = 520 → 52 €/yö; p2: 600 − 70 = 530 → 53 €/yö
    const p1 = a.properties.find((p) => p.property_id === "p1")!;
    expect(p1.net).toBe(520);
    expect(p1.net_per_available_night).toBeCloseTo(52);
    expect(a.totals.net).toBe(1050);
    expect(a.totals.net_per_available_night).toBeCloseTo(1050 / 20);
  });

  it("järjestää kohteet nousevasti netto/yö:n mukaan", () => {
    expect(a.properties.map((p) => p.property_id)).toEqual(["p1", "p2"]);
  });

  it("laskee vuodon negatiivisista varauksista", () => {
    // r2: 60 − 70 = −10 → vuoto 10 €, 1 yö / 11 varatusta yöstä
    expect(a.leak_eur).toBe(10);
    expect(a.leak_nights).toBe(1);
    expect(a.leak_pct).toBeCloseTo(100 / 11);
    expect(a.negative_reservations).toHaveLength(1);
    expect(a.negative_reservations[0].reservation_id).toBe("r2");
  });

  it("suhteuttaa liikevaihdon jakson yli menevältä varaukselta", () => {
    // 4 yön varaus josta 2 yötä jaksolla → puolet bruttosta, ei kustannusta (checkout jakson ulkopuolella)
    const spill = [res("s1", "p1", "2026-07-09", "2026-07-13", 4, 400)];
    const b = analyzePortfolio(spill, costMap(cost("s1", 70)), "2026-07-01", "2026-07-11");
    const p1 = b.properties.find((p) => p.property_id === "p1")!;
    expect(p1.booked_nights).toBe(2);
    expect(p1.gross).toBeCloseTo(200);
    expect(p1.costs).toBe(0);
  });

  it("kaatuu selkeästi jos kustannusrivi puuttuu", () => {
    expect(() => analyzePortfolio(reservations, costMap(cost("r1", 70)), from, to)).toThrow(
      /has no cost row/,
    );
  });

  it("ilman allPropertyIds-parametria käytös ja tuloskentät ovat ennallaan", () => {
    expect(a.no_booking_properties).toBeUndefined();
    expect("no_booking_properties" in a).toBe(false);
  });

  it("allPropertyIds: nollavarauskohde mukaan nimittäjään (booked 0, gap = jakson yöt, net 0)", () => {
    const b = analyzePortfolio(reservations, costs, from, to, ["p1", "p2", "p3-empty"]);
    const empty = b.properties.find((p) => p.property_id === "p3-empty")!;
    expect(empty).toEqual({
      property_id: "p3-empty",
      booked_nights: 0,
      gap_nights: 10,
      available_nights: 10,
      gross: 0,
      costs: 0,
      net: 0,
      net_per_available_night: 0,
    });
    // nimittäjä kasvaa 20 → 30, varatut yöt eivät → käyttöaste laskee rehellisesti
    expect(b.totals.available_nights).toBe(30);
    expect(b.totals.booked_nights).toBe(11);
    expect(b.totals.occupancy_pct).toBeCloseTo((11 / 30) * 100);
    expect(b.totals.net).toBe(a.totals.net); // netto ei muutu, vain jakauma
    expect(b.totals.net_per_available_night).toBeCloseTo(1050 / 30);
    expect(b.no_booking_properties).toBe(1);
  });

  it("allPropertyIds: listan varaukselliset kohteet eivät duplikoidu eikä luku kasva", () => {
    const b = analyzePortfolio(reservations, costs, from, to, ["p1", "p2"]);
    expect(b.properties).toHaveLength(2);
    expect(b.totals.available_nights).toBe(20);
    expect(b.no_booking_properties).toBe(0);
  });
});

describe("manualSource", () => {
  it("antaa jokaiselle varaukselle keskiarvokustannuksen", async () => {
    const src = manualSource({ avgTurnoverCost: 70 });
    const costs = await src.getCosts([res("r1", "p1", "2026-07-01", "2026-07-03", 2, 200)]);
    expect(costs.get("r1")).toEqual({
      reservation_id: "r1",
      cleaning_cost: 70,
      travel_cost: 0,
      laundry_cost: 0,
    });
  });

  it("soveltaa tieriä property_id-osuman mukaan", async () => {
    const src = manualSource({ avgTurnoverCost: 70, tiers: parseTiers("1br:55,3br:95") });
    const costs = await src.getCosts([
      res("a", "demo-1br-01", "2026-07-01", "2026-07-03", 2, 200),
      res("b", "demo-2br-04", "2026-07-01", "2026-07-03", 2, 200),
      res("c", "demo-3br-08", "2026-07-01", "2026-07-03", 2, 200),
    ]);
    expect(costs.get("a")!.cleaning_cost).toBe(55);
    expect(costs.get("b")!.cleaning_cost).toBe(70);
    expect(costs.get("c")!.cleaning_cost).toBe(95);
  });

  it("hylkää rikkinäisen COST_TIERS-arvon", () => {
    expect(() => parseTiers("1br=55")).toThrow(/COST_TIERS/);
  });
});

describe("generateMockReservations", () => {
  const from = "2026-06-01";
  const to = "2026-07-01";

  it("on deterministinen", () => {
    expect(generateMockReservations(from, to)).toEqual(generateMockReservations(from, to));
  });

  it("tuottaa analyysikelpoisen portfolion jossa on vuotoa", async () => {
    const reservations = generateMockReservations(from, to);
    expect(reservations.length).toBeGreaterThan(30);
    const costs = await manualSource({ avgTurnoverCost: 70 }).getCosts(reservations);
    const a = analyzePortfolio(reservations, costs, from, to);
    expect(a.properties).toHaveLength(8);
    expect(a.totals.net).toBeGreaterThan(0);
    expect(a.leak_eur).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { analyzePortfolio } from "../src/core/calc.js";
import type { Reservation, TurnoverCost } from "../src/core/types.js";
import { formatAnalysis } from "../src/tools/analyzePortfolio.js";

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

const FROM = "2026-07-01";
const TO = "2026-07-11";

/** Sisältörivit ilman tyhjiä — järjestysasserttien perusta. */
const contentLines = (text: string): string[] =>
  text.split("\n").filter((l) => l.trim() !== "");

describe("formatAnalysis — kipu ensin", () => {
  it("leak > 0: vuotolause on ensimmäinen sisältörivi otsikon + lähderivin jälkeen", () => {
    // r2 on nettonegatiivinen: 100 € brutto − 120 € siivous = −20 €
    const reservations = [
      res("r1", "p1", "2026-07-01", "2026-07-05", 4, 400),
      res("r2", "p1", "2026-07-07", "2026-07-09", 2, 100),
    ];
    const costs = costMap(cost("r1", 70, 20, 10), cost("r2", 120));
    const a = analyzePortfolio(reservations, costs, FROM, TO);
    expect(a.leak_eur).toBe(20);

    const text = formatAnalysis(a, "manual (test)", "reservations: fixture");
    const lines = contentLines(text);
    expect(lines[0]).toMatch(/^## Portfolio 2026-07-01 → 2026-07-11$/);
    expect(lines[1]).toMatch(/^Cost source:/);
    expect(lines[2]).toMatch(
      /^\*\*€20 is leaking from 1 booking that doesn't cover its own turnover cost\.\*\*/,
    );
    // netto/yö tulee vasta vuotolauseen JÄLKEEN
    expect(lines[3]).toContain("Net per available night:");
    expect(text.indexOf("is leaking from")).toBeLessThan(text.indexOf("Net per available night"));
  });

  it("leak > 0 monikossa: euromäärä ja varausten lukumäärä säilyvät", () => {
    const reservations = [
      res("r1", "p1", "2026-07-01", "2026-07-03", 2, 50),
      res("r2", "p1", "2026-07-05", "2026-07-07", 2, 60),
    ];
    const costs = costMap(cost("r1", 120), cost("r2", 100));
    const a = analyzePortfolio(reservations, costs, FROM, TO);
    expect(a.negative_reservations).toHaveLength(2);

    const text = formatAnalysis(a, "manual (test)", "");
    expect(text).toContain(
      `**€${a.leak_eur} is leaking from 2 bookings that don't cover their own turnover cost.**`,
    );
    // vuotoprosentti säilyy yksityiskohtana samalla rivillä
    expect(text).toContain("of booked nights are net-negative");
  });

  it("leak = 0: no leak -lause + netto/yö samalla ensimmäisellä sisältörivillä", () => {
    // checkout jakson SISÄLLÄ → vaihtokustannus lasketaan mukaan (1500 − 90 = 1410 / 10 yötä)
    const reservations = [res("r1", "p1", "2026-07-01", "2026-07-10", 9, 1500)];
    const costs = costMap(cost("r1", 70, 10, 10));
    const a = analyzePortfolio(reservations, costs, FROM, TO);
    expect(a.leak_eur).toBe(0);

    const text = formatAnalysis(a, "manual (test)", "reservations: fixture");
    const lines = contentLines(text);
    expect(lines[2]).toMatch(
      /^\*\*No leak — every booking covers its own turnover cost\.\*\* Net per available night: €141$/,
    );
    // netto/yö ei toistu toisena otsikkorivinä
    expect(text.match(/Net per available night/g)).toHaveLength(1);
  });

  it("leak = 0: yhteenveto EI väitä että halvat varaukset eivät kata kulujaan (regressio: ristiriita No leak -otsikon kanssa)", () => {
    const reservations = [res("r1", "p1", "2026-07-01", "2026-07-10", 9, 1500)];
    const costs = costMap(cost("r1", 70, 10, 10));
    const a = analyzePortfolio(reservations, costs, FROM, TO);
    expect(a.leak_eur).toBe(0);

    const text = formatAnalysis(a, "manual (test)", "");
    expect(text).toContain("**No leak — every booking covers its own turnover cost.**");
    expect(text).toContain("leak totaled €0 — no booking sold below its turnover cost.");
    expect(text).not.toContain("do not cover their turnover cost");
  });

  it("leak > 0: yhteenvedon selityslause säilyy ennallaan", () => {
    const reservations = [
      res("r1", "p1", "2026-07-01", "2026-07-05", 4, 400),
      res("r2", "p1", "2026-07-07", "2026-07-09", 2, 100),
    ];
    const costs = costMap(cost("r1", 70, 20, 10), cost("r2", 120));
    const a = analyzePortfolio(reservations, costs, FROM, TO);
    expect(a.leak_eur).toBe(20);

    const text = formatAnalysis(a, "manual (test)", "");
    expect(text).toContain("leak totaled €20 — short, cheap bookings do not cover their turnover cost.");
  });

  it("leak 0 < x < 0.5 € näytetään desimaalilla — ei '€0 is leaking' (löydös 8)", () => {
    // r1 netto −0.3 € → leak 0.3 pyöristyisi eur():llä nollaan
    const reservations = [res("r1", "p1", "2026-07-01", "2026-07-03", 2, 69.7)];
    const costs = costMap(cost("r1", 70));
    const a = analyzePortfolio(reservations, costs, FROM, TO);
    expect(a.leak_eur).toBeCloseTo(0.3);

    const text = formatAnalysis(a, "manual (test)", "");
    expect(text).toContain("€0.3 is leaking from 1 booking");
    expect(text).not.toContain("**€0 is leaking");
    expect(text).toContain("leak totaled €0.3");
  });

  it("nollavarauskohteet: 'had no bookings' -rivi + kohteet bottom-listassa €0-nettona (löydös 7)", () => {
    const reservations = [res("r1", "p1", "2026-07-01", "2026-07-05", 4, 400)];
    const costs = costMap(cost("r1", 70, 20, 10));
    const a = analyzePortfolio(reservations, costs, FROM, TO, ["p1", "p2-empty", "p3-empty"]);
    expect(a.no_booking_properties).toBe(2);

    const text = formatAnalysis(a, "manual (test)", "");
    expect(text).toContain("2 properties had no bookings in this window");
    // nollakohde näkyy taulukossa rehellisesti €0-nettona
    expect(text).toContain("| p2-empty | €0 | 0 | 10 | €0 |");

    // yksikkömuoto
    const single = analyzePortfolio(reservations, costs, FROM, TO, ["p1", "p2-empty"]);
    expect(formatAnalysis(single, "manual (test)", "")).toContain(
      "1 property had no bookings in this window",
    );
  });

  it("ilman kohdelistaa (tai kun kaikilla on varauksia) riviä ei näytetä", () => {
    const reservations = [res("r1", "p1", "2026-07-01", "2026-07-05", 4, 400)];
    const costs = costMap(cost("r1", 70));
    const withoutList = analyzePortfolio(reservations, costs, FROM, TO);
    expect(formatAnalysis(withoutList, "manual (test)", "")).not.toContain("had no bookings");
    const allBooked = analyzePortfolio(reservations, costs, FROM, TO, ["p1"]);
    expect(formatAnalysis(allBooked, "manual (test)", "")).not.toContain("had no bookings");
  });

  it("oletusikkunan huomautus näkyy otsikossa vain kun ikkuna on oletus", () => {
    const reservations = [res("r1", "p1", "2026-07-01", "2026-07-11", 10, 1500)];
    const costs = costMap(cost("r1", 70));
    const a = analyzePortfolio(reservations, costs, FROM, TO);

    const withNote = formatAnalysis(a, "manual (test)", "", true);
    expect(contentLines(withNote)[0]).toBe(
      "## Portfolio 2026-07-01 → 2026-07-11 (default window: last 30 + next 90 days — pass from/to to change)",
    );

    const withoutNote = formatAnalysis(a, "manual (test)", "");
    expect(withoutNote).not.toContain("default window");
  });

  it("KUUNLOPPU-ANSA: monthEndNote näkyy ikkunarivin yhteydessä kun annettu", () => {
    const reservations = [res("r1", "p1", "2026-08-01", "2026-08-11", 10, 1500)];
    const costs = costMap(cost("r1", 70));
    const a = analyzePortfolio(reservations, costs, "2026-08-01", "2026-08-31");

    const note =
      "Note: to=2026-08-31 is exclusive — the night of Aug 31 is not included. Use to=2026-09-01 for the full month.";
    const text = formatAnalysis(a, "manual (test)", "", false, undefined, note);
    const lines = contentLines(text);

    expect(lines[0]).toBe("## Portfolio 2026-08-01 → 2026-08-31");
    expect(lines[1]).toBe(note);

    // Ei laskentaan vaikutusta — pelkkä huomautusrivi.
    const withoutNote = formatAnalysis(a, "manual (test)", "");
    expect(withoutNote).not.toContain("is exclusive");
  });
});

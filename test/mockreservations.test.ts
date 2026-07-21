import { describe, expect, it } from "vitest";
import { csvSource } from "../src/sources/csv.js";
import { generateMockReservations } from "../src/sources/mockReservations.js";

/**
 * Mock-portfolion pitää olla IKKUNARIIPPUMATON: analyze_portfolio,
 * compare_strategies ja gap_night_check katsovat eri ikkunoita, ja niiden
 * pitää nähdä sama portfolio — analyysin näyttämä aukko on aukko myös
 * gap-checkin omassa ikkunassa, ja sample-CSV:n id:t osuvat joka ikkunassa.
 */
describe("generateMockReservations — ikkunariippumaton kiinteä kalenteri", () => {
  it("sama varaus samalla id:llä joka ikkunassa", () => {
    const june = generateMockReservations("2026-06-01", "2026-07-01");
    const wide = generateMockReservations("2026-05-03", "2026-09-15");
    const wideById = new Map(wide.map((r) => [r.reservation_id, r]));
    expect(june.length).toBeGreaterThan(0);
    for (const r of june) {
      expect(wideById.get(r.reservation_id)).toEqual(r);
    }
  });

  it("deterministinen: kaksi kutsua → identtinen tulos", () => {
    expect(generateMockReservations("2026-06-01", "2026-07-01")).toEqual(
      generateMockReservations("2026-06-01", "2026-07-01"),
    );
  });

  it("leikkaa ikkunaan: mukana myös varaus jonka checkout == from (vaihto jaksolla)", () => {
    const all = generateMockReservations("2026-01-01", "2027-01-01");
    const june = generateMockReservations("2026-06-01", "2026-07-01");
    const expected = all.filter((r) => r.checkin < "2026-07-01" && r.checkout >= "2026-06-01");
    expect(june).toEqual(expected);
  });

  it("sample-CSV osuu joka varaukseen id:llä missä tahansa ikkunassa (CSV ↔ mock -synkka)", async () => {
    // Jos tämä kaatuu, mock-generaattori on muuttunut ilman CSV:n
    // uudelleengenerointia — aja: npx tsx scripts/generate-sample-csv.ts
    const src = csvSource({ path: "examples/sample-costs.csv" });
    for (const [from, to] of [
      ["2026-06-01", "2026-07-01"],
      ["2026-06-10", "2026-06-25"],
      ["2026-11-15", "2026-12-15"],
    ] as Array<[string, string]>) {
      const reservations = generateMockReservations(from, to);
      // ilman fallbackia getCosts heittää jos yksikin id puuttuu
      const costs = await src.getCosts(reservations);
      expect(costs.size).toBe(reservations.length);
    }
  });

  it("README-esimerkin aukkoyö: demo-1br-01 2026-06-23 on vapaa kiinteässä kalenterissa", () => {
    const all = generateMockReservations("2026-01-01", "2027-01-01");
    const covering = all.find(
      (r) =>
        r.property_id === "demo-1br-01" && r.checkin <= "2026-06-23" && "2026-06-23" < r.checkout,
    );
    expect(covering).toBeUndefined();
  });
});

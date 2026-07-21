import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Reservation } from "../src/core/types.js";
import { csvSource } from "../src/sources/csv.js";
import { manualSource } from "../src/sources/manual.js";
import { avgFallbackFromEnv, resolveCosts } from "../src/sources/resolveCosts.js";

const res = (id: string, over: Partial<Reservation> = {}): Reservation => ({
  reservation_id: id,
  property_id: "p1",
  checkin: "2026-06-01",
  checkout: "2026-06-03",
  nights: 2,
  gross_revenue: 200,
  ...over,
});

const HEADER =
  "reservation_id,property_id,checkin,checkout,nights,gross_revenue,cleaning_cost,travel_cost,laundry_cost,turnover_date,is_sunday_or_holiday";

function writeCsv(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "margin-resolve-"));
  const path = join(dir, "costs.csv");
  writeFileSync(path, [HEADER, ...rows].join("\n"));
  return path;
}

describe("avgFallbackFromEnv", () => {
  it("ilman enviä ja parametria → undefined (kaskadin virhehaara pääsee läpi)", () => {
    expect(avgFallbackFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(avgFallbackFromEnv({ AVG_TURNOVER_COST: "" } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(avgFallbackFromEnv({ AVG_TURNOVER_COST: "  " } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("parametri voittaa envin; env luetaan kun parametria ei ole", () => {
    expect(avgFallbackFromEnv({ AVG_TURNOVER_COST: "85" } as NodeJS.ProcessEnv, 60)).toBe(60);
    expect(avgFallbackFromEnv({ AVG_TURNOVER_COST: "85" } as NodeJS.ProcessEnv)).toBe(85);
  });

  it("kelvoton env-arvo kaatuu selkeästi", () => {
    expect(() => avgFallbackFromEnv({ AVG_TURNOVER_COST: "abc" } as NodeJS.ProcessEnv)).toThrow(
      /AVG_TURNOVER_COST/,
    );
    expect(() => avgFallbackFromEnv({ AVG_TURNOVER_COST: "-5" } as NodeJS.ProcessEnv)).toThrow(
      /AVG_TURNOVER_COST/,
    );
  });
});

describe("resolveCosts — yhteinen kohdistus kaikille tooleille", () => {
  it("manual-lähde (ei getRows): suora getCosts, ei kohdistusriviä", async () => {
    const { costs, matchNote } = await resolveCosts(
      manualSource({ avgTurnoverCost: 70 }),
      [res("r1")],
      "2026-06-01",
      "2026-07-01",
    );
    expect(costs.get("r1")!.cleaning_cost).toBe(70);
    expect(matchNote).toBe("");
  });

  it("csv-lähde: matchCosts-kaskadi + kohdistusrivi (id- ja komposiittiosumat)", async () => {
    const path = writeCsv([
      "r1,p1,2026-06-01,2026-06-03,2,200,55,12,18,2026-06-03,false",
      "ch-2,p1,2026-06-05,2026-06-08,3,300,60,10,15,2026-06-08,false",
    ]);
    const { costs, matchNote } = await resolveCosts(
      csvSource({ path }),
      [res("r1"), res("wh-2", { checkin: "2026-06-05", checkout: "2026-06-08" })],
      "2026-06-01",
      "2026-07-01",
    );
    expect(costs.get("r1")!.cleaning_cost).toBe(55);
    expect(costs.get("wh-2")!.cleaning_cost).toBe(60); // komposiittiosuma
    expect(matchNote).toBe("Cost attribution: 1 by reservation_id, 1 by composite key (2 total)");
  });

  it("puuttuva rivi ILMAN fallbackia → selkeä virhe toimintaohjeineen (haara 5 saavutettavissa)", async () => {
    const path = writeCsv(["r1,p1,2026-06-01,2026-06-03,2,200,55,12,18,2026-06-03,false"]);
    await expect(
      resolveCosts(csvSource({ path }), [res("r1"), res("orpo", { checkin: "2026-06-10", checkout: "2026-06-12" })], "2026-06-01", "2026-07-01"),
    ).rejects.toThrow(/orpo.*AVG_TURNOVER_COST/s);
  });

  it("puuttuva rivi fallbackilla → keskiarvo näkyy kohdistusrivillä", async () => {
    const path = writeCsv(["r1,p1,2026-06-01,2026-06-03,2,200,55,12,18,2026-06-03,false"]);
    const { costs, matchNote } = await resolveCosts(
      csvSource({ path }),
      [res("r1"), res("orpo", { checkin: "2026-06-10", checkout: "2026-06-12" })],
      "2026-06-01",
      "2026-07-01",
      70,
    );
    expect(costs.get("orpo")!.cleaning_cost).toBe(70);
    expect(matchNote).toBe("Cost attribution: 1 by reservation_id, 1 by average fallback (2 total)");
  });

  it("duplikaattikomposiitit nostavat varoituksen kohdistusriville", async () => {
    const path = writeCsv([
      "a,p1,2026-06-01,2026-06-03,2,200,40,0,0,2026-06-03,false",
      "b,p1,2026-06-01,2026-06-03,2,200,60,0,0,2026-06-03,false",
    ]);
    const { matchNote } = await resolveCosts(
      csvSource({ path }),
      [res("x"), res("y")],
      "2026-06-01",
      "2026-07-01",
    );
    expect(matchNote).toContain("Cost attribution: 2/2 bookings matched by composite key");
    expect(matchNote).toContain("warning:");
  });
});

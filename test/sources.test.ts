import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Reservation } from "../src/core/types.js";
import { cleanhubSource } from "../src/sources/cleanhub.js";
import { csvSource } from "../src/sources/csv.js";
import { costSourceFromEnv } from "../src/sources/index.js";

const res = (id: string): Reservation => ({
  reservation_id: id,
  property_id: "p1",
  checkin: "2026-06-01",
  checkout: "2026-06-03",
  nights: 2,
  gross_revenue: 200,
});

const HEADER =
  "reservation_id,property_id,checkin,checkout,nights,gross_revenue,cleaning_cost,travel_cost,laundry_cost,turnover_date,is_sunday_or_holiday";

function writeCsv(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "margin-csv-"));
  const path = join(dir, "costs.csv");
  writeFileSync(path, [HEADER, ...rows].join("\n"));
  return path;
}

describe("csvSource", () => {
  it("lukee kustannukset reservation_id:llä", async () => {
    const path = writeCsv(["r1,p1,2026-06-01,2026-06-03,2,200,55,12,18,2026-06-03,false"]);
    const costs = await csvSource({ path }).getCosts([res("r1")]);
    expect(costs.get("r1")).toEqual({
      reservation_id: "r1",
      cleaning_cost: 55,
      travel_cost: 12,
      laundry_cost: 18,
    });
  });

  it("kaatuu selkeästi kun rivi puuttuu eikä fallbackia ole", async () => {
    const path = writeCsv(["r1,p1,2026-06-01,2026-06-03,2,200,55,0,0,2026-06-03,false"]);
    await expect(csvSource({ path }).getCosts([res("r1"), res("r2")])).rejects.toThrow(
      /puuttuu kustannusrivi.*r2/,
    );
  });

  it("täyttää puuttuvan rivin fallback-keskiarvolla", async () => {
    const path = writeCsv(["r1,p1,2026-06-01,2026-06-03,2,200,55,0,0,2026-06-03,false"]);
    const costs = await csvSource({ path, fallbackAvg: 70 }).getCosts([res("r1"), res("r2")]);
    expect(costs.get("r2")!.cleaning_cost).toBe(70);
  });

  it("hylkää CSV:n josta puuttuu sarakkeita", () => {
    const dir = mkdtempSync(join(tmpdir(), "margin-csv-"));
    const path = join(dir, "bad.csv");
    writeFileSync(path, "reservation_id,foo\nr1,1");
    expect(() => csvSource({ path })).toThrow(/puuttuu sarakkeet/);
  });

  it("kertoo toimintaohjeen kun tiedostoa ei ole", () => {
    expect(() => csvSource({ path: "/ei/ole/olemassa.csv" })).toThrow(/CSV_PATH/);
  });

  it("getRows palauttaa rivit matchaus-kenttineen (property_id, checkin, checkout)", async () => {
    const path = writeCsv(["r1,p1,2026-06-01,2026-06-03,2,200,55,12,18,2026-06-03,false"]);
    const rows = await csvSource({ path }).getRows!();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reservation_id: "r1",
      property_id: "p1",
      checkin: "2026-06-01",
      checkout: "2026-06-03",
      cleaning_cost: 55,
      travel_cost: 12,
      laundry_cost: 18,
    });
    expect(rows[0].confirmation_code).toBeUndefined();
  });
});

describe("cleanhubSource", () => {
  const row = { reservation_id: "r1", cleaning_cost: 62, travel_cost: 14, laundry_cost: 9 };

  it("hakee kustannukset varausten aikaväliltä Bearer-tokenilla", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const src = cleanhubSource({
      url: "https://ch.example.com/",
      token: "tok",
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenAuth = init?.headers?.Authorization ?? "";
        return { ok: true, status: 200, json: async () => [row] };
      },
    });
    const costs = await src.getCosts([res("r1")]);
    expect(seenUrl).toBe(
      "https://ch.example.com/api/exports/turnover-costs?from=2026-06-01&to=2026-06-03",
    );
    expect(seenAuth).toBe("Bearer tok");
    expect(costs.get("r1")).toEqual(row);
  });

  it("neuvoo tarkistamaan tokenin 401/403-vastauksella", async () => {
    const src = cleanhubSource({
      url: "https://ch.example.com",
      token: "bad",
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    await expect(src.getCosts([res("r1")])).rejects.toThrow(/CLEANHUB_TOKEN/);
  });

  it("kaatuu selkeästi jos vastaus ei ole taulukko", async () => {
    const src = cleanhubSource({
      url: "https://ch.example.com",
      token: "tok",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ rows: [] }) }),
    });
    await expect(src.getCosts([res("r1")])).rejects.toThrow(/JSON-taulukko/);
  });

  it("getRows hakee rivit annetulta aikaväliltä matchaus-kenttineen", async () => {
    let seenUrl = "";
    const src = cleanhubSource({
      url: "https://ch.example.com",
      token: "tok",
      fetchImpl: async (url) => {
        seenUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => [
            { ...row, property_id: "p1", checkin: "2026-06-01", checkout: "2026-06-03" },
          ],
        };
      },
    });
    const rows = await src.getRows!("2026-06-01", "2026-06-30");
    expect(seenUrl).toBe(
      "https://ch.example.com/api/exports/turnover-costs?from=2026-06-01&to=2026-06-30",
    );
    expect(rows[0]).toMatchObject({
      reservation_id: "r1",
      property_id: "p1",
      checkin: "2026-06-01",
      checkout: "2026-06-03",
      cleaning_cost: 62,
      travel_cost: 14,
      laundry_cost: 9,
    });
  });

  it("getRows ilman aikaväliä kaatuu selkeällä ohjeella", async () => {
    const src = cleanhubSource({
      url: "https://ch.example.com",
      token: "tok",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
    });
    await expect(src.getRows!()).rejects.toThrow(/getRows\(from, to\)/);
  });
});

describe("costSourceFromEnv", () => {
  it("csv-tila vaatii CSV_PATHin", () => {
    expect(() => costSourceFromEnv({ COST_SOURCE: "csv" } as NodeJS.ProcessEnv)).toThrow(/CSV_PATH/);
  });

  it("cleanhub-tila vaatii urlin ja tokenin", () => {
    expect(() => costSourceFromEnv({ COST_SOURCE: "cleanhub" } as NodeJS.ProcessEnv)).toThrow(
      /CLEANHUB_API_URL/,
    );
  });

  it("csv-tila rakentuu kun CSV_PATH osoittaa tiedostoon", () => {
    const path = writeCsv(["r1,p1,2026-06-01,2026-06-03,2,200,55,0,0,2026-06-03,false"]);
    const src = costSourceFromEnv({ COST_SOURCE: "csv", CSV_PATH: path } as NodeJS.ProcessEnv);
    expect(src.label).toContain("csv");
  });
});

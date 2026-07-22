import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzePortfolio } from "../src/core/calc.js";
import type { Reservation, TurnoverCost } from "../src/core/types.js";
import { readTargets } from "../src/state.js";
import { formatAnalysis } from "../src/tools/analyzePortfolio.js";
import {
  formatTargetsSection,
  monthWindow,
  propertyGrossInWindow,
  runSetTarget,
} from "../src/tools/setTarget.js";

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nm-target-test-"));
  env = { NM_STATE_DIR: dir } as NodeJS.ProcessEnv;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

const stubSource = (reservations: Reservation[]) => ({
  label: "stub",
  getReservations: async () => reservations,
});

describe("monthWindow", () => {
  it("kuukausi → [kuun 1. pv, seuraavan kuun 1. pv)", () => {
    expect(monthWindow("2026-08")).toEqual({ from: "2026-08-01", to: "2026-09-01" });
    expect(monthWindow("2026-12")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
  });

  it("virheellinen muoto → selkeä virhe", () => {
    expect(() => monthWindow("2026-13")).toThrow(/YYYY-MM/);
    expect(() => monthWindow("elokuu")).toThrow(/YYYY-MM/);
  });
});

describe("propertyGrossInWindow", () => {
  it("suhteuttaa liikevaihdon ikkunaan osuviin öihin (sama sääntö kuin calc.ts)", () => {
    const reservations = [
      res("r1", "p1", "2026-07-28", "2026-08-07", 10, 1000), // 6 yötä elokuussa → 600
      res("r2", "p1", "2026-08-10", "2026-08-12", 2, 300), // kokonaan → 300
      res("r3", "p2", "2026-08-01", "2026-08-05", 4, 999), // eri kohde
    ];
    expect(propertyGrossInWindow(reservations, "p1", "2026-08-01", "2026-09-01")).toBe(900);
    expect(propertyGrossInWindow(reservations, "p3", "2026-08-01", "2026-09-01")).toBe(0);
  });
});

describe("set_target", () => {
  it("tallentaa tavoitteen ja näyttää kuukauden toteuman prosentteineen", async () => {
    const source = stubSource([res("r1", "p1", "2026-08-01", "2026-08-11", 10, 1000)]);
    const out = await runSetTarget(
      { property_id: "p1", month: "2026-08", gross_target: 6000 },
      env,
      { reservationSource: source },
    );

    expect(out).toContain("Target saved: p1 · 2026-08 → gross €6,000.");
    expect(out).toContain("Current gross for p1 in 2026-08: €1,000 of €6,000 (17%).");
    expect(out).toContain("analyze_portfolio");

    const targets = readTargets(env);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ property_id: "p1", month: "2026-08", gross_target: 6000 });
    expect(targets[0].set_at).toBeTruthy();
  });

  it("sama kohde+kuukausi päivittyy (upsert), muut säilyvät", async () => {
    const source = stubSource([]);
    await runSetTarget({ property_id: "p1", month: "2026-08", gross_target: 6000 }, env, {
      reservationSource: source,
    });
    await runSetTarget({ property_id: "p2", month: "2026-08", gross_target: 4000 }, env, {
      reservationSource: source,
    });
    const out = await runSetTarget({ property_id: "p1", month: "2026-08", gross_target: 7000 }, env, {
      reservationSource: source,
    });

    expect(out).toContain("Target updated: p1 · 2026-08 → gross €7,000.");
    const targets = readTargets(env);
    expect(targets).toHaveLength(2);
    expect(targets.find((t) => t.property_id === "p1")!.gross_target).toBe(7000);
  });

  it("ei varauksia kuukaudelle → 0 % -rivi", async () => {
    const out = await runSetTarget({ property_id: "p1", month: "2026-08", gross_target: 5000 }, env, {
      reservationSource: stubSource([]),
    });
    expect(out).toContain("No booked gross yet for p1 in 2026-08 (0% of €5,000).");
  });

  it("toteumahaku kaatuu → tavoite silti talteen ja virhe kerrotaan", async () => {
    const failing = {
      label: "failing",
      getReservations: async (): Promise<Reservation[]> => {
        throw new Error("network down");
      },
    };
    const out = await runSetTarget({ property_id: "p1", month: "2026-08", gross_target: 5000 }, env, {
      reservationSource: failing,
    });
    expect(out).toContain("Could not compute the current month's gross (network down)");
    expect(readTargets(env)).toHaveLength(1);
  });

  it("virheellinen kuukausi tai tavoite → selkeä virhe eikä tallennusta", async () => {
    await expect(
      runSetTarget({ property_id: "p1", month: "08/2026", gross_target: 5000 }, env, {
        reservationSource: stubSource([]),
      }),
    ).rejects.toThrow(/YYYY-MM/);
    await expect(
      runSetTarget({ property_id: "p1", month: "2026-08", gross_target: -5 }, env, {
        reservationSource: stubSource([]),
      }),
    ).rejects.toThrow(/positive amount/);
    expect(readTargets(env)).toEqual([]);
  });
});

describe("formatTargetsSection — tavoiterivi analyze_portfolioon", () => {
  const target = (property_id: string, month: string, gross_target: number) => ({
    property_id,
    month,
    gross_target,
    set_at: "2026-07-22T00:00:00.000Z",
  });
  const reservations = [res("r1", "p1", "2026-08-01", "2026-08-11", 10, 1000)];

  it("ikkunaan osuva tavoite → rivi toteumalla ja prosentilla", () => {
    const section = formatTargetsSection([target("p1", "2026-08", 6000)], reservations, "2026-08-01", "2026-09-01");
    expect(section).toContain("### Monthly targets");
    expect(section).toContain("- p1 · 2026-08: €1,000 / €6,000 (17%)");
    expect(section).not.toContain("window covers");
  });

  it("osittainen kate mainitaan", () => {
    const section = formatTargetsSection([target("p1", "2026-08", 6000)], reservations, "2026-08-01", "2026-08-06");
    // 5 ensimmäistä yötä → 500
    expect(section).toContain("- p1 · 2026-08: €500 / €6,000 (8%) — window covers 2026-08-01 → 2026-08-06 only");
  });

  it("ikkunan ulkopuolinen tavoite → undefined (ei tyhjää osiota)", () => {
    expect(
      formatTargetsSection([target("p1", "2026-10", 6000)], reservations, "2026-08-01", "2026-09-01"),
    ).toBeUndefined();
    expect(formatTargetsSection([], reservations, "2026-08-01", "2026-09-01")).toBeUndefined();
  });

  it("formatAnalysis sisällyttää tavoiteosion Top-taulukon jälkeen", () => {
    const costs = new Map<string, TurnoverCost>([
      ["r1", { reservation_id: "r1", cleaning_cost: 70, travel_cost: 0, laundry_cost: 0 }],
    ]);
    const a = analyzePortfolio(reservations, costs, "2026-08-01", "2026-09-01");
    const section = formatTargetsSection([target("p1", "2026-08", 6000)], reservations, "2026-08-01", "2026-09-01")!;
    const text = formatAnalysis(a, "manual (test)", "reservations: stub", false, section);

    expect(text).toContain("### Monthly targets");
    expect(text.indexOf("### Monthly targets")).toBeGreaterThan(text.indexOf("### Top"));
    // ilman osiota tavoitteita ei näy
    expect(formatAnalysis(a, "manual (test)", "reservations: stub", false)).not.toContain(
      "Monthly targets",
    );
  });
});

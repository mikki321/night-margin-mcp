import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_WINDOW_NOTE, defaultWindow, resolveWindow } from "../src/config.js";
import { analyzePortfolioInputSchema } from "../src/tools/analyzePortfolio.js";
import { compareStrategiesInputSchema } from "../src/tools/compareStrategies.js";

// Injektoitu "nyt" — 2026-07-22 UTC-päivänä
const NOW = new Date("2026-07-22T15:30:00Z");

describe("defaultWindow", () => {
  it("tänään − 30 pv → tänään + 90 pv", () => {
    expect(defaultWindow(NOW)).toEqual({ from: "2026-06-22", to: "2026-10-20" });
  });

  it("UTC-päivä ratkaisee, ei paikallinen aika", () => {
    // 23.7. klo 01:00 UTC+3 = 22.7. klo 22:00 UTC → sama ikkuna kuin NOW
    expect(defaultWindow(new Date("2026-07-23T01:00:00+03:00"))).toEqual({
      from: "2026-06-22",
      to: "2026-10-20",
    });
  });

  it("toimii kuukausi- ja vuosirajojen yli", () => {
    expect(defaultWindow(new Date("2026-01-15T00:00:00Z"))).toEqual({
      from: "2025-12-16",
      to: "2026-04-15",
    });
  });
});

describe("resolveWindow", () => {
  it("molemmat puuttuu → oletusikkuna ja isDefault=true", () => {
    expect(resolveWindow(undefined, undefined, NOW)).toEqual({
      from: "2026-06-22",
      to: "2026-10-20",
      isDefault: true,
    });
  });

  it("vain from annettu → to = from + 120 pv (sama 30+90-sääntö)", () => {
    expect(resolveWindow("2026-06-01", undefined, NOW)).toEqual({
      from: "2026-06-01",
      to: "2026-09-29",
      isDefault: false,
    });
  });

  it("vain to annettu → from = to − 120 pv (sama 30+90-sääntö)", () => {
    expect(resolveWindow(undefined, "2026-10-01", NOW)).toEqual({
      from: "2026-06-03",
      to: "2026-10-01",
      isDefault: false,
    });
  });

  it("molemmat annettu → ei muutoksia, isDefault=false", () => {
    expect(resolveWindow("2026-06-01", "2026-07-01", NOW)).toEqual({
      from: "2026-06-01",
      to: "2026-07-01",
      isDefault: false,
    });
  });

  it("virheellinen yksipuolinen päivä → selkeä virhe", () => {
    expect(() => resolveWindow("not-a-date", undefined, NOW)).toThrow(/Invalid date/);
  });
});

describe("tool-skeemat — from/to valinnaisia", () => {
  it("analyze_portfolio hyväksyy tyhjät argumentit", () => {
    expect(z.object(analyzePortfolioInputSchema).parse({})).toEqual({});
  });

  it("analyze_portfolio hyväksyy pelkän fromin", () => {
    expect(z.object(analyzePortfolioInputSchema).parse({ from: "2026-06-01" })).toEqual({
      from: "2026-06-01",
    });
  });

  it("compare_strategies hyväksyy tyhjät argumentit ja pelkän ton", () => {
    expect(z.object(compareStrategiesInputSchema).parse({})).toEqual({});
    expect(z.object(compareStrategiesInputSchema).parse({ to: "2026-10-01" })).toEqual({
      to: "2026-10-01",
    });
  });

  it("describet kertovat oletusikkunasta", () => {
    expect(analyzePortfolioInputSchema.from.description).toContain(
      "optional — defaults to last 30 + next 90 days",
    );
    expect(analyzePortfolioInputSchema.to.description).toContain(
      "optional — defaults to last 30 + next 90 days",
    );
    expect(compareStrategiesInputSchema.from.description).toContain(
      "optional — defaults to last 30 + next 90 days",
    );
    expect(compareStrategiesInputSchema.to.description).toContain(
      "optional — defaults to last 30 + next 90 days",
    );
  });
});

describe("DEFAULT_WINDOW_NOTE", () => {
  it("on täsmälleen sovittu englanninkielinen huomautus", () => {
    expect(DEFAULT_WINDOW_NOTE).toBe(
      " (default window: last 30 + next 90 days — pass from/to to change)",
    );
  });
});

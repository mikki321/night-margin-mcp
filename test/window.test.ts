import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_WINDOW_NOTE,
  defaultWindow,
  isLastDayOfMonth,
  monthEndExclusiveNote,
  resolveWindow,
} from "../src/config.js";
import { analyzePortfolioInputSchema } from "../src/tools/analyzePortfolio.js";
import { compareStrategiesInputSchema } from "../src/tools/compareStrategies.js";
import { reviewHistoryInputSchema } from "../src/tools/reviewHistory.js";

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

describe("review_history — skeema", () => {
  it("hyväksyy tyhjät argumentit", () => {
    expect(z.object(reviewHistoryInputSchema).parse({})).toEqual({});
  });

  it("hyväksyy pelkän fromin", () => {
    expect(z.object(reviewHistoryInputSchema).parse({ from: "2026-01-01" })).toEqual({
      from: "2026-01-01",
    });
  });

  it("hylkää negatiivisen avg_turnover_costin", () => {
    expect(() => z.object(reviewHistoryInputSchema).parse({ avg_turnover_cost: -1 })).toThrow();
  });

  it("describet mainitsevat koko historian ja kuukausi-inklusiivisen semantiikan", () => {
    expect(reviewHistoryInputSchema.from.description).toContain("all available history");
    expect(reviewHistoryInputSchema.to.description).toContain("INCLUSIVE");
    expect(reviewHistoryInputSchema.to.description).toContain("MONTH granularity");
  });
});

describe("DEFAULT_WINDOW_NOTE", () => {
  it("on täsmälleen sovittu englanninkielinen huomautus", () => {
    expect(DEFAULT_WINDOW_NOTE).toBe(
      " (default window: last 30 + next 90 days — pass from/to to change)",
    );
  });
});

describe("KUUNLOPPU-ANSA — isLastDayOfMonth / monthEndExclusiveNote", () => {
  it("2026-08-31 on elokuun viimeinen päivä", () => {
    expect(isLastDayOfMonth("2026-08-31")).toBe(true);
  });

  it("2026-09-01 ei ole minkään kuukauden viimeinen päivä", () => {
    expect(isLastDayOfMonth("2026-09-01")).toBe(false);
  });

  it("helmikuu ei-karkausvuonna: 28. on viimeinen, 27. ei ole", () => {
    expect(isLastDayOfMonth("2027-02-28")).toBe(true);
    expect(isLastDayOfMonth("2027-02-27")).toBe(false);
  });

  it("helmikuu karkausvuonna: 29. on viimeinen, 28. EI ole", () => {
    expect(isLastDayOfMonth("2028-02-29")).toBe(true);
    expect(isLastDayOfMonth("2028-02-28")).toBe(false);
  });

  it("monthEndExclusiveNote — täsmällinen teksti", () => {
    expect(monthEndExclusiveNote("2026-08-31")).toBe(
      "Note: to=2026-08-31 is exclusive — the night of Aug 31 is not included. Use to=2026-09-01 for the full month.",
    );
    expect(monthEndExclusiveNote("2028-02-29")).toBe(
      "Note: to=2028-02-29 is exclusive — the night of Feb 29 is not included. Use to=2028-03-01 for the full month.",
    );
  });
});

describe("KUUNLOPPU-ANSA — resolveWindow.monthEndNote", () => {
  it("to=2026-08-31 (molemmat annettu) → monthEndNote asetettu", () => {
    const r = resolveWindow("2026-08-01", "2026-08-31", NOW);
    expect(r.monthEndNote).toBe(
      "Note: to=2026-08-31 is exclusive — the night of Aug 31 is not included. Use to=2026-09-01 for the full month.",
    );
  });

  it("to=2026-09-01 → ei notea", () => {
    const r = resolveWindow("2026-08-01", "2026-09-01", NOW);
    expect(r.monthEndNote).toBeUndefined();
  });

  it("vain to=2026-08-31 annettu → monthEndNote asetettu silti", () => {
    const r = resolveWindow(undefined, "2026-08-31", NOW);
    expect(r.monthEndNote).toBe(
      "Note: to=2026-08-31 is exclusive — the night of Aug 31 is not included. Use to=2026-09-01 for the full month.",
    );
  });

  it("vain from annettu → to on LASKETTU, ei koskaan notea vaikka osuisi kuun loppuun", () => {
    // from + 120 pv voisi sattumalta osua kuun viimeiselle päivälle — silti ei
    // notea, koska käyttäjä ei antanut to:ta itse.
    const r = resolveWindow("2026-08-01", undefined, NOW);
    expect(r.monthEndNote).toBeUndefined();
  });

  it("oletusikkuna (molemmat puuttuu) → ei koskaan notea", () => {
    const r = resolveWindow(undefined, undefined, NOW);
    expect(r.monthEndNote).toBeUndefined();
    expect(r.isDefault).toBe(true);
  });

  it("helmikuu karkausvuonna to:ssa (molemmat annettu) → nightistä puhutaan Feb 29", () => {
    const r = resolveWindow("2028-02-01", "2028-02-29", NOW);
    expect(r.monthEndNote).toBe(
      "Note: to=2028-02-29 is exclusive — the night of Feb 29 is not included. Use to=2028-03-01 for the full month.",
    );
  });

  it("helmikuu ei-karkausvuonna to:ssa → Feb 28", () => {
    const r = resolveWindow("2027-02-01", "2027-02-28", NOW);
    expect(r.monthEndNote).toBe(
      "Note: to=2027-02-28 is exclusive — the night of Feb 28 is not included. Use to=2027-03-01 for the full month.",
    );
  });
});

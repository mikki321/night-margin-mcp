import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { riskAdjustedMargin } from "../src/core/risk.js";
import { readDecisions } from "../src/state.js";
import { runGapNightCheck } from "../src/tools/gapNightCheck.js";
import { runProposeDecisions } from "../src/tools/proposeDecisions.js";

describe("riskAdjustedMargin (puhdas)", () => {
  it("conservative kaksinkertaistaa, recommended ei muuta, aggressive käyttää 40 %:a", () => {
    expect(riskAdjustedMargin(25, "conservative")).toBe(50);
    expect(riskAdjustedMargin(25, "recommended")).toBe(25);
    expect(riskAdjustedMargin(25, "aggressive")).toBe(10); // round(25*0.4) = round(10) = 10
  });

  it("pyöristää lähimpään kokonaislukuun", () => {
    expect(riskAdjustedMargin(27, "aggressive")).toBe(11); // round(27*0.4) = round(10.8) = 11
    expect(riskAdjustedMargin(15, "aggressive")).toBe(6); // round(15*0.4) = round(6) = 6
  });

  it("nolla-marginaali pysyy nollana kaikilla presetellä", () => {
    expect(riskAdjustedMargin(0, "conservative")).toBe(0);
    expect(riskAdjustedMargin(0, "aggressive")).toBe(0);
  });
});

describe("propose_decisions — risk-preset skaalaa lattian ja kertoo sen tulosteessa", () => {
  const NOW = new Date("2026-06-01T12:00:00Z");
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nm-risk-propose-"));
    // Korkea manual-kustannus takaa ehdotuksia joka presetellä (kuten decisiontools.test.ts:ssä).
    env = { NM_STATE_DIR: dir, AVG_TURNOVER_COST: "200" } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recommended (oletus): marginaali ennallaan, lattia 225 (200+0+25)", async () => {
    const out = await runProposeDecisions({}, env, { now: NOW });
    expect(out).toContain("Floor uses the recommended risk preset (margin €25).");
    const decisions = readDecisions(env);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0].floor_price).toBe(225);
  });

  it("conservative: marginaali tuplattu, lattia 250 (200+0+50)", async () => {
    const out = await runProposeDecisions({ risk: "conservative" }, env, { now: NOW });
    expect(out).toContain("Floor uses the conservative risk preset (margin €50).");
    const decisions = readDecisions(env);
    expect(decisions[0].floor_price).toBe(250);
  });

  it("aggressive: marginaali 40 % (pyöristetty), lattia 210 (200+0+10)", async () => {
    const out = await runProposeDecisions({ risk: "aggressive" }, env, { now: NOW });
    expect(out).toContain("Floor uses the aggressive risk preset (margin €10).");
    const decisions = readDecisions(env);
    expect(decisions[0].floor_price).toBe(210);
  });
});

describe("gap_night_check — risk-preset skaalaa lattian ja kertoo sen tulosteessa", () => {
  const NOW = new Date("2026-06-01T12:00:00Z");
  const env = {} as NodeJS.ProcessEnv;
  // README-esimerkin aukkoyö kiinteässä mock-kalenterissa (ks. test/gapnight.test.ts).
  const PROPERTY = "demo-1br-01";
  const DATE = "2026-06-23";

  it("recommended (oletus): lattia €95 (manual 70 + matka 0 + marginaali 25)", async () => {
    const out = await runGapNightCheck({ property_id: PROPERTY, date: DATE }, env, NOW);
    expect(out).toContain("Floor €95 (turnover 70 + travel 0 + margin 25)");
    expect(out).toContain("Floor uses the recommended risk preset (margin €25).");
  });

  it("conservative: lattia €120 (manual 70 + matka 0 + marginaali 50)", async () => {
    const out = await runGapNightCheck({ property_id: PROPERTY, date: DATE, risk: "conservative" }, env, NOW);
    expect(out).toContain("Floor €120 (turnover 70 + travel 0 + margin 50)");
    expect(out).toContain("Floor uses the conservative risk preset (margin €50).");
  });

  it("aggressive: lattia €80 (manual 70 + matka 0 + marginaali 10)", async () => {
    const out = await runGapNightCheck({ property_id: PROPERTY, date: DATE, risk: "aggressive" }, env, NOW);
    expect(out).toContain("Floor €80 (turnover 70 + travel 0 + margin 10)");
    expect(out).toContain("Floor uses the aggressive risk preset (margin €10).");
  });

  it("risk-rivi näkyy myös kun yö on jo varattu tai ilman hintaa annettua verdiktiä", async () => {
    const out = await runGapNightCheck({ property_id: PROPERTY, date: DATE }, env, NOW);
    expect(out).not.toMatch(/→ (FILL|SKIP)/); // ei candidate_price/WH-avainta → ei verdiktiä
    expect(out).toContain("Floor uses the recommended risk preset");
  });
});

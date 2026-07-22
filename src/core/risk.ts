/**
 * Riskipresetit aukkoyölattian marginaalille — Wheelhousen omaa CON/REC/AGG-
 * kieltä. Kerroin MIN_MARGINiin ennen kuin se lisätään lattiaan (vaihto +
 * matka + marginaali): pienempi kerroin → matalampi lattia → täyttää useamman
 * yön mutta suojaa vähemmän katetta; suurempi kerroin toimii päinvastoin.
 * Puhdas — ei I/O:ta, ei env-lukuja (kutsuja ratkaisee MIN_MARGINin ensin).
 */

export type RiskPreset = "conservative" | "recommended" | "aggressive";

export const RISK_PRESETS: readonly RiskPreset[] = ["conservative", "recommended", "aggressive"];

export const DEFAULT_RISK_PRESET: RiskPreset = "recommended";

const RISK_MULTIPLIER: Record<RiskPreset, number> = {
  conservative: 2.0,
  recommended: 1.0,
  aggressive: 0.4,
};

/** Presetin todella käyttämä marginaali: round(MIN_MARGIN × presetin kerroin). */
export function riskAdjustedMargin(minMargin: number, risk: RiskPreset): number {
  return Math.round(minMargin * RISK_MULTIPLIER[risk]);
}

import type { CostSource } from "./costSource.js";
import { manualSource, parseTiers } from "./manual.js";

export function costSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  avgTurnoverOverride?: number,
): CostSource {
  const mode = (env.COST_SOURCE ?? "manual").toLowerCase();
  if (mode === "manual") {
    const avg = avgTurnoverOverride ?? Number(env.AVG_TURNOVER_COST ?? 70);
    if (Number.isNaN(avg) || avg < 0) {
      throw new Error(`AVG_TURNOVER_COST="${env.AVG_TURNOVER_COST}" ei ole kelvollinen luku`);
    }
    return manualSource({ avgTurnoverCost: avg, tiers: parseTiers(env.COST_TIERS) });
  }
  if (mode === "csv" || mode === "cleanhub") {
    throw new Error(
      `COST_SOURCE="${mode}" tulee vaiheessa 2 — käytä toistaiseksi COST_SOURCE=manual (tai poista muuttuja)`,
    );
  }
  throw new Error(`Tuntematon COST_SOURCE="${mode}" — vaihtoehdot: manual | csv | cleanhub`);
}

import type { CostSource } from "./costSource.js";
import { cleanhubSource } from "./cleanhub.js";
import { csvSource } from "./csv.js";
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

  if (mode === "csv") {
    if (!env.CSV_PATH) {
      throw new Error('COST_SOURCE=csv vaatii CSV_PATH-ympäristömuuttujan (esim. examples/sample-costs.csv)');
    }
    const fallback = avgTurnoverOverride ?? (env.AVG_TURNOVER_COST ? Number(env.AVG_TURNOVER_COST) : undefined);
    return csvSource({ path: env.CSV_PATH, fallbackAvg: fallback });
  }

  if (mode === "cleanhub") {
    if (!env.CLEANHUB_API_URL || !env.CLEANHUB_TOKEN) {
      throw new Error("COST_SOURCE=cleanhub vaatii CLEANHUB_API_URL- ja CLEANHUB_TOKEN-ympäristömuuttujat");
    }
    return cleanhubSource({ url: env.CLEANHUB_API_URL, token: env.CLEANHUB_TOKEN });
  }

  throw new Error(`Tuntematon COST_SOURCE="${mode}" — vaihtoehdot: manual | csv | cleanhub`);
}

import type { Reservation, TurnoverCost } from "../core/types.js";
import type { CostSource } from "./costSource.js";
import { formatMatchReport, matchCosts } from "./matchCosts.js";

/**
 * Kaskadin keskiarvo-fallback: parametri > env AVG_TURNOVER_COST > EI fallbackia.
 * Palauttaa undefined kun kumpaakaan ei ole annettu — silloin matchCosts saa
 * heittää selkeän virheen toimintaohjeineen (kaskadin haara 5) sen sijaan että
 * analyysi valmistuisi hiljaa tasakustannuksella.
 */
export function avgFallbackFromEnv(
  env: NodeJS.ProcessEnv,
  override?: number,
): number | undefined {
  if (override !== undefined) return override;
  const raw = env.AVG_TURNOVER_COST;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`AVG_TURNOVER_COST="${raw}" is not a valid number`);
  }
  return n;
}

export interface ResolvedCosts {
  /** avain = varauksen reservation_id (core/calc.ts:n odottama muoto) */
  costs: Map<string, TurnoverCost>;
  /** "Cost attribution: 41 by reservation_id, 6 by composite key (47 total)" — tyhjä kun lähde ei tarjoa raakarivejä (manual). */
  matchNote: string;
}

/**
 * Yhteinen kustannusten kohdistus KAIKILLE tooleille (analyze, compare, gap):
 * getRows-lähteillä (csv, cleanhub) matchCosts-kaskadi id → koodi → komposiitti
 * → keskiarvo-fallback; muilla (manual) suora getCosts. Yksi polku → samat
 * luvut ja sama käytös puuttuvalla rivillä joka toolissa.
 */
export async function resolveCosts(
  costSource: CostSource,
  reservations: Reservation[],
  from: string,
  to: string,
  avgFallback?: number,
): Promise<ResolvedCosts> {
  if (costSource.getRows) {
    // Haetaan rivit varausten koko aikaväliltä (checkin voi alkaa ennen jaksoa,
    // vaihto osua sen loppuun) — sama sääntö kuin cleanhub-getCostsissa.
    const rowsFrom = reservations.reduce((a, r) => (r.checkin < a ? r.checkin : a), from);
    const rowsTo = reservations.reduce((a, r) => (r.checkout > a ? r.checkout : a), to);
    const rows = await costSource.getRows(rowsFrom, rowsTo);
    const result = matchCosts(reservations, rows, { avgFallback });
    const note = [formatMatchReport(result.report), ...result.warnings].filter(Boolean).join(" · ");
    return { costs: result.costs, matchNote: note };
  }
  return { costs: await costSource.getCosts(reservations), matchNote: "" };
}

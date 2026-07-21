/**
 * Pienet env-helperit — konfiguraatioluvut luetaan yhdestä paikasta
 * selkeillä virheillä. Env injektoidaan testattavuuden vuoksi.
 */

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `${name}="${raw}" ei ole kelvollinen luku — käytä ei-negatiivista euromäärää, esim. ${name}=${fallback}`,
    );
  }
  return n;
}

/** Aukkoyölattian minimikate € (env MIN_MARGIN, oletus 25). */
export function minMargin(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "MIN_MARGIN", 25);
}

/** Keskimääräinen vaihtokustannus € per vaihto (env AVG_TURNOVER_COST, oletus 70). */
export function avgTurnoverCost(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "AVG_TURNOVER_COST", 70);
}

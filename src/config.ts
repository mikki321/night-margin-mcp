/**
 * Pienet env-helperit — konfiguraatioluvut luetaan yhdestä paikasta
 * selkeillä virheillä. Env injektoidaan testattavuuden vuoksi.
 */

import { parseISODate } from "./core/calc.js";

const MS_PER_DAY = 86_400_000;
/** Oletusikkuna: viimeiset 30 pv (tuoreet vaihdot) + seuraavat 90 pv (varaushorisontti). */
const WINDOW_BACK_DAYS = 30;
const WINDOW_FORWARD_DAYS = 90;
const WINDOW_TOTAL_DAYS = WINDOW_BACK_DAYS + WINDOW_FORWARD_DAYS;

/** Käyttäjälle näytettävä huomautus kun analyysijakso on kokonaan oletus. */
export const DEFAULT_WINDOW_NOTE =
  " (default window: last 30 + next 90 days — pass from/to to change)";

const isoDate = (t: number): string => new Date(t).toISOString().slice(0, 10);

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "Tänään" UTC-päivänä (keskiyö UTC, ms). */
function utcToday(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * KUUNLOPPU-ANSA: `to` on aina eksklusiivinen (viimeinen mukaan luettu yö on
 * to − 1 pv). Kun käyttäjä antaa to:n joka SATTUU olemaan kuukauden viimeinen
 * kalenteripäivä, kuun viimeinen yö jää pois — tarkistetaan vertaamalla
 * seuraavan päivän kuukautta (toimii helmikuulle ja karkausvuosille ilman
 * erillistä kalenterilogiikkaa).
 */
export function isLastDayOfMonth(dateStr: string): boolean {
  const t = parseISODate(dateStr);
  return isoDate(t + MS_PER_DAY).slice(8, 10) === "01";
}

/** Kuunloppu-ansan huomautusteksti — vain kun `to` on käyttäjän itse antama. */
export function monthEndExclusiveNote(to: string): string {
  const t = parseISODate(to);
  const d = new Date(t);
  const monthAbbr = MONTH_ABBR[d.getUTCMonth()];
  const day = d.getUTCDate();
  const nextDay = isoDate(t + MS_PER_DAY);
  return (
    `Note: to=${to} is exclusive — the night of ${monthAbbr} ${day} is not included. ` +
    `Use to=${nextDay} for the full month.`
  );
}

/** Palauttaa kuunloppu-huomautuksen vain kun `to` osuu kuukauden viimeiselle päivälle. */
function monthEndNoteIfApplicable(to: string): string | undefined {
  return isLastDayOfMonth(to) ? monthEndExclusiveNote(to) : undefined;
}

/** Oletusikkuna: tänään − 30 pv → tänään + 90 pv. `now` injektoitavissa testejä varten. */
export function defaultWindow(now: Date = new Date()): { from: string; to: string } {
  const today = utcToday(now);
  return {
    from: isoDate(today - WINDOW_BACK_DAYS * MS_PER_DAY),
    to: isoDate(today + WINDOW_FORWARD_DAYS * MS_PER_DAY),
  };
}

export interface ResolvedWindow {
  from: string;
  to: string;
  /** true vain kun KUMPIKIN puuttui → tuloste mainitsee oletusikkunan. */
  isDefault: boolean;
  /**
   * Asetettu vain kun KÄYTTÄJÄ antoi to:n joka on kuukauden viimeinen
   * kalenteripäivä (ei koskaan oletusikkunassa eikä kun to täydentyi from:sta).
   */
  monthEndNote?: string;
}

/**
 * Täydentää puuttuvat from/to yhdessä paikassa: molemmat puuttuu →
 * defaultWindow(now); vain toinen annettu → toinen täydennetään samalla
 * säännöllä (30 + 90 pv = 120 pv ikkuna) suhteessa annettuun.
 */
export function resolveWindow(from?: string, to?: string, now: Date = new Date()): ResolvedWindow {
  if (from !== undefined && to !== undefined) {
    return { from, to, isDefault: false, monthEndNote: monthEndNoteIfApplicable(to) };
  }
  if (from === undefined && to === undefined) return { ...defaultWindow(now), isDefault: true };
  if (from !== undefined) {
    // to on tässä LASKETTU from:sta — ei käyttäjän antama, ei koskaan notea.
    return { from, to: isoDate(parseISODate(from) + WINDOW_TOTAL_DAYS * MS_PER_DAY), isDefault: false };
  }
  // vain to annettu — käyttäjän oma to, tarkista kuunloppu-ansa.
  return {
    from: isoDate(parseISODate(to!) - WINDOW_TOTAL_DAYS * MS_PER_DAY),
    to: to!,
    isDefault: false,
    monthEndNote: monthEndNoteIfApplicable(to!),
  };
}

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `${name}="${raw}" is not a valid number — use a non-negative amount in euros, e.g. ${name}=${fallback}`,
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

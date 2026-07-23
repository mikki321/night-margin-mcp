import { z } from "zod";
import { overlapNights, parseISODate } from "../core/calc.js";
import type { Reservation } from "../core/types.js";
import {
  type ReservationSource,
  reservationSourceFromEnv,
} from "../sources/reservationSource.js";
import { type Target, readTargets, writeTargets } from "../state.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const eur = (n: number): string => {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString("en-US");
  return v < 0 ? `-€${s}` : `€${s}`;
};

/** Zod-skeema — index.ts rekisteröi tämän sellaisenaan. */
export const setTargetInputSchema = {
  property_id: z
    .string()
    .min(1)
    .describe("Property identifier as it appears in analyze_portfolio (property_id)"),
  month: z
    .string()
    .regex(MONTH_RE, "Use the format YYYY-MM")
    .describe("Target month, YYYY-MM"),
  gross_target: z.number().positive().describe("Gross revenue target for the month, €"),
};

export interface SetTargetArgs {
  property_id: string;
  month: string;
  gross_target: number;
}

/** Injektoitava lähde testejä varten. */
export interface SetTargetDeps {
  reservationSource?: ReservationSource;
}

/** Kuukauden ikkuna [YYYY-MM-01, seuraavan kuun 01) — sama eksklusiivinen loppu kuin corella. */
export function monthWindow(month: string): { from: string; to: string } {
  if (!MONTH_RE.test(month)) {
    throw new Error(`Invalid month "${month}" — use the format YYYY-MM, e.g. 2026-08`);
  }
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from, to: `${next}-01` };
}

/**
 * Kohteen brutto ikkunassa [from, to) — SAMA kohdistussääntö kuin
 * core/calc.ts: liikevaihto suhteutetaan jaksolle osuviin öihin
 * (gross/nights × jakson yöt).
 */
export function propertyGrossInWindow(
  reservations: Reservation[],
  propertyId: string,
  from: string,
  to: string,
): number {
  let gross = 0;
  for (const r of reservations) {
    if (r.property_id !== propertyId || r.nights <= 0) continue;
    gross += (r.gross_revenue / r.nights) * overlapNights(r, from, to);
  }
  return gross;
}

/**
 * Pieni tavoiteosio analyze_portfolio-tulosteeseen: rivit tavoitteista joiden
 * kuukausi leikkaa analyysijaksoa. Brutto lasketaan kuukauden ja jakson
 * leikkauksesta jo haetuista varauksista; osittainen kate mainitaan.
 * Palauttaa undefined kun yksikään tavoite ei osu jaksolle.
 */
export function formatTargetsSection(
  targets: Target[],
  reservations: Reservation[],
  from: string,
  to: string,
  /**
   * Nykyisen datalähteen tuntemat kohteet. Tavoitteet elävät yhdessä
   * ~/.night-margin/targets.json-tiedostossa riippumatta siitä ajetaanko
   * demo- vai live-tilassa, joten ilman tätä suodatinta oikean portfolion
   * kohde (oikea katuosoite) tulostui synteettisen demodatan tulokseen.
   * Tuntematon lista = ei suodatusta (vanha käytös).
   */
  knownPropertyIds?: Iterable<string>,
): string | undefined {
  const known = knownPropertyIds ? new Set(knownPropertyIds) : undefined;
  const lines: string[] = [];
  const sorted = [...targets].sort((a, b) =>
    a.month === b.month ? a.property_id.localeCompare(b.property_id) : a.month.localeCompare(b.month),
  );
  for (const t of sorted) {
    if (known && !known.has(t.property_id)) continue; // toisen tilan kohde
    let mw: { from: string; to: string };
    try {
      mw = monthWindow(t.month);
    } catch {
      continue; // viallinen rivi tiedostossa — ei kaadeta analyysiä
    }
    const lo = mw.from > from ? mw.from : from;
    const hi = mw.to < to ? mw.to : to;
    if (parseISODate(hi) <= parseISODate(lo)) continue; // kuukausi ei leikkaa jaksoa
    const gross = propertyGrossInWindow(reservations, t.property_id, lo, hi);
    const pct = t.gross_target > 0 ? (gross / t.gross_target) * 100 : 0;
    const partial = lo !== mw.from || hi !== mw.to ? ` — window covers ${lo} → ${hi} only` : "";
    lines.push(
      `- ${t.property_id} · ${t.month}: ${eur(gross)} / ${eur(t.gross_target)} (${pct.toFixed(0)}%)${partial}`,
    );
  }
  if (lines.length === 0) return undefined;
  return `### Monthly targets\n${lines.join("\n")}`;
}

/**
 * Tallentaa kuukausittaisen bruttotavoitteen kohteelle (targets.json,
 * upsert per kohde+kuukausi) ja näyttää kuukauden toteuman jos laskettavissa.
 */
export async function runSetTarget(
  args: SetTargetArgs,
  env: NodeJS.ProcessEnv = process.env,
  deps: SetTargetDeps = {},
): Promise<string> {
  if (!MONTH_RE.test(args.month)) {
    throw new Error(`Invalid month "${args.month}" — use the format YYYY-MM, e.g. 2026-08`);
  }
  if (!Number.isFinite(args.gross_target) || args.gross_target <= 0) {
    throw new Error("gross_target must be a positive amount in euros");
  }

  const targets = readTargets(env);
  const kept = targets.filter(
    (t) => !(t.property_id === args.property_id && t.month === args.month),
  );
  const replaced = kept.length < targets.length;
  kept.push({
    property_id: args.property_id,
    month: args.month,
    gross_target: args.gross_target,
    set_at: new Date().toISOString(),
  });
  writeTargets(kept, env);

  // Kuukauden toteuma jos laskettavissa — epäonnistuminen ei kaada tallennusta.
  const { from, to } = monthWindow(args.month);
  let actualLine: string;
  try {
    const source = deps.reservationSource ?? reservationSourceFromEnv(env);
    const reservations = await source.getReservations(from, to);
    const gross = propertyGrossInWindow(reservations, args.property_id, from, to);
    const pct = (gross / args.gross_target) * 100;
    actualLine =
      gross > 0
        ? `Current gross for ${args.property_id} in ${args.month}: ${eur(gross)} of ${eur(args.gross_target)} (${pct.toFixed(0)}%).`
        : `No booked gross yet for ${args.property_id} in ${args.month} (0% of ${eur(args.gross_target)}).`;
  } catch (e) {
    actualLine = `Could not compute the current month's gross (${(e as Error).message}) — the target itself is saved.`;
  }

  return [
    `Target ${replaced ? "updated" : "saved"}: ${args.property_id} · ${args.month} → gross ${eur(args.gross_target)}.`,
    actualLine,
    `Progress shows up in analyze_portfolio whenever the analysis window overlaps ${args.month}.`,
  ].join("\n");
}

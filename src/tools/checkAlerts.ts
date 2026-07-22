import { z } from "zod";
import { minMargin as minMarginFromEnv } from "../config.js";
import { totalCost } from "../core/calc.js";
import { DEFAULT_RISK_PRESET, riskAdjustedMargin } from "../core/risk.js";
import type { Reservation, TurnoverCost } from "../core/types.js";
import { type NotifyFetch, sendNotification } from "../notify.js";
import { costSourceFromEnv } from "../sources/index.js";
import { type ReservationSource, mockReservationSource } from "../sources/reservationSource.js";
import { avgFallbackFromEnv, resolveCosts } from "../sources/resolveCosts.js";
import {
  type SeenBookings,
  acquireStateLock,
  hasSeenBookings,
  readSeenBookings,
  writeSeenBookings,
} from "../state.js";
import { wheelhouseReservations } from "../wheelhouse/adapter.js";
import { WheelhouseClient } from "../wheelhouse/client.js";
import { gatherGapFloorProposals } from "./proposeDecisions.js";

const MS_PER_DAY = 86_400_000;
/** Uusien varausten hakuikkuna: [tänään − 7, tänään + 120] pv. */
const BOOKINGS_WINDOW_BEFORE_DAYS = 7;
const BOOKINGS_WINDOW_AFTER_DAYS = 120;
/** Max varausta listattuna viestissä — loput "…and N more". */
const MAX_LISTED_BOOKINGS = 5;

const eur = (n: number): string => {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString("en-US");
  return v < 0 ? `-€${s}` : `€${s}`;
};
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

function bookingsWindow(now: Date): { from: string; to: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    from: iso(today - BOOKINGS_WINDOW_BEFORE_DAYS * MS_PER_DAY),
    to: iso(today + BOOKINGS_WINDOW_AFTER_DAYS * MS_PER_DAY),
  };
}

function formatBookingLine(r: Reservation, cost: TurnoverCost | undefined): string {
  const nightsLabel = `${r.nights} night${r.nights === 1 ? "" : "s"}`;
  const gross = eur(r.gross_revenue);
  if (!cost) {
    return `🏠 New booking: ${r.property_id} · ${r.checkin}, ${nightsLabel} · gross ${gross} (turnover cost unavailable — check the cost source)`;
  }
  const net = r.gross_revenue - totalCost(cost);
  const perNight = r.nights > 0 ? net / r.nights : net;
  return `🏠 New booking: ${r.property_id} · ${r.checkin}, ${nightsLabel} · gross ${gross} → **net ${eur(net)} after turnover** (${eur(perNight)}/night)`;
}

/** Zod-skeema — index.ts rekisteröi tämän sellaisenaan. */
export const checkAlertsInputSchema = {
  send: z
    .boolean()
    .optional()
    .describe(
      "Send a notification if a channel is configured (default true — set NM_TELEGRAM_BOT_TOKEN + NM_TELEGRAM_CHAT_ID, " +
        "or NM_WEBHOOK_URL, to configure one). Set false to only see the report without sending anything.",
    ),
};

export interface CheckAlertsArgs {
  send?: boolean;
}

/** Injektoitavat riippuvuudet testejä varten — tuotannossa rakennetaan env:stä. */
export interface CheckAlertsDeps {
  client?: WheelhouseClient;
  reservationSource?: ReservationSource;
  now?: Date;
  fetchImpl?: NotifyFetch;
}

/**
 * Proaktiiviset hälytykset, read-only: (1) tulevat aukkoyöt jotka on
 * hinnoiteltu alle omakustannelattian (aina recommended-riskipreseti, sama
 * datapolku kuin propose_decisions mutta EI koskaan tallenna päätöslokiin),
 * ja (2) uudet varaukset viime tarkistuksen jälkeen (netto vaihtokustannusten
 * jälkeen — "nähty"-joukko asuu NM_STATE_DIR/seen_bookings.json:issa).
 * Lähettää ilmoituksen jos kanava on konfiguroitu eikä send ole false;
 * tekstiraportti palautetaan aina.
 */
export async function runCheckAlerts(
  args: CheckAlertsArgs,
  env: NodeJS.ProcessEnv = process.env,
  deps: CheckAlertsDeps = {},
): Promise<string> {
  const now = deps.now ?? new Date();

  const key = env.WHEELHOUSE_API_KEY?.trim();
  const client =
    deps.client ?? (key ? new WheelhouseClient({ apiKey: key, baseUrl: env.WHEELHOUSE_API_URL }) : undefined);
  const source: ReservationSource =
    deps.reservationSource ??
    (client
      ? wheelhouseReservations(client, { channel: env.WHEELHOUSE_CHANNEL })
      : mockReservationSource());

  // 1) Floor-hälytys — sama datapolku kuin propose_decisions (seuraavat 30 pv,
  // aina recommended-preseti), mutta read-only: ei koskaan tallenna ehdotuksia.
  const recommendedMargin = riskAdjustedMargin(minMarginFromEnv(env), DEFAULT_RISK_PRESET);
  const floorResult = await gatherGapFloorProposals(
    {},
    env,
    { client, reservationSource: source, now },
    recommendedMargin,
  );

  let floorLine: string | undefined;
  if (!floorResult.blocked) {
    const nightCount = floorResult.proposals.reduce((acc, p) => acc + p.dates.length, 0);
    const propertyCount = new Set(floorResult.proposals.map((p) => p.property_id)).size;
    if (nightCount > 0) {
      floorLine =
        `⚠️ ${nightCount} gap night${nightCount === 1 ? "" : "s"} on ${propertyCount} propert${propertyCount === 1 ? "y" : "ies"} ` +
        `${nightCount === 1 && propertyCount === 1 ? "is" : "are"} priced below your cost floor — run propose_decisions to review.`;
    }
  }

  // 2) Uudet varaukset — [tänään-7, tänään+120], verrattuna paikallisesti
  // muistettuun reservation_id-joukkoon (seen_bookings.json).
  const { from: bFrom, to: bTo } = bookingsWindow(now);
  const allReservations = await source.getReservations(bFrom, bTo);
  const nowIso = now.toISOString();

  let isBaselineRun = false;
  let baselineCount = 0;
  let newReservations: Reservation[] = [];

  const release = await acquireStateLock(env);
  try {
    // Baseline = tiedoston OLEMASSAOLO, ei sen tyhjyys — muuten nolla
    // varausta ensimmäisellä ajolla tekisi JOKAISESTA myöhemmästä ajosta
    // baselinen kunnes ensimmäinen varaus ilmestyy (se jäisi hälyttämättä).
    isBaselineRun = !hasSeenBookings(env);
    const seen = readSeenBookings(env);
    if (isBaselineRun) {
      // Ensimmäinen ajo: EI listata olemassa olevia historiallisina "uusina" —
      // kirjataan kaikki seeniin ja kerrotaan baseline-tilanne.
      baselineCount = allReservations.length;
      const updated: SeenBookings = {};
      for (const r of allReservations) updated[r.reservation_id] = nowIso;
      writeSeenBookings(updated, env);
    } else {
      newReservations = allReservations.filter((r) => !(r.reservation_id in seen));
      if (newReservations.length > 0) {
        const updated: SeenBookings = { ...seen };
        for (const r of newReservations) updated[r.reservation_id] = nowIso;
        writeSeenBookings(updated, env);
      }
    }
  } finally {
    release();
  }

  let bookingsSection: string | undefined;
  if (isBaselineRun) {
    bookingsSection =
      `Baseline recorded: ${baselineCount} existing booking${baselineCount === 1 ? "" : "s"} — ` +
      `you'll be alerted about new ones from now on.`;
  } else if (newReservations.length > 0) {
    newReservations.sort((a, b) => (a.checkin < b.checkin ? -1 : a.checkin > b.checkin ? 1 : 0));

    let costsById = new Map<string, TurnoverCost>();
    let costNote = "";
    try {
      const costSource = costSourceFromEnv(env);
      const resolved = await resolveCosts(costSource, newReservations, bFrom, bTo, avgFallbackFromEnv(env));
      costsById = resolved.costs;
    } catch (e) {
      // Kustannushaun kaatuminen ei saa kaataa koko hälytystä (cron/--watch
      // ajaa tätä ilman valvontaa) — näytä bruttoluvut ja kerro syy.
      costNote = `Note: turnover cost lookup failed (${(e as Error).message}) — showing gross only.`;
    }

    const shown = newReservations.slice(0, MAX_LISTED_BOOKINGS);
    const remainder = newReservations.length - shown.length;
    bookingsSection = [
      ...shown.map((r) => formatBookingLine(r, costsById.get(r.reservation_id))),
      ...(remainder > 0 ? [`…and ${remainder} more`] : []),
      ...(costNote ? [costNote] : []),
    ].join("\n");
  }

  const parts: string[] = [];
  if (floorLine) parts.push(floorLine);
  if (bookingsSection) parts.push(bookingsSection);
  if (parts.length === 0) {
    parts.push("All clear — no gap nights below floor, no new bookings since the last check.");
  }
  let text = parts.join("\n\n");

  const send = args.send ?? true;
  if (send) {
    const result = await sendNotification(text, env, deps.fetchImpl);
    if (result.sent) {
      text += `\n\nSent via ${result.via}.`;
    } else if (result.note) {
      text += `\n\n(Not sent: ${result.note})`;
    }
  }

  return text;
}

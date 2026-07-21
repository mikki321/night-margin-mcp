import { z } from "zod";
import { minMargin as minMarginFromEnv } from "../config.js";
import { parseISODate } from "../core/calc.js";
import {
  type GapFloorProposal,
  type NightPrice,
  gapNightsByProperty,
  proposeGapFloorDecisions,
} from "../core/decisions.js";
import type { Reservation } from "../core/types.js";
import { costSourceFromEnv } from "../sources/index.js";
import {
  type ReservationSource,
  mockReservationSource,
} from "../sources/reservationSource.js";
import { avgFallbackFromEnv, resolveCosts } from "../sources/resolveCosts.js";
import {
  channelForListing,
  listingFromDocumented,
  wheelhouseReservations,
} from "../wheelhouse/adapter.js";
import { WheelhouseClient, type WhListing } from "../wheelhouse/client.js";
import {
  type Decision,
  nextDecisionIdNumber,
  readDecisions,
  writeDecisions,
} from "../state.js";

const MS_PER_DAY = 86_400_000;
/** Tämän toolin oletusikkuna: SEURAAVAT 30 pv — päätökset koskevat tulevaisuutta. */
const PROPOSE_WINDOW_DAYS = 30;

const eur = (n: number): string => {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString("en-US");
  return v < 0 ? `-€${s}` : `€${s}`;
};
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const utcTodayIso = (now: Date): string =>
  iso(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Zod-skeema — index.ts rekisteröi tämän sellaisenaan. */
export const proposeDecisionsInputSchema = {
  from: z
    .string()
    .optional()
    .describe("Window start, YYYY-MM-DD (optional — defaults to today; decisions apply to future nights)"),
  to: z
    .string()
    .optional()
    .describe("Window end (exclusive), YYYY-MM-DD (optional — defaults to 30 days from the start)"),
};

export interface ProposeWindow {
  from: string;
  to: string;
  isDefault: boolean;
}

/**
 * Ikkunan täydennys tälle toolille: molemmat puuttuu → [tänään, tänään + 30 pv);
 * vain toinen annettu → toinen täydennetään 30 pv:n säännöllä.
 */
export function proposeWindow(from?: string, to?: string, now: Date = new Date()): ProposeWindow {
  if (from !== undefined && to !== undefined) return { from, to, isDefault: false };
  if (from !== undefined) {
    return { from, to: iso(parseISODate(from) + PROPOSE_WINDOW_DAYS * MS_PER_DAY), isDefault: false };
  }
  if (to !== undefined) {
    return { from: iso(parseISODate(to) - PROPOSE_WINDOW_DAYS * MS_PER_DAY), to, isDefault: false };
  }
  const today = utcTodayIso(now);
  return { from: today, to: iso(parseISODate(today) + PROPOSE_WINDOW_DAYS * MS_PER_DAY), isDefault: true };
}

export interface ProposeArgs {
  from?: string;
  to?: string;
}

/** Injektoitavat riippuvuudet testejä varten — tuotannossa rakennetaan env:stä. */
export interface ProposeDeps {
  client?: WheelhouseClient;
  reservationSource?: ReservationSource;
  now?: Date;
}

function formatDates(dates: string[]): string {
  return dates.length === 1
    ? dates[0]
    : `${dates[0]} – ${dates[dates.length - 1]}`;
}

function formatRecRange(p: GapFloorProposal): string {
  return p.rec_min === p.rec_max ? eur(p.rec_min) : `${eur(p.rec_min)}–${eur(p.rec_max)}`;
}

/**
 * Ehdottaa aukkoyölattia-päätöksiä ja tallentaa ne decisions.json:iin
 * (status "proposed"; saman ikkunan vanhat proposed-rivit korvataan).
 * WH-avaimella hinnat = Wheelhousen price_recommendations; ilman avainta
 * (mock-tila) verrataan lattiaa kohteen keskimääräiseen listahintaan.
 */
export async function runProposeDecisions(
  args: ProposeArgs,
  env: NodeJS.ProcessEnv = process.env,
  deps: ProposeDeps = {},
): Promise<string> {
  const now = deps.now ?? new Date();
  const today = utcTodayIso(now);
  const resolved = proposeWindow(args.from, args.to, now);
  let { from } = resolved;
  const { to, isDefault } = resolved;

  // Päätökset koskevat tulevaisuutta — menneet yöt eivät ole päätettävissä.
  let clampNote = "";
  if (from < today) {
    if (to <= today) {
      return (
        `The window ${from} → ${to} is entirely in the past — pricing decisions apply to future nights. ` +
        `Try propose_decisions without arguments for the next ${PROPOSE_WINDOW_DAYS} days.`
      );
    }
    clampNote = ` (start clamped from ${from} to today — decisions apply to future nights)`;
    from = today;
  }

  const key = env.WHEELHOUSE_API_KEY?.trim();
  const client =
    deps.client ?? (key ? new WheelhouseClient({ apiKey: key, baseUrl: env.WHEELHOUSE_API_URL }) : undefined);
  const source =
    deps.reservationSource ??
    (client
      ? wheelhouseReservations(client, { channel: env.WHEELHOUSE_CHANNEL })
      : mockReservationSource());

  const reservations = await source.getReservations(from, to);
  const windowLine = `Window: ${from} → ${to}${isDefault ? ` (default: next ${PROPOSE_WINDOW_DAYS} days — pass from/to to change)` : ""}${clampNote}`;
  if (reservations.length === 0) {
    return [
      `## Pricing decision proposals`,
      windowLine,
      `No reservations found in the window — cannot estimate cost floors or find gap nights. Check the data source and the dates.`,
    ].join("\n");
  }

  const costSource = costSourceFromEnv(env);
  const { costs } = await resolveCosts(costSource, reservations, from, to, avgFallbackFromEnv(env));
  const gaps = gapNightsByProperty(reservations, from, to);
  const totalGapNights = [...gaps.values()].reduce((acc, d) => acc + d.length, 0);

  // Hinnat per kohde: WH-suositukset avaimella; mock-tilassa kohteen ADR-estimaatti.
  const priceRecsByProperty = new Map<string, NightPrice[]>();
  const listingByProperty = new Map<string, WhListing>();
  const priceNotes: string[] = [];
  let priceLabel: string;

  if (client) {
    priceLabel = "Wheelhouse price recommendations";
    const listings = (await client.listListings()).filter((l) => l.is_active !== false);
    for (const listing of listings) listingByProperty.set(listingFromDocumented(listing), listing);
    for (const propertyId of gaps.keys()) {
      const listing = listingByProperty.get(propertyId);
      if (!listing) {
        priceNotes.push(`no Wheelhouse listing match for "${propertyId}" — skipped`);
        continue;
      }
      const channel = channelForListing(listing, env.WHEELHOUSE_CHANNEL);
      try {
        const recs = await client.priceRecommendations(listing.id, channel);
        priceRecsByProperty.set(
          propertyId,
          recs.map((r) => ({ stay_date: r.stay_date, price: r.price })),
        );
      } catch (e) {
        priceNotes.push(`price recommendations failed for "${propertyId}" (${(e as Error).message}) — skipped`);
      }
    }
  } else {
    priceLabel =
      "demo estimate — the property's average nightly rate (set WHEELHOUSE_API_KEY for real Wheelhouse recommendations)";
    for (const [propertyId, gapDates] of gaps) {
      const propRes = reservations.filter((r: Reservation) => r.property_id === propertyId);
      const gross = propRes.reduce((acc, r) => acc + r.gross_revenue, 0);
      const nights = propRes.reduce((acc, r) => acc + r.nights, 0);
      if (nights <= 0) continue;
      const adr = Math.round(gross / nights);
      priceRecsByProperty.set(
        propertyId,
        gapDates.map((d) => ({ stay_date: d, price: adr })),
      );
    }
  }

  const proposals = proposeGapFloorDecisions({
    reservations,
    costsById: costs,
    priceRecsByProperty,
    from,
    to,
    minMargin: minMarginFromEnv(env),
  });

  // Talleta: saman ikkunan vanhat proposed-rivit korvataan; id:t juoksevat koko lokin yli.
  const existing = readDecisions(env);
  let nextId = nextDecisionIdNumber(existing);
  const kept = existing.filter(
    (d) =>
      !(d.status === "proposed" && d.type === "gap_floor" && d.dates.some((dt) => dt >= from && dt < to)),
  );
  const createdAt = new Date().toISOString();
  const newDecisions: Decision[] = proposals.map((p) => {
    const listing = listingByProperty.get(p.property_id);
    return {
      id: `d${nextId++}`,
      created_at: createdAt,
      type: "gap_floor",
      property_id: p.property_id,
      listing_id: listing ? listing.id : "mock",
      // KIRJOITUSkanava = listingin OMA channel-kenttä ILMAN env-yliajoa
      // (turvasääntö 5: ei koskaan kirjoituksia muulle kuin listingin omalle
      // kanavalle; WHEELHOUSE_CHANNEL vaikuttaa vain lukuihin).
      channel: listing ? channelForListing(listing) : "mock",
      currency: listing?.currency?.trim() || "EUR",
      dates: p.dates,
      floor_price: p.floor_price,
      wh_recommended_price: p.rec_min,
      expected: {
        protected_nights: p.protected_nights,
        floor_vs_rec_delta: Math.round(p.floor_vs_rec_delta),
      },
      status: "proposed",
    };
  });
  writeDecisions([...kept, ...newDecisions], env);

  // Tuloste
  const parts: string[] = [];
  parts.push("## Pricing decision proposals");
  parts.push(
    [
      windowLine,
      `Price basis: ${priceLabel}`,
      `Cost source: ${costSource.label} · reservations: ${source.label}`,
      ...(priceNotes.length > 0 ? [`Notes: ${priceNotes.join(" · ")}`] : []),
    ].join("\n"),
  );

  if (proposals.length === 0) {
    parts.push(
      totalGapNights === 0
        ? "No gap nights in the window — nothing to propose."
        : `No proposals — prices for all ${totalGapNights} gap night${totalGapNights === 1 ? "" : "s"} in the window are at or above the cost floor (turnover + travel + minimum margin). That's good: nothing is priced below cost.`,
    );
    return parts.join("\n\n");
  }

  const lines: string[] = [];
  newDecisions.forEach((d, i) => {
    const p = proposals[i];
    lines.push(
      `${i + 1}. **${d.id} · ${d.property_id}** · ${formatDates(d.dates)} (${p.protected_nights} night${p.protected_nights === 1 ? "" : "s"})\n` +
        `   Raise to floor ${eur(d.floor_price)}/night — protects ${p.protected_nights} night${p.protected_nights === 1 ? "" : "s"} from selling below cost (floor ${eur(d.floor_price)} vs current recommendation ${formatRecRange(p)}).`,
    );
  });
  parts.push(
    `Found ${proposals.length} proposal${proposals.length === 1 ? "" : "s"} — gap nights where the current price is below your cost floor:\n\n${lines.join("\n")}`,
  );
  parts.push(
    [
      `Apply with: apply_decision {"decision_id": "${newDecisions[0].id}", "confirm": true}`,
      `Preview the exact payload first with: apply_decision {"decision_id": "${newDecisions[0].id}"}`,
    ].join("\n"),
  );
  return parts.join("\n\n");
}

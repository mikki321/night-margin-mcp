import { z } from "zod";
import { minMargin as minMarginFromEnv } from "../config.js";
import { parseISODate } from "../core/calc.js";
import {
  type GapFloorProposal,
  type NightPrice,
  gapNightsByProperty,
  proposeGapFloorDecisions,
} from "../core/decisions.js";
import { DEFAULT_RISK_PRESET, type RiskPreset, riskAdjustedMargin } from "../core/risk.js";
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
  acquireStateLock,
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
  risk: z
    .enum(["conservative", "recommended", "aggressive"])
    .optional()
    .describe(
      "Risk preset for the gap-night floor's minimum margin (Wheelhouse's own CON/REC/AGG language): " +
        "conservative doubles MIN_MARGIN, recommended keeps it as configured (default), aggressive uses 40% of it.",
    ),
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
  risk?: RiskPreset;
}

/** Injektoitavat riippuvuudet testejä varten — tuotannossa rakennetaan env:stä. */
export interface ProposeDeps {
  client?: WheelhouseClient;
  reservationSource?: ReservationSource;
  now?: Date;
}

/** Seuraava päivä ISO-muodossa — `to` on eksklusiivinen, joten horisontin
 *  viimeinen yö vaatii +1 päivän kelvatakseen `to`-arvoksi. */
function nextDay(isoDate: string): string {
  return iso(Date.parse(`${isoDate}T00:00:00Z`) + MS_PER_DAY);
}

function formatDates(dates: string[]): string {
  return dates.length === 1
    ? dates[0]
    : `${dates[0]} – ${dates[dates.length - 1]}`;
}

function formatRecRange(p: GapFloorProposal): string {
  return p.rec_min === p.rec_max ? eur(p.rec_min) : `${eur(p.rec_min)}–${eur(p.rec_max)}`;
}

/** Tiivis id-lista: peräkkäiset numerot rangeksi — "d1, d2, d3, d7" → "d1–d3, d7". */
export function formatIdRanges(ids: string[]): string {
  const nums = ids
    .map((id) => /^d(\d+)$/.exec(id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const other = ids.filter((id) => !/^d\d+$/.test(id));
  const parts: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(j > i ? `d${nums[i]}–d${nums[j]}` : `d${nums[i]}`);
    i = j + 1;
  }
  return [...parts, ...other].join(", ");
}

export interface GapFloorGatherResult {
  from: string;
  to: string;
  isDefault: boolean;
  clampNote: string;
  /**
   * Asetettu kun mitään ei voitu arvioida (ikkuna kokonaan menneisyydessä, tai
   * ei varauksia ikkunassa) — proposals on tyhjä eikä kustannus-/hintadataa
   * haettu. Kutsuja päättää oman viestinsä (propose_decisions ja check_alerts
   * sanovat tämän eri sanoin).
   */
  blocked?: "entirely-past" | "no-reservations";
  reservations: Reservation[];
  costSourceLabel: string;
  reservationSourceLabel: string;
  priceLabel: string;
  priceNotes: string[];
  totalGapNights: number;
  pricedGapNights: number;
  excludedGapNights: number;
  overlappingAppliedIds: string[];
  proposals: GapFloorProposal[];
  listingByProperty: Map<string, WhListing>;
  /** Viimeisin yö jolle Wheelhouse antoi hintasuosituksen (rullaava ~30 vrk). */
  priceHorizon?: string;
}

/**
 * Hakee aukkoyölattia-ehdotukset ikkunalle: ratkaisee ikkunan, hakee
 * varaukset + kustannukset + hintadatan ja ajaa ydinlaskennan. EI koske
 * päätöslokin PYSYVIIN riveihin (lukee vain applied-päätökset poissulkua
 * varten, kuten ennenkin) — jaettu propose_decisionsin (joka tallentaa
 * tuloksen) ja check_alertsin (joka vain laskee ne, read-only) kesken.
 */
export async function gatherGapFloorProposals(
  args: ProposeArgs,
  env: NodeJS.ProcessEnv,
  deps: ProposeDeps,
  minMargin: number,
): Promise<GapFloorGatherResult> {
  const now = deps.now ?? new Date();
  const today = utcTodayIso(now);
  const resolved = proposeWindow(args.from, args.to, now);
  let { from } = resolved;
  const { to, isDefault } = resolved;

  // Päätökset koskevat tulevaisuutta — menneet yöt eivät ole päätettävissä.
  let clampNote = "";
  if (from < today) {
    if (to <= today) {
      return {
        from,
        to,
        isDefault,
        clampNote: "",
        blocked: "entirely-past",
        reservations: [],
        costSourceLabel: "",
        reservationSourceLabel: "",
        priceLabel: "",
        priceNotes: [],
        totalGapNights: 0,
        pricedGapNights: 0,
        excludedGapNights: 0,
        overlappingAppliedIds: [],
        proposals: [],
        listingByProperty: new Map(),
      };
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
  if (reservations.length === 0) {
    return {
      from,
      to,
      isDefault,
      clampNote,
      blocked: "no-reservations",
      reservations: [],
      costSourceLabel: "",
      reservationSourceLabel: source.label,
      priceLabel: "",
      priceNotes: [],
      totalGapNights: 0,
      pricedGapNights: 0,
      excludedGapNights: 0,
      overlappingAppliedIds: [],
      proposals: [],
      listingByProperty: new Map(),
    };
  }

  const costSource = costSourceFromEnv(env);
  const { costs } = await resolveCosts(costSource, reservations, from, to, avgFallbackFromEnv(env));
  const gaps = gapNightsByProperty(reservations, from, to);

  // Löydös: applied-päätöksen kattamat yöt suljetaan pois uusista ehdotuksista.
  // Päällekkäinen päätös samoille öille snapshottaisi TYÖKALUN OMAN lattiahinnan
  // "aiempana tilana" → väärässä järjestyksessä tehty revert kirjoittaisi sen
  // takaisin. Revert ensin, propose sitten.
  const priorLog = readDecisions(env);
  const appliedNights = new Map<string, Set<string>>();
  for (const d of priorLog) {
    if (d.status !== "applied") continue;
    for (const night of d.dates) {
      if (night < from || night >= to) continue;
      let set = appliedNights.get(d.property_id);
      if (!set) appliedNights.set(d.property_id, (set = new Set()));
      set.add(night);
    }
  }
  const gapSetByProperty = new Map([...gaps].map(([p, ds]) => [p, new Set(ds)] as const));
  let excludedGapNights = 0;
  for (const [propertyId, gapSet] of gapSetByProperty) {
    const set = appliedNights.get(propertyId);
    if (!set) continue;
    for (const night of set) if (gapSet.has(night)) excludedGapNights++;
  }
  const overlappingAppliedIds: string[] = [];
  if (excludedGapNights > 0) {
    for (const d of priorLog) {
      if (d.status !== "applied") continue;
      const gapSet = gapSetByProperty.get(d.property_id);
      if (gapSet && d.dates.some((dt) => dt >= from && dt < to && gapSet.has(dt))) {
        overlappingAppliedIds.push(d.id);
      }
    }
  }

  // Aukkoyötilastot ilman applied-katettuja öitä — viestit eivät saa väittää
  // että poissuljetut yöt olisi verrattu lattiaan.
  const totalGapNights =
    [...gaps.values()].reduce((acc, d) => acc + d.length, 0) - excludedGapNights;

  // Hinnat per kohde: WH-suositukset avaimella; mock-tilassa kohteen ADR-estimaatti.
  const priceRecsByProperty = new Map<string, NightPrice[]>();
  // Min stay per yö per kohde (vain kokonaisluvut ≥ 2; null/puuttuva = ei
  // sääntöä = 1) — täytetään vain live-tilassa. Mock-tilassa jää tyhjäksi →
  // lattiat täsmälleen ennallaan.
  const minStayByProperty = new Map<string, ReadonlyMap<string, number>>();
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
        continue; // ilman hintadataa öitä ei voi flägätä → min stay -haku olisi turha kutsu
      }
      // Suositusten RINNALLA yön min stay samalle ikkunalle (1 lisäkutsu per
      // gap-kohde, sarjassa — clientin throttle tahdistaa). Haun epäonnistuminen
      // EI kaada proposea: fallback = ei sääntöä = 1 (lattiat ennallaan) + note.
      try {
        const days = await client.getMinStayCalendar(listing.id, channel, from, to);
        const byDate = new Map<string, number>();
        for (const day of days) {
          const n = day.min_stay;
          if (typeof day.stay_date === "string" && typeof n === "number" && Number.isFinite(n) && Math.floor(n) >= 2) {
            byDate.set(day.stay_date, Math.floor(n));
          }
        }
        if (byDate.size > 0) minStayByProperty.set(propertyId, byDate);
      } catch (e) {
        priceNotes.push(
          `min-stay lookup failed for "${propertyId}" (${(e as Error).message}) — floors assume a 1-night minimum stay`,
        );
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

  // Löydös 6: yöt ilman hintadataa ohitetaan lattiavertailusta — "ei ehdotuksia"
  // -viesti ei saa yliväittää. M = hinnalliset aukkoyöt, N = kaikki aukkoyöt
  // (kummastakin on jo poistettu applied-päätösten kattamat yöt).
  let pricedGapNights = 0;
  for (const [propertyId, gapDates] of gaps) {
    const priced = new Set((priceRecsByProperty.get(propertyId) ?? []).map((p) => p.stay_date));
    const excluded = appliedNights.get(propertyId);
    pricedGapNights += gapDates.filter((d) => priced.has(d) && !excluded?.has(d)).length;
  }

  // Wheelhousen hintasuositukset kattavat rullaavan ~30 yön horisontin (verifioitu
  // livenä 23.7.: stay_date 2026-07-23 → 2026-08-21, tasan 30 riviä per listing).
  // Sen takana olevia öitä EI voi verrata lattiaan lainkaan — käyttäjän on
  // nähtävä horisontti, muutta "ei ehdotuksia" luetaan väärin "kaikki kunnossa".
  let priceHorizon: string | undefined;
  for (const recs of priceRecsByProperty.values()) {
    for (const r of recs) {
      if (r.stay_date && (priceHorizon === undefined || r.stay_date > priceHorizon)) {
        priceHorizon = r.stay_date;
      }
    }
  }

  if (excludedGapNights > 0) {
    priceNotes.push(
      `${excludedGapNights} gap night${excludedGapNights === 1 ? " is" : "s are"} already covered by applied decision${overlappingAppliedIds.length === 1 ? "" : "s"} ${formatIdRanges(overlappingAppliedIds)} — excluded from proposals (revert first to re-propose)`,
    );
  }

  const proposals = proposeGapFloorDecisions({
    reservations,
    costsById: costs,
    priceRecsByProperty,
    from,
    to,
    minMargin,
    excludeNights: appliedNights,
    minStayByProperty,
  });

  return {
    from,
    to,
    isDefault,
    clampNote,
    reservations,
    costSourceLabel: costSource.label,
    reservationSourceLabel: source.label,
    priceLabel,
    priceNotes,
    totalGapNights,
    pricedGapNights,
    excludedGapNights,
    overlappingAppliedIds,
    proposals,
    listingByProperty,
    priceHorizon,
  };
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
  const risk: RiskPreset = args.risk ?? DEFAULT_RISK_PRESET;
  const adjustedMargin = riskAdjustedMargin(minMarginFromEnv(env), risk);
  const result = await gatherGapFloorProposals(args, env, deps, adjustedMargin);

  if (result.blocked === "entirely-past") {
    return (
      `The window ${result.from} → ${result.to} is entirely in the past — pricing decisions apply to future nights. ` +
      `Try propose_decisions without arguments for the next ${PROPOSE_WINDOW_DAYS} days.`
    );
  }

  const windowLine = `Window: ${result.from} → ${result.to}${result.isDefault ? ` (default: next ${PROPOSE_WINDOW_DAYS} days — pass from/to to change)` : ""}${result.clampNote}`;
  const riskLine = `Floor uses the ${risk} risk preset (margin ${eur(adjustedMargin)}).`;

  if (result.blocked === "no-reservations") {
    return [
      `## Pricing decision proposals`,
      windowLine,
      `No reservations found in the window — cannot estimate cost floors or find gap nights. Check the data source and the dates.`,
    ].join("\n");
  }

  const {
    from,
    to,
    proposals,
    priceLabel,
    priceNotes,
    costSourceLabel,
    reservationSourceLabel,
    totalGapNights,
    pricedGapNights,
    excludedGapNights,
    overlappingAppliedIds,
    listingByProperty,
    priceHorizon,
  } = result;

  // Talleta LUKON ALLA (rinnakkainen sessio voisi muuten hävittää välissä
  // tehdyt apply/propose-kirjoitukset — read-modify-write ei ole atominen):
  // saman ikkunan vanhat proposed-rivit korvataan; id:t juoksevat koko lokin yli.
  const release = await acquireStateLock(env);
  const replacedIds: string[] = [];
  let newDecisions: Decision[];
  try {
    const existing = readDecisions(env);
    let nextId = nextDecisionIdNumber(existing);
    const kept = existing.filter((d) => {
      const replaced =
        d.status === "proposed" && d.type === "gap_floor" && d.dates.some((dt) => dt >= from && dt < to);
      if (replaced) replacedIds.push(d.id);
      return !replaced;
    });
    const createdAt = new Date().toISOString();
    newDecisions = proposals.map((p) => {
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
  } finally {
    release();
  }

  // Tuloste
  const parts: string[] = [];
  parts.push("## Pricing decision proposals");
  parts.push(
    [
      windowLine,
      riskLine,
      `Price basis: ${priceLabel}`,
      `Cost source: ${costSourceLabel} · reservations: ${reservationSourceLabel}`,
      ...(priceNotes.length > 0 ? [`Notes: ${priceNotes.join(" · ")}`] : []),
    ].join("\n"),
  );

  // Löydös 9: vanhojen ehdotusten korvaaminen sanotaan ääneen — käyttäjän
  // (tai aiemman viestin) hallussa olevat id:t eivät enää kelpaa.
  if (replacedIds.length > 0) {
    parts.push(
      `Replaced ${replacedIds.length} earlier proposal${replacedIds.length === 1 ? "" : "s"} for this window — ` +
        `${formatIdRanges(replacedIds)} ${replacedIds.length === 1 ? "is" : "are"} no longer valid` +
        `${proposals.length > 0 ? "; use the new ids below" : ""}.`,
    );
  }

  // Wheelhouse antaa hintasuosituksia vain rullaavalle ~30 yön horisontille.
  // Ilman tätä lausetta "no proposals" luetaan "kaikki hinnat ovat kunnossa",
  // vaikka tosiasiassa suurinta osaa ikkunasta ei voitu tarkistaa lainkaan.
  const horizonNote = priceHorizon
    ? ` Wheelhouse price recommendations reach through ${priceHorizon} (a rolling ~30-night horizon) — gap nights after that date have no price to compare and were not checked. Re-run with to=${nextDay(priceHorizon)} to see everything that is checkable today.`
    : "";

  // Sama tieto myös silloin kun ehdotuksia LÖYTYI: muuten ne näyttävät
  // kattavan koko ikkunan, vaikka horisontin takaosaa ei tarkistettu.
  // `to` on eksklusiivinen, joten tarkistamatta jäi jotain vasta kun horisontin
  // SEURAAVA yö mahtuu vielä ikkunaan — muuten oletusikkuna näyttäisi turhan
  // huomautuksen nollasta yöstä.
  if (priceHorizon && nextDay(priceHorizon) < to && proposals.length > 0) {
    parts.push(
      `Checked through ${priceHorizon} only — Wheelhouse price recommendations cover a rolling ~30-night horizon, so the rest of the window (to ${to}) has no price data and was not compared against the floor.`,
    );
  }

  if (proposals.length === 0) {
    let message: string;
    if (totalGapNights === 0 && excludedGapNights > 0) {
      message =
        `No proposals — all ${excludedGapNights} gap night${excludedGapNights === 1 ? "" : "s"} in the window ` +
        `${excludedGapNights === 1 ? "is" : "are"} already covered by applied decision${overlappingAppliedIds.length === 1 ? "" : "s"} ` +
        `${formatIdRanges(overlappingAppliedIds)}. Revert ${overlappingAppliedIds.length === 1 ? "it" : "them"} first to re-propose these nights.`;
    } else if (totalGapNights === 0) {
      message = "No gap nights in the window — nothing to propose.";
    } else if (pricedGapNights === 0) {
      message =
        `No proposals — none of the ${totalGapNights} gap night${totalGapNights === 1 ? "" : "s"} in the window have price data to compare against the cost floor.` +
        horizonNote;
    } else if (pricedGapNights < totalGapNights) {
      message =
        `No proposals — all ${pricedGapNights} priced gap night${pricedGapNights === 1 ? "" : "s"} (of ${totalGapNights}) are at or above the cost floor ` +
        `(turnover + travel + minimum margin); the remaining ${totalGapNights - pricedGapNights} ha${totalGapNights - pricedGapNights === 1 ? "s" : "ve"} no price data and ${totalGapNights - pricedGapNights === 1 ? "was" : "were"} not compared.` +
        horizonNote;
    } else {
      message = `No proposals — prices for all ${totalGapNights} gap night${totalGapNights === 1 ? "" : "s"} in the window are at or above the cost floor (turnover + travel + minimum margin). That's good: nothing is priced below cost.`;
    }
    parts.push(message);
    return parts.join("\n\n");
  }

  const lines: string[] = [];
  newDecisions.forEach((d, i) => {
    const p = proposals[i];
    // Min stay ≥ 2 → lattia on amortisoitu minimioleskelun yli; sanotaan se
    // ääneen, ettei matala lattia näytä virheeltä. min_stay = 1 → rivi
    // täsmälleen ennallaan (mock-demo ja min_stay=null-portfoliot eivät muutu).
    const amortNote =
      p.min_stay >= 2 ? ` (turnover amortized over the ${p.min_stay}-night minimum stay)` : "";
    // Min stay = 1 → lattia on koko vaihtokustannus yhdelle yölle. Se on oikein
    // (yö on yhä myytävissä yhden yön varauksena), mutta lukija ei näe oletusta
    // — ja minimioleskelu on halvin tapa pudottaa lattiaa. Sanotaan molemmat.
    const minStayLever =
      p.min_stay < 2 && p.dates.length >= 3
        ? ` Or set a ${Math.min(3, p.dates.length)}-night minimum stay for these dates: the same turnover then spreads over ${Math.min(3, p.dates.length)} nights and the floor drops to ${eur(Math.ceil(d.floor_price / Math.min(3, p.dates.length)))}/night.`
        : "";
    lines.push(
      `${i + 1}. **${d.id} · ${d.property_id}** · ${formatDates(d.dates)} (${p.protected_nights} night${p.protected_nights === 1 ? "" : "s"})\n` +
        `   Raise to floor ${eur(d.floor_price)}/night${amortNote} — ${eur(Math.round(p.floor_vs_rec_delta))} of below-floor exposure across ${p.protected_nights} night${p.protected_nights === 1 ? "" : "s"} (floor ${eur(d.floor_price)} vs current recommendation ${formatRecRange(p)}).${minStayLever}`,
    );
  });
  // Kokonaissumma: ilman tätä lista on "20 ehdotusta" ilman yhtään euroa, eikä
  // lukija näe kummalla päällä lista on tärkeysjärjestyksessä (se on jo lajiteltu
  // tällä samalla luvulla, src/core/decisions.ts:232).
  const totalExposure = Math.round(proposals.reduce((acc, p) => acc + p.floor_vs_rec_delta, 0));
  const totalNights = proposals.reduce((acc, p) => acc + p.protected_nights, 0);
  const totalProperties = new Set(proposals.map((p) => p.property_id)).size;
  parts.push(
    `Found ${proposals.length} proposal${proposals.length === 1 ? "" : "s"} — gap nights where the current price is below your cost floor.\n` +
      `**Total below-floor exposure: ${eur(totalExposure)} across ${totalNights} night${totalNights === 1 ? "" : "s"} on ${totalProperties} propert${totalProperties === 1 ? "y" : "ies"}.** ` +
      `That is the gap between the price on offer and what those nights cost to produce — not a forecast of lost revenue, since an unsold night earns nothing either way.\n\n${lines.join("\n")}`,
  );
  parts.push(
    [
      `Apply with: apply_decision {"decision_id": "${newDecisions[0].id}", "confirm": true}`,
      `Preview the exact payload first with: apply_decision {"decision_id": "${newDecisions[0].id}"}`,
    ].join("\n"),
  );
  return parts.join("\n\n");
}

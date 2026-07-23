import { z } from "zod";
import { avgTurnoverCost } from "../config.js";
import { parseISODate } from "../core/calc.js";
import {
  reviewHistory,
  type HistoryReview,
  type MonthlyKpiInput,
  type MonthRollup,
} from "../core/history.js";
import { channelForListing, listingFromDocumented } from "../wheelhouse/adapter.js";
import { WheelhouseClient, WheelhouseHttpError, type WhMonthlyKpi } from "../wheelhouse/client.js";

/** Zod-skeema — index.ts rekisteröi tämän sellaisenaan (yksi totuus, testattavissa). */
export const reviewHistoryInputSchema = {
  from: z
    .string()
    .optional()
    .describe(
      "Earliest month to include, YYYY-MM-DD — matched at MONTH granularity and INCLUSIVE (any day in the month includes that whole month). Optional — defaults to all available history.",
    ),
  to: z
    .string()
    .optional()
    .describe(
      "Latest month to include, YYYY-MM-DD — matched at MONTH granularity and INCLUSIVE. Optional — defaults to all available history.",
    ),
  avg_turnover_cost: z
    .number()
    .positive()
    .optional()
    .describe(
      "Override AVG_TURNOVER_COST for this run: € per turnover. Used to ESTIMATE turnover cost from monthly averages (occupied nights ÷ avg length of stay × this number).",
    ),
};

export interface ReviewHistoryArgs {
  from?: string;
  to?: string;
  avg_turnover_cost?: number;
}

export interface ReviewHistoryDeps {
  client?: WheelhouseClient;
  /** Injektoitava "nyt" testeille; tuotannossa new Date(). Erottaa toteutuneet
   *  kuukaudet tulevista (kirjoissa olevista) varauksista. */
  now?: Date;
}

// --- formatterin apurit (pyöristys tapahtuu VAIN täällä) ---
const eur = (n: number): string => {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString("en-US");
  return v < 0 ? `-€${s}` : `€${s}`;
};
const pct1 = (n: number): string => `${n.toFixed(1)}%`;

const MONTH_ROW_RE = /^\d{4}-\d{2}-01$/;

// --- kanoniset rehellisyyslauseet ---
function honestyHeader(review: HistoryReview, windowApplied: boolean): string {
  const n = review.months_count;
  const monthWord = n === 1 ? "month" : "months";
  let line: string;
  if (n === 0) {
    line = `Based on 0 months of your own Wheelhouse history.`;
  } else {
    line = `Based on ${n} ${monthWord} of your own Wheelhouse history (earliest ${review.earliest_month}, latest ${review.latest_month}).`;
  }
  if (windowApplied) {
    const lo = review.window_from_month ?? "your earliest month";
    const hi = review.window_to_month ?? "your latest month";
    line += ` Window applied: ${lo} → ${hi} (inclusive).`;
  }
  // Tulevat kuukaudet mainitaan ERIKSEEN — niitä ei koskaan lasketa historiaksi.
  if (review.future) {
    const f = review.future;
    line +=
      ` You also have ${f.months_count} month${f.months_count === 1 ? "" : "s"} already on the books ` +
      `(${f.earliest_month} → ${f.latest_month}, ${eur(f.revenue)} booked) — those are future stays, ` +
      `shown separately below, not counted as history.`;
  }
  return line;
}

function estimateDisclaimer(avg: number): string {
  return (
    `Turnover cost and net below are ESTIMATES: the monthly KPI endpoint has no per-booking ` +
    `data, so turnovers are estimated as occupied nights ÷ your average length of stay, then ` +
    `× ${eur(avg)} per turnover (AVG_TURNOVER_COST). They are not measured per booking.`
  );
}

const FOOTER =
  `This is a review of what already happened — not a forecast, not a strategy recommendation. ` +
  `It does not tell you what to do next or claim another strategy would have earned more.`;

const COMP_SET_NOTE =
  `Competitor (comp_set) figures are omitted — the endpoint returns 0/null placeholders that ` +
  `mean "no data", not "competitors earned €0".`;

interface FormatContext {
  avg: number;
  currency: string;
  skipped: number;
  malformedRows: number;
  mixedCurrency: boolean;
  windowApplied: boolean;
  windowFromMonth: string | null;
  windowToMonth: string | null;
}

function monthRow(r: MonthRollup): string {
  const hasEst = r.estimable_revenue > 0;
  const cost = hasEst ? eur(r.est_turnover_cost) : "—";
  const net = hasEst ? eur(r.est_net) : "— (no length-of-stay data)";
  const share = r.turnover_share !== null ? pct1(r.turnover_share * 100) : "— (no length-of-stay data)";
  const occ = r.occupancy !== null ? pct1(r.occupancy * 100) : "—";
  const adr = r.adr !== null ? eur(r.adr) : "—";
  return `| ${r.month} | ${eur(r.revenue)} | ${cost} | ${net} | ${share} | ${occ} | ${adr} |`;
}

function dataQualityNotes(ctx: FormatContext, review: HistoryReview): string[] {
  const notes: string[] = [];
  if (ctx.skipped > 0) {
    notes.push(
      `${ctx.skipped} listing${ctx.skipped === 1 ? "" : "s"} had no monthly KPI history on their channel and ${ctx.skipped === 1 ? "was" : "were"} skipped.`,
    );
  }
  if (review.totals.non_estimable_revenue > 0) {
    notes.push(
      `${eur(review.totals.non_estimable_revenue)} of revenue is in months/listings with no length-of-stay data — shown in the revenue column but EXCLUDED from every net and turnover-share figure (not guessed).`,
    );
  }
  if (ctx.malformedRows > 0) {
    notes.push(
      `${ctx.malformedRows} monthly row${ctx.malformedRows === 1 ? "" : "s"} ${ctx.malformedRows === 1 ? "was" : "were"} malformed and skipped.`,
    );
  }
  if (ctx.mixedCurrency) {
    notes.push(
      `Listings reported more than one currency; figures are summed as-is — treat cross-currency totals with care.`,
    );
  }
  notes.push(COMP_SET_NOTE);
  return notes;
}

export function formatReviewHistory(review: HistoryReview, ctx: FormatContext): string {
  const parts: string[] = [];
  parts.push(`## Season review — your own Wheelhouse history`);
  const hasTable = review.rollup.length > 0;
  // Rehellisyysotsikko + yhden lauseen viittaus arvioihin. Itse selitys ja
  // data-quality-notet tulevat NUMEROIDEN JÄLKEEN, ettei taulukko hautaudu
  // varoitusten alle (numbers first, caveats attached below the table).
  parts.push(
    honestyHeader(review, ctx.windowApplied) +
      (hasTable ? ` Turnover cost and net are estimates — see the note under the table.` : ""),
  );

  // Zero-history / degeneraatti: ei yhtään revenue>0 -kuukautta.
  if (review.rollup.length === 0) {
    // Data-quality-notet paitsi non-estimable (ei mitään dataa) — pidetään skip/malformed/mixed + comp_set.
    const notes: string[] = [];
    if (ctx.skipped > 0) {
      notes.push(
        `${ctx.skipped} listing${ctx.skipped === 1 ? "" : "s"} had no monthly KPI history on their channel and ${ctx.skipped === 1 ? "was" : "were"} skipped.`,
      );
    }
    if (ctx.malformedRows > 0) {
      notes.push(
        `${ctx.malformedRows} monthly row${ctx.malformedRows === 1 ? "" : "s"} ${ctx.malformedRows === 1 ? "was" : "were"} malformed and skipped.`,
      );
    }
    if (ctx.mixedCurrency) {
      notes.push(
        `Listings reported more than one currency; figures are summed as-is — treat cross-currency totals with care.`,
      );
    }
    notes.push(COMP_SET_NOTE);
    parts.push(notes.join("\n"));
    if (ctx.windowApplied) {
      const lo = ctx.windowFromMonth ?? "your earliest month";
      const hi = ctx.windowToMonth ?? "your latest month";
      parts.push(
        `No booked months fall inside ${lo} → ${hi}. Widen the window or omit from/to to see all available history.`,
      );
    } else {
      parts.push(
        `No booked months found in your Wheelhouse history yet — every month returned zero revenue. There is nothing to review.`,
      );
    }
    return parts.join("\n\n");
  }

  // Per-month-taulukko (TOTEUTUNEET kuukaudet) — NUMEROT ENSIN.
  const tableLines = [
    `| Month | Revenue | Est turnover cost | Est net | Turnover share | Occupancy | ADR |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
    ...review.rollup.map(monthRow),
  ];
  parts.push(tableLines.join("\n"));

  // Totals-rivi.
  const t = review.totals;
  if (t.turnover_share === null) {
    const reason =
      t.estimable_revenue === 0
        ? " (no length-of-stay data in any month)"
        : "";
    parts.push(
      `**Portfolio total: revenue ${eur(t.revenue)} · est turnover cost ${eur(t.est_turnover_cost)} · est net ${eur(t.est_net)} · turnover share not estimable${reason}.**`,
    );
  } else {
    parts.push(
      `**Portfolio total: revenue ${eur(t.revenue)} · est turnover cost ${eur(t.est_turnover_cost)} · est net ${eur(t.est_net)} · turnover share ${pct1(t.turnover_share * 100)} (over the ${eur(t.estimable_revenue)} of revenue we could estimate).**`,
    );
  }

  // Thinnest-margin-kuukaudet — VAIN jos se kaventaa taulukkoa (muuten toistaa
  // samat rivit uudelleen järjesteltynä; ohuin kuukausi näkyy jo share-sarakkeesta).
  const estimableCount = review.rollup.filter((r) => r.turnover_share !== null).length;
  if (review.thinnest.length > 0 && estimableCount > review.thinnest.length) {
    const bullets = review.thinnest.map(
      (r) =>
        `- **${r.month}** — turnover ate ${pct1((r.turnover_share as number) * 100)} of the revenue we could estimate (revenue ${eur(r.revenue)}, est net ${eur(r.est_net)}).`,
    );
    parts.push(`### Where turnover ate the most\n${bullets.join("\n")}`);
  }

  // Seasonality.
  const lo = review.lowest_share_month;
  const hi = review.highest_share_month;
  if (lo && hi && lo.month !== hi.month) {
    parts.push(
      `**Seasonality:** turnover was ${pct1((lo.turnover_share as number) * 100)} of the revenue we could estimate in your leanest-cost month (${lo.month}) and ${pct1((hi.turnover_share as number) * 100)} in your heaviest-cost month (${hi.month}). That is a description of the months you have, not a seasonal forecast.`,
    );
  } else if (estimableCount === 1 && lo) {
    parts.push(
      `**Seasonality:** only one booked month has length-of-stay data (${lo.month}), so there is no seasonal comparison to make.`,
    );
  }
  // 0 estimable → jätetään osio pois.

  // TULEVAT kuukaudet (kirjoissa) — erillinen, selkeästi merkitty osio.
  if (review.future_rollup.length > 0) {
    const f = review.future;
    const futureLines = [
      `### Already on the books — future stays, not history`,
      `Bookings you have taken for months that have not happened yet. Shown so you can see the shape of what is coming; excluded from every history figure above.`,
      ``,
      `| Month | Revenue booked | Est net | Occupancy so far | ADR |`,
      `|---|---:|---:|---:|---:|`,
      ...review.future_rollup.map((r) => {
        const net = r.estimable_revenue > 0 ? eur(r.est_net) : "—";
        const occ = r.occupancy !== null ? pct1(r.occupancy * 100) : "—";
        const adr = r.adr !== null ? eur(r.adr) : "—";
        return `| ${r.month} | ${eur(r.revenue)} | ${net} | ${occ} | ${adr} |`;
      }),
    ];
    if (f) {
      futureLines.push(``, `On the books so far: ${eur(f.revenue)} across ${f.months_count} future month${f.months_count === 1 ? "" : "s"}. Occupancy will keep rising as more bookings arrive.`);
    }
    parts.push(futureLines.join("\n"));
  }

  // Selitys + data-quality-notet NUMEROIDEN JÄLKEEN (numbers first).
  parts.push(estimateDisclaimer(ctx.avg));
  parts.push(dataQualityNotes(ctx, review).join("\n"));

  parts.push(FOOTER);
  return parts.join("\n\n");
}

export async function runReviewHistory(
  args: ReviewHistoryArgs,
  env: NodeJS.ProcessEnv = process.env,
  deps: ReviewHistoryDeps = {},
): Promise<string> {
  // 1. Validoi ikkunapäivät jos annettu (repo-standardi Invalid date -virhe).
  if (args.from) parseISODate(args.from);
  if (args.to) parseISODate(args.to);
  if (args.from && args.to && args.from.slice(0, 7) > args.to.slice(0, 7)) {
    return `The window ${args.from} → ${args.to} is empty — 'from' is a later month than 'to'.`;
  }
  const windowApplied = Boolean(args.from || args.to);

  // 2. Keskimääräinen vaihtokustannus (yksi portfolio-laajuinen keskiarvo by design).
  const avg = args.avg_turnover_cost ?? avgTurnoverCost(env);

  // 3. Client — ilman avainta ei fabricointia.
  const key = env.WHEELHOUSE_API_KEY?.trim();
  const client =
    deps.client ??
    (key ? new WheelhouseClient({ apiKey: key, baseUrl: env.WHEELHOUSE_API_URL }) : undefined);
  if (!client) {
    return (
      `review_history reads your own Wheelhouse monthly history, so it needs an API key. ` +
      `Set WHEELHOUSE_API_KEY (see the README) and run it again. This tool never invents ` +
      `history and has no demo/mock mode — it only mirrors real months back at you.`
    );
  }

  // 4. Hae sarjassa (throttlattu client, ei fan-outia).
  const listings = (await client.listListings()).filter((l) => l.is_active !== false);
  const cells: MonthlyKpiInput[] = [];
  let skipped = 0;
  let malformedRows = 0;
  let currency = "";
  let mixedCurrency = false;

  for (const listing of listings) {
    const channel = channelForListing(listing, env.WHEELHOUSE_CHANNEL);
    // propertyId luetaan johdonmukaisuuden vuoksi (ei näytetä per-listing).
    void listingFromDocumented(listing);
    let resp: { currency: string; data: WhMonthlyKpi[] };
    try {
      resp = await client.monthlyKpis(listing.id, channel);
    } catch (e) {
      if (e instanceof WheelhouseHttpError && e.status === 404) {
        skipped++;
        continue;
      }
      throw e;
    }

    if (resp.currency) {
      if (!currency) currency = resp.currency;
      else if (resp.currency !== currency) mixedCurrency = true;
    }

    for (const row of resp.data) {
      const month = (row as { month?: unknown }).month;
      const revenue = (row as { revenue?: unknown }).revenue;
      if (
        typeof month !== "string" ||
        !MONTH_ROW_RE.test(month) ||
        typeof revenue !== "number" ||
        !Number.isFinite(revenue)
      ) {
        malformedRows++;
        continue;
      }
      cells.push({
        month,
        revenue,
        occupancy: typeof row.occupancy === "number" ? row.occupancy : null,
        los: typeof row.los === "number" ? row.los : null,
        adr: typeof row.adr === "number" ? row.adr : null,
      });
    }
  }

  // 5. Laske. nowMonth erottaa toteutuneet kuukaudet tulevista (kirjoissa).
  const now = deps.now ?? new Date();
  const nowMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const review = reviewHistory(cells, avg, { from: args.from, to: args.to }, nowMonth);

  // 6. Formatoi.
  return formatReviewHistory(review, {
    avg,
    currency: currency || "EUR",
    skipped,
    malformedRows,
    mixedCurrency,
    windowApplied,
    windowFromMonth: review.window_from_month,
    windowToMonth: review.window_to_month,
  });
}

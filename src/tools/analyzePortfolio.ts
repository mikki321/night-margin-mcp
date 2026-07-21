import { z } from "zod";
import { DEFAULT_WINDOW_NOTE, resolveWindow } from "../config.js";
import { analyzePortfolio } from "../core/calc.js";
import type { PortfolioAnalysis, PropertyStats } from "../core/types.js";
import { costSourceFromEnv } from "../sources/index.js";
import { reservationSourceFromEnv } from "../sources/reservationSource.js";
import { avgFallbackFromEnv, resolveCosts } from "../sources/resolveCosts.js";

/** Zod-skeema — index.ts rekisteröi tämän sellaisenaan (yksi totuus, testattavissa). */
export const analyzePortfolioInputSchema = {
  from: z
    .string()
    .optional()
    .describe("Period start, YYYY-MM-DD (optional — defaults to last 30 + next 90 days)"),
  to: z
    .string()
    .optional()
    .describe("Period end (exclusive), YYYY-MM-DD (optional — defaults to last 30 + next 90 days)"),
  avg_turnover_cost: z
    .number()
    .positive()
    .optional()
    .describe("Override AVG_TURNOVER_COST for this run: € per turnover (manual mode)"),
};

const eur = (n: number): string => {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString("en-US");
  return v < 0 ? `-€${s}` : `€${s}`;
};
const eur2 = (n: number): string => {
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
  return n < 0 ? `-€${s}` : `€${s}`;
};
const pct = (n: number): string => `${n.toFixed(1)}%`;

function propertyTable(rows: PropertyStats[]): string {
  const lines = [
    "| Property | Net/night | Booked nights | Gap nights | Net € |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const p of rows) {
    lines.push(
      `| ${p.property_id} | ${eur2(p.net_per_available_night)} | ${p.booked_nights} | ${p.gap_nights} | ${eur(p.net)} |`,
    );
  }
  return lines.join("\n");
}

export function formatAnalysis(
  a: PortfolioAnalysis,
  sourceLabel: string,
  dataNote: string,
  isDefaultWindow = false,
): string {
  const bottom = a.properties.slice(0, 10);
  const top = [...a.properties].slice(-5).reverse();
  const worst = a.properties[0];

  const parts: string[] = [];
  parts.push(`## Portfolio ${a.from} → ${a.to}${isDefaultWindow ? DEFAULT_WINDOW_NOTE : ""}`);
  parts.push(`Cost source: ${sourceLabel}${dataNote ? ` · ${dataNote}` : ""}`);

  // Kipu ensin: vuotolause on ensimmäinen sisältörivi otsikon + lähderivin jälkeen.
  const nNeg = a.negative_reservations.length;
  const occLine = `Occupancy ${pct(a.totals.occupancy_pct)} (${a.totals.booked_nights} booked, ${a.totals.gap_nights} gap nights)`;
  const grossLine = `Gross ${eur(a.totals.gross)} − turnover costs ${eur(a.totals.costs)} = net ${eur(a.totals.net)}`;
  const statLines =
    a.leak_eur > 0
      ? [
          `**${eur(a.leak_eur)} is leaking from ${nNeg} booking${nNeg === 1 ? "" : "s"} that ${nNeg === 1 ? "doesn't" : "don't"} cover ${nNeg === 1 ? "its" : "their"} own turnover cost.** (${pct(a.leak_pct)} of booked nights are net-negative)`,
          `**Net per available night: ${eur2(a.totals.net_per_available_night)}**`,
          occLine,
          grossLine,
        ]
      : [
          `**No leak — every booking covers its own turnover cost.** Net per available night: ${eur2(a.totals.net_per_available_night)}`,
          occLine,
          grossLine,
        ];
  parts.push(statLines.join("\n"));

  parts.push(`### Bottom ${bottom.length} (net/night)\n${propertyTable(bottom)}`);
  parts.push(`### Top ${top.length} (net/night)\n${propertyTable(top)}`);

  if (a.negative_reservations.length > 0) {
    const rows = a.negative_reservations
      .slice(0, 10)
      .map(
        (r) =>
          `| ${r.reservation_id} | ${r.checkin} | ${r.nights} | ${eur(r.gross)} | ${eur(r.costs)} | ${eur(r.net)} |`,
      );
    parts.push(
      `### Net-negative bookings\n| Booking | Check-in | Nights | Gross | Costs | Net |\n|---|---|---:|---:|---:|---:|\n${rows.join("\n")}`,
    );
  }

  const summary = worst
    ? `The portfolio nets ${eur2(a.totals.net_per_available_night)}/night; the biggest improvement potential is in ${worst.property_id} (${eur2(worst.net_per_available_night)}/night), and leak totaled ${eur(a.leak_eur)} — short, cheap bookings do not cover their turnover cost.`
    : `No bookings fell within the period — check the dates.`;
  parts.push(`**Summary:** ${summary}`);

  return parts.join("\n\n");
}

export interface AnalyzeArgs {
  from?: string;
  to?: string;
  avg_turnover_cost?: number;
}

export async function runAnalyzePortfolio(args: AnalyzeArgs): Promise<string> {
  const { from, to, isDefault } = resolveWindow(args.from, args.to);
  const costSource = costSourceFromEnv(process.env, args.avg_turnover_cost);
  const reservationSource = reservationSourceFromEnv(process.env);

  const reservations = await reservationSource.getReservations(from, to);
  const { costs, matchNote } = await resolveCosts(
    costSource,
    reservations,
    from,
    to,
    avgFallbackFromEnv(process.env, args.avg_turnover_cost),
  );

  const analysis = analyzePortfolio(reservations, costs, from, to);
  const dataNote =
    `reservations: ${reservationSource.label}` + (matchNote ? `\n${matchNote}` : "");
  return formatAnalysis(analysis, costSource.label, dataNote, isDefault);
}

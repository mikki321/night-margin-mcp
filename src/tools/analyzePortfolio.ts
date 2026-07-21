import { analyzePortfolio } from "../core/calc.js";
import type { PortfolioAnalysis, PropertyStats } from "../core/types.js";
import { costSourceFromEnv } from "../sources/index.js";
import { reservationSourceFromEnv } from "../sources/reservationSource.js";
import { avgFallbackFromEnv, resolveCosts } from "../sources/resolveCosts.js";

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

export function formatAnalysis(a: PortfolioAnalysis, sourceLabel: string, dataNote: string): string {
  const bottom = a.properties.slice(0, 10);
  const top = [...a.properties].slice(-5).reverse();
  const worst = a.properties[0];

  const parts: string[] = [];
  parts.push(`## Portfolio ${a.from} → ${a.to}`);
  parts.push(`Cost source: ${sourceLabel}${dataNote ? ` · ${dataNote}` : ""}`);
  parts.push(
    [
      `**Net per available night: ${eur2(a.totals.net_per_available_night)}**`,
      `Occupancy ${pct(a.totals.occupancy_pct)} (${a.totals.booked_nights} booked, ${a.totals.gap_nights} gap nights)`,
      `Gross ${eur(a.totals.gross)} − turnover costs ${eur(a.totals.costs)} = net ${eur(a.totals.net)}`,
      `**Leak: ${eur(a.leak_eur)}** — ${pct(a.leak_pct)} of booked nights were net-negative (${a.negative_reservations.length} bookings)`,
    ].join("\n"),
  );

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
  from: string;
  to: string;
  avg_turnover_cost?: number;
}

export async function runAnalyzePortfolio(args: AnalyzeArgs): Promise<string> {
  const costSource = costSourceFromEnv(process.env, args.avg_turnover_cost);
  const reservationSource = reservationSourceFromEnv(process.env);

  const reservations = await reservationSource.getReservations(args.from, args.to);
  const { costs, matchNote } = await resolveCosts(
    costSource,
    reservations,
    args.from,
    args.to,
    avgFallbackFromEnv(process.env, args.avg_turnover_cost),
  );

  const analysis = analyzePortfolio(reservations, costs, args.from, args.to);
  const dataNote =
    `reservations: ${reservationSource.label}` + (matchNote ? `\n${matchNote}` : "");
  return formatAnalysis(analysis, costSource.label, dataNote);
}

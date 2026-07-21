import { z } from "zod";
import { DEFAULT_WINDOW_NOTE, resolveWindow } from "../config.js";
import { analyzePortfolio, overlapNights, parseISODate } from "../core/calc.js";
import { simulateFillGaps, simulateMinStayUplift } from "../core/simulate.js";
import type { PortfolioAnalysis, Reservation } from "../core/types.js";
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
/** Etumerkillinen delta: "+€3.2" / "-€3.2". */
const sign = (n: number, fmt: (x: number) => string): string =>
  n >= 0 ? `+${fmt(n)}` : fmt(n);
const pp = (n: number): string => `${n.toFixed(1)} pp`;
const signedCount = (n: number): string => `${n >= 0 ? "+" : "-"}${Math.abs(n)}`;

/** Zod-skeema — index.ts rekisteröi tämän sellaisenaan (yksi totuus, testattavissa). */
export const compareStrategiesInputSchema = {
  from: z
    .string()
    .optional()
    .describe("Period start, YYYY-MM-DD (optional — defaults to last 30 + next 90 days)"),
  to: z
    .string()
    .optional()
    .describe("Period end (exclusive), YYYY-MM-DD (optional — defaults to last 30 + next 90 days)"),
  discount_pct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Strategy A: gap night price discount as a percentage of the property's ADR (default 40)"),
  min_stay: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Strategy B: minimum stay in nights — bookings shorter than this are dropped (default 3)"),
  uplift_pct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Strategy B: price uplift percentage for the remaining bookings (default 10)"),
};

export interface CompareArgs {
  from?: string;
  to?: string;
  discount_pct?: number;
  min_stay?: number;
  uplift_pct?: number;
}

interface Scenario {
  label: string;
  analysis: PortfolioAnalysis;
  turnovers: number;
}

/**
 * Vaihdot = jaksolle osuvien varausten määrä — sama sisällytyssääntö kuin
 * analyysissä (yöt osuvat jaksolle tai checkout ∈ [from, to)).
 */
export function countTurnovers(reservations: Reservation[], from: string, to: string): number {
  const fromT = parseISODate(from);
  const toT = parseISODate(to);
  let n = 0;
  for (const r of reservations) {
    const checkoutT = parseISODate(r.checkout);
    if (overlapNights(r, from, to) > 0 || (checkoutT >= fromT && checkoutT < toT)) n += 1;
  }
  return n;
}

function scenarioTable(scenarios: Scenario[]): string {
  const lines = [
    "| Scenario | Gross | Net | Net/night | Occupancy | Turnovers | Leak |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const s of scenarios) {
    const t = s.analysis.totals;
    lines.push(
      `| ${s.label} | ${eur(t.gross)} | ${eur(t.net)} | ${eur2(t.net_per_available_night)} | ${pct(t.occupancy_pct)} | ${s.turnovers} | ${eur(s.analysis.leak_eur)} |`,
    );
  }
  return lines.join("\n");
}

function deltaSentence(name: string, s: Scenario, base: Scenario): string {
  const dOcc = s.analysis.totals.occupancy_pct - base.analysis.totals.occupancy_pct;
  const dNet = s.analysis.totals.net - base.analysis.totals.net;
  const dNetPerNight =
    s.analysis.totals.net_per_available_night - base.analysis.totals.net_per_available_night;
  const dGross = s.analysis.totals.gross - base.analysis.totals.gross;
  const dTurnovers = s.turnovers - base.turnovers;

  const dLeak = s.analysis.leak_eur - base.analysis.leak_eur;

  const occVerb = dOcc >= 0 ? "raises" : "lowers";
  const link = dNetPerNight * dOcc < 0 || dNetPerNight * dGross < 0 ? "but" : "and";
  const leakNote =
    dLeak > 0 ? ` Leak grows by ${eur(dLeak)} — some of the new bookings are net-negative.` : "";
  return (
    `**${name}** ${occVerb} occupancy by ${sign(dOcc, pp)} ${link} net/night changes by ${sign(dNetPerNight, eur2)} ` +
    `(gross ${sign(dGross, eur)}, net ${sign(dNet, eur)}, turnovers ${signedCount(dTurnovers)}).${leakNote}`
  );
}

export function formatComparison(
  scenarios: [Scenario, Scenario, Scenario],
  from: string,
  to: string,
  sourceLabel: string,
  dataNote: string,
  isDefaultWindow = false,
): string {
  const [base, a, b] = scenarios;

  const parts: string[] = [];
  parts.push(`## Strategy comparison ${from} → ${to}${isDefaultWindow ? DEFAULT_WINDOW_NOTE : ""}`);
  parts.push(`Cost source: ${sourceLabel}${dataNote ? ` · ${dataNote}` : ""}`);
  parts.push(
    `${scenarioTable(scenarios)}\n_Turnovers = number of bookings touching the period._\n` +
      // Tuomarisimulaation löydös 1: A:n 100 % -täyttöoletus näkyviin.
      `_Strategy A assumes every gap night sells at the discounted price — an upper bound._`,
  );
  parts.push([deltaSentence("A", a, base), deltaSentence("B", b, base)].join("\n"));

  const dGrossA = a.analysis.totals.gross - base.analysis.totals.gross;
  const dNetA = a.analysis.totals.net - base.analysis.totals.net;
  const dLeakA = a.analysis.leak_eur - base.analysis.leak_eur;
  const best = [...scenarios].sort(
    (x, y) =>
      y.analysis.totals.net_per_available_night - x.analysis.totals.net_per_available_night,
  )[0];
  let tension = "";
  if (dGrossA > 0 && dNetA < 0) {
    tension = ` A brings ${eur(dGrossA)} more gross but ${eur(-dNetA)} less net — gross-optimizing fill is a net loss.`;
  } else if (dLeakA > 0) {
    tension = ` Some of A's gap fills lose money (leak ${sign(dLeakA, eur)}) — in the cheapest properties a discounted night does not cover the turnover cost.`;
  }
  parts.push(
    `**Summary:** Best net/night: ${best.label} (${eur2(best.analysis.totals.net_per_available_night)}/night).${tension}`,
  );

  return parts.join("\n\n");
}

export async function runCompareStrategies(args: CompareArgs): Promise<string> {
  const { from, to, isDefault } = resolveWindow(args.from, args.to);
  const discountPct = args.discount_pct ?? 40;
  const minStay = args.min_stay ?? 3;
  const upliftPct = args.uplift_pct ?? 10;

  const costSource = costSourceFromEnv(process.env);
  const reservationSource = reservationSourceFromEnv(process.env);

  const reservations = await reservationSource.getReservations(from, to);
  // Sama kohdistuskaskadi kuin analyze_portfoliossa (id → koodi → komposiitti
  // → keskiarvo) — samat luvut samalla jaksolla molemmissa tooleissa.
  const { costs, matchNote } = await resolveCosts(
    costSource,
    reservations,
    from,
    to,
    avgFallbackFromEnv(process.env),
  );

  const baseline = analyzePortfolio(reservations, costs, from, to);
  const simA = simulateFillGaps(reservations, costs, from, to, { discountPct });
  const simB = simulateMinStayUplift(reservations, costs, from, to, {
    minStay,
    upliftPct,
  });
  const analysisA = analyzePortfolio(simA.reservations, simA.costs, from, to);
  const analysisB = analyzePortfolio(simB.reservations, simB.costs, from, to);

  const scenarios: [Scenario, Scenario, Scenario] = [
    {
      label: "Baseline",
      analysis: baseline,
      turnovers: countTurnovers(reservations, from, to),
    },
    {
      label: `A: fill gap nights (${discountPct}% off)`,
      analysis: analysisA,
      turnovers: countTurnovers(simA.reservations, from, to),
    },
    {
      label: `B: min stay ${minStay} nights + prices +${upliftPct}%`,
      analysis: analysisB,
      turnovers: countTurnovers(simB.reservations, from, to),
    },
  ];

  const dataNote =
    `reservations: ${reservationSource.label}` + (matchNote ? `\n${matchNote}` : "");
  return formatComparison(scenarios, from, to, costSource.label, dataNote, isDefault);
}

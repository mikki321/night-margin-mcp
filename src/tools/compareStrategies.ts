import { analyzePortfolio, overlapNights, parseISODate } from "../core/calc.js";
import { simulateFillGaps, simulateMinStayUplift } from "../core/simulate.js";
import type { PortfolioAnalysis, Reservation } from "../core/types.js";
import { costSourceFromEnv } from "../sources/index.js";
import { reservationSourceFromEnv } from "../sources/reservationSource.js";
import { avgFallbackFromEnv, resolveCosts } from "../sources/resolveCosts.js";

const eur = (n: number): string => `${Math.round(n).toLocaleString("fi-FI")} €`;
const eur2 = (n: number): string =>
  `${n.toLocaleString("fi-FI", { minimumFractionDigits: 0, maximumFractionDigits: 1 })} €`;
const pct = (n: number): string => `${n.toFixed(1).replace(".", ",")} %`;
/** Etumerkillinen delta: "+3,2 €" / "−3,2 €". */
const sign = (n: number, fmt: (x: number) => string): string =>
  n >= 0 ? `+${fmt(n)}` : fmt(n);
const pp = (n: number): string => `${n.toFixed(1).replace(".", ",").replace("-", "−")} pp`;
const signedCount = (n: number): string => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

export interface CompareArgs {
  from: string;
  to: string;
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
    "| Skenaario | Brutto | Netto | Netto/yö | Käyttöaste | Vaihdot | Vuoto |",
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

  const occVerb = dOcc >= 0 ? "nostaa" : "laskee";
  const link = dNetPerNight * dOcc < 0 || dNetPerNight * dGross < 0 ? "mutta" : "ja";
  const leakNote =
    dLeak > 0 ? ` Vuoto kasvaa ${eur(dLeak)} — osa uusista varauksista on nettonegatiivisia.` : "";
  return (
    `**${name}** ${occVerb} käyttöastetta ${sign(dOcc, pp)} ${link} netto/yö muuttuu ${sign(dNetPerNight, eur2)} ` +
    `(brutto ${sign(dGross, eur)}, netto ${sign(dNet, eur)}, vaihdot ${signedCount(dTurnovers)}).${leakNote}`
  );
}

export function formatComparison(
  scenarios: [Scenario, Scenario, Scenario],
  from: string,
  to: string,
  sourceLabel: string,
  dataNote: string,
): string {
  const [base, a, b] = scenarios;

  const parts: string[] = [];
  parts.push(`## Strategiavertailu ${from} → ${to}`);
  parts.push(`Kustannuslähde: ${sourceLabel}${dataNote ? ` · ${dataNote}` : ""}`);
  parts.push(`${scenarioTable(scenarios)}\n_Vaihdot = jaksolle osuvien varausten määrä._`);
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
    tension = ` A tuo ${eur(dGrossA)} lisää bruttoa mutta ${eur(-dNetA)} vähemmän nettoa — bruttoa optimoiva täyttö on nettona tappio.`;
  } else if (dLeakA > 0) {
    tension = ` A:n aukkotäytöistä osa on tappiollisia (vuoto ${sign(dLeakA, eur)}) — halvimmissa kohteissa alennettu yö ei kata vaihtokustannusta.`;
  }
  parts.push(
    `**Yhteenveto:** Paras netto/yö: ${best.label} (${eur2(best.analysis.totals.net_per_available_night)}/yö).${tension}`,
  );

  return parts.join("\n\n");
}

export async function runCompareStrategies(args: CompareArgs): Promise<string> {
  const discountPct = args.discount_pct ?? 40;
  const minStay = args.min_stay ?? 3;
  const upliftPct = args.uplift_pct ?? 10;

  const costSource = costSourceFromEnv(process.env);
  const reservationSource = reservationSourceFromEnv(process.env);

  const reservations = await reservationSource.getReservations(args.from, args.to);
  // Sama kohdistuskaskadi kuin analyze_portfoliossa (id → koodi → komposiitti
  // → keskiarvo) — samat luvut samalla jaksolla molemmissa tooleissa.
  const { costs, matchNote } = await resolveCosts(
    costSource,
    reservations,
    args.from,
    args.to,
    avgFallbackFromEnv(process.env),
  );

  const baseline = analyzePortfolio(reservations, costs, args.from, args.to);
  const simA = simulateFillGaps(reservations, costs, args.from, args.to, { discountPct });
  const simB = simulateMinStayUplift(reservations, costs, args.from, args.to, {
    minStay,
    upliftPct,
  });
  const analysisA = analyzePortfolio(simA.reservations, simA.costs, args.from, args.to);
  const analysisB = analyzePortfolio(simB.reservations, simB.costs, args.from, args.to);

  const scenarios: [Scenario, Scenario, Scenario] = [
    {
      label: "Baseline",
      analysis: baseline,
      turnovers: countTurnovers(reservations, args.from, args.to),
    },
    {
      label: `A: täytä aukkoyöt (ale ${discountPct} %)`,
      analysis: analysisA,
      turnovers: countTurnovers(simA.reservations, args.from, args.to),
    },
    {
      label: `B: min-stay ${minStay} yötä + hinnat +${upliftPct} %`,
      analysis: analysisB,
      turnovers: countTurnovers(simB.reservations, args.from, args.to),
    },
  ];

  const dataNote =
    `varaukset: ${reservationSource.label}` + (matchNote ? `\n${matchNote}` : "");
  return formatComparison(scenarios, args.from, args.to, costSource.label, dataNote);
}

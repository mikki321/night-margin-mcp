import { analyzePortfolio } from "../core/calc.js";
import type { PortfolioAnalysis, PropertyStats } from "../core/types.js";
import { costSourceFromEnv } from "../sources/index.js";
import { generateMockReservations } from "../sources/mockReservations.js";

const eur = (n: number): string => `${Math.round(n).toLocaleString("fi-FI")} €`;
const eur2 = (n: number): string =>
  `${n.toLocaleString("fi-FI", { minimumFractionDigits: 0, maximumFractionDigits: 1 })} €`;
const pct = (n: number): string => `${n.toFixed(1).replace(".", ",")} %`;

function propertyTable(rows: PropertyStats[]): string {
  const lines = [
    "| Kohde | Netto/yö | Varatut yöt | Aukkoyöt | Netto € |",
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
  parts.push(`Kustannuslähde: ${sourceLabel}${dataNote ? ` · ${dataNote}` : ""}`);
  parts.push(
    [
      `**Netto per käytettävissä oleva yö: ${eur2(a.totals.net_per_available_night)}**`,
      `Käyttöaste ${pct(a.totals.occupancy_pct)} (${a.totals.booked_nights} varattua, ${a.totals.gap_nights} aukkoyötä)`,
      `Brutto ${eur(a.totals.gross)} − vaihtokustannukset ${eur(a.totals.costs)} = netto ${eur(a.totals.net)}`,
      `**Vuoto: ${eur(a.leak_eur)}** — ${pct(a.leak_pct)} varatuista öistä oli nettonegatiivisia (${a.negative_reservations.length} varausta)`,
    ].join("\n"),
  );

  parts.push(`### Bottom ${bottom.length} (netto/yö)\n${propertyTable(bottom)}`);
  parts.push(`### Top ${top.length} (netto/yö)\n${propertyTable(top)}`);

  if (a.negative_reservations.length > 0) {
    const rows = a.negative_reservations
      .slice(0, 10)
      .map(
        (r) =>
          `| ${r.reservation_id} | ${r.checkin} | ${r.nights} | ${eur(r.gross)} | ${eur(r.costs)} | ${eur(r.net)} |`,
      );
    parts.push(
      `### Nettonegatiiviset varaukset\n| Varaus | Check-in | Yöt | Brutto | Kust. | Netto |\n|---|---|---:|---:|---:|---:|\n${rows.join("\n")}`,
    );
  }

  const summary = worst
    ? `Portfolio tuottaa nettona ${eur2(a.totals.net_per_available_night)}/yö; suurin parannuspotentiaali kohteessa ${worst.property_id} (${eur2(worst.net_per_available_night)}/yö), ja vuotoa syntyi ${eur(a.leak_eur)} — lyhyet halvat varaukset eivät kata vaihtokustannusta.`
    : `Jaksolle ei osunut yhtään varausta — tarkista päivämäärät.`;
  parts.push(`**Yhteenveto:** ${summary}`);

  return parts.join("\n\n");
}

export interface AnalyzeArgs {
  from: string;
  to: string;
  avg_turnover_cost?: number;
}

export async function runAnalyzePortfolio(args: AnalyzeArgs): Promise<string> {
  const source = costSourceFromEnv(process.env, args.avg_turnover_cost);

  // Vaihe 2 tuo Wheelhouse-adapterin; siihen asti varaukset ovat synteettisiä.
  const dataNote = process.env.WHEELHOUSE_API_KEY
    ? "varaukset: synteettinen demo-data (Wheelhouse-adapteri tulossa — avain havaittu)"
    : "varaukset: synteettinen demo-data (aseta WHEELHOUSE_API_KEY, kun WH-adapteri on julkaistu)";
  const reservations = generateMockReservations(args.from, args.to);

  const costs = await source.getCosts(reservations);
  const analysis = analyzePortfolio(reservations, costs, args.from, args.to);
  return formatAnalysis(analysis, source.label, dataNote);
}

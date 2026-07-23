import { z } from "zod";
import { DEFAULT_WINDOW_NOTE, resolveWindow } from "../config.js";
import { analyzePortfolio } from "../core/calc.js";
import type { PortfolioAnalysis, PropertyStats } from "../core/types.js";
import { costSourceFromEnv } from "../sources/index.js";
import { reservationSourceFromEnv } from "../sources/reservationSource.js";
import { avgFallbackFromEnv, resolveCosts } from "../sources/resolveCosts.js";
import { readTargets } from "../state.js";
import { formatTargetsSection } from "./setTarget.js";

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
const eur1 = (n: number): string => {
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return n < 0 ? `-€${s}` : `€${s}`;
};
/** Vuotosumma: 0 < leak < 0.5 € ei saa pyöristyä muotoon "€0 is leaking" (löydös 8). */
const leakEurTxt = (n: number): string => (n === 0 || Math.round(n) > 0 ? eur(n) : eur1(n));
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
  targetsSection?: string,
  monthEndNote?: string,
): string {
  // Vain varauksia saaneet kohteet asetetaan paremmuusjärjestykseen. Ilman tätä
  // live-portfolion Bottom 10 oli kymmenen riviä "€0 | 0 booked | €0" 60 kohteen
  // tasapelistä, ja yhteenveto nimesi niistä yhden "suurimmaksi parannuskohteeksi"
  // — se ei ole diagnoosi vaan se listaus jonka API sattui palauttamaan ensin.
  // Nollavarauskohteet pysyvät nimittäjässä; ne raportoidaan omalla rivillään.
  const ranked = a.properties.filter((p) => p.booked_nights > 0);
  const bottom = ranked.slice(0, 10);
  const top = [...ranked].slice(-5).reverse();
  const worst = ranked[0];

  const parts: string[] = [];
  const windowLine = `## Portfolio ${a.from} → ${a.to}${isDefaultWindow ? DEFAULT_WINDOW_NOTE : ""}`;
  // KUUNLOPPU-ANSA: huomautus ikkunarivin yhteydessä (ei laskentaan vaikutusta).
  parts.push(monthEndNote ? `${windowLine}\n${monthEndNote}` : windowLine);
  parts.push(`Cost source: ${sourceLabel}${dataNote ? ` · ${dataNote}` : ""}`);

  // Kipu ensin: vuotolause on ensimmäinen sisältörivi otsikon + lähderivin jälkeen.
  const nNeg = a.negative_reservations.length;
  const occLine = `Occupancy ${pct(a.totals.occupancy_pct)} (${a.totals.booked_nights} booked, ${a.totals.gap_nights} gap nights)`;
  // Löydös 7: nollavarauskohteet ovat mukana nimittäjässä — sanotaan se ääneen.
  // Kun niitä on paljon (live-ajossa 60/73), pelkkä lukumäärä ei riitä: käyttäjä
  // lukee "€1/yö · käyttöaste 1.4 %" rikkinäiseksi työkaluksi, ellei tulosteessa
  // kerrota että liikevaihtoluvut tulevat vain raportoineista kohteista.
  const nTotal = a.properties.length;
  const nNoBooking = a.no_booking_properties ?? 0;
  const nReporting = nTotal - nNoBooking;
  const noBookingLines =
    a.no_booking_properties !== undefined && nNoBooking > 0
      ? nTotal > 0 && nNoBooking / nTotal > 0.3
        ? [
            `⚠️ ${nNoBooking} of ${nTotal} listings returned no reservations for this window — check they are connected in Wheelhouse, or that the window matches your season. Occupancy and net/night below divide by all ${nTotal}; the revenue figures come from the ${nReporting} that reported.`,
          ]
        : [`${nNoBooking} ${nNoBooking === 1 ? "property" : "properties"} had no bookings in this window`]
      : [];
  const grossLine = `Gross ${eur(a.totals.gross)} − turnover costs ${eur(a.totals.costs)} = net ${eur(a.totals.net)}`;
  const statLines =
    a.leak_eur > 0
      ? [
          `**${leakEurTxt(a.leak_eur)} is leaking from ${nNeg} booking${nNeg === 1 ? "" : "s"} that ${nNeg === 1 ? "doesn't" : "don't"} cover ${nNeg === 1 ? "its" : "their"} own turnover cost.** (${pct(a.leak_pct)} of booked nights are net-negative)`,
          `**Net per available night: ${eur2(a.totals.net_per_available_night)}**`,
          occLine,
          ...noBookingLines,
          grossLine,
        ]
      : [
          `**No leak — every booking covers its own turnover cost.** Net per available night: ${eur2(a.totals.net_per_available_night)}`,
          occLine,
          ...noBookingLines,
          grossLine,
        ];
  parts.push(statLines.join("\n"));

  // Alle 11 varatulla kohteella Bottom ja Top toistaisivat samat rivit kahdesti
  // (3 kohteen käyttäjällä sama kohde molemmissa) — silloin yksi taulukko.
  if (ranked.length === 0) {
    parts.push(
      `No property had a booking in this window, so there is nothing to rank. The figures above cover ${a.properties.length} ${a.properties.length === 1 ? "property" : "properties"}.`,
    );
  } else if (ranked.length <= 10) {
    parts.push(
      `### All ${ranked.length} propert${ranked.length === 1 ? "y" : "ies"} with bookings (net/night)\n${propertyTable([...ranked].reverse())}`,
    );
  } else {
    parts.push(`### Bottom ${bottom.length} (net/night)\n${propertyTable(bottom)}`);
    parts.push(`### Top ${top.length} (net/night)\n${propertyTable(top)}`);
  }

  // Kuukausitavoitteet (set_target) — vain kun tavoite osuu ikkunaan.
  if (targetsSection) parts.push(targetsSection);

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

  // Selityslause vain kun vuotoa ON — leak=0-ikkunassa "short, cheap bookings
  // do not cover their turnover cost" olisi ristiriidassa No leak -otsikon kanssa.
  const leakClause =
    a.leak_eur > 0
      ? `leak totaled ${leakEurTxt(a.leak_eur)} — short, cheap bookings do not cover their turnover cost.`
      : `leak totaled €0 — no booking sold below its turnover cost.`;
  const summary = worst
    ? `The portfolio nets ${eur2(a.totals.net_per_available_night)}/night; the biggest improvement potential is in ${worst.property_id} (${eur2(worst.net_per_available_night)}/night), and ${leakClause}`
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
  const { from, to, isDefault, monthEndNote } = resolveWindow(args.from, args.to);
  const costSource = costSourceFromEnv(process.env, args.avg_turnover_cost);
  const reservationSource = reservationSourceFromEnv(process.env);

  const reservations = await reservationSource.getReservations(from, to);
  // Löydös 7: kun lähde tuntee kohdelistan, nollavarauskohteet lasketaan
  // mukaan käyttöasteen nimittäjään (booked=0, gap=jakson yöt).
  const allPropertyIds = reservationSource.listPropertyIds
    ? await reservationSource.listPropertyIds()
    : undefined;
  const { costs, matchNote } = await resolveCosts(
    costSource,
    reservations,
    from,
    to,
    avgFallbackFromEnv(process.env, args.avg_turnover_cost),
  );

  const analysis = analyzePortfolio(reservations, costs, from, to, allPropertyIds);
  const dataNote =
    `reservations: ${reservationSource.label}` + (matchNote ? `\n${matchNote}` : "");

  // Tavoitteet (set_target): lukukelvoton state ei saa kaataa analyysiä.
  // Suodatetaan nykyisen lähteen tuntemiin kohteisiin — tavoitetiedosto on
  // jaettu demo- ja live-tilan kesken, ja ilman tätä oikea katuosoite tulostui
  // synteettisen demodatan analyysiin (näkyisi videolla ja julkisessa demossa).
  let targetsSection: string | undefined;
  try {
    targetsSection = formatTargetsSection(
      readTargets(process.env),
      reservations,
      from,
      to,
      analysis.properties.map((p) => p.property_id),
    );
  } catch {
    targetsSection = undefined;
  }

  return formatAnalysis(analysis, costSource.label, dataNote, isDefault, targetsSection, monthEndNote);
}

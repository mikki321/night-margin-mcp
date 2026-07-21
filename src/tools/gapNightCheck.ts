import { avgTurnoverCost, minMargin as minMarginFromEnv } from "../config.js";
import { gapNightFloor, parseISODate } from "../core/calc.js";
import type { Reservation, TurnoverCost } from "../core/types.js";
import { costSourceFromEnv } from "../sources/index.js";
import { reservationSourceFromEnv } from "../sources/reservationSource.js";
import { avgFallbackFromEnv, resolveCosts } from "../sources/resolveCosts.js";

const MS_PER_DAY = 86_400_000;
const WINDOW_BEFORE_DAYS = 45;
const WINDOW_AFTER_DAYS = 15;

const eur = (n: number): string => {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString("en-US");
  return v < 0 ? `-€${s}` : `€${s}`;
};
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Varaushaun ikkuna: [date − 45 pv, date + 15 pv]. */
export function checkWindow(date: string): { from: string; to: string } {
  const t = parseISODate(date);
  return {
    from: isoDay(t - WINDOW_BEFORE_DAYS * MS_PER_DAY),
    to: isoDay(t + WINDOW_AFTER_DAYS * MS_PER_DAY),
  };
}

/** Mediaani. Tyhjälle listalle 0 — kutsuja hoitaa tyhjän tapauksen erikseen. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface TurnoverEstimate {
  /** siivous + pyykki, € per vaihto */
  turnover: number;
  /** matka, € per vaihto */
  travel: number;
  /** true = laskettu kohteen omista kustannusriveistä, false = manual-keskiarvo */
  fromRows: boolean;
  rowCount: number;
}

/** Vaihtoarvio kohteen kustannusriveistä (mediaanit); ilman rivejä manual-keskiarvo. */
export function estimateTurnover(rows: TurnoverCost[], manualAvg: number): TurnoverEstimate {
  if (rows.length === 0) {
    return { turnover: manualAvg, travel: 0, fromRows: false, rowCount: 0 };
  }
  return {
    turnover: median(rows.map((r) => r.cleaning_cost + r.laundry_cost)),
    travel: median(rows.map((r) => r.travel_cost)),
    fromRows: true,
    rowCount: rows.length,
  };
}

/** Varaus joka kattaa yön `date` — yö kuuluu alkupäivälleen, checkout eksklusiivinen (kuten core). */
export function findBooking(
  reservations: Reservation[],
  propertyId: string,
  date: string,
): Reservation | undefined {
  return reservations.find(
    (r) => r.property_id === propertyId && r.checkin <= date && date < r.checkout,
  );
}

export interface GapNightData {
  /** Ikkunan varaukset (kaikki kohteet) — kohteen tunnistukseen ja varauscheckiin. */
  reservations: Reservation[];
  /** Kohteen varausten kustannusrivit; tyhjä → manual-keskiarvo. */
  costRows: TurnoverCost[];
  /** Haetun ikkunan rajat virheviestejä varten. */
  from: string;
  to: string;
  minMargin: number;
  manualAvg: number;
  candidatePrice?: number;
  /**
   * Askel 3: WH-hintasuositus (price_recommendations, stay_date-osuma).
   * Kytkentä = anna tämä kenttä — muuta ei tarvita.
   */
  recommendedPrice?: number;
  whKeyPresent?: boolean;
  /** CostSourcen label, esim. "csv (examples/sample-costs.csv, 181 rows)". */
  costLabel?: string;
  /** Lisähuomautus kustannusriveistä (esim. haun epäonnistuminen). */
  costNote?: string;
}

/** Puhdas raportti: ei I/O:ta — kaikki data injektoituna. */
export function gapNightReport(propertyId: string, date: string, data: GapNightData): string {
  const known = [...new Set(data.reservations.map((r) => r.property_id))].sort();
  if (known.length === 0) {
    throw new Error(
      `No reservations in the data within the window ${data.from} – ${data.to} — check the data source and the date`,
    );
  }
  if (!known.includes(propertyId)) {
    const shown = known.slice(0, 10);
    const suffix = known.length > 10 ? ` (showing 10 of ${known.length})` : "";
    throw new Error(
      `Property "${propertyId}" not found in the reservation data within the window ${data.from} – ${data.to}. ` +
        `Known properties${suffix}: ${shown.join(", ")} — check property_id`,
    );
  }

  const header = `## Gap night check: ${propertyId} · ${date}`;

  const booking = findBooking(data.reservations, propertyId, date);
  if (booking) {
    return [
      header,
      `Not a gap night — booking ${booking.reservation_id} (${booking.checkin} – ${booking.checkout}) covers the night of ${date}.`,
    ].join("\n");
  }

  const est = estimateTurnover(data.costRows, data.manualAvg);
  const floor = gapNightFloor(est.turnover, est.travel, data.minMargin);

  const estimateNote = est.fromRows
    ? `turnover estimate: median of ${est.rowCount} cost rows`
    : `turnover estimate: no cost rows → manual average ${eur(data.manualAvg)}`;
  const sourceLine = [
    `Cost source: ${data.costLabel ?? "unknown"}`,
    estimateNote,
    ...(data.costNote ? [data.costNote] : []),
  ].join(" · ");

  const floorPart = `Floor ${eur(floor)} (turnover ${Math.round(est.turnover)} + travel ${Math.round(est.travel)} + margin ${Math.round(data.minMargin)})`;

  const price =
    data.candidatePrice !== undefined
      ? { value: data.candidatePrice, label: "candidate price" }
      : data.recommendedPrice !== undefined
        ? { value: data.recommendedPrice, label: "WH recommendation" }
        : undefined;

  let verdictLine: string;
  if (price) {
    const diff = price.value - floor;
    const verdict = diff >= 0 ? "FILL" : "SKIP";
    const diffTxt = diff >= 0 ? `+${eur(diff)}` : eur(diff);
    verdictLine = `${floorPart} · ${price.label} ${eur(price.value)} → ${verdict} — filling yields ${diffTxt}.`;
  } else if (data.whKeyPresent) {
    verdictLine = `${floorPart}. The WH price recommendation will be wired in once the WH reservation adapter is ready — provide candidate_price to get a FILL/SKIP verdict.`;
  } else {
    verdictLine = `${floorPart}. Provide candidate_price (€/night) to get a FILL/SKIP verdict — FILL when price ≥ floor.`;
  }

  return [header, sourceLine, verdictLine].join("\n");
}

export interface GapNightArgs {
  property_id: string;
  date: string;
  candidate_price?: number;
}

/**
 * Aukkoyön fill/skip-tarkistus.
 *
 * Askel 3 -kytkentä (WH-hintasuositus): kun listing↔property-mapping on
 * olemassa, hae priceRecommendations ja anna stay_date-osuma
 * gapNightReportin `recommendedPrice`-kenttään — yhden kutsun lisäys.
 */
export async function runGapNightCheck(
  args: GapNightArgs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { from, to } = checkWindow(args.date);
  const reservationSource = reservationSourceFromEnv(env);
  const reservations = await reservationSource.getReservations(from, to);

  const propertyReservations = reservations.filter((r) => r.property_id === args.property_id);
  const needCosts =
    propertyReservations.length > 0 && !findBooking(reservations, args.property_id, args.date);

  let costRows: TurnoverCost[] = [];
  let costLabel: string | undefined;
  let costNote: string | undefined;
  if (needCosts) {
    const costSource = costSourceFromEnv(env);
    costLabel = costSource.label;
    try {
      // Sama kohdistuskaskadi kuin analyze/compare-tooleissa (id → koodi →
      // komposiitti → keskiarvo) — sama data, sama tulkinta joka toolissa.
      const { costs, matchNote } = await resolveCosts(
        costSource,
        propertyReservations,
        from,
        to,
        avgFallbackFromEnv(env),
      );
      costRows = propertyReservations
        .map((r) => costs.get(r.reservation_id))
        .filter((c): c is TurnoverCost => c !== undefined);
      if (matchNote) costNote = matchNote;
    } catch (e) {
      costNote = `failed to fetch cost rows (${(e as Error).message})`;
    }
  }

  return gapNightReport(args.property_id, args.date, {
    reservations,
    costRows,
    from,
    to,
    minMargin: minMarginFromEnv(env),
    manualAvg: avgTurnoverCost(env),
    candidatePrice: args.candidate_price,
    whKeyPresent: Boolean(env.WHEELHOUSE_API_KEY?.trim()),
    costLabel,
    costNote,
  });
}

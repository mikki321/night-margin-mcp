import { avgTurnoverCost, minMargin as minMarginFromEnv } from "../config.js";
import { gapNightFloor, parseISODate } from "../core/calc.js";
import type { Reservation, TurnoverCost } from "../core/types.js";
import { costSourceFromEnv } from "../sources/index.js";
import { reservationSourceFromEnv } from "../sources/reservationSource.js";
import { avgFallbackFromEnv, resolveCosts } from "../sources/resolveCosts.js";

const MS_PER_DAY = 86_400_000;
const WINDOW_BEFORE_DAYS = 45;
const WINDOW_AFTER_DAYS = 15;

const eur = (n: number): string => `${Math.round(n).toLocaleString("fi-FI")} €`;
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
  /** CostSourcen label, esim. "csv (examples/sample-costs.csv, 181 riviä)". */
  costLabel?: string;
  /** Lisähuomautus kustannusriveistä (esim. haun epäonnistuminen). */
  costNote?: string;
}

/** Puhdas raportti: ei I/O:ta — kaikki data injektoituna. */
export function gapNightReport(propertyId: string, date: string, data: GapNightData): string {
  const known = [...new Set(data.reservations.map((r) => r.property_id))].sort();
  if (known.length === 0) {
    throw new Error(
      `Varausdatassa ei ole yhtään varausta ikkunalla ${data.from} – ${data.to} — tarkista datalähde ja päivämäärä`,
    );
  }
  if (!known.includes(propertyId)) {
    const shown = known.slice(0, 10);
    const suffix = known.length > 10 ? ` (10/${known.length} näytetty)` : "";
    throw new Error(
      `Kohdetta "${propertyId}" ei löydy varausdatasta ikkunalla ${data.from} – ${data.to}. ` +
        `Tunnetut kohteet${suffix}: ${shown.join(", ")} — tarkista property_id`,
    );
  }

  const header = `## Aukkoyötarkistus: ${propertyId} · ${date}`;

  const booking = findBooking(data.reservations, propertyId, date);
  if (booking) {
    return [
      header,
      `Ei aukkoyö — varaus ${booking.reservation_id} (${booking.checkin} – ${booking.checkout}) kattaa yön ${date}.`,
    ].join("\n");
  }

  const est = estimateTurnover(data.costRows, data.manualAvg);
  const floor = gapNightFloor(est.turnover, est.travel, data.minMargin);

  const estimateNote = est.fromRows
    ? `vaihtoarvio: mediaani ${est.rowCount} kustannusrivistä`
    : `vaihtoarvio: ei kustannusrivejä → manual-keskiarvo ${eur(data.manualAvg)}`;
  const sourceLine = [
    `Kustannuslähde: ${data.costLabel ?? "tuntematon"}`,
    estimateNote,
    ...(data.costNote ? [data.costNote] : []),
  ].join(" · ");

  const floorPart = `Lattia ${eur(floor)} (vaihto ${Math.round(est.turnover)} + matka ${Math.round(est.travel)} + kate ${Math.round(data.minMargin)})`;

  const price =
    data.candidatePrice !== undefined
      ? { value: data.candidatePrice, label: "ehdokashinta" }
      : data.recommendedPrice !== undefined
        ? { value: data.recommendedPrice, label: "WH-suositus" }
        : undefined;

  let verdictLine: string;
  if (price) {
    const diff = price.value - floor;
    const verdict = diff >= 0 ? "FILL" : "SKIP";
    const diffTxt = diff >= 0 ? `+${eur(diff)}` : eur(diff);
    verdictLine = `${floorPart} · ${price.label} ${eur(price.value)} → ${verdict} — täyttö tuottaa ${diffTxt}.`;
  } else if (data.whKeyPresent) {
    verdictLine = `${floorPart}. WH-hintasuositus kytketään kun WH-varausadapteri on valmis — anna candidate_price, niin saat FILL/SKIP-verdiktin.`;
  } else {
    verdictLine = `${floorPart}. Anna candidate_price (€/yö), niin saat FILL/SKIP-verdiktin — FILL kun hinta ≥ lattia.`;
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
      costNote = `kustannusrivien haku epäonnistui (${(e as Error).message})`;
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

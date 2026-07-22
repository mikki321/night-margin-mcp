/**
 * Päätössilmukan puhdas ydin — EI I/O:ta. Ehdottaa aukkoyölattia-päätöksiä:
 * tulevat aukkoyöt joiden hintasuositus alittaa kohteen omakustannelattian
 * (mediaanivaihto + mediaanimatka + MIN_MARGIN) nostetaan lattiaan.
 *
 * Vaikutusarvio on REHELLINEN: "suojaa N yötä alle omakustannehinnan
 * myynniltä" — ei kuvitteellista tuottolupausta (lattian asettaminen ei
 * takaa että yö myydään).
 */

import { nightFloor, nightFloorRaw, overlapNights, parseISODate } from "./calc.js";
import type { Reservation, TurnoverCost } from "./types.js";

const MS_PER_DAY = 86_400_000;
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Yökohtainen hinta — rakenteellisesti yhteensopiva WhPriceRecin kanssa (core ei riipu WH-moduulista). */
export interface NightPrice {
  stay_date: string;
  price: number;
}

/** Mediaani. Tyhjälle listalle 0 — kutsuja hoitaa tyhjän tapauksen erikseen. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Aukkoyöt per kohde jaksolla [from, to) — TÄSMÄLLEEN sama yömääritelmä kuin
 * core/calc.ts: yö kuuluu alkupäivälleen, `to` on eksklusiivinen. Kohteet
 * mukaan samalla säännöllä kuin analyysissä (varauksen yöt osuvat jaksolle
 * TAI checkout ∈ [from, to)); kohteista joilla ei ole yhtään varausta emme
 * tiedä mitään → ei rivejä. Sama yksi-yksikkö-oletus kuin calc/simulate.
 */
export function gapNightsByProperty(
  reservations: Reservation[],
  from: string,
  to: string,
): Map<string, string[]> {
  const fromT = parseISODate(from);
  const toT = parseISODate(to);
  if (toT <= fromT) throw new Error(`Period end (${to}) must be after the start (${from})`);
  const periodNights = Math.round((toT - fromT) / MS_PER_DAY);

  const byProperty = new Map<string, Reservation[]>();
  for (const r of reservations) {
    const checkoutT = parseISODate(r.checkout);
    const checkoutInWindow = checkoutT >= fromT && checkoutT < toT;
    if (overlapNights(r, from, to) === 0 && !checkoutInWindow) continue;
    const list = byProperty.get(r.property_id) ?? [];
    list.push(r);
    byProperty.set(r.property_id, list);
  }

  const out = new Map<string, string[]>();
  for (const [propertyId, propRes] of byProperty) {
    const occupied = new Array<boolean>(periodNights).fill(false);
    for (const r of propRes) {
      const start = Math.max(parseISODate(r.checkin), fromT);
      const end = Math.min(parseISODate(r.checkout), toT);
      for (let t = start; t < end; t += MS_PER_DAY) {
        occupied[Math.round((t - fromT) / MS_PER_DAY)] = true;
      }
    }
    const gaps: string[] = [];
    for (let i = 0; i < periodNights; i++) {
      if (!occupied[i]) gaps.push(iso(fromT + i * MS_PER_DAY));
    }
    if (gaps.length > 0) out.set(propertyId, gaps);
  }
  return out;
}

/** Ryhmittelee nousevasti järjestetyt päivät peräkkäisiksi jonoiksi. */
export function groupConsecutive(dates: string[]): string[][] {
  const sorted = [...dates].sort();
  const runs: string[][] = [];
  for (const date of sorted) {
    const current = runs[runs.length - 1];
    if (
      current &&
      parseISODate(date) - parseISODate(current[current.length - 1]) === MS_PER_DAY
    ) {
      current.push(date);
    } else {
      runs.push([date]);
    }
  }
  return runs;
}

/**
 * Yöt → PUT/DELETE-rangeiksi: start_date = jonon ensimmäinen yö, end_date =
 * viimeinen yö + 1 pv (verifioitu WH-muoto: yhden yön range on end = start + 1).
 * Ei-peräkkäiset päivät jaetaan omiin rangeihinsa.
 */
export function datesToRanges(dates: string[]): { start_date: string; end_date: string }[] {
  return groupConsecutive(dates).map((run) => ({
    start_date: run[0],
    end_date: iso(parseISODate(run[run.length - 1]) + MS_PER_DAY),
  }));
}

export interface GapFloorProposal {
  property_id: string;
  /** Peräkkäiset yöt (yksi ehdotus per jono). */
  dates: string[];
  /**
   * Lattiahinta €/yö johon yöt nostettaisiin: nightFloor(mediaanivaihto,
   * mediaanimatka, minMargin, min_stay) — raakalattia jaettuna yön min staylla
   * ja pyöristettynä YLÖS kokonaiseuroon; kirjoitettu hinta ei koskaan alita
   * lattiaa. Ilman min stay -sääntöä (min_stay = 1) täsmälleen entinen
   * ceil(gapNightFloor(...)).
   */
  floor_price: number;
  /**
   * Näiden öiden yhteinen minimioleskelu (1 = ei sääntöä) — lattia on
   * amortisoitu tämän yli. Sama kaikille ehdotuksen öille (osa
   * ryhmittelyavainta), jotta selite ja floor_price pitävät paikkansa.
   */
  min_stay: number;
  /** Suositusten haarukka näille öille, €. */
  rec_min: number;
  rec_max: number;
  /** = dates.length — montako yötä suojataan alle omakustannehinnan myynniltä. */
  protected_nights: number;
  /** Σ(floor_price − suositus) öiden yli, € — kuinka paljon lattian alla suositukset ovat. */
  floor_vs_rec_delta: number;
}

export interface ProposeInputs {
  reservations: Reservation[];
  /** avain = reservation_id (resolveCosts-muoto). */
  costsById: Map<string, TurnoverCost>;
  /** Per kohde: yökohtaiset hinnat (WH-suositukset; mock-tilassa demo-estimaatti). */
  priceRecsByProperty: Map<string, NightPrice[]>;
  from: string;
  to: string;
  minMargin: number;
  /**
   * Per kohde: yöt joita EI saa ehdottaa (esim. jo applied-tilaisen päätöksen
   * kattamat yöt) — päällekkäiset päätökset samoille öille rikkoisivat
   * revert-järjestyksen (jälkimmäisen snapshot = edellisen lattiahinta).
   */
  excludeNights?: Map<string, ReadonlySet<string>>;
  /**
   * Per kohde: yön voimassa oleva minimioleskelu (vain kokonaisluvut ≥ 2 —
   * kutsuja normalisoi; puuttuva yö = ei sääntöä = 1). Live-tilassa täytetään
   * Wheelhousen min_stay_calendarista; mock-tilassa jätetään antamatta →
   * kaikki lattiat täsmälleen ennallaan.
   */
  minStayByProperty?: Map<string, ReadonlyMap<string, number>>;
}

/**
 * Aukkoyölattia-ehdotukset jaksolle [from, to):
 * - aukkoyöt samalla yömääritelmällä kuin calc.ts (gapNightsByProperty)
 * - lattia per yö = nightFloorRaw(mediaani(cleaning+laundry), mediaani(travel),
 *   minMargin, yön min_stay) — ilman min stay -sääntöä täsmälleen entinen
 *   kohdekohtainen gapNightFloor
 * - yö ehdolle kun sille on hinta JA hinta < lattia (raakalattia, ei pyöristetty)
 * - peräkkäiset yöt joilla SAMA lattia (floor + min_stay ryhmittelyavaimessa)
 *   yhdistetään yhdeksi ehdotukseksi per kohde
 * - järjestys: suurin floor_vs_rec_delta ensin (eniten suojattavaa ylimpänä)
 *
 * Yöt joille ei ole hintaa (esim. suositushorisontin ulkopuolella) jätetään
 * ehdottamatta — vertailua ei voi tehdä rehellisesti.
 */
export function proposeGapFloorDecisions(inputs: ProposeInputs): GapFloorProposal[] {
  const gaps = gapNightsByProperty(inputs.reservations, inputs.from, inputs.to);
  const proposals: GapFloorProposal[] = [];

  for (const [propertyId, gapDates] of gaps) {
    const rows = inputs.reservations
      .filter((r) => r.property_id === propertyId)
      .map((r) => inputs.costsById.get(r.reservation_id))
      .filter((c): c is TurnoverCost => c !== undefined);
    if (rows.length === 0) continue; // ei kustannuspohjaa → ei lattiaa → ei ehdotusta

    const turnover = median(rows.map((c) => c.cleaning_cost + c.laundry_cost));
    const travel = median(rows.map((c) => c.travel_cost));
    const minStayByDate = inputs.minStayByProperty?.get(propertyId);
    const stayFor = (d: string): number => minStayByDate?.get(d) ?? 1;

    const priceByDate = new Map(
      (inputs.priceRecsByProperty.get(propertyId) ?? []).map((p) => [p.stay_date, p.price]),
    );
    const excluded = inputs.excludeNights?.get(propertyId);
    const flagged = gapDates.filter((d) => {
      if (excluded?.has(d)) return false;
      const price = priceByDate.get(d);
      return price !== undefined && price < nightFloorRaw(turnover, travel, inputs.minMargin, stayFor(d));
    });

    const pushProposal = (dates: string[]): void => {
      const stay = stayFor(dates[0]);
      const floorPrice = nightFloor(turnover, travel, inputs.minMargin, stay);
      const prices = dates.map((d) => priceByDate.get(d)!);
      proposals.push({
        property_id: propertyId,
        dates,
        floor_price: floorPrice,
        min_stay: stay,
        rec_min: Math.min(...prices),
        rec_max: Math.max(...prices),
        protected_nights: dates.length,
        floor_vs_rec_delta: dates.reduce((acc, d) => acc + (floorPrice - priceByDate.get(d)!), 0),
      });
    };

    for (const run of groupConsecutive(flagged)) {
      // Lattia (= min_stay, josta lattia kohteen sisällä määräytyy) on osa
      // ryhmittelyavainta: jono katkaistaan kun yön min_stay vaihtuu, jotta
      // ehdotuksen floor_price ja amortisointiselite pätevät sen joka yölle.
      // Ilman min stay -dataa stayFor on vakio 1 → yksi ehdotus per jono,
      // täsmälleen entinen käytös.
      let segment: string[] = [];
      for (const d of run) {
        if (segment.length > 0 && stayFor(d) !== stayFor(segment[0])) {
          pushProposal(segment);
          segment = [];
        }
        segment.push(d);
      }
      if (segment.length > 0) pushProposal(segment);
    }
  }

  proposals.sort((a, b) => b.floor_vs_rec_delta - a.floor_vs_rec_delta);
  return proposals;
}

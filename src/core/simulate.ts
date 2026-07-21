import { nightsInPeriod, overlapNights, parseISODate, totalCost } from "./calc.js";
import type { Reservation, TurnoverCost } from "./types.js";

const MS_PER_DAY = 86_400_000;
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Simulaation tulos: muokatut KOPIOT — alkuperäisiä inputteja ei mutatoida. */
export interface SimulationResult {
  reservations: Reservation[];
  costs: Map<string, TurnoverCost>;
}

export interface FillGapsOptions {
  /** Alennus % kohteen ADR:stä aukkoyön hinnalle (oletus 40). */
  discountPct?: number;
}

export interface MinStayOptions {
  /** Minimioleskelu öinä — tätä lyhyemmät varaukset pudotetaan (oletus 3). */
  minStay?: number;
  /** Jäljelle jäävien varausten hinnankorotus prosentteina (oletus 10). */
  upliftPct?: number;
}

/**
 * Kohteen olemassa olevien kustannusrivien MEDIAANI kokonaiskustannuksesta
 * (cleaning + travel + laundry). Parillisella määrällä kahden keskimmäisen
 * keskiarvo.
 */
function medianTotalCost(rows: TurnoverCost[]): number {
  const totals = rows.map(totalCost).sort((a, b) => a - b);
  const mid = Math.floor(totals.length / 2);
  return totals.length % 2 === 1 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
}

/**
 * Strategia A — täytä aukkoyöt alennuksella.
 *
 * Per kohde:
 * - ADR = jaksolle [from, to) osuvien varausten Σ gross_revenue / Σ nights
 *   (koko varauksen luvuilla, ei jaksolle leikattuna).
 * - Jokaiselle aukkoyölle syntyy synteettinen 1 yön varaus id:llä
 *   "gap-<property_id>-<date>" hintaan ADR × (1 − discountPct/100).
 *   Aukkoyöt lasketaan samalla määritelmällä kuin core/calc.ts:
 *   yö kuuluu alkupäivälleen, `to` on eksklusiivinen.
 * - Synteettisen varauksen kustannus = kohteen olemassa olevien
 *   kustannusrivien MEDIAANI kokonaiskustannuksesta. Valinta: koko summa
 *   kirjataan cleaning_costiin (travel/laundry 0) — analyysi käyttää vain
 *   rivin kokonaissummaa, joten jako komponentteihin ei vaikuta tuloksiin
 *   ja tämä pitää simulaation yksinkertaisena.
 * - Jakson VIIMEISTÄ yötä ei täytetä: sen synteettisen varauksen checkout
 *   olisi `to`, jolloin analyysi laskisi tuoton mutta ei vaihtokustannusta
 *   (kustannus kohdistuu checkout-päivälle, joka jäisi jakson ulkopuolelle)
 *   eikä nettonegatiivinen täyttö kirjautuisi vuotoon — rivi olisi
 *   sisäisesti ristiriitainen ja vinouttaisi tulosta strategian A eduksi.
 *
 * Kohteet mukaan samalla säännöllä kuin analyysissä: varauksen yöt osuvat
 * jaksolle TAI checkout ∈ [from, to). Kohteet, joilla ei ole yhtään tällaista
 * varausta, eivät näy inputissa eikä niille voida arvioida ADR:ää → ei
 * synteettisiä öitä.
 *
 * Oletus (sama kuin core/calc.ts): yksi yksikkö per property_id — jos
 * datassa on päällekkäisiä varauksia (moniyksikkökohde), varatut yöt
 * lasketaan tässä unionina mutta calc summaa ne, jolloin käyttöaste voi
 * erota. Palauttaa kopiot; inputteja ei mutatoida.
 */
export function simulateFillGaps(
  reservations: Reservation[],
  costsById: Map<string, TurnoverCost>,
  from: string,
  to: string,
  opts: FillGapsOptions = {},
): SimulationResult {
  const discountPct = opts.discountPct ?? 40;
  if (discountPct < 0 || discountPct > 100) {
    throw new Error(`discountPct=${discountPct} ei kelpaa — anna alennus väliltä 0–100`);
  }
  const fromT = parseISODate(from);
  const toT = parseISODate(to);
  if (toT <= fromT) throw new Error(`Jakson loppu (${to}) pitää olla alun (${from}) jälkeen`);
  const periodNights = nightsInPeriod(from, to);

  // Ryhmittele jaksolle osuvat varaukset kohteittain — sama sisällytyssääntö
  // kuin analyysissä (yöt osuvat jaksolle TAI checkout ∈ [from, to)).
  const byProperty = new Map<string, Reservation[]>();
  for (const r of reservations) {
    const checkoutT = parseISODate(r.checkout);
    const checkoutInWindow = checkoutT >= fromT && checkoutT < toT;
    if (overlapNights(r, from, to) === 0 && !checkoutInWindow) continue;
    const list = byProperty.get(r.property_id) ?? [];
    list.push(r);
    byProperty.set(r.property_id, list);
  }

  const outReservations = [...reservations];
  const outCosts = new Map(costsById);

  for (const [propertyId, propRes] of byProperty) {
    const totalGross = propRes.reduce((acc, r) => acc + r.gross_revenue, 0);
    const totalNights = propRes.reduce((acc, r) => acc + r.nights, 0);
    if (totalNights <= 0) continue;
    const adr = totalGross / totalNights;
    const gapPrice = adr * (1 - discountPct / 100);

    const costRows = propRes
      .map((r) => costsById.get(r.reservation_id))
      .filter((c): c is TurnoverCost => c !== undefined);
    if (costRows.length === 0) {
      throw new Error(
        `Kohteen ${propertyId} varauksilta puuttuvat kustannusrivit — tarkista kustannuslähde (COST_SOURCE)`,
      );
    }
    const gapCost = medianTotalCost(costRows);

    // Merkitse varatut yöt [from, to) -välillä (yö = alkupäivänsä).
    const occupied = new Array<boolean>(periodNights).fill(false);
    for (const r of propRes) {
      const start = Math.max(parseISODate(r.checkin), fromT);
      const end = Math.min(parseISODate(r.checkout), toT);
      for (let t = start; t < end; t += MS_PER_DAY) {
        occupied[Math.round((t - fromT) / MS_PER_DAY)] = true;
      }
    }

    // Viimeinen yö (i = periodNights − 1) jätetään täyttämättä — ks. doc yllä.
    for (let i = 0; i < periodNights - 1; i++) {
      if (occupied[i]) continue;
      const nightT = fromT + i * MS_PER_DAY;
      const date = iso(nightT);
      const id = `gap-${propertyId}-${date}`;
      outReservations.push({
        reservation_id: id,
        property_id: propertyId,
        checkin: date,
        checkout: iso(nightT + MS_PER_DAY),
        nights: 1,
        gross_revenue: gapPrice,
      });
      outCosts.set(id, {
        reservation_id: id,
        cleaning_cost: gapCost,
        travel_cost: 0,
        laundry_cost: 0,
      });
    }
  }

  return { reservations: outReservations, costs: outCosts };
}

/**
 * Strategia B — minimioleskelu + hinnankorotus.
 *
 * Pudottaa varaukset joissa nights < minStay kustannusriveineen ja korottaa
 * jäljelle jäävien gross_revenueta × (1 + upliftPct/100). Sääntö koskee
 * kaikkia annettuja varauksia; jaksolle leikkaamisen tekee analyzePortfolio.
 * Palauttaa kopiot; inputteja ei mutatoida.
 */
export function simulateMinStayUplift(
  reservations: Reservation[],
  costsById: Map<string, TurnoverCost>,
  _from: string,
  _to: string,
  opts: MinStayOptions = {},
): SimulationResult {
  const minStay = opts.minStay ?? 3;
  const upliftPct = opts.upliftPct ?? 10;
  if (!Number.isInteger(minStay) || minStay < 1) {
    throw new Error(`minStay=${minStay} ei kelpaa — anna kokonaisluku ≥ 1`);
  }
  if (upliftPct <= -100) {
    throw new Error(`upliftPct=${upliftPct} ei kelpaa — anna korotus suurempi kuin −100`);
  }

  const factor = 1 + upliftPct / 100;
  const outReservations: Reservation[] = [];
  const outCosts = new Map<string, TurnoverCost>();

  for (const r of reservations) {
    if (r.nights < minStay) continue;
    outReservations.push({ ...r, gross_revenue: r.gross_revenue * factor });
    const cost = costsById.get(r.reservation_id);
    if (cost) outCosts.set(r.reservation_id, cost);
  }

  return { reservations: outReservations, costs: outCosts };
}

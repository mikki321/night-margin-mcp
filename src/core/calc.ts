import type {
  NegativeReservation,
  PortfolioAnalysis,
  PropertyStats,
  Reservation,
  TurnoverCost,
} from "./types.js";

const MS_PER_DAY = 86_400_000;

export function parseISODate(d: string): number {
  const t = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`Invalid date: "${d}" — use the format YYYY-MM-DD`);
  // Kalenteritarkistus (round-trip): V8 pyöräyttää esim. 2026-02-30 → 2026-03-02
  // hiljaa — verdikti laskettaisiin eri yölle kuin käyttäjä kysyi.
  if (new Date(t).toISOString().slice(0, 10) !== d) {
    throw new Error(
      `Invalid date: "${d}" — that day does not exist in the calendar (use the format YYYY-MM-DD)`,
    );
  }
  return t;
}

/**
 * Jakson yöt [from, to) — yö kuuluu alkupäivälleen, `to` on eksklusiivinen.
 * Tämä on "käytettävissä olevat yöt per kohde" -määritelmän ainoa paikka.
 */
export function nightsInPeriod(from: string, to: string): number {
  return Math.max(0, Math.round((parseISODate(to) - parseISODate(from)) / MS_PER_DAY));
}

/** Varauksen yöt jotka osuvat jaksolle [from, to). */
export function overlapNights(r: Reservation, from: string, to: string): number {
  const start = Math.max(parseISODate(r.checkin), parseISODate(from));
  const end = Math.min(parseISODate(r.checkout), parseISODate(to));
  return Math.max(0, Math.round((end - start) / MS_PER_DAY));
}

export function totalCost(c: TurnoverCost): number {
  return c.cleaning_cost + c.travel_cost + c.laundry_cost;
}

/** Koko oleskelun netto vaihtokustannusten jälkeen. */
export function reservationNet(r: Reservation, c: TurnoverCost): number {
  return r.gross_revenue - totalCost(c);
}

/** Aukkoyön lattiahinta: alle tämän täyttö on nettona tappiollista. */
export function gapNightFloor(turnoverCost: number, travelCost: number, minMargin: number): number {
  return turnoverCost + travelCost + minMargin;
}

/**
 * Min-stay-tietoinen lattia RAAKANA (pyöristämättä): n yön oleskelu hintaan
 * p/yö nettoaa n×p − (vaihto + matka); vaatimus netto ≥ kate antaa
 * p ≥ (vaihto + matka + kate) / n, ja pahin sallittu tapaus on n = min_stay.
 * minStay ≤ 1 (ei sääntöä) → täsmälleen gapNightFloor — nykyiset luvut eivät
 * muutu. Ehdotusten "hinta < lattia" -vertailu tehdään tällä raakalattialla
 * (sama sääntö kuin ennen: pyöristys ei saa flägätä rajalla olevaa yötä).
 */
export function nightFloorRaw(
  turnoverCost: number,
  travelCost: number,
  minMargin: number,
  minStay: number,
): number {
  return gapNightFloor(turnoverCost, travelCost, minMargin) / Math.max(1, minStay);
}

/**
 * Min-stay-tietoinen lattia KIRJOITETTAVANA/NÄYTETTÄVÄNÄ hintana: raakalattia
 * pyöristettynä YLÖS kokonaiseuroon — kirjoitettu hinta ei koskaan alita
 * lattiaa. minStay = 1 → ceil(gapNightFloor(...)), eli täsmälleen nykyinen
 * floor_price (kokonaislukusyötteillä sama luku kuin gapNightFloor itse).
 */
export function nightFloor(
  turnoverCost: number,
  travelCost: number,
  minMargin: number,
  minStay: number,
): number {
  return Math.ceil(nightFloorRaw(turnoverCost, travelCost, minMargin, minStay));
}

/**
 * Portfolion analyysi jaksolle [from, to).
 *
 * Kohdistussäännöt (edge-käyttäytyminen yhdessä paikassa):
 * - varatut yöt: varauksen yöt leikattuna jaksolle
 * - liikevaihto: suhteutettu jaksolle osuviin öihin (gross/nights × jakson yöt)
 * - vaihtokustannus: kohdistuu checkout-päivälle — mukana jos checkout ∈ [from, to)
 * - vuoto: varaukset joiden checkout ∈ [from, to) ja koko oleskelun netto < 0
 *
 * Oletus: yksi yksikkö per property_id. Päällekkäiset varaukset (moniyksikkö-
 * kohde) SUMMAUTUVAT varattuihin öihin — käyttöaste voi silloin ylittää 100 %
 * ja gap_nights leikkautuu nollaan. Sama oletus on core/simulate.ts:ssä.
 *
 * VALINNAINEN allPropertyIds (löydös 7): kun annettu, listan kohteet joilla ei
 * ole yhtään varausta jaksolla lisätään mukaan (booked=0, gap=jakson yöt,
 * gross=costs=0) — käyttöasteen nimittäjä kertoo koko portfolion, ei vain
 * varattuja kohteita. Ilman parametria käytös on täsmälleen entinen.
 */
export function analyzePortfolio(
  reservations: Reservation[],
  costsById: Map<string, TurnoverCost>,
  from: string,
  to: string,
  allPropertyIds?: string[],
): PortfolioAnalysis {
  const fromT = parseISODate(from);
  const toT = parseISODate(to);
  if (toT <= fromT) throw new Error(`Period end (${to}) must be after the start (${from})`);

  const periodNights = nightsInPeriod(from, to);
  const byProperty = new Map<string, { booked: number; gross: number; costs: number }>();
  const negatives: NegativeReservation[] = [];
  let leakEur = 0;
  let leakNights = 0;

  for (const r of reservations) {
    const nightsInWindow = overlapNights(r, from, to);
    const checkoutT = parseISODate(r.checkout);
    const checkoutInWindow = checkoutT >= fromT && checkoutT < toT;
    if (nightsInWindow === 0 && !checkoutInWindow) continue;

    const cost = costsById.get(r.reservation_id);
    if (!cost) {
      throw new Error(
        `Reservation ${r.reservation_id} has no cost row — check the cost source (COST_SOURCE)`,
      );
    }

    const stat = byProperty.get(r.property_id) ?? { booked: 0, gross: 0, costs: 0 };
    stat.booked += nightsInWindow;
    stat.gross += r.nights > 0 ? (r.gross_revenue / r.nights) * nightsInWindow : 0;
    if (checkoutInWindow) {
      stat.costs += totalCost(cost);
      const net = reservationNet(r, cost);
      if (net < 0) {
        leakEur += -net;
        leakNights += nightsInWindow;
        negatives.push({
          reservation_id: r.reservation_id,
          property_id: r.property_id,
          checkin: r.checkin,
          nights: r.nights,
          gross: r.gross_revenue,
          costs: totalCost(cost),
          net,
        });
      }
    }
    byProperty.set(r.property_id, stat);
  }

  // Nollavarauskohteet mukaan nimittäjään vain kun kohdelista on annettu.
  let noBookingProperties = 0;
  if (allPropertyIds) {
    for (const id of allPropertyIds) {
      if (!byProperty.has(id)) {
        byProperty.set(id, { booked: 0, gross: 0, costs: 0 });
        noBookingProperties += 1;
      }
    }
  }

  const properties: PropertyStats[] = [...byProperty.entries()].map(([property_id, s]) => {
    const available = periodNights;
    const net = s.gross - s.costs;
    return {
      property_id,
      booked_nights: s.booked,
      gap_nights: Math.max(0, available - s.booked),
      available_nights: available,
      gross: s.gross,
      costs: s.costs,
      net,
      net_per_available_night: available > 0 ? net / available : 0,
    };
  });
  properties.sort((a, b) => a.net_per_available_night - b.net_per_available_night);

  const sum = (f: (p: PropertyStats) => number) => properties.reduce((acc, p) => acc + f(p), 0);
  const bookedNights = sum((p) => p.booked_nights);
  const availableNights = sum((p) => p.available_nights);
  const gross = sum((p) => p.gross);
  const costs = sum((p) => p.costs);
  const net = gross - costs;

  negatives.sort((a, b) => a.net - b.net);

  return {
    from,
    to,
    properties,
    totals: {
      booked_nights: bookedNights,
      gap_nights: sum((p) => p.gap_nights),
      available_nights: availableNights,
      gross,
      costs,
      net,
      net_per_available_night: availableNights > 0 ? net / availableNights : 0,
      occupancy_pct: availableNights > 0 ? (bookedNights / availableNights) * 100 : 0,
    },
    leak_eur: leakEur,
    leak_nights: leakNights,
    leak_pct: bookedNights > 0 ? (leakNights / bookedNights) * 100 : 0,
    negative_reservations: negatives,
    ...(allPropertyIds !== undefined ? { no_booking_properties: noBookingProperties } : {}),
  };
}

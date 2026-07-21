import { parseISODate } from "../core/calc.js";
import type { Reservation } from "../core/types.js";

const MS_PER_DAY = 86_400_000;

/** Deterministinen PRNG — sama siemen → sama demo-portfolio joka ajolla. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * Kiinteä kalenteri: portfolio generoidaan AINA tälle välille ja leikataan
 * pyydettyyn ikkunaan. Näin jokainen tool (analyze, compare, gap_night_check)
 * näkee saman portfolion riippumatta omasta ikkunastaan — analyysin näyttämä
 * aukko on aukko myös gap-checkin ikkunassa, ja CSV:n reservation_id:t
 * osuvat samoihin varauksiin joka ikkunalla.
 */
const CAL_FROM = "2026-01-01";
const CAL_TO = "2027-01-01";

/**
 * maxGap ohjaa aukkoyövirtaa: halvat kohteet jäävät useammin tyhjilleen
 * (aukkoja 0–maxGap yötä vaihtojen väliin), premium-kohteet ovat lähes
 * täynnä. Näin "täytä aukot alennuksella" -strategian täytöt painottuvat
 * kohteisiin joissa alennettu yö EI kata vaihtokustannusta — demon
 * ydinjännite näkyy myös manual-tilan tasakustannuksella.
 */
const PROPERTIES = [
  { id: "demo-1br-01", adr: 89, maxGap: 5 },
  { id: "demo-1br-02", adr: 105, maxGap: 5 },
  { id: "demo-1br-03", adr: 98, maxGap: 5 },
  { id: "demo-2br-04", adr: 139, maxGap: 2 },
  { id: "demo-2br-05", adr: 152, maxGap: 1 },
  { id: "demo-2br-06", adr: 145, maxGap: 1 },
  { id: "demo-3br-07", adr: 210, maxGap: 1 },
  { id: "demo-3br-08", adr: 245, maxGap: 0 },
];

let calendarCache: Reservation[] | undefined;

/** Koko kalenterivuoden deterministinen portfolio (generoidaan kerran). */
function generateCalendar(): Reservation[] {
  const rnd = mulberry32(20260721);
  const calFromT = parseISODate(CAL_FROM);
  const calToT = parseISODate(CAL_TO);
  const reservations: Reservation[] = [];

  for (const prop of PROPERTIES) {
    let cursor = calFromT;
    let n = 0;
    while (cursor < calToT) {
      const gap = Math.floor(rnd() * (prop.maxGap + 1)); // 0–maxGap aukkoyötä
      cursor += gap * MS_PER_DAY;
      if (cursor >= calToT) break;

      const nights = 1 + Math.floor(rnd() * rnd() * 7); // 1–7 yötä, painottuu lyhyisiin
      const lastMinute = nights <= 2 && rnd() < 0.6; // aukkojen täyttö alennuksella
      const nightly = prop.adr * (0.75 + rnd() * 0.5) * (lastMinute ? 0.45 : 1);
      const checkout = cursor + nights * MS_PER_DAY;

      n += 1;
      reservations.push({
        reservation_id: `${prop.id}-r${n}`,
        property_id: prop.id,
        checkin: iso(cursor),
        checkout: iso(checkout),
        nights,
        gross_revenue: Math.round(nightly * nights),
      });
      cursor = checkout;
    }
  }
  return reservations;
}

/**
 * Synteettinen mock-portfolio: 8 mökkiä, vaihtelevat oleskelupituudet,
 * osa lyhyistä last minute -varauksista hinnoiteltu niin halvalla että
 * netto painuu miinukselle → analyysillä on aina jotain näytettävää.
 *
 * Ikkunariippumaton: palauttaa kiinteän kalenterin varaukset leikattuna
 * ikkunaan [from, to) — mukana myös varaus jonka checkout == from, koska
 * analyysi kohdistaa sen vaihtokustannuksen jaksolle.
 */
export function generateMockReservations(from: string, to: string): Reservation[] {
  calendarCache ??= generateCalendar();
  return calendarCache.filter((r) => r.checkin < to && r.checkout >= from);
}

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

const PROPERTIES = [
  { id: "demo-1br-01", adr: 89 },
  { id: "demo-1br-02", adr: 105 },
  { id: "demo-1br-03", adr: 98 },
  { id: "demo-2br-04", adr: 139 },
  { id: "demo-2br-05", adr: 152 },
  { id: "demo-2br-06", adr: 145 },
  { id: "demo-3br-07", adr: 210 },
  { id: "demo-3br-08", adr: 245 },
];

/**
 * Synteettinen mock-portfolio: 8 mökkiä, vaihtelevat oleskelupituudet,
 * osa lyhyistä last minute -varauksista hinnoiteltu niin halvalla että
 * netto painuu miinukselle → analyysillä on aina jotain näytettävää.
 */
export function generateMockReservations(from: string, to: string): Reservation[] {
  const rnd = mulberry32(20260721);
  const fromT = parseISODate(from);
  const toT = parseISODate(to);
  const reservations: Reservation[] = [];

  for (const prop of PROPERTIES) {
    // aloitetaan jakson alusta taaksepäin hieman, jotta reunan yli meneviä varauksia syntyy
    let cursor = fromT - Math.floor(rnd() * 4) * MS_PER_DAY;
    let n = 0;
    while (cursor < toT) {
      const gap = Math.floor(rnd() * 4); // 0–3 aukkoyötä
      cursor += gap * MS_PER_DAY;
      if (cursor >= toT) break;

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

/**
 * Generoi examples/sample-costs.csv deterministisesti mock-portfoliosta.
 * Aja repojuuresta: npx tsx scripts/generate-sample-csv.ts
 *
 * CSV kattaa mock-generaattorin KOKO kiinteän kalenterin (2026), joten
 * reservation_id:t (ja komposiittikentät) osuvat mihin tahansa
 * analyysi-ikkunaan. Aja tämä uudelleen aina kun
 * src/sources/mockReservations.ts muuttuu — muuten CSV:n id:t eriytyvät
 * mock-varauksista. Data on täysin synteettistä.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateMockReservations } from "../src/sources/mockReservations.js";

/** Sama deterministinen PRNG kuin mock-generaattorissa, oma siemen kustannuksille. */
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

/** Kustannushaarukat kokoluokittain (€) — synteettiset mutta uskottavat. */
const TIERS = [
  { match: "1br", cleaning: [50, 60], travel: [10, 20], laundry: [8, 11] },
  { match: "2br", cleaning: [65, 80], travel: [10, 22], laundry: [12, 18] },
  { match: "3br", cleaning: [85, 95], travel: [12, 25], laundry: [22, 30] },
] as const;

const rnd = mulberry32(20260722);
const draw = ([lo, hi]: readonly [number, number]): number =>
  Math.round(lo + rnd() * (hi - lo));

const HEADER =
  "reservation_id,property_id,checkin,checkout,nights,gross_revenue,cleaning_cost,travel_cost,laundry_cost,turnover_date,is_sunday_or_holiday";

const lines = [HEADER];
for (const r of generateMockReservations("2026-01-01", "2027-01-01")) {
  const tier = TIERS.find((t) => r.property_id.includes(t.match));
  if (!tier) throw new Error(`Kohteelle ${r.property_id} ei löydy kustannushaarukkaa`);
  const isSunday = new Date(`${r.checkout}T00:00:00Z`).getUTCDay() === 0;
  lines.push(
    [
      r.reservation_id,
      r.property_id,
      r.checkin,
      r.checkout,
      r.nights,
      r.gross_revenue,
      draw(tier.cleaning),
      draw(tier.travel),
      draw(tier.laundry),
      r.checkout,
      isSunday,
    ].join(","),
  );
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "sample-costs.csv");
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`Kirjoitettu ${out}: ${lines.length - 1} riviä`);

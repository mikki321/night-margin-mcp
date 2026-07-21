/**
 * Generoi web/data.json /web-demolle samasta laskentapolusta kuin toolit
 * (reservationSource + resolveCosts + core analyzePortfolio).
 *
 * Käyttö: npx tsx scripts/generate-web-data.ts [from] [to]
 * Data tulee env-konfigista (WHEELHOUSE_API_KEY → live; muuten mock;
 * COST_SOURCE ohjaa kustannukset). HUOM: web/data.json on gitignoressa —
 * live-ajo sisältää oikeaa dataa eikä saa päätyä repoon.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { analyzePortfolio } from "../src/core/calc.js";
import { costSourceFromEnv } from "../src/sources/index.js";
import { reservationSourceFromEnv } from "../src/sources/reservationSource.js";
import { avgFallbackFromEnv, resolveCosts } from "../src/sources/resolveCosts.js";

const from = process.argv[2] ?? "2026-07-01";
const to = process.argv[3] ?? "2026-10-01";

const reservationSource = reservationSourceFromEnv();
const costSource = costSourceFromEnv();

const reservations = await reservationSource.getReservations(from, to);
const { costs, matchNote } = await resolveCosts(
  costSource,
  reservations,
  from,
  to,
  avgFallbackFromEnv(process.env),
);
const analysis = analyzePortfolio(reservations, costs, from, to);

const outDir = new URL("../web/", import.meta.url);
mkdirSync(outDir, { recursive: true });
writeFileSync(
  new URL("data.json", outDir),
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      window: { from, to },
      sources: {
        reservations: reservationSource.label,
        costs: costSource.label,
        attribution: matchNote,
      },
      analysis,
    },
    null,
    1,
  ),
);
console.log(
  `web/data.json: ${analysis.properties.length} properties, ${reservations.length} bookings, net/night ${analysis.totals.net_per_available_night.toFixed(1)}`,
);

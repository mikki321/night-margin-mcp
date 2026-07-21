import type { Reservation, TurnoverCost } from "../core/types.js";
import type { CostRow } from "./costSource.js";

/** Montako varausta kohdistui milläkin kaskadin haaralla. */
export interface MatchReport {
  by_id: number;
  by_code: number;
  by_composite: number;
  by_fallback: number;
}

export interface MatchResult {
  /** avain = varauksen reservation_id (core/calc.ts:n odottama muoto) */
  costs: Map<string, TurnoverCost>;
  report: MatchReport;
  /** Datan laatuhuomiot (esim. duplikaattikomposiitit) — näytetään kohdistusrivillä. */
  warnings: string[];
}

const compositeKey = (propertyId: string, checkin: string, checkout: string): string =>
  `${propertyId.toLowerCase()}|${checkin}|${checkout}`;

/**
 * Varauksen mahdollinen vahvistuskoodi. Reservation-tyypissä ei ole kenttää
 * (vielä) — haara aktivoituu askeleessa 3, kun WH-adapterin parseri alkaa
 * tuottaa confirmation_coden oikeasta API-vastauksesta.
 */
function confirmationCode(r: Reservation): string | undefined {
  const code = (r as unknown as Record<string, unknown>).confirmation_code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * Kohdistaa kustannusrivit varauksiin kaskadilla, EI fuzzy-matchausta:
 *   1. tarkka reservation_id
 *   2. confirmation_code (jos molemmilla puolilla on)
 *   3. komposiitti lowercase(property_id)|checkin|checkout
 *   4. avgFallback (jos annettu) — pelkkä siivouskustannus, matka/pyykki 0
 *   5. muuten virhe, jossa max 3 esimerkki-id:tä ja toimintaohje
 *
 * Jokainen kustannusrivi kulutetaan enintään KERRAN: haarat ajetaan
 * tasoittain (kaikki id-osumat ennen koodi-osumia jne.), joten vahvin haara
 * saa rivin ensin eikä sama siivous kirjaudu kahdelle varaukselle. Useampi
 * rivi samalla komposiittiavaimella säilyy listana (moniyksikkökohde) —
 * kukin rivi palvelee eri varausta — ja tuottaa varoituksen.
 */
export function matchCosts(
  reservations: Reservation[],
  rows: CostRow[],
  opts: { avgFallback?: number } = {},
): MatchResult {
  const byId = new Map<string, CostRow>();
  const byCode = new Map<string, CostRow>();
  const byComposite = new Map<string, CostRow[]>();
  let duplicateCompositeKeys = 0;
  for (const row of rows) {
    if (row.reservation_id) byId.set(row.reservation_id, row);
    if (row.confirmation_code) byCode.set(row.confirmation_code, row);
    if (row.property_id && row.checkin && row.checkout) {
      const key = compositeKey(row.property_id, row.checkin, row.checkout);
      const list = byComposite.get(key) ?? [];
      list.push(row);
      if (list.length === 2) duplicateCompositeKeys += 1;
      byComposite.set(key, list);
    }
  }

  const used = new Set<CostRow>();
  const assigned = new Map<Reservation, CostRow>();
  const report: MatchReport = { by_id: 0, by_code: 0, by_composite: 0, by_fallback: 0 };

  // Taso 1: tarkka reservation_id
  for (const r of reservations) {
    const row = byId.get(r.reservation_id);
    if (row && !used.has(row)) {
      used.add(row);
      assigned.set(r, row);
      report.by_id += 1;
    }
  }
  // Taso 2: confirmation_code
  for (const r of reservations) {
    if (assigned.has(r)) continue;
    const code = confirmationCode(r);
    if (!code) continue;
    const row = byCode.get(code);
    if (row && !used.has(row)) {
      used.add(row);
      assigned.set(r, row);
      report.by_code += 1;
    }
  }
  // Taso 3: komposiitti — ensimmäinen vielä käyttämätön rivi avaimen listasta
  for (const r of reservations) {
    if (assigned.has(r)) continue;
    const list = byComposite.get(compositeKey(r.property_id, r.checkin, r.checkout)) ?? [];
    const row = list.find((candidate) => !used.has(candidate));
    if (row) {
      used.add(row);
      assigned.set(r, row);
      report.by_composite += 1;
    }
  }

  const costs = new Map<string, TurnoverCost>();
  const unmatched: string[] = [];
  for (const r of reservations) {
    const row = assigned.get(r);
    if (row) {
      costs.set(r.reservation_id, {
        reservation_id: r.reservation_id,
        cleaning_cost: row.cleaning_cost,
        travel_cost: row.travel_cost,
        laundry_cost: row.laundry_cost,
      });
    } else if (opts.avgFallback !== undefined) {
      report.by_fallback += 1;
      costs.set(r.reservation_id, {
        reservation_id: r.reservation_id,
        cleaning_cost: opts.avgFallback,
        travel_cost: 0,
        laundry_cost: 0,
      });
    } else {
      unmatched.push(r.reservation_id);
    }
  }

  if (unmatched.length > 0) {
    throw new Error(
      `No cost row found for ${unmatched.length} reservation(s) (e.g. ${unmatched
        .slice(0, 3)
        .join(", ")}) — add rows (reservation_id or property_id+checkin+checkout) to the source or set AVG_TURNOVER_COST as a fallback`,
    );
  }

  const warnings: string[] = [];
  if (duplicateCompositeKeys > 0) {
    warnings.push(
      `warning: ${duplicateCompositeKeys} composite key(s) (property+checkin+checkout) appear on multiple cost rows — each row was attributed only once`,
    );
  }

  return { costs, report, warnings };
}

/**
 * "Cost attribution: 41 id, 6 composite, 3 average" — vain nollasta
 * poikkeavat luokat. Tyhjä merkkijono jos kaikki luokat ovat nollia.
 */
export function formatMatchReport(report: MatchReport): string {
  const parts: string[] = [];
  if (report.by_id > 0) parts.push(`${report.by_id} id`);
  if (report.by_code > 0) parts.push(`${report.by_code} code`);
  if (report.by_composite > 0) parts.push(`${report.by_composite} composite`);
  if (report.by_fallback > 0) parts.push(`${report.by_fallback} average`);
  return parts.length > 0 ? `Cost attribution: ${parts.join(", ")}` : "";
}

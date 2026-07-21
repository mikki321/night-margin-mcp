import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import type { Reservation, TurnoverCost } from "../core/types.js";
import type { CostRow, CostSource } from "./costSource.js";

interface CsvRow {
  reservation_id: string;
  cleaning_cost: string;
  travel_cost: string;
  laundry_cost: string;
  /** matchCosts-kaskadin valinnaiset kentät — sample-CSV:ssä mukana */
  property_id?: string;
  checkin?: string;
  checkout?: string;
  confirmation_code?: string;
}

function num(row: CsvRow, field: keyof CsvRow, line: number): number {
  const n = Number(row[field]);
  if (Number.isNaN(n)) {
    throw new Error(`CSV line ${line}: field ${field}="${row[field]}" is not a number`);
  }
  return n;
}

/** Lukee kustannukset CSV:stä (CleanHub-export-skeema otsikkoriveinä). */
export function csvSource(opts: { path: string; fallbackAvg?: number }): CostSource {
  let rows: CsvRow[];
  try {
    rows = parse(readFileSync(opts.path, "utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as CsvRow[];
  } catch (e) {
    throw new Error(
      `Failed to read CSV (${opts.path}): ${(e as Error).message} — check CSV_PATH`,
    );
  }
  const required = ["reservation_id", "cleaning_cost", "travel_cost", "laundry_cost"];
  const missing = required.filter((c) => rows.length > 0 && !(c in rows[0]));
  if (missing.length > 0) {
    throw new Error(`CSV is missing columns: ${missing.join(", ")} (${opts.path})`);
  }

  const byId = new Map<string, TurnoverCost>();
  const costRows: CostRow[] = [];
  rows.forEach((row, i) => {
    const cost: TurnoverCost = {
      reservation_id: row.reservation_id,
      cleaning_cost: num(row, "cleaning_cost", i + 2),
      travel_cost: num(row, "travel_cost", i + 2),
      laundry_cost: num(row, "laundry_cost", i + 2),
    };
    byId.set(row.reservation_id, cost);
    costRows.push({
      ...cost,
      property_id: row.property_id || undefined,
      checkin: row.checkin || undefined,
      checkout: row.checkout || undefined,
      confirmation_code: row.confirmation_code || undefined,
    });
  });

  return {
    label: `csv (${opts.path}, ${byId.size} rows)`,
    async getRows() {
      return costRows;
    },
    async getCosts(reservations: Reservation[]) {
      const map = new Map<string, TurnoverCost>();
      const missingIds: string[] = [];
      for (const r of reservations) {
        const row = byId.get(r.reservation_id);
        if (row) {
          map.set(r.reservation_id, row);
        } else if (opts.fallbackAvg !== undefined) {
          map.set(r.reservation_id, {
            reservation_id: r.reservation_id,
            cleaning_cost: opts.fallbackAvg,
            travel_cost: 0,
            laundry_cost: 0,
          });
        } else {
          missingIds.push(r.reservation_id);
        }
      }
      if (missingIds.length > 0) {
        throw new Error(
          `${missingIds.length} reservation(s) have no cost row in the CSV (e.g. ${missingIds
            .slice(0, 3)
            .join(", ")}) — add the rows or set AVG_TURNOVER_COST as a fallback`,
        );
      }
      return map;
    },
  };
}

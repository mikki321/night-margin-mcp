import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import type { Reservation, TurnoverCost } from "../core/types.js";
import type { CostSource } from "./costSource.js";

interface CsvRow {
  reservation_id: string;
  cleaning_cost: string;
  travel_cost: string;
  laundry_cost: string;
}

function num(row: CsvRow, field: keyof CsvRow, line: number): number {
  const n = Number(row[field]);
  if (Number.isNaN(n)) {
    throw new Error(`CSV rivi ${line}: kenttä ${field}="${row[field]}" ei ole luku`);
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
      `CSV:n luku epäonnistui (${opts.path}): ${(e as Error).message} — tarkista CSV_PATH`,
    );
  }
  const required = ["reservation_id", "cleaning_cost", "travel_cost", "laundry_cost"];
  const missing = required.filter((c) => rows.length > 0 && !(c in rows[0]));
  if (missing.length > 0) {
    throw new Error(`CSV:stä puuttuu sarakkeet: ${missing.join(", ")} (${opts.path})`);
  }

  const byId = new Map<string, TurnoverCost>();
  rows.forEach((row, i) => {
    byId.set(row.reservation_id, {
      reservation_id: row.reservation_id,
      cleaning_cost: num(row, "cleaning_cost", i + 2),
      travel_cost: num(row, "travel_cost", i + 2),
      laundry_cost: num(row, "laundry_cost", i + 2),
    });
  });

  return {
    label: `csv (${opts.path}, ${byId.size} riviä)`,
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
          `${missingIds.length} varaukselta puuttuu kustannusrivi CSV:stä (esim. ${missingIds
            .slice(0, 3)
            .join(", ")}) — lisää rivit tai aseta AVG_TURNOVER_COST fallbackiksi`,
        );
      }
      return map;
    },
  };
}

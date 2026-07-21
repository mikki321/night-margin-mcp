import type { Reservation, TurnoverCost } from "../core/types.js";
import type { CostSource } from "./costSource.js";

export interface CostTier {
  /** osuma property_id:hen substring-vertailulla, esim. "1br" */
  match: string;
  cost: number;
}

/** Parsii env-muodon "1br:55,2br:70,3br:95". Tyhjä/undefined → ei tiereja. */
export function parseTiers(raw: string | undefined): CostTier[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((part) => {
    const [match, cost] = part.split(":").map((s) => s.trim());
    const n = Number(cost);
    if (!match || Number.isNaN(n)) {
      throw new Error(`Invalid COST_TIERS value "${part}" — use the format "1br:55,2br:70"`);
    }
    return { match, cost: n };
  });
}

export function manualSource(opts: { avgTurnoverCost: number; tiers?: CostTier[] }): CostSource {
  const tiers = opts.tiers ?? [];
  const costFor = (propertyId: string): number =>
    tiers.find((t) => propertyId.toLowerCase().includes(t.match.toLowerCase()))?.cost ??
    opts.avgTurnoverCost;

  return {
    label: tiers.length
      ? `manual (tiers: ${tiers.map((t) => `${t.match}:€${t.cost}`).join(", ")}, others €${opts.avgTurnoverCost})`
      : `manual (€${opts.avgTurnoverCost}/turnover)`,
    async getCosts(reservations: Reservation[]) {
      const map = new Map<string, TurnoverCost>();
      for (const r of reservations) {
        map.set(r.reservation_id, {
          reservation_id: r.reservation_id,
          cleaning_cost: costFor(r.property_id),
          travel_cost: 0,
          laundry_cost: 0,
        });
      }
      return map;
    },
  };
}

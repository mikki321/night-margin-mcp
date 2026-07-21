import type { Reservation, TurnoverCost } from "../core/types.js";

export interface CostSource {
  /** Näytetään tool-vastauksen otsikossa, esim. "manual (70 €/vaihto)". */
  label: string;
  getCosts(reservations: Reservation[]): Promise<Map<string, TurnoverCost>>;
}

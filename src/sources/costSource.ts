import type { Reservation, TurnoverCost } from "../core/types.js";

/**
 * Raaka kustannusrivi matchCosts-kaskadia varten (askel 3):
 * TurnoverCost + valinnaiset matchaus-kentät CSV-/CleanHub-contractista.
 */
export interface CostRow extends TurnoverCost {
  property_id?: string;
  /** ISO-päivä YYYY-MM-DD */
  checkin?: string;
  /** ISO-päivä YYYY-MM-DD */
  checkout?: string;
  confirmation_code?: string;
}

export interface CostSource {
  /** Näytetään tool-vastauksen otsikossa, esim. "manual (€70/turnover)". */
  label: string;
  getCosts(reservations: Reservation[]): Promise<Map<string, TurnoverCost>>;
  /**
   * Valinnainen: raa'at kustannusrivit matchCosts-kaskadille.
   * from/to (ISO-päivät) rajaavat haun verkosta hakevissa lähteissä (cleanhub);
   * tiedostopohjaiset lähteet (csv) palauttavat kaikki rivinsä ja ohittavat parametrit.
   */
  getRows?(from?: string, to?: string): Promise<CostRow[]>;
}

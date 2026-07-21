/** Varaus — kentät seuraavat CleanHub/CSV-contractin nimeämistä. */
export interface Reservation {
  reservation_id: string;
  property_id: string;
  /** ISO-päivä YYYY-MM-DD */
  checkin: string;
  /** ISO-päivä YYYY-MM-DD */
  checkout: string;
  nights: number;
  gross_revenue: number;
  /** Kanavan vahvistuskoodi (esim. WH-varauksista) — matchCosts-kaskadin haara 2. */
  confirmation_code?: string;
}

/** Yhden varauksen vaihtokustannukset. */
export interface TurnoverCost {
  reservation_id: string;
  cleaning_cost: number;
  travel_cost: number;
  laundry_cost: number;
}

export interface PropertyStats {
  property_id: string;
  booked_nights: number;
  gap_nights: number;
  available_nights: number;
  gross: number;
  costs: number;
  net: number;
  net_per_available_night: number;
}

export interface NegativeReservation {
  reservation_id: string;
  property_id: string;
  checkin: string;
  nights: number;
  gross: number;
  costs: number;
  net: number;
}

export interface PortfolioAnalysis {
  from: string;
  to: string;
  properties: PropertyStats[]; // nouseva järjestys netto/yö
  totals: {
    booked_nights: number;
    gap_nights: number;
    available_nights: number;
    gross: number;
    costs: number;
    net: number;
    net_per_available_night: number;
    occupancy_pct: number;
  };
  /** Σ |negatiivinen netto| € — varauksista joiden vaihto (checkout) osuu jaksolle */
  leak_eur: number;
  /** negatiivisten varausten jaksolle osuvat yöt */
  leak_nights: number;
  /** leak_nights / booked_nights, prosentteina */
  leak_pct: number;
  negative_reservations: NegativeReservation[];
}

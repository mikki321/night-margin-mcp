import type { Reservation } from "../core/types.js";
import { WheelhouseClient } from "../wheelhouse/client.js";
import { wheelhouseReservations } from "../wheelhouse/adapter.js";
import { generateMockReservations, mockPropertyIds } from "./mockReservations.js";

export interface ReservationSource {
  /** Näytetään tool-vastauksessa datalähteenä. */
  label: string;
  getReservations(from: string, to: string): Promise<Reservation[]>;
  /**
   * VALINNAINEN: kaikki lähteen tuntemat kohteet (myös nollavarauskohteet) —
   * analyze_portfolio laskee näillä rehellisen käyttöastenimittäjän.
   * CSV-kustannuslähteellä ei ole kohdelistaa → kenttä puuttuu.
   */
  listPropertyIds?(): Promise<string[]>;
}

export function mockReservationSource(): ReservationSource {
  return {
    label: "synthetic demo data (set WHEELHOUSE_API_KEY to analyze your own portfolio)",
    async getReservations(from, to) {
      return generateMockReservations(from, to);
    },
    async listPropertyIds() {
      return mockPropertyIds();
    },
  };
}

export function reservationSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReservationSource {
  if (env.WHEELHOUSE_API_KEY?.trim()) {
    return wheelhouseReservations(
      new WheelhouseClient({ apiKey: env.WHEELHOUSE_API_KEY.trim(), baseUrl: env.WHEELHOUSE_API_URL }),
      // Env WHEELHOUSE_CHANNEL = yliajo; ilman sitä käytetään listingin omaa
      // channel-kenttää per listing (ks. adapter.ts, verifioitu 22.7.).
      { channel: env.WHEELHOUSE_CHANNEL },
    );
  }
  return mockReservationSource();
}

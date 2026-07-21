import type { Reservation } from "../core/types.js";
import { WheelhouseClient } from "../wheelhouse/client.js";
import { wheelhouseReservations } from "../wheelhouse/adapter.js";
import { generateMockReservations } from "./mockReservations.js";

export interface ReservationSource {
  /** Näytetään tool-vastauksessa datalähteenä. */
  label: string;
  getReservations(from: string, to: string): Promise<Reservation[]>;
}

export function mockReservationSource(): ReservationSource {
  return {
    label: "synteettinen demo-data (aseta WHEELHOUSE_API_KEY analysoidaksesi omaa portfoliota)",
    async getReservations(from, to) {
      return generateMockReservations(from, to);
    },
  };
}

export function reservationSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ReservationSource {
  if (env.WHEELHOUSE_API_KEY?.trim()) {
    return wheelhouseReservations(
      new WheelhouseClient({ apiKey: env.WHEELHOUSE_API_KEY.trim(), baseUrl: env.WHEELHOUSE_API_URL }),
    );
  }
  return mockReservationSource();
}

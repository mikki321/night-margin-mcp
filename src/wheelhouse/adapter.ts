import type { Reservation } from "../core/types.js";
import type { ReservationSource } from "../sources/reservationSource.js";
import type { WheelhouseClient, WhListing } from "./client.js";

/**
 * TYNKÄ (askel 3): kirjoitetaan vasta oikean API-vastauksen mukaan —
 * työsääntö 1: Wheelhouse-vastauksen kenttiä ei arvata.
 */
export function parseWhReservations(_raw: unknown, _listing: WhListing): Reservation[] {
  throw new Error(
    "The Wheelhouse reservation parser expects a real API response (run curl #2 from the README and paste the response)",
  );
}

export function wheelhouseReservations(client: WheelhouseClient): ReservationSource {
  return {
    label: "Wheelhouse RM API (your portfolio)",
    async getReservations(from, to) {
      const listings = (await client.listListings()).filter((l) => l.is_active !== false);
      const all: Reservation[] = [];
      // sarjassa — 60 req/min -budjetti, backoff hoitaa loput
      for (const listing of listings) {
        const raw = await client.listReservationsRaw(listing.id, listing.channel);
        all.push(...parseWhReservations(raw, listing));
      }
      const inWindow = all.filter((r) => r.checkin < to && r.checkout > from);
      return inWindow;
    },
  };
}

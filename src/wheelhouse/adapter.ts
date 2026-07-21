import type { Reservation } from "../core/types.js";
import type { ReservationSource } from "../sources/reservationSource.js";
import type { WheelhouseClient, WhListing } from "./client.js";

/**
 * TYÖSÄÄNTÖ 1 (ks. TEAM.md + Päätösloki P2): Wheelhouse-VARAUSvastauksen muotoa
 * ei arvata — raja on `unknown`. Tässä tiedostossa ei saa esiintyä yhtään
 * Wheelhouse-varauskentän nimeä. Parsinta kirjoitetaan vasta oikeasta,
 * redaktoidusta curl #2 -vastauksesta (test/fixtures/wh-reservations.json).
 */

/** Parserin tyyppi — injektoitavissa testeissä, jotta putki on testattavissa ilman kenttänimiä. */
export type ParseReservations = (raw: unknown) => Reservation[];

/**
 * STUB (askel 3 / v0.2.1): heittää aina. Oikea toteutus kirjoitetaan vasta
 * oikean API-vastauksen mukaan.
 */
export function parseReservations(_raw: unknown): Reservation[] {
  throw new Error(
    "Live Wheelhouse reservations land in v0.2.1 — this version cannot parse Wheelhouse reservation responses yet. " +
      "In the meantime: unset WHEELHOUSE_API_KEY to run on synthetic demo data, " +
      "or set COST_SOURCE=csv with your own cost CSV. " +
      'Developers: see the curl commands under "For developers" in the README to capture a real reservations response.',
  );
}

/**
 * Ihmisluettava kohdenimi VAIN dokumentoiduista listings-kentistä:
 * nickname → title → id.
 */
export function listingFromDocumented(listing: WhListing): string {
  return listing.nickname?.trim() || listing.title?.trim() || String(listing.id);
}

/**
 * Valmis putki: listListings() → suodata is_active → per listing
 * listReservationsRaw() SARJASSA (60 req/min -budjetti; backoff clientissä)
 * → parse(raw) → leikkaus jaksolle [from, to).
 *
 * `parse` on oletuksena stub joka heittää — virhe nousee käyttäjälle asti,
 * EI hiljaista mock-fallbackia (Päätösloki P2/P3).
 */
export function wheelhouseReservations(
  client: WheelhouseClient,
  parse: ParseReservations = parseReservations,
): ReservationSource {
  return {
    label: "Wheelhouse RM API (live reservation parsing lands in v0.2.1)",
    async getReservations(from, to) {
      const listings = (await client.listListings()).filter((l) => l.is_active !== false);
      const all: Reservation[] = [];
      // sarjassa — ei fan-outia
      for (const listing of listings) {
        const raw = await client.listReservationsRaw(listing.id, listing.channel);
        all.push(...parse(raw));
      }
      // jaksoleikkaus [from, to): mukaan varaukset jotka leikkaavat ikkunaa
      return all.filter((r) => r.checkin < to && r.checkout > from);
    },
  };
}

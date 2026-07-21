import type { Reservation } from "../core/types.js";
import type { ReservationSource } from "../sources/reservationSource.js";
import { WheelhouseHttpError, type WheelhouseClient, type WhListing } from "./client.js";

/**
 * TYÖSÄÄNTÖ 1 TÄYTTYY (ks. TEAM.md + Päätösloki P2): tämä parseri on
 * kirjoitettu OIKEASTA curl #2 -vastauksesta (21.7.2026), ei arvauksista.
 * Synteettinen fixtuuri test/fixtures/wh-reservations.json noudattaa
 * täsmälleen samaa skeemaa.
 *
 * Mapping-päätökset (orkestraattorin spec):
 * - Vain status === "Accepted" otetaan mukaan; muut pudotetaan hiljaa.
 * - gross_revenue = total_price − taxes − security_deposit
 *   (majoitustulo + lisät; verot ja pantti eivät ole tuloa).
 * - checkin = start_date, checkout = end_date, nights = päiväero.
 * - reservation_id = id; confirmation_code mukaan jos ei-null
 *   (aktivoi matchCosts-kaskadin haaran 2).
 * - property_id asetetaan vasta putkessa listingFromDocumented-helperillä
 *   (nickname → title → id) — parseri ei tunne listinkiä.
 * - Kanava: listingin channel_ids-avaimista EI voi päätellä API:lle kelpaavaa
 *   channel-arvoa (esim. Hostaway-PMS:llä vain channel=hostaway toimii vaikka
 *   avaimissa lukee muuta) → kanava tulee env WHEELHOUSE_CHANNEL, oletus
 *   "hostaway".
 * - `comments`-kenttään ei kosketa (voi sisältää PII:tä).
 * - Virheviesteissä kentän nimi ja saatu TYYPPI, ei koskaan arvoa (PII-riski).
 *
 * v0.2.1 TODO (EI toteuteta nyt): GET /listings/{id}/price_recommendations
 * ?channel=... palauttaa {"data":[{"stay_date":"YYYY-MM-DD","price":<number>,
 * "currency":"EUR","custom_type":null}]} ~31 päivää eteenpäin → kytketään
 * gap_night_checkin recommendedPriceen stay_date-osumalla heti kun
 * listing↔property-mapping on olemassa.
 */

/** Default channel for Wheelhouse API calls — override with env WHEELHOUSE_CHANNEL. */
export const DEFAULT_WHEELHOUSE_CHANNEL = "hostaway";

/** Parserin tyyppi — injektoitavissa testeissä, jotta putki on testattavissa erikseen. */
export type ParseReservations = (raw: unknown) => Reservation[];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Tyyppinimi virheviestiin — EI koskaan itse arvoa (voi olla PII:tä). */
function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function fieldError(index: number, field: string, expected: string, got: unknown): Error {
  return new Error(
    `Wheelhouse reservation at index ${index}: field "${field}" must be ${expected}, got ${typeName(got)}`,
  );
}

function requireString(rec: Record<string, unknown>, field: string, index: number): string {
  const v = rec[field];
  if (typeof v !== "string" || v === "") {
    throw fieldError(index, field, "a non-empty string", v);
  }
  return v;
}

function requireNumber(rec: Record<string, unknown>, field: string, index: number): number {
  const v = rec[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw fieldError(index, field, "a finite number", v);
  }
  return v;
}

function requireIsoDate(rec: Record<string, unknown>, field: string, index: number): string {
  const v = requireString(rec, field, index);
  if (!DATE_RE.test(v)) {
    throw new Error(
      `Wheelhouse reservation at index ${index}: field "${field}" must be a YYYY-MM-DD date string`,
    );
  }
  return v;
}

function nightsBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / MS_PER_DAY);
}

/**
 * Parsii Wheelhouse-varausvastauksen (JSON-array) oman contractimme
 * Reservation-riveiksi. Vain "Accepted"-varaukset; ks. mapping-päätökset yllä.
 * Viallinen rivi → englanninkielinen virhe: kenttä + saatu tyyppi + indeksi,
 * EI arvoja.
 */
export function parseReservations(raw: unknown): Reservation[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `Wheelhouse reservations response: expected a JSON array of reservations, got ${typeName(raw)}`,
    );
  }
  const out: Reservation[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `Wheelhouse reservation at index ${i}: expected an object, got ${typeName(item)}`,
      );
    }
    const rec = item as Record<string, unknown>;

    // Status ensin: ei-Accepted pudotetaan hiljaa ilman lisävalidointia.
    const status = requireString(rec, "status", i);
    if (status !== "Accepted") continue;

    const id = requireString(rec, "id", i);
    const checkin = requireIsoDate(rec, "start_date", i);
    const checkout = requireIsoDate(rec, "end_date", i);
    if (!(checkout > checkin)) {
      throw new Error(
        `Wheelhouse reservation at index ${i}: field "end_date" must be a date after "start_date"`,
      );
    }
    const totalPrice = requireNumber(rec, "total_price", i);
    const taxes = requireNumber(rec, "taxes", i);
    const securityDeposit = requireNumber(rec, "security_deposit", i);

    const code = rec["confirmation_code"];
    if (code !== null && code !== undefined && typeof code !== "string") {
      throw fieldError(i, "confirmation_code", "a string or null", code);
    }

    const reservation: Reservation = {
      reservation_id: id,
      // Korvataan putkessa listing-nimellä (listingFromDocumented).
      property_id: "",
      checkin,
      checkout,
      nights: nightsBetween(checkin, checkout),
      gross_revenue: totalPrice - taxes - securityDeposit,
    };
    if (typeof code === "string" && code !== "") {
      reservation.confirmation_code = code;
    }
    out.push(reservation);
  }
  return out;
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
 * → parse(raw) → property_id listingin nimestä → leikkaus jaksolle [from, to).
 *
 * Kanava tulee kutsujalta (env WHEELHOUSE_CHANNEL, oletus "hostaway") — EI
 * listingin channel-kentästä, koska listingin omat kanava-avaimet eivät
 * välttämättä kelpaa reservations-endpointille (ks. tiedoston alun kommentti).
 */
export function wheelhouseReservations(
  client: WheelhouseClient,
  opts: { channel?: string; parse?: ParseReservations } = {},
): ReservationSource {
  const channel = opts.channel?.trim() || DEFAULT_WHEELHOUSE_CHANNEL;
  const parse = opts.parse ?? parseReservations;
  const source: ReservationSource = {
    label: "Wheelhouse RM API (live)",
    async getReservations(from, to) {
      const listings = (await client.listListings()).filter((l) => l.is_active !== false);
      const all: Reservation[] = [];
      let skipped = 0;
      // sarjassa — ei fan-outia
      for (const listing of listings) {
        const propertyId = listingFromDocumented(listing);
        let raw: unknown;
        try {
          raw = await client.listReservationsRaw(listing.id, channel);
        } catch (e) {
          // Yksittäinen kanavalta puuttuva listaus (esim. WH-natiivi ilman
          // PMS-vastinetta) ei saa kaataa koko portfolion analyysiä.
          if (e instanceof WheelhouseHttpError && e.status === 404) {
            skipped++;
            continue;
          }
          throw e;
        }
        for (const r of parse(raw)) {
          all.push({ ...r, property_id: propertyId });
        }
      }
      source.label =
        skipped > 0
          ? `Wheelhouse RM API (live) — ${skipped} listing${skipped === 1 ? "" : "s"} skipped (not found on channel "${channel}")`
          : "Wheelhouse RM API (live)";
      // jaksoleikkaus [from, to): mukaan varaukset jotka leikkaavat ikkunaa
      return all.filter((r) => r.checkin < to && r.checkout > from);
    },
  };
  return source;
}

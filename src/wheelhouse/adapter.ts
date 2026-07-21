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
 * - Kanava (päivitetty 22.7., verifioitu oikealla tilillä — wh-write-api-spec):
 *   käytetään LISTINGIN OMAA `channel`-kenttää per listing (GET /listings
 *   palauttaa esim. "hostaway" | "hypothetical"). Env WHEELHOUSE_CHANNEL toimii
 *   yliajona jos asetettu. Hypothetical-listaukset toimivat näin omalla
 *   kanavallaan; 404-ohitus säilyy varalta (esim. yliajokanavalta puuttuva
 *   listaus ei kaada koko analyysiä).
 * - `comments`-kenttään ei kosketa (voi sisältää PII:tä).
 * - Virheviesteissä kentän nimi ja saatu TYYPPI, ei koskaan arvoa (PII-riski).
 */

/** Viimesijainen fallback jos listingiltä puuttuu channel-kenttä kokonaan. */
export const DEFAULT_WHEELHOUSE_CHANNEL = "hostaway";

/**
 * API-kutsujen kanava listingille: env-yliajo voittaa; muuten listingin oma
 * channel-kenttä; viimesijaisena DEFAULT_WHEELHOUSE_CHANNEL.
 */
export function channelForListing(listing: WhListing, override?: string): string {
  const o = override?.trim();
  if (o) return o;
  const own = typeof listing.channel === "string" ? listing.channel.trim() : "";
  return own || DEFAULT_WHEELHOUSE_CHANNEL;
}

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
 * Kanava per listing: opts.channel (env WHEELHOUSE_CHANNEL) toimii yliajona
 * jos asetettu; muuten käytetään listingin omaa channel-kenttää (verifioitu
 * 22.7. — hypothetical-listausten varaukset saa niiden omalla kanavalla).
 */
export function wheelhouseReservations(
  client: WheelhouseClient,
  opts: { channel?: string; parse?: ParseReservations } = {},
): ReservationSource {
  const channelOverride = opts.channel?.trim() || undefined;
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
        const channel = channelForListing(listing, channelOverride);
        let raw: unknown;
        try {
          raw = await client.listReservationsRaw(listing.id, channel);
        } catch (e) {
          // Varalta: kanavalta puuttuva listaus (esim. yliajokanava jolla
          // listausta ei ole) ei saa kaataa koko portfolion analyysiä.
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
          ? `Wheelhouse RM API (live) — ${skipped} listing${skipped === 1 ? "" : "s"} skipped (not found on ${
              channelOverride ? `channel "${channelOverride}"` : "their listing channel"
            })`
          : "Wheelhouse RM API (live)";
      // jaksoleikkaus [from, to): mukaan varaukset jotka leikkaavat ikkunaa
      return all.filter((r) => r.checkin < to && r.checkout > from);
    },
  };
  return source;
}

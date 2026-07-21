import type { Reservation, TurnoverCost } from "../core/types.js";
import type { CostRow, CostSource } from "./costSource.js";

/**
 * CleanHub-exportin rivi — contract CLAUDE.md:ssä. Endpoint palauttaa
 * JSON-taulukon näitä rivejä (CleanHubin pää rakennetaan tätä vasten).
 */
interface CleanhubRow {
  reservation_id: string;
  cleaning_cost: number;
  travel_cost: number;
  laundry_cost: number;
  /** matchCosts-kaskadin valinnaiset kentät — contractissa mukana */
  property_id?: string;
  checkin?: string;
  checkout?: string;
  confirmation_code?: string;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Hakee todelliset vaihtokustannukset CleanHubin export-rajapinnasta. */
export function cleanhubSource(opts: {
  url: string;
  token: string;
  fetchImpl?: FetchLike;
}): CostSource {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const base = opts.url.replace(/\/$/, "");

  async function fetchRows(from: string, to: string): Promise<CleanhubRow[]> {
    const url = `${base}/api/exports/turnover-costs?from=${from}&to=${to}`;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${opts.token}` } });
    } catch (e) {
      throw new Error(`CleanHub request failed (${base}): ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new Error(
        res.status === 401 || res.status === 403
          ? `CleanHub rejected the token (HTTP ${res.status}) — check CLEANHUB_TOKEN`
          : `CleanHub returned HTTP ${res.status} (${url})`,
      );
    }
    const body = (await res.json()) as unknown;
    const rows = Array.isArray(body) ? (body as CleanhubRow[]) : null;
    if (!rows) {
      throw new Error("CleanHub response was not a JSON array — check CLEANHUB_API_URL");
    }
    return rows;
  }

  return {
    label: `cleanhub (${base})`,
    async getCosts(reservations: Reservation[]) {
      if (reservations.length === 0) return new Map();
      const from = reservations.reduce((a, r) => (r.checkin < a ? r.checkin : a), reservations[0].checkin);
      const to = reservations.reduce((a, r) => (r.checkout > a ? r.checkout : a), reservations[0].checkout);

      const map = new Map<string, TurnoverCost>();
      for (const row of await fetchRows(from, to)) {
        map.set(row.reservation_id, {
          reservation_id: row.reservation_id,
          cleaning_cost: Number(row.cleaning_cost) || 0,
          travel_cost: Number(row.travel_cost) || 0,
          laundry_cost: Number(row.laundry_cost) || 0,
        });
      }
      return map;
    },
    async getRows(from?: string, to?: string) {
      if (!from || !to) {
        throw new Error(
          "The cleanhub source's getRows requires a date range — call getRows(from, to) with ISO dates",
        );
      }
      const rows: CostRow[] = (await fetchRows(from, to)).map((row) => ({
        reservation_id: row.reservation_id,
        cleaning_cost: Number(row.cleaning_cost) || 0,
        travel_cost: Number(row.travel_cost) || 0,
        laundry_cost: Number(row.laundry_cost) || 0,
        property_id: row.property_id || undefined,
        checkin: row.checkin || undefined,
        checkout: row.checkout || undefined,
        confirmation_code: row.confirmation_code || undefined,
      }));
      return rows;
    },
  };
}

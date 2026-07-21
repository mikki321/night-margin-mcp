/**
 * Wheelhouse RM API -client. Vain dokumentoidut endpointit ja kentät —
 * varausten vastausmuoto parsitaan adapterissa vasta oikeasta API-vastauksesta.
 */

const DEFAULT_BASE_URL = "https://api.usewheelhouse.com/ss_api/v1";
const CACHE_TTL_MS = 10 * 60_000;
// 429-palautumisen viimeinen porras ylittää koko 60 s -ikkunan → limiitti nollautuu varmasti.
const BACKOFF_MS = [2_000, 5_000, 15_000, 31_000, 61_000];
// Ennakoiva tahdistus ~54 req/min: iso portfolio (esim. 73 kohdetta) ei osu limiittiin lainkaan.
const MIN_INTERVAL_MS = 1_100;

/** Dokumentoidut listing-kentät; muut jätetään huomiotta. */
export interface WhListing {
  id: string | number;
  channel: string;
  wheelhouse_id?: string | number;
  title?: string;
  nickname?: string;
  currency?: string;
  is_active?: boolean;
  number_of_active_units?: number | null;
}

/** price_recommendations: data[]-rivin dokumentoidut kentät. */
export interface WhPriceRec {
  stay_date: string;
  price: number;
  currency?: string;
  min_stay?: number;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

type SleepLike = (ms: number) => Promise<void>;

const realSleep: SleepLike = (ms) => new Promise((r) => setTimeout(r, ms));

/** HTTP-virhe statuskoodilla — adapteri voi esim. ohittaa yksittäisen 404-listauksen. */
export class WheelhouseHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "WheelhouseHttpError";
  }
}

export class WheelhouseClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: SleepLike;
  private readonly cache = new Map<string, { at: number; body: unknown }>();
  private lastRequestAt = 0;

  constructor(opts: { apiKey: string; baseUrl?: string; fetchImpl?: FetchLike; sleepImpl?: SleepLike }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.sleep = opts.sleepImpl ?? realSleep;
  }

  /** GET + auth + 429-backoff + prosessikohtainen cache. Kutsutaan sarjassa, ei fan-outia. */
  private async request(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.body;

    for (let attempt = 0; ; attempt++) {
      const throttle = this.lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (throttle > 0) await this.sleep(throttle);
      this.lastRequestAt = Date.now();

      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(url, { headers: { "X-Integration-Api-Key": this.apiKey } });
      } catch (e) {
        throw new Error(`Wheelhouse connection failed (${url}): ${(e as Error).message}`);
      }

      if (res.status === 429) {
        if (attempt >= BACKOFF_MS.length) {
          throw new Error("Wheelhouse rate limit reached (60 requests/min) — try again in a moment");
        }
        await this.sleep(BACKOFF_MS[attempt]);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new WheelhouseHttpError(
          `Wheelhouse rejected the API key (HTTP ${res.status}) — check WHEELHOUSE_API_KEY`,
          res.status,
        );
      }
      if (!res.ok) {
        throw new WheelhouseHttpError(`Wheelhouse returned HTTP ${res.status} (${url})`, res.status);
      }

      const body = await res.json();
      this.cache.set(url, { at: Date.now(), body });
      return body;
    }
  }

  /** Kaikki listaukset paginoituna (per_page=100 kunnes vajaa sivu). */
  async listListings(): Promise<WhListing[]> {
    const perPage = 100;
    const all: WhListing[] = [];
    for (let page = 1; ; page++) {
      const body = await this.request(`/listings?per_page=${perPage}&page=${page}`);
      const items = Array.isArray(body)
        ? (body as WhListing[])
        : Array.isArray((body as { data?: unknown }).data)
          ? ((body as { data: WhListing[] }).data)
          : null;
      if (!items) {
        throw new Error("Wheelhouse /listings response was not in the expected shape (array or {data: [...]})");
      }
      all.push(...items);
      if (items.length < perPage) return all;
    }
  }

  /** Varaukset RAAKANA — parsinta adapterissa oikean API-vastauksen mukaan. */
  async listReservationsRaw(listingId: string | number, channel: string): Promise<unknown> {
    return this.request(`/listings/${listingId}/reservations?channel=${encodeURIComponent(channel)}`);
  }

  async priceRecommendations(listingId: string | number, channel: string): Promise<WhPriceRec[]> {
    const body = await this.request(
      `/listings/${listingId}/price_recommendations?channel=${encodeURIComponent(channel)}`,
    );
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new Error("Wheelhouse price_recommendations response is missing the data array");
    }
    return data as WhPriceRec[];
  }
}

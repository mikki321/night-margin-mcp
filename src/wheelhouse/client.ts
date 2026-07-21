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

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Custom rate -rivi GET-vastauksessa / PUT-bodyssä (verifioitu oikealla
 * tilillä 22.7. — ks. wh-write-api-spec). Vain dokumentoidut kentät tyypitetty;
 * loput kulkevat läpi tulkitsematta (snapshot/restore käyttää raakaobjektia).
 */
export type WhCustomRate = Record<string, unknown> & {
  start_date?: string;
  end_date?: string;
};

/** Fixed-tyypin custom rate asettaa hinnan viikonpäivittäin — kaikki 7 samaan hintaan. */
export const CUSTOM_RATE_WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

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

  /**
   * HTTP-kutsu + auth + throttle + 429-backoff. Vain GET-vastaukset cachetetaan;
   * kirjoituksia (PUT/DELETE) EI koskaan cacheteta. Kutsutaan sarjassa, ei fan-outia.
   */
  private async request(
    path: string,
    opts: { method?: "GET" | "PUT" | "DELETE"; body?: unknown } = {},
  ): Promise<unknown> {
    const method = opts.method ?? "GET";
    const url = `${this.baseUrl}${path}`;
    if (method === "GET") {
      const cached = this.cache.get(url);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.body;
    }

    for (let attempt = 0; ; attempt++) {
      const throttle = this.lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (throttle > 0) await this.sleep(throttle);
      this.lastRequestAt = Date.now();

      const headers: Record<string, string> = { "X-Integration-Api-Key": this.apiKey };
      const init: { method?: string; headers: Record<string, string>; body?: string } = { headers };
      if (method !== "GET") init.method = method;
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }

      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.fetchImpl(url, init);
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

      // 204 No Content (esim. DELETE custom_rates) — ei bodya parsittavaksi.
      const body = res.status === 204 ? undefined : await res.json();
      if (method === "GET") this.cache.set(url, { at: Date.now(), body });
      return body;
    }
  }

  /** Poistaa listingin custom_rates-GETit cachesta — kutsutaan jokaisen kirjoituksen jälkeen. */
  private invalidateCustomRatesCache(listingId: string | number): void {
    const prefix = `${this.baseUrl}/listings/${listingId}/custom_rates`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
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

  // -------------------------------------------------------------------------
  // Custom rates — muodot verifioitu oikealla tilillä 22.7. (wh-write-api-spec):
  // GET → array, PUT body = {start_date, end_date, rate_type:"fixed", currency,
  // monday..sunday}, DELETE ?start_date&end_date → 204. end_date on
  // eksklusiivinen tyyliin "yksi yö = start+1".
  // -------------------------------------------------------------------------

  /** Listingin nykyiset custom ratet (tyhjä array jos ei yhtään). */
  async getCustomRates(listingId: string | number, channel: string): Promise<WhCustomRate[]> {
    const body = await this.request(
      `/listings/${listingId}/custom_rates?channel=${encodeURIComponent(channel)}`,
    );
    if (!Array.isArray(body)) {
      throw new Error("Wheelhouse custom_rates response was not in the expected shape (array)");
    }
    return body as WhCustomRate[];
  }

  /**
   * Kirjoittaa fixed-hinnan välille [start_date, end_date): kaikki 7 viikonpäivää
   * samaan hintaan (vain rangen päivien viikonpäivillä on merkitystä). Currency
   * annetaan listingistä; ilman sitä "EUR". Kirjoitusta EI cacheteta ja se
   * invalidoi listingin custom_rates-cachen.
   */
  async putCustomRate(
    listingId: string | number,
    channel: string,
    opts: { start_date: string; end_date: string; price: number; currency?: string },
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      start_date: opts.start_date,
      end_date: opts.end_date,
      rate_type: "fixed",
      currency: opts.currency?.trim() || "EUR",
    };
    for (const day of CUSTOM_RATE_WEEKDAYS) body[day] = opts.price;
    return this.putCustomRateBody(listingId, channel, body);
  }

  /**
   * Raaka PUT valmiilla bodylla — revert käyttää tätä snapshotin aiempien
   * custom ratejen palautukseen täsmälleen sellaisinaan.
   */
  async putCustomRateBody(
    listingId: string | number,
    channel: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.request(
        `/listings/${listingId}/custom_rates?channel=${encodeURIComponent(channel)}`,
        { method: "PUT", body },
      );
    } finally {
      // Myös virhetilanteessa: palvelin on voinut ehtiä kirjoittaa.
      this.invalidateCustomRatesCache(listingId);
    }
  }

  /** Poistaa custom ratet väliltä [start_date, end_date) — revert-mekanismi (204). */
  async deleteCustomRates(
    listingId: string | number,
    channel: string,
    start_date: string,
    end_date: string,
  ): Promise<void> {
    try {
      await this.request(
        `/listings/${listingId}/custom_rates?channel=${encodeURIComponent(channel)}` +
          `&start_date=${encodeURIComponent(start_date)}&end_date=${encodeURIComponent(end_date)}`,
        { method: "DELETE" },
      );
    } finally {
      this.invalidateCustomRatesCache(listingId);
    }
  }
}

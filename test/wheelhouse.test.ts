import { describe, expect, it } from "vitest";
import { mockReservationSource, reservationSourceFromEnv } from "../src/sources/reservationSource.js";
import { generateMockReservations } from "../src/sources/mockReservations.js";
import { WheelhouseClient, type FetchLike } from "../src/wheelhouse/client.js";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) });

function clientWith(fetchImpl: FetchLike): WheelhouseClient {
  return new WheelhouseClient({ apiKey: "k", fetchImpl, sleepImpl: async () => {} });
}

describe("reservationSourceFromEnv", () => {
  it("ilman avainta → mock-source", () => {
    const src = reservationSourceFromEnv({} as NodeJS.ProcessEnv);
    expect(src.label).toContain("synteettinen");
  });

  it("avaimella → wheelhouse-source", () => {
    const src = reservationSourceFromEnv({ WHEELHOUSE_API_KEY: "abc" } as NodeJS.ProcessEnv);
    expect(src.label).toContain("Wheelhouse");
  });

  it("mock-source palauttaa samat varaukset kuin generaattori suoraan", async () => {
    const viaSource = await mockReservationSource().getReservations("2026-06-01", "2026-07-01");
    expect(viaSource).toEqual(generateMockReservations("2026-06-01", "2026-07-01"));
  });
});

describe("WheelhouseClient", () => {
  it("lähettää avaimen X-Integration-Api-Key-headerissa", async () => {
    let seenAuth = "";
    const client = clientWith(async (_url, init) => {
      seenAuth = init?.headers?.["X-Integration-Api-Key"] ?? "";
      return ok([]);
    });
    await client.listListings();
    expect(seenAuth).toBe("k");
  });

  it("paginoi kunnes sivu on vajaa", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, channel: "airbnb" }));
    const page2 = [{ id: 100, channel: "airbnb" }];
    const urls: string[] = [];
    const client = clientWith(async (url) => {
      urls.push(url);
      return ok(url.endsWith("page=1") ? page1 : page2);
    });
    const listings = await client.listListings();
    expect(listings).toHaveLength(101);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("page=2");
  });

  it("tukee {data: [...]}-muotoista listings-vastausta", async () => {
    const client = clientWith(async () => ok({ data: [{ id: 1, channel: "vrbo" }] }));
    expect(await client.listListings()).toHaveLength(1);
  });

  it("429 → backoff ja uusi yritys", async () => {
    let calls = 0;
    const client = clientWith(async () => (++calls < 3 ? status(429) : ok([])));
    await client.listListings();
    expect(calls).toBe(3);
  });

  it("429 joka yrityksellä → selkeä rate limit -virhe", async () => {
    const client = clientWith(async () => status(429));
    await expect(client.listListings()).rejects.toThrow(/rate limit/);
  });

  it("401 → neuvoo tarkistamaan avaimen", async () => {
    const client = clientWith(async () => status(401));
    await expect(client.listListings()).rejects.toThrow(/WHEELHOUSE_API_KEY/);
  });

  it("cache: sama pyyntö ei mene verkkoon toista kertaa", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls++;
      return ok([]);
    });
    await client.listListings();
    await client.listListings();
    expect(calls).toBe(1);
  });

  it("price_recommendations palauttaa data-taulukon", async () => {
    const rec = { stay_date: "2026-08-01", price: 129, currency: "EUR", min_stay: 2 };
    const client = clientWith(async () => ok({ data: [rec] }));
    expect(await client.priceRecommendations(1, "airbnb")).toEqual([rec]);
  });
});

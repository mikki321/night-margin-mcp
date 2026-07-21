import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Reservation } from "../src/core/types.js";
import { mockReservationSource, reservationSourceFromEnv } from "../src/sources/reservationSource.js";
import { generateMockReservations } from "../src/sources/mockReservations.js";
import {
  listingFromDocumented,
  parseReservations,
  wheelhouseReservations,
} from "../src/wheelhouse/adapter.js";
import { WheelhouseClient, type FetchLike, type WhListing } from "../src/wheelhouse/client.js";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) });

function clientWith(fetchImpl: FetchLike): WheelhouseClient {
  return new WheelhouseClient({ apiKey: "k", fetchImpl, sleepImpl: async () => {} });
}

describe("reservationSourceFromEnv", () => {
  it("ilman avainta → mock-source", () => {
    const src = reservationSourceFromEnv({} as NodeJS.ProcessEnv);
    expect(src.label).toContain("synthetic");
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

// ---------------------------------------------------------------------------
// WH-adapterin turvakuori (Päätösloki P2). TYÖSÄÄNTÖ 1: näissä testeissä ei
// esiinny yhtään Wheelhouse-VARAUSkentän nimeä — raakadata on läpinäkymätön
// sentinel ja parseri injektoidaan.
// ---------------------------------------------------------------------------

/** Synteettinen varaus OMAN contractimme kentillä (ei WH-kenttiä). */
const resv = (
  id: string,
  property: string,
  checkin: string,
  checkout: string,
): Reservation => ({
  reservation_id: id,
  property_id: property,
  checkin,
  checkout,
  nights: 1,
  gross_revenue: 100,
});

describe("parseReservations (stub)", () => {
  it("heittää: kertoo v0.2.1:stä ja ohjaa demo-dataan tai CSV:hen", () => {
    expect(() => parseReservations({})).toThrow(/v0\.2\.1/);
    expect(() => parseReservations({})).toThrow(/demo data/i);
    expect(() => parseReservations({})).toThrow(/WHEELHOUSE_API_KEY/);
    expect(() => parseReservations({})).toThrow(/README/);
  });
});

describe("listingFromDocumented", () => {
  it("nickname → title → id -järjestys", () => {
    expect(
      listingFromDocumented({ id: 7, channel: "airbnb", nickname: "Aurora Cabin", title: "T" }),
    ).toBe("Aurora Cabin");
    expect(listingFromDocumented({ id: 7, channel: "airbnb", title: "Downtown Loft" })).toBe(
      "Downtown Loft",
    );
    expect(listingFromDocumented({ id: 7, channel: "airbnb" })).toBe("7");
  });

  it("tyhjä/whitespace-nickname putoaa titleen", () => {
    expect(
      listingFromDocumented({ id: 7, channel: "airbnb", nickname: "  ", title: "Downtown Loft" }),
    ).toBe("Downtown Loft");
  });
});

describe("wheelhouseReservations-putki", () => {
  const listings: WhListing[] = [
    { id: 1, channel: "airbnb", nickname: "Alpha" },
    { id: 2, channel: "vrbo", is_active: false },
    { id: 3, channel: "airbnb", title: "Gamma", is_active: true },
  ];

  /** Fake-client: listings-sivu + läpinäkymätön sentinel-raaka per listing. */
  function pipelineClient() {
    const urls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const client = clientWith(async (url) => {
      urls.push(url);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      if (url.includes("/reservations")) {
        const id = url.match(/listings\/(\d+)\//)![1];
        return ok(`RAW_PAYLOAD_${id}`);
      }
      return ok(listings);
    });
    return { client, urls, max: () => maxInFlight };
  }

  it("hakee listaukset, suodattaa inaktiiviset, kutsuu raw-haut sarjassa ja syöttää raa'an datan parserille sellaisenaan", async () => {
    const { client, urls, max } = pipelineClient();
    const rawSeen: unknown[] = [];
    const src = wheelhouseReservations(client, (raw) => {
      rawSeen.push(raw);
      return [];
    });

    await src.getReservations("2026-06-01", "2026-07-01");

    const resUrls = urls.filter((u) => u.includes("/reservations"));
    expect(resUrls).toHaveLength(2); // inaktiivinen id=2 suodattui
    expect(resUrls[0]).toContain("/listings/1/reservations?channel=airbnb");
    expect(resUrls[1]).toContain("/listings/3/reservations?channel=airbnb");
    expect(rawSeen).toEqual(["RAW_PAYLOAD_1", "RAW_PAYLOAD_3"]); // pass-through, ei tulkintaa
    expect(max()).toBe(1); // sarjassa, ei fan-outia
  });

  it("leikkaa jaksolle [from, to): ikkunaa leikkaavat mukaan, rajatapaukset ulos", async () => {
    const { client } = pipelineClient();
    const perListing: Reservation[][] = [
      [
        resv("in-full", "p1", "2026-06-05", "2026-06-08"),
        resv("out-before", "p1", "2026-05-01", "2026-05-04"),
        resv("out-checkout-eq-from", "p1", "2026-05-28", "2026-06-01"),
      ],
      [
        resv("in-overlap-end", "p3", "2026-06-28", "2026-07-02"),
        resv("out-checkin-eq-to", "p3", "2026-07-01", "2026-07-04"),
      ],
    ];
    let call = 0;
    const src = wheelhouseReservations(client, () => perListing[call++]);

    const got = await src.getReservations("2026-06-01", "2026-07-01");
    expect(got.map((r) => r.reservation_id)).toEqual(["in-full", "in-overlap-end"]);
  });

  it("oletusparserilla stub-virhe nousee kutsujalle asti — EI hiljaista mock-fallbackia", async () => {
    const { client } = pipelineClient();
    const src = wheelhouseReservations(client);
    await expect(src.getReservations("2026-06-01", "2026-07-01")).rejects.toThrow(/v0\.2\.1/);
  });

  it("label kertoo rehellisesti tilanteen", () => {
    const { client } = pipelineClient();
    const src = wheelhouseReservations(client);
    expect(src.label).toContain("Wheelhouse");
    expect(src.label).toContain("v0.2.1");
  });
});

// ---------------------------------------------------------------------------
// Fixture-portitetut testit: aktivoituvat automaattisesti kun Mikin redaktoima
// curl #2 -vastaus ilmestyy (ks. test/fixtures/README.md). Siihen asti skip.
// Asserit käyttävät VAIN oman Reservation-contractimme kenttiä.
// ---------------------------------------------------------------------------

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "wh-reservations.json",
);
const fixtureExists = existsSync(FIXTURE_PATH);

describe.skipIf(!fixtureExists)("parseReservations oikealla (redaktoidulla) fixtuurilla", () => {
  it("parsii fixtuurin Reservation-contractin mukaisiksi riveiksi", () => {
    const raw: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const reservations = parseReservations(raw);

    expect(Array.isArray(reservations)).toBe(true);
    expect(reservations.length).toBeGreaterThan(0);
    for (const r of reservations) {
      expect(typeof r.reservation_id).toBe("string");
      expect(r.reservation_id.length).toBeGreaterThan(0);
      expect(typeof r.property_id).toBe("string");
      expect(r.checkin).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.checkout).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.checkin < r.checkout).toBe(true);
      expect(Number.isFinite(r.nights)).toBe(true);
      expect(r.nights).toBeGreaterThan(0);
      expect(Number.isFinite(r.gross_revenue)).toBe(true);
    }
  });
});

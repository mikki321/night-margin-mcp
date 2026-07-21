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
// WH-adapterin putkitestit (Päätösloki P2). Putkitesteissä raakadata on
// läpinäkymätön sentinel ja parseri injektoidaan; parserin omat testit ajavat
// synteettistä fixtuuria joka noudattaa OIKEAA curl #2 -skeemaa (työsääntö 1
// täyttyy — ks. src/wheelhouse/adapter.ts:n alkukommentti).
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

describe("parseReservations: ei-array-syöte", () => {
  it("objekti/merkkijono/null → selkeä virhe saadulla tyypillä", () => {
    expect(() => parseReservations({})).toThrow(/expected a JSON array.*got object/);
    expect(() => parseReservations("RAW")).toThrow(/expected a JSON array.*got string/);
    expect(() => parseReservations(null)).toThrow(/expected a JSON array.*got null/);
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
    const src = wheelhouseReservations(client, {
      parse: (raw) => {
        rawSeen.push(raw);
        return [];
      },
    });

    await src.getReservations("2026-06-01", "2026-07-01");

    const resUrls = urls.filter((u) => u.includes("/reservations"));
    expect(resUrls).toHaveLength(2); // inaktiivinen id=2 suodattui
    // kanava = LISTINGIN OMA channel-kenttä per listing (22.7. spec)
    expect(resUrls[0]).toContain("/listings/1/reservations?channel=airbnb");
    expect(resUrls[1]).toContain("/listings/3/reservations?channel=airbnb");
    expect(rawSeen).toEqual(["RAW_PAYLOAD_1", "RAW_PAYLOAD_3"]); // pass-through, ei tulkintaa
    expect(max()).toBe(1); // sarjassa, ei fan-outia
  });

  it("kanavan voi yliajaa (env WHEELHOUSE_CHANNEL → opts.channel)", async () => {
    const { client, urls } = pipelineClient();
    const src = wheelhouseReservations(client, { channel: "examplepms", parse: () => [] });
    await src.getReservations("2026-06-01", "2026-07-01");
    const resUrls = urls.filter((u) => u.includes("/reservations"));
    expect(resUrls[0]).toContain("channel=examplepms");
  });

  it("asettaa property_id:n listingin nimestä (nickname → title → id)", async () => {
    const { client } = pipelineClient();
    const src = wheelhouseReservations(client, {
      parse: () => [resv("r1", "", "2026-06-05", "2026-06-08")],
    });
    const got = await src.getReservations("2026-06-01", "2026-07-01");
    expect(got.map((r) => r.property_id)).toEqual(["Alpha", "Gamma"]);
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
    const src = wheelhouseReservations(client, { parse: () => perListing[call++] });

    const got = await src.getReservations("2026-06-01", "2026-07-01");
    expect(got.map((r) => r.reservation_id)).toEqual(["in-full", "in-overlap-end"]);
  });

  it("oletusparserilla validointivirhe nousee kutsujalle asti — EI hiljaista mock-fallbackia", async () => {
    const { client } = pipelineClient();
    const src = wheelhouseReservations(client); // sentinel-raaka on merkkijono, ei array
    await expect(src.getReservations("2026-06-01", "2026-07-01")).rejects.toThrow(
      /expected a JSON array/,
    );
  });

  it("label kertoo datalähteen rehellisesti", () => {
    const { client } = pipelineClient();
    const src = wheelhouseReservations(client);
    expect(src.label).toContain("Wheelhouse RM API (live)");
    expect(src.label).not.toContain("v0.2.1");
  });
});

// ---------------------------------------------------------------------------
// Fixture-testit: synteettinen fixtuuri noudattaa täsmälleen oikean curl #2
// -vastauksen skeemaa (ei oikeita arvoja). Asserit käyttävät VAIN oman
// Reservation-contractimme kenttiä + fixtuurin synteettisiä arvoja.
// ---------------------------------------------------------------------------

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "wh-reservations.json",
);
const fixtureExists = existsSync(FIXTURE_PATH);

/** Fixtuuri on rivitaulukko; kopio per testi ettei rikkominen vuoda muihin. */
function loadFixture(): Record<string, unknown>[] {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>[];
}

describe.skipIf(!fixtureExists)("parseReservations fixtuurilla (curl #2 -skeema)", () => {
  it("parsii täsmälleen 3 Accepted-varausta ja pudottaa ei-Accepted-rivin hiljaa", () => {
    const reservations = parseReservations(loadFixture());
    expect(reservations.map((r) => r.reservation_id)).toEqual([
      "10000001",
      "10000002",
      "10000004",
    ]);
    // SyntheticNotAccepted (10000003) ei ole mukana
    expect(reservations.some((r) => r.reservation_id === "10000003")).toBe(false);
  });

  it("täyttää Reservation-contractin kentät jokaiselle riville", () => {
    for (const r of parseReservations(loadFixture())) {
      expect(typeof r.reservation_id).toBe("string");
      expect(r.reservation_id.length).toBeGreaterThan(0);
      expect(typeof r.property_id).toBe("string"); // putki täyttää nimen; parserilta ""
      expect(r.checkin).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.checkout).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.checkin < r.checkout).toBe(true);
      expect(Number.isFinite(r.nights)).toBe(true);
      expect(r.nights).toBeGreaterThan(0);
      expect(Number.isFinite(r.gross_revenue)).toBe(true);
    }
  });

  it("checkin=start_date, checkout=end_date ja nights=päiväero", () => {
    const byId = new Map(parseReservations(loadFixture()).map((r) => [r.reservation_id, r]));
    expect(byId.get("10000001")).toMatchObject({
      checkin: "2026-06-03",
      checkout: "2026-06-06",
      nights: 3,
    });
    expect(byId.get("10000002")!.nights).toBe(1);
    // kuunvaihteen yli: 2026-06-28 → 2026-07-03
    expect(byId.get("10000004")!.nights).toBe(5);
  });

  it("gross_revenue = total_price − taxes − security_deposit (10000004 → 700)", () => {
    const byId = new Map(parseReservations(loadFixture()).map((r) => [r.reservation_id, r]));
    expect(byId.get("10000004")!.gross_revenue).toBe(700); // 780 − 30 − 50
    expect(byId.get("10000001")!.gross_revenue).toBe(330); // 360 − 30 − 0
    expect(byId.get("10000002")!.gross_revenue).toBe(95); // 95 − 0 − 0
  });

  it("confirmation_code: null → kenttä pois; merkkijono → mukaan", () => {
    const byId = new Map(parseReservations(loadFixture()).map((r) => [r.reservation_id, r]));
    expect(byId.get("10000001")!.confirmation_code).toBe("SYNTH0001A");
    expect(byId.get("10000002")!.confirmation_code).toBeUndefined();
    expect("confirmation_code" in byId.get("10000002")!).toBe(false);
  });

  it("viallinen rivi → virhe kentän nimellä, tyypillä ja indeksillä — EI arvolla", () => {
    const missingId = loadFixture();
    delete missingId[0].id;
    expect(() => parseReservations(missingId)).toThrow(
      /index 0.*field "id" must be a non-empty string, got undefined/,
    );

    const badPrice = loadFixture();
    badPrice[1].total_price = "SYNTH_LEAK_CANARY";
    try {
      parseReservations(badPrice);
      expect.unreachable("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/index 1.*field "total_price" must be a finite number, got string/);
      expect(msg).not.toContain("SYNTH_LEAK_CANARY"); // arvo ei saa vuotaa virheeseen
    }

    const badDate = loadFixture();
    badDate[0].start_date = "03.06.2026";
    expect(() => parseReservations(badDate)).toThrow(
      /index 0.*field "start_date" must be a YYYY-MM-DD date string/,
    );

    const reversedDates = loadFixture();
    reversedDates[0].end_date = "2026-06-01"; // ennen start_datea 2026-06-03
    expect(() => parseReservations(reversedDates)).toThrow(
      /index 0.*"end_date" must be a date after "start_date"/,
    );

    const badCode = loadFixture();
    badCode[0].confirmation_code = 12345;
    expect(() => parseReservations(badCode)).toThrow(
      /index 0.*field "confirmation_code" must be a string or null, got number/,
    );

    const badRow = loadFixture() as unknown[];
    badRow[2] = "not-an-object";
    expect(() => parseReservations(badRow)).toThrow(/index 2.*expected an object, got string/);
  });

  it("viallinen EI-Accepted-rivi pudotetaan silti hiljaa (status tarkistetaan ensin)", () => {
    const fixture = loadFixture();
    const dropped = fixture.find((row) => row.status !== "Accepted")!;
    delete dropped.total_price; // rikki, mutta rivi ei koskaan päädy validointiin
    expect(parseReservations(fixture)).toHaveLength(3);
  });

  it("putki päästä päähän: property_id listingin nimestä, channel listingin omasta kentästä", async () => {
    const fixtureBody = loadFixture();
    const urls: string[] = [];
    const client = clientWith(async (url) => {
      urls.push(url);
      if (url.includes("/reservations")) return ok(fixtureBody);
      return ok([{ id: 570099, channel: "examplepms", nickname: "Aurora Cabin" }]);
    });
    const src = wheelhouseReservations(client);

    const got = await src.getReservations("2026-06-01", "2026-07-01");

    expect(urls.some((u) => u.includes("channel=examplepms"))).toBe(true);
    expect(got).toHaveLength(3); // 10000004 leikkaa ikkunaa → mukana
    expect(new Set(got.map((r) => r.property_id))).toEqual(new Set(["Aurora Cabin"]));
  });
});

import { describe, expect, it } from "vitest";
import { channelForListing } from "../src/wheelhouse/adapter.js";
import { WheelhouseClient, type FetchLike } from "../src/wheelhouse/client.js";

/**
 * WRITE-API:n client-testit — payload-muodot vastaavat TÄSMÄLLEEN 22.7.
 * oikealla tilillä verifioitua spexiä (wh-write-api-spec). EI verkkoa:
 * fake-fetch kaappaa kutsut.
 */

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const noContent = () => ({
  ok: true,
  status: 204,
  // 204:llä ei ole bodya — json() heittää kuten oikea fetch tekisi.
  json: async (): Promise<unknown> => {
    throw new Error("204 has no body");
  },
});

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function clientWith(fetchImpl: FetchLike): WheelhouseClient {
  return new WheelhouseClient({ apiKey: "k", fetchImpl, sleepImpl: async () => {} });
}

function capturingClient(respond: (c: Captured) => ReturnType<FetchLike>) {
  const calls: Captured[] = [];
  const client = clientWith(async (url, init) => {
    const call: Captured = {
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    };
    calls.push(call);
    return respond(call);
  });
  return { client, calls };
}

describe("putCustomRate — payload täsmälleen spexin muodossa", () => {
  it("body = start/end + rate_type fixed + currency + KAIKKI 7 viikonpäivää samaan hintaan", async () => {
    const { client, calls } = capturingClient(async () => ok({}));
    await client.putCustomRate(64419961, "hypothetical", {
      start_date: "2026-12-15",
      end_date: "2026-12-16",
      price: 110,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/listings/64419961/custom_rates?channel=hypothetical");
    expect(calls[0].headers["X-Integration-Api-Key"]).toBe("k");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    // TÄSMÄLLEEN spexin body — ei ylimääräisiä avaimia, kaikki 7 päivää.
    expect(JSON.parse(calls[0].body!)).toEqual({
      start_date: "2026-12-15",
      end_date: "2026-12-16",
      rate_type: "fixed",
      currency: "EUR",
      monday: 110,
      tuesday: 110,
      wednesday: 110,
      thursday: 110,
      friday: 110,
      saturday: 110,
      sunday: 110,
    });
  });

  it("currency listingistä kulkee läpi; puuttuva/tyhjä → EUR", async () => {
    const { client, calls } = capturingClient(async () => ok({}));
    await client.putCustomRate(1, "hostaway", {
      start_date: "2026-08-01",
      end_date: "2026-08-03",
      price: 95,
      currency: "USD",
    });
    await client.putCustomRate(1, "hostaway", {
      start_date: "2026-08-03",
      end_date: "2026-08-04",
      price: 95,
      currency: "  ",
    });
    expect(JSON.parse(calls[0].body!).currency).toBe("USD");
    expect(JSON.parse(calls[1].body!).currency).toBe("EUR");
  });

  it("putCustomRateBody lähettää annetun bodyn sellaisenaan (revertin palautuspolku)", async () => {
    const { client, calls } = capturingClient(async () => ok({}));
    const body = {
      start_date: "2026-08-01",
      end_date: "2026-08-02",
      rate_type: "fixed",
      currency: "EUR",
      monday: 80,
      tuesday: 81,
      wednesday: 82,
      thursday: 83,
      friday: 84,
      saturday: 85,
      sunday: 86,
    };
    await client.putCustomRateBody(7, "hostaway", body);
    expect(JSON.parse(calls[0].body!)).toEqual(body);
  });
});

describe("deleteCustomRates", () => {
  it("DELETE oikealla URL:llä (channel + start_date + end_date) ja 204 ilman body-parsintaa", async () => {
    const { client, calls } = capturingClient(async () => noContent());
    await client.deleteCustomRates(64419961, "hypothetical", "2026-12-15", "2026-12-16");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toContain(
      "/listings/64419961/custom_rates?channel=hypothetical&start_date=2026-12-15&end_date=2026-12-16",
    );
    expect(calls[0].body).toBeUndefined();
  });
});

describe("getCustomRates", () => {
  it("palauttaa arrayn; ei-array → selkeä virhe", async () => {
    const rate = { start_date: "2026-12-15", end_date: "2026-12-16", rate_type: "fixed" };
    const { client } = capturingClient(async () => ok([rate]));
    expect(await client.getCustomRates(1, "hostaway")).toEqual([rate]);

    const bad = capturingClient(async () => ok({ nope: true }));
    await expect(bad.client.getCustomRates(1, "hostaway")).rejects.toThrow(/expected shape \(array\)/);
  });
});

describe("cache-käytös kirjoituksissa", () => {
  it("GET custom_rates cachetetaan; PUT invalidoi listingin custom_rates-cachen", async () => {
    const { client, calls } = capturingClient(async (c) =>
      c.method === "PUT" ? ok({}) : ok([]),
    );
    await client.getCustomRates(5, "hostaway");
    await client.getCustomRates(5, "hostaway"); // cache-osuma
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);

    await client.putCustomRate(5, "hostaway", {
      start_date: "2026-08-01",
      end_date: "2026-08-02",
      price: 95,
    });
    await client.getCustomRates(5, "hostaway"); // cache invalidoitu → verkkoon
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("DELETE invalidoi cachen; kirjoituksia EI cacheteta (kaksi PUTia → kaksi kutsua)", async () => {
    const { client, calls } = capturingClient(async (c) => {
      if (c.method === "DELETE") return noContent();
      return c.method === "PUT" ? ok({}) : ok([]);
    });
    await client.getCustomRates(5, "hostaway");
    await client.deleteCustomRates(5, "hostaway", "2026-08-01", "2026-08-02");
    await client.getCustomRates(5, "hostaway");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);

    const putOpts = { start_date: "2026-08-01", end_date: "2026-08-02", price: 95 };
    await client.putCustomRate(5, "hostaway", putOpts);
    await client.putCustomRate(5, "hostaway", putOpts);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("PUT-invalidointi EI koske muiden listausten cachea", async () => {
    const { client, calls } = capturingClient(async (c) =>
      c.method === "PUT" ? ok({}) : ok([]),
    );
    await client.getCustomRates(5, "hostaway");
    await client.getCustomRates(6, "hostaway");
    await client.putCustomRate(5, "hostaway", {
      start_date: "2026-08-01",
      end_date: "2026-08-02",
      price: 95,
    });
    await client.getCustomRates(6, "hostaway"); // yhä cachessa
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });
});

describe("channelForListing", () => {
  it("yliajo voittaa; muuten listingin oma channel; tyhjä → hostaway-fallback", () => {
    expect(channelForListing({ id: 1, channel: "hypothetical" }, "override")).toBe("override");
    expect(channelForListing({ id: 1, channel: "hypothetical" })).toBe("hypothetical");
    expect(channelForListing({ id: 1, channel: "" })).toBe("hostaway");
    expect(channelForListing({ id: 1, channel: "hypothetical" }, "  ")).toBe("hypothetical");
  });
});

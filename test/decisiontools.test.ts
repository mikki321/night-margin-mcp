import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Decision, readDecisions, writeDecisions } from "../src/state.js";
import { buildRatePayload, runApplyDecision } from "../src/tools/applyDecision.js";
import { proposeWindow, runProposeDecisions } from "../src/tools/proposeDecisions.js";
import { restoreBodyFromSnapshot, runRevertDecision } from "../src/tools/revertDecision.js";
import { WheelhouseClient, type FetchLike } from "../src/wheelhouse/client.js";

/**
 * Päätössilmukan tool-testit — EI verkkoa: fake-client + tmp-statedir.
 * Fake-WH:n varausdata noudattaa oikeaa curl #2 -skeemaa synteettisin arvoin
 * (työsääntö 1: skeema verifioitu, arvot keksittyjä).
 */

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nm-tools-test-"));
  env = { NM_STATE_DIR: dir } as NodeJS.ProcessEnv;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-06-01T12:00:00Z"); // determinismi: mock-kalenteri kattaa 2026

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const noContent = () => ({
  ok: true,
  status: 204,
  json: async (): Promise<unknown> => {
    throw new Error("204 has no body");
  },
});
const httpStatus = (code: number) => ({ ok: false, status: code, json: async () => ({}) });

function clientWith(fetchImpl: FetchLike): WheelhouseClient {
  return new WheelhouseClient({ apiKey: "test-key", fetchImpl, sleepImpl: async () => {} });
}

/** Synteettinen listing + varaus (curl #2 -skeema) + suositukset + stateful custom_rates -varasto. */
function fakeWheelhouse(
  opts: {
    priorRates?: Record<string, unknown>[];
    failPut?: boolean;
    /** Kaada VAIN n:s custom_rates-PUT (1-alkuinen) — osittaisen kirjoitusvirheen simulointi. */
    failPutOnCall?: number;
    /** Yliaja hintasuositukset (oletus: 50 € kaikille kolmelle aukkoyölle). */
    priceRecs?: { stay_date: string; price: number; currency: string }[];
  } = {},
) {
  const listings = [{ id: 11, channel: "hypothetical", nickname: "Test Cabin", currency: "EUR" }];
  const rawReservations = [
    {
      id: "20000001",
      status: "Accepted",
      start_date: "2026-06-01",
      end_date: "2026-06-28",
      total_price: 2700,
      taxes: 0,
      security_deposit: 0,
      confirmation_code: null,
    },
  ];
  // aukot 2026-06-28..30; suositus 50 < lattia 95 (manual 70 + 0 + marginaali 25)
  const priceRecs = {
    data: opts.priceRecs ?? [
      { stay_date: "2026-06-28", price: 50, currency: "EUR" },
      { stay_date: "2026-06-29", price: 50, currency: "EUR" },
      { stay_date: "2026-06-30", price: 50, currency: "EUR" },
    ],
  };
  const store: Record<string, unknown>[] = [...(opts.priorRates ?? [])];
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let putCount = 0;

  const client = clientWith(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
    const u = new URL(url);
    if (method === "GET" && u.pathname.endsWith("/listings")) return ok(listings);
    if (method === "GET" && u.pathname.includes("/reservations")) return ok(rawReservations);
    if (method === "GET" && u.pathname.includes("/price_recommendations")) return ok(priceRecs);
    if (u.pathname.includes("/custom_rates")) {
      if (method === "GET") return ok([...store]);
      if (method === "PUT") {
        putCount++;
        if (opts.failPut || putCount === opts.failPutOnCall) return httpStatus(500);
        const body = JSON.parse(init!.body!) as Record<string, unknown>;
        const idx = store.findIndex(
          (r) => r.start_date === body.start_date && r.end_date === body.end_date,
        );
        const stored = { ...body, expires_at: null };
        if (idx >= 0) store[idx] = stored;
        else store.push(stored);
        return ok(stored);
      }
      if (method === "DELETE") {
        const start = u.searchParams.get("start_date")!;
        const end = u.searchParams.get("end_date")!;
        for (let i = store.length - 1; i >= 0; i--) {
          const r = store[i] as { start_date: string; end_date: string };
          if (r.start_date < end && r.end_date > start) store.splice(i, 1);
        }
        return noContent();
      }
    }
    throw new Error(`fake wheelhouse: unhandled ${method} ${url}`);
  });
  return { client, store, calls };
}

const whEnv = () => ({ ...env, WHEELHOUSE_API_KEY: "test-key" }) as NodeJS.ProcessEnv;

describe("proposeWindow", () => {
  it("oletus: tänään → tänään + 30 pv", () => {
    expect(proposeWindow(undefined, undefined, NOW)).toEqual({
      from: "2026-06-01",
      to: "2026-07-01",
      isDefault: true,
    });
  });

  it("vain toinen annettu → täydennys 30 pv:n säännöllä", () => {
    expect(proposeWindow("2026-08-01", undefined, NOW)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
      isDefault: false,
    });
    expect(proposeWindow(undefined, "2026-08-31", NOW)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
      isDefault: false,
    });
  });
});

describe("propose_decisions — mock-tila (ei avainta, ei verkkoa)", () => {
  it("generoi ehdotuksia demodatasta, tallentaa proposed-rivit ja ohjeistaa applyyn", async () => {
    // korkea manual-kustannus takaa: lattia (225) > jokaisen kohteen ADR → ehdotuksia syntyy
    const e = { ...env, AVG_TURNOVER_COST: "200" } as NodeJS.ProcessEnv;
    const out = await runProposeDecisions({}, e, { now: NOW });

    expect(out).toContain("## Pricing decision proposals");
    expect(out).toContain("Window: 2026-06-01 → 2026-07-01 (default: next 30 days");
    expect(out).toContain("demo estimate");
    expect(out).toMatch(/Apply with: apply_decision \{"decision_id": "d1", "confirm": true\}/);

    const decisions = readDecisions(e);
    expect(decisions.length).toBeGreaterThan(0);
    for (const [i, d] of decisions.entries()) {
      expect(d.id).toBe(`d${i + 1}`);
      expect(d.status).toBe("proposed");
      expect(d.type).toBe("gap_floor");
      expect(d.channel).toBe("mock");
      expect(d.listing_id).toBe("mock");
      expect(d.floor_price).toBe(225);
      expect(d.dates.length).toBe(d.expected.protected_nights);
    }
  });

  it("uusi ajo samalle ikkunalle korvaa vanhat proposed-rivit eikä uudelleenkäytä id:itä", async () => {
    const e = { ...env, AVG_TURNOVER_COST: "200" } as NodeJS.ProcessEnv;
    await runProposeDecisions({}, e, { now: NOW });
    const first = readDecisions(e);
    await runProposeDecisions({}, e, { now: NOW });
    const second = readDecisions(e);

    expect(second).toHaveLength(first.length); // korvattu, ei duplikoitu
    const firstMax = Math.max(...first.map((d) => Number(d.id.slice(1))));
    for (const d of second) {
      expect(Number(d.id.slice(1))).toBeGreaterThan(firstMax);
    }
  });

  it("kokonaan mennyt ikkuna → selkeä viesti, ei tallennuksia", async () => {
    const out = await runProposeDecisions({ from: "2026-01-01", to: "2026-02-01" }, env, { now: NOW });
    expect(out).toContain("entirely in the past");
    expect(readDecisions(env)).toEqual([]);
  });

  it("mennyt alku clampataan tähän päivään ja se kerrotaan", async () => {
    const e = { ...env, AVG_TURNOVER_COST: "200" } as NodeJS.ProcessEnv;
    const out = await runProposeDecisions({ from: "2026-05-01", to: "2026-06-15" }, e, { now: NOW });
    expect(out).toContain("start clamped from 2026-05-01 to today");
    expect(out).toContain("Window: 2026-06-01 → 2026-06-15");
  });
});

describe("propose_decisions — WH-tila (fake-client)", () => {
  it("hakee suositukset listingin omalla kanavalla ja tallentaa listing-tiedot päätökseen", async () => {
    const { client, calls } = fakeWheelhouse();
    const e = whEnv();
    const out = await runProposeDecisions({}, e, { now: NOW, client });

    expect(out).toContain("Wheelhouse price recommendations");
    expect(out).toContain("Test Cabin");
    // suositushaku listingin omalla kanavalla (hypothetical), ei kovakoodattua
    expect(
      calls.some((c) => c.url.includes("/price_recommendations?channel=hypothetical")),
    ).toBe(true);

    const decisions = readDecisions(e);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      id: "d1",
      property_id: "Test Cabin",
      listing_id: 11,
      channel: "hypothetical",
      currency: "EUR",
      dates: ["2026-06-28", "2026-06-29", "2026-06-30"],
      floor_price: 95,
      wh_recommended_price: 50,
      expected: { protected_nights: 3, floor_vs_rec_delta: 135 },
      status: "proposed",
    });
  });

  it("ei ehdotuksia + osalta öistä puuttuu hinta → viesti erottelee hinnalliset (M) kaikista (N)", async () => {
    // Vain 2/3 aukkoyölle on hintadata, molemmat ≥ lattia 95 → ei ehdotuksia,
    // mutta viesti EI saa väittää että kaikki 3 yötä olisi verrattu.
    const { client } = fakeWheelhouse({
      priceRecs: [
        { stay_date: "2026-06-28", price: 200, currency: "EUR" },
        { stay_date: "2026-06-29", price: 200, currency: "EUR" },
      ],
    });
    const out = await runProposeDecisions({}, whEnv(), { now: NOW, client });

    expect(out).toContain("No proposals — all 2 priced gap nights (of 3) are at or above the cost floor");
    expect(out).toContain("the remaining 1 has no price data and was not compared");
  });

  it("WHEELHOUSE_CHANNEL-yliajo EI vuoda kirjoituskanavaan — päätös saa listingin oman kanavan", async () => {
    const { client, calls } = fakeWheelhouse();
    // .env.example-tyylinen yliajo joka eroaa listingin omasta kanavasta (hypothetical)
    const e = { ...whEnv(), WHEELHOUSE_CHANNEL: "hostaway" } as NodeJS.ProcessEnv;
    await runProposeDecisions({}, e, { now: NOW, client });

    // luvut saavat käyttää yliajoa (22.7.-spec) …
    expect(
      calls.some((c) => c.url.includes("/price_recommendations?channel=hostaway")),
    ).toBe(true);
    // … mutta kirjoituskanava = listingin OMA channel-kenttä (turvasääntö 5)
    const d = readDecisions(e)[0];
    expect(d.channel).toBe("hypothetical");
    expect(d.channel).not.toBe("hostaway");
  });
});

/** Seed: sovellettava WH-päätös suoraan lokiin (fokusoidut apply/revert-testit). */
function seedDecision(e: NodeJS.ProcessEnv, overrides: Partial<Decision> = {}): Decision {
  const d: Decision = {
    id: "d1",
    created_at: "2026-06-01T00:00:00.000Z",
    type: "gap_floor",
    property_id: "Test Cabin",
    listing_id: 11,
    channel: "hypothetical",
    currency: "EUR",
    dates: ["2026-06-28", "2026-06-29", "2026-06-30"],
    floor_price: 95,
    wh_recommended_price: 50,
    expected: { protected_nights: 3, floor_vs_rec_delta: 135 },
    status: "proposed",
    ...overrides,
  };
  writeDecisions([d], e);
  return d;
}

describe("apply_decision — dry run ja turvasäännöt", () => {
  it("ilman confirmia → dry run: TARKKA payload näkyvissä, mitään ei kirjoiteta", async () => {
    const e = whEnv();
    seedDecision(e);
    const out = await runApplyDecision({ decision_id: "d1" }, e); // ei clientiä → verkkoa ei saa tarvita

    expect(out).toContain("## Dry run — decision d1 (nothing written)");
    expect(out).toContain("PUT /listings/11/custom_rates?channel=hypothetical");
    // payload täsmälleen spexin muoto — kaikki 7 viikonpäivää
    const payload = JSON.parse(out.slice(out.indexOf("{"), out.indexOf("}") + 1));
    expect(payload).toEqual({
      start_date: "2026-06-28",
      end_date: "2026-07-01",
      rate_type: "fixed",
      currency: "EUR",
      monday: 95,
      tuesday: 95,
      wednesday: 95,
      thursday: 95,
      friday: 95,
      saturday: 95,
      sunday: 95,
    });
    expect(out).toContain('apply_decision {"decision_id": "d1", "confirm": true}');
    expect(readDecisions(e)[0].status).toBe("proposed"); // ei muutosta
  });

  it("dry_run=true voittaa vaikka confirm=true", async () => {
    const e = whEnv();
    seedDecision(e);
    const out = await runApplyDecision({ decision_id: "d1", confirm: true, dry_run: true }, e);
    expect(out).toContain("nothing written");
    expect(readDecisions(e)[0].status).toBe("proposed");
  });

  it("mock-tila (ei avainta, ei clientiä): apply ilman confirmia → dry-run payload, EI avainvirhettä", async () => {
    // Tuomarien demopolku: propose mock-tilassa → proposen ohjeistama esikatselu.
    const e = { ...env, AVG_TURNOVER_COST: "200" } as NodeJS.ProcessEnv; // ei WHEELHOUSE_API_KEYtä
    await runProposeDecisions({}, e, { now: NOW });

    const out = await runApplyDecision({ decision_id: "d1" }, e); // ei clientiä → verkkoa ei saa tarvita

    expect(out).toContain("## Dry run — decision d1 (nothing written)");
    expect(out).toContain("PUT /listings/mock/custom_rates?channel=mock");
    expect(out).toContain('"rate_type": "fixed"');
    // demo-huomautus: oikea sovellus vaatii avaimen + uuden proposen
    expect(out).toContain("requires WHEELHOUSE_API_KEY");
    expect(readDecisions(e)[0].status).toBe("proposed"); // mitään ei kirjoitettu
  });

  it("dry run osittaisen kirjoituksen retry-tilassa listaa jo kirjoitetut ranget eikä väitä ettei mitään ole kirjoitettu", async () => {
    const e = whEnv();
    // kaksi EI-peräkkäistä yötä → kaksi rangea; 1. range ehti kirjautua aiemmalla yrityksellä
    seedDecision(e, {
      dates: ["2026-06-28", "2026-06-30"],
      applied_ranges: [{ start_date: "2026-06-28", end_date: "2026-06-29" }],
    });
    const out = await runApplyDecision({ decision_id: "d1" }, e); // ei clientiä → ei verkkoa

    expect(out).not.toContain("Nothing has been written");
    expect(out).toContain("## Dry run — decision d1 (this preview writes nothing)");
    expect(out).toContain(
      "a previous apply attempt already wrote 1 of 2 ranges: 2026-06-28 → 2026-06-29",
    );
    expect(out).toContain('revert_decision {"decision_id": "d1", "confirm": true}');
    expect(out).toContain('To execute: apply_decision {"decision_id": "d1", "confirm": true}');
    expect(readDecisions(e)[0].status).toBe("proposed"); // esikatselu ei muuta mitään
  });

  it("ilman avainta → selkeä virhe WHEELHOUSE_API_KEYstä", async () => {
    seedDecision(env);
    await expect(runApplyDecision({ decision_id: "d1", confirm: true }, env)).rejects.toThrow(
      /requires WHEELHOUSE_API_KEY/,
    );
  });

  it("mock-datasta ehdotettu päätös → virhe joka ohjaa uuteen proposeen", async () => {
    const e = whEnv();
    seedDecision(e, { channel: "mock", listing_id: "mock" });
    await expect(runApplyDecision({ decision_id: "d1", confirm: true }, e)).rejects.toThrow(
      /demo data.*Set WHEELHOUSE_API_KEY/s,
    );
  });

  it("tuntematon decision_id → virhe joka listaa ehdotetut", async () => {
    const e = whEnv();
    seedDecision(e);
    await expect(runApplyDecision({ decision_id: "d9" }, e)).rejects.toThrow(
      /Decision "d9" not found.*Currently proposed: d1/s,
    );
  });
});

describe("apply_decision — confirm=true kirjoittaa, snapshottaa ja verifioi", () => {
  const priorRate = {
    start_date: "2026-06-29",
    end_date: "2026-06-30",
    rate_type: "fixed",
    currency: "EUR",
    monday: 80,
    tuesday: 80,
    wednesday: 80,
    thursday: 80,
    friday: 80,
    saturday: 80,
    sunday: 80,
    expires_at: null,
  };

  it("GET-snapshot → PUT → GET-verify → status applied", async () => {
    const e = whEnv();
    seedDecision(e);
    const { client, store, calls } = fakeWheelhouse({ priorRates: [priorRate] });

    const out = await runApplyDecision({ decision_id: "d1", confirm: true }, e, { client });

    expect(out).toContain("## Applied decision d1 — Test Cabin");
    expect(out).toContain("Verified: 1/1");
    expect(out).toContain('revert_decision {"decision_id": "d1", "confirm": true}');

    // kirjoitettu payload täsmälleen spexin muodossa
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual(buildRatePayload({ start_date: "2026-06-28", end_date: "2026-07-01" }, 95, "EUR"));
    // järjestys: snapshot-GET ennen PUTia
    const methods = calls.filter((c) => c.url.includes("/custom_rates")).map((c) => c.method);
    expect(methods).toEqual(["GET", "PUT", "GET"]);

    const d = readDecisions(e)[0];
    expect(d.status).toBe("applied");
    expect(d.applied_at).toBeTruthy();
    expect(d.applied_ranges).toEqual([{ start_date: "2026-06-28", end_date: "2026-07-01" }]);
    expect(d.snapshot!.prior_custom_rates).toEqual([priorRate]);
    // fake-varastossa on nyt kirjoitettu rate
    expect(store.some((r) => r.start_date === "2026-06-28" && r.end_date === "2026-07-01")).toBe(true);
  });

  it("PUT epäonnistuu → snapshot on JO lokissa, virhe kertoo ettei mitään kirjoitettu", async () => {
    const e = whEnv();
    seedDecision(e);
    const { client } = fakeWheelhouse({ priorRates: [priorRate], failPut: true });

    await expect(runApplyDecision({ decision_id: "d1", confirm: true }, e, { client })).rejects.toThrow(
      /Write failed after 0 of 1 range.*Nothing was written/s,
    );
    const d = readDecisions(e)[0];
    expect(d.status).toBe("proposed"); // ei väitetä applied
    expect(d.snapshot!.prior_custom_rates).toEqual([priorRate]); // snapshot ENNEN kirjoitusta
    expect(d.applied_ranges).toEqual([]);
  });

  it("osittainen kirjoitusvirhe → uusintayritys EI ylikirjoita snapshotia, revert palauttaa alkuperäisen tilan", async () => {
    const e = whEnv();
    // kaksi EI-peräkkäistä yötä → kaksi rangea: [28→29] ja [30→01]
    seedDecision(e, { dates: ["2026-06-28", "2026-06-30"] });
    // aiempi käyttäjän oma rate ensimmäisen rangen kohdalla (80 €/yö ≠ lattia 95)
    const userPrior = { ...priorRate, start_date: "2026-06-28", end_date: "2026-06-29" };
    // 1. yrityksen PUT #2 kaatuu — range 1 ehtii kirjautua
    const { client, store } = fakeWheelhouse({ priorRates: [userPrior], failPutOnCall: 2 });

    await expect(runApplyDecision({ decision_id: "d1", confirm: true }, e, { client })).rejects.toThrow(
      /Write failed after 1 of 2 ranges/,
    );
    let d = readDecisions(e)[0];
    expect(d.status).toBe("proposed");
    expect(d.applied_ranges).toEqual([{ start_date: "2026-06-28", end_date: "2026-06-29" }]);
    expect(d.snapshot!.prior_custom_rates).toEqual([userPrior]);
    // varastossa on nyt työkalun oma lattiahinta rangen 1 kohdalla
    expect(store.some((r) => r.start_date === "2026-06-28" && r.monday === 95)).toBe(true);

    // Uusintayritys onnistuu — snapshotin on pysyttävä AITONA aiempana tilana,
    // ei 1. yrityksen kirjoittamana lattiahintana.
    const out = await runApplyDecision({ decision_id: "d1", confirm: true }, e, { client });
    expect(out).toContain("## Applied decision d1");
    d = readDecisions(e)[0];
    expect(d.status).toBe("applied");
    expect(d.snapshot!.prior_custom_rates).toEqual([userPrior]);

    // Revert palauttaa TÄSMÄLLEEN alkuperäisen varaston sisällön (gate 1).
    const reverted = await runRevertDecision({ decision_id: "d1", confirm: true }, e, { client });
    expect(reverted).toContain("Reverted decision d1");
    expect(store).toEqual([userPrior]);
  });

  it("jo applied → ei kirjoiteta uudelleen, ohjataan revertiin", async () => {
    const e = whEnv();
    seedDecision(e, { status: "applied", applied_at: "2026-06-02T00:00:00.000Z" });
    const out = await runApplyDecision({ decision_id: "d1", confirm: true }, e);
    expect(out).toContain("already applied");
    expect(out).toContain("revert_decision");
  });
});

describe("revert_decision", () => {
  const appliedSeed = (e: NodeJS.ProcessEnv, priorRates: Record<string, unknown>[] = []) =>
    seedDecision(e, {
      status: "applied",
      applied_at: "2026-06-02T00:00:00.000Z",
      applied_ranges: [{ start_date: "2026-06-28", end_date: "2026-07-01" }],
      snapshot: { prior_custom_rates: priorRates },
    });

  it("ilman confirmia → esikatselu, mitään ei muuteta", async () => {
    const e = whEnv();
    appliedSeed(e);
    const out = await runRevertDecision({ decision_id: "d1" }, e); // ei clientiä → ei verkkoa
    expect(out).toContain("## Revert preview — decision d1 (nothing changed)");
    expect(out).toContain("2026-06-28 → 2026-07-01");
    expect(out).toContain('revert_decision {"decision_id": "d1", "confirm": true}');
    expect(readDecisions(e)[0].status).toBe("applied");
  });

  it("confirm=true → DELETE kirjoitetut ranget + palauta snapshotin aiempi rate + status reverted", async () => {
    const priorRate = {
      start_date: "2026-06-29",
      end_date: "2026-06-30",
      rate_type: "fixed",
      currency: "EUR",
      monday: 80,
      tuesday: 80,
      wednesday: 80,
      thursday: 80,
      friday: 80,
      saturday: 80,
      sunday: 80,
      expires_at: null,
    };
    const e = whEnv();
    appliedSeed(e, [priorRate]);
    // varastossa on applyn kirjoittama rate
    const written = buildRatePayload({ start_date: "2026-06-28", end_date: "2026-07-01" }, 95, "EUR");
    const { client, store, calls } = fakeWheelhouse({ priorRates: [{ ...written, expires_at: null }] });

    const out = await runRevertDecision({ decision_id: "d1", confirm: true }, e, { client });

    expect(out).toContain("## Reverted decision d1 — Test Cabin");
    expect(out).toContain("Restored 1 prior custom rate");
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toContain("channel=hypothetical&start_date=2026-06-28&end_date=2026-07-01");
    // palautus-PUT: whitelistatty body — expires_at EI lähde takaisin
    const restorePut = calls.find((c) => c.method === "PUT")!;
    expect(restorePut.body).toEqual({
      start_date: "2026-06-29",
      end_date: "2026-06-30",
      rate_type: "fixed",
      currency: "EUR",
      monday: 80,
      tuesday: 80,
      wednesday: 80,
      thursday: 80,
      friday: 80,
      saturday: 80,
      sunday: 80,
    });
    expect(readDecisions(e)[0].status).toBe("reverted");
    expect(readDecisions(e)[0].reverted_at).toBeTruthy();
    // varastossa: kirjoitettu rate poissa, aiempi palautettu
    expect(store.some((r) => r.start_date === "2026-06-28")).toBe(false);
    expect(store.some((r) => r.start_date === "2026-06-29")).toBe(true);
  });

  it("soveltamaton päätös → ei mitään perottavaa", async () => {
    const e = whEnv();
    seedDecision(e); // status proposed
    await expect(runRevertDecision({ decision_id: "d1", confirm: true }, e)).rejects.toThrow(
      /has not been applied/,
    );
  });

  it("confirm ilman avainta → selkeä virhe", async () => {
    appliedSeed(env);
    await expect(runRevertDecision({ decision_id: "d1", confirm: true }, env)).rejects.toThrow(
      /requires WHEELHOUSE_API_KEY/,
    );
  });
});

describe("restoreBodyFromSnapshot", () => {
  it("poimii vain verifioidut PUT-kentät; puuttuvat päivämäärät → undefined", () => {
    expect(
      restoreBodyFromSnapshot({
        start_date: "2026-06-29",
        end_date: "2026-06-30",
        rate_type: "fixed",
        currency: "EUR",
        monday: 80,
        expires_at: null,
        unknown_field: "x",
      }),
    ).toEqual({
      start_date: "2026-06-29",
      end_date: "2026-06-30",
      rate_type: "fixed",
      currency: "EUR",
      monday: 80,
    });
    expect(restoreBodyFromSnapshot({ rate_type: "fixed" })).toBeUndefined();
  });
});

describe("apply → revert -kierros propose-tuloksesta (integraatio, fake-client)", () => {
  it("koko silmukka: propose → apply (confirm) → revert (confirm)", async () => {
    const e = whEnv();
    const { client, store } = fakeWheelhouse();

    await runProposeDecisions({}, e, { now: NOW, client });
    expect(readDecisions(e)[0].status).toBe("proposed");

    const applied = await runApplyDecision({ decision_id: "d1", confirm: true }, e, { client });
    expect(applied).toContain("Verified: 1/1");
    expect(readDecisions(e)[0].status).toBe("applied");
    expect(store).toHaveLength(1);

    const reverted = await runRevertDecision({ decision_id: "d1", confirm: true }, e, { client });
    expect(reverted).toContain("Reverted decision d1");
    expect(readDecisions(e)[0].status).toBe("reverted");
    expect(store).toHaveLength(0); // ei aiempia rateja → tyhjä kuten alussa
  });
});

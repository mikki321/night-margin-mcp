import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gapNightFloor, nightFloor, nightFloorRaw } from "../src/core/calc.js";
import {
  type NightPrice,
  proposeGapFloorDecisions,
} from "../src/core/decisions.js";
import { riskAdjustedMargin } from "../src/core/risk.js";
import type { Reservation, TurnoverCost } from "../src/core/types.js";
import { readDecisions } from "../src/state.js";
import { runGapNightCheck } from "../src/tools/gapNightCheck.js";
import { runProposeDecisions } from "../src/tools/proposeDecisions.js";
import { WheelhouseClient, type FetchLike } from "../src/wheelhouse/client.js";

/**
 * Min-stay-tietoinen kustannuslattia (verifioitu API-fakta 23.7.:
 * GET /listings/{id}/min_stay_calendar → [{stay_date, min_stay|null}];
 * null/puuttuva = ei sääntöä = 1).
 *
 * P10-LUKKO: kaikki nykyiset luvut (mock-demo, README, min_stay=null-
 * portfoliot) pysyvät ennallaan — muutos näkyy VAIN kun min_stay ≥ 2
 * oikeasti löytyy. Vanhoja testejä EI muutettu tämän ominaisuuden takia.
 */

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const httpStatus = (code: number) => ({ ok: false, status: code, json: async () => ({}) });

function clientWith(fetchImpl: FetchLike): WheelhouseClient {
  return new WheelhouseClient({ apiKey: "test-key", fetchImpl, sleepImpl: async () => {} });
}

// ---------------------------------------------------------------------------
// 1) Lattian matematiikka — nightFloor(t, tr, m, n) = ceil((t + tr + m) / max(1, n))
// ---------------------------------------------------------------------------

describe("nightFloor / nightFloorRaw — min-stay-tietoinen lattia", () => {
  it("1/2/3 yötä: vaihto amortisoituu minimioleskelun yli", () => {
    expect(nightFloor(70, 23, 25, 1)).toBe(118); // sama kuin gapNightFloor
    expect(nightFloor(70, 23, 25, 2)).toBe(59); // 118 / 2
    expect(nightFloor(70, 23, 25, 3)).toBe(40); // ceil(118 / 3 = 39.33…)
  });

  it("tehtävän esimerkki: manual 70 + matka 0 + kate 25, min stay 2 → €48", () => {
    expect(nightFloorRaw(70, 0, 25, 2)).toBe(47.5);
    expect(nightFloor(70, 0, 25, 2)).toBe(48); // pyöristys YLÖS — kirjoitettu hinta ei alita lattiaa
  });

  it("minStay ≤ 1 (0, negatiivinen, 1) → jakaja on 1", () => {
    expect(nightFloor(70, 0, 25, 0)).toBe(95);
    expect(nightFloor(70, 0, 25, -3)).toBe(95);
    expect(nightFloor(70, 0, 25, 1)).toBe(95);
    expect(nightFloorRaw(70, 0, 25, 0)).toBe(95);
  });

  it("minStay=1 kokonaislukusyötteillä = täsmälleen gapNightFloor (ceil ei muuta mitään)", () => {
    for (const [t, tr, m] of [
      [70, 0, 25],
      [70, 23, 25],
      [200, 0, 25],
      [55, 23, 15],
    ] as const) {
      expect(nightFloor(t, tr, m, 1)).toBe(gapNightFloor(t, tr, m));
    }
  });

  it("minStay=1 murtosyötteillä: raw = gapNightFloor sellaisenaan, ceil vain kirjoitettavassa hinnassa", () => {
    expect(gapNightFloor(70.4, 0, 25)).toBeCloseTo(95.4);
    expect(nightFloorRaw(70.4, 0, 25, 1)).toBeCloseTo(95.4); // vertailulattia EI pyöristy
    expect(nightFloor(70.4, 0, 25, 1)).toBe(96);
  });

  it("risk-preset skaalaa marginaalin ENNEN jakoa: ceil((t + tr + risk×m) / n)", () => {
    // conservative: 25 → 50; lattia ceil((70+0+50)/2) = 60 — EI ceil(95/2)+jotain
    expect(nightFloor(70, 0, riskAdjustedMargin(25, "conservative"), 2)).toBe(60);
    // aggressive: 25 → 10; ceil((70+0+10)/2) = 40
    expect(nightFloor(70, 0, riskAdjustedMargin(25, "aggressive"), 2)).toBe(40);
    // recommended: ennallaan; ceil((70+0+25)/2) = 48
    expect(nightFloor(70, 0, riskAdjustedMargin(25, "recommended"), 2)).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// 2) Core: proposeGapFloorDecisions min stay -datalla
// ---------------------------------------------------------------------------

const res = (
  id: string,
  property: string,
  checkin: string,
  checkout: string,
  nights: number,
): Reservation => ({
  reservation_id: id,
  property_id: property,
  checkin,
  checkout,
  nights,
  gross_revenue: 100 * nights,
});

const cost = (id: string, cleaning: number, travel = 0, laundry = 0): TurnoverCost => ({
  reservation_id: id,
  cleaning_cost: cleaning,
  travel_cost: travel,
  laundry_cost: laundry,
});

describe("proposeGapFloorDecisions — min stay -tietoinen lattia ja ryhmittely", () => {
  // p1 varattu 01–04 ja 06–08 → aukot 04, 05, 08, 09, 10.
  // Kustannukset: 70+10=80 + matka 15 → peruslattia 80+15+25 = 120.
  const FROM = "2026-08-01";
  const TO = "2026-08-11";
  const reservations = [
    res("r1", "p1", "2026-08-01", "2026-08-04", 3),
    res("r2", "p1", "2026-08-06", "2026-08-08", 2),
  ];
  const costs = new Map([
    ["r1", cost("r1", 70, 15, 10)],
    ["r2", cost("r2", 70, 15, 10)],
  ]);
  const recs = (...entries: [string, number][]): NightPrice[] =>
    entries.map(([stay_date, price]) => ({ stay_date, price }));

  const base = {
    reservations,
    costsById: costs,
    from: FROM,
    to: TO,
    minMargin: 25,
  };

  it("min stay 2 puolittaa lattian: yö jonka hinta ≥ amortisoitu lattia EI ole enää ehdolla", () => {
    const priceRecsByProperty = new Map([
      ["p1", recs(["2026-08-04", 100], ["2026-08-05", 100])],
    ]);
    // Ilman min stay -dataa molemmat flägätään (100 < 120)…
    expect(
      proposeGapFloorDecisions({ ...base, priceRecsByProperty }).flatMap((p) => p.dates),
    ).toEqual(["2026-08-04", "2026-08-05"]);
    // …min stay 2:lla raakalattia on 60 → 100 ≥ 60 → ei ehdotuksia.
    const minStayByProperty = new Map([
      ["p1", new Map([["2026-08-04", 2], ["2026-08-05", 2]])],
    ]);
    expect(
      proposeGapFloorDecisions({ ...base, priceRecsByProperty, minStayByProperty }),
    ).toEqual([]);
  });

  it("vertailu tehdään RAAKALLA amortisoidulla lattialla; floor_price on ceil", () => {
    // Peruslattia 120 → min stay 2: raw 60. Hinta 60 EI ole alle (raja), 59.9 on.
    const priceRecsByProperty = new Map([
      ["p1", recs(["2026-08-04", 60], ["2026-08-05", 59.9])],
    ]);
    const minStayByProperty = new Map([
      ["p1", new Map([["2026-08-04", 2], ["2026-08-05", 2]])],
    ]);
    const proposals = proposeGapFloorDecisions({ ...base, priceRecsByProperty, minStayByProperty });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      dates: ["2026-08-05"],
      floor_price: 60,
      min_stay: 2,
    });
  });

  it("ryhmittely katkeaa kun min stay (= lattia) vaihtuu kesken peräkkäisen jonon", () => {
    // Aukot 08–10 peräkkäin, kaikki hinnalla 30 (< 40 = 120/3 ja < 120):
    // 08 min stay 3, 09–10 ei sääntöä → kaksi ehdotusta vaikka yöt ovat peräkkäin.
    const priceRecsByProperty = new Map([
      ["p1", recs(["2026-08-08", 30], ["2026-08-09", 30], ["2026-08-10", 30])],
    ]);
    const minStayByProperty = new Map([["p1", new Map([["2026-08-08", 3]])]]);
    const proposals = proposeGapFloorDecisions({ ...base, priceRecsByProperty, minStayByProperty });

    expect(proposals).toHaveLength(2);
    // järjestys: suurin delta ensin — [09,10] delta (120−30)×2 = 180 > [08] delta 40−30 = 10
    expect(proposals[0]).toMatchObject({
      dates: ["2026-08-09", "2026-08-10"],
      floor_price: 120,
      min_stay: 1,
      floor_vs_rec_delta: 180,
    });
    expect(proposals[1]).toMatchObject({
      dates: ["2026-08-08"],
      floor_price: 40, // 120 / 3
      min_stay: 3,
      floor_vs_rec_delta: 10,
    });
  });

  it("P10: minStayByProperty pois / tyhjä / pelkkiä ykkösiä → täsmälleen sama tulos", () => {
    const priceRecsByProperty = new Map([
      ["p1", recs(["2026-08-04", 100], ["2026-08-05", 90], ["2026-08-09", 100])],
    ]);
    const without = proposeGapFloorDecisions({ ...base, priceRecsByProperty });
    const empty = proposeGapFloorDecisions({
      ...base,
      priceRecsByProperty,
      minStayByProperty: new Map(),
    });
    const ones = proposeGapFloorDecisions({
      ...base,
      priceRecsByProperty,
      minStayByProperty: new Map([["p1", new Map([["2026-08-04", 1], ["2026-08-05", 1]])]]),
    });
    expect(empty).toEqual(without);
    expect(ones).toEqual(without);
    expect(without.every((p) => p.min_stay === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3) propose_decisions fake-clientillä: calendar-haku, selite, fallback
// ---------------------------------------------------------------------------

/**
 * Synteettinen WH: listing + varaus 06-01→28 (aukot 28–30 ikkunassa
 * [06-01, 07-01)), suositus 50 €/yö, manual-kustannus 70 → peruslattia 95.
 * min_stay_calendar palauttaa VERIFIOIDUN muodon (paljas array; null = ei sääntöä).
 */
function fakeWheelhouseWithMinStay(
  opts: {
    /** stay_date → min_stay -rivit; oletus: kaikki null. */
    minStays?: { stay_date: string; min_stay: number | null }[];
    /** Kaada min_stay_calendar-haku tällä statuksella. */
    failMinStayStatus?: number;
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
  const priceRecs = {
    data: opts.priceRecs ?? [
      { stay_date: "2026-06-28", price: 50, currency: "EUR" },
      { stay_date: "2026-06-29", price: 50, currency: "EUR" },
      { stay_date: "2026-06-30", price: 50, currency: "EUR" },
    ],
  };
  const minStays = opts.minStays ?? [
    { stay_date: "2026-06-28", min_stay: null },
    { stay_date: "2026-06-29", min_stay: null },
    { stay_date: "2026-06-30", min_stay: null },
  ];
  const calls: { method: string; url: string }[] = [];

  const client = clientWith(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const u = new URL(url);
    if (method === "GET" && u.pathname.endsWith("/listings")) return ok(listings);
    if (method === "GET" && u.pathname.includes("/reservations")) return ok(rawReservations);
    if (method === "GET" && u.pathname.includes("/price_recommendations")) return ok(priceRecs);
    if (method === "GET" && u.pathname.includes("/min_stay_calendar")) {
      if (opts.failMinStayStatus) return httpStatus(opts.failMinStayStatus);
      return ok(minStays); // verifioitu muoto: paljas array
    }
    throw new Error(`fake wheelhouse: unhandled ${method} ${url}`);
  });
  return { client, calls };
}

describe("propose_decisions — min stay fake-clientillä (live-tila)", () => {
  const NOW = new Date("2026-06-01T12:00:00Z");
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nm-minstay-"));
    env = { NM_STATE_DIR: dir, WHEELHOUSE_API_KEY: "test-key" } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hakee min_stay_calendarin suositusten rinnalla samalle ikkunalle", async () => {
    const { client, calls } = fakeWheelhouseWithMinStay();
    await runProposeDecisions({}, env, { now: NOW, client });

    const minStayCalls = calls.filter((c) => c.url.includes("/min_stay_calendar"));
    expect(minStayCalls).toHaveLength(1); // 1 lisäkutsu per gap-kohde
    expect(minStayCalls[0].url).toContain(
      "/listings/11/min_stay_calendar?channel=hypothetical&start_date=2026-06-01&end_date=2026-07-01",
    );
  });

  it("kaikki min_stay null → tulos täsmälleen kuin ennen (floor 95, ei amortisointiselitettä)", async () => {
    const { client } = fakeWheelhouseWithMinStay();
    const out = await runProposeDecisions({}, env, { now: NOW, client });

    expect(out).toContain("Raise to floor €95/night — ");
    expect(out).toContain("of below-floor exposure across 3 nights");
    expect(out).not.toContain("amortized");
    expect(out).not.toContain("min-stay lookup failed");
    // min_stay 1 + ≥3 yötä → minimioleskeluvipu näytetään (lattia/3)
    expect(out).toContain("Or set a 3-night minimum stay for these dates");
    expect(out).toContain("the floor drops to €32/night");
    const d = readDecisions(env)[0];
    expect(d).toMatchObject({ floor_price: 95, dates: ["2026-06-28", "2026-06-29", "2026-06-30"] });
  });

  it("min_stay 2 osalle öistä: lattia ~puolittuu, ryhmittely jakautuu, selite näkyy", async () => {
    // 28: min stay 2, hinta 30 < 47.5 → floor €48 amortisointiselitteellä.
    // 29–30: ei sääntöä, hinta 50 < 95 → floor €95 ilman selitettä.
    const { client } = fakeWheelhouseWithMinStay({
      minStays: [
        { stay_date: "2026-06-28", min_stay: 2 },
        { stay_date: "2026-06-29", min_stay: null },
        { stay_date: "2026-06-30", min_stay: null },
      ],
      priceRecs: [
        { stay_date: "2026-06-28", price: 30, currency: "EUR" },
        { stay_date: "2026-06-29", price: 50, currency: "EUR" },
        { stay_date: "2026-06-30", price: 50, currency: "EUR" },
      ],
    });
    const out = await runProposeDecisions({}, env, { now: NOW, client });

    // Peräkkäinen jono 28–30 jakautuu kahdeksi ehdotukseksi (lattia on osa avainta)
    expect(out).toContain("Found 2 proposals");
    expect(out).toContain(
      "Raise to floor €48/night (turnover amortized over the 2-night minimum stay)",
    );
    expect(out).toContain("of below-floor exposure across 2 nights");
    // 2 yötä (< 3) → vipulausetta ei näytetä
    expect(out).not.toContain("Or set a 3-night minimum stay");

    const decisions = readDecisions(env);
    expect(decisions).toHaveLength(2);
    // järjestys: delta — [29,30] (95−50)×2 = 90 > [28] 48−30 = 18
    expect(decisions[0]).toMatchObject({ id: "d1", dates: ["2026-06-29", "2026-06-30"], floor_price: 95 });
    expect(decisions[1]).toMatchObject({ id: "d2", dates: ["2026-06-28"], floor_price: 48 });
  });

  it("min_stay 2 kaikilla öillä ja hinta amortisoidun lattian yllä → ei ehdotuksia (lattia puolittui)", async () => {
    const { client } = fakeWheelhouseWithMinStay({
      minStays: [
        { stay_date: "2026-06-28", min_stay: 2 },
        { stay_date: "2026-06-29", min_stay: 2 },
        { stay_date: "2026-06-30", min_stay: 2 },
      ],
    });
    // suositus 50 ≥ 47.5 = 95/2 → mikään yö ei ole enää lattian alla
    const out = await runProposeDecisions({}, env, { now: NOW, client });
    expect(out).toContain("No proposals");
    expect(readDecisions(env)).toEqual([]);
  });

  it("calendar-haun virhe (404) → fallback min_stay=1: ehdotukset kuin ennen + note", async () => {
    const { client } = fakeWheelhouseWithMinStay({ failMinStayStatus: 404 });
    const out = await runProposeDecisions({}, env, { now: NOW, client });

    // Propose EI kaadu; lattiat kuin ilman min stay -dataa
    expect(out).toContain("Raise to floor €95/night — ");
    expect(out).toContain("of below-floor exposure across 3 nights");
    expect(out).toContain(
      'min-stay lookup failed for "Test Cabin"',
    );
    expect(out).toContain("floors assume a 1-night minimum stay");
    expect(readDecisions(env)[0]).toMatchObject({ floor_price: 95 });
  });
});

// ---------------------------------------------------------------------------
// 4) gap_night_check — live-tilassa yön min stay samasta kalenterista
// ---------------------------------------------------------------------------

describe("gap_night_check — min stay live-tilassa (fake-client)", () => {
  const NOW = new Date("2026-06-01T12:00:00Z");
  const env = { WHEELHOUSE_API_KEY: "test-key" } as NodeJS.ProcessEnv;

  it("min_stay 2 → lattia €48 amortisointiselitteellä; FILL/SKIP ja netto amortisoiduin kuluin", async () => {
    const { client, calls } = fakeWheelhouseWithMinStay({
      minStays: [{ stay_date: "2026-06-28", min_stay: 2 }],
    });
    const fill = await runGapNightCheck(
      { property_id: "Test Cabin", date: "2026-06-28", candidate_price: 50 },
      env,
      NOW,
      { client },
    );
    // lattia ceil((70+0+25)/2) = 48; netto 50 − 70/2 = +15
    expect(fill).toContain(
      "Floor €48 (turnover 70 + travel 0 + margin 25, amortized over the 2-night minimum stay)",
    );
    expect(fill).toContain(
      "→ FILL — clears the floor by €2 (barely — consider your risk appetite); net after amortized turnover costs +€15.",
    );
    // kalenterihaku: [date, date+1) — kattaa yön kummallakin end_date-tulkinnalla
    const minStayCalls = calls.filter((c) => c.url.includes("/min_stay_calendar"));
    expect(minStayCalls).toHaveLength(1);
    expect(minStayCalls[0].url).toContain(
      "/listings/11/min_stay_calendar?channel=hypothetical&start_date=2026-06-28&end_date=2026-06-29",
    );

    const skip = await runGapNightCheck(
      { property_id: "Test Cabin", date: "2026-06-28", candidate_price: 40 },
      env,
      NOW,
      { client },
    );
    // 40 − 48 = −8 lattiasta; netto 40 − 35 = +5
    expect(skip).toContain(
      "→ SKIP — €8 below floor; filling would net +€5 after amortized costs.",
    );
  });

  it("min_stay null → lattia €95 täsmälleen kuin ennen, ei selitettä eikä notea", async () => {
    const { client } = fakeWheelhouseWithMinStay(); // kaikki null
    const out = await runGapNightCheck(
      { property_id: "Test Cabin", date: "2026-06-28", candidate_price: 96 },
      env,
      NOW,
      { client },
    );
    expect(out).toContain("Floor €95 (turnover 70 + travel 0 + margin 25)");
    expect(out).toContain("→ FILL — clears the floor by €1 (barely — consider your risk appetite); net after turnover costs +€26.");
    expect(out).not.toContain("amortized");
    expect(out).not.toContain("min-stay lookup failed");
  });

  it("calendar-haun virhe → fallback 1: lattia €95 + note, tarkistus EI kaadu", async () => {
    const { client } = fakeWheelhouseWithMinStay({ failMinStayStatus: 500 });
    const out = await runGapNightCheck(
      { property_id: "Test Cabin", date: "2026-06-28" },
      env,
      NOW,
      { client },
    );
    expect(out).toContain("Floor €95 (turnover 70 + travel 0 + margin 25)");
    expect(out).toContain("min-stay lookup failed");
    expect(out).toContain("the floor assumes a 1-night minimum stay");
  });

  it("varatulle yölle EI tehdä min stay -hakua (ei turhia kutsuja)", async () => {
    const { client, calls } = fakeWheelhouseWithMinStay();
    const out = await runGapNightCheck(
      { property_id: "Test Cabin", date: "2026-06-15" }, // varauksen 06-01→28 sisällä
      env,
      NOW,
      { client },
    );
    expect(out).toContain("Not a gap night");
    expect(calls.some((c) => c.url.includes("/min_stay_calendar"))).toBe(false);
  });

  it("risk-preset skaalaa marginaalin ennen jakoa myös gap-checkissä", async () => {
    const { client } = fakeWheelhouseWithMinStay({
      minStays: [{ stay_date: "2026-06-28", min_stay: 2 }],
    });
    const out = await runGapNightCheck(
      { property_id: "Test Cabin", date: "2026-06-28", risk: "conservative" },
      env,
      NOW,
      { client },
    );
    // conservative: kate 50 → lattia ceil((70+0+50)/2) = 60
    expect(out).toContain(
      "Floor €60 (turnover 70 + travel 0 + margin 50, amortized over the 2-night minimum stay)",
    );
  });
});

// ---------------------------------------------------------------------------
// 5) WheelhouseClient.getMinStayCalendar — muoto ja virheet
// ---------------------------------------------------------------------------

describe("WheelhouseClient.getMinStayCalendar", () => {
  it("kutsuu oikeaa polkua ja palauttaa rivit sellaisinaan (paljas array)", async () => {
    const rows = [
      { stay_date: "2026-08-01", min_stay: 2 },
      { stay_date: "2026-08-02", min_stay: null },
    ];
    let seenUrl = "";
    const client = clientWith(async (url) => {
      seenUrl = url;
      return ok(rows);
    });
    const got = await client.getMinStayCalendar(570051, "hostaway", "2026-08-01", "2026-08-03");
    expect(got).toEqual(rows);
    expect(seenUrl).toContain(
      "/listings/570051/min_stay_calendar?channel=hostaway&start_date=2026-08-01&end_date=2026-08-03",
    );
  });

  it("ei-array-vastaus → selkeä virhe (client heittää normaalisti — fallback kuuluu kutsujalle)", async () => {
    const client = clientWith(async () => ok({ data: [] }));
    await expect(client.getMinStayCalendar(1, "hostaway", "a", "b")).rejects.toThrow(
      /min_stay_calendar response was not in the expected shape/,
    );
  });

  it("HTTP-virhe nousee statuskoodeineen (adapteri päättää fallbackista)", async () => {
    const client = clientWith(async () => httpStatus(404));
    await expect(client.getMinStayCalendar(1, "hostaway", "a", "b")).rejects.toThrow(/HTTP 404/);
  });
});

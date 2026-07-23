import { describe, expect, it } from "vitest";
import type { GapFloorProposal } from "../src/core/decisions.js";
import { buildMoves, runMarginCopilot } from "../src/tools/marginCopilot.js";
import { WheelhouseClient, type FetchLike } from "../src/wheelhouse/client.js";

function prop(over: Partial<GapFloorProposal>): GapFloorProposal {
  return {
    property_id: "p",
    dates: ["2026-08-01"],
    floor_price: 95,
    min_stay: 1,
    rec_min: 50,
    rec_max: 50,
    protected_nights: 1,
    floor_vs_rec_delta: 45,
    ...over,
  };
}

describe("buildMoves — ryhmittely ja järjestys", () => {
  it("ryhmittää kohteittain ja järjestää altistuksen mukaan (suurin ensin)", () => {
    const proposals = [
      prop({ property_id: "A", floor_vs_rec_delta: 100, protected_nights: 2 }),
      prop({ property_id: "B", floor_vs_rec_delta: 500, protected_nights: 5 }),
      prop({ property_id: "A", floor_vs_rec_delta: 50, protected_nights: 1 }),
    ];
    const moves = buildMoves(proposals);
    expect(moves).toHaveLength(2);
    // B (500) ennen A:ta (150 = 100+50)
    expect(moves[0].property_id).toBe("B");
    expect(moves[0].exposure).toBe(500);
    expect(moves[1].property_id).toBe("A");
    expect(moves[1].exposure).toBe(150); // aggregoitu
    expect(moves[1].nights).toBe(3); // 2+1
  });

  it("min_stay = jonojen pienin; longest_cluster = pisin jono", () => {
    const moves = buildMoves([
      prop({ property_id: "A", min_stay: 3, dates: ["d1", "d2"] }),
      prop({ property_id: "A", min_stay: 1, dates: ["d1", "d2", "d3", "d4"] }),
    ]);
    expect(moves[0].min_stay).toBe(1);
    expect(moves[0].longest_cluster).toBe(4);
  });
});

// --- live-tila fake-clientillä (sama polku kuin propose_decisions) ---
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const NOW = new Date("2026-07-23T00:00:00Z");

/** Fake WH: 1 listaus, joku varaus (jotta jaksossa on aukkoyötä) ja
 *  price_recommendations selvästi lattian alle → syntyy money-move. */
const LISTING = { id: 11, channel: "hostaway", nickname: "Test Cabin", currency: "EUR", is_active: true };
const RESERVATIONS = [
  {
    id: "20000001",
    status: "Accepted",
    start_date: "2026-08-05",
    end_date: "2026-08-08",
    total_price: 300,
    taxes: 0,
    security_deposit: 0,
    confirmation_code: null,
  },
];
function recsAt(price: number): { stay_date: string; price: number; currency: string }[] {
  const recs: { stay_date: string; price: number; currency: string }[] = [];
  for (let d = 24; d <= 31; d++) recs.push({ stay_date: `2026-07-${d}`, price, currency: "EUR" });
  for (let d = 1; d <= 22; d++)
    recs.push({ stay_date: `2026-08-${String(d).padStart(2, "0")}`, price, currency: "EUR" });
  return recs;
}
function clientWithRecPrice(price: number): WheelhouseClient {
  const recs = recsAt(price);
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("/reservations")) return ok(RESERVATIONS);
    if (url.includes("/price_recommendations")) return ok({ data: recs });
    if (url.includes("/min_stay_calendar")) return ok([]); // min_stay 1 kaikkialla
    return ok([LISTING]); // /listings
  };
  return new WheelhouseClient({ apiKey: "k", fetchImpl, sleepImpl: async () => {} });
}
// €50 << lattia ~€95 → syntyy money-move
const fakeClient = () => clientWithRecPrice(50);

const ENV = { WHEELHOUSE_API_KEY: "k", COST_SOURCE: "manual", AVG_TURNOVER_COST: "70", MIN_MARGIN: "25" } as unknown as NodeJS.ProcessEnv;

describe("runMarginCopilot — live-tila", () => {
  it("tuottaa rankatun kortin suosituksella, EI arvattua nettodeltaa, ei kirjoita", async () => {
    const text = await runMarginCopilot({}, ENV, { client: fakeClient(), now: NOW });

    expect(text).toContain("## Margin Copilot");
    expect(text).toContain("Nothing here writes prices.");
    expect(text).toContain("money-move");
    // kortti + punnitut vaihtoehdot, yksi suositeltu
    expect(text).toContain("**Guard the floor** _(recommended)_");
    expect(text).toContain("**Hold**");
    // altistus näkyy euroina
    expect(text).toMatch(/below-floor exposure/);
    // REHELLISYYS: ei "30-day net vs holding" -tyyppistä keksittyä deltaa
    expect(text).not.toContain("30-day net");
    expect(text).not.toContain("vs holding");
    // reitittää oikeaan kirjoituspolkuun
    expect(text).toContain("apply_decision");
    expect(text).toContain('"confirm": true');
  });

  it("min_stay 1 + ≥3 yön jono → minimioleskeluvaihtoehto lattian pudotuksella", async () => {
    const text = await runMarginCopilot({}, ENV, { client: fakeClient(), now: NOW });
    expect(text).toContain("Raise the minimum stay");
  });
});

describe("runMarginCopilot — ei liikkeitä", () => {
  it("kun mikään ei ole lattian alla → 'No money-moves' rehellisesti", async () => {
    // suositukset lattian YLÄPUOLELLE (€300) → ei ehdotuksia
    const client = clientWithRecPrice(300);
    const text = await runMarginCopilot({}, ENV, { client, now: NOW });
    expect(text).toContain("No money-moves right now");
    expect(text).toContain("the good outcome");
  });
});

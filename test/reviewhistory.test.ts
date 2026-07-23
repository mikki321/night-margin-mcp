import { describe, expect, it } from "vitest";
import { runReviewHistory } from "../src/tools/reviewHistory.js";
import { WheelhouseClient, type FetchLike } from "../src/wheelhouse/client.js";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });

/** Fake-client joka palauttaa annetut listaukset ja per-listing kpis/monthly-vastaukset. */
function fakeClient(
  listings: unknown[],
  kpisByListing: Record<string, unknown>,
): WheelhouseClient {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes("/kpis/monthly")) {
      const id = url.match(/listings\/([^/]+)\/kpis/)![1];
      const resp = kpisByListing[id];
      if (resp === undefined) return notFound();
      return ok(resp);
    }
    return ok(listings);
  };
  return new WheelhouseClient({ apiKey: "k", fetchImpl, sleepImpl: async () => {} });
}

const ENV_KEY = { WHEELHOUSE_API_KEY: "k" } as NodeJS.ProcessEnv;

// Kiinteä "nyt" jotta toteutunut/tuleva-jako on deterministinen (ei riipu
// oikeasta päivämäärästä). Kaikki 2026-alkuvuoden testikuukaudet ovat tätä
// ennen → toteutunutta historiaa.
const NOW = new Date("2027-06-15T00:00:00Z");

const COMP_SET_OMISSION =
  'Competitor (comp_set) figures are omitted — the endpoint returns 0/null placeholders that mean "no data", not "competitors earned €0".';

describe("runReviewHistory — ei avainta", () => {
  it("palauttaa ohjeen eikä keksi historiaa", async () => {
    const text = await runReviewHistory({}, {} as NodeJS.ProcessEnv, {});
    expect(text).toContain("needs an API key");
    expect(text).toContain("no demo/mock mode");
    expect(text).not.toContain("## Season review");
  });
});

describe("runReviewHistory — pieni synteettinen portfolio", () => {
  it("rehellisyysotsikko, estimate-disclaimer, footer; ei comp_set-numeroita", async () => {
    const listings = [{ id: 1, channel: "hostaway" }];
    // comp_set_revenue: 0 mukana vastauksessa — EI saa vuotaa tulosteeseen faktana.
    const kpis = {
      "1": {
        currency: "EUR",
        data: [
          {
            month: "2026-01-01",
            revenue: 10_000,
            occupancy: 0.5,
            adr: 200,
            los: 4,
            comp_set_revenue: 0,
            comp_set_adr: 0,
          },
          {
            month: "2026-02-01",
            revenue: 8_000,
            occupancy: 0.6,
            adr: 150,
            los: 2,
            comp_set_revenue: 0,
          },
        ],
      },
    };
    const client = fakeClient(listings, kpis);
    const text = await runReviewHistory({}, ENV_KEY, { client, now: NOW });

    expect(text).toContain("## Season review — your own Wheelhouse history");
    expect(text).toContain(
      "Based on 2 months of your own Wheelhouse history (earliest 2026-01, latest 2026-02).",
    );
    expect(text).toContain("are ESTIMATES");
    expect(text).toContain("× €70 per turnover (AVG_TURNOVER_COST)");
    expect(text).toContain(
      "This is a review of what already happened — not a forecast, not a strategy recommendation.",
    );
    expect(text).toContain(COMP_SET_OMISSION);
    // comp_set-numeroita ei tulosteessa
    expect(text).not.toContain("comp_set_revenue");
    // seasonality kuvaava, denominator rehellinen (ei "of gross")
    expect(text).toContain("**Seasonality:**");
    expect(text).toContain("of the revenue we could estimate");
    expect(text).not.toContain("of gross");
    expect(text).toContain("not a seasonal forecast");
    // 2 arvioitavaa kuukautta → thinnest-osio EI toistu (kaventaisi 2→2)
    expect(text).not.toContain("### Where turnover ate the most");
    // ei tulevia kuukausia tässä datassa
    expect(text).not.toContain("Already on the books");
    // ei kiellettyjä aikaväli-ilmauksia
    expect(text).not.toContain("last year");
    expect(text).not.toContain("5 years");
  });

  it("thinnest-osio renderöityy kun se kaventaa taulukkoa (>3 arvioitavaa kuukautta)", async () => {
    const listings = [{ id: 1, channel: "hostaway" }];
    const mk = (month: string, revenue: number, los: number) => ({
      month,
      revenue,
      occupancy: 0.5,
      adr: 100,
      los,
    });
    const kpis = {
      "1": {
        currency: "EUR",
        // 4 arvioitavaa kuukautta, eri turnover share (pieni los = enemmän vaihtoja = suurempi share)
        data: [
          mk("2026-01-01", 10_000, 6),
          mk("2026-02-01", 10_000, 5),
          mk("2026-03-01", 10_000, 2),
          mk("2026-04-01", 10_000, 1.5),
        ],
      },
    };
    const text = await runReviewHistory({}, ENV_KEY, { client: fakeClient(listings, kpis), now: NOW });
    expect(text).toContain("### Where turnover ate the most");
    expect(text).toContain("of the revenue we could estimate");
    expect(text).not.toContain("of gross");
  });

  it("tulevat kuukaudet erotellaan historiasta (kirjoissa, ei laskenneta historiaan)", async () => {
    const listings = [{ id: 1, channel: "hostaway" }];
    const mk = (month: string, revenue: number) => ({
      month,
      revenue,
      occupancy: 0.5,
      adr: 100,
      los: 3,
    });
    const kpis = {
      "1": {
        currency: "EUR",
        data: [
          mk("2026-05-01", 8_000), // toteutunut (< NOW 2027-06)
          mk("2026-06-01", 9_000), // toteutunut
          mk("2027-08-01", 20_000), // TULEVA (> NOW)
          mk("2027-09-01", 15_000), // TULEVA
        ],
      },
    };
    const text = await runReviewHistory({}, ENV_KEY, { client: fakeClient(listings, kpis), now: NOW });
    // historia = vain 2 toteutunutta kuukautta
    expect(text).toContain(
      "Based on 2 months of your own Wheelhouse history (earliest 2026-05, latest 2026-06).",
    );
    // tulevat mainitaan otsikossa ja omassa osiossaan, EI historiana
    expect(text).toContain("2 months already on the books");
    expect(text).toContain("Already on the books — future stays, not history");
    // tulevat rivit vain "kirjoissa" -osiossa
    const [historyBlock, futureBlock] = text.split("Already on the books");
    expect(futureBlock).toContain("| 2027-08 |");
    expect(futureBlock).toContain("| 2027-09 |");
    // historiataulukossa EI tulevia rivejä (otsikko saa nimetä span-välin)
    expect(historyBlock).not.toContain("| 2027-08 |");
    expect(historyBlock).toContain("| 2026-05 |");
    // portfolio-totaaliin ei lasketa tulevien €35k:ta (vain €17k toteutunutta)
    expect(text).toContain("revenue €17,000");
  });

  it("los=null kuukausi → net/share '—', non-estimable-note näkyy", async () => {
    const listings = [{ id: 1, channel: "hostaway" }];
    const kpis = {
      "1": {
        currency: "EUR",
        data: [{ month: "2026-03-01", revenue: 5_000, occupancy: 0.7, adr: 120, los: null }],
      },
    };
    const text = await runReviewHistory({}, ENV_KEY, { client: fakeClient(listings, kpis) });
    expect(text).toContain("no length-of-stay data");
    expect(text).toContain("turnover share not estimable");
    expect(text).not.toContain("### Where margin was thinnest");
  });
});

describe("runReviewHistory — zero-history", () => {
  it("kaikki kuukaudet revenue 0 → N=0, 'nothing to review'", async () => {
    const listings = [{ id: 1, channel: "hostaway" }];
    const kpis = {
      "1": {
        currency: "EUR",
        data: [{ month: "2026-01-01", revenue: 0, occupancy: 0, adr: null, los: null }],
      },
    };
    const text = await runReviewHistory({}, ENV_KEY, { client: fakeClient(listings, kpis) });
    expect(text).toContain("Based on 0 months of your own Wheelhouse history.");
    expect(text).not.toContain("earliest");
    expect(text).toContain("There is nothing to review.");
    expect(text).not.toContain("| Month |");
  });
});

describe("runReviewHistory — 404 listaus ohitetaan", () => {
  it("listaus ilman kpis-historiaa lasketaan skipatuksi", async () => {
    const listings = [
      { id: 1, channel: "hostaway" },
      { id: 2, channel: "hostaway" },
    ];
    const kpis = {
      "1": {
        currency: "EUR",
        data: [{ month: "2026-01-01", revenue: 9_000, occupancy: 0.5, adr: 180, los: 4 }],
      },
      // id 2 puuttuu → 404 → skip
    };
    const text = await runReviewHistory({}, ENV_KEY, { client: fakeClient(listings, kpis) });
    expect(text).toContain("1 listing had no monthly KPI history on their channel and was skipped.");
  });
});

describe("runReviewHistory — tyhjä ikkuna", () => {
  it("from myöhempi kuin to → ohjeviesti", async () => {
    const text = await runReviewHistory(
      { from: "2026-06-01", to: "2026-01-01" },
      ENV_KEY,
      { client: fakeClient([], {}) },
    );
    expect(text).toContain("is empty — 'from' is a later month than 'to'");
  });

  it("ikkuna ilman osumia → window-spesifi tyhjäviesti", async () => {
    const listings = [{ id: 1, channel: "hostaway" }];
    const kpis = {
      "1": {
        currency: "EUR",
        data: [{ month: "2026-01-01", revenue: 9_000, occupancy: 0.5, adr: 180, los: 4 }],
      },
    };
    const text = await runReviewHistory(
      { from: "2026-06-01", to: "2026-07-01" },
      ENV_KEY,
      { client: fakeClient(listings, kpis) },
    );
    expect(text).toContain("No booked months fall inside 2026-06 → 2026-07");
    expect(text).toContain("Window applied: 2026-06 → 2026-07 (inclusive).");
  });
});

describe("runReviewHistory — virheellinen päivä", () => {
  it("from ei ole validi päivä → Invalid date", async () => {
    await expect(
      runReviewHistory({ from: "not-a-date" }, ENV_KEY, { client: fakeClient([], {}) }),
    ).rejects.toThrow(/Invalid date/);
  });
});

import { describe, expect, it } from "vitest";
import { daysInMonth, reviewHistory, type MonthlyKpiInput } from "../src/core/history.js";

/** Pikarakentaja yhdelle listing-kuukausi-solulle. */
function cell(
  month: string,
  revenue: number,
  occupancy: number | null,
  los: number | null,
  adr: number | null = null,
): MonthlyKpiInput {
  return { month, revenue, occupancy, los, adr };
}

describe("daysInMonth", () => {
  it("tavalliset kuukaudet", () => {
    expect(daysInMonth("2026-01-01")).toBe(31);
    expect(daysInMonth("2026-04-01")).toBe(30);
  });

  it("helmikuu — ei-karkausvuosi 28, karkausvuosi 29", () => {
    expect(daysInMonth("2027-02-01")).toBe(28);
    expect(daysInMonth("2028-02-01")).toBe(29);
  });

  it("hyväksyy myös YYYY-MM-muodon", () => {
    expect(daysInMonth("2026-12")).toBe(31);
  });

  it("virheellinen kuukausi heittää", () => {
    expect(() => daysInMonth("2026-13")).toThrow(/Invalid month/);
    expect(() => daysInMonth("2026-00")).toThrow(/Invalid month/);
  });
});

describe("reviewHistory — arvioitava kuukausi (tarkat floatit)", () => {
  it("occupancy=0.5, los=4, days=30, avg=70 → occupied=15, turnovers=3.75, cost=262.5", () => {
    // huhtikuu = 30 pv
    const review = reviewHistory([cell("2026-04-01", 10_000, 0.5, 4)], 70);
    expect(review.months_count).toBe(1);
    const r = review.rollup[0];
    expect(r.occupied_nights).toBe(15); // 0.5 * 30
    expect(r.est_turnover_cost).toBeCloseTo(262.5, 10); // 15/4 * 70
    expect(r.estimable_revenue).toBe(10_000);
    expect(r.est_net).toBeCloseTo(10_000 - 262.5, 10);
    expect(r.turnover_share).toBeCloseTo(262.5 / 10_000, 12);
    expect(r.adr).toBeCloseTo(10_000 / 15, 10);
    expect(r.occupancy).toBeCloseTo(0.5, 12);
  });
});

describe("reviewHistory — revenue===0 solu pudotetaan", () => {
  it("nollavarauskuukausi ei näy rollupissa, months_countissa eikä spanissa", () => {
    const review = reviewHistory(
      [cell("2026-01-01", 0, 0, 4), cell("2026-02-01", 5_000, 0.5, 5)],
      70,
    );
    expect(review.months_count).toBe(1);
    expect(review.earliest_month).toBe("2026-02");
    expect(review.latest_month).toBe("2026-02");
    expect(review.rollup.map((r) => r.month)).toEqual(["2026-02"]);
  });

  it("negatiivinen revenue pudotetaan myös", () => {
    const review = reviewHistory([cell("2026-03-01", -100, 0.4, 3)], 70);
    expect(review.months_count).toBe(0);
    expect(review.earliest_month).toBeNull();
  });
});

describe("reviewHistory — los=null solu (ei arvioitavissa)", () => {
  it("revenue + non_estimable_revenue kasvaa, turnover-arvio ei; share heijastaa vain arvioitavaa", () => {
    // Sama kuukausi: yksi arvioitava solu + yksi los=null solu.
    const review = reviewHistory(
      [cell("2026-04-01", 10_000, 0.5, 4), cell("2026-04-01", 4_000, 0.6, null)],
      70,
    );
    const r = review.rollup[0];
    expect(r.revenue).toBe(14_000);
    expect(r.non_estimable_revenue).toBe(4_000);
    expect(r.estimable_revenue).toBe(10_000);
    expect(r.est_turnover_cost).toBeCloseTo(262.5, 10); // vain arvioitavasta
    expect(r.turnover_share).toBeCloseTo(262.5 / 10_000, 12); // vain arvioitavasta revenuesta
  });

  it("kuukausi jossa VAIN los-null soluja → share=null, est_net=0, estimable_revenue=0", () => {
    const review = reviewHistory([cell("2026-05-01", 8_000, 0.7, null)], 70);
    const r = review.rollup[0];
    expect(r.revenue).toBe(8_000);
    expect(r.non_estimable_revenue).toBe(8_000);
    expect(r.estimable_revenue).toBe(0);
    expect(r.est_net).toBe(0);
    expect(r.turnover_share).toBeNull();
    // occupancy JA adr silti lasketaan (occupancy present)
    expect(r.occupancy).toBeCloseTo(0.7, 12);
  });
});

describe("reviewHistory — occupancy=null solu", () => {
  it("suljetaan occupancysta, adr:stä ja arviosta; revenue → non_estimable_revenue", () => {
    const review = reviewHistory([cell("2026-06-01", 3_000, null, 4)], 70);
    const r = review.rollup[0];
    expect(r.revenue).toBe(3_000);
    expect(r.non_estimable_revenue).toBe(3_000);
    expect(r.estimable_revenue).toBe(0);
    expect(r.occupancy).toBeNull();
    expect(r.adr).toBeNull();
    expect(r.occupied_nights).toBe(0);
    expect(r.available_nights).toBe(0);
  });
});

describe("reviewHistory — usea listing samaan kuukauteen aggregoituu", () => {
  it("revenue summautuu; occupancy=Σocc/Σavail; adr=Σocc-revenue/Σoccupied", () => {
    // huhtikuu 30 pv: listing A occ=0.5 (15 yötä, rev 6000), B occ=0.8 (24 yötä, rev 12000)
    const review = reviewHistory(
      [cell("2026-04-01", 6_000, 0.5, 3), cell("2026-04-01", 12_000, 0.8, 6)],
      70,
    );
    const r = review.rollup[0];
    expect(r.revenue).toBe(18_000);
    expect(r.occupied_nights).toBeCloseTo(39, 10); // 15 + 24
    expect(r.available_nights).toBe(60); // 30 + 30
    expect(r.occupancy).toBeCloseTo(39 / 60, 12);
    expect(r.adr).toBeCloseTo(18_000 / 39, 10);
    // turnovers = 15/3 + 24/6 = 5 + 4 = 9 → cost = 630
    expect(r.est_turnover_cost).toBeCloseTo(630, 10);
  });
});

describe("reviewHistory — thinnest järjestys", () => {
  it("korkein turnover_share ensin, katto 3, tie-break month nousevasti", () => {
    // rakenna kuukaudet joilla tunnetut sharet: käytä los-säätöä kääntämään share.
    // share = cost/rev = (occ*days/los*avg)/rev. Pidä occ,days,avg,rev vakiona, muuta los.
    // days huhti=30, occ=0.5 → occNights=15, avg=70, rev=10000.
    // los pieni → enemmän turnovereita → suurempi share.
    const review = reviewHistory(
      [
        cell("2026-01-01", 10_000, 0.5, 10), // occNights 0.5*31=15.5 cost=15.5/10*70=108.5 share 0.01085
        cell("2026-02-01", 10_000, 0.5, 2), // 0.5*28=14, /2*70=490 share 0.049
        cell("2026-03-01", 10_000, 0.5, 5), // 0.5*31=15.5 /5*70=217 share 0.0217
        cell("2026-04-01", 10_000, 0.5, 3), // 0.5*30=15 /3*70=350 share 0.035
      ],
      70,
    );
    expect(review.thinnest.map((r) => r.month)).toEqual(["2026-02", "2026-04", "2026-03"]);
    expect(review.thinnest).toHaveLength(3);
  });

  it("tie-break: sama share → aikaisempi kuukausi ensin", () => {
    // identtiset parametrit eri kuukausina, mutta days eroaa → share eroaa. Pakota sama:
    // käytä helmi (28) ja marras (30) — eri days → eri share. Sen sijaan tehdään
    // kaksi solua samoilla luvuilla eri kuukausina joilla SAMA days: huhti(30) & kesä(30).
    const review = reviewHistory(
      [cell("2026-06-01", 10_000, 0.5, 4), cell("2026-04-01", 10_000, 0.5, 4)],
      70,
    );
    // molemmilla sama share → aikaisempi (2026-04) ensin
    expect(review.thinnest.map((r) => r.month)).toEqual(["2026-04", "2026-06"]);
  });
});

describe("reviewHistory — seasonality", () => {
  it("lowest/highest share -kuukaudet valitaan oikein", () => {
    const review = reviewHistory(
      [
        cell("2026-02-01", 10_000, 0.5, 2), // korkea share
        cell("2026-01-01", 10_000, 0.5, 10), // matala share
        cell("2026-03-01", 10_000, 0.5, 5), // keski
      ],
      70,
    );
    expect(review.lowest_share_month?.month).toBe("2026-01");
    expect(review.highest_share_month?.month).toBe("2026-02");
  });

  it("yksi arvioitava kuukausi → lowest ja highest sama kuukausi", () => {
    const review = reviewHistory(
      [cell("2026-01-01", 10_000, 0.5, 4), cell("2026-02-01", 5_000, 0.6, null)],
      70,
    );
    expect(review.lowest_share_month?.month).toBe("2026-01");
    expect(review.highest_share_month?.month).toBe("2026-01");
  });

  it("nolla arvioitavaa kuukautta → molemmat null", () => {
    const review = reviewHistory([cell("2026-01-01", 5_000, 0.6, null)], 70);
    expect(review.lowest_share_month).toBeNull();
    expect(review.highest_share_month).toBeNull();
    expect(review.thinnest).toEqual([]);
  });
});

describe("reviewHistory — ikkunasuodatin (kuukausigranulariteetti, inklusiivinen)", () => {
  const cells = [
    cell("2026-01-01", 1_000, 0.5, 4),
    cell("2026-02-01", 2_000, 0.5, 4),
    cell("2026-03-01", 3_000, 0.5, 4),
  ];

  it("from/to keskellä kuukautta sisältää koko kuukauden", () => {
    const review = reviewHistory(cells, 70, { from: "2026-01-15", to: "2026-02-20" });
    expect(review.rollup.map((r) => r.month)).toEqual(["2026-01", "2026-02"]);
    expect(review.window_from_month).toBe("2026-01");
    expect(review.window_to_month).toBe("2026-02");
  });

  it("pelkkä from", () => {
    const review = reviewHistory(cells, 70, { from: "2026-02-01" });
    expect(review.rollup.map((r) => r.month)).toEqual(["2026-02", "2026-03"]);
  });

  it("ikkuna ilman osumia → months_count 0, span null", () => {
    const review = reviewHistory(cells, 70, { from: "2026-06-01", to: "2026-07-01" });
    expect(review.months_count).toBe(0);
    expect(review.earliest_month).toBeNull();
    expect(review.latest_month).toBeNull();
  });
});

describe("reviewHistory — totalsin täsmäytys", () => {
  it("est_net = estimable_revenue − est_turnover_cost; revenue = Σ rollup.revenue", () => {
    const review = reviewHistory(
      [
        cell("2026-01-01", 10_000, 0.5, 4),
        cell("2026-02-01", 8_000, 0.6, null), // non-estimable
        cell("2026-03-01", 12_000, 0.7, 5),
      ],
      70,
    );
    const t = review.totals;
    expect(t.revenue).toBe(review.rollup.reduce((s, r) => s + r.revenue, 0));
    expect(t.revenue).toBe(30_000);
    expect(t.est_net).toBeCloseTo(t.estimable_revenue - t.est_turnover_cost, 10);
    expect(t.non_estimable_revenue).toBe(8_000);
    expect(t.turnover_share).toBeCloseTo(t.est_turnover_cost / t.estimable_revenue, 12);
  });

  it("zero-history portfolio → totals nolla, share null", () => {
    const review = reviewHistory([cell("2026-01-01", 0, 0, 4)], 70);
    expect(review.months_count).toBe(0);
    expect(review.totals.revenue).toBe(0);
    expect(review.totals.turnover_share).toBeNull();
  });
});

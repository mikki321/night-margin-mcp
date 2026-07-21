import { describe, expect, it } from "vitest";
import type { Reservation } from "../src/core/types.js";
import type { CostRow } from "../src/sources/costSource.js";
import { formatMatchReport, matchCosts } from "../src/sources/matchCosts.js";

const res = (id: string, over: Partial<Reservation> = {}): Reservation => ({
  reservation_id: id,
  property_id: "p1",
  checkin: "2026-06-01",
  checkout: "2026-06-03",
  nights: 2,
  gross_revenue: 200,
  ...over,
});

const row = (id: string, over: Partial<CostRow> = {}): CostRow => ({
  reservation_id: id,
  cleaning_cost: 55,
  travel_cost: 12,
  laundry_cost: 8,
  ...over,
});

describe("matchCosts — kaskadin haarat", () => {
  it("(1) tarkka reservation_id", () => {
    const { costs, report } = matchCosts([res("r1")], [row("r1")]);
    expect(costs.get("r1")).toEqual({
      reservation_id: "r1",
      cleaning_cost: 55,
      travel_cost: 12,
      laundry_cost: 8,
    });
    expect(report).toEqual({ by_id: 1, by_code: 0, by_composite: 0, by_fallback: 0 });
  });

  it("(2) confirmation_code kun id ei osu (WH-parseri tuottaa kentän)", () => {
    const r = res("wh-123", { property_id: "eri-kohde" });
    r.confirmation_code = "HMABCDEF";
    const { costs, report } = matchCosts([r], [row("ch-999", { confirmation_code: "HMABCDEF" })]);
    // kustannus avaimoidaan ja normalisoidaan varauksen id:lle, ei rivin
    expect(costs.get("wh-123")!.reservation_id).toBe("wh-123");
    expect(costs.get("wh-123")!.cleaning_cost).toBe(55);
    expect(report).toEqual({ by_id: 0, by_code: 1, by_composite: 0, by_fallback: 0 });
  });

  it("(3) komposiitti property_id|checkin|checkout kun id ja koodi eivät osu", () => {
    const { costs, report } = matchCosts(
      [res("wh-1", { property_id: "villa-a" })],
      [row("ch-1", { property_id: "villa-a", checkin: "2026-06-01", checkout: "2026-06-03" })],
    );
    expect(costs.get("wh-1")!.reservation_id).toBe("wh-1");
    expect(costs.get("wh-1")!.travel_cost).toBe(12);
    expect(report).toEqual({ by_id: 0, by_code: 0, by_composite: 1, by_fallback: 0 });
  });

  it("(3) komposiitti on case-insensitiivinen property_id:n suhteen", () => {
    const { report } = matchCosts(
      [res("wh-1", { property_id: "Villa-A" })],
      [row("ch-1", { property_id: "VILLA-a", checkin: "2026-06-01", checkout: "2026-06-03" })],
    );
    expect(report.by_composite).toBe(1);
  });

  it("(3) komposiitti EI osu jos checkin/checkout eroaa (ei fuzzya)", () => {
    const { report } = matchCosts(
      [res("wh-1", { property_id: "villa-a" })],
      [row("ch-1", { property_id: "villa-a", checkin: "2026-06-02", checkout: "2026-06-03" })],
      { avgFallback: 70 },
    );
    expect(report.by_composite).toBe(0);
    expect(report.by_fallback).toBe(1);
  });

  it("(4) avgFallback kun mikään ei osu: pelkkä siivous, matka/pyykki 0", () => {
    const { costs, report } = matchCosts([res("orpo")], [], { avgFallback: 70 });
    expect(costs.get("orpo")).toEqual({
      reservation_id: "orpo",
      cleaning_cost: 70,
      travel_cost: 0,
      laundry_cost: 0,
    });
    expect(report).toEqual({ by_id: 0, by_code: 0, by_composite: 0, by_fallback: 1 });
  });

  it("(5) ilman fallbackia heittää virheen: max 3 esimerkki-id:tä + toimintaohje", () => {
    const orphans = [res("o1"), res("o2"), res("o3"), res("o4")];
    expect(() => matchCosts(orphans, [])).toThrow(
      /4 reservation\(s\).*e\.g\. o1, o2, o3\).*AVG_TURNOVER_COST/,
    );
    expect(() => matchCosts(orphans, [])).not.toThrow(/o4/);
  });

  it("id voittaa komposiitin — sama varaus lasketaan vain kerran ja vain id-luokkaan", () => {
    const { report } = matchCosts(
      [res("r1", { property_id: "p1" })],
      [
        row("r1", { cleaning_cost: 40 }),
        row("muu", { property_id: "p1", checkin: "2026-06-01", checkout: "2026-06-03" }),
      ],
    );
    expect(report).toEqual({ by_id: 1, by_code: 0, by_composite: 0, by_fallback: 0 });
  });

  it("sama rivi ei kohdistu kahdesti: id-osuma kuluttaa rivin ennen komposiittia", () => {
    // Rivi osuu r1:een id:llä JA r2:een komposiitilla (esim. peruttu+uudelleen-
    // buukattu pari) — kustannus saa kirjautua vain kerran.
    const shared = row("r1", { property_id: "p1", checkin: "2026-06-01", checkout: "2026-06-03" });
    const { costs, report } = matchCosts([res("r1"), res("r2")], [shared], { avgFallback: 70 });
    expect(report).toEqual({ by_id: 1, by_code: 0, by_composite: 0, by_fallback: 1 });
    expect(costs.get("r1")!.cleaning_cost).toBe(55);
    expect(costs.get("r2")!.cleaning_cost).toBe(70); // fallback, EI sama rivi uudelleen
  });

  it("jaettu rivi ilman fallbackia → virhe toiselle varaukselle, ei hiljaista kahdennusta", () => {
    const shared = row("r1", { property_id: "p1", checkin: "2026-06-01", checkout: "2026-06-03" });
    expect(() => matchCosts([res("r1"), res("r2")], [shared])).toThrow(/r2/);
  });

  it("kaksi riviä samalla komposiittiavaimella palvelee kahta varausta (moniyksikkö) + varoitus", () => {
    const rows = [
      row("a", { property_id: "p1", checkin: "2026-06-01", checkout: "2026-06-03", cleaning_cost: 40 }),
      row("b", { property_id: "p1", checkin: "2026-06-01", checkout: "2026-06-03", cleaning_cost: 60 }),
    ];
    const { report, warnings } = matchCosts([res("x"), res("y")], rows);
    expect(report.by_composite).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("composite key");
  });

  it("normaalidata ei tuota varoituksia", () => {
    const { warnings } = matchCosts([res("r1")], [row("r1")]);
    expect(warnings).toEqual([]);
  });

  it("count-raportti summautuu sekakatraalla oikein", () => {
    const rWithCode = res("wh-b", { property_id: "kohde-b", checkin: "2026-06-05", checkout: "2026-06-08" });
    rWithCode.confirmation_code = "CODE-B";
    const reservations = [
      res("r1"),
      rWithCode,
      res("wh-c", { property_id: "kohde-c", checkin: "2026-06-10", checkout: "2026-06-12" }),
      res("orpo", { property_id: "ei-riviä" }),
    ];
    const rows = [
      row("r1"),
      row("ch-b", { confirmation_code: "CODE-B" }),
      row("ch-c", { property_id: "Kohde-C", checkin: "2026-06-10", checkout: "2026-06-12" }),
    ];
    const { costs, report } = matchCosts(reservations, rows, { avgFallback: 65 });
    expect(report).toEqual({ by_id: 1, by_code: 1, by_composite: 1, by_fallback: 1 });
    expect(costs.size).toBe(4);
  });
});

describe("formatMatchReport", () => {
  it("monilähteinen: täysmuoto + kokonaismäärä", () => {
    expect(
      formatMatchReport({ by_id: 41, by_code: 0, by_composite: 6, by_fallback: 3 }),
    ).toBe("Cost attribution: 41 by reservation_id, 6 by composite key, 3 by average fallback (50 total)");
  });

  it("näyttää koodiluokan kun sitä on", () => {
    expect(
      formatMatchReport({ by_id: 2, by_code: 1, by_composite: 0, by_fallback: 0 }),
    ).toBe("Cost attribution: 2 by reservation_id, 1 by confirmation code (3 total)");
  });

  it("yksi mätsityyppi: N/N bookings matched by -muoto", () => {
    expect(
      formatMatchReport({ by_id: 289, by_code: 0, by_composite: 0, by_fallback: 0 }),
    ).toBe("Cost attribution: 289/289 bookings matched by reservation_id");
    expect(
      formatMatchReport({ by_id: 0, by_code: 0, by_composite: 0, by_fallback: 1 }),
    ).toBe("Cost attribution: 1/1 booking matched by average fallback");
  });

  it("palauttaa tyhjän kun kaikki luokat ovat nollia", () => {
    expect(formatMatchReport({ by_id: 0, by_code: 0, by_composite: 0, by_fallback: 0 })).toBe("");
  });
});

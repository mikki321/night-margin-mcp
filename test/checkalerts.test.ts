import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Reservation } from "../src/core/types.js";
import type { NotifyFetch } from "../src/notify.js";
import type { ReservationSource } from "../src/sources/reservationSource.js";
import { runCheckAlerts } from "../src/tools/checkAlerts.js";

/**
 * check_alerts-testit — EI verkkoa: injektoitu reservationSource (ei
 * mock-datan satunnaisuudesta riippuvainen) ja fake fetchImpl notifylle;
 * tuore tmp NM_STATE_DIR per testi (seen_bookings.json).
 */

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nm-checkalerts-"));
  env = { NM_STATE_DIR: dir } as NodeJS.ProcessEnv;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-06-01T12:00:00Z");

const res = (over: Partial<Reservation> & Pick<Reservation, "reservation_id" | "checkin" | "checkout">): Reservation => ({
  property_id: "p1",
  nights: 1,
  gross_revenue: 100,
  ...over,
});

function sourceReturning(reservations: Reservation[]): ReservationSource {
  return { label: "test-source", async getReservations() { return reservations; } };
}

function capturingFetch(respond: (body: string) => { ok: boolean; status: number } = () => ({ ok: true, status: 200 })) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: NotifyFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    return respond(init.body);
  };
  return { fetchImpl, calls };
}

describe("check_alerts — uudet varaukset", () => {
  it("ensimmäinen ajo (tyhjä seen) → baseline eikä listaa vanhoja uusina", async () => {
    const base = [
      res({ reservation_id: "r1", checkin: "2026-06-05", checkout: "2026-06-10", nights: 5, gross_revenue: 500 }),
    ];
    const out = await runCheckAlerts({ send: false }, env, { reservationSource: sourceReturning(base), now: NOW });

    expect(out).toContain("Baseline recorded: 1 existing booking — you'll be alerted about new ones from now on.");
    expect(out).not.toContain("New booking:");
  });

  it("toinen ajo uudella varauksella hälyttää netto-luvuin (manual €70/turnover)", async () => {
    const base = [
      res({ reservation_id: "r1", checkin: "2026-06-05", checkout: "2026-06-10", nights: 5, gross_revenue: 500 }),
    ];
    const extra = res({
      reservation_id: "r2",
      property_id: "p1",
      checkin: "2026-06-20",
      checkout: "2026-06-24",
      nights: 4,
      gross_revenue: 400,
    });

    // Baseline-ajo: kirjaa r1 seeniin.
    await runCheckAlerts({ send: false }, env, { reservationSource: sourceReturning(base), now: NOW });

    // Toinen ajo: r1 + uusi r2 → vain r2 on "uusi".
    const out = await runCheckAlerts({ send: false }, env, {
      reservationSource: sourceReturning([...base, extra]),
      now: NOW,
    });

    expect(out).not.toContain("Baseline recorded");
    // manual-kustannus: cleaning 70 + travel 0 + laundry 0 = 70; netto = 400-70=330; /night = 330/4=82.5 → €83
    expect(out).toContain(
      "🏠 New booking: p1 · 2026-06-20, 4 nights · gross €400 → **net €330 after turnover** (€83/night)",
    );
  });

  it("kolmas ajo ilman uusia varauksia ei hälytä uudestaan samasta varauksesta", async () => {
    const base = [
      res({ reservation_id: "r1", checkin: "2026-06-05", checkout: "2026-06-10", nights: 5, gross_revenue: 500 }),
    ];
    await runCheckAlerts({ send: false }, env, { reservationSource: sourceReturning(base), now: NOW });
    const out = await runCheckAlerts({ send: false }, env, { reservationSource: sourceReturning(base), now: NOW });

    expect(out).not.toContain("New booking:");
    expect(out).not.toContain("Baseline recorded");
  });

  it("yli 5 uutta varausta → 5 listataan ja loput '…and N more'", async () => {
    const base: Reservation[] = [];
    await runCheckAlerts({ send: false }, env, { reservationSource: sourceReturning(base), now: NOW });

    const many = Array.from({ length: 7 }, (_, i) =>
      res({
        reservation_id: `n${i}`,
        checkin: `2026-06-${String(5 + i).padStart(2, "0")}`,
        checkout: `2026-06-${String(6 + i).padStart(2, "0")}`,
        nights: 1,
        gross_revenue: 100,
      }),
    );
    const out = await runCheckAlerts({ send: false }, env, { reservationSource: sourceReturning(many), now: NOW });

    const listedCount = (out.match(/🏠 New booking:/g) ?? []).length;
    expect(listedCount).toBe(5);
    expect(out).toContain("…and 2 more");
  });
});

describe("check_alerts — floor-hälytys", () => {
  it("mock-datasta korotetulla AVG_TURNOVER_COSTilla syntyy floor-hälytys", async () => {
    const e = { ...env, AVG_TURNOVER_COST: "200" } as NodeJS.ProcessEnv;
    const out = await runCheckAlerts({ send: false }, e, { now: NOW });

    expect(out).toContain("priced below your cost floor — run propose_decisions to review.");
    expect(out).toMatch(/⚠️ \d+ gap nights? on \d+ propert(y|ies)/);
  });

  it("all clear kun ei floor-hälytystä eikä uusia varauksia (toinen ajo, sama data)", async () => {
    const base = [
      res({ reservation_id: "r1", checkin: "2026-06-01", checkout: "2026-07-01", nights: 30, gross_revenue: 3000 }),
    ];
    await runCheckAlerts({ send: false }, env, { reservationSource: sourceReturning(base), now: NOW });
    const out = await runCheckAlerts({ send: false }, env, { reservationSource: sourceReturning(base), now: NOW });

    expect(out).toBe("All clear — no gap nights below floor, no new bookings since the last check.");
  });
});

describe("check_alerts — send-parametri ja notify-integraatio", () => {
  it("send=false ei kutsu fetchiä vaikka webhook on konfiguroitu", async () => {
    const e = { ...env, NM_WEBHOOK_URL: "https://hooks.example.com/incoming" } as NodeJS.ProcessEnv;
    const { fetchImpl, calls } = capturingFetch();

    await runCheckAlerts({ send: false }, e, { now: NOW, fetchImpl });

    expect(calls).toHaveLength(0);
  });

  it("send=true (oletus) lähettää raportin konfiguroituun webhookiin ja kertoo sen tulosteessa", async () => {
    const e = { ...env, NM_WEBHOOK_URL: "https://hooks.example.com/incoming" } as NodeJS.ProcessEnv;
    const { fetchImpl, calls } = capturingFetch();

    const out = await runCheckAlerts({}, e, { now: NOW, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body).text).toBe(out.replace(/\n\nSent via webhook\.$/, ""));
    expect(out).toContain("Sent via webhook.");
  });

  it("ei kanavaa konfiguroitu → tulosteessa kerrotaan syy eikä yritetä lähettää turhaan", async () => {
    const out = await runCheckAlerts({}, env, { now: NOW });
    expect(out).toContain("Not sent: no notification channel configured");
  });
});

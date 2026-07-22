import { describe, expect, it } from "vitest";
import { type NotifyFetch, sendNotification } from "../src/notify.js";

/**
 * notify.ts-testit — EI verkkoa: fake-fetch kaappaa kutsut. Telegramin
 * endpoint on kiinteä, dokumentoitu julkinen API (kuten wheelhouse/client.ts:n
 * api.usewheelhouse.com) — sallittu literaali. Webhook-URL sen sijaan on
 * käyttäjän oma konfiguraatio, joten testeissä käytetään RFC 2606
 * example.com-verkkotunnusta (sama käytäntö kuin test/sources.test.ts:ssä).
 */

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function capturing(respond: (c: Captured) => { ok: boolean; status: number }) {
  const calls: Captured[] = [];
  const fetchImpl: NotifyFetch = async (url, init) => {
    const call: Captured = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    return respond(call);
  };
  return { fetchImpl, calls };
}

describe("sendNotification — telegram", () => {
  it("täsmälleen oikea payload kun sekä token että chat id on asetettu", async () => {
    const { fetchImpl, calls } = capturing(() => ({ ok: true, status: 200 }));
    const env = { NM_TELEGRAM_BOT_TOKEN: "tok123", NM_TELEGRAM_CHAT_ID: "chat456" } as NodeJS.ProcessEnv;

    const result = await sendNotification("hello there", env, fetchImpl);

    expect(result).toEqual({ sent: true, via: "telegram" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.telegram.org/bottok123/sendMessage");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body)).toEqual({ chat_id: "chat456", text: "hello there" });
  });

  it("ottaa etusijan webhookiin nähden kun molemmat on konfiguroitu", async () => {
    const { fetchImpl, calls } = capturing(() => ({ ok: true, status: 200 }));
    const env = {
      NM_TELEGRAM_BOT_TOKEN: "tok",
      NM_TELEGRAM_CHAT_ID: "chat",
      NM_WEBHOOK_URL: "https://hooks.example.com/incoming/should-not-be-called",
    } as NodeJS.ProcessEnv;

    const result = await sendNotification("hi", env, fetchImpl);

    expect(result.via).toBe("telegram");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("api.telegram.org");
  });

  it("HTTP-virhe → sent:false, ei heitä, ei tokenia note-kentässä", async () => {
    const { fetchImpl } = capturing(() => ({ ok: false, status: 401 }));
    const env = {
      NM_TELEGRAM_BOT_TOKEN: "super-secret-token",
      NM_TELEGRAM_CHAT_ID: "chat",
    } as NodeJS.ProcessEnv;

    const result = await sendNotification("hello", env, fetchImpl);

    expect(result.sent).toBe(false);
    expect(result.note).toContain("401");
    expect(result.note).not.toContain("super-secret-token");
  });

  it("verkkovirhe (fetch heittää) → sent:false, ei heitä, ei tokenia/URL:ia note-kentässä", async () => {
    const throwingFetch: NotifyFetch = async () => {
      throw new Error("connect ECONNREFUSED https://api.telegram.org/botsuper-secret-token/sendMessage");
    };
    const env = {
      NM_TELEGRAM_BOT_TOKEN: "super-secret-token",
      NM_TELEGRAM_CHAT_ID: "chat",
    } as NodeJS.ProcessEnv;

    await expect(sendNotification("hello", env, throwingFetch)).resolves.toEqual({
      sent: false,
      note: "Telegram notification failed (network error)",
    });
  });
});

describe("sendNotification — webhook", () => {
  it("{text} JSON-body kun vain NM_WEBHOOK_URL on asetettu", async () => {
    const { fetchImpl, calls } = capturing(() => ({ ok: true, status: 200 }));
    const env = { NM_WEBHOOK_URL: "https://hooks.example.com/incoming/T00/B00/xyz" } as NodeJS.ProcessEnv;

    const result = await sendNotification("hello webhook", env, fetchImpl);

    expect(result).toEqual({ sent: true, via: "webhook" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://hooks.example.com/incoming/T00/B00/xyz");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body)).toEqual({ text: "hello webhook" });
  });

  it("HTTP-virhe → sent:false statuksella, ei heitä", async () => {
    const { fetchImpl } = capturing(() => ({ ok: false, status: 500 }));
    const env = { NM_WEBHOOK_URL: "https://hooks.example.com/incoming" } as NodeJS.ProcessEnv;

    const result = await sendNotification("hello", env, fetchImpl);

    expect(result.sent).toBe(false);
    expect(result.note).toContain("500");
  });

  it("verkkovirhe → sent:false, ei heitä, ei URL:ia note-kentässä", async () => {
    const throwingFetch: NotifyFetch = async () => {
      throw new Error("fetch failed: https://hooks.example.com/incoming?token=abc");
    };
    const env = { NM_WEBHOOK_URL: "https://hooks.example.com/incoming?token=abc" } as NodeJS.ProcessEnv;

    const result = await sendNotification("hello", env, throwingFetch);

    expect(result.sent).toBe(false);
    expect(result.note).not.toContain("token=abc");
  });
});

describe("sendNotification — ei kanavaa konfiguroitu", () => {
  it("sent:false selkeällä note-kentällä, fetchiä ei kutsuta", async () => {
    const { fetchImpl, calls } = capturing(() => ({ ok: true, status: 200 }));

    const result = await sendNotification("hello", {} as NodeJS.ProcessEnv, fetchImpl);

    expect(result.sent).toBe(false);
    expect(result.note).toMatch(/no notification channel configured/);
    expect(result.note).toContain("NM_TELEGRAM");
    expect(result.note).toContain("NM_WEBHOOK_URL");
    expect(calls).toHaveLength(0);
  });

  it("tyhjät/whitespace-arvot lasketaan konfiguroimattomiksi", async () => {
    const { fetchImpl, calls } = capturing(() => ({ ok: true, status: 200 }));
    const env = {
      NM_TELEGRAM_BOT_TOKEN: "   ",
      NM_TELEGRAM_CHAT_ID: "   ",
      NM_WEBHOOK_URL: "   ",
    } as NodeJS.ProcessEnv;

    const result = await sendNotification("hello", env, fetchImpl);

    expect(result.sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("puuttuva chat id vaikka token on asetettu → ei telegramia eikä webhookia", async () => {
    const { fetchImpl, calls } = capturing(() => ({ ok: true, status: 200 }));
    const env = { NM_TELEGRAM_BOT_TOKEN: "tok" } as NodeJS.ProcessEnv;

    const result = await sendNotification("hello", env, fetchImpl);

    expect(result.sent).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("sendNotification — oletus-fetchImpl", () => {
  it("ei heitä kun kanavaa ei ole konfiguroitu (ei kutsu globaalia fetchiä ollenkaan)", async () => {
    await expect(sendNotification("hello", {} as NodeJS.ProcessEnv)).resolves.toEqual({
      sent: false,
      note: "no notification channel configured (set NM_TELEGRAM_BOT_TOKEN + NM_TELEGRAM_CHAT_ID, or NM_WEBHOOK_URL)",
    });
  });
});

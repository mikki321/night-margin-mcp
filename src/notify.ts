/**
 * Valinnaiset ulosmenevät ilmoitukset check_alertsille: Telegram-botti tai
 * geneerinen incoming webhook (Slack-yhteensopiva JSON-body {text}).
 * Oletuksena POIS — sendNotification lähettää vain kun asiaankuuluvat
 * ympäristömuuttujat on asetettu (turvasääntö: notify ei aktivoidu itsestään).
 * Ei KOSKAAN heitä: epäonnistunut lähetys raportoidaan paluuarvossa, ei
 * poikkeuksena, eikä token/URL koskaan päädy paluuarvon note-kenttään
 * (salaisuudet — ei repoon, ei lokeihin, ei virheviesteihin).
 */

export type NotifyFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface NotifyResult {
  sent: boolean;
  via?: "telegram" | "webhook";
  note?: string;
}

export async function sendNotification(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: NotifyFetch = fetch as unknown as NotifyFetch,
): Promise<NotifyResult> {
  const token = env.NM_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.NM_TELEGRAM_CHAT_ID?.trim();
  if (token && chatId) {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        return { sent: false, note: `Telegram notification failed (HTTP ${res.status})` };
      }
      return { sent: true, via: "telegram" };
    } catch {
      // EI koskaan käytetä kiinniotetun virheen .message-kenttää — se voi
      // sisältää pyynnön URL:n (ja siten botin tokenin). Syy pidetään geneerisenä.
      return { sent: false, note: "Telegram notification failed (network error)" };
    }
  }

  const webhookUrl = env.NM_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    try {
      const res = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        return { sent: false, note: `Webhook notification failed (HTTP ${res.status})` };
      }
      return { sent: true, via: "webhook" };
    } catch {
      return { sent: false, note: "Webhook notification failed (network error)" };
    }
  }

  return {
    sent: false,
    note: "no notification channel configured (set NM_TELEGRAM_BOT_TOKEN + NM_TELEGRAM_CHAT_ID, or NM_WEBHOOK_URL)",
  };
}

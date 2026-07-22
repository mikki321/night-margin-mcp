/**
 * Paikallinen UI-serveri: tarjoilee web/-sivun ja ohuen JSON-API:n samojen
 * dist/-moduulien päälle joita MCP-toolit käyttävät. EI riippuvuuksia
 * (node:http). Kuuntelee VAIN 127.0.0.1:ssa — tämä on omistajan oma
 * paikallinen työkalu, ei hostattava palvelu.
 *
 * Turvasäännöt:
 * - Mikään vastaus ei koskaan sisällä env-arvoja (avaimet/tokenit/URLit) —
 *   /api/health kertoo vain booleanit (mode, notify_configured).
 * - Kirjoitukset (apply/revert) vain POST + body.confirm === true; ilman
 *   confirmia toolit palauttavat dry-run-esikatselun eivätkä kirjoita mitään.
 * - Host-otsake tarkistetaan (DNS rebinding -suoja) ja POST-bodyn on oltava
 *   JSON — selaimen no-cors-pyyntö ei voi laukaista kirjoituksia.
 * - Stderriin lokitetaan vain metodi + polku.
 *
 * Käyttö: node scripts/ui-server.mjs   (env: NM_UI_PORT yliajaa portin 8788)
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = join(ROOT, "web");
const PORT = Number(process.env.NM_UI_PORT) > 0 ? Number(process.env.NM_UI_PORT) : 8788;
const HOST = "127.0.0.1";

/* dist/-importit pathToFileURL:llä — repopolussa on välilyönti, joten pelkkä
 * merkkijonopolku import()-kutsussa hajoaisi; file://-URL enkoodaa sen oikein. */
const dist = (p) => import(pathToFileURL(join(ROOT, "dist", p)).href);
const [config, calc, sources, reservationSourceMod, resolveCostsMod, state, propose, apply, revert, setTarget, checkAlerts, whClient, whAdapter] =
  await Promise.all([
    dist("config.js"),
    dist("core/calc.js"),
    dist("sources/index.js"),
    dist("sources/reservationSource.js"),
    dist("sources/resolveCosts.js"),
    dist("state.js"),
    dist("tools/proposeDecisions.js"),
    dist("tools/applyDecision.js"),
    dist("tools/revertDecision.js"),
    dist("tools/setTarget.js"),
    dist("tools/checkAlerts.js"),
    dist("wheelhouse/client.js"),
    dist("wheelhouse/adapter.js"),
  ]);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const RISKS = new Set(["conservative", "recommended", "aggressive"]);
const DECISION_ID_RE = /^d\d+$/;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

/** Virhe → {error} + statuskoodi. Viestit tulevat tooleilta, jotka eivät
 *  koskaan upota env-arvoja virheviesteihin (ks. notify.ts, client). */
function errorStatus(message) {
  if (/not found|disappeared/i.test(message)) return 404;
  if (/locked by another|has not been applied|cannot be applied|requires WHEELHOUSE_API_KEY/i.test(message)) return 409;
  if (/invalid|use the format|must be a positive|is not a valid number/i.test(message)) return 400;
  return 500;
}

class BadRequest extends Error {}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new BadRequest("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      /* Content-Type-portti ENNEN tyhjän bodyn oikopolkua: KAIKKI POSTit
       * vaativat application/json:in, myös bodyttömät. Selaimen no-cors-pyyntö
       * ei voi asettaa tätä otsaketta → tyhjä no-cors-POST ei pääse
       * handlereihin asti (propose/alerts kirjoittavat paikallista tilaa). */
      const ctype = String(req.headers["content-type"] ?? "");
      if (!ctype.toLowerCase().includes("application/json")) {
        return reject(new BadRequest("POST bodies must be JSON (Content-Type: application/json)"));
      }
      if (raw === "") return resolvePromise({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new BadRequest("POST body must be a JSON object"));
        }
        resolvePromise(parsed);
      } catch {
        reject(new BadRequest("POST body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requireDateParam(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    throw new BadRequest(`Invalid ${name}: use the format YYYY-MM-DD`);
  }
  return value;
}

/* Yksi pitkäikäinen lähdepari koko serverin elinajaksi: live-tilassa KAIKKI
 * HTTP-pyynnöt jakavat saman WheelhouseClientin — yksi tahdistus
 * (MIN_INTERVAL_MS) ja yksi 10 min GET-cache. Uusi client per pyyntö antaisi
 * jokaiselle rinnakkaiselle pyynnölle oman tyhjän cachen ja oman tahdistuksen,
 * mikä ohittaisi clientin "sarjassa, ei fan-outia" -budjetin. Laiska luonti:
 * env-virhe (esim. viallinen COST_SOURCE) ei kaada serveriä käynnistyksessä
 * vaan palautuu pyynnön virheenä. */
let sharedSources = null;
function getSources() {
  if (!sharedSources) {
    /* Live-tilassa client rakennetaan TÄSSÄ (sama resepti kuin
     * reservationSourceFromEnv: avain + WHEELHOUSE_API_URL + WHEELHOUSE_CHANNEL
     * lukuyliajona) ja pidetään käsissä, jotta myös POST-toimintopolut
     * (propose/targets/alerts) saavat SAMAN clientin deps-injektiolla —
     * toolien oma env-fallback loisi joka klikkaukselle uuden clientin
     * kylmällä cachella ja omalla tahdistuksella. Demo-tilassa client on
     * undefined ja lähde on mock, kuten ennenkin. */
    const key = process.env.WHEELHOUSE_API_KEY?.trim();
    const client = key
      ? new whClient.WheelhouseClient({ apiKey: key, baseUrl: process.env.WHEELHOUSE_API_URL })
      : undefined;
    sharedSources = {
      client,
      reservations: client
        ? whAdapter.wheelhouseReservations(client, { channel: process.env.WHEELHOUSE_CHANNEL })
        : reservationSourceMod.reservationSourceFromEnv(process.env),
      costs: sources.costSourceFromEnv(process.env),
    };
  }
  return sharedSources;
}

/** Sama datapolku kuin analyze_portfolio-tool ja web/data.json-generaattori. */
async function buildAnalysis(fromParam, toParam) {
  const { from, to } = config.resolveWindow(fromParam, toParam);
  const { reservations: reservationSource, costs: costSource } = getSources();
  const reservations = await reservationSource.getReservations(from, to);
  const allPropertyIds = reservationSource.listPropertyIds
    ? await reservationSource.listPropertyIds()
    : undefined;
  const { costs, matchNote } = await resolveCostsMod.resolveCosts(
    costSource,
    reservations,
    from,
    to,
    resolveCostsMod.avgFallbackFromEnv(process.env),
  );
  const analysis = calc.analyzePortfolio(reservations, costs, from, to, allPropertyIds);
  return {
    generated_at: new Date().toISOString(),
    window: { from, to },
    sources: {
      reservations: reservationSource.label,
      costs: costSource.label,
      attribution: matchNote ?? "",
    },
    analysis,
  };
}

function isLive() {
  return Boolean(process.env.WHEELHOUSE_API_KEY?.trim());
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/api/health" && method === "GET") {
    return json(res, 200, {
      ok: true,
      version: pkg.version,
      mode: isLive() ? "live" : "demo",
      /* VAIN boolean — kanavan tokenit/URLit eivät koskaan päädy vastaukseen. */
      notify_configured: Boolean(
        (process.env.NM_TELEGRAM_BOT_TOKEN?.trim() && process.env.NM_TELEGRAM_CHAT_ID?.trim()) ||
          process.env.NM_WEBHOOK_URL?.trim(),
      ),
    });
  }

  if (path === "/api/analysis" && method === "GET") {
    const from = requireDateParam(url.searchParams.get("from") ?? undefined, "from");
    const to = requireDateParam(url.searchParams.get("to") ?? undefined, "to");
    return json(res, 200, await buildAnalysis(from, to));
  }

  if (path === "/api/decisions" && method === "GET") {
    return json(res, 200, { decisions: state.readDecisions(process.env) });
  }

  if (path === "/api/propose" && method === "POST") {
    const body = await readBody(req);
    const from = requireDateParam(body.from, "from");
    const to = requireDateParam(body.to, "to");
    let risk;
    if (body.risk !== undefined) {
      if (typeof body.risk !== "string" || !RISKS.has(body.risk)) {
        throw new BadRequest('Invalid risk: use "conservative", "recommended" or "aggressive"');
      }
      risk = body.risk;
    }
    /* Jaettu lähde + client deps-injektiolla — ilman niitä tool rakentaisi
     * oman clientin (kylmä cache, oma tahdistus) ja hakisi saman live-datan
     * uudelleen jonka dashboard juuri cachetti (85–140 s stalli per klikkaus). */
    const src = getSources();
    const text = await propose.runProposeDecisions(
      { from, to, risk },
      process.env,
      { client: src.client, reservationSource: src.reservations },
    );
    return json(res, 200, { text, decisions: state.readDecisions(process.env) });
  }

  const decisionAction = /^\/api\/decisions\/([^/]+)\/(apply|revert)$/.exec(path);
  if (decisionAction && method === "POST") {
    const decisionId = decodeURIComponent(decisionAction[1]);
    if (!DECISION_ID_RE.test(decisionId)) {
      throw new BadRequest('Invalid decision id: use the form "d1", "d2", …');
    }
    const body = await readBody(req);
    /* KIRJOITUS VAIN kun body.confirm === true (tiukka boolean-vertailu) —
     * kaikki muu on toolien oma dry-run/esikatselupolku. */
    const confirm = body.confirm === true;
    const text =
      decisionAction[2] === "apply"
        ? await apply.runApplyDecision({ decision_id: decisionId, confirm })
        : await revert.runRevertDecision({ decision_id: decisionId, confirm });
    return json(res, 200, { text, confirmed: confirm, decisions: state.readDecisions(process.env) });
  }

  if (path === "/api/targets" && method === "GET") {
    return json(res, 200, { targets: state.readTargets(process.env) });
  }

  if (path === "/api/targets" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.property_id !== "string" || body.property_id.trim() === "") {
      throw new BadRequest("Invalid property_id: pass the property id string from the analysis");
    }
    if (typeof body.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month)) {
      throw new BadRequest("Invalid month: use the format YYYY-MM");
    }
    const gross = Number(body.gross_target);
    if (!Number.isFinite(gross) || gross <= 0) {
      throw new BadRequest("Invalid gross_target: must be a positive amount in euros");
    }
    /* Sama jaettu varauslähde kuin GET-reiteillä — toolin oma
     * reservationSourceFromEnv-fallback ohittaisi 10 min cachen ja tahdistuksen. */
    const text = await setTarget.runSetTarget(
      {
        property_id: body.property_id.trim(),
        month: body.month,
        gross_target: gross,
      },
      process.env,
      { reservationSource: getSources().reservations },
    );
    return json(res, 200, { text, targets: state.readTargets(process.env) });
  }

  /* Kuukausitavoitteiden toteumat YHDELLÄ varaushaulla koko jaksolle — ei
   * per-kuukausi-fan-outia /api/analysisiin (6 rinnakkaista hakua tarkoitti
   * live-tilassa minuuttien odotusta). Viipalointi kuukausiin käyttää samaa
   * kohdistussääntöä kuin set_target-tool (propertyGrossInWindow), joten
   * luvut täsmäävät toolin tulosteeseen. Read-only — ei kirjoita mitään. */
  if (path === "/api/target-actuals" && method === "GET") {
    const raw = url.searchParams.get("months") ?? "";
    const months = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (months.length === 0 || months.length > 24) {
      throw new BadRequest("Invalid months: pass 1–24 comma-separated YYYY-MM values");
    }
    const bounds = months.map((m) => {
      if (!MONTH_RE.test(m)) throw new BadRequest(`Invalid month "${m}": use the format YYYY-MM`);
      return setTarget.monthWindow(m);
    });
    const from = bounds.reduce((a, b) => (b.from < a ? b.from : a), bounds[0].from);
    const to = bounds.reduce((a, b) => (b.to > a ? b.to : a), bounds[0].to);
    const reservations = await getSources().reservations.getReservations(from, to);
    const propertyIds = [...new Set(reservations.map((r) => r.property_id))];
    const grossByMonth = {};
    months.forEach((m, i) => {
      const byProperty = {};
      for (const pid of propertyIds) {
        byProperty[pid] = setTarget.propertyGrossInWindow(reservations, pid, bounds[i].from, bounds[i].to);
      }
      grossByMonth[m] = byProperty;
    });
    return json(res, 200, { window: { from, to }, months: grossByMonth });
  }

  /* POST, EI GET: runCheckAlerts KIRJOITTAA seen_bookings.json:iin (baseline
   * ensimmäisellä ajolla; myöhemmin uudet varaukset merkitään nähdyiksi).
   * GET ei saa koskaan kirjoittaa — muuten curl/linkkiprefetcher kuluttaisi
   * hiljaa "uusi varaus" -tapahtumat ilmoituskanavalta. */
  if (path === "/api/alerts" && method === "POST") {
    await readBody(req); // sama JSON-body-portti kuin muilla POST-reiteillä
    /* Jaettu lähde + client — floor-tarkistus ja uusien varausten haku
     * osuvat dashboardin jo lämmittämään cacheen live-tilassa. */
    const src = getSources();
    const text = await checkAlerts.runCheckAlerts(
      { send: false },
      process.env,
      { client: src.client, reservationSource: src.reservations },
    );
    return json(res, 200, { text });
  }

  return json(res, 404, { error: `Unknown API endpoint: ${method} ${path}` });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = resolve(WEB_DIR, `.${rel}`);
  /* Polkutraversaali-suoja: vain web/-hakemiston sisältö tarjoillaan. */
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + "/")) {
    return json(res, 403, { error: "Forbidden" });
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    return json(res, 404, { error: `Not found: ${url.pathname}` });
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(readFileSync(file));
}

/** DNS rebinding -suoja: hyväksy vain paikalliset Host-otsakkeet. */
function hostAllowed(req) {
  const host = String(req.headers.host ?? "").toLowerCase();
  const bare = host.replace(/:\d+$/, "");
  return bare === "127.0.0.1" || bare === "localhost" || bare === "[::1]";
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  /* Lokiin VAIN metodi + polku — ei queryä, ei bodyä, ei otsakkeita. */
  console.error(`${req.method} ${url.pathname}`);

  try {
    if (!hostAllowed(req)) {
      return json(res, 403, { error: "Forbidden host" });
    }
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "POST") {
        return json(res, 405, { error: `Method ${req.method} not allowed` });
      }
      return await handleApi(req, res, url);
    }
    if (req.method !== "GET") {
      return json(res, 405, { error: `Method ${req.method} not allowed` });
    }
    return serveStatic(req, res, url);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof BadRequest ? 400 : errorStatus(message);
    if (!res.headersSent) return json(res, status, { error: message });
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.error(
    `night-margin UI: http://${HOST}:${PORT} (${isLive() ? "live" : "demo"} mode, v${pkg.version}) — local only`,
  );
});

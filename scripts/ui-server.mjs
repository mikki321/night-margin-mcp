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
const [config, calc, sources, reservationSourceMod, resolveCostsMod, state, propose, apply, revert, setTarget, checkAlerts, whClient, whAdapter, simulate, risk, gapCheck] =
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
    dist("core/simulate.js"),
    dist("core/risk.js"),
    dist("tools/gapNightCheck.js"),
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

/* ======================= Month plan =======================
 *
 * GET /api/month-plan?property_id&month=YYYY-MM&risk=… kokoaa YHDEN vastauksen:
 * toteutunut myynti päivittäin, jäljellä olevat aukkoyöt hintapohjineen,
 * alueen konteksti (neighborhood pricing + occupancy), kolme kumulatiivista
 * projektiota kuun loppuun ja kuukausihistoria (kpis/monthly).
 *
 * REHELLISYYSSÄÄNTÖ: jokainen projektio kantaa assumptions-listan — mistä
 * täyttöoletus tulee, mistä yöhinnat tulevat, miten netto on arvioitu. UI
 * näyttää ne graafin alla; mikään luku ei esiinny ilman lähdettään.
 *
 * Live-tila hakee VAIN tämän listingin datan (5 GET-kutsua sarjassa clientin
 * tahdistuksella ≈ 5–15 s kylmänä) — ei koko portfolion varaushakuja. Vastaus
 * cachetetaan 10 min per property+month+risk; clientin oma GET-cache kattaa
 * saman ajan, joten risk-vaihto lasketaan uudelleen ilman uusia verkkokutsuja.
 */
const PLAN_TTL_MS = 10 * 60_000;
const planCache = new Map(); // "pid\u0000month\u0000risk" → { at, body }

const MS_PER_DAY = 86_400_000;
const isoFromMs = (t) => new Date(t).toISOString().slice(0, 10);
const utcTodayIso = () => new Date().toISOString().slice(0, 10);
const sumOf = (arr) => arr.reduce((a, b) => a + b, 0);
const avgOf = (arr) => (arr.length ? sumOf(arr) / arr.length : 0);
const round50 = (n) => Math.round(n / 50) * 50;

function monthDayList(from, to) {
  const out = [];
  for (let t = calc.parseISODate(from); t < calc.parseISODate(to); t += MS_PER_DAY) out.push(isoFromMs(t));
  return out;
}

async function buildMonthPlan(propertyId, month, riskChoice) {
  const { from, to } = setTarget.monthWindow(month);
  const today = utcTodayIso();
  const days = monthDayList(from, to);
  const src = getSources();
  const live = Boolean(src.client);

  /* -- Kohde + sen varaukset --------------------------------------------
   * Live: YHDEN listingin varaukset suoraan (koko portfolion serial-haku
   * veisi minuutteja). Sama nimisääntö kuin analyysissä: nickname → title
   * → id (listingFromDocumented). Demo: jaettu mock-lähde suodatettuna. */
  let listing = null;
  let channel = null;
  let currency = "EUR";
  let reservations;
  if (live) {
    const listings = (await src.client.listListings()).filter((l) => l.is_active !== false);
    listing = listings.find((l) => whAdapter.listingFromDocumented(l) === propertyId) ?? null;
    if (!listing) {
      const known = listings.map((l) => whAdapter.listingFromDocumented(l)).sort();
      throw new Error(
        `Property "${propertyId}" not found among Wheelhouse listings. Known properties` +
          `${known.length > 10 ? ` (showing 10 of ${known.length})` : ""}: ${known.slice(0, 10).join(", ")}`,
      );
    }
    channel = whAdapter.channelForListing(listing, process.env.WHEELHOUSE_CHANNEL);
    currency = listing.currency?.trim() || "EUR";
    const raw = await src.client.listReservationsRaw(listing.id, channel);
    reservations = whAdapter.parseReservations(raw).map((r) => ({ ...r, property_id: propertyId }));
  } else {
    const trailingFrom = isoFromMs(calc.parseISODate(today) - 120 * MS_PER_DAY);
    const windowFrom = trailingFrom < from ? trailingFrom : from;
    const all = await src.reservations.getReservations(windowFrom, to);
    reservations = all.filter((r) => r.property_id === propertyId);
    if (reservations.length === 0) {
      const known = src.reservations.listPropertyIds
        ? await src.reservations.listPropertyIds()
        : [...new Set(all.map((r) => r.property_id))].sort();
      if (!known.includes(propertyId)) {
        throw new Error(
          `Property "${propertyId}" not found in the reservation data. Known properties` +
            `${known.length > 10 ? ` (showing 10 of ${known.length})` : ""}: ${known.slice(0, 10).join(", ")}`,
        );
      }
    }
  }

  /* -- Kuukauden päivittäinen varattu brutto ----------------------------
   * Sama kohdistussääntö kuin core/calc.ts: liikevaihto suhteutetaan öihin
   * (gross/nights per yö), yö kuuluu alkupäivälleen, `to` eksklusiivinen. */
  const monthRes = reservations.filter((r) => r.checkin < to && r.checkout > from && r.nights > 0);
  const dailyGross = days.map((d) =>
    sumOf(monthRes.filter((r) => r.checkin <= d && d < r.checkout).map((r) => r.gross_revenue / r.nights)),
  );
  const dailyNights = days.map((d) => monthRes.filter((r) => r.checkin <= d && d < r.checkout).length);
  const bookedCum = [];
  {
    let acc = 0;
    for (const g of dailyGross) {
      acc += g;
      bookedCum.push(acc);
    }
  }
  const firstFutureIdx = days.findIndex((d) => d >= today);
  const pastCount = firstFutureIdx === -1 ? days.length : firstFutureIdx; // päiviä jo eletty tästä kuusta
  const actualCum = days.map((_, i) => (i < pastCount ? Math.round(bookedCum[i]) : null));
  const bookedToDateGross = pastCount > 0 ? bookedCum[pastCount - 1] : 0;
  const bookedAheadGross = (bookedCum[days.length - 1] ?? 0) - bookedToDateGross;
  const gapStart = pastCount < days.length ? days[pastCount] : null; // null → kuukausi on jo ohi

  /* Jäljellä olevat aukkoyöt: [max(tänään, kuun alku), kuun loppu) — sama
   * yömääritelmä kuin core/decisions.gapNightsByProperty. */
  const gapDates = [];
  for (let i = pastCount; i < days.length; i++) if (dailyNights[i] === 0) gapDates.push(days[i]);

  /* -- Kustannuslattia (risk-skaalattu) --------------------------------- */
  const costSource = sources.costSourceFromEnv(process.env);
  let costRows = [];
  let costsById = new Map();
  let costNote = null;
  try {
    const resolved = await resolveCostsMod.resolveCosts(
      costSource,
      monthRes,
      from,
      to,
      resolveCostsMod.avgFallbackFromEnv(process.env),
    );
    costsById = resolved.costs;
    costRows = monthRes.map((r) => costsById.get(r.reservation_id)).filter((c) => c !== undefined);
  } catch (e) {
    costNote = `cost rows unavailable (${e instanceof Error ? e.message : String(e)})`;
  }
  const manualAvg = config.avgTurnoverCost(process.env);
  const est = gapCheck.estimateTurnover(costRows, manualAvg);
  const margin = risk.riskAdjustedMargin(config.minMargin(process.env), riskChoice);
  const floor = Math.ceil(calc.gapNightFloor(est.turnover, est.travel, margin));
  const perNightCost = est.turnover + est.travel;
  const turnoverBasis = est.fromRows
    ? `median of ${est.rowCount} cost row${est.rowCount === 1 ? "" : "s"} (${costSource.label})`
    : `manual average €${manualAvg} (AVG_TURNOVER_COST)${costNote ? ` — ${costNote}` : ""}`;

  /* -- WH-hintasuositukset + min-stay -----------------------------------
   * price_recommendations RAAKANA clientin requestilla (sama endpoint kuin
   * client.priceRecommendations, mutta tarvitsemme myös top-level-kentät).
   * Muoto verifioitu curlilla 23.7.2026 (listing 483611): {data:[{stay_date,
   * price, currency, custom_type}], base_price, base_price_recommended,
   * base_price_conservative, base_price_aggressive, global_min_stay,
   * automatic_rate_posting_enabled} — data kattaa vain ~30 pv eteenpäin;
   * per-rivin min_stay-kenttää EI tullut tällä tilillä (luetaan jos joskus
   * tulee, muuten min-stay = global_min_stay). */
  const recByDate = new Map();
  let globalMinStay = null;
  let recNote = null;
  let adr = monthRes.length ? sumOf(monthRes.map((r) => r.gross_revenue)) / sumOf(monthRes.map((r) => r.nights)) : 0;
  if (!(adr > 0)) {
    const rest = reservations.filter((r) => r.nights > 0);
    adr = rest.length ? sumOf(rest.map((r) => r.gross_revenue)) / sumOf(rest.map((r) => r.nights)) : 0;
  }
  if (live) {
    try {
      const body = await src.client.request(
        `/listings/${listing.id}/price_recommendations?channel=${encodeURIComponent(channel)}`,
      );
      for (const r0 of body?.data ?? []) {
        if (r0 && typeof r0.stay_date === "string" && typeof r0.price === "number") {
          recByDate.set(r0.stay_date, {
            price: r0.price,
            min_stay: typeof r0.min_stay === "number" ? r0.min_stay : null,
          });
        }
      }
      globalMinStay = typeof body?.global_min_stay === "number" ? body.global_min_stay : null;
    } catch (e) {
      recNote = `Wheelhouse price recommendations unavailable (${e instanceof Error ? e.message : String(e)})`;
    }
  }

  /* -- Alueen konteksti -------------------------------------------------- */
  const area = { pricing: null, occupancy: null, notes: [] };
  if (live) {
    /* neighborhood/pricing — muoto verifioitu curlilla 23.7.2026 (483611):
     * {currency, data:[{stay_date, median_price, low_price, high_price,
     * listings_count}]}. Rivit alkavat TÄSTÄ PÄIVÄSTÄ ja jatkuvat ~vuoden
     * start/end-parametreista riippumatta → suodatus kuukauteen tässä. */
    try {
      const body = await src.client.request(
        `/listings/${listing.id}/neighborhood/pricing?channel=${encodeURIComponent(channel)}&start_date=${from}&end_date=${to}`,
      );
      const rows = (body?.data ?? []).filter(
        (p) => p && typeof p.stay_date === "string" && p.stay_date >= from && p.stay_date < to,
      );
      area.pricing = rows.map((p) => ({
        date: p.stay_date,
        median: typeof p.median_price === "number" ? p.median_price : null,
        low: typeof p.low_price === "number" ? p.low_price : null,
        high: typeof p.high_price === "number" ? p.high_price : null,
        listings_count: typeof p.listings_count === "number" ? p.listings_count : null,
      }));
      if (rows.length === 0)
        area.notes.push("no neighborhood pricing rows fall inside this month (the API reports from today onwards)");
    } catch (e) {
      area.notes.push(`neighborhood pricing unavailable (${e instanceof Error ? e.message : String(e)})`);
    }
    /* neighborhood/occupancy — muoto verifioitu OMALLA curlilla 23.7.2026
     * (tehtävänannon mukaisesti; listing 483611): {data:[{stay_date,
     * occupancy, adjusted_occupancy, expected_bookings, expected_bookings_sd,
     * observed_bookings, calendar_nights}]} — occupancy on OSUUS 0..1
     * (esim. 0.1158); rivit alkavat tästä päivästä ja jatkuvat ~vuoden,
     * range-parametrit eivät rajaa vastausta → suodatus kuukauteen tässä. */
    try {
      const body = await src.client.request(
        `/listings/${listing.id}/neighborhood/occupancy?channel=${encodeURIComponent(channel)}&start_date=${from}&end_date=${to}`,
      );
      const rows = (body?.data ?? []).filter(
        (o) => o && typeof o.stay_date === "string" && o.stay_date >= from && o.stay_date < to && typeof o.occupancy === "number",
      );
      area.occupancy = rows.map((o) => ({
        date: o.stay_date,
        occupancy: o.occupancy,
        adjusted_occupancy: typeof o.adjusted_occupancy === "number" ? o.adjusted_occupancy : null,
        calendar_nights: typeof o.calendar_nights === "number" ? o.calendar_nights : null,
      }));
      if (rows.length === 0) area.notes.push("no neighborhood occupancy rows fall inside this month");
    } catch (e) {
      area.notes.push(`neighborhood occupancy unavailable (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    area.notes.push("neighborhood pricing and occupancy require WHEELHOUSE_API_KEY (live mode)");
  }

  /* -- Täyttöoletus: lähdekaskadi, lähde AINA nimetty --------------------
   * 1) alueen occupancy jäljellä oleville öille, 2) oma trailing 90 pv
   * käyttöaste, 3) konservatiivinen 30 % -oletus. */
  let fill;
  const occRemaining = (area.occupancy ?? []).filter((o) => o.date >= today);
  if (occRemaining.length > 0) {
    const rate = Math.min(1, Math.max(0, avgOf(occRemaining.map((o) => o.occupancy))));
    fill = {
      rate,
      source: `neighborhood occupancy — the comp set is on average ${(rate * 100).toFixed(0)}% booked across the ${occRemaining.length} remaining nights of this month`,
    };
  } else {
    const tFrom = isoFromMs(calc.parseISODate(today) - 90 * MS_PER_DAY);
    const trailingNights = sumOf(reservations.map((r) => calc.overlapNights(r, tFrom, today)));
    if (trailingNights > 0) {
      const rate = Math.min(1, trailingNights / 90);
      fill = {
        rate,
        source: `this property's own trailing 90-day occupancy ${(rate * 100).toFixed(0)}% — no neighborhood occupancy data available`,
      };
    } else {
      fill = {
        rate: 0.3,
        source: "conservative default 30% — no neighborhood occupancy data and no own bookings in the last 90 days",
      };
    }
  }

  /* -- Hintapohja per aukkoyö: WH-suositus → alueen mediaani → oma ADR --- */
  const areaMedianByDate = new Map((area.pricing ?? []).map((p) => [p.date, p.median]));
  let recCount = 0;
  let areaCount = 0;
  let adrCount = 0;
  let unpricedCount = 0;
  const perNight = gapDates.map((d) => {
    const rec = recByDate.get(d);
    let price = null;
    let basis = null;
    if (rec) {
      price = rec.price;
      basis = "wh_recommendation";
      recCount++;
    } else if (typeof areaMedianByDate.get(d) === "number") {
      price = areaMedianByDate.get(d);
      basis = "area_median";
      areaCount++;
    } else if (adr > 0) {
      price = adr;
      basis = "trailing_adr";
      adrCount++;
    } else {
      unpricedCount++;
    }
    return {
      date: d,
      rec_price: rec ? rec.price : null,
      min_stay: rec?.min_stay ?? globalMinStay,
      floor,
      price: price === null ? null : Math.round(price * 100) / 100,
      price_basis: basis,
    };
  });
  const pricedCount = recCount + areaCount + adrCount;
  const priceAssumption =
    gapDates.length === 0
      ? "No open nights left in this month."
      : `Night prices for the ${gapDates.length} open nights: ` +
        [
          recCount > 0 ? `Wheelhouse recommendation for ${recCount}` : "",
          areaCount > 0 ? `area median price for ${areaCount} (beyond the ~30-day recommendation horizon)` : "",
          adrCount > 0
            ? `${live ? "the property's trailing average nightly rate" : "the property's average nightly rate (demo estimate)"} €${Math.round(adr)} for ${adrCount}`
            : "",
          unpricedCount > 0 ? `${unpricedCount} without any price basis (they add €0)` : "",
        ]
          .filter(Boolean)
          .join("; ") +
        ".";
  const costAssumption = `Net estimate = gross − one turnover (€${Math.round(perNightCost)}; ${turnoverBasis}) per filled night — consecutive filled nights that would share a turnover are not netted, so the cost side is conservative.`;

  /* -- Projektiot (kumulatiiviset sarjat kuun loppuun) ------------------- */
  const cumulativeWith = (extraByDate) => {
    const series = [];
    let extra = 0;
    for (let i = 0; i < days.length; i++) {
      extra += extraByDate.get(days[i]) ?? 0;
      series.push(Math.round(bookedCum[i] + extra));
    }
    return series;
  };
  const monthOverNote = gapStart === null ? "This month is already over — nothing left to fill; the projection equals booked gross." : null;

  // a) current pace — aukot × hinta × täyttöoletus
  const paceExtra = new Map();
  let paceExpectedNights = 0;
  for (const n of perNight)
    if (n.price !== null) {
      paceExtra.set(n.date, n.price * fill.rate);
      paceExpectedNights += fill.rate;
    }
  const paceSeries = cumulativeWith(paceExtra);
  const paceGross = paceSeries[paceSeries.length - 1] ?? 0;
  const currentPace = {
    label: "Current pace",
    series: paceSeries,
    end_gross: Math.round(paceGross),
    end_net_estimate: Math.round(paceGross - paceExpectedNights * perNightCost),
    expected_filled_nights: Math.round(paceExpectedNights * 10) / 10,
    assumptions: monthOverNote
      ? [monthOverNote]
      : [
          `Fill assumption: ${(fill.rate * 100).toFixed(0)}% of each open night sells — source: ${fill.source}.`,
          priceAssumption,
          costAssumption,
          "Already-booked nights are taken as final; cancellations are not modelled.",
        ],
  };

  // b) floor guard — sama, mutta hinnat max(hinta, lattia)
  const floorExtra = new Map();
  let floorExpectedNights = 0;
  let raisedNights = 0;
  for (const n of perNight)
    if (n.price !== null) {
      const p = Math.max(n.price, floor);
      if (p > n.price) raisedNights++;
      floorExtra.set(n.date, p * fill.rate);
      floorExpectedNights += fill.rate;
    }
  const floorSeries = cumulativeWith(floorExtra);
  const floorGross = floorSeries[floorSeries.length - 1] ?? 0;
  const floorGuard = {
    label: "Floor guard",
    series: floorSeries,
    end_gross: Math.round(floorGross),
    end_net_estimate: Math.round(floorGross - floorExpectedNights * perNightCost),
    expected_filled_nights: Math.round(floorExpectedNights * 10) / 10,
    assumptions: monthOverNote
      ? [monthOverNote]
      : [
          `Open nights priced below your cost floor are raised to it: max(price, €${floor}) — the floor is turnover + travel + the ${riskChoice} margin (€${margin}), and it raised ${raisedNights} of ${pricedCount} priced nights.`,
          `Fill assumption: ${(fill.rate * 100).toFixed(0)}% of each open night sells — source: ${fill.source}. Applying the same fill rate to raised prices is optimistic: a higher price can also lower the chance the night sells.`,
          priceAssumption,
          costAssumption,
        ],
  };

  // c) fill push — dist/core/simulate.js:n fill-gaps-sääntö: KAIKKI aukot
  // alennushinnalla, 100 % täyttö = yläraja, ei ennuste.
  const pushExtra = new Map();
  const pushCosts = [];
  let pushBasisNote = null;
  let pushPriceNote = null;
  if (gapStart !== null && gapDates.length > 0) {
    let usedSimulate = false;
    try {
      const sim = simulate.simulateFillGaps(monthRes, costsById, gapStart, to, { discountPct: 40 });
      const prefix = `gap-${propertyId}-`;
      for (const r0 of sim.reservations) {
        if (typeof r0.reservation_id === "string" && r0.reservation_id.startsWith(prefix)) {
          pushExtra.set(r0.checkin, r0.gross_revenue);
          const c = sim.costs.get(r0.reservation_id);
          pushCosts.push(c ? calc.totalCost(c) : perNightCost);
        }
      }
      if (pushExtra.size > 0) {
        usedSimulate = true;
        pushBasisNote =
          `Every open night is filled at 40% off the property's average nightly rate in the remaining window ` +
          `(core simulateFillGaps — the same rule as compare_strategies' fill-gaps strategy).`;
        /* Simulaten "viimeistä yötä ei täytetä" -sääntö puree vain jos kuun
         * viimeinen yö on oikeasti auki — jos se on jo varattu, lause kuvaisi
         * sääntöä joka ei osunut tähän kuuhun. */
        if (gapDates.includes(days[days.length - 1])) {
          pushBasisNote +=
            " The last night of the month is left unfilled: its turnover cost would land outside the month.";
        }
      }
    } catch {
      /* ei kustannuspohjaa simulatelle → manuaalinen fallback alla */
    }
    if (!usedSimulate) {
      for (const n of perNight)
        if (n.price !== null) {
          pushExtra.set(n.date, n.price * 0.6);
          pushCosts.push(perNightCost);
        }
      pushBasisNote =
        "Every open night is filled at 40% off its night price (the simulate module needs bookings in the remaining window to estimate an average rate — none found, so per-night prices are discounted directly).";
      /* Fallback diskonttaa per-yö-hintoja → niiden lähde (WH-suositus /
       * aluemediaani / trailing ADR, hinnattomat +0 €) kuuluu mukaan tämänkin
       * projektion assumptions-listaan, ei vain pace/floor-projektioiden. */
      pushPriceNote = priceAssumption;
    }
  }
  const pushSeries = cumulativeWith(pushExtra);
  const pushGross = pushSeries[pushSeries.length - 1] ?? 0;
  const fillPush = {
    label: "Fill push",
    series: pushSeries,
    end_gross: Math.round(pushGross),
    end_net_estimate: Math.round(pushGross - sumOf(pushCosts)),
    expected_filled_nights: pushExtra.size,
    assumptions: monthOverNote
      ? [monthOverNote]
      : [
          "Upper bound — assumes EVERY open night sells at the discounted price; 100% fill is a ceiling, not a forecast.",
          ...(pushBasisNote ? [pushBasisNote] : []),
          ...(pushPriceNote ? [pushPriceNote] : []),
          costAssumption,
        ],
  };

  /* -- Historia: kpis/monthly -------------------------------------------
   * Muoto verifioitu curlilla 23.7.2026 (483611): {currency, data:[{month:
   * "YYYY-MM-01", adr, occupancy, revpar, revenue, comp_set_adr,
   * comp_set_occupancy, comp_set_revenue, …}]} — tällä tilillä historia on
   * enimmäkseen 0/null → sanotaan suoraan "no history yet". */
  const history = { items: [], notes: [] };
  if (live) {
    try {
      const body = await src.client.request(`/listings/${listing.id}/kpis/monthly?channel=${encodeURIComponent(channel)}`);
      const byMonth = new Map((body?.data ?? []).map((k) => [String(k?.month ?? "").slice(0, 7), k]));
      const [y, m] = month.split("-").map(Number);
      const wanted = [{ label: "same month last year", ym: `${y - 1}-${String(m).padStart(2, "0")}` }];
      for (let i = 3; i >= 1; i--) {
        const mm = m - i;
        const yy = mm <= 0 ? y - 1 : y;
        const m2 = ((mm + 11) % 12) + 1;
        wanted.push({ label: `${i} month${i === 1 ? "" : "s"} before`, ym: `${yy}-${String(m2).padStart(2, "0")}` });
      }
      for (const w of wanted) {
        const k = byMonth.get(w.ym);
        if (!k) {
          history.items.push({ month: w.ym, label: w.label, available: false });
          continue;
        }
        const item = {
          month: w.ym,
          label: w.label,
          available: true,
          revenue: typeof k.revenue === "number" ? k.revenue : null,
          adr: typeof k.adr === "number" ? k.adr : null,
          occupancy: typeof k.occupancy === "number" ? k.occupancy : null,
          revpar: typeof k.revpar === "number" ? k.revpar : null,
        };
        /* comp_set vain jos ei-null — tyhjää vertailua ei keksitä. */
        // comp_set vain kun siinä on OIKEAA signaalia — RM API palauttaa
        // comp_set_revenue=0 placeholderina joka riviltä (verifioitu 3 listingiltä),
        // eikä tyhjää vertailua esitetä "verrokit tienasivat nollan" -faktana.
        if (
          k.comp_set_adr != null ||
          k.comp_set_occupancy != null ||
          (typeof k.comp_set_revenue === "number" && k.comp_set_revenue > 0)
        ) {
          item.comp_set = {
            revenue: typeof k.comp_set_revenue === "number" ? k.comp_set_revenue : null,
            adr: typeof k.comp_set_adr === "number" ? k.comp_set_adr : null,
            occupancy: typeof k.comp_set_occupancy === "number" ? k.comp_set_occupancy : null,
          };
        }
        history.items.push(item);
      }
      const anyData = history.items.some(
        (i) => i.available && ((i.revenue ?? 0) > 0 || (i.adr ?? 0) > 0 || (i.occupancy ?? 0) > 0),
      );
      if (!anyData) {
        history.notes.push(
          "No booking history in Wheelhouse monthly KPIs for this listing yet — revenue, ADR and occupancy are zero or empty for the reference months, so there is no past-performance baseline to lean on.",
        );
      }
    } catch (e) {
      history.notes.push(`monthly KPI history unavailable (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    history.notes.push("monthly KPI history requires WHEELHOUSE_API_KEY (live mode)");
  }

  return {
    property_id: propertyId,
    month,
    window: { from, to },
    generated_at: new Date().toISOString(),
    mode: live ? "live" : "demo",
    currency,
    risk: riskChoice,
    today,
    days,
    actual: {
      daily_gross: dailyGross.map((g) => Math.round(g * 100) / 100),
      cum: actualCum,
      booked_cum: bookedCum.map((v) => Math.round(v)),
      booked_to_date_gross: Math.round(bookedToDateGross),
      booked_ahead_gross: Math.round(bookedAheadGross),
      booked_nights_to_date: sumOf(dailyNights.slice(0, pastCount)),
      booked_ahead_nights: sumOf(dailyNights.slice(pastCount)),
    },
    remaining: {
      open_nights: gapDates.length,
      nights: perNight,
      floor,
      floor_components: { turnover: Math.round(est.turnover), travel: Math.round(est.travel), margin },
      turnover_basis: turnoverBasis,
      global_min_stay: globalMinStay,
      ...(recNote ? { rec_note: recNote } : {}),
    },
    area,
    fill: { rate: Math.round(fill.rate * 1000) / 1000, source: fill.source },
    projections: { current_pace: currentPace, floor_guard: floorGuard, fill_push: fillPush },
    recommended_targets: {
      current_pace: round50(currentPace.end_gross),
      floor_guard: round50(floorGuard.end_gross),
      fill_push: round50(fillPush.end_gross),
    },
    history,
  };
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

  /* Month plan: read-only kooste yhdelle kohteelle ja kuukaudelle.
   * Cache 10 min per property+month+risk — kylmä rakennus live-tilassa
   * kestää ~5–15 s (5 GET-kutsua sarjassa clientin tahdistuksella). */
  if (path === "/api/month-plan" && method === "GET") {
    const pid = (url.searchParams.get("property_id") ?? "").trim();
    if (pid === "") {
      throw new BadRequest("Invalid property_id: pass the property id string from the analysis");
    }
    const month = url.searchParams.get("month") ?? "";
    if (!MONTH_RE.test(month)) {
      throw new BadRequest("Invalid month: use the format YYYY-MM");
    }
    const riskChoice = url.searchParams.get("risk") ?? "recommended";
    if (!RISKS.has(riskChoice)) {
      throw new BadRequest('Invalid risk: use "conservative", "recommended" or "aggressive"');
    }
    const cacheKey = `${pid}\u0000${month}\u0000${riskChoice}`;
    const hit = planCache.get(cacheKey);
    if (hit && Date.now() - hit.at < PLAN_TTL_MS) {
      return json(res, 200, { ...hit.body, cached: true });
    }
    const body = await buildMonthPlan(pid, month, riskChoice);
    planCache.set(cacheKey, { at: Date.now(), body });
    if (planCache.size > 200) {
      const oldest = [...planCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) planCache.delete(oldest[0]);
    }
    return json(res, 200, { ...body, cached: false });
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

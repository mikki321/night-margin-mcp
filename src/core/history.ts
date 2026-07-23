/**
 * Puhdas historia-yhteenveto (season review). Ei I/O:ta, ei client-importteja.
 * Ottaa jo haetut ja litistetyt listing-kuukausi-solut + keskimääräisen
 * vaihtokustannuksen + (valinnaisen) kuukausi-ikkunan ja palauttaa koko
 * review-rakenteen. Vaihtokustannus ja netto ovat ARVIOITA kuukausikeskiarvoista
 * — laskenta pitää floatit, pyöristys tapahtuu vasta formatterissa
 * (sama sääntö kuin analyzePortfolio).
 *
 * EI ennusteita, EI strategiavertailuja, EI kontrafaktuaaleja — vain kuvaus
 * siitä mitä todella tapahtui käyttäjän omissa kuukausiluvuissa.
 */

/** Kuukauden päivien määrä "YYYY-MM" tai "YYYY-MM-01" -merkkijonosta (karkausvuosivarma). */
export function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)); // 1-based
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error(`Invalid month "${month}" — expected YYYY-MM`);
  }
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this
}

/** Yksi listing-kuukausi-solu (tool litistää kaikki listingit tähän ennen ydintä). */
export interface MonthlyKpiInput {
  month: string;            // "YYYY-MM-01"
  revenue: number;
  occupancy: number | null;
  los: number | null;
  adr: number | null;       // säilytetään, mutta rollup-ADR lasketaan revenue/occupied
}

export interface MonthRollup {
  month: string;                 // "YYYY-MM"
  revenue: number;               // Σ kaikista revenue>0 -soluista
  estimable_revenue: number;     // Σ revenue niistä soluista joissa turnover on arvioitavissa
  non_estimable_revenue: number; // revenue>0 mutta occupancy tai los puuttuu
  est_turnover_cost: number;     // vain arvioitavista soluista
  est_net: number;               // estimable_revenue − est_turnover_cost
  turnover_share: number | null; // est_turnover_cost / estimable_revenue; null jos ei arvioitavaa revenueta
  occupied_nights: number;       // Σ occupancy*days soluista joissa occupancy on luku
  available_nights: number;      // Σ days niistä soluista (occupancy present)
  occupancy: number | null;      // occupied/available; null jos ei yhtään occupancy-solua
  adr: number | null;            // revenue(occ-solut) / occupied_nights; null jos occupied=0
  cells: number;                 // revenue>0 -solujen määrä tässä kuussa
  estimable_cells: number;
  is_future: boolean;            // month >= nowMonth → varauksia kirjoissa, ei toteutunutta historiaa
}

export interface HistoryReview {
  months_count: number;          // TOTEUTUNEET kuukaudet joissa portfolio-revenue>0 (ikkunan jälkeen)
  earliest_month: string | null; // "YYYY-MM" (toteutunut)
  latest_month: string | null;
  window_from_month: string | null; // sovellettu suodatin "YYYY-MM" tai null (= all history)
  window_to_month: string | null;
  rollup: MonthRollup[];         // TOTEUTUNEET kuukaudet aikajärjestyksessä
  future_rollup: MonthRollup[];  // TULEVAT (kirjoissa) kuukaudet aikajärjestyksessä
  future: {                      // yhteenveto kirjoissa olevista tulevista kuukausista; null jos ei yhtään
    months_count: number;
    earliest_month: string;
    latest_month: string;
    revenue: number;
  } | null;
  totals: {
    revenue: number;
    estimable_revenue: number;
    non_estimable_revenue: number;
    est_turnover_cost: number;
    est_net: number;
    turnover_share: number | null;
  };
  thinnest: MonthRollup[];       // arvioitavat kuukaudet, turnover_share laskevasti, top 3
  lowest_share_month: MonthRollup | null;  // seasonality-vertailun matalin
  highest_share_month: MonthRollup | null; // seasonality-vertailun korkein
}

/** Sisäinen akkumulaattori per kuukausi (mutatoituva; finalisoidaan MonthRollupiksi). */
interface Acc {
  month: string;
  revenue: number;
  estimable_revenue: number;
  non_estimable_revenue: number;
  est_turnover_cost: number;
  occupied_nights: number;
  available_nights: number;
  occRevenue: number; // revenue niistä soluista joilla occupancy present (ADR-nimittäjä)
  cells: number;
  estimable_cells: number;
}

export function reviewHistory(
  cells: MonthlyKpiInput[],
  avgTurnoverCost: number,
  window?: { from?: string; to?: string }, // YYYY-MM-DD; validoitu kutsujassa
  nowMonth?: string, // "YYYY-MM" — kuukaudet >= tämä ovat TULEVIA (kirjoissa, ei historiaa)
): HistoryReview {
  // 1. Ikkunan rajat (kuukausigranulariteetti, inklusiivinen).
  const fromYM = window?.from?.slice(0, 7);
  const toYM = window?.to?.slice(0, 7);

  const byMonth = new Map<string, Acc>();

  // 2. Per solu — vain revenue > 0 (revenue===0 tai <0 pudotetaan: ei varattu kuukausi).
  for (const c of cells) {
    if (!(typeof c.revenue === "number" && Number.isFinite(c.revenue) && c.revenue > 0)) continue;
    const ym = c.month.slice(0, 7);
    if (fromYM && ym < fromYM) continue;
    if (toYM && ym > toYM) continue;

    const days = daysInMonth(c.month);
    const hasOcc =
      typeof c.occupancy === "number" && Number.isFinite(c.occupancy) && c.occupancy >= 0;
    const occNights = hasOcc ? (c.occupancy as number) * days : 0;
    const estimable =
      hasOcc && typeof c.los === "number" && Number.isFinite(c.los) && c.los > 0;

    let acc = byMonth.get(ym);
    if (!acc) {
      acc = {
        month: ym,
        revenue: 0,
        estimable_revenue: 0,
        non_estimable_revenue: 0,
        est_turnover_cost: 0,
        occupied_nights: 0,
        available_nights: 0,
        occRevenue: 0,
        cells: 0,
        estimable_cells: 0,
      };
      byMonth.set(ym, acc);
    }

    acc.revenue += c.revenue;
    acc.cells += 1;
    if (hasOcc) {
      acc.occupied_nights += occNights;
      acc.available_nights += days;
      acc.occRevenue += c.revenue;
    }
    if (estimable) {
      const turnovers = occNights / (c.los as number);
      const turnoverCost = turnovers * avgTurnoverCost;
      acc.estimable_revenue += c.revenue;
      acc.est_turnover_cost += turnoverCost;
      acc.estimable_cells += 1;
    } else {
      acc.non_estimable_revenue += c.revenue;
    }
  }

  // 3. Finalisoi kukin kuukausi MonthRollupiksi.
  const rollup: MonthRollup[] = [];
  for (const acc of byMonth.values()) {
    const est_net = acc.estimable_revenue - acc.est_turnover_cost;
    const turnover_share =
      acc.estimable_revenue > 0 ? acc.est_turnover_cost / acc.estimable_revenue : null;
    const occupancy =
      acc.available_nights > 0 ? acc.occupied_nights / acc.available_nights : null;
    const adr = acc.occupied_nights > 0 ? acc.occRevenue / acc.occupied_nights : null;
    rollup.push({
      month: acc.month,
      revenue: acc.revenue,
      estimable_revenue: acc.estimable_revenue,
      non_estimable_revenue: acc.non_estimable_revenue,
      est_turnover_cost: acc.est_turnover_cost,
      est_net,
      turnover_share,
      occupied_nights: acc.occupied_nights,
      available_nights: acc.available_nights,
      occupancy,
      adr,
      cells: acc.cells,
      estimable_cells: acc.estimable_cells,
      // Kuukausi >= nowMonth on TULEVA (varauksia kirjoissa, ei toteutunutta
      // historiaa). Ilman tätä työkalu kutsui 2027:n varauksia "historiaksi" ja
      // oli ristiriidassa oman "review of what already happened" -lupauksensa kanssa.
      is_future: nowMonth ? acc.month >= nowMonth : false,
    });
  }

  // 4. Aikajärjestys (string-sort toimii YYYY-MM:lle).
  rollup.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

  // 5. Jako toteutuneisiin ja tuleviin. Historian yhteenveto (span, totals,
  //    ohuimmat kuukaudet, kausivaihtelu) lasketaan VAIN toteutuneista —
  //    "mitä jo tapahtui". Tulevat näytetään erikseen omana "kirjoissa" -osiona.
  const realized = rollup.filter((r) => !r.is_future);
  const futureRows = rollup.filter((r) => r.is_future);

  // 6. Span (toteutuneista).
  const months_count = realized.length;
  const earliest_month = realized[0]?.month ?? null;
  const latest_month = realized.at(-1)?.month ?? null;

  const future =
    futureRows.length > 0
      ? {
          months_count: futureRows.length,
          earliest_month: futureRows[0].month,
          latest_month: futureRows.at(-1)!.month,
          revenue: futureRows.reduce((s, r) => s + r.revenue, 0),
        }
      : null;

  // 7. Totals (toteutuneista).
  const totals = {
    revenue: 0,
    estimable_revenue: 0,
    non_estimable_revenue: 0,
    est_turnover_cost: 0,
    est_net: 0,
    turnover_share: null as number | null,
  };
  for (const r of realized) {
    totals.revenue += r.revenue;
    totals.estimable_revenue += r.estimable_revenue;
    totals.non_estimable_revenue += r.non_estimable_revenue;
    totals.est_turnover_cost += r.est_turnover_cost;
  }
  totals.est_net = totals.estimable_revenue - totals.est_turnover_cost;
  totals.turnover_share =
    totals.estimable_revenue > 0 ? totals.est_turnover_cost / totals.estimable_revenue : null;

  // 7. Thinnest — arvioitavat kuukaudet, share laskevasti (korkein share = ohuin kate),
  //    tie-break month nousevasti, top 3.
  const estimableMonths = realized.filter((r) => r.turnover_share !== null);
  const thinnest = [...estimableMonths]
    .sort((a, b) => {
      const d = (b.turnover_share as number) - (a.turnover_share as number);
      if (d !== 0) return d;
      return a.month < b.month ? -1 : a.month > b.month ? 1 : 0;
    })
    .slice(0, 3);

  // 8. Seasonality — matalin ja korkein share (tie-break month nousevasti).
  let lowest_share_month: MonthRollup | null = null;
  let highest_share_month: MonthRollup | null = null;
  for (const r of estimableMonths) {
    const s = r.turnover_share as number;
    if (
      lowest_share_month === null ||
      s < (lowest_share_month.turnover_share as number) ||
      (s === (lowest_share_month.turnover_share as number) && r.month < lowest_share_month.month)
    ) {
      lowest_share_month = r;
    }
    if (
      highest_share_month === null ||
      s > (highest_share_month.turnover_share as number) ||
      (s === (highest_share_month.turnover_share as number) && r.month < highest_share_month.month)
    ) {
      highest_share_month = r;
    }
  }

  return {
    months_count,
    earliest_month,
    latest_month,
    window_from_month: fromYM ?? null,
    window_to_month: toYM ?? null,
    rollup: realized,
    future_rollup: futureRows,
    future,
    totals,
    thinnest,
    lowest_share_month,
    highest_share_month,
  };
}

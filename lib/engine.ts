// Runtime imports come from the compiled MCP output (dist/), which is built by
// the `prepare` script on npm install — Turbopack cannot resolve the NodeNext
// ".js" specifiers in src/ back to their .ts sources. Types are imported
// type-only from src/ (erased at compile time).
import { analyzePortfolio, gapNightFloor } from '@/dist/core/calc.js'
import { simulateFillGaps, simulateMinStayUplift } from '@/dist/core/simulate.js'
import type { PortfolioAnalysis, TurnoverCost } from '@/src/core/types.js'
import { costSourceFromEnv } from '@/dist/sources/index.js'
import { reservationSourceFromEnv } from '@/dist/sources/reservationSource.js'
import { avgFallbackFromEnv, resolveCosts } from '@/dist/sources/resolveCosts.js'
import { avgTurnoverCost, minMargin } from '@/dist/config.js'
import { checkWindow, estimateTurnover, findBooking } from '@/dist/tools/gapNightCheck.js'

export interface AnalysisPayload {
  analysis: PortfolioAnalysis
  costLabel: string
  reservationLabel: string
}

async function loadData(from: string, to: string) {
  const costSource = costSourceFromEnv(process.env)
  const reservationSource = reservationSourceFromEnv(process.env)
  const reservations = await reservationSource.getReservations(from, to)
  const { costs } = await resolveCosts(
    costSource,
    reservations,
    from,
    to,
    avgFallbackFromEnv(process.env),
  )
  return { reservations, costs, costSource, reservationSource }
}

export async function getAnalysis(from: string, to: string): Promise<AnalysisPayload> {
  const { reservations, costs, costSource, reservationSource } = await loadData(from, to)
  return {
    analysis: analyzePortfolio(reservations, costs, from, to),
    costLabel: costSource.label,
    reservationLabel: reservationSource.label,
  }
}

export interface CompareOptions {
  discountPct: number
  minStay: number
  upliftPct: number
}

export interface ComparePayload {
  baseline: PortfolioAnalysis
  fillGaps: PortfolioAnalysis
  minStayUplift: PortfolioAnalysis
  options: CompareOptions
}

export async function getComparison(
  from: string,
  to: string,
  options: CompareOptions,
): Promise<ComparePayload> {
  const { reservations, costs } = await loadData(from, to)

  const baseline = analyzePortfolio(reservations, costs, from, to)

  const a = simulateFillGaps(reservations, costs, from, to, {
    discountPct: options.discountPct,
  })
  const fillGaps = analyzePortfolio(a.reservations, a.costs, from, to)

  const b = simulateMinStayUplift(reservations, costs, from, to, {
    minStay: options.minStay,
    upliftPct: options.upliftPct,
  })
  const minStayUplift = analyzePortfolio(b.reservations, b.costs, from, to)

  return { baseline, fillGaps, minStayUplift, options }
}

export interface GapCheckPayload {
  propertyId: string
  date: string
  isBooked: boolean
  bookingId?: string
  floor?: number
  turnover?: number
  travel?: number
  margin?: number
  candidatePrice?: number
  verdict?: 'FILL' | 'SKIP'
  diff?: number
  estimateNote?: string
  error?: string
}

export async function getGapCheck(
  propertyId: string,
  date: string,
  candidatePrice?: number,
): Promise<GapCheckPayload> {
  const { from, to } = checkWindow(date)
  const reservationSource = reservationSourceFromEnv(process.env)
  const reservations = await reservationSource.getReservations(from, to)

  const known = [...new Set(reservations.map((r) => r.property_id))]
  if (!known.includes(propertyId)) {
    return {
      propertyId,
      date,
      isBooked: false,
      error: `Property "${propertyId}" not found in the window ${from} – ${to}.`,
    }
  }

  const booking = findBooking(reservations, propertyId, date)
  if (booking) {
    return { propertyId, date, isBooked: true, bookingId: booking.reservation_id }
  }

  const propertyReservations = reservations.filter((r) => r.property_id === propertyId)
  const costSource = costSourceFromEnv(process.env)
  let costRows: TurnoverCost[] = []
  try {
    const { costs } = await resolveCosts(
      costSource,
      propertyReservations,
      from,
      to,
      avgFallbackFromEnv(process.env),
    )
    costRows = propertyReservations
      .map((r) => costs.get(r.reservation_id))
      .filter((c): c is TurnoverCost => c !== undefined)
  } catch {
    costRows = []
  }

  const manualAvg = avgTurnoverCost(process.env)
  const margin = minMargin(process.env)
  const est = estimateTurnover(costRows, manualAvg)
  const floor = gapNightFloor(est.turnover, est.travel, margin)

  const payload: GapCheckPayload = {
    propertyId,
    date,
    isBooked: false,
    floor,
    turnover: est.turnover,
    travel: est.travel,
    margin,
    estimateNote: est.fromRows
      ? `median of ${est.rowCount} cost rows`
      : `no cost rows — manual average €${manualAvg}`,
  }

  if (candidatePrice !== undefined) {
    payload.candidatePrice = candidatePrice
    payload.diff = candidatePrice - floor
    payload.verdict = candidatePrice >= floor ? 'FILL' : 'SKIP'
  }

  return payload
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function validISODate(value: string | null): value is string {
  return value !== null && ISO_DATE.test(value)
}

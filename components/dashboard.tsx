'use client'

import { useState } from 'react'
import useSWR from 'swr'
import type { PortfolioAnalysis } from '@/src/core/types.js'
import { KpiCards } from '@/components/kpi-cards'
import { NetChart } from '@/components/net-chart'
import { PropertyTable } from '@/components/property-table'
import { LeakTable } from '@/components/leak-table'
import { StrategyCompare } from '@/components/strategy-compare'
import { GapChecker } from '@/components/gap-checker'

interface AnalysisPayload {
  analysis: PortfolioAnalysis
  costLabel: string
  reservationLabel: string
  error?: string
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** Demo data covers calendar year 2026 — [from, to) per month. */
const PERIODS = MONTHS.map((label, i) => {
  const from = `2026-${String(i + 1).padStart(2, '0')}-01`
  const to = i === 11 ? '2027-01-01' : `2026-${String(i + 2).padStart(2, '0')}-01`
  return { label: `${label} 2026`, from, to }
})

export function Dashboard() {
  const [periodIndex, setPeriodIndex] = useState(5) // June 2026
  const period = PERIODS[periodIndex]

  const { data, isLoading } = useSWR<AnalysisPayload>(
    `/api/portfolio?from=${period.from}&to=${period.to}`,
    fetcher,
    { keepPreviousData: true },
  )

  const analysis = data && !data.error ? data.analysis : undefined

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <label htmlFor="period" className="text-sm text-muted-foreground">
            Period
          </label>
          <select
            id="period"
            value={periodIndex}
            onChange={(e) => setPeriodIndex(Number(e.target.value))}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {PERIODS.map((p, i) => (
              <option key={p.from} value={i}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {data && !data.error && (
          <p className="text-xs text-muted-foreground">
            Costs: {data.costLabel} · Reservations: {data.reservationLabel}
          </p>
        )}
      </div>

      {analysis ? (
        <>
          <KpiCards analysis={analysis} />
          <NetChart properties={analysis.properties} />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <PropertyTable properties={analysis.properties} />
            <LeakTable reservations={analysis.negative_reservations} />
          </div>
          <StrategyCompare from={period.from} to={period.to} />
          <GapChecker
            propertyIds={analysis.properties.map((p) => p.property_id).sort()}
            defaultDate={period.from}
          />
        </>
      ) : (
        <div className="rounded-lg border border-border bg-card p-16 text-center text-sm text-muted-foreground">
          {isLoading ? 'Analyzing portfolio…' : (data?.error ?? 'No data')}
        </div>
      )}
    </div>
  )
}

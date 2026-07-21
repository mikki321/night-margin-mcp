'use client'

import { useState } from 'react'
import useSWR from 'swr'
import type { PortfolioAnalysis } from '@/src/core/types.js'
import { eur, eur1, pct } from '@/lib/format'

interface ComparePayload {
  baseline: PortfolioAnalysis
  fillGaps: PortfolioAnalysis
  minStayUplift: PortfolioAnalysis
  error?: string
}

const fetcher = (url: string) => fetch(url).then((r) => r.json())

function StrategyCard({
  title,
  subtitle,
  analysis,
  baselineNet,
}: {
  title: string
  subtitle: string
  analysis: PortfolioAnalysis
  baselineNet?: number
}) {
  const t = analysis.totals
  const delta = baselineNet !== undefined ? t.net - baselineNet : undefined
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground text-pretty">{subtitle}</p>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-2xl font-semibold tabular-nums">
          {eur1(t.net_per_available_night)}
        </span>
        <span className="text-xs text-muted-foreground">net / night</span>
      </div>
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Net result</dt>
          <dd className={`font-mono tabular-nums ${t.net < 0 ? 'text-negative' : ''}`}>
            {eur(t.net)}
            {delta !== undefined && (
              <span className={delta >= 0 ? 'text-positive' : 'text-negative'}>
                {' '}
                ({delta >= 0 ? '+' : ''}
                {eur(delta)})
              </span>
            )}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Gross</dt>
          <dd className="font-mono tabular-nums">{eur(t.gross)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Occupancy</dt>
          <dd className="font-mono tabular-nums">{pct(t.occupancy_pct)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Leak</dt>
          <dd className="font-mono tabular-nums text-negative">{eur(analysis.leak_eur)}</dd>
        </div>
      </dl>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  suffix: string
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 rounded-md border border-border bg-card px-2 py-1 font-mono text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <span className="text-muted-foreground">{suffix}</span>
    </label>
  )
}

export function StrategyCompare({ from, to }: { from: string; to: string }) {
  const [discount, setDiscount] = useState(40)
  const [minStay, setMinStay] = useState(3)
  const [uplift, setUplift] = useState(10)

  const { data, isLoading } = useSWR<ComparePayload>(
    `/api/compare?from=${from}&to=${to}&discount=${discount}&minStay=${minStay}&uplift=${uplift}`,
    fetcher,
    { keepPreviousData: true },
  )

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Strategy comparison</h2>
          <p className="text-sm text-muted-foreground text-pretty">
            Gross revenue can grow while profit shrinks — compare strategies on net, not gross.
          </p>
        </div>
        <div className="flex flex-wrap gap-4">
          <NumberField
            label="Gap discount"
            value={discount}
            onChange={setDiscount}
            min={0}
            max={100}
            suffix="%"
          />
          <NumberField
            label="Min stay"
            value={minStay}
            onChange={setMinStay}
            min={1}
            max={14}
            suffix="nights"
          />
          <NumberField
            label="Uplift"
            value={uplift}
            onChange={setUplift}
            min={-50}
            max={100}
            suffix="%"
          />
        </div>
      </div>
      {data && !data.error ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <StrategyCard
            title="Baseline"
            subtitle="Current bookings, no changes"
            analysis={data.baseline}
          />
          <StrategyCard
            title={`A — Fill gaps at ${discount}% off`}
            subtitle="Every gap night filled at a discounted ADR; each fill adds a full turnover cost"
            analysis={data.fillGaps}
            baselineNet={data.baseline.totals.net}
          />
          <StrategyCard
            title={`B — Min stay ${minStay} + ${uplift}% uplift`}
            subtitle="Drop short bookings, raise prices on the rest; fewer turnovers per booked night"
            analysis={data.minStayUplift}
            baselineNet={data.baseline.totals.net}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          {isLoading ? 'Simulating strategies…' : (data?.error ?? 'No data')}
        </div>
      )}
    </section>
  )
}

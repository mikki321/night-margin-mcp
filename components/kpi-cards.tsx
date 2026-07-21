import type { PortfolioAnalysis } from '@/src/core/types.js'
import { eur, eur1, pct } from '@/lib/format'

function Card({
  label,
  value,
  detail,
  negative = false,
}: {
  label: string
  value: string
  detail: string
  negative?: boolean
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={`font-mono text-2xl font-semibold tabular-nums ${negative ? 'text-negative' : 'text-card-foreground'}`}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground text-pretty">{detail}</span>
    </div>
  )
}

export function KpiCards({ analysis }: { analysis: PortfolioAnalysis }) {
  const t = analysis.totals
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card
        label="Net per available night"
        value={eur1(t.net_per_available_night)}
        detail={`${t.available_nights} available nights across ${analysis.properties.length} properties`}
      />
      <Card
        label="Occupancy"
        value={pct(t.occupancy_pct)}
        detail={`${t.booked_nights} booked · ${t.gap_nights} gap nights`}
      />
      <Card
        label="Net result"
        value={eur(t.net)}
        detail={`Gross ${eur(t.gross)} − turnover costs ${eur(t.costs)}`}
        negative={t.net < 0}
      />
      <Card
        label="Profit leak"
        value={eur(analysis.leak_eur)}
        detail={`${pct(analysis.leak_pct)} of booked nights net-negative (${analysis.negative_reservations.length} bookings)`}
        negative={analysis.leak_eur > 0}
      />
    </div>
  )
}

import type { PropertyStats } from '@/src/core/types.js'
import { eur, eur1, pct } from '@/lib/format'

export function PropertyTable({ properties }: { properties: PropertyStats[] }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-1 text-base font-semibold">Properties</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Ranked by net per available night, weakest first.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Property</th>
              <th className="py-2 pr-4 text-right font-medium">Net / night</th>
              <th className="py-2 pr-4 text-right font-medium">Occupancy</th>
              <th className="py-2 pr-4 text-right font-medium">Booked</th>
              <th className="py-2 pr-4 text-right font-medium">Gap nights</th>
              <th className="py-2 pr-4 text-right font-medium">Gross</th>
              <th className="py-2 pr-4 text-right font-medium">Costs</th>
              <th className="py-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {properties.map((p) => {
              const occ =
                p.available_nights > 0 ? (p.booked_nights / p.available_nights) * 100 : 0
              return (
                <tr key={p.property_id} className="border-b border-border last:border-b-0">
                  <td className="py-2 pr-4 font-mono text-xs">{p.property_id}</td>
                  <td
                    className={`py-2 pr-4 text-right font-mono tabular-nums ${
                      p.net_per_available_night < 0 ? 'text-negative' : ''
                    }`}
                  >
                    {eur1(p.net_per_available_night)}
                  </td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{pct(occ)}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{p.booked_nights}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{p.gap_nights}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{eur(p.gross)}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{eur(p.costs)}</td>
                  <td
                    className={`py-2 text-right font-mono tabular-nums ${
                      p.net < 0 ? 'text-negative' : ''
                    }`}
                  >
                    {eur(p.net)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

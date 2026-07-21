import type { NegativeReservation } from '@/src/core/types.js'
import { eur } from '@/lib/format'

export function LeakTable({ reservations }: { reservations: NegativeReservation[] }) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-1 text-base font-semibold">Net-negative bookings</h2>
      <p className="mb-4 text-sm text-muted-foreground text-pretty">
        Bookings whose gross did not cover their own turnover cost — a 2-night and a 7-night
        booking consume the same cleaning.
      </p>
      {reservations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No net-negative bookings in this period.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">Booking</th>
                <th className="py-2 pr-4 font-medium">Check-in</th>
                <th className="py-2 pr-4 text-right font-medium">Nights</th>
                <th className="py-2 pr-4 text-right font-medium">Gross</th>
                <th className="py-2 pr-4 text-right font-medium">Costs</th>
                <th className="py-2 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {reservations.slice(0, 12).map((r) => (
                <tr key={r.reservation_id} className="border-b border-border last:border-b-0">
                  <td className="py-2 pr-4 font-mono text-xs">{r.reservation_id}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.checkin}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{r.nights}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{eur(r.gross)}</td>
                  <td className="py-2 pr-4 text-right font-mono tabular-nums">{eur(r.costs)}</td>
                  <td className="py-2 text-right font-mono tabular-nums text-negative">
                    {eur(r.net)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {reservations.length > 12 && (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing 12 of {reservations.length} net-negative bookings.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

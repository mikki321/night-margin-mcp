'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { eur } from '@/lib/format'

interface GapCheckPayload {
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

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function GapChecker({
  propertyIds,
  defaultDate,
}: {
  propertyIds: string[]
  defaultDate: string
}) {
  const [property, setProperty] = useState(propertyIds[0] ?? '')
  const [date, setDate] = useState(defaultDate)
  const [price, setPrice] = useState('')

  const priceParam = price.trim() !== '' && Number.isFinite(Number(price)) ? `&price=${Number(price)}` : ''
  const { data, isLoading } = useSWR<GapCheckPayload>(
    property && date ? `/api/gap?property=${property}&date=${date}${priceParam}` : null,
    fetcher,
    { keepPreviousData: true },
  )

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-1 text-base font-semibold">Gap-night check</h2>
      <p className="mb-4 text-sm text-muted-foreground text-pretty">
        Is a single gap night worth filling? Floor = turnover + travel + minimum margin. FILL when
        the price covers the floor.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Property</span>
          <select
            value={property}
            onChange={(e) => setProperty(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {propertyIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Night</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1.5 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{'Candidate price (\u20AC, optional)'}</span>
          <input
            type="number"
            min={0}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="e.g. 95"
            className="w-36 rounded-md border border-border bg-card px-2 py-1.5 font-mono text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
      </div>

      {isLoading && !data ? (
        <p className="text-sm text-muted-foreground">Checking…</p>
      ) : data?.error ? (
        <p className="text-sm text-negative">{data.error}</p>
      ) : data?.isBooked ? (
        <p className="text-sm">
          Not a gap night — booking{' '}
          <span className="font-mono text-xs">{data.bookingId}</span> covers the night of{' '}
          <span className="font-mono text-xs">{data.date}</span>.
        </p>
      ) : data?.floor !== undefined ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm">
              Floor <span className="font-mono font-semibold tabular-nums">{eur(data.floor)}</span>
              <span className="text-muted-foreground">
                {' '}
                (turnover {Math.round(data.turnover ?? 0)} + travel {Math.round(data.travel ?? 0)} +
                margin {Math.round(data.margin ?? 0)})
              </span>
            </span>
            {data.verdict && (
              <span
                className={`rounded-md px-2 py-0.5 font-mono text-sm font-semibold ${
                  data.verdict === 'FILL'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-negative-muted text-negative'
                }`}
              >
                {data.verdict}
              </span>
            )}
            {data.diff !== undefined && (
              <span className="text-sm text-muted-foreground">
                filling at {eur(data.candidatePrice ?? 0)} yields{' '}
                <span
                  className={`font-mono tabular-nums ${data.diff >= 0 ? 'text-positive' : 'text-negative'}`}
                >
                  {data.diff >= 0 ? '+' : ''}
                  {eur(data.diff)}
                </span>
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Turnover estimate: {data.estimateNote}</p>
          {data.verdict === undefined && (
            <p className="text-xs text-muted-foreground">
              Enter a candidate price to get a FILL/SKIP verdict.
            </p>
          )}
        </div>
      ) : null}
    </section>
  )
}

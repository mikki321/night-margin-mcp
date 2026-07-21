'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { PropertyStats } from '@/src/core/types.js'
import { eur1 } from '@/lib/format'

export function NetChart({ properties }: { properties: PropertyStats[] }) {
  const data = properties.map((p) => ({
    name: p.property_id.replace(/^demo-/, ''),
    net: Number(p.net_per_available_night.toFixed(1)),
  }))

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-1 text-base font-semibold">Net per available night by property</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Sorted worst to best — where each property actually earns after turnover costs.
      </p>
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--border)' }}
            />
            <YAxis
              tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `\u20AC${v}`}
              width={48}
            />
            <Tooltip
              formatter={(value) => [eur1(Number(value)), 'Net / night']}
              contentStyle={{
                borderRadius: 8,
                border: '1px solid var(--border)',
                fontSize: 13,
              }}
            />
            <ReferenceLine y={0} stroke="var(--muted-foreground)" />
            <Bar dataKey="net" radius={[4, 4, 0, 0]} maxBarSize={56}>
              {data.map((entry) => (
                <Cell
                  key={entry.name}
                  fill={entry.net < 0 ? 'var(--negative)' : 'var(--primary)'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

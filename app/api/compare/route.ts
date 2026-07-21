import { NextRequest, NextResponse } from 'next/server'
import { getComparison, validISODate } from '@/lib/engine'

function num(value: string | null, fallback: number): number {
  if (value === null || value.trim() === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const from = params.get('from')
  const to = params.get('to')

  if (!validISODate(from) || !validISODate(to)) {
    return NextResponse.json(
      { error: 'Provide from and to as YYYY-MM-DD query params' },
      { status: 400 },
    )
  }

  const options = {
    discountPct: num(params.get('discount'), 40),
    minStay: Math.max(1, Math.round(num(params.get('minStay'), 3))),
    upliftPct: num(params.get('uplift'), 10),
  }

  try {
    const payload = await getComparison(from, to, options)
    return NextResponse.json(payload)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

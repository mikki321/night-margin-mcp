import { NextRequest, NextResponse } from 'next/server'
import { getGapCheck, validISODate } from '@/lib/engine'

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const property = params.get('property')
  const date = params.get('date')
  const priceRaw = params.get('price')

  if (!property || !validISODate(date)) {
    return NextResponse.json(
      { error: 'Provide property and date (YYYY-MM-DD) query params' },
      { status: 400 },
    )
  }

  let price: number | undefined
  if (priceRaw !== null && priceRaw.trim() !== '') {
    const n = Number(priceRaw)
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: 'price must be a non-negative number' }, { status: 400 })
    }
    price = n
  }

  try {
    const payload = await getGapCheck(property, date, price)
    return NextResponse.json(payload)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

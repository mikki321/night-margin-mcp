import { NextRequest, NextResponse } from 'next/server'
import { getAnalysis, validISODate } from '@/lib/engine'

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

  try {
    const payload = await getAnalysis(from, to)
    return NextResponse.json(payload)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { scoreTrades, type ScorableTrade } from '@/lib/scoring'

// On-visit scoring for the journal page (works signed-out too). The signed-in
// real-time path is the background worker in src/server/scoreWorker.ts.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_TRADES = 50

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { trades?: ScorableTrade[] }
    const trades = (body.trades ?? []).slice(0, MAX_TRADES)
    if (trades.length === 0) return NextResponse.json({ results: [] })
    return NextResponse.json({ results: await scoreTrades(trades) })
  } catch (err) {
    console.error('score-trades error:', err)
    return NextResponse.json({ error: 'Failed to score trades' }, { status: 500 })
  }
}

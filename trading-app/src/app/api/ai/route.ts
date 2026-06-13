import { NextRequest, NextResponse } from 'next/server'
import { runAIModel, type AIModelInput } from '@/lib/aiModel'

// Runs the AI model server-side so ANTHROPIC_API_KEY stays off the client.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<AIModelInput>

    if (!body.pair || !body.indicators || !body.signal) {
      return NextResponse.json(
        { error: 'Missing required fields: pair, indicators, signal' },
        { status: 400 },
      )
    }

    const insight = await runAIModel({
      pair: body.pair,
      currentPrice: body.currentPrice ?? 0,
      priceChangePct24h: body.priceChangePct24h ?? 0,
      indicators: body.indicators,
      signal: body.signal,
      news: body.news ?? [],
    })

    return NextResponse.json(insight)
  } catch (err) {
    console.error('AI route error:', err)
    return NextResponse.json({ error: 'Failed to generate AI insight' }, { status: 500 })
  }
}

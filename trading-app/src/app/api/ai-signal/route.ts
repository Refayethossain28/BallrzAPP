import { NextResponse, type NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { getUserTier } from '@/lib/tier'

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

export async function POST(request: NextRequest) {
  // Auth check
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Tier check
  const tier = await getUserTier(user.id)
  if (tier !== 'pro') {
    return NextResponse.json(
      { error: 'Pro subscription required' },
      { status: 403 }
    )
  }

  const body = await request.json()
  const { pair, price, indicators, techSignal, newsHeadlines } = body

  const prompt = `You are an expert forex analyst. Analyze the following data for ${pair} and provide a trading signal.

Current Price: ${price}

Technical Indicators:
- RSI (14): ${indicators?.rsi?.toFixed(2) ?? 'N/A'}
- MACD: ${indicators?.macd?.macd?.toFixed(5) ?? 'N/A'} (Signal: ${indicators?.macd?.signal?.toFixed(5) ?? 'N/A'}, Histogram: ${indicators?.macd?.histogram?.toFixed(5) ?? 'N/A'})
- SMA 20: ${indicators?.sma20?.toFixed(5) ?? 'N/A'}
- SMA 50: ${indicators?.sma50?.toFixed(5) ?? 'N/A'}
- Bollinger Bands: Upper ${indicators?.bollingerBands?.upper?.toFixed(5) ?? 'N/A'}, Lower ${indicators?.bollingerBands?.lower?.toFixed(5) ?? 'N/A'}
- ATR (14): ${indicators?.atr?.toFixed(5) ?? 'N/A'}
- Stochastic K: ${indicators?.stochastic?.k?.toFixed(2) ?? 'N/A'}, D: ${indicators?.stochastic?.d?.toFixed(2) ?? 'N/A'}
- ADX: ${indicators?.adx?.toFixed(2) ?? 'N/A'}

Technical Signal: ${techSignal?.type ?? 'N/A'} (${techSignal?.confidence?.toFixed(0) ?? 'N/A'}% confidence)
Entry: ${techSignal?.entryPrice ?? 'N/A'}
TP1: ${techSignal?.takeProfit1 ?? 'N/A'}, TP2: ${techSignal?.takeProfit2 ?? 'N/A'}, TP3: ${techSignal?.takeProfit3 ?? 'N/A'}
Stop Loss: ${techSignal?.stopLoss ?? 'N/A'}

Recent News Headlines:
${(newsHeadlines ?? []).map((h: string, i: number) => `${i + 1}. ${h}`).join('\n')}

Provide your analysis in the following JSON format ONLY (no markdown, no extra text):
{
  "signal": "BUY" | "SELL" | "NEUTRAL",
  "confidence": <number 0-100>,
  "tp1": <price level>,
  "tp2": <price level>,
  "tp3": <price level>,
  "sl": <price level>,
  "analysis": "<2-3 sentence plain English explanation of why you are taking this signal>",
  "keyFactors": ["<factor 1>", "<factor 2>", "<factor 3>"]
}`

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    })

    const content = message.content[0]
    if (content.type !== 'text') {
      return NextResponse.json({ error: 'Invalid AI response' }, { status: 500 })
    }

    // Parse JSON from response
    const jsonMatch = content.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ error: 'Could not parse AI response' }, { status: 500 })
    }

    const result = JSON.parse(jsonMatch[0])
    return NextResponse.json(result)
  } catch (error) {
    console.error('AI signal error:', error)
    return NextResponse.json({ error: 'AI analysis failed' }, { status: 500 })
  }
}

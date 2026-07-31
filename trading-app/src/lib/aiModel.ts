import Anthropic from '@anthropic-ai/sdk'
import type {
  AIInsight,
  NewsArticle,
  SignalType,
  TechnicalIndicators,
  TradingSignal,
} from './types'

// The AI model reads the deterministic technical analysis plus market news and
// produces a second-opinion verdict with a plain-English rationale. It runs
// server-side only (the API key never reaches the browser). When no key is
// configured it falls back to a transparent heuristic so the app still works.

const MODEL = 'claude-opus-4-8'

export interface AIModelInput {
  pair: string
  currentPrice: number
  priceChangePct24h: number
  indicators: TechnicalIndicators
  signal: TradingSignal
  news: NewsArticle[]
}

// Structured-output schema. The Messages API constrains the response to this
// shape, so the result is always parseable JSON. (Numeric min/max constraints
// aren't supported by structured outputs, so confidence is clamped in code.)
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['BUY', 'SELL', 'NEUTRAL'] },
    confidence: { type: 'integer', description: 'Conviction from 0 to 100' },
    summary: { type: 'string', description: 'One-sentence call, under 25 words' },
    rationale: {
      type: 'array',
      items: { type: 'string' },
      description: '2-4 concise bullet points justifying the verdict',
    },
    keyRisks: {
      type: 'array',
      items: { type: 'string' },
      description: '1-3 things that would invalidate the call',
    },
    agreesWithTechnical: {
      type: 'boolean',
      description: 'Whether the verdict matches the technical signal',
    },
    timeHorizon: {
      type: 'string',
      description: 'e.g. "intraday", "swing (days)", "position (weeks)"',
    },
  },
  required: [
    'verdict',
    'confidence',
    'summary',
    'rationale',
    'keyRisks',
    'agreesWithTechnical',
    'timeHorizon',
  ],
  additionalProperties: false,
} as const

const SYSTEM_PROMPT = `You are a disciplined forex trading analyst.
You are given the output of a deterministic technical-analysis engine (indicators
and a weighted signal) plus recent market news with sentiment for one currency pair.

Your job: weigh the technical picture against the news and macro context, then issue
a single actionable verdict. Be decisive but honest about uncertainty:
- If the indicators conflict or the trend is weak (low ADX), prefer NEUTRAL and say so.
- If recent news contradicts the technical signal, surface that tension explicitly.
- Confidence should reflect agreement across indicators AND news, not just one.
- Never invent prices, levels, or data points that aren't provided.
This is educational analysis, not financial advice.`

export async function runAIModel(input: AIModelInput): Promise<AIInsight> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return heuristicInsight(input)

  try {
    const client = new Anthropic({ apiKey })

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: `Analyze ${input.pair} and return your verdict.\n\n${buildMarketBrief(input)}`,
        },
      ],
    })

    if (response.stop_reason === 'refusal') return heuristicInsight(input)

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()

    if (!text) return heuristicInsight(input)

    const parsed = JSON.parse(text) as Omit<AIInsight, 'source' | 'model'>
    return {
      ...parsed,
      verdict: normalizeVerdict(parsed.verdict),
      confidence: clampConfidence(parsed.confidence),
      rationale: Array.isArray(parsed.rationale) ? parsed.rationale : [],
      keyRisks: Array.isArray(parsed.keyRisks) ? parsed.keyRisks : [],
      source: 'ai',
      model: response.model,
    }
  } catch (err) {
    console.error('AI model error:', err)
    return heuristicInsight(input)
  }
}

// Serializes the market state into a compact brief for the model.
function buildMarketBrief(input: AIModelInput): string {
  const { indicators: ind, signal, news } = input
  const lines: string[] = []

  lines.push(`Current price: ${input.currentPrice}`)
  lines.push(`24h change: ${input.priceChangePct24h.toFixed(2)}%`)
  lines.push('')
  lines.push('Technical signal:')
  lines.push(`  Type: ${signal.type} (confidence ${signal.confidence.toFixed(0)}%)`)
  lines.push(`  Entry ${signal.entryPrice}, SL ${signal.stopLoss}, TP1 ${signal.takeProfit1}`)
  for (const s of signal.scores) {
    lines.push(`  - ${s.indicator}: ${s.signal} (weight ${s.weight}, ${s.value}) — ${s.description}`)
  }
  lines.push('')
  lines.push('Indicators:')
  lines.push(`  RSI ${ind.rsi.toFixed(1)}, ADX ${ind.adx.toFixed(1)}, ATR ${ind.atr}`)
  lines.push(`  MACD ${ind.macd.macd.toFixed(5)} / signal ${ind.macd.signal.toFixed(5)}`)
  lines.push(`  EMA20 ${ind.ema20.toFixed(5)} vs EMA50 ${ind.ema50.toFixed(5)}`)
  lines.push(`  Stochastic %K ${ind.stochastic.k.toFixed(1)} / %D ${ind.stochastic.d.toFixed(1)}`)
  lines.push('')

  if (news.length === 0) {
    lines.push('Recent news: none available.')
  } else {
    lines.push('Recent news (most recent first):')
    for (const a of news.slice(0, 6)) {
      lines.push(`  - [${a.sentiment}] ${a.title} (${a.source})`)
    }
  }

  return lines.join('\n')
}

function normalizeVerdict(v: unknown): SignalType {
  return v === 'BUY' || v === 'SELL' ? v : 'NEUTRAL'
}

function clampConfidence(c: unknown): number {
  const n = typeof c === 'number' ? c : Number(c)
  if (!Number.isFinite(n)) return 50
  return Math.max(0, Math.min(100, Math.round(n)))
}

// Deterministic fallback used when no API key is set or the model call fails.
// Blends the technical signal with news sentiment so the output is still useful.
function heuristicInsight(input: AIModelInput): AIInsight {
  const { signal, news, indicators: ind } = input
  const positive = news.filter(n => n.sentiment === 'positive').length
  const negative = news.filter(n => n.sentiment === 'negative').length
  const newsTilt = positive - negative

  const trendStrong = ind.adx > 25
  const newsAgrees =
    (signal.type === 'BUY' && newsTilt >= 0) ||
    (signal.type === 'SELL' && newsTilt <= 0) ||
    signal.type === 'NEUTRAL'

  let confidence = signal.confidence
  if (!trendStrong) confidence -= 8
  if (!newsAgrees) confidence -= 12
  if (newsAgrees && newsTilt !== 0) confidence += 5
  confidence = clampConfidence(confidence)

  const rationale: string[] = []
  const topScores = [...signal.scores]
    .filter(s => s.signal === signal.type && s.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
  for (const s of topScores) rationale.push(`${s.indicator}: ${s.description}`)
  if (rationale.length === 0) {
    rationale.push('Indicators are mixed with no clear directional edge.')
  }
  rationale.push(
    trendStrong
      ? `ADX ${ind.adx.toFixed(0)} confirms a strong trend, so the signal is more reliable.`
      : `ADX ${ind.adx.toFixed(0)} shows a weak trend, so signals are less reliable.`,
  )
  if (news.length > 0) {
    rationale.push(
      newsTilt > 0
        ? `News flow skews bullish (${positive} positive vs ${negative} negative).`
        : newsTilt < 0
          ? `News flow skews bearish (${negative} negative vs ${positive} positive).`
          : 'News sentiment is balanced.',
    )
  }

  const keyRisks: string[] = []
  if (!newsAgrees) keyRisks.push('Recent news sentiment runs counter to the technical signal.')
  if (!trendStrong) keyRisks.push('Weak trend strength raises the odds of a false breakout.')
  keyRisks.push(`A close beyond the stop loss (${signal.stopLoss}) invalidates the setup.`)

  return {
    verdict: signal.type,
    confidence,
    summary:
      signal.type === 'NEUTRAL'
        ? `No high-conviction edge on ${input.pair} right now — stand aside.`
        : `${signal.type} bias on ${input.pair} with ${confidence}% conviction.`,
    rationale,
    keyRisks,
    agreesWithTechnical: true,
    timeHorizon: trendStrong ? 'swing (days)' : 'intraday',
    source: 'heuristic',
  }
}

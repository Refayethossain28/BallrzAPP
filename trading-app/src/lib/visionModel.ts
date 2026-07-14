import Anthropic from '@anthropic-ai/sdk'
import type { ScreenshotAnalysis, SignalType } from './types'

// Reads a trading-platform screenshot (Plus500, MT4, TradingView, ...) with
// Claude vision and produces a trade plan: BUY/SELL verdict, entry, take
// profit, and stop loss. Runs server-side only — the API key never reaches
// the browser. Unlike the pair analyzer there is no heuristic fallback:
// without a vision model there is nothing to read the image with.

// Claude Fable 5, with Opus 4.8 as a server-side fallback: if Fable 5's
// safety classifiers decline a request, the API re-runs it on Opus in the
// same call. The response's `model` field reports which one answered.
const MODEL = 'claude-fable-5'
const FALLBACK_MODEL = 'claude-opus-4-8'

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

// Structured-output schema. Numeric min/max constraints aren't supported by
// structured outputs, so confidence is clamped in code. Prices are strings so
// the model can carry the instrument's native precision (162.224, 1.08453, ...).
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    isChart: {
      type: 'boolean',
      description: 'Whether the image actually shows a tradeable price chart or trading platform screen',
    },
    instrument: { type: 'string', description: 'e.g. "USD/JPY", "XAU/USD", "Unknown"' },
    timeframe: { type: 'string', description: 'Chart timeframe if visible, e.g. "30m", else "unknown"' },
    currentPrice: { type: 'string', description: 'Current/last price read from the screenshot' },
    verdict: { type: 'string', enum: ['BUY', 'SELL', 'NEUTRAL'] },
    confidence: { type: 'integer', description: 'Conviction from 0 to 100' },
    entry: { type: 'string', description: 'Suggested entry price' },
    takeProfit1: { type: 'string', description: 'First take-profit level' },
    takeProfit2: { type: 'string', description: 'Second (extended) take-profit level' },
    stopLoss: { type: 'string', description: 'Stop-loss level' },
    riskRewardRatio: { type: 'string', description: 'e.g. "1:2.1" using TP1' },
    summary: { type: 'string', description: 'One-sentence call, under 30 words' },
    rationale: {
      type: 'array',
      items: { type: 'string' },
      description: '2-5 concise bullet points justifying the verdict, grounded in what is visible',
    },
    keyRisks: {
      type: 'array',
      items: { type: 'string' },
      description: '1-3 things that would invalidate the setup',
    },
  },
  required: [
    'isChart', 'instrument', 'timeframe', 'currentPrice', 'verdict', 'confidence',
    'entry', 'takeProfit1', 'takeProfit2', 'stopLoss', 'riskRewardRatio',
    'summary', 'rationale', 'keyRisks',
  ],
  additionalProperties: false,
} as const

const SYSTEM_PROMPT = `You are a disciplined technical analyst. You are shown a screenshot
from a trading platform (Plus500, MetaTrader, TradingView, or similar).

Read everything visible: the instrument name, bid/ask or sell/buy quotes, the candlestick
chart (trend, swing highs/lows, support and resistance, moving averages), the timeframe,
and any stats shown (change %, high/low ranges).

Then produce ONE actionable trade plan:
- verdict: BUY, SELL, or NEUTRAL. Be decisive when the chart supports it, but prefer
  NEUTRAL when the picture is genuinely mixed or ranging — do not force a trade.
- entry: at or very close to the current visible price (use the ask for BUY, bid for SELL
  when both are shown).
- stopLoss: beyond the nearest meaningful swing high/low or structure level visible on the
  chart — never an arbitrary distance.
- takeProfit1 / takeProfit2: at the next visible resistance (for BUY) or support (for SELL)
  levels, with TP2 beyond TP1. Aim for at least ~1:1.5 risk-reward on TP1 when structure allows.
- Use the same decimal precision as the prices shown in the screenshot.
- Never invent price levels that contradict what is visible. All rationale must reference
  things actually visible in the image.
- If the image is not a price chart or trading screen, set isChart to false, verdict NEUTRAL,
  and explain in the summary.

This is educational analysis, not financial advice.`

export async function analyzeScreenshot(
  imageBase64: string,
  mediaType: ImageMediaType,
): Promise<ScreenshotAnalysis | { error: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return {
      error:
        'AI vision is not configured. Set ANTHROPIC_API_KEY on the server to enable screenshot analysis.',
    }
  }

  try {
    const client = new Anthropic({ apiKey })

    // Fable 5 has thinking always on — the `thinking` param is omitted.
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4096,
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: FALLBACK_MODEL }],
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: imageBase64 },
            },
            {
              type: 'text',
              text: 'Analyze this trading screenshot and return your trade plan.',
            },
          ],
        },
      ],
    })

    if (response.stop_reason === 'refusal') {
      return { error: 'The AI declined to analyze this image. Try a different screenshot.' }
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()

    if (!text) return { error: 'The AI returned an empty analysis. Please try again.' }

    const parsed = JSON.parse(text) as Omit<ScreenshotAnalysis, 'model'>
    return {
      ...parsed,
      verdict: normalizeVerdict(parsed.verdict),
      confidence: clampConfidence(parsed.confidence),
      rationale: Array.isArray(parsed.rationale) ? parsed.rationale : [],
      keyRisks: Array.isArray(parsed.keyRisks) ? parsed.keyRisks : [],
      model: response.model,
    }
  } catch (err) {
    console.error('Vision model error:', err)
    if (err instanceof Anthropic.AuthenticationError) {
      return { error: 'The configured ANTHROPIC_API_KEY is invalid.' }
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { error: 'The AI is rate-limited right now. Wait a moment and try again.' }
    }
    return { error: 'Failed to analyze the screenshot. Please try again.' }
  }
}

function normalizeVerdict(v: unknown): SignalType {
  return v === 'BUY' || v === 'SELL' ? v : 'NEUTRAL'
}

function clampConfidence(c: unknown): number {
  const n = typeof c === 'number' ? c : Number(c)
  if (!Number.isFinite(n)) return 50
  return Math.max(0, Math.min(100, Math.round(n)))
}

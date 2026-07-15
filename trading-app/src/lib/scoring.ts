// Shared trade-scoring engine, used by the on-visit /api/score-trades route
// and the real-time background worker. Walks hourly candles (Yahoo Finance
// chart API, keyless) from each trade's creation: the first candle touching
// TP1 wins, SL loses, and a candle spanning both is ambiguous (stays open).

export interface ScorableTrade {
  id: string
  instrument: string
  verdict: 'BUY' | 'SELL'
  takeProfit1: string
  stopLoss: string
  createdAt: string
}

export interface Candle { t: number; high: number; low: number }

export const MAX_TRADE_AGE_DAYS = 60

export function toYahooSymbol(instrument: string): string | null {
  const cleaned = instrument.toUpperCase().replace(/\s/g, '')
  const m = cleaned.match(/^([A-Z]{3})\/?([A-Z]{3})$/)
  if (!m) return null
  const [, base, quote] = m
  if (base === 'XAU') return 'GC=F'  // gold futures — closest keyless proxy
  if (base === 'XAG') return 'SI=F'
  if (base === 'BTC' || base === 'ETH') return `${base}-${quote}`
  return `${base}${quote}=X`
}

export async function fetchCandles(symbol: string, fromUnix: number): Promise<Candle[] | null> {
  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?period1=${fromUnix}&period2=${Math.floor(Date.now() / 1000)}&interval=60m`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (ApexFX journal scoring)' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const data = await res.json() as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ high?: (number | null)[]; low?: (number | null)[] }> } }> }
    }
    const r = data.chart?.result?.[0]
    const ts = r?.timestamp
    const q = r?.indicators?.quote?.[0]
    if (!ts || !q?.high || !q?.low) return null
    const candles: Candle[] = []
    for (let i = 0; i < ts.length; i++) {
      const high = q.high[i]
      const low = q.low[i]
      if (high != null && low != null) candles.push({ t: ts[i] * 1000, high, low })
    }
    return candles
  } catch {
    return null
  }
}

export function scoreTrade(trade: ScorableTrade, candles: Candle[]): 'tp1' | 'sl' | null {
  const tp = parseFloat(trade.takeProfit1.replace(/[,\s]/g, ''))
  const sl = parseFloat(trade.stopLoss.replace(/[,\s]/g, ''))
  const opened = Date.parse(trade.createdAt)
  if (!Number.isFinite(tp) || !Number.isFinite(sl) || !Number.isFinite(opened)) return null

  for (const c of candles) {
    if (c.t < opened) continue
    const tpHit = trade.verdict === 'BUY' ? c.high >= tp : c.low <= tp
    const slHit = trade.verdict === 'BUY' ? c.low <= sl : c.high >= sl
    if (tpHit && slHit) return null // both inside one candle — ambiguous, leave open
    if (tpHit) return 'tp1'
    if (slHit) return 'sl'
  }
  return null
}

// Scores a batch, fetching each instrument's candles once.
export async function scoreTrades(
  trades: ScorableTrade[],
): Promise<Array<{ id: string; outcome: 'tp1' | 'sl' | null }>> {
  const bySymbol = new Map<string, ScorableTrade[]>()
  const results: Array<{ id: string; outcome: 'tp1' | 'sl' | null }> = []

  for (const t of trades) {
    const symbol = toYahooSymbol(t.instrument)
    if (!symbol) {
      results.push({ id: t.id, outcome: null })
      continue
    }
    const list = bySymbol.get(symbol) ?? []
    list.push(t)
    bySymbol.set(symbol, list)
  }

  for (const [symbol, group] of Array.from(bySymbol.entries())) {
    const oldest = Math.min(...group.map(t => Date.parse(t.createdAt)))
    const from = Math.max(oldest, Date.now() - MAX_TRADE_AGE_DAYS * 86400_000)
    const candles = await fetchCandles(symbol, Math.floor(from / 1000))
    for (const trade of group) {
      results.push({ id: trade.id, outcome: candles ? scoreTrade(trade, candles) : null })
    }
  }
  return results
}

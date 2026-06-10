import { NextRequest, NextResponse } from 'next/server'
import type { OHLCVData, ForexAnalysis } from '@/lib/types'
import { computeIndicators, generateSignal } from '@/lib/technicalAnalysis'

const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY || 'demo'
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || ''

async function fetchAlphaVantageDaily(from: string, to: string): Promise<OHLCVData[]> {
  const url = `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${from}&to_symbol=${to}&outputsize=compact&apikey=${AV_KEY}`
  const res = await fetch(url, { next: { revalidate: 300 } })
  const json = await res.json()

  const series = json['Time Series FX (Daily)'] as Record<string, Record<string, string>> | undefined
  if (!series) return []

  return Object.entries(series)
    .slice(0, 60)
    .reverse()
    .map(([time, bar]) => ({
      time,
      open: parseFloat(bar['1. open']),
      high: parseFloat(bar['2. high']),
      low: parseFloat(bar['3. low']),
      close: parseFloat(bar['4. close']),
      volume: 0,
    }))
}

async function fetchAlphaVantageRate(from: string, to: string): Promise<{ price: number; bid: number; ask: number } | null> {
  const url = `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${from}&to_currency=${to}&apikey=${AV_KEY}`
  const res = await fetch(url, { next: { revalidate: 60 } })
  const json = await res.json()
  const data = json['Realtime Currency Exchange Rate']
  if (!data) return null
  const price = parseFloat(data['5. Exchange Rate'])
  const bid = parseFloat(data['8. Bid Price']) || price
  const ask = parseFloat(data['9. Ask Price']) || price
  return { price, bid, ask }
}

async function fetchFinnhubRate(from: string, to: string): Promise<{ price: number; bid: number; ask: number } | null> {
  if (!FINNHUB_KEY) return null
  try {
    const symbol = `${from}${to}`
    const url = `https://finnhub.io/api/v1/forex/candle?symbol=OANDA:${symbol}&resolution=D&count=60&token=${FINNHUB_KEY}`
    const res = await fetch(url, { next: { revalidate: 300 } })
    const json = await res.json()
    if (json.s !== 'ok') return null
    const last = json.c[json.c.length - 1]
    return { price: last, bid: last, ask: last }
  } catch { return null }
}

// Generates mock OHLCV when APIs are unavailable (for demo/rate-limit scenarios)
function generateMockOHLCV(basePrice: number, days = 60): OHLCVData[] {
  const data: OHLCVData[] = []
  let price = basePrice * (1 - 0.03 + Math.random() * 0.06)
  const now = new Date()
  for (let i = days; i >= 0; i--) {
    const date = new Date(now)
    date.setDate(date.getDate() - i)
    const change = (Math.random() - 0.49) * basePrice * 0.008
    const open = price
    const close = price + change
    const high = Math.max(open, close) + Math.random() * basePrice * 0.003
    const low = Math.min(open, close) - Math.random() * basePrice * 0.003
    data.push({ time: date.toISOString().split('T')[0], open, high, low, close, volume: Math.floor(Math.random() * 100000) })
    price = close
  }
  return data
}

export async function GET(request: NextRequest) {
  const pair = request.nextUrl.searchParams.get('pair') || 'EUR/USD'
  const [from, to] = pair.replace('/', '').split('').reduce<string[]>((acc, _, i, arr) => {
    if (i === 3) return [arr.slice(0, 3).join(''), arr.slice(3).join('')]
    return acc
  }, ['', '']) || pair.split('/')

  const fromCur = pair.includes('/') ? pair.split('/')[0] : pair.slice(0, 3)
  const toCur = pair.includes('/') ? pair.split('/')[1] : pair.slice(3)

  try {
    const [rateData, ohlcvData] = await Promise.allSettled([
      fetchAlphaVantageRate(fromCur, toCur).then(r => r || fetchFinnhubRate(fromCur, toCur)),
      fetchAlphaVantageDaily(fromCur, toCur),
    ])

    let currentPrice = 1.0
    let bid = 1.0
    let ask = 1.0

    if (rateData.status === 'fulfilled' && rateData.value) {
      currentPrice = rateData.value.price
      bid = rateData.value.bid
      ask = rateData.value.ask
    }

    let ohlcv: OHLCVData[] = []
    if (ohlcvData.status === 'fulfilled' && ohlcvData.value.length >= 30) {
      ohlcv = ohlcvData.value
      if (currentPrice === 1.0) currentPrice = ohlcv[ohlcv.length - 1].close
    } else {
      // Use last known price or generate mock data
      if (currentPrice === 1.0) {
        // Fallback prices for common pairs
        const fallbacks: Record<string, number> = {
          'EUR/USD': 1.085, 'GBP/USD': 1.272, 'USD/JPY': 149.5, 'USD/CHF': 0.895,
          'AUD/USD': 0.651, 'USD/CAD': 1.365, 'NZD/USD': 0.601, 'EUR/GBP': 0.852,
          'EUR/JPY': 162.3, 'GBP/JPY': 190.1, 'XAU/USD': 2320.0,
        }
        currentPrice = fallbacks[pair] || 1.0
      }
      ohlcv = generateMockOHLCV(currentPrice)
    }

    if (bid === ask) {
      const spreadFactor = fromCur === 'XAU' ? 0.0003 : 0.0001
      bid = currentPrice * (1 - spreadFactor)
      ask = currentPrice * (1 + spreadFactor)
    }

    const prevClose = ohlcv.length >= 2 ? ohlcv[ohlcv.length - 2].close : currentPrice
    const priceChange24h = currentPrice - prevClose
    const priceChangePct24h = prevClose !== 0 ? (priceChange24h / prevClose) * 100 : 0
    const spread = ask - bid

    const indicators = computeIndicators(ohlcv)
    const signal = generateSignal(indicators, currentPrice, pair)

    const analysis: Omit<ForexAnalysis, 'news'> = {
      pair,
      baseCurrency: fromCur,
      quoteCurrency: toCur,
      currentPrice,
      priceChange24h,
      priceChangePct24h,
      bid,
      ask,
      spread,
      ohlcv: ohlcv.slice(-30),
      indicators,
      signal,
      lastUpdated: new Date().toISOString(),
    }

    return NextResponse.json(analysis)
  } catch (err) {
    console.error('Forex API error:', err)
    return NextResponse.json({ error: 'Failed to fetch forex data' }, { status: 500 })
  }
}

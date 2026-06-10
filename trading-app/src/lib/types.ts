export type SignalType = 'BUY' | 'SELL' | 'NEUTRAL'

export interface OHLCVData {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface TechnicalIndicators {
  rsi: number
  macd: { macd: number; signal: number; histogram: number }
  sma20: number
  sma50: number
  ema20: number
  ema50: number
  bollingerBands: { upper: number; middle: number; lower: number }
  atr: number
  stochastic: { k: number; d: number }
  adx: number
}

export interface SignalScore {
  indicator: string
  signal: SignalType
  weight: number
  value: string
  description: string
}

export interface TradingSignal {
  type: SignalType
  confidence: number // 0-100
  scores: SignalScore[]
  entryPrice: number
  takeProfit1: number
  takeProfit2: number
  takeProfit3: number
  stopLoss: number
  riskRewardRatio: number
  pipValue: number
}

export interface NewsArticle {
  title: string
  description: string
  url: string
  source: string
  publishedAt: string
  sentiment: 'positive' | 'negative' | 'neutral'
}

export interface EconomicEvent {
  date: string
  country: string
  event: string
  impact: 'high' | 'medium' | 'low'
  actual?: string
  forecast?: string
  previous?: string
}

export interface ForexAnalysis {
  pair: string
  baseCurrency: string
  quoteCurrency: string
  currentPrice: number
  priceChange24h: number
  priceChangePct24h: number
  bid: number
  ask: number
  spread: number
  ohlcv: OHLCVData[]
  indicators: TechnicalIndicators
  signal: TradingSignal
  news: NewsArticle[]
  lastUpdated: string
  error?: string
}

export const POPULAR_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD',
  'USD/CAD', 'NZD/USD', 'EUR/GBP', 'EUR/JPY', 'GBP/JPY',
  'EUR/CHF', 'AUD/JPY', 'USD/MXN', 'USD/SGD', 'XAU/USD',
]

export const CURRENCY_FLAGS: Record<string, string> = {
  EUR: 'EU', USD: 'US', GBP: 'GB', JPY: 'JP', CHF: 'CH',
  AUD: 'AU', CAD: 'CA', NZD: 'NZ', MXN: 'MX', SGD: 'SG',
  XAU: '🥇',
}

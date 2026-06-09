'use client'
import type { ForexAnalysis } from '@/lib/types'

interface Props {
  data: ForexAnalysis
}

const isJPY = (pair: string) => pair.includes('JPY')
const isGold = (pair: string) => pair.includes('XAU')
function fmt(pair: string, v: number): string {
  if (isGold(pair)) return v.toFixed(2)
  if (isJPY(pair)) return v.toFixed(3)
  return v.toFixed(5)
}

function StatBox({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-surface-muted rounded-lg px-4 py-3">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`font-mono font-semibold text-base ${color || 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

export default function MarketOverview({ data }: Props) {
  const changeColor = data.priceChange24h >= 0 ? 'text-buy' : 'text-sell'
  const changeSign = data.priceChange24h >= 0 ? '+' : ''

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white font-mono tracking-wide">{data.pair}</h1>
          <p className="text-gray-400 text-sm mt-0.5">{data.baseCurrency} / {data.quoteCurrency}</p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-bold font-mono text-white">{fmt(data.pair, data.currentPrice)}</p>
          <p className={`text-sm font-semibold ${changeColor}`}>
            {changeSign}{fmt(data.pair, data.priceChange24h)} ({changeSign}{data.priceChangePct24h.toFixed(3)}%)
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatBox label="Bid" value={fmt(data.pair, data.bid)} />
        <StatBox label="Ask" value={fmt(data.pair, data.ask)} />
        <StatBox label="Spread" value={fmt(data.pair, data.spread)} sub="pips" />
        <StatBox label="24h Change" value={`${changeSign}${data.priceChangePct24h.toFixed(3)}%`} color={changeColor} />
        <StatBox label="RSI (14)" value={data.indicators.rsi.toFixed(1)} color={data.indicators.rsi > 65 ? 'text-sell' : data.indicators.rsi < 35 ? 'text-buy' : 'text-white'} />
        <StatBox label="ATR (14)" value={fmt(data.pair, data.indicators.atr)} sub="volatility" />
        <StatBox label="ADX (14)" value={data.indicators.adx.toFixed(1)} sub={data.indicators.adx > 25 ? 'Strong trend' : 'Weak trend'} />
        <StatBox label="SMA 50" value={fmt(data.pair, data.indicators.sma50)} />
      </div>

      <p className="text-xs text-gray-500 mt-3 text-right">
        Last updated: {new Date(data.lastUpdated).toLocaleTimeString()}
      </p>
    </div>
  )
}

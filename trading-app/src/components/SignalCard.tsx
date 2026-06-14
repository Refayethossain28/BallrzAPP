'use client'
import type { TradingSignal, SignalType } from '@/lib/types'
import BrokerButtons from '@/components/BrokerButtons'

interface Props {
  signal: TradingSignal
  pair: string
  currentPrice: number
}

function pips(pair: string, price: number): string {
  const isJpy = pair.includes('JPY')
  const isGold = pair.includes('XAU')
  if (isGold) return price.toFixed(2)
  if (isJpy) return price.toFixed(3)
  return price.toFixed(5)
}

function SignalBadge({ type }: { type: SignalType }) {
  if (type === 'BUY') return (
    <span className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-buy/20 text-buy border border-buy/40 text-sm font-bold tracking-wider">
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M3.293 9.707a1 1 0 010-1.414l6-6a1 1 0 011.414 0l6 6a1 1 0 01-1.414 1.414L11 5.414V17a1 1 0 11-2 0V5.414L4.707 9.707a1 1 0 01-1.414 0z" clipRule="evenodd" />
      </svg>
      BUY
    </span>
  )
  if (type === 'SELL') return (
    <span className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-sell/20 text-sell border border-sell/40 text-sm font-bold tracking-wider">
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M16.707 10.293a1 1 0 010 1.414l-6 6a1 1 0 01-1.414 0l-6-6a1 1 0 111.414-1.414L9 14.586V3a1 1 0 012 0v11.586l4.293-4.293a1 1 0 011.414 0z" clipRule="evenodd" />
      </svg>
      SELL
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 text-sm font-bold tracking-wider">
      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
      </svg>
      NEUTRAL
    </span>
  )
}

export default function SignalCard({ signal, pair, currentPrice }: Props) {
  const isBuy = signal.type === 'BUY'
  const isSell = signal.type === 'SELL'
  const accentColor = isBuy ? '#00c853' : isSell ? '#d50000' : '#f59e0b'

  const tpDistance = Math.abs(signal.takeProfit1 - signal.entryPrice)
  const slDistance = Math.abs(signal.stopLoss - signal.entryPrice)
  const rrRatio = slDistance > 0 ? (tpDistance / slDistance).toFixed(1) : '—'

  return (
    <div className="card p-6 animate-fade-in" style={{ borderColor: `${accentColor}40` }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-gray-400 text-sm mb-1">Trading Signal</p>
          <div className="flex items-center gap-3">
            <SignalBadge type={signal.type} />
            <span className="text-gray-400 text-sm">{signal.confidence.toFixed(0)}% confidence</span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-gray-400 text-xs mb-1">Risk / Reward</p>
          <p className="text-white font-mono font-bold text-xl">1 : {rrRatio}</p>
        </div>
      </div>

      {/* Confidence Bar */}
      <div className="mb-6">
        <div className="flex justify-between text-xs text-gray-400 mb-1">
          <span>Signal Strength</span>
          <span>{signal.confidence.toFixed(0)}%</span>
        </div>
        <div className="h-2 bg-surface-muted rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${signal.confidence}%`, backgroundColor: accentColor }}
          />
        </div>
      </div>

      {/* Price Levels */}
      <div className="grid grid-cols-1 gap-3">
        {/* TP Levels */}
        <div className="space-y-2">
          <p className="text-xs text-gray-500 uppercase tracking-wider">Take Profit Levels</p>
          {[
            { label: 'TP1', price: signal.takeProfit1, pct: '1R' },
            { label: 'TP2', price: signal.takeProfit2, pct: '2R' },
            { label: 'TP3', price: signal.takeProfit3, pct: '3R' },
          ].map(({ label, price, pct }) => (
            <div key={label} className="flex items-center justify-between bg-buy/10 border border-buy/20 rounded-lg px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-buy text-xs font-semibold w-8">{label}</span>
                <span className="text-gray-400 text-xs">{pct}</span>
              </div>
              <span className="font-mono text-buy font-semibold">{pips(pair, price)}</span>
            </div>
          ))}
        </div>

        {/* Entry */}
        <div className="flex items-center justify-between bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-2.5">
          <span className="text-blue-400 text-sm font-semibold">Entry Price</span>
          <span className="font-mono text-blue-300 font-bold">{pips(pair, signal.entryPrice)}</span>
        </div>

        {/* SL */}
        <div className="flex items-center justify-between bg-sell/10 border border-sell/20 rounded-lg px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sell text-sm font-semibold">Stop Loss</span>
            <span className="text-gray-400 text-xs">1.5R</span>
          </div>
          <span className="font-mono text-sell font-semibold">{pips(pair, signal.stopLoss)}</span>
        </div>
      </div>

      {/* ATR Info */}
      <div className="mt-4 pt-4 border-t border-surface-border flex items-center justify-between text-xs text-gray-500">
        <span>ATR (14) = {pips(pair, signal.pipValue)}</span>
        <span>Levels based on 1.0x / 1.5x ATR</span>
      </div>

      {/* Broker Affiliate Buttons */}
      <BrokerButtons signal={signal.type} />
    </div>
  )
}

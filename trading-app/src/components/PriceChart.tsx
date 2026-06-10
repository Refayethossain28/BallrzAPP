'use client'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import type { OHLCVData, TradingSignal } from '@/lib/types'

interface Props {
  data: OHLCVData[]
  signal: TradingSignal
  pair: string
}

const isJPY = (pair: string) => pair.includes('JPY')
const isGold = (pair: string) => pair.includes('XAU')
const decimals = (pair: string) => isGold(pair) ? 2 : isJPY(pair) ? 3 : 5

function fmt(pair: string, v: number) {
  return v.toFixed(decimals(pair))
}

export default function PriceChart({ data, signal, pair }: Props) {
  const isBuy = signal.type === 'BUY'
  const isSell = signal.type === 'SELL'
  const color = isBuy ? '#00c853' : isSell ? '#d50000' : '#f59e0b'
  const d = decimals(pair)

  const chartData = data.map(bar => ({
    date: bar.time.slice(5),
    close: parseFloat(bar.close.toFixed(d)),
    high: parseFloat(bar.high.toFixed(d)),
    low: parseFloat(bar.low.toFixed(d)),
  }))

  const allVals = chartData.flatMap(c => [c.close])
  const levels = [signal.stopLoss, signal.takeProfit1, signal.takeProfit2, signal.takeProfit3, signal.entryPrice].filter(Boolean)
  const allWithLevels = [...allVals, ...levels]
  const minVal = Math.min(...allWithLevels)
  const maxVal = Math.max(...allWithLevels)
  const padding = (maxVal - minVal) * 0.15
  const domain: [number, number] = [parseFloat((minVal - padding).toFixed(d)), parseFloat((maxVal + padding).toFixed(d))]

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white font-semibold text-lg">Price Chart (Daily)</h2>
        <span className="text-xs text-gray-400">Last 30 sessions</span>
      </div>

      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
            <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis
              domain={domain}
              tick={{ fill: '#6b7280', fontSize: 11 }}
              tickFormatter={v => v.toFixed(d)}
              width={70}
            />
            <Tooltip
              contentStyle={{ background: '#1a1d2e', border: '1px solid #2a2d3e', borderRadius: 8, color: '#e2e8f0', fontSize: 12 }}
              formatter={(v: number) => [fmt(pair, v), 'Close']}
            />
            <Area type="monotone" dataKey="close" stroke={color} strokeWidth={2} fill="url(#priceGrad)" dot={false} />
            <ReferenceLine y={signal.entryPrice} stroke="#3b82f6" strokeDasharray="5 5" strokeWidth={1.5} label={{ value: 'Entry', fill: '#3b82f6', fontSize: 10 }} />
            <ReferenceLine y={signal.stopLoss} stroke="#d50000" strokeDasharray="5 5" strokeWidth={1.5} label={{ value: 'SL', fill: '#d50000', fontSize: 10 }} />
            <ReferenceLine y={signal.takeProfit1} stroke="#00c853" strokeDasharray="5 5" strokeWidth={1.5} label={{ value: 'TP1', fill: '#00c853', fontSize: 10 }} />
            <ReferenceLine y={signal.takeProfit2} stroke="#00c853" strokeDasharray="5 5" strokeWidth={1} label={{ value: 'TP2', fill: '#00c853', fontSize: 10 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

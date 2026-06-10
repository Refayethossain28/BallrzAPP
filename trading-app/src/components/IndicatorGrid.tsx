'use client'
import type { SignalScore } from '@/lib/types'

interface Props {
  scores: SignalScore[]
}

function SignalDot({ signal }: { signal: string }) {
  if (signal === 'BUY') return <span className="w-2.5 h-2.5 rounded-full bg-buy inline-block" />
  if (signal === 'SELL') return <span className="w-2.5 h-2.5 rounded-full bg-sell inline-block" />
  return <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 inline-block" />
}

function badgeClass(signal: string) {
  if (signal === 'BUY') return 'badge-buy'
  if (signal === 'SELL') return 'badge-sell'
  return 'badge-neutral'
}

export default function IndicatorGrid({ scores }: Props) {
  const active = scores.filter(s => s.weight > 0)
  const buy = active.filter(s => s.signal === 'BUY').length
  const sell = active.filter(s => s.signal === 'SELL').length
  const neutral = active.filter(s => s.signal === 'NEUTRAL').length

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white font-semibold text-lg">Technical Indicators</h2>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-buy" />{buy} BUY</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sell" />{sell} SELL</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400" />{neutral} NEUTRAL</span>
        </div>
      </div>

      <div className="space-y-3">
        {scores.map((score) => (
          <div key={score.indicator} className="flex items-start justify-between gap-4 py-3 border-b border-surface-border last:border-0">
            <div className="flex items-start gap-3 flex-1 min-w-0">
              <SignalDot signal={score.signal} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{score.indicator}</p>
                <p className="text-xs text-gray-400 mt-0.5">{score.description}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-xs text-gray-300">{score.value}</span>
              <span className={badgeClass(score.signal)}>{score.signal}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

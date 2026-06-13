'use client'
import type { AIInsight, SignalType } from '@/lib/types'

interface Props {
  insight: AIInsight | null
  loading: boolean
}

function accentFor(type: SignalType): string {
  return type === 'BUY' ? '#00c853' : type === 'SELL' ? '#d50000' : '#f59e0b'
}

function VerdictBadge({ type }: { type: SignalType }) {
  if (type === 'BUY') return <span className="badge-buy">BUY</span>
  if (type === 'SELL') return <span className="badge-sell">SELL</span>
  return <span className="badge-neutral">NEUTRAL</span>
}

export default function AIInsightCard({ insight, loading }: Props) {
  if (loading) {
    return (
      <div className="card p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-surface-muted rounded w-1/3" />
          <div className="h-16 bg-surface-muted rounded" />
          <div className="h-4 bg-surface-muted rounded w-3/4" />
          <div className="h-4 bg-surface-muted rounded w-2/3" />
        </div>
      </div>
    )
  }

  if (!insight) return null

  const accent = accentFor(insight.verdict)

  return (
    <div className="card p-6 animate-fade-in" style={{ borderColor: `${accent}40` }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-300 text-xs font-bold">
            AI
          </span>
          <div>
            <h2 className="text-white font-semibold text-lg leading-none">AI Analyst</h2>
            <p className="text-gray-500 text-xs mt-0.5">
              {insight.source === 'ai'
                ? `Model verdict${insight.model ? ` · ${insight.model}` : ''}`
                : 'Heuristic (set ANTHROPIC_API_KEY for live AI)'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <VerdictBadge type={insight.verdict} />
          <span className="text-gray-400 text-sm">{insight.confidence}%</span>
        </div>
      </div>

      {/* Confidence bar */}
      <div className="mb-4">
        <div className="h-2 bg-surface-muted rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${insight.confidence}%`, backgroundColor: accent }}
          />
        </div>
      </div>

      <p className="text-white text-sm leading-relaxed mb-4">{insight.summary}</p>

      <div className="flex items-center gap-2 mb-4 text-xs">
        <span className="text-gray-500">Horizon:</span>
        <span className="text-gray-300">{insight.timeHorizon}</span>
        <span className="text-gray-600">·</span>
        <span className={insight.agreesWithTechnical ? 'text-buy' : 'text-yellow-400'}>
          {insight.agreesWithTechnical ? 'Agrees with technicals' : 'Diverges from technicals'}
        </span>
      </div>

      {insight.rationale.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Why</p>
          <ul className="space-y-1.5">
            {insight.rationale.map((r, i) => (
              <li key={i} className="flex gap-2 text-sm text-gray-300">
                <span style={{ color: accent }}>•</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {insight.keyRisks.length > 0 && (
        <div className="pt-4 border-t border-surface-border">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Key risks</p>
          <ul className="space-y-1.5">
            {insight.keyRisks.map((r, i) => (
              <li key={i} className="flex gap-2 text-sm text-gray-400">
                <span className="text-sell">!</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

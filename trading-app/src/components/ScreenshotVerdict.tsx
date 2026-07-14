'use client'
import type { ScreenshotAnalysis } from '@/lib/types'
import { TrendingUp, TrendingDown, Minus, Target, ShieldAlert, LogIn, AlertTriangle, Globe } from 'lucide-react'

const VERDICT_STYLES = {
  BUY: { badge: 'bg-buy/20 text-buy border-buy/40', bar: 'bg-buy', Icon: TrendingUp },
  SELL: { badge: 'bg-sell/20 text-sell border-sell/40', bar: 'bg-sell', Icon: TrendingDown },
  NEUTRAL: { badge: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40', bar: 'bg-yellow-500', Icon: Minus },
} as const

export default function ScreenshotVerdict({ result }: { result: ScreenshotAnalysis }) {
  const { badge, bar, Icon } = VERDICT_STYLES[result.verdict]

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Verdict header */}
      <div className="card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl border text-2xl font-bold ${badge}`}>
                <Icon className="w-7 h-7" />
                {result.verdict}
              </span>
              <div>
                <p className="text-white font-semibold text-lg font-mono">{result.instrument}</p>
                <p className="text-gray-500 text-xs">
                  {result.timeframe !== 'unknown' && `${result.timeframe} chart · `}
                  Price {result.currentPrice}
                </p>
              </div>
            </div>
          </div>
          <div className="min-w-[140px]">
            <div className="flex justify-between text-xs text-gray-400 mb-1">
              <span>Confidence</span>
              <span className="text-white font-semibold">{result.confidence}%</span>
            </div>
            <div className="h-2 rounded-full bg-surface-muted overflow-hidden">
              <div className={`h-full rounded-full ${bar}`} style={{ width: `${result.confidence}%` }} />
            </div>
          </div>
        </div>
        <p className="text-gray-300 text-sm mt-4">{result.summary}</p>
        {result.liveContext && !/^not available/i.test(result.liveContext.trim()) && (
          <div className="mt-3 flex gap-2 items-start text-sm text-blue-300/90 bg-blue-600/10 border border-blue-500/20 rounded-lg px-3 py-2">
            <Globe className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{result.liveContext}</span>
          </div>
        )}
      </div>

      {/* Trade levels */}
      {result.verdict !== 'NEUTRAL' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <LevelCard label="Entry" value={result.entry} icon={<LogIn className="w-4 h-4" />} tone="text-blue-400" />
          <LevelCard label="Take Profit 1" value={result.takeProfit1} icon={<Target className="w-4 h-4" />} tone="text-buy" />
          <LevelCard label="Take Profit 2" value={result.takeProfit2} icon={<Target className="w-4 h-4" />} tone="text-buy" />
          <LevelCard label="Stop Loss" value={result.stopLoss} icon={<ShieldAlert className="w-4 h-4" />} tone="text-sell" />
        </div>
      )}

      {result.verdict !== 'NEUTRAL' && (
        <div className="card px-4 py-3 flex items-center justify-between text-sm">
          <span className="text-gray-400">Risk / Reward (TP1)</span>
          <span className="text-white font-mono font-semibold">{result.riskRewardRatio}</span>
        </div>
      )}

      {/* Rationale + risks */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-5">
          <h3 className="text-white font-semibold text-sm mb-3">Why</h3>
          <ul className="space-y-2">
            {result.rationale.map((r, i) => (
              <li key={i} className="text-gray-400 text-sm flex gap-2">
                <span className="text-blue-400 shrink-0">•</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
        <div className="card p-5">
          <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-yellow-500" /> Key Risks
          </h3>
          <ul className="space-y-2">
            {result.keyRisks.map((r, i) => (
              <li key={i} className="text-gray-400 text-sm flex gap-2">
                <span className="text-yellow-500 shrink-0">•</span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {result.model && (
        <p className="text-center text-[11px] text-gray-600">Analyzed by {result.model}</p>
      )}
    </div>
  )
}

function LevelCard({ label, value, icon, tone }: { label: string; value: string; icon: React.ReactNode; tone: string }) {
  return (
    <div className="card p-4">
      <div className={`flex items-center gap-1.5 text-xs mb-1 ${tone}`}>
        {icon}
        {label}
      </div>
      <p className="text-white font-mono font-bold text-lg">{value}</p>
    </div>
  )
}

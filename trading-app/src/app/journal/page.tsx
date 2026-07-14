'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  loadJournal, setOutcome, removeEntry, clearJournal, computeStats,
  type JournalEntry, type TradeOutcome,
} from '@/lib/journal'
import { Trash2, BookOpen } from 'lucide-react'

// Trade journal + scoreboard. Entries live in this device's localStorage —
// every analysis is saved automatically; outcomes are marked by the trader.

const OUTCOME_OPTIONS: Array<{ value: TradeOutcome; label: string; tone: string }> = [
  { value: 'open', label: 'Open', tone: 'text-blue-300 border-blue-500/50 bg-blue-600/20' },
  { value: 'tp1', label: 'TP1 ✓', tone: 'text-buy border-buy/50 bg-buy/15' },
  { value: 'tp2', label: 'TP2 ✓✓', tone: 'text-buy border-buy/50 bg-buy/15' },
  { value: 'sl', label: 'SL ✗', tone: 'text-sell border-sell/50 bg-sell/15' },
  { value: 'breakeven', label: 'BE', tone: 'text-gray-300 border-gray-500/50 bg-gray-500/15' },
  { value: 'skipped', label: 'Skipped', tone: 'text-gray-400 border-gray-600/50 bg-gray-600/10' },
]

const VERDICT_BADGE: Record<string, string> = {
  BUY: 'badge-buy',
  SELL: 'badge-sell',
  NEUTRAL: 'badge-neutral',
}

export default function JournalPage() {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setEntries(loadJournal())
    setLoaded(true)
  }, [])

  const stats = computeStats(entries)

  const mark = (id: string, outcome: TradeOutcome) => {
    setOutcome(id, outcome)
    setEntries(loadJournal())
  }

  const remove = (id: string) => {
    removeEntry(id)
    setEntries(loadJournal())
  }

  const clearAll = () => {
    if (window.confirm('Delete the entire journal? This cannot be undone.')) {
      clearJournal()
      setEntries([])
    }
  }

  return (
    <div className="min-h-screen bg-surface-DEFAULT">
      <header className="border-b border-surface-border bg-surface-card/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-sm font-bold">FX</div>
            <div>
              <h1 className="text-white font-bold text-base leading-none">ApexFX</h1>
              <p className="text-gray-400 text-xs">Trade Journal</p>
            </div>
          </Link>
          <Link href="/screenshot" className="text-xs text-gray-400 hover:text-white transition-colors">
            ← Analyzer
          </Link>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Scoreboard */}
        <div className="card p-5">
          <h2 className="text-white font-semibold text-sm mb-4">Scoreboard</h2>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 text-center">
            <Stat label="Win rate" value={stats.winRate !== null ? `${stats.winRate}%` : '—'} tone={
              stats.winRate === null ? 'text-gray-400' : stats.winRate >= 50 ? 'text-buy' : 'text-sell'
            } />
            <Stat label="Calls" value={String(stats.total)} tone="text-white" />
            <Stat label="Wins" value={String(stats.wins)} tone="text-buy" />
            <Stat label="Losses" value={String(stats.losses)} tone="text-sell" />
            <Stat label="Open" value={String(stats.open)} tone="text-blue-300" />
            <Stat label="B/E" value={String(stats.breakeven)} tone="text-gray-300" />
          </div>
          {stats.winRate === null && stats.total > 0 && (
            <p className="text-xs text-gray-500 mt-3 text-center">
              Mark trades as TP1/TP2 or SL below and your win rate appears here.
            </p>
          )}
        </div>

        {/* Entries */}
        {loaded && entries.length === 0 && (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto mb-4">
              <BookOpen className="w-8 h-8 text-blue-400" />
            </div>
            <p className="text-white font-semibold mb-1">No trades yet</p>
            <p className="text-gray-500 text-sm mb-6">Every screenshot you analyze is saved here automatically.</p>
            <Link
              href="/screenshot"
              className="inline-block px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
            >
              Analyze a chart
            </Link>
          </div>
        )}

        <div className="space-y-3">
          {entries.map(e => (
            <div key={e.id} className="card p-4">
              <div className="flex gap-4">
                {e.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={e.thumb} alt="" className="w-16 h-16 object-cover rounded-lg border border-surface-border shrink-0" />
                ) : (
                  <div className="w-16 h-16 rounded-lg bg-surface-muted shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={VERDICT_BADGE[e.verdict]}>{e.verdict}</span>
                    <span className="text-white font-mono font-semibold text-sm">{e.instrument}</span>
                    <span className="text-gray-500 text-xs">
                      {new Date(e.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                      {e.timeframe !== 'unknown' && ` · ${e.timeframe}`}
                      {` · ${e.confidence}%`}
                    </span>
                    <button
                      onClick={() => remove(e.id)}
                      aria-label="Delete entry"
                      className="ml-auto text-gray-600 hover:text-sell transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 font-mono mt-1">
                    E {e.entry} · TP1 {e.takeProfit1} · TP2 {e.takeProfit2} · SL {e.stopLoss}
                  </p>
                  {e.verdict !== 'NEUTRAL' && (
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      {OUTCOME_OPTIONS.map(o => (
                        <button
                          key={o.value}
                          onClick={() => mark(e.id, o.value)}
                          className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                            e.outcome === o.value
                              ? o.tone
                              : 'text-gray-500 border-surface-border hover:border-gray-500'
                          }`}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {entries.length > 0 && (
          <div className="text-center">
            <button onClick={clearAll} className="text-xs text-gray-600 hover:text-sell transition-colors">
              Clear entire journal
            </button>
            <p className="text-[11px] text-gray-600 mt-2">
              The journal is stored on this device only.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-surface-muted/50 border border-surface-border rounded-xl py-3">
      <p className={`text-xl font-bold ${tone}`}>{value}</p>
      <p className="text-[11px] text-gray-500 uppercase tracking-wide mt-0.5">{label}</p>
    </div>
  )
}

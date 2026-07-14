import type { ScreenshotAnalysis, SignalType } from './types'

// Device-local trade journal. Every analysis is saved to localStorage with a
// small thumbnail; the trader marks outcomes as trades resolve, and the
// scoreboard derives an honest hit-rate from what they've marked. Capped so
// we stay well inside localStorage quotas.

export type TradeOutcome = 'open' | 'tp1' | 'tp2' | 'sl' | 'breakeven' | 'skipped'

export interface JournalEntry {
  id: string
  createdAt: string
  instrument: string
  timeframe: string
  verdict: SignalType
  confidence: number
  entry: string
  takeProfit1: string
  takeProfit2: string
  stopLoss: string
  riskRewardRatio: string
  summary: string
  thumb: string // small JPEG data URL
  outcome: TradeOutcome
}

export interface JournalStats {
  total: number
  open: number
  wins: number   // tp1 + tp2
  losses: number // sl
  breakeven: number
  skipped: number
  winRate: number | null // wins / (wins + losses), null until something closed
}

const KEY = 'apexfx-journal'
const MAX_ENTRIES = 60

export function loadJournal(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as JournalEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persist(entries: JournalEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    // Quota exceeded — drop oldest entries and retry once.
    try {
      localStorage.setItem(KEY, JSON.stringify(entries.slice(0, Math.max(10, MAX_ENTRIES / 2))))
    } catch { /* give up quietly; journaling must never break analysis */ }
  }
}

export function addEntry(result: ScreenshotAnalysis, thumb: string): JournalEntry {
  const entry: JournalEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    instrument: result.instrument,
    timeframe: result.timeframe,
    verdict: result.verdict,
    confidence: result.confidence,
    entry: result.entry,
    takeProfit1: result.takeProfit1,
    takeProfit2: result.takeProfit2,
    stopLoss: result.stopLoss,
    riskRewardRatio: result.riskRewardRatio,
    summary: result.summary,
    thumb,
    outcome: 'open',
  }
  persist([entry, ...loadJournal()])
  return entry
}

export function setOutcome(id: string, outcome: TradeOutcome) {
  persist(loadJournal().map(e => (e.id === id ? { ...e, outcome } : e)))
}

export function removeEntry(id: string) {
  persist(loadJournal().filter(e => e.id !== id))
}

export function clearJournal() {
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

export function computeStats(entries: JournalEntry[]): JournalStats {
  const tradeable = entries.filter(e => e.verdict !== 'NEUTRAL')
  const wins = tradeable.filter(e => e.outcome === 'tp1' || e.outcome === 'tp2').length
  const losses = tradeable.filter(e => e.outcome === 'sl').length
  const closed = wins + losses
  return {
    total: entries.length,
    open: tradeable.filter(e => e.outcome === 'open').length,
    wins,
    losses,
    breakeven: tradeable.filter(e => e.outcome === 'breakeven').length,
    skipped: tradeable.filter(e => e.outcome === 'skipped').length,
    winRate: closed > 0 ? Math.round((wins / closed) * 100) : null,
  }
}

// Small thumbnail for journal rows — keeps 60 entries comfortably in quota.
export async function makeThumb(dataUrl: string): Promise<string> {
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = reject
      img.src = dataUrl
    })
    const scale = 160 / Math.max(img.width, img.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.6)
  } catch {
    return ''
  }
}

'use client'
import { useState, useCallback, useEffect, useRef } from 'react'
import type { ForexAnalysis, NewsArticle } from '@/lib/types'
import { POPULAR_PAIRS } from '@/lib/types'
import PairSearch from '@/components/PairSearch'
import SignalCard from '@/components/SignalCard'
import IndicatorGrid from '@/components/IndicatorGrid'
import PriceChart from '@/components/PriceChart'
import NewsSection from '@/components/NewsSection'
import MarketOverview from '@/components/MarketOverview'
import type { Tier } from '@/lib/tier'

const DISCLAIMER = 'This tool is for educational purposes only. Trading forex involves significant risk. Never trade with money you cannot afford to lose.'

const FREE_PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD', 'USD/CHF']

interface AiSignal {
  signal: string
  confidence: number
  tp1: number
  tp2: number
  tp3: number
  sl: number
  analysis: string
  keyFactors: string[]
}

interface Props {
  tier: Tier
}

export default function TradingAppClient({ tier }: Props) {
  const [pair, setPair] = useState('EUR/USD')
  const [loading, setLoading] = useState(false)
  const [newsLoading, setNewsLoading] = useState(false)
  const [analysis, setAnalysis] = useState<ForexAnalysis | null>(null)
  const [news, setNews] = useState<NewsArticle[]>([])
  const [error, setError] = useState<string | null>(null)
  const [aiSignal, setAiSignal] = useState<AiSignal | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [countdown, setCountdown] = useState(300)
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const isPro = tier === 'pro'
  const availablePairs = isPro ? POPULAR_PAIRS : FREE_PAIRS

  const analyze = useCallback(async (selectedPair: string) => {
    setLoading(true)
    setNewsLoading(true)
    setError(null)
    setAiSignal(null)
    setPair(selectedPair)

    try {
      const [forexRes, newsRes] = await Promise.allSettled([
        fetch(`/api/forex?pair=${encodeURIComponent(selectedPair)}`),
        fetch(`/api/news?pair=${encodeURIComponent(selectedPair)}`),
      ])

      let analysisData: ForexAnalysis | null = null

      if (forexRes.status === 'fulfilled' && forexRes.value.ok) {
        const data = await forexRes.value.json() as ForexAnalysis
        if (data.error) { setError(data.error) } else {
          setAnalysis(data)
          analysisData = data
        }
      } else {
        setError('Failed to fetch market data. Please try again.')
      }

      if (newsRes.status === 'fulfilled' && newsRes.value.ok) {
        const data = await newsRes.value.json() as { articles: NewsArticle[] }
        setNews(data.articles)

        // Auto-fetch AI signal for Pro users
        if (isPro && analysisData) {
          fetchAiSignal(selectedPair, analysisData, data.articles)
        }
      }
    } catch {
      setError('Network error. Check your connection and try again.')
    } finally {
      setLoading(false)
      setNewsLoading(false)
    }
  }, [isPro])

  const fetchAiSignal = async (
    currentPair: string,
    analysisData: ForexAnalysis,
    newsArticles: NewsArticle[]
  ) => {
    if (!isPro) return
    setAiLoading(true)
    try {
      const res = await fetch('/api/ai-signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pair: currentPair,
          price: analysisData.currentPrice,
          indicators: analysisData.indicators,
          techSignal: analysisData.signal,
          newsHeadlines: newsArticles.slice(0, 5).map(a => a.title),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setAiSignal(data)
      }
    } catch {
      // AI signal is optional, fail silently
    } finally {
      setAiLoading(false)
    }
  }

  // Auto-refresh for Pro users
  useEffect(() => {
    if (!isPro) return

    const startAutoRefresh = () => {
      setCountdown(300)

      countdownRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) return 300
          return prev - 1
        })
      }, 1000)

      autoRefreshRef.current = setInterval(() => {
        if (pair) analyze(pair)
        setCountdown(300)
      }, 300000)
    }

    startAutoRefresh()

    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [isPro, pair, analyze])

  const displayPairs = availablePairs.slice(0, isPro ? POPULAR_PAIRS.length : 5)

  return (
    <main className="max-w-7xl mx-auto px-4 py-6">
      {/* Search Section */}
      <div className="mb-8">
        <div className="text-center mb-6">
          <h2 className="text-white text-2xl font-bold mb-1">Forex Market Analysis</h2>
          <p className="text-gray-400 text-sm">
            {isPro
              ? 'Pro: All pairs, AI signals, 5-min auto-refresh'
              : 'Free: 5 pairs, technical signals — upgrade for AI & more'}
          </p>
          {isPro && (
            <p className="text-gray-500 text-xs mt-1">
              Auto-refresh in <span className="text-blue-400 font-mono">{Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}</span>
            </p>
          )}
        </div>
        <div className="flex justify-center">
          <PairSearch value={pair} onChange={analyze} loading={loading} />
        </div>

        {/* Quick pair buttons */}
        <div className="flex flex-wrap justify-center gap-2 mt-4">
          {displayPairs.map(p => (
            <button
              key={p}
              onClick={() => analyze(p)}
              className={`px-3 py-1 rounded-full text-xs font-mono transition-colors border ${
                pair === p
                  ? 'bg-blue-600/30 border-blue-500 text-blue-300'
                  : 'bg-surface-muted border-surface-border text-gray-400 hover:text-white hover:border-gray-500'
              }`}
            >
              {p}
            </button>
          ))}
          {!isPro && (
            <a
              href="/pricing"
              className="px-3 py-1 rounded-full text-xs font-mono border border-purple-500/50 text-purple-400 hover:bg-purple-600/20 transition-colors"
            >
              + 10 more pairs (Pro)
            </a>
          )}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && !analysis && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className={`card p-6 ${i === 1 ? 'lg:col-span-3' : i === 4 ? 'lg:col-span-3' : ''}`}>
              <div className="animate-pulse space-y-3">
                <div className="h-4 bg-surface-muted rounded w-1/4" />
                <div className="h-24 bg-surface-muted rounded" />
                <div className="h-4 bg-surface-muted rounded w-3/4" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Main dashboard */}
      {analysis && !loading && (
        <div className="space-y-6 animate-fade-in">
          {/* Top: Market Overview (full width) */}
          <MarketOverview data={analysis} />

          {/* Middle: Chart + Signal */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2">
              <PriceChart data={analysis.ohlcv} signal={analysis.signal} pair={analysis.pair} />
            </div>
            <div>
              <SignalCard signal={analysis.signal} pair={analysis.pair} currentPrice={analysis.currentPrice} />
            </div>
          </div>

          {/* AI Signal Card (Pro only) */}
          {isPro && (
            <div className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-purple-600/30 flex items-center justify-center">
                    <svg className="w-3 h-3 text-purple-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z" />
                    </svg>
                  </div>
                  <h3 className="text-white font-semibold">Claude AI Signal</h3>
                  <span className="px-1.5 py-0.5 rounded text-xs bg-purple-600/20 text-purple-400 border border-purple-500/30">PRO</span>
                </div>
                {aiLoading && (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <div className="w-3 h-3 rounded-full border border-purple-500 border-t-transparent animate-spin" />
                    Analyzing with AI...
                  </div>
                )}
              </div>
              {aiSignal ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-4">
                    <span className={`px-3 py-1 rounded-full text-sm font-bold border ${
                      aiSignal.signal === 'BUY'
                        ? 'bg-buy/20 text-buy border-buy/40'
                        : aiSignal.signal === 'SELL'
                        ? 'bg-sell/20 text-sell border-sell/40'
                        : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40'
                    }`}>
                      AI: {aiSignal.signal}
                    </span>
                    <span className="text-gray-400 text-sm">{aiSignal.confidence}% confidence</span>
                  </div>
                  <p className="text-gray-300 text-sm leading-relaxed">{aiSignal.analysis}</p>
                  {aiSignal.keyFactors && aiSignal.keyFactors.length > 0 && (
                    <div>
                      <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Key Factors</p>
                      <ul className="space-y-1">
                        {aiSignal.keyFactors.map((factor, i) => (
                          <li key={i} className="text-gray-400 text-sm flex items-start gap-2">
                            <span className="text-purple-400 mt-0.5">•</span>
                            {factor}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : !aiLoading ? (
                <p className="text-gray-500 text-sm">Run an analysis to get AI-powered insights.</p>
              ) : null}
            </div>
          )}

          {/* Upgrade nudge for free users */}
          {!isPro && (
            <div className="card p-6 border-purple-500/30 bg-purple-600/5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-white font-semibold mb-1">Unlock Pro Features</h3>
                  <p className="text-gray-400 text-sm">Get AI signals from Claude, access all 15 pairs, and 5-minute auto-refresh.</p>
                </div>
                <a
                  href="/pricing"
                  className="shrink-0 ml-4 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold transition-colors"
                >
                  Upgrade $15/mo
                </a>
              </div>
            </div>
          )}

          {/* Bottom: Indicators + News */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <IndicatorGrid scores={analysis.signal.scores} />
            <NewsSection articles={news} loading={newsLoading} />
          </div>

          {/* Disclaimer */}
          <div className="p-4 bg-yellow-500/5 border border-yellow-500/20 rounded-xl">
            <p className="text-xs text-yellow-600/80 text-center">{DISCLAIMER}</p>
          </div>
        </div>
      )}

      {/* Welcome state */}
      {!analysis && !loading && !error && (
        <div className="text-center py-20">
          <div className="w-20 h-20 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto mb-6">
            <svg className="w-10 h-10 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Ready to Analyze</h2>
          <p className="text-gray-400 text-sm mb-8 max-w-md mx-auto">
            Select a currency pair above to get real-time technical analysis and trading signals.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 max-w-2xl mx-auto">
            {displayPairs.slice(0, 10).map(p => (
              <button
                key={p}
                onClick={() => analyze(p)}
                className="p-3 card hover:border-blue-500/50 hover:bg-blue-600/10 transition-all text-sm font-mono text-gray-300 hover:text-white"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </main>
  )
}

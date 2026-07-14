'use client'
import { useState, useCallback } from 'react'
import Link from 'next/link'
import type { AIInsight, ForexAnalysis, NewsArticle } from '@/lib/types'
import { POPULAR_PAIRS } from '@/lib/types'
import PairSearch from '@/components/PairSearch'
import SignalCard from '@/components/SignalCard'
import AIInsightCard from '@/components/AIInsightCard'
import IndicatorGrid from '@/components/IndicatorGrid'
import PriceChart from '@/components/PriceChart'
import NewsSection from '@/components/NewsSection'
import MarketOverview from '@/components/MarketOverview'

const DISCLAIMER = 'This tool is for educational purposes only. Trading forex involves significant risk. Never trade with money you cannot afford to lose.'

export default function TradingApp() {
  const [pair, setPair] = useState('EUR/USD')
  const [loading, setLoading] = useState(false)
  const [newsLoading, setNewsLoading] = useState(false)
  const [analysis, setAnalysis] = useState<ForexAnalysis | null>(null)
  const [news, setNews] = useState<NewsArticle[]>([])
  const [aiInsight, setAiInsight] = useState<AIInsight | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const analyze = useCallback(async (selectedPair: string) => {
    setLoading(true)
    setNewsLoading(true)
    setAiLoading(true)
    setError(null)
    setAiInsight(null)
    setPair(selectedPair)

    try {
      const [forexRes, newsRes] = await Promise.allSettled([
        fetch(`/api/forex?pair=${encodeURIComponent(selectedPair)}`),
        fetch(`/api/news?pair=${encodeURIComponent(selectedPair)}`),
      ])

      let forexData: ForexAnalysis | null = null
      let newsArticles: NewsArticle[] = []

      if (forexRes.status === 'fulfilled' && forexRes.value.ok) {
        const data = await forexRes.value.json() as ForexAnalysis
        if (data.error) { setError(data.error) } else { forexData = data; setAnalysis(data) }
      } else {
        setError('Failed to fetch market data. Please try again.')
      }

      if (newsRes.status === 'fulfilled' && newsRes.value.ok) {
        const data = await newsRes.value.json() as { articles: NewsArticle[] }
        newsArticles = data.articles
        setNews(data.articles)
      }
      setNewsLoading(false)

      // Run the AI model once we have the technical analysis to reason over.
      if (forexData) {
        try {
          const aiRes = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pair: forexData.pair,
              currentPrice: forexData.currentPrice,
              priceChangePct24h: forexData.priceChangePct24h,
              indicators: forexData.indicators,
              signal: forexData.signal,
              news: newsArticles,
            }),
          })
          if (aiRes.ok) {
            const insight = await aiRes.json() as AIInsight
            if (!('error' in insight)) setAiInsight(insight)
          }
        } catch {
          // AI is a non-blocking enhancement — ignore failures.
        }
      }
    } catch (e) {
      setError('Network error. Check your connection and try again.')
    } finally {
      setLoading(false)
      setNewsLoading(false)
      setAiLoading(false)
    }
  }, [])

  return (
    <div className="min-h-screen bg-surface-DEFAULT">
      {/* Header */}
      <header className="border-b border-surface-border bg-surface-card/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-sm font-bold">FX</div>
            <div>
              <h1 className="text-white font-bold text-base leading-none">FX Signal Pro</h1>
              <p className="text-gray-400 text-xs">Currency Trading Analysis</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/screenshot"
              className="text-xs font-semibold text-blue-300 bg-blue-600/20 border border-blue-500/40 px-3 py-1.5 rounded-full hover:bg-blue-600/30 transition-colors"
            >
              📸 Screenshot Analyzer
            </Link>
            <div className="hidden sm:flex items-center gap-2 text-xs text-gray-500">
              <span className="w-2 h-2 rounded-full bg-buy animate-pulse-slow" />
              <span>Live Data</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Screenshot analyzer banner */}
        <Link
          href="/screenshot"
          className="block mb-6 card p-4 hover:border-blue-500/50 hover:bg-blue-600/5 transition-all"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-xl">📸</div>
              <div>
                <p className="text-white font-semibold text-sm">New: AI Screenshot Analysis</p>
                <p className="text-gray-400 text-xs">Paste a Plus500 / MT4 / TradingView screenshot and get Buy/Sell with entry, TP and SL</p>
              </div>
            </div>
            <span className="text-blue-400 text-sm shrink-0">Try it →</span>
          </div>
        </Link>

        {/* Search Section */}
        <div className="mb-8">
          <div className="text-center mb-6">
            <h2 className="text-white text-2xl font-bold mb-1">Forex Market Analysis</h2>
            <p className="text-gray-400 text-sm">Enter a currency pair to get real-time signals, take profit and stop loss levels</p>
          </div>
          <div className="flex justify-center">
            <PairSearch value={pair} onChange={analyze} loading={loading} />
          </div>

          {/* Quick pair buttons */}
          <div className="flex flex-wrap justify-center gap-2 mt-4">
            {POPULAR_PAIRS.slice(0, 8).map(p => (
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

            {/* AI analyst verdict (full width) */}
            <AIInsightCard insight={aiInsight} loading={aiLoading} />

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
              Select a currency pair above or click any of the quick-select buttons to get started with real-time technical analysis and trading signals.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3 max-w-2xl mx-auto">
              {POPULAR_PAIRS.slice(0, 10).map(p => (
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
    </div>
  )
}

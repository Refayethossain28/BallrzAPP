'use client'
import type { NewsArticle } from '@/lib/types'

interface Props {
  articles: NewsArticle[]
  loading: boolean
}

function SentimentBadge({ sentiment }: { sentiment: NewsArticle['sentiment'] }) {
  if (sentiment === 'positive') return <span className="badge-buy">Bullish</span>
  if (sentiment === 'negative') return <span className="badge-sell">Bearish</span>
  return <span className="badge-neutral">Neutral</span>
}

function timeAgo(isoDate: string): string {
  const diff = (Date.now() - new Date(isoDate).getTime()) / 1000
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export default function NewsSection({ articles, loading }: Props) {
  const bullish = articles.filter(a => a.sentiment === 'positive').length
  const bearish = articles.filter(a => a.sentiment === 'negative').length
  const overallSentiment = bullish > bearish ? 'positive' : bearish > bullish ? 'negative' : 'neutral'
  const sentimentLabel = overallSentiment === 'positive' ? 'Bullish' : overallSentiment === 'negative' ? 'Bearish' : 'Neutral'
  const sentimentColor = overallSentiment === 'positive' ? 'text-buy' : overallSentiment === 'negative' ? 'text-sell' : 'text-yellow-400'

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-white font-semibold text-lg">Market News & Sentiment</h2>
        {!loading && articles.length > 0 && (
          <div className="text-right">
            <p className="text-xs text-gray-400">Overall Sentiment</p>
            <p className={`text-sm font-semibold ${sentimentColor}`}>{sentimentLabel}</p>
          </div>
        )}
      </div>

      {/* Sentiment bar */}
      {!loading && articles.length > 0 && (
        <div className="mb-5">
          <div className="flex justify-between text-xs text-gray-400 mb-1">
            <span>Bearish ({bearish})</span>
            <span>Bullish ({bullish})</span>
          </div>
          <div className="h-1.5 bg-surface-muted rounded-full overflow-hidden flex">
            <div className="bg-sell h-full transition-all" style={{ width: `${(bearish / articles.length) * 100}%` }} />
            <div className="bg-yellow-400 h-full transition-all" style={{ width: `${((articles.length - bullish - bearish) / articles.length) * 100}%` }} />
            <div className="bg-buy h-full transition-all" style={{ width: `${(bullish / articles.length) * 100}%` }} />
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="animate-pulse">
              <div className="h-4 bg-surface-muted rounded w-3/4 mb-2" />
              <div className="h-3 bg-surface-muted rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : articles.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-4">No news available. Add a NewsAPI key for live articles.</p>
      ) : (
        <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
          {articles.map((article, idx) => (
            <div key={idx} className="border-b border-surface-border pb-4 last:border-0 last:pb-0">
              <div className="flex items-start justify-between gap-2 mb-1">
                <a
                  href={article.url !== '#' ? article.url : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-white hover:text-blue-400 transition-colors leading-snug flex-1"
                >
                  {article.title}
                </a>
                <SentimentBadge sentiment={article.sentiment} />
              </div>
              {article.description && (
                <p className="text-xs text-gray-400 line-clamp-2 mb-2">{article.description}</p>
              )}
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span>{article.source}</span>
                <span>•</span>
                <span>{timeAgo(article.publishedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

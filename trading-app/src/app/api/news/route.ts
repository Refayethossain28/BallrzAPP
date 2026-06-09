import { NextRequest, NextResponse } from 'next/server'
import type { NewsArticle } from '@/lib/types'

const NEWS_KEY = process.env.NEWS_API_KEY || ''
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || ''

const POSITIVE_WORDS = ['rise', 'gain', 'rally', 'surge', 'bullish', 'high', 'growth', 'strong', 'positive', 'increase', 'soar', 'jump', 'boost', 'optimism', 'upside']
const NEGATIVE_WORDS = ['fall', 'drop', 'decline', 'bearish', 'low', 'weak', 'negative', 'decrease', 'plunge', 'tumble', 'risk', 'concern', 'recession', 'inflation', 'crisis']

function analyzeSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.toLowerCase()
  const pos = POSITIVE_WORDS.filter(w => lower.includes(w)).length
  const neg = NEGATIVE_WORDS.filter(w => lower.includes(w)).length
  if (pos > neg) return 'positive'
  if (neg > pos) return 'negative'
  return 'neutral'
}

async function fetchNewsAPI(from: string, to: string): Promise<NewsArticle[]> {
  if (!NEWS_KEY) return []
  const query = encodeURIComponent(`${from} ${to} forex currency exchange`)
  const url = `https://newsapi.org/v2/everything?q=${query}&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_KEY}`
  const res = await fetch(url, { next: { revalidate: 600 } })
  const json = await res.json()
  if (!json.articles) return []
  return json.articles.map((a: { title: string; description: string; url: string; source: { name: string }; publishedAt: string }) => ({
    title: a.title,
    description: a.description || '',
    url: a.url,
    source: a.source.name,
    publishedAt: a.publishedAt,
    sentiment: analyzeSentiment(`${a.title} ${a.description || ''}`),
  }))
}

async function fetchFinnhubNews(from: string, to: string): Promise<NewsArticle[]> {
  if (!FINNHUB_KEY) return []
  try {
    const url = `https://finnhub.io/api/v1/news?category=forex&token=${FINNHUB_KEY}`
    const res = await fetch(url, { next: { revalidate: 600 } })
    const json = await res.json()
    if (!Array.isArray(json)) return []
    const keywords = [from.toLowerCase(), to.toLowerCase(), 'forex', 'currency']
    return json
      .filter((a: { headline: string; summary: string }) => keywords.some(k => (a.headline + a.summary).toLowerCase().includes(k)))
      .slice(0, 8)
      .map((a: { headline: string; summary: string; url: string; source: string; datetime: number }) => ({
        title: a.headline,
        description: a.summary,
        url: a.url,
        source: a.source,
        publishedAt: new Date(a.datetime * 1000).toISOString(),
        sentiment: analyzeSentiment(`${a.headline} ${a.summary}`),
      }))
  } catch { return [] }
}

function getMockNews(from: string, to: string): NewsArticle[] {
  const now = new Date()
  const pairs = [`${from}/${to}`, from, to]
  return [
    {
      title: `${from}/${to} Technical Analysis: Key Support Levels Hold`,
      description: `The ${from}/${to} pair continues to consolidate near key technical levels as traders watch central bank commentary.`,
      url: '#',
      source: 'Market Watch',
      publishedAt: now.toISOString(),
      sentiment: 'neutral',
    },
    {
      title: `${from} Shows Resilience Amid Global Uncertainty`,
      description: `The ${from} currency maintains strength following recent economic data releases, with markets pricing in future rate decisions.`,
      url: '#',
      source: 'FX Street',
      publishedAt: new Date(now.getTime() - 3600000).toISOString(),
      sentiment: 'positive',
    },
    {
      title: `Central Bank Watch: ${to} Policy Outlook`,
      description: `Analysts weigh in on the upcoming policy meeting that could significantly impact ${pairs[0]} direction in the near term.`,
      url: '#',
      source: 'Bloomberg FX',
      publishedAt: new Date(now.getTime() - 7200000).toISOString(),
      sentiment: 'neutral',
    },
    {
      title: `Risk Sentiment Drives ${from}/${to} Volatility`,
      description: `Global risk appetite shifts have created notable volatility in major currency pairs including ${from}/${to}.`,
      url: '#',
      source: 'Reuters',
      publishedAt: new Date(now.getTime() - 10800000).toISOString(),
      sentiment: 'negative',
    },
    {
      title: `Economic Calendar: Key Events for ${from} and ${to} This Week`,
      description: `Several high-impact economic releases this week could drive significant moves in ${from}/${to}.`,
      url: '#',
      source: 'Investing.com',
      publishedAt: new Date(now.getTime() - 14400000).toISOString(),
      sentiment: 'neutral',
    },
  ]
}

export async function GET(request: NextRequest) {
  const pair = request.nextUrl.searchParams.get('pair') || 'EUR/USD'
  const fromCur = pair.includes('/') ? pair.split('/')[0] : pair.slice(0, 3)
  const toCur = pair.includes('/') ? pair.split('/')[1] : pair.slice(3)

  try {
    let articles: NewsArticle[] = []

    const [newsAPIResult, finnhubResult] = await Promise.allSettled([
      fetchNewsAPI(fromCur, toCur),
      fetchFinnhubNews(fromCur, toCur),
    ])

    if (newsAPIResult.status === 'fulfilled') articles = [...articles, ...newsAPIResult.value]
    if (finnhubResult.status === 'fulfilled') articles = [...articles, ...finnhubResult.value]

    // Deduplicate by title
    const seen = new Set<string>()
    articles = articles.filter(a => {
      const key = a.title.slice(0, 50)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    if (articles.length === 0) {
      articles = getMockNews(fromCur, toCur)
    }

    return NextResponse.json({ articles: articles.slice(0, 10) })
  } catch (err) {
    console.error('News API error:', err)
    return NextResponse.json({ articles: getMockNews(fromCur, toCur) })
  }
}

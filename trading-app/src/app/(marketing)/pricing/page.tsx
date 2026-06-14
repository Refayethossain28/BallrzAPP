'use client'
import { useState } from 'react'

export default function PricingPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleStartPro = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/stripe/checkout', { method: 'POST' })
      if (res.status === 401) {
        window.location.href = '/auth/signup'
        return
      }
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        setError('Failed to start checkout. Please try again.')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="py-20 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-16">
          <h1 className="text-4xl font-bold text-white mb-4">Choose your plan</h1>
          <p className="text-gray-400 text-lg">Start free. Upgrade to Pro for AI-powered insights.</p>
        </div>

        {error && (
          <div className="mb-8 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm text-center">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Free */}
          <div className="card p-8">
            <div className="mb-6">
              <h2 className="text-white font-bold text-2xl mb-2">Free</h2>
              <div className="flex items-baseline gap-1 mb-3">
                <span className="text-5xl font-bold text-white">$0</span>
                <span className="text-gray-400">/month</span>
              </div>
              <p className="text-gray-400 text-sm">Perfect for getting started with forex analysis.</p>
            </div>
            <ul className="space-y-4 mb-10">
              {[
                { text: '5 major currency pairs', included: true },
                { text: 'Technical signals (RSI, MACD, etc.)', included: true },
                { text: '6 technical indicators', included: true },
                { text: 'Manual data refresh', included: true },
                { text: 'News feed', included: true },
                { text: 'Claude AI signals', included: false },
                { text: 'All 15 pairs', included: false },
                { text: '5-min auto-refresh', included: false },
              ].map(item => (
                <li key={item.text} className="flex items-center gap-3 text-sm">
                  {item.included ? (
                    <svg className="w-4 h-4 text-buy shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-gray-600 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  )}
                  <span className={item.included ? 'text-gray-300' : 'text-gray-600'}>{item.text}</span>
                </li>
              ))}
            </ul>
            <a
              href="/auth/signup"
              className="block w-full text-center px-4 py-3 rounded-lg border border-surface-border hover:border-gray-500 text-gray-300 hover:text-white font-semibold transition-colors"
            >
              Get Started Free
            </a>
          </div>

          {/* Pro */}
          <div className="card p-8 border-purple-500/50 bg-purple-600/5 relative">
            <div className="absolute top-4 right-4">
              <span className="px-2 py-1 rounded-full text-xs font-bold bg-purple-600 text-white">MOST POPULAR</span>
            </div>
            <div className="mb-6">
              <h2 className="text-white font-bold text-2xl mb-2">Pro</h2>
              <div className="flex items-baseline gap-1 mb-3">
                <span className="text-5xl font-bold text-white">$15</span>
                <span className="text-gray-400">/month</span>
              </div>
              <p className="text-gray-400 text-sm">For serious traders who want every edge.</p>
            </div>
            <ul className="space-y-4 mb-10">
              {[
                { text: 'All 15 currency pairs', included: true },
                { text: 'Claude AI signals & plain-English analysis', included: true },
                { text: 'All 6 technical indicators', included: true },
                { text: '5-minute auto-refresh', included: true },
                { text: 'Server-side API keys (no setup needed)', included: true },
                { text: 'News sentiment analysis', included: true },
                { text: 'Priority support', included: true },
                { text: 'Cancel anytime', included: true },
              ].map(item => (
                <li key={item.text} className="flex items-center gap-3 text-sm">
                  <svg className="w-4 h-4 text-purple-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  <span className="text-gray-300">{item.text}</span>
                </li>
              ))}
            </ul>
            <button
              onClick={handleStartPro}
              disabled={loading}
              className="block w-full text-center px-4 py-3 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold transition-colors"
            >
              {loading ? 'Redirecting to checkout...' : 'Start Pro — $15/month'}
            </button>
            <p className="text-center text-gray-500 text-xs mt-3">Secure payment via Stripe. Cancel anytime.</p>
          </div>
        </div>

        {/* FAQ */}
        <div className="mt-20">
          <h2 className="text-2xl font-bold text-white mb-8 text-center">Frequently Asked Questions</h2>
          <div className="space-y-6 max-w-2xl mx-auto">
            {[
              {
                q: 'What is FX Signal Pro?',
                a: 'FX Signal Pro is a real-time forex analysis tool that combines technical indicators with Claude AI to generate trading signals, take profit, and stop loss levels.',
              },
              {
                q: 'How does the AI signal work?',
                a: 'Pro subscribers get Claude AI analysis that reads technical indicator values and recent news headlines to provide a plain-English trade rationale with confidence level.',
              },
              {
                q: 'Can I cancel anytime?',
                a: 'Yes. You can cancel your Pro subscription at any time from your Stripe billing portal. Your access continues until the end of the billing period.',
              },
              {
                q: 'Is this financial advice?',
                a: 'No. FX Signal Pro is for educational and informational purposes only. Always do your own research and never trade with money you cannot afford to lose.',
              },
            ].map(faq => (
              <div key={faq.q} className="card p-6">
                <h3 className="text-white font-semibold mb-2">{faq.q}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}

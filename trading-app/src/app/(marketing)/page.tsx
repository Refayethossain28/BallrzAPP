export default function LandingPage() {
  return (
    <main>
      {/* Hero */}
      <section className="relative overflow-hidden py-24 px-4">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-600/10 via-surface-DEFAULT to-purple-600/10 pointer-events-none" />
        <div className="relative max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-400 text-sm mb-6">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            Live Forex Signals
          </div>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white mb-6 leading-tight">
            AI-Powered{' '}
            <span className="bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
              Forex Signals
            </span>
          </h1>
          <p className="text-gray-400 text-lg sm:text-xl mb-10 max-w-2xl mx-auto leading-relaxed">
            Real-time currency analysis with 6 technical indicators, Claude AI insights, and automatic take profit &amp; stop loss levels — all in one dashboard.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <a
              href="/auth/signup"
              className="px-8 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-lg transition-colors"
            >
              Get Started Free
            </a>
            <a
              href="/pricing"
              className="px-8 py-3 rounded-xl border border-surface-border hover:border-gray-500 text-gray-300 hover:text-white font-semibold text-lg transition-colors"
            >
              View Pricing
            </a>
          </div>
        </div>
      </section>

      {/* Features Grid */}
      <section className="py-20 px-4 border-t border-surface-border">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-white mb-4">Everything you need to trade smarter</h2>
            <p className="text-gray-400 max-w-xl mx-auto">Professional-grade tools that were previously only available to institutional traders.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              {
                icon: (
                  <svg className="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                  </svg>
                ),
                title: 'Real-time Rates',
                description: 'Live bid/ask prices from Alpha Vantage for all major, minor, and exotic currency pairs.',
                color: 'blue',
              },
              {
                icon: (
                  <svg className="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.698-1.2 2.698h-2.4" />
                  </svg>
                ),
                title: 'AI Analysis',
                description: 'Claude AI reads the technicals and news to generate a plain-English trade rationale and signal.',
                color: 'purple',
              },
              {
                icon: (
                  <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                  </svg>
                ),
                title: '6 Technical Indicators',
                description: 'RSI, MACD, Bollinger Bands, Stochastic, ADX, and moving averages all computed server-side.',
                color: 'green',
              },
              {
                icon: (
                  <svg className="w-6 h-6 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                ),
                title: 'Auto-Refresh',
                description: 'Pro users get automatic 5-minute data refresh so you never miss a market movement.',
                color: 'orange',
              },
            ].map((feature) => (
              <div key={feature.title} className="card p-6">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-4 ${
                  feature.color === 'blue' ? 'bg-blue-600/20' :
                  feature.color === 'purple' ? 'bg-purple-600/20' :
                  feature.color === 'green' ? 'bg-green-600/20' :
                  'bg-orange-600/20'
                }`}>
                  {feature.icon}
                </div>
                <h3 className="text-white font-semibold mb-2">{feature.title}</h3>
                <p className="text-gray-400 text-sm leading-relaxed">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section className="py-20 px-4 border-t border-surface-border">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold text-white mb-4">Simple, transparent pricing</h2>
            <p className="text-gray-400">Start free. Upgrade when you need more.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Free */}
            <div className="card p-8">
              <div className="mb-6">
                <h3 className="text-white font-bold text-xl mb-2">Free</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-bold text-white">$0</span>
                  <span className="text-gray-400">/month</span>
                </div>
              </div>
              <ul className="space-y-3 mb-8">
                {[
                  '5 currency pairs (majors)',
                  'Technical signals',
                  '6 indicators',
                  'Manual refresh',
                  'News feed',
                ].map(item => (
                  <li key={item} className="flex items-center gap-3 text-gray-300 text-sm">
                    <svg className="w-4 h-4 text-buy shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    {item}
                  </li>
                ))}
              </ul>
              <a
                href="/auth/signup"
                className="block w-full text-center px-4 py-3 rounded-lg border border-surface-border hover:border-gray-500 text-gray-300 hover:text-white font-semibold transition-colors"
              >
                Get Started
              </a>
            </div>

            {/* Pro */}
            <div className="card p-8 border-purple-500/50 bg-purple-600/5 relative">
              <div className="absolute top-4 right-4">
                <span className="px-2 py-1 rounded-full text-xs font-bold bg-purple-600 text-white">POPULAR</span>
              </div>
              <div className="mb-6">
                <h3 className="text-white font-bold text-xl mb-2">Pro</h3>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-bold text-white">$15</span>
                  <span className="text-gray-400">/month</span>
                </div>
              </div>
              <ul className="space-y-3 mb-8">
                {[
                  'All 15 currency pairs',
                  'Claude AI signals & analysis',
                  '5-minute auto-refresh',
                  'Server-side API keys (no setup)',
                  'Priority support',
                ].map(item => (
                  <li key={item} className="flex items-center gap-3 text-gray-300 text-sm">
                    <svg className="w-4 h-4 text-purple-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    {item}
                  </li>
                ))}
              </ul>
              <a
                href="/pricing"
                className="block w-full text-center px-4 py-3 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-semibold transition-colors"
              >
                Start Pro
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-surface-border py-10 px-4">
        <div className="max-w-6xl mx-auto text-center">
          <p className="text-gray-500 text-xs mb-3 max-w-2xl mx-auto">
            DISCLAIMER: FX Signal Pro is for educational and informational purposes only. Nothing on this platform constitutes financial advice. Forex trading involves substantial risk of loss. Never invest money you cannot afford to lose.
          </p>
          <p className="text-gray-600 text-xs">
            &copy; {new Date().getFullYear()} FX Signal Pro. All rights reserved.
          </p>
        </div>
      </footer>
    </main>
  )
}

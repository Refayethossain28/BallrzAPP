export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-DEFAULT">
      {/* Marketing Nav */}
      <header className="border-b border-surface-border bg-surface-card/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <a href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-sm font-bold">FX</div>
            <span className="text-white font-bold text-base">FX Signal Pro</span>
          </a>
          <nav className="flex items-center gap-3">
            <a href="/pricing" className="text-gray-400 hover:text-white text-sm transition-colors hidden sm:block">
              Pricing
            </a>
            <a
              href="/auth/login"
              className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white border border-surface-border hover:border-gray-500 transition-colors"
            >
              Login
            </a>
            <a
              href="/auth/signup"
              className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors"
            >
              Get Started
            </a>
          </nav>
        </div>
      </header>
      {children}
    </div>
  )
}

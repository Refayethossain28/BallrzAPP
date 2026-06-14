export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-DEFAULT">
      {/* Marketing Nav */}
      <header className="border-b border-surface-border bg-surface-card/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <a href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{background:'linear-gradient(135deg,#1d4ed8,#7c3aed)'}}>
              <svg width="18" height="18" viewBox="0 0 44 44" fill="none"><path d="M8 32 L18 16 L26 24 L34 10" stroke="white" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="34" cy="10" r="4" fill="#00c853"/></svg>
            </div>
            <span className="text-white font-bold text-base">ApexTrade</span>
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

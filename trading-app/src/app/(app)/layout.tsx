import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getUserTier, type Tier } from '@/lib/tier'

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth/login')
  }

  const tier = await getUserTier(user.id)

  return (
    <div className="min-h-screen bg-surface-DEFAULT">
      {/* Top Nav */}
      <header className="border-b border-surface-border bg-surface-card/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-sm font-bold">FX</div>
            <div>
              <h1 className="text-white font-bold text-base leading-none">FX Signal Pro</h1>
              <p className="text-gray-400 text-xs">Currency Trading Analysis</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 text-xs text-gray-500">
              <span className="w-2 h-2 rounded-full bg-buy animate-pulse-slow" />
              <span>Live Data</span>
            </div>
            {tier === 'pro' ? (
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-600/20 text-purple-400 border border-purple-500/30">
                PRO
              </span>
            ) : (
              <a
                href="/pricing"
                className="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-600/20 text-blue-400 border border-blue-500/30 hover:bg-blue-600/30 transition-colors"
              >
                FREE — Upgrade
              </a>
            )}
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="text-xs text-gray-400 hover:text-white transition-colors"
              >
                Logout
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* Pass tier via data attribute; children read from props */}
      <div data-tier={tier}>
        {/* Children rendered with tier injected via cloneElement in page */}
        {children}
      </div>
    </div>
  )
}

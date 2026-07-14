'use client'
import { useEffect, useState } from 'react'

// Executive intro splash: shown once per browser session, tap to skip.
// Server-renders visible so it covers the page from the first paint; repeat
// visitors get dismissed on hydration. Honors prefers-reduced-motion.
export default function SplashScreen() {
  const [phase, setPhase] = useState<'showing' | 'leaving' | 'gone'>('showing')

  useEffect(() => {
    if (sessionStorage.getItem('apexfx-splash-seen')) {
      setPhase('gone')
      return
    }
    sessionStorage.setItem('apexfx-splash-seen', '1')
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const hold = reduceMotion ? 900 : 3000
    const t1 = setTimeout(() => setPhase('leaving'), hold)
    const t2 = setTimeout(() => setPhase('gone'), hold + 800)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  if (phase === 'gone') return null

  const dismiss = () => {
    setPhase('leaving')
    setTimeout(() => setPhase('gone'), 800)
  }

  return (
    <div
      onClick={dismiss}
      role="presentation"
      aria-hidden="true"
      className={`fixed inset-0 z-[100] flex items-center justify-center cursor-pointer select-none
        transition-opacity duration-700 ease-out ${phase === 'leaving' ? 'opacity-0' : 'opacity-100'}`}
      style={{ background: 'radial-gradient(120% 90% at 50% 30%, #10131d 0%, #07080d 55%, #030407 100%)' }}
    >
      {/* Faint chart grid + vignette */}
      <div className="absolute inset-0 splash-grid" />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(90% 70% at 50% 45%, transparent 40%, rgba(0,0,0,0.55) 100%)' }} />

      <div className="relative flex flex-col items-center px-8 text-center">
        {/* Monogram: roundel with rising candles */}
        <svg viewBox="0 0 120 120" className="w-28 h-28 mb-8" fill="none">
          <circle cx="60" cy="60" r="56" stroke="rgba(217,185,104,0.25)" strokeWidth="1" />
          <circle cx="60" cy="60" r="49" stroke="rgba(217,185,104,0.12)" strokeWidth="0.75" strokeDasharray="2 4" />
          {/* candles */}
          <g className="splash-candle" style={{ animationDelay: '0.35s' }}>
            <line x1="42" y1="82" x2="42" y2="58" stroke="#c8a355" strokeWidth="1.2" />
            <rect x="38.5" y="63" width="7" height="14" rx="1" fill="#c8a355" />
          </g>
          <g className="splash-candle" style={{ animationDelay: '0.55s' }}>
            <line x1="60" y1="72" x2="60" y2="46" stroke="#d9b968" strokeWidth="1.2" />
            <rect x="56.5" y="51" width="7" height="16" rx="1" fill="#d9b968" />
          </g>
          <g className="splash-candle" style={{ animationDelay: '0.75s' }}>
            <line x1="78" y1="62" x2="78" y2="34" stroke="#f0dfae" strokeWidth="1.2" />
            <rect x="74.5" y="39" width="7" height="17" rx="1" fill="#f0dfae" />
          </g>
          {/* ascending trace */}
          <polyline
            points="30,88 47,70 60,77 90,32"
            stroke="#f7ecc8"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="splash-trace"
          />
          <path d="M83,32 L90,32 L90,39" stroke="#f7ecc8" strokeWidth="1.6" strokeLinecap="round" className="splash-trace" style={{ animationDelay: '1.15s' }} />
        </svg>

        {/* Hairline */}
        <div className="splash-hairline mb-6" style={{ animationDelay: '0.9s' }} />

        {/* Wordmark */}
        <h1
          className="splash-rise splash-gold text-3xl sm:text-4xl font-semibold tracking-[0.32em] mb-3"
          style={{ animationDelay: '1s', fontFamily: 'Georgia, "Times New Roman", serif' }}
        >
          APEX&nbsp;FX
        </h1>

        {/* Tagline */}
        <p
          className="splash-rise text-[11px] tracking-[0.42em] text-gray-500 uppercase mb-10"
          style={{ animationDelay: '1.4s' }}
        >
          AI-Powered Market Intelligence
        </p>

        {/* Loading shimmer bar */}
        <div className="splash-rise w-40 h-px bg-white/10 overflow-hidden rounded-full" style={{ animationDelay: '1.6s' }}>
          <div className="splash-loader h-full w-1/3 rounded-full" />
        </div>

        <p className="splash-rise mt-10 text-[10px] tracking-[0.3em] text-gray-600 uppercase" style={{ animationDelay: '2s' }}>
          Powered by Claude · Tap to enter
        </p>
      </div>
    </div>
  )
}

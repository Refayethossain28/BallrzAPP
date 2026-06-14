'use client'
import { useEffect, useState } from 'react'

export default function SplashScreen() {
  const [visible, setVisible] = useState(true)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFading(true), 2200)
    const hideTimer = setTimeout(() => setVisible(false), 2800)
    return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer) }
  }, [])

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: '#0a0c14',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        transition: 'opacity 0.6s ease',
        opacity: fading ? 0 : 1,
        pointerEvents: fading ? 'none' : 'all',
      }}
    >
      {/* Logo mark */}
      <div style={{
        width: 80, height: 80, borderRadius: 22,
        background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 24,
        boxShadow: '0 0 60px rgba(124,58,237,0.4)',
      }}>
        <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
          <path d="M8 32 L18 16 L26 24 L34 10" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="34" cy="10" r="4" fill="#00c853"/>
        </svg>
      </div>

      {/* Brand name */}
      <div style={{
        fontSize: 38, fontWeight: 800, letterSpacing: '-1px',
        background: 'linear-gradient(90deg, #ffffff 0%, #a78bfa 100%)',
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        marginBottom: 8,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}>
        ApexTrade
      </div>

      {/* Tagline */}
      <div style={{ color: '#6b7280', fontSize: 13, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 48 }}>
        AI-Powered Forex Signals
      </div>

      {/* Loading bar */}
      <div style={{ width: 120, height: 3, background: '#1f2937', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: 999,
          background: 'linear-gradient(90deg, #1d4ed8, #7c3aed)',
          animation: 'apexLoad 2s ease-in-out forwards',
        }} />
      </div>

      <style>{`
        @keyframes apexLoad {
          0%   { width: 0% }
          60%  { width: 80% }
          100% { width: 100% }
        }
      `}</style>
    </div>
  )
}

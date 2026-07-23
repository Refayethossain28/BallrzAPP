'use client'
import { useEffect } from 'react'

// Registers the service worker in production builds. Disabled in dev to avoid
// the SW serving stale assets while iterating (`npm run dev`).
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return

    const register = () => {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((err) => console.error('Service worker registration failed:', err))
    }

    window.addEventListener('load', register)
    return () => window.removeEventListener('load', register)
  }, [])

  return null
}

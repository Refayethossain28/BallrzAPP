'use client'
import { useEffect, useState } from 'react'

type AIStatus = 'checking' | 'online' | 'unconfigured' | 'invalid_key' | 'error'

const STYLES: Record<AIStatus, { dot: string; text: string; label: string; pulse?: boolean }> = {
  checking: { dot: 'bg-gray-400', text: 'text-gray-400', label: 'Checking AI…', pulse: true },
  online: { dot: 'bg-buy', text: 'text-buy', label: 'AI online' },
  unconfigured: { dot: 'bg-yellow-500', text: 'text-yellow-400', label: 'AI not configured' },
  invalid_key: { dot: 'bg-sell', text: 'text-sell', label: 'AI key invalid' },
  error: { dot: 'bg-sell', text: 'text-sell', label: 'AI unreachable' },
}

// Live indicator showing whether screenshot analysis will actually work.
// Backed by /api/health, which verifies the Anthropic key with a free call.
export default function AIStatusBadge() {
  const [status, setStatus] = useState<AIStatus>('checking')
  const [message, setMessage] = useState('Verifying the AI connection…')

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/api/health')
        const data = await res.json() as { ai: AIStatus; message: string }
        if (!cancelled) {
          setStatus(data.ai)
          setMessage(data.message)
        }
      } catch {
        if (!cancelled) {
          setStatus('error')
          setMessage('Could not reach the server health check.')
        }
      }
    }
    void check()
    // Re-check periodically so a fixed key flips the badge green without a reload.
    const interval = setInterval(check, 60 * 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const s = STYLES[status]
  return (
    <span
      title={message}
      className={`inline-flex items-center gap-1.5 text-xs ${s.text} bg-surface-muted/60 border border-surface-border px-2.5 py-1 rounded-full`}
    >
      <span className={`w-2 h-2 rounded-full ${s.dot} ${s.pulse ? 'animate-pulse-slow' : ''}`} />
      {s.label}
    </span>
  )
}

'use client'
import { useState, useRef, useEffect } from 'react'
import { POPULAR_PAIRS } from '@/lib/types'

interface Props {
  value: string
  onChange: (pair: string) => void
  loading: boolean
}

export default function PairSearch({ value, onChange, loading }: Props) {
  const [input, setInput] = useState(value)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { setInput(value) }, [value])
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = POPULAR_PAIRS.filter(p =>
    p.toLowerCase().includes(input.toUpperCase().replace('/', ''))
    || p.toUpperCase().includes(input.toUpperCase())
  )

  const submit = () => {
    const normalized = input.toUpperCase().replace(/[^A-Z]/g, '')
    const pair = normalized.length === 6 ? `${normalized.slice(0, 3)}/${normalized.slice(3)}` : input.toUpperCase()
    if (pair.length >= 7) { onChange(pair); setOpen(false) }
  }

  return (
    <div ref={ref} className="relative w-full max-w-md">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            className="w-full bg-surface-muted border border-surface-border rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 font-mono text-lg uppercase tracking-widest"
            placeholder="EUR/USD"
            value={input}
            onChange={e => { setInput(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
          />
          {open && filtered.length > 0 && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-surface-card border border-surface-border rounded-lg shadow-xl z-50 overflow-hidden">
              {filtered.map(pair => (
                <button
                  key={pair}
                  className="w-full text-left px-4 py-2.5 font-mono text-sm hover:bg-surface-muted transition-colors text-gray-300 hover:text-white"
                  onClick={() => { onChange(pair); setInput(pair); setOpen(false) }}
                >
                  {pair}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={submit}
          disabled={loading}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:text-blue-700 text-white rounded-lg font-semibold transition-colors flex items-center gap-2"
        >
          {loading ? (
            <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          )}
          Analyze
        </button>
      </div>
    </div>
  )
}

'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { ScreenshotAnalysis } from '@/lib/types'
import ScreenshotVerdict from '@/components/ScreenshotVerdict'
import AIStatusBadge from '@/components/AIStatusBadge'
import { ImagePlus, ClipboardPaste, Loader2, RotateCcw } from 'lucide-react'

const DISCLAIMER = 'This tool is for educational purposes only. AI can misread charts. Trading involves significant risk. Never trade with money you cannot afford to lose.'

// Downscale large screenshots (e.g. 1290x2796 iPhone captures) client-side so
// they stay under the API's 5MB image cap and its 2576px resolution ceiling.
const MAX_EDGE = 2400

async function toAnalyzableImage(file: Blob): Promise<{ base64: string; mediaType: string; previewUrl: string }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()

  // JPEG keeps chart screenshots small; quality 0.92 preserves candle detail.
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
  return {
    base64: dataUrl.split(',')[1],
    mediaType: 'image/jpeg',
    previewUrl: dataUrl,
  }
}

export default function ScreenshotAnalyzer() {
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ScreenshotAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const analyze = useCallback(async (file: Blob) => {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const { base64, mediaType, previewUrl } = await toAnalyzableImage(file)
      setPreview(previewUrl)

      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, mediaType }),
      })
      const data = await res.json() as ScreenshotAnalysis & { error?: string }
      if (!res.ok || data.error) {
        setError(data.error ?? 'Analysis failed. Please try again.')
      } else if (!data.isChart) {
        setError(data.summary || 'This image does not look like a trading chart. Paste a screenshot of a price chart.')
      } else {
        setResult(data)
      }
    } catch {
      setError('Could not process that image. Try a PNG or JPEG screenshot.')
    } finally {
      setLoading(false)
    }
  }, [])

  const handleFiles = useCallback((files: FileList | File[] | null) => {
    const file = files?.[0]
    if (file && file.type.startsWith('image/')) void analyze(file)
  }, [analyze])

  // Global paste: Cmd/Ctrl+V anywhere on the page analyzes the clipboard image.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find(i => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) {
        e.preventDefault()
        void analyze(file)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [analyze])

  const reset = () => {
    setPreview(null)
    setResult(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="min-h-screen bg-surface-DEFAULT">
      <header className="border-b border-surface-border bg-surface-card/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-sm font-bold">FX</div>
            <div>
              <h1 className="text-white font-bold text-base leading-none">FX Signal Pro</h1>
              <p className="text-gray-400 text-xs">Screenshot Analyzer</p>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <AIStatusBadge />
            <Link href="/" className="text-xs text-gray-400 hover:text-white transition-colors">
              ← Pair Analyzer
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="text-center">
          <h2 className="text-white text-2xl font-bold mb-1">AI Chart Screenshot Analysis</h2>
          <p className="text-gray-400 text-sm">
            Paste or upload a screenshot from Plus500, MT4, TradingView or any platform — get a Buy/Sell call with entry, take profit and stop loss
          </p>
        </div>

        {/* Drop / paste zone */}
        {!preview && !loading && (
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
            onClick={() => fileInputRef.current?.click()}
            className={`card p-12 text-center cursor-pointer transition-all border-2 border-dashed ${
              dragging ? 'border-blue-500 bg-blue-600/10' : 'border-surface-border hover:border-blue-500/50 hover:bg-blue-600/5'
            }`}
          >
            <div className="w-16 h-16 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto mb-4">
              <ImagePlus className="w-8 h-8 text-blue-400" />
            </div>
            <p className="text-white font-semibold mb-1">Drop a screenshot here, or click to choose a file</p>
            <p className="text-gray-500 text-sm flex items-center justify-center gap-1.5">
              <ClipboardPaste className="w-4 h-4" /> or just press Ctrl/Cmd+V to paste from your clipboard
            </p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />

        {/* Preview + status */}
        {preview && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            <div className="card p-3 lg:col-span-1">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="Uploaded trading screenshot" className="rounded-lg w-full" />
              <button
                onClick={reset}
                className="mt-3 w-full flex items-center justify-center gap-2 text-sm text-gray-400 hover:text-white py-2 rounded-lg border border-surface-border hover:border-gray-500 transition-colors"
              >
                <RotateCcw className="w-4 h-4" /> Analyze another screenshot
              </button>
            </div>

            <div className="lg:col-span-2">
              {loading && (
                <div className="card p-10 text-center">
                  <Loader2 className="w-8 h-8 text-blue-400 animate-spin mx-auto mb-4" />
                  <p className="text-white font-semibold">Reading your chart…</p>
                  <p className="text-gray-500 text-sm mt-1">The AI is identifying the instrument, trend, and key levels</p>
                </div>
              )}
              {error && !loading && (
                <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">{error}</div>
              )}
              {result && !loading && <ScreenshotVerdict result={result} />}
            </div>
          </div>
        )}

        {loading && !preview && (
          <div className="card p-10 text-center">
            <Loader2 className="w-8 h-8 text-blue-400 animate-spin mx-auto" />
          </div>
        )}

        {error && !preview && !loading && (
          <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">{error}</div>
        )}

        <div className="p-4 bg-yellow-500/5 border border-yellow-500/20 rounded-xl">
          <p className="text-xs text-yellow-600/80 text-center">{DISCLAIMER}</p>
        </div>
      </main>
    </div>
  )
}

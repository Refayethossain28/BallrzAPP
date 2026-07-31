'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { ScreenshotAnalysis } from '@/lib/types'
import ScreenshotVerdict from '@/components/ScreenshotVerdict'
import AIStatusBadge from '@/components/AIStatusBadge'
import { makeThumb } from '@/lib/journal'
import { saveEntry } from '@/lib/journalStore'
import { ImagePlus, ClipboardPaste, Loader2, RotateCcw, Plus, Sparkles, X } from 'lucide-react'

const DISCLAIMER = 'This tool is for educational purposes only. AI can misread charts. Trading involves significant risk. Never trade with money you cannot afford to lose.'
const MAX_IMAGES = 3

// Downscale large screenshots (e.g. 1290x2796 iPhone captures) client-side so
// they stay under the API's 5MB image cap and its 2576px resolution ceiling.
const MAX_EDGE = 2400

interface PendingImage {
  base64: string
  mediaType: string
  previewUrl: string
}

async function toAnalyzableImage(file: Blob): Promise<PendingImage> {
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
  const [images, setImages] = useState<PendingImage[]>([])
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ScreenshotAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files) return
    const list = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (list.length === 0) return
    setError(null)
    setResult(null)
    try {
      const processed = await Promise.all(list.map(toAnalyzableImage))
      setImages(prev => [...prev, ...processed].slice(0, MAX_IMAGES))
    } catch {
      setError('Could not process that image. Try a PNG or JPEG screenshot.')
    }
  }, [])

  const analyze = useCallback(async (toAnalyze: PendingImage[]) => {
    if (toAnalyze.length === 0) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: toAnalyze.map(i => ({ image: i.base64, mediaType: i.mediaType })),
        }),
      })
      const data = await res.json() as ScreenshotAnalysis & { error?: string }
      if (!res.ok || data.error) {
        setError(data.error ?? 'Analysis failed. Please try again.')
      } else if (!data.isChart) {
        setError(data.summary || 'This image does not look like a trading chart. Paste a screenshot of a price chart.')
      } else {
        setResult(data)
        // Auto-save to the journal (best-effort; never blocks the verdict).
        try {
          const thumb = await makeThumb(toAnalyze[0].previewUrl)
          await saveEntry(data, thumb)
        } catch { /* ignore */ }
      }
    } catch {
      setError('Network error. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [])

  // Global paste: Cmd/Ctrl+V anywhere on the page adds the clipboard image.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter(i => i.type.startsWith('image/'))
        .map(i => i.getAsFile())
        .filter((f): f is File => f !== null)
      if (files.length > 0) {
        e.preventDefault()
        void addFiles(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  const reset = () => {
    setImages([])
    setResult(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeImage = (idx: number) => {
    setImages(prev => prev.filter((_, i) => i !== idx))
  }

  return (
    <div className="min-h-screen bg-surface-DEFAULT">
      <header className="border-b border-surface-border bg-surface-card/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-sm font-bold">FX</div>
            <div>
              <h1 className="text-white font-bold text-base leading-none">ApexFX</h1>
              <p className="text-gray-400 text-xs">Screenshot Analyzer</p>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <AIStatusBadge />
            <Link href="/journal" className="text-xs text-gray-400 hover:text-white transition-colors">
              Journal
            </Link>
            <Link href="/" className="text-xs text-gray-400 hover:text-white transition-colors hidden sm:inline">
              ← Pair Analyzer
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="text-center">
          <h2 className="text-white text-2xl font-bold mb-1">AI Chart Screenshot Analysis</h2>
          <p className="text-gray-400 text-sm">
            Paste or upload up to {MAX_IMAGES} screenshots — add a higher timeframe of the same pair for a stronger call
          </p>
        </div>

        {/* Drop / paste zone */}
        {images.length === 0 && !loading && (
          <div
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files) }}
            onClick={() => fileInputRef.current?.click()}
            className={`card p-12 text-center cursor-pointer transition-all border-2 border-dashed ${
              dragging ? 'border-blue-500 bg-blue-600/10' : 'border-surface-border hover:border-blue-500/50 hover:bg-blue-600/5'
            }`}
          >
            <div className="w-16 h-16 rounded-2xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center mx-auto mb-4">
              <ImagePlus className="w-8 h-8 text-blue-400" />
            </div>
            <p className="text-white font-semibold mb-1">Drop screenshots here, or click to choose files</p>
            <p className="text-gray-500 text-sm flex items-center justify-center gap-1.5">
              <ClipboardPaste className="w-4 h-4" /> or just press Ctrl/Cmd+V to paste from your clipboard
            </p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={e => { void addFiles(e.target.files); if (fileInputRef.current) fileInputRef.current.value = '' }}
        />

        {/* Staged images + analyze controls */}
        {images.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
            <div className="card p-3 lg:col-span-1 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {images.map((img, i) => (
                  <div key={i} className={`relative ${images.length === 1 ? 'col-span-2' : ''}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.previewUrl} alt={`Screenshot ${i + 1}`} className="rounded-lg w-full" />
                    {!loading && (
                      <button
                        onClick={() => removeImage(i)}
                        aria-label="Remove image"
                        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/70 border border-white/20 flex items-center justify-center text-gray-300 hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {!loading && !result && (
                <>
                  <button
                    onClick={() => void analyze(images)}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold transition-colors"
                  >
                    <Sparkles className="w-4 h-4" />
                    Analyze {images.length > 1 ? `${images.length} timeframes` : 'chart'}
                  </button>
                  {images.length < MAX_IMAGES && (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-surface-border text-sm text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
                    >
                      <Plus className="w-4 h-4" /> Add a higher timeframe
                    </button>
                  )}
                </>
              )}

              {(result || loading) && (
                <button
                  onClick={reset}
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-2 text-sm text-gray-400 hover:text-white py-2 rounded-lg border border-surface-border hover:border-gray-500 transition-colors disabled:opacity-50"
                >
                  <RotateCcw className="w-4 h-4" /> Analyze another
                </button>
              )}
            </div>

            <div className="lg:col-span-2">
              {loading && (
                <div className="card p-10 text-center">
                  <Loader2 className="w-8 h-8 text-blue-400 animate-spin mx-auto mb-4" />
                  <p className="text-white font-semibold">Reading your chart{images.length > 1 ? 's' : ''}…</p>
                  <p className="text-gray-500 text-sm mt-1">The AI is identifying the instrument and key levels, and checking live prices &amp; news on the web</p>
                </div>
              )}
              {error && !loading && (
                <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">{error}</div>
              )}
              {result && !loading && <ScreenshotVerdict result={result} />}
              {!result && !loading && !error && (
                <div className="card p-8 text-center text-sm text-gray-500">
                  {images.length < MAX_IMAGES
                    ? 'Tip: add a 4h or daily chart of the same pair — the AI will check the higher-timeframe trend before calling the trade.'
                    : 'Ready when you are — hit Analyze.'}
                </div>
              )}
            </div>
          </div>
        )}

        {error && images.length === 0 && !loading && (
          <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">{error}</div>
        )}

        <div className="p-4 bg-yellow-500/5 border border-yellow-500/20 rounded-xl">
          <p className="text-xs text-yellow-600/80 text-center">{DISCLAIMER}</p>
        </div>
      </main>
    </div>
  )
}

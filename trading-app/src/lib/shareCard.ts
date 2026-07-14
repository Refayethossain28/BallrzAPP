import type { ScreenshotAnalysis } from './types'

// Renders a branded 1080x1350 signal card on a canvas and shares it via the
// Web Share API (falls back to a download). Runs entirely client-side.

const W = 1080
const H = 1350
const GOLD = '#d9b968'
const GOLD_LIGHT = '#f0dfae'
const CREAM = '#f7ecc8'

const VERDICT_COLORS: Record<string, string> = {
  BUY: '#00c853',
  SELL: '#ff5252',
  NEUTRAL: '#f5b60a',
}

export async function shareResultCard(result: ScreenshotAnalysis, appUrl: string) {
  const canvas = renderCard(result, appUrl)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not render card')

  const file = new File([blob], `apexfx-${result.instrument.replace(/\W+/g, '')}.png`, { type: 'image/png' })
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'ApexFX Signal' })
      return
    } catch (err) {
      // AbortError = user closed the share sheet; anything else → download.
      if ((err as DOMException)?.name === 'AbortError') return
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function renderCard(result: ScreenshotAnalysis, appUrl: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // Backdrop: dark radial gradient + faint grid
  const bg = ctx.createRadialGradient(W / 2, H * 0.3, 0, W / 2, H * 0.3, H)
  bg.addColorStop(0, '#10131d')
  bg.addColorStop(1, '#04050a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  ctx.strokeStyle = 'rgba(255,255,255,0.03)'
  ctx.lineWidth = 1
  for (let x = 0; x <= W; x += 72) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
  for (let y = 0; y <= H; y += 72) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }

  // Monogram (ring + candles + trace), centered near the top
  drawMonogram(ctx, W / 2, 200, 1.15)

  // Wordmark
  ctx.textAlign = 'center'
  ctx.fillStyle = GOLD
  ctx.font = '600 52px Georgia, "Times New Roman", serif'
  drawSpaced(ctx, 'APEX FX', W / 2, 370, 16)

  hairline(ctx, W / 2, 402, 300)

  // Instrument + timeframe
  ctx.fillStyle = '#e2e8f0'
  ctx.font = 'bold 64px -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(result.instrument, W / 2, 500)
  ctx.fillStyle = '#7a8194'
  ctx.font = '28px -apple-system, "Segoe UI", Roboto, sans-serif'
  const tf = result.timeframe !== 'unknown' ? `${result.timeframe} chart · ` : ''
  ctx.fillText(`${tf}Price ${result.currentPrice}`, W / 2, 545)

  // Verdict
  const vColor = VERDICT_COLORS[result.verdict] ?? GOLD
  ctx.fillStyle = vColor
  ctx.font = '800 128px -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(result.verdict, W / 2, 690)
  ctx.fillStyle = '#9aa1b3'
  ctx.font = '30px -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(`${result.confidence}% confidence · R:R ${result.riskRewardRatio}`, W / 2, 745)

  // Level boxes
  const levels: Array<[string, string, string]> = [
    ['ENTRY', result.entry, '#60a5fa'],
    ['TP 1', result.takeProfit1, '#00c853'],
    ['TP 2', result.takeProfit2, '#00c853'],
    ['STOP', result.stopLoss, '#ff5252'],
  ]
  const boxW = 232, boxH = 130, gap = 20
  const startX = (W - (boxW * 4 + gap * 3)) / 2
  const boxY = 800
  for (let i = 0; i < levels.length; i++) {
    const [label, value, color] = levels[i]
    const x = startX + i * (boxW + gap)
    roundRect(ctx, x, boxY, boxW, boxH, 18)
    ctx.fillStyle = 'rgba(255,255,255,0.045)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'
    ctx.stroke()
    ctx.fillStyle = color
    ctx.font = '600 24px -apple-system, "Segoe UI", Roboto, sans-serif'
    ctx.fillText(label, x + boxW / 2, boxY + 44)
    ctx.fillStyle = '#f1f5f9'
    ctx.font = 'bold 36px ui-monospace, Menlo, monospace'
    ctx.fillText(fitText(ctx, value, boxW - 30), x + boxW / 2, boxY + 96)
  }

  // Summary, wrapped
  ctx.fillStyle = '#b9c0d0'
  ctx.font = '32px -apple-system, "Segoe UI", Roboto, sans-serif'
  wrapText(ctx, result.summary, W / 2, 1020, W - 180, 44, 3)

  hairline(ctx, W / 2, 1180, 300)

  // Footer
  ctx.fillStyle = GOLD
  ctx.font = '600 28px -apple-system, "Segoe UI", Roboto, sans-serif'
  ctx.fillText(appUrl, W / 2, 1235)
  ctx.fillStyle = '#5b6272'
  ctx.font = '24px -apple-system, "Segoe UI", Roboto, sans-serif'
  const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  ctx.fillText(`AI analysis · ${date} · Not financial advice`, W / 2, 1280)

  return canvas
}

function drawMonogram(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  const T = (v: number) => v * s
  ctx.save()
  ctx.translate(cx, cy)
  ctx.strokeStyle = 'rgba(217,185,104,0.45)'
  ctx.lineWidth = T(2)
  ctx.beginPath()
  ctx.arc(0, 0, T(100), 0, Math.PI * 2)
  ctx.stroke()

  const candle = (x: number, wickTop: number, wickBot: number, bodyTop: number, bodyBot: number, color: string) => {
    ctx.strokeStyle = color
    ctx.lineWidth = T(3)
    ctx.beginPath()
    ctx.moveTo(T(x), T(wickTop))
    ctx.lineTo(T(x), T(wickBot))
    ctx.stroke()
    ctx.fillStyle = color
    ctx.fillRect(T(x - 6.5), T(bodyTop), T(13), T(bodyBot - bodyTop))
  }
  // Coordinates scaled ~1.85x from the 120 viewBox, centered on (60,60)
  candle(-33, -4, 41, 5, 31, '#c8a355')
  candle(0, -26, 22, -17, 13, GOLD)
  candle(33, -48, 4, -39, -7, GOLD_LIGHT)

  ctx.strokeStyle = CREAM
  ctx.lineWidth = T(4.5)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(T(-55), T(52))
  ctx.lineTo(T(-24), T(18))
  ctx.lineTo(T(0), T(31))
  ctx.lineTo(T(55), T(-52))
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(T(42), T(-52))
  ctx.lineTo(T(55), T(-52))
  ctx.lineTo(T(55), T(-39))
  ctx.stroke()
  ctx.restore()
}

function drawSpaced(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, spacing: number) {
  const widths = text.split('').map(ch => ctx.measureText(ch).width)
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1)
  let x = cx - total / 2
  ctx.save()
  ctx.textAlign = 'left'
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i], x, y)
    x += widths[i] + spacing
  }
  ctx.restore()
}

function hairline(ctx: CanvasRenderingContext2D, cx: number, y: number, halfWidth: number) {
  const grad = ctx.createLinearGradient(cx - halfWidth, y, cx + halfWidth, y)
  grad.addColorStop(0, 'rgba(217,185,104,0)')
  grad.addColorStop(0.5, 'rgba(217,185,104,0.7)')
  grad.addColorStop(1, 'rgba(217,185,104,0)')
  ctx.fillStyle = grad
  ctx.fillRect(cx - halfWidth, y, halfWidth * 2, 2)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let t = text
  while (t.length > 3 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1)
  return `${t}…`
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const words = text.split(/\s+/)
  let line = ''
  let lines = 0
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      if (lines === maxLines - 1) {
        ctx.fillText(fitText(ctx, `${line}…`, maxWidth), cx, y + lines * lineHeight)
        return
      }
      ctx.fillText(line, cx, y + lines * lineHeight)
      lines++
      line = word
    } else {
      line = test
    }
  }
  if (line) ctx.fillText(line, cx, y + lines * lineHeight)
}

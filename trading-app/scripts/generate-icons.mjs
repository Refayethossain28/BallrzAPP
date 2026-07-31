// Generates the PWA icon set as PNGs with zero external dependencies.
// Draws the ApexFX monogram — gold ring, three rising candlesticks, and an
// ascending trace on a dark radial backdrop — matching the splash screen.
// Run with: node scripts/generate-icons.mjs
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '..', 'public', 'icons')

// --- minimal PNG encoder (RGBA, 8-bit) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // 10-12 default (deflate, no filter, no interlace)
  // add filter byte (0) per scanline
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// --- drawing ---
// All geometry lives in the splash monogram's 120x120 viewBox space and is
// scaled about the center; `scale` < 1 shrinks the mark (maskable safe zone).
function drawIcon(size, scale) {
  const W = size
  const H = size
  const px = Buffer.alloc(W * H * 4)

  // Dark radial backdrop: #10131d at the focus fading to near-black.
  const fx = 0.5 * W
  const fy = 0.38 * H
  const maxD = Math.hypot(0.5 * W, 0.62 * H)
  const top = [16, 19, 29]
  const bot = [4, 5, 9]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = Math.min(1, Math.hypot(x - fx, y - fy) / maxD)
      const i = (y * W + x) * 4
      px[i] = Math.round(top[0] + (bot[0] - top[0]) * t)
      px[i + 1] = Math.round(top[1] + (bot[1] - top[1]) * t)
      px[i + 2] = Math.round(top[2] + (bot[2] - top[2]) * t)
      px[i + 3] = 255
    }
  }

  const blend = (x, y, color, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return
    const na = Math.min(1, a)
    const i = (y * W + x) * 4
    px[i] = Math.round(px[i] * (1 - na) + color[0] * na)
    px[i + 1] = Math.round(px[i + 1] * (1 - na) + color[1] * na)
    px[i + 2] = Math.round(px[i + 2] * (1 - na) + color[2] * na)
  }

  // viewBox(120) -> pixel space, scaled about the icon center
  const T = (v) => (0.5 + (v / 120 - 0.5) * scale) * size
  const S = (len) => (len / 120) * scale * size
  const cov = (halfWidth, d) => Math.max(0, Math.min(1, halfWidth + 0.5 - d))

  // Thick line segment with round caps (distance-to-segment coverage).
  const seg = (x1, y1, x2, y2, w, color, alpha = 1) => {
    const ax = T(x1), ay = T(y1), bx = T(x2), by = T(y2), hw = S(w) / 2
    const minX = Math.floor(Math.min(ax, bx) - hw - 2)
    const maxX = Math.ceil(Math.max(ax, bx) + hw + 2)
    const minY = Math.floor(Math.min(ay, by) - hw - 2)
    const maxY = Math.ceil(Math.max(ay, by) + hw + 2)
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy || 1
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / len2))
        const d = Math.hypot(x + 0.5 - (ax + t * dx), y + 0.5 - (ay + t * dy))
        blend(x, y, color, cov(hw, d) * alpha)
      }
    }
  }

  // Axis-aligned filled rectangle with anti-aliased edges.
  const rect = (x0, y0, x1, y1, color, alpha = 1) => {
    const l = T(x0), t = T(y0), r = T(x1), b = T(y1)
    for (let y = Math.floor(t) - 1; y <= Math.ceil(b) + 1; y++) {
      for (let x = Math.floor(l) - 1; x <= Math.ceil(r) + 1; x++) {
        const d = Math.max(l - (x + 0.5), x + 0.5 - r, t - (y + 0.5), y + 0.5 - b)
        blend(x, y, color, Math.max(0, Math.min(1, 0.5 - d)) * alpha)
      }
    }
  }

  const ring = (cx, cy, r, w, color, alpha) => {
    const pcx = T(cx), pcy = T(cy), pr = S(r), hw = S(w) / 2
    const lo = Math.floor(pcx - pr - hw - 2)
    const hi = Math.ceil(pcx + pr + hw + 2)
    for (let y = Math.floor(pcy - pr - hw - 2); y <= Math.ceil(pcy + pr + hw + 2); y++) {
      for (let x = lo; x <= hi; x++) {
        const d = Math.abs(Math.hypot(x + 0.5 - pcx, y + 0.5 - pcy) - pr)
        blend(x, y, color, cov(hw, d) * alpha)
      }
    }
  }

  // Champagne-gold palette (matches the splash monogram)
  const gold1 = [200, 163, 85]  // #c8a355
  const gold2 = [217, 185, 104] // #d9b968
  const gold3 = [240, 223, 174] // #f0dfae
  const cream = [247, 236, 200] // #f7ecc8

  ring(60, 60, 56, 2.4, gold2, 0.5)

  // Candles: wick then body, ascending left to right
  seg(42, 58, 42, 82, 1.8, gold1)
  rect(38.5, 63, 45.5, 77, gold1)
  seg(60, 46, 60, 72, 1.8, gold2)
  rect(56.5, 51, 63.5, 67, gold2)
  seg(78, 34, 78, 62, 1.8, gold3)
  rect(74.5, 39, 81.5, 56, gold3)

  // Ascending trace with arrowhead
  const w = 2.6
  seg(30, 88, 47, 70, w, cream)
  seg(47, 70, 60, 77, w, cream)
  seg(60, 77, 90, 32, w, cream)
  seg(83, 32, 90, 32, w, cream)
  seg(90, 32, 90, 39, w, cream)

  return encodePNG(W, H, px)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const targets = [
  ['icon-192.png', 192, 0.98],
  ['icon-512.png', 512, 0.98],
  ['icon-maskable-512.png', 512, 0.7], // shrink into the maskable safe zone
  ['apple-touch-icon.png', 180, 0.98],
]
for (const [name, size, scale] of targets) {
  fs.writeFileSync(path.join(OUT_DIR, name), drawIcon(size, scale))
  console.log('wrote', path.relative(path.join(__dirname, '..'), path.join(OUT_DIR, name)))
}

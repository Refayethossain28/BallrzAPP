// Generates the PWA icon set as PNGs with zero external dependencies.
// Draws a simple ascending bar-chart motif on the app's blue brand color.
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
function drawIcon(size, pad) {
  const W = size
  const H = size
  const px = Buffer.alloc(W * H * 4)
  const bg = [0x25, 0x63, 0xeb] // blue-600 (#2563eb) — matches the in-app logo
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = bg[0]
    px[i * 4 + 1] = bg[1]
    px[i * 4 + 2] = bg[2]
    px[i * 4 + 3] = 255
  }

  const rect = (x0, y0, x1, y1, color) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) {
        const i = (y * W + x) * 4
        px[i] = color[0]
        px[i + 1] = color[1]
        px[i + 2] = color[2]
        px[i + 3] = 255
      }
    }
  }

  const white = [255, 255, 255]
  const inner = size * (1 - 2 * pad)
  const left = size * pad
  const baseY = size * (1 - pad)
  const heights = [0.32, 0.52, 0.66, 0.88] // clean ascending trend
  const nbars = heights.length
  const gap = inner * 0.07
  const bw = (inner - gap * (nbars - 1)) / nbars
  for (let b = 0; b < nbars; b++) {
    const x0 = left + b * (bw + gap)
    rect(x0, baseY - inner * heights[b], x0 + bw, baseY, white)
  }
  return encodePNG(W, H, px)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const targets = [
  ['icon-192.png', 192, 0.16],
  ['icon-512.png', 512, 0.16],
  ['icon-maskable-512.png', 512, 0.26], // extra safe-zone padding for maskable
  ['apple-touch-icon.png', 180, 0.16],
]
for (const [name, size, pad] of targets) {
  fs.writeFileSync(path.join(OUT_DIR, name), drawIcon(size, pad))
  console.log('wrote', path.relative(path.join(__dirname, '..'), path.join(OUT_DIR, name)))
}

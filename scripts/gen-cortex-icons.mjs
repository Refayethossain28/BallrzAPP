#!/usr/bin/env node
/**
 * Generates the Cortex PWA icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder as gen-coin-icons.mjs). The motif is
 * the thing itself: a tiny neural network (2→3→1, the shape of the shared
 * model) drawn on a dark tile — GREEN for the Miner app, BLUE for the Wallet,
 * so the two installed apps read as a set but are instantly tellable apart.
 *
 * Run: node scripts/gen-cortex-icons.mjs
 *   → cortex/mine-icon-{192,512}.png,  mine-icon-maskable-512.png,  mine-icon-180.png
 *   → cortex/wallet-icon-{192,512}.png, wallet-icon-maskable-512.png, wallet-icon-180.png
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'cortex');

/* ---- minimal PNG (RGBA) ---- */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(N, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---- tiny software rasteriser (signed distances + smooth edges) ---- */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (d, aa) => clamp(0.5 - d / aa, 0, 1); // coverage from signed distance
function sdRoundBox(x, y, hw, hh, r) {
  const qx = Math.abs(x) - hw + r, qy = Math.abs(y) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}
function sdCircle(x, y, cx, cy, r) { return Math.hypot(x - cx, y - cy) - r; }
function sdSegment(x, y, ax, ay, bx, by) {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const h = clamp((px * dx + py * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(px - dx * h, py - dy * h);
}

// The 2→3→1 network, in unit coordinates.
const L1 = [[0.26, 0.38], [0.26, 0.62]];
const L2 = [[0.52, 0.30], [0.52, 0.50], [0.52, 0.70]];
const L3 = [[0.78, 0.50]];
const EDGES = [];
for (const a of L1) for (const b of L2) EDGES.push([a, b]);
for (const a of L2) for (const b of L3) EDGES.push([a, b]);

function renderIcon(N, { accent, maskable }) {
  const rgba = Buffer.alloc(N * N * 4);
  const aa = 1.6 / N;
  const bg = [11, 14, 20];              // #0b0e14
  const edgeC = accent.map((v) => Math.round(v * 0.55));
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const x = (px + 0.5) / N, y = (py + 0.5) / N;
      let r = 0, g = 0, b = 0, a = 0;
      // tile: full-bleed for maskable, rounded for "any"
      const tile = maskable ? 1 : smooth(sdRoundBox(x - 0.5, y - 0.5, 0.46, 0.46, 0.11), aa);
      if (tile > 0) {
        r = bg[0]; g = bg[1]; b = bg[2]; a = 255 * tile;
        // edges
        let e = 0;
        for (const [p, q] of EDGES) e = Math.max(e, smooth(sdSegment(x, y, p[0], p[1], q[0], q[1]) - 0.016, aa));
        if (e > 0) { r = r + (edgeC[0] - r) * e; g = g + (edgeC[1] - g) * e; b = b + (edgeC[2] - b) * e; }
        // nodes (output node slightly bigger + a ring)
        let n = 0;
        for (const [cx, cy] of [...L1, ...L2]) n = Math.max(n, smooth(sdCircle(x, y, cx, cy, 0.055), aa));
        const out = L3[0];
        n = Math.max(n, smooth(sdCircle(x, y, out[0], out[1], 0.075), aa));
        if (n > 0) { r = r + (accent[0] - r) * n; g = g + (accent[1] - g) * n; b = b + (accent[2] - b) * n; }
        const ring = smooth(Math.abs(sdCircle(x, y, out[0], out[1], 0.115)) - 0.012, aa);
        if (ring > 0) { r = r + (accent[0] - r) * ring * 0.8; g = g + (accent[1] - g) * ring * 0.8; b = b + (accent[2] - b) * ring * 0.8; }
      }
      const i = (py * N + px) * 4;
      rgba[i] = Math.round(r); rgba[i + 1] = Math.round(g); rgba[i + 2] = Math.round(b); rgba[i + 3] = Math.round(a);
    }
  }
  return encodePNG(N, rgba);
}

const GREEN = [90, 209, 168];   // #5ad1a8 — Miner
const BLUE = [106, 169, 255];   // #6aa9ff — Wallet

for (const [prefix, accent] of [['mine', GREEN], ['wallet', BLUE]]) {
  writeFileSync(join(OUT, `${prefix}-icon-192.png`), renderIcon(192, { accent }));
  writeFileSync(join(OUT, `${prefix}-icon-512.png`), renderIcon(512, { accent }));
  writeFileSync(join(OUT, `${prefix}-icon-maskable-512.png`), renderIcon(512, { accent, maskable: true }));
  writeFileSync(join(OUT, `${prefix}-icon-180.png`), renderIcon(180, { accent, maskable: true })); // apple-touch (iOS wants full-bleed)
  console.log(`wrote cortex/${prefix}-icon-{192,512,maskable-512,180}.png`);
}

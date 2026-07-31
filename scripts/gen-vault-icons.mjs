#!/usr/bin/env node
/**
 * Generates the Vault app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-drip-icons.mjs).
 * Rasterizes the same motif as vault/icon.svg: a deep-indigo rounded tile with
 * a bank-vault door — a violet→mint locking ring, four bolt handles, a solid
 * inner core, and a gold cross-spindle at the centre.
 *
 * Run: node scripts/gen-vault-icons.mjs   (writes icon-180/192/512.png into vault/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'vault');

/* ---- minimal PNG (RGBA, no palette) ---- */
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
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---- helpers ---- */
const VIOLET = [0x8b, 0x7c, 0xf7];
const MINT = [0x3c, 0xe6, 0xb0];
const GOLD = [0xf5, 0xc0, 0x4a];
const CORE = [0x12, 0x16, 0x31];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
/** The ring gradient: violet at top-left → mint at bottom-right. */
function ringCol(x, y, N) {
  const f = clamp((x + y) / (2 * N));
  return [lerp(VIOLET[0], MINT[0], f), lerp(VIOLET[1], MINT[1], f), lerp(VIOLET[2], MINT[2], f)];
}
/** Distance to a vertical/horizontal capsule (rounded-cap line segment). */
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const c1 = vx * wx + vy * wy, c2 = vx * vx + vy * vy;
  const t = c2 ? clamp(c1 / c2) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/* ---- the artwork (geometry in 512-space, scaled to N) ---- */
function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const s = N / 512, c = N / 2;
  const ringR = 150 * s, ringHW = 13 * s;      // locking ring radius + half-width
  const coreR = 86 * s, coreEdge = 5 * s;
  const boltHW = 11 * s;                        // bolt capsule half-width
  const spindleHW = 9 * s, spindleL = 40 * s;   // gold cross
  const aa = 1.6 * s;
  const bolts = [
    [256 * s, 66 * s, 256 * s, 118 * s], [256 * s, 394 * s, 256 * s, 446 * s],
    [66 * s, 256 * s, 118 * s, 256 * s], [394 * s, 256 * s, 446 * s, 256 * s]
  ];

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // radial deep-indigo background
    const dist = Math.hypot(x - N * 0.6, y - N * 0.2);
    const rb = clamp(dist / (N * 0.9));
    let col = [lerp(0x1e, 0x0a, rb), lerp(0x23, 0x0c, rb), lerp(0x42, 0x14, rb)];

    const g = ringCol(x, y, N);
    const dc = Math.hypot(x - c, y - c);

    // locking ring (annulus)
    const ringCov = 1 - smooth(ringHW - aa, ringHW + aa, Math.abs(dc - ringR));
    col = [lerp(col[0], g[0], ringCov), lerp(col[1], g[1], ringCov), lerp(col[2], g[2], ringCov)];

    // four bolt handles
    let boltCov = 0;
    for (const [ax, ay, bx, by] of bolts) {
      boltCov = Math.max(boltCov, 1 - smooth(boltHW - aa, boltHW + aa, distSeg(x, y, ax, ay, bx, by)));
    }
    col = [lerp(col[0], g[0], boltCov), lerp(col[1], g[1], boltCov), lerp(col[2], g[2], boltCov)];

    // solid inner core with a gradient rim
    const rimCov = 1 - smooth(coreEdge - aa, coreEdge + aa, Math.abs(dc - coreR));
    const coreCov = 1 - smooth(coreR - coreEdge - aa, coreR - coreEdge + aa, dc);
    col = [lerp(col[0], CORE[0], coreCov), lerp(col[1], CORE[1], coreCov), lerp(col[2], CORE[2], coreCov)];
    col = [lerp(col[0], g[0], rimCov), lerp(col[1], g[1], rimCov), lerp(col[2], g[2], rimCov)];

    // gold spindle cross in the core
    const dCross = Math.min(distSeg(x, y, c, c - spindleL, c, c + spindleL), distSeg(x, y, c - spindleL, c, c + spindleL, c));
    const crossCov = (1 - smooth(spindleHW - aa, spindleHW + aa, dCross)) * coreCov;
    col = [lerp(col[0], GOLD[0], crossCov), lerp(col[1], GOLD[1], crossCov), lerp(col[2], GOLD[2], crossCov)];

    const i = (y * N + x) * 4;
    buf[i] = Math.round(col[0]); buf[i + 1] = Math.round(col[1]); buf[i + 2] = Math.round(col[2]); buf[i + 3] = 255;
  }
  return buf;
}

for (const N of [180, 192, 512]) {
  const png = encodePNG(N, render(N));
  writeFileSync(join(OUT, `icon-${N}.png`), png);
  console.log(`wrote icon-${N}.png (${png.length} bytes)`);
}

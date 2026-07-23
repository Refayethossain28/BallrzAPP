#!/usr/bin/env node
/**
 * Generates the Lingua app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-cusp-icons.mjs).
 * Motif: a radial-dark rounded square holding a gradient speech bubble with a
 * tail — the "translate / speak any language" idea — plus a teal accent dot.
 *
 * Run: node scripts/gen-lingua-icons.mjs   (writes icon-180/192/512.png into lingua/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lingua');

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
const STOPS = [[0, [0x6e, 0x8b, 0xff]], [0.55, [0x8b, 0x7c, 0xff]], [1, [0x34, 0xe1, 0xc0]]];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function grad(t) {
  t = clamp(t);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], f = (t - a) / (b - a);
      return ca.map((v, k) => lerp(v, cb[k], f));
    }
  }
  return STOPS[STOPS.length - 1][1];
}
// signed distance to a rounded rect centred region (for the speech bubble body)
function rrectCover(x, y, x0, y0, x1, y1, r, aa) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  const d = Math.hypot(x - cx, y - cy) - r;       // outside dist (neg inside)
  return 1 - smooth(-aa, aa, d);
}
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const c1 = vx * wx + vy * wy, c2 = vx * vx + vy * vy;
  const t = c2 ? clamp(c1 / c2) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/* ---- artwork (geometry in 512-space, scaled to N) ---- */
function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const s = N / 512, aa = 1.6 * s;
  // bubble body + tail
  const bx0 = 96 * s, by0 = 120 * s, bx1 = 416 * s, by1 = 320 * s, br = 56 * s;
  const tipA = [180 * s, 312 * s], tipB = [150 * s, 392 * s], tipC = [248 * s, 312 * s];

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = N / 2, dist = Math.hypot(x - c, y - c);
    const rb = clamp(dist / (N * 0.72));
    let col = [lerp(0x1b, 0x0b, rb), lerp(0x24, 0x0e, rb), lerp(0x40, 0x17, rb)]; // radial dark bg

    // brand-gradient speech bubble (body ∪ triangular tail)
    let cov = rrectCover(x, y, bx0, by0, bx1, by1, br, aa);
    // tail: distance to the triangle's edges, filled if inside-ish
    const inTri = pointInTri(x, y, tipA, tipB, tipC);
    if (inTri) cov = Math.max(cov, 1);
    else cov = Math.max(cov, 1 - smooth(0, aa * 1.5, Math.min(
      distSeg(x, y, tipA[0], tipA[1], tipB[0], tipB[1]),
      distSeg(x, y, tipB[0], tipB[1], tipC[0], tipC[1])
    ) - 0));

    const g = grad((x + (N - y)) / (2 * N));
    col = [lerp(col[0], g[0], cov), lerp(col[1], g[1], cov), lerp(col[2], g[2], cov)];

    // two "dots" punched darker into the bubble = abstract glyphs / chat
    const ink = [0x0b, 0x0e, 0x17];
    const d1 = 1 - smooth(34 * s - aa, 34 * s + aa, Math.hypot(x - 206 * s, y - 220 * s));
    const d2 = 1 - smooth(30 * s - aa, 30 * s + aa, Math.hypot(x - 318 * s, y - 220 * s));
    const punch = Math.max(d1, d2) * cov;
    col = [lerp(col[0], ink[0], punch), lerp(col[1], ink[1], punch), lerp(col[2], ink[2], punch)];

    const i = (y * N + x) * 4;
    buf[i] = Math.round(col[0]); buf[i + 1] = Math.round(col[1]); buf[i + 2] = Math.round(col[2]); buf[i + 3] = 255;
  }
  return buf;
}
function sign(ax, ay, bx, by, cx, cy) { return (ax - cx) * (by - cy) - (bx - cx) * (ay - cy); }
function pointInTri(px, py, a, b, c) {
  const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
  const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
  const d3 = sign(px, py, c[0], c[1], a[0], a[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

for (const N of [180, 192, 512]) {
  const png = encodePNG(N, render(N));
  writeFileSync(join(OUT, `icon-${N}.png`), png);
  console.log(`wrote icon-${N}.png (${png.length} bytes)`);
}

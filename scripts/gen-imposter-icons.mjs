#!/usr/bin/env node
/**
 * Generates the Imposter app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder as gen-cusp-icons.mjs).
 * Rasterizes the icon.svg motif: a radial-dark rounded square holding a
 * brand-gradient spy mask — a detective hat, two masked eye-holes and a
 * "shhh" smirk, with a teal accent node.
 *
 * Run: node scripts/gen-imposter-icons.mjs   (writes icon-180/192/512.png into imposter/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'imposter');

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
const STOPS = [[0, [0x7c, 0x8b, 0xff]], [0.5, [0x8b, 0x7c, 0xff]], [1, [0x34, 0xe7, 0xc0]]];
const TEAL = [0x34, 0xe7, 0xc0];
const INK = [0x0a, 0x0d, 0x17];
const clamp = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;
const mix = (ca, cb, f) => ca.map((v, k) => lerp(v, cb[k], f));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function grad(t) {
  t = clamp(t);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], f = (t - a) / (b - a);
      return mix(ca, cb, f);
    }
  }
  return STOPS[STOPS.length - 1][1];
}
// distance from point to segment a→b
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
  const aa = 1.6 * s;

  // hat crown: a half-disc; brim: a wide ellipse. eyes: two discs with ink pupils.
  const brim = { cx: c, cy: 196 * s, rx: 150 * s, ry: 34 * s };
  const crown = { cx: c, cy: 190 * s, r: 106 * s }; // upper half only
  const eyeL = { cx: 206 * s, cy: 300 * s, r: 40 * s };
  const eyeR = { cx: 306 * s, cy: 300 * s, r: 40 * s };
  const pupR = 17 * s;
  const node = { cx: c, cy: 392 * s, r: 13 * s };

  const inEllipse = (x, y, e) => {
    const dx = (x - e.cx) / e.rx, dy = (y - e.cy) / e.ry;
    return Math.hypot(dx, dy); // ~1 at edge
  };

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dist = Math.hypot(x - c, y - c);
    const rb = clamp(dist / (N * 0.72));
    let col = [lerp(0x1c, 0x08, rb), lerp(0x27, 0x0a, rb), lerp(0x48, 0x14, rb)]; // radial dark bg
    const g = grad((x + (N - y)) / (2 * N)); // diagonal brand gradient

    let cov = 0;
    // brim ellipse
    cov = Math.max(cov, 1 - smooth(0.96, 1.04, inEllipse(x, y, brim)));
    // crown: disc clipped to upper half (y above brim centre)
    if (y <= crown.cy + 6 * s) cov = Math.max(cov, 1 - smooth(crown.r - aa, crown.r + aa, Math.hypot(x - crown.cx, y - crown.cy)));
    // eyes (mask discs)
    cov = Math.max(cov, 1 - smooth(eyeL.r - aa, eyeL.r + aa, Math.hypot(x - eyeL.cx, y - eyeL.cy)));
    cov = Math.max(cov, 1 - smooth(eyeR.r - aa, eyeR.r + aa, Math.hypot(x - eyeR.cx, y - eyeR.cy)));
    // smirk stroke
    const smirkD = distSeg(x, y, 196 * s, 372 * s, 256 * s, 384 * s);
    const smirkD2 = distSeg(x, y, 256 * s, 384 * s, 316 * s, 372 * s);
    cov = Math.max(cov, 1 - smooth(8 * s - aa, 8 * s + aa, Math.min(smirkD, smirkD2)));

    col = mix(col, g, cov);

    // ink details on top of the brand shape: brim shadow band + pupils
    let ink = 0;
    if (y > brim.cy - 10 * s && y < brim.cy + 10 * s) ink = Math.max(ink, (1 - smooth(0.0, 1.0, inEllipse(x, y, { cx: c, cy: brim.cy, rx: 150 * s, ry: 10 * s }))) * 0.4);
    ink = Math.max(ink, 1 - smooth(pupR - aa, pupR + aa, Math.hypot(x - eyeL.cx, y - eyeL.cy)));
    ink = Math.max(ink, 1 - smooth(pupR - aa, pupR + aa, Math.hypot(x - eyeR.cx, y - eyeR.cy)));
    col = mix(col, INK, ink);

    // teal accent node
    const ncov = 1 - smooth(node.r - aa, node.r + aa, Math.hypot(x - node.cx, y - node.cy));
    col = mix(col, TEAL, ncov);

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

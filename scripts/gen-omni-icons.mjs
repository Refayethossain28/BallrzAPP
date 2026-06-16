#!/usr/bin/env node
/**
 * Generates the Omni app icons as real PNGs — no image libraries, just Node's
 * built-in zlib. Rasterizes the same motif as omni/icon.svg: a radial-dark
 * rounded square holding a 3×3 grid of gradient dots (the "everything" launcher
 * metaphor) with a brighter centre node.
 *
 * Run: node scripts/gen-omni-icons.mjs   (writes icon-180/192/512.png into omni/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'omni');

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

/* ---- the artwork ---- */
const STOPS = [[0, [0x6e, 0x8bff & 0xff, 0xff]], [0.5, [0x8b, 0x7c, 0xff]], [1, [0x39, 0xe6, 0xb4]]];
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
function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const c = N / 2;
  // grid geometry: 3×3 dots centred, centre dot larger
  const gap = N * 0.26;
  const r0 = N * 0.052;          // outer dots radius
  const rc = N * 0.085;          // centre dot radius
  const nodes = [];
  for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) {
    nodes.push([c + gx * gap, c + gy * gap, gx === 0 && gy === 0 ? rc : r0]);
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dist = Math.hypot(x - c, y - c);
    const rb = clamp(dist / (N * 0.72));               // radial dark background (opaque, full-bleed)
    let col = [lerp(0x14, 0x07, rb), lerp(0x16, 0x09, rb), lerp(0x24, 0x12, rb)];
    const g = grad((x + (N - y)) / (2 * N));            // diagonal brand gradient
    let a = 0;
    for (const [nx, ny, nr] of nodes) {
      const d = Math.hypot(x - nx, y - ny);
      a = Math.max(a, 1 - smooth(nr - 1.5, nr + 1.5, d));
    }
    col = [lerp(col[0], g[0], a), lerp(col[1], g[1], a), lerp(col[2], g[2], a)];
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

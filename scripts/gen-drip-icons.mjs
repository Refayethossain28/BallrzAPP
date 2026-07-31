#!/usr/bin/env node
/**
 * Generates the Drip app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-cusp-icons.mjs).
 * Rasterizes the same motif as drip/icon.svg: a radial-dark rounded square
 * holding a teal→green→gold droplet with a dark coin face and a gold sparkle.
 *
 * Run: node scripts/gen-drip-icons.mjs   (writes icon-180/192/512.png into drip/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'drip');

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
const STOPS = [[0, [0x39, 0xe6, 0xb4]], [0.55, [0x3f, 0xd6, 0x8f]], [1, [0xf5, 0xc0, 0x4a]]];
const GOLD = [0xff, 0xdd, 0x87];
const COIN = [0x0b, 0x1a, 0x11];
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
// distance from point (px,py) to segment a→b
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const c1 = vx * wx + vy * wy, c2 = vx * vx + vy * vy;
  const t = c2 ? clamp(c1 / c2) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Signed droplet coverage at (x,y) in 512-space: the classic drop is the union
 * of a circle (the bulb) and the triangle from the apex to the two horizontal
 * tangent points of the circle. Returns 0..1 with a soft edge of width `aa`.
 */
function dropCov(x, y, cx, cy, r, apexY, aa) {
  const dCirc = Math.hypot(x - cx, y - cy) - r;                 // <0 inside bulb
  // triangle apex→left/right tangent points (at the circle's equator)
  const ax = cx, ay = apexY, lx = cx - r, rx = cx + r, ty = cy;
  let dTri;
  const inTri = (() => { // barycentric-ish: point-in-triangle via sign tests
    const s1 = (x - ax) * (ty - ay) - (lx - ax) * (y - ay);
    const s2 = (x - lx) * (ty - ty) - (rx - lx) * (y - ty);
    const s3 = (x - rx) * (ay - ty) - (ax - rx) * (y - ty);
    return (s1 <= 0 && s2 <= 0 && s3 <= 0) || (s1 >= 0 && s2 >= 0 && s3 >= 0);
  })();
  const edge = Math.min(distSeg(x, y, ax, ay, lx, ty), distSeg(x, y, ax, ay, rx, ty), distSeg(x, y, lx, ty, rx, ty));
  dTri = inTri ? -edge : edge;
  const d = Math.min(dCirc, dTri);                              // union
  return 1 - smooth(-aa, aa, d);
}

/* ---- the artwork (geometry in 512-space, scaled to N) ---- */
function render(N) {
  const buf = Buffer.alloc(N * N * 4);
  const s = N / 512, c = N / 2;
  const bulb = { x: 256 * s, y: 300 * s, r: 112 * s };
  const apexY = 92 * s;
  const coinR = 64 * s, coinRingHW = 7 * s;
  const barW = 9 * s, barH = 40 * s;                 // the £-ish glyph: bar + crossbar
  const spark = { x: 356 * s, y: 132 * s, r: 13 * s };
  const aa = 1.6 * s;

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dist = Math.hypot(x - c, y - (N * 0.38));
    const rb = clamp(dist / (N * 0.8));
    let col = [lerp(0x14, 0x08, rb), lerp(0x28, 0x12, rb), lerp(0x1d, 0x09, rb)]; // radial dark green bg

    // droplet in the diagonal brand gradient
    const g = grad((x + y) / (2 * N));
    const cov = dropCov(x, y, bulb.x, bulb.y, bulb.r, apexY, aa);
    col = [lerp(col[0], g[0], cov), lerp(col[1], g[1], cov), lerp(col[2], g[2], cov)];

    // dark coin face inside the bulb, with a thin gold ring + vertical bar mark
    const dCoin = Math.hypot(x - bulb.x, y - bulb.y);
    const coinCov = (1 - smooth(coinR - aa, coinR + aa, dCoin)) * cov;
    col = [lerp(col[0], COIN[0], coinCov * 0.9), lerp(col[1], COIN[1], coinCov * 0.9), lerp(col[2], COIN[2], coinCov * 0.9)];
    const ringCov = (1 - smooth(coinRingHW - aa, coinRingHW + aa, Math.abs(dCoin - coinR * 0.72))) * coinCov;
    let mark = ringCov * 0.55;
    // simple upright £-suggestion: stem, a mid crossbar, and a wide base bar
    const inStem = Math.abs(x - (bulb.x - 6 * s)) < barW && y > bulb.y - barH && y < bulb.y + barH * 0.75;
    const inCross = Math.abs(y - (bulb.y - 4 * s)) < barW * 0.8 && Math.abs(x - (bulb.x - 6 * s)) < barH * 0.5;
    const inBase = Math.abs(y - (bulb.y + barH * 0.75)) < barW * 0.8 && Math.abs(x - bulb.x) < barH * 0.62;
    if ((inStem || inCross || inBase) && coinCov > 0.5) mark = Math.max(mark, 0.95);
    col = [lerp(col[0], GOLD[0], mark), lerp(col[1], GOLD[1], mark), lerp(col[2], GOLD[2], mark)];

    // gold sparkle
    const scov = 1 - smooth(spark.r - aa, spark.r + aa, Math.hypot(x - spark.x, y - spark.y));
    col = [lerp(col[0], GOLD[0], scov), lerp(col[1], GOLD[1], scov), lerp(col[2], GOLD[2], scov)];

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

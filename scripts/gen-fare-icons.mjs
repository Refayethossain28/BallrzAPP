#!/usr/bin/env node
/**
 * Generates the Fare app icons as real PNGs — no image libraries, just
 * Node's built-in zlib (same minimal PNG encoder approach as
 * gen-magpie-icons.mjs). Rasterizes the same motif as fare/public/icon.svg:
 * a midnight rounded square, the gold chauffeur road sweeping up with a
 * dashed centre line, and the pound coin it earns at the summit.
 *
 * Run: node scripts/gen-fare-icons.mjs   (writes icon-180/192/512.png into fare/public/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fare', 'public');

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
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---- helpers ---- */
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function capsuleDist(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1), 0, 1);
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t));
}
// the road from icon.svg: M96 428 C 210 388, 176 268, 268 220 C 348 178, 380 150, 408 96
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}
function roadPoints() {
  const a = [[96, 428], [210, 388], [176, 268], [268, 220]];
  const b = [[268, 220], [348, 178], [380, 150], [408, 96]];
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push(bezier(...a, i / 40));
  for (let i = 1; i <= 40; i++) pts.push(bezier(...b, i / 40));
  return pts;
}
const ROAD = roadPoints();
// dash dots along the road, spaced by arc length
const DOTS = (() => {
  const dots = []; let acc = 24;
  for (let i = 1; i < ROAD.length; i++) {
    acc += Math.hypot(ROAD[i][0] - ROAD[i - 1][0], ROAD[i][1] - ROAD[i - 1][1]);
    if (acc >= 46) { dots.push(ROAD[i]); acc = 0; }
  }
  return dots;
})();
// the £ glyph as capsule strokes (design space 512, centred on the coin)
const CX = 408, CY = 96;
const POUND = [
  [CX + 2, CY - 26, CX - 6, CY + 16],   // stem, leaning
  [CX + 2, CY - 26, CX + 16, CY - 20],  // top hook
  [CX - 18, CY - 2, CX + 10, CY - 2],   // crossbar
  [CX - 14, CY + 22, CX + 20, CY + 18], // base bar
];

function goldAt(x, y, N) { // bottom-left #9c7a1e → top-right #e9c25a
  const t = clamp((x + (N - y)) / (2 * N), 0, 1);
  return [Math.round(lerp(0x9c, 0xe9, t)), Math.round(lerp(0x7a, 0xc2, t)), Math.round(lerp(0x1e, 0x5a, t))];
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const S = N / 512;
  const aa = 1.0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      const corner = 116 * S;
      const qx = Math.abs(x - N / 2) - (N / 2 - corner);
      const qy = Math.abs(y - N / 2) - (N / 2 - corner);
      const rd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const mask = clamp(0.5 - rd / aa, 0, 1);
      if (mask <= 0) { rgba[i + 3] = 0; continue; }

      // radial midnight background, light pooling near the top
      const dTop = clamp(Math.hypot(x - N * 0.5, y - N * 0.2) / (N * 0.95), 0, 1);
      let r = Math.round(lerp(0x1b, 0x0a, dTop));
      let g = Math.round(lerp(0x24, 0x0f, dTop));
      let b = Math.round(lerp(0x33, 0x16, dTop));
      const [gr, gg, gb] = goldAt(x, y, N);

      // the road (thick gold sweep)
      let dRoad = Infinity;
      for (let s = 1; s < ROAD.length; s++) {
        dRoad = Math.min(dRoad, capsuleDist(x, y, ROAD[s - 1][0] * S, ROAD[s - 1][1] * S, ROAD[s][0] * S, ROAD[s][1] * S));
      }
      const aRoad = clamp(0.5 - (dRoad - 29 * S) / aa, 0, 1);
      if (aRoad > 0) { r = Math.round(lerp(r, gr, aRoad)); g = Math.round(lerp(g, gg, aRoad)); b = Math.round(lerp(b, gb, aRoad)); }

      // dashed centre line (dark dots punched into the road)
      let dDot = Infinity;
      for (const [dx, dy] of DOTS) dDot = Math.min(dDot, Math.hypot(x - dx * S, y - dy * S));
      const aDot = clamp(0.5 - (dDot - 4.5 * S) / aa, 0, 1) * aRoad;
      if (aDot > 0) { r = Math.round(lerp(r, 0x0a, aDot)); g = Math.round(lerp(g, 0x0f, aDot)); b = Math.round(lerp(b, 0x16, aDot)); }

      // the pound coin: dark face…
      const dC = Math.hypot(x - CX * S, y - CY * S);
      const aFace = clamp(0.5 - (dC - 49 * S) / aa, 0, 1);
      if (aFace > 0) { r = Math.round(lerp(r, 0x0a, aFace)); g = Math.round(lerp(g, 0x0f, aFace)); b = Math.round(lerp(b, 0x16, aFace)); }
      // …gold rim…
      const aRim = clamp(0.5 - (Math.abs(dC - 54 * S) - 5 * S) / aa, 0, 1);
      if (aRim > 0) { r = Math.round(lerp(r, gr, aRim)); g = Math.round(lerp(g, gg, aRim)); b = Math.round(lerp(b, gb, aRim)); }
      // …and the £ strokes
      let dP = Infinity;
      for (const [ax, ay, bx, by] of POUND) dP = Math.min(dP, capsuleDist(x, y, ax * S, ay * S, bx * S, by * S));
      const aP = clamp(0.5 - (dP - 5.5 * S) / aa, 0, 1);
      if (aP > 0) { r = Math.round(lerp(r, 0xe9, aP)); g = Math.round(lerp(g, 0xc2, aP)); b = Math.round(lerp(b, 0x5a, aP)); }

      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(N, rgba);
}

for (const n of [180, 192, 512]) {
  writeFileSync(join(OUT, `icon-${n}.png`), render(n));
  console.log(`fare/public/icon-${n}.png`);
}

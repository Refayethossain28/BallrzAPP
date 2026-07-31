#!/usr/bin/env node
/**
 * Generates the Velvet app icons as real PNGs — no image libraries, just Node's
 * built-in zlib (same minimal PNG encoder approach as gen-cusp-icons.mjs).
 * Rasterizes the same motif as concierge/icon.svg: a dark rounded square with a
 * warm radial glow, a gold ring, and a gold concierge bell with a sparkle.
 *
 * Run: node scripts/gen-concierge-icons.mjs   (writes icon-180/192/512.png into concierge/)
 */
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'concierge');

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

/* ---- painting helpers ---- */
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* smooth edge: 1 inside, 0 outside, ~1px feather */
const edge = (d, feather) => clamp01(0.5 - d / feather);

function roundRectDist(x, y, N, r) {
  const hx = N / 2, hy = N / 2;
  const dx = Math.abs(x - hx) - (hx - r), dy = Math.abs(y - hy) - (hy - r);
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function render(N) {
  const rgba = Buffer.alloc(N * N * 4);
  const px = 1;                                     // feather in device px
  const GOLD_HI = [240, 217, 140], GOLD = [212, 175, 55], GOLD_LO = [156, 122, 30];
  const u = (v) => (v / 512) * N;                   // svg units → device px

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      // rounded-square card
      const cardD = roundRectDist(x + 0.5, y + 0.5, N, u(112));
      const cardA = edge(cardD, px);
      if (cardA > 0) {
        // warm radial glow from top-left third
        const gx = (x - 0.30 * N) / N, gy = (y - 0.22 * N) / N;
        const t = clamp01(Math.hypot(gx, gy) / 1.05);
        let c = t < 0.55 ? mix([42, 32, 19], [18, 14, 8], t / 0.55) : mix([18, 14, 8], [10, 8, 6], (t - 0.55) / 0.45);

        // gold ring (r=168, w=10) with a faint inner ring (r=146)
        const dc = Math.hypot(x - N / 2, y - N / 2);
        const diag = clamp01((x + y) / (2 * N));    // gradient along the diagonal
        const goldAt = mix(GOLD_HI, GOLD_LO, diag);
        const ringA = edge(Math.abs(dc - u(168)) - u(5), px);
        if (ringA > 0) c = mix(c, goldAt, ringA);
        const ring2A = edge(Math.abs(dc - u(146)) - u(1), px) * 0.45;
        if (ring2A > 0) c = mix(c, GOLD, ring2A);

        // concierge bell: dome (half-ellipse), base bar, button
        let bell = 0;
        const bx = x - N / 2;
        // dome: ellipse a=96, b=112 centred on y=290, upper half only
        const ey = y - u(290);
        if (ey <= 0) {
          const dd = Math.hypot(bx / u(96), ey / u(112)) - 1;
          bell = Math.max(bell, edge(dd * u(96), px));
        }
        // base bar: rounded rect 220×18 (half-size 110×9, corner r=9) at y=299
        {
          const qx = Math.abs(bx) - (u(110) - u(9));
          const qy = Math.abs(y - u(299));          // half-height == corner radius
          const dd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy - u(9)), 0) - u(9);
          bell = Math.max(bell, edge(dd, px));
        }
        // button on top: circle r=12 at (256,160)
        bell = Math.max(bell, edge(Math.hypot(bx, y - u(160)) - u(12), px));
        if (bell > 0) c = mix(c, goldAt, bell);

        // sparkle: diamond at (362,148), "radius" 27
        const sp = edge((Math.abs(x - u(362)) + Math.abs(y - u(148))) - u(27), px);
        if (sp > 0) c = mix(c, GOLD_HI, sp);

        r = c[0]; g = c[1]; b = c[2]; a = 255 * cardA;
      }

      const i = (y * N + x) * 4;
      rgba[i] = Math.round(r); rgba[i + 1] = Math.round(g); rgba[i + 2] = Math.round(b); rgba[i + 3] = Math.round(a);
    }
  }
  return rgba;
}

for (const N of [180, 192, 512]) {
  const png = encodePNG(N, render(N));
  const file = join(OUT, `icon-${N}.png`);
  writeFileSync(file, png);
  console.log(`wrote ${file} (${png.length} bytes)`);
}

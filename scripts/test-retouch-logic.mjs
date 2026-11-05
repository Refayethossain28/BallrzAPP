#!/usr/bin/env node
/**
 * Unit tests for retouch/engine.js — the pure photo-studio engine behind
 * Retouch: credit plans and their resets, the content policy, the prompt →
 * pipeline parser, job building, and the pixel math itself (tone, levels,
 * blur, sharpen, vignette, grain, resampling, subject matting, inpainting)
 * over plain RGBA arrays. Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-retouch-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} }, Uint8ClampedArray, Float32Array };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'retouch', 'engine.js'), 'utf8'), sandbox, { filename: 'retouch/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 10, 5, 13, 30, 0); // 2026-11-05 13:30 UTC
const { HOUR, DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

// a tiny test image: w×h filled with one colour, alpha 255
const solid = (w, h, [r, g, b]) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b; px[i * 4 + 3] = 255; }
  return px;
};
const at = (px, w, x, y) => [px[(y * w + x) * 4], px[(y * w + x) * 4 + 1], px[(y * w + x) * 4 + 2], px[(y * w + x) * 4 + 3]];

/* ---------- hashing ---------- */
test('hashStr / rand01 / noise01 are deterministic and spread', () => {
  assert.equal(E.hashStr('retouch'), E.hashStr('retouch'));
  assert.notEqual(E.hashStr('a'), E.hashStr('b'));
  const r = E.rand01('seed'); assert.ok(r >= 0 && r < 1); assert.equal(r, E.rand01('seed'));
  const h = E.hashStr('g'); const vals = new Set(); for (let i = 0; i < 200; i++) vals.add(E.noise01(h, i).toFixed(3));
  assert.ok(vals.size > 150, 'noise varies per index');
  assert.equal(E.noise01(h, 7), E.noise01(h, 7));
});
test('escapeHTML neutralises markup', () => {
  assert.equal(E.escapeHTML('<b a="1">&\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;');
});

/* ---------- tools & presets ---------- */
test('tools: seven studio jobs, each with a positive cost and known presets', () => {
  assert.equal(E.TOOLS.length, 7);
  E.TOOLS.forEach((t) => {
    assert.ok(t.cost >= 1, t.id + ' costs credits');
    t.presets.forEach((p) => assert.ok(E.presetById(p), t.id + ' preset ' + p + ' exists'));
  });
  assert.equal(E.toolById('headshot').label, 'Headshot');
  assert.equal(E.toolById('nope'), null);
});
test('expandSteps inlines presets one level deep and keeps order', () => {
  deepEq(E.expandSteps([{ type: 'preset', id: 'mono' }, { type: 'grain', amount: 5 }]),
    [{ type: 'tone', saturation: -100, contrast: 10 }, { type: 'grain', amount: 5 }]);
  deepEq(E.expandSteps([{ type: 'preset', id: 'missing' }]), []);
});
test('orderSteps: geometry → matting → tone → finish', () => {
  const out = E.orderSteps([{ type: 'grain' }, { type: 'tone' }, { type: 'upscale' }, { type: 'background' }, { type: 'sharpen' }, { type: 'levels' }]);
  deepEq(out.map((s) => s.type), ['upscale', 'levels', 'background', 'tone', 'sharpen', 'grain']);
});

/* ---------- credits ---------- */
test('free plan: 10 a day, resets at midnight UTC', () => {
  const L = E.newLedger('free');
  assert.equal(E.creditsLeft(L, NOW), 10);
  const L2 = E.spend(L, 3, NOW);
  assert.equal(E.creditsLeft(L2, NOW), 7);
  assert.equal(E.creditsLeft(L, NOW), 10, 'spend does not mutate');
  assert.equal(E.creditsLeft(L2, NOW + DAY), 10, 'fresh allowance tomorrow');
  assert.equal(E.dayKey(NOW), '2026-11-05');
  assert.equal(E.nextResetAt('free', NOW), Date.UTC(2026, 10, 6));
});
test('spend refuses what you can’t pay and rounds junk costs', () => {
  const L = E.spend(E.newLedger('free'), 9, NOW);
  assert.equal(E.spend(L, 2, NOW), null);
  assert.equal(E.canAfford(L, 1, NOW), true);
  assert.equal(E.creditsLeft(E.spend(L, 'x', NOW), NOW), 1, 'NaN cost → 0');
});
test('pro plan: monthly pool, switching keeps the spend record', () => {
  const L = E.switchPlan(E.spend(E.newLedger('free'), 4, NOW), 'pro');
  assert.equal(L.plan, 'pro');
  assert.equal(E.creditsLeft(L, NOW), 400, 'daily spend is not counted against the month');
  const L2 = E.spend(L, 50, NOW);
  assert.equal(E.creditsLeft(L2, NOW + 20 * DAY), 350, 'same month');
  assert.equal(E.creditsLeft(L2, Date.UTC(2026, 11, 1)), 400, 'next month');
  assert.equal(E.switchPlan(L, 'bogus').plan, 'free');
});
test('creditsSummary: reset text and low flag', () => {
  const s = E.creditsSummary(E.spend(E.newLedger('free'), 8, NOW), NOW);
  deepEq([s.left, s.low, s.resetText, s.planLabel], [2, true, 'resets in 11h', 'Free']);
  const p = E.creditsSummary(E.newLedger('pro'), NOW);
  assert.ok(/days$/.test(p.resetText));
});

/* ---------- policy ---------- */
test('policy: ordinary edits pass', () => {
  ['warmer and sharper', 'blur the background', 'remove the lamp', 'make my headshot look professional', 'brighter, more contrast'].forEach((p) => {
    assert.equal(E.checkPolicy(p).ok, true, p);
  });
});
test('policy: undressing, sexualising and forging are refused before any work', () => {
  ['undress her', 'remove her clothes', 'make him naked', 'nudify this', 'take off their shirt', 'deep nude', 'see-through top', 'bikini swap', 'sexy teen', 'fake passport photo'].forEach((p) => {
    const r = E.checkPolicy(p);
    assert.equal(r.ok, false, p);
    assert.ok(r.reason.length > 10, 'has a reason');
  });
  const j = E.parsePrompt('undress her and make it brighter');
  assert.equal(j.ok, false); deepEq(j.steps, []);
});

/* ---------- prompt parser ---------- */
test('parsePrompt: phrases become ordered steps with labels', () => {
  const p = E.parsePrompt('make it black and white, sharper, with a vignette');
  assert.equal(p.ok, true);
  deepEq(p.matched, ['black & white', 'sharpen', 'vignette']);
  deepEq(p.steps.map((s) => s.type), ['tone', 'sharpen', 'vignette']);
  assert.equal(p.steps[0].saturation, -100);
});
test('parsePrompt: intensity words scale amounts', () => {
  assert.equal(E.parsePrompt('warmer').steps[0].temperature, 22);
  assert.equal(E.parsePrompt('a bit warmer').steps[0].temperature, 11);
  assert.equal(E.parsePrompt('much warmer').steps[0].temperature, 33);
  assert.equal(E.parsePrompt('very blurry background').steps[0].radius, 6, 'radius is not scaled');
});
test('parsePrompt: background phrasing variants', () => {
  deepEq(E.parsePrompt('blur the background').matched, ['blurred background']);
  deepEq(E.parsePrompt('portrait mode please').matched, ['blurred background']);
  deepEq(E.parsePrompt('remove my background').matched, ['white background']);
  deepEq(E.parsePrompt('upscale and enhance').steps.map((s) => s.type), ['upscale', 'levels', 'sharpen', 'sharpen']);
});
test('parsePrompt: empty or unknown text is a clear no', () => {
  assert.equal(E.parsePrompt('').ok, false);
  assert.equal(E.parsePrompt('   ').ok, false);
  const r = E.parsePrompt('put a dragon in it');
  assert.equal(r.ok, false); assert.ok(/didn’t catch/.test(r.reason));
});

/* ---------- jobs ---------- */
test('buildJob: preset tools expand, prompts refine, ids are stable', () => {
  const j = E.buildJob('headshot', { preset: 'studio', prompt: 'a bit warmer', seed: 'p.jpg' }, NOW);
  assert.equal(j.ok, true);
  assert.equal(j.cost, 3);
  assert.equal(j.label, 'Headshot · Studio + warmer');
  deepEq(j.steps.map((s) => s.type), ['levels', 'background', 'tone', 'tone', 'sharpen']);
  assert.equal(j.id, E.buildJob('headshot', { preset: 'studio', prompt: 'a bit warmer', seed: 'p.jpg' }, NOW).id);
  assert.notEqual(j.id, E.buildJob('headshot', { preset: 'studio', prompt: 'a bit warmer', seed: 'q.jpg' }, NOW).id);
  assert.ok(j.seconds > 1 && j.seconds < 10);
});
test('buildJob: default preset, wrong preset, unknown tool', () => {
  assert.equal(E.buildJob('style', {}, NOW).label, 'Style · Film');
  assert.equal(E.buildJob('style', { preset: 'corporate' }, NOW).ok, false, 'preset must belong to the tool');
  assert.equal(E.buildJob('wand', {}, NOW).ok, false);
});
test('buildJob: prompt tool needs an edit; remove tool needs a mask; policy wins everywhere', () => {
  assert.equal(E.buildJob('prompt', { prompt: '' }, NOW).ok, false);
  const p = E.buildJob('prompt', { prompt: 'cinematic and darker' }, NOW);
  assert.equal(p.ok, true); assert.ok(p.label.startsWith('Prompt: '));
  assert.equal(E.buildJob('remove', {}, NOW).ok, false);
  assert.equal(E.buildJob('remove', { mask: { count: 0 } }, NOW).ok, false);
  deepEq(E.buildJob('remove', { mask: { count: 12 } }, NOW).steps, [{ type: 'inpaint', smooth: 3 }]);
  assert.equal(E.buildJob('enhance', { preset: 'auto', prompt: 'undress them' }, NOW).ok, false);
  assert.equal(E.buildJob('enhance', { preset: 'auto', prompt: 'dragon' }, NOW).ok, true, 'an unrecognised note is ignored alongside a preset');
});

/* ---------- pixel math ---------- */
test('applyTone: brightness, contrast, saturation, temperature behave and never mutate', () => {
  const px = solid(2, 2, [100, 150, 200]);
  const b = E.applyTone(px, 2, 2, { brightness: 10 });
  deepEq(at(b, 2, 0, 0), [113, 163, 213, 255]);
  deepEq(at(px, 2, 0, 0), [100, 150, 200, 255], 'input untouched');
  const g = E.applyTone(px, 2, 2, { saturation: -100 });
  const [r, gg, bb] = at(g, 2, 1, 1); assert.equal(r, gg); assert.equal(gg, bb);
  const w = E.applyTone(px, 2, 2, { temperature: 50 });
  assert.ok(at(w, 2, 0, 0)[0] > 100 && at(w, 2, 0, 0)[2] < 200, 'warmer = more red, less blue');
  const c = E.applyTone(solid(1, 1, [200, 200, 200]), 1, 1, { contrast: 50 });
  assert.equal(at(c, 1, 0, 0)[0], 236, 'contrast pushes away from mid grey');
  assert.equal(at(E.applyTone(px, 2, 2, { brightness: 999 }), 2, 0, 0)[0], 255, 'clamped');
});
test('applyLevels stretches the 1–99% range to full', () => {
  const w = 10, h = 10, px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = 60 + Math.round(i * 100 / 99); px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255; }
  const pc = E.channelPercentiles(px, w, h, 0.01, 0.99);
  assert.equal(pc[0][0], 60); assert.ok(pc[0][1] >= 158);
  const out = E.applyLevels(px, w, h, { low: 0.01, high: 0.99 });
  assert.equal(out[0], 0); assert.equal(out[(w * h - 1) * 4], 255);
  assert.equal(E.applyLevels(solid(3, 3, [50, 50, 50]), 3, 3, {})[0], 50, 'flat image is left alone');
  // a shared range keeps hue: a warm patch on a dark→light grey ramp stays warm, not clipped per channel
  const w2 = 10, h2 = 10, px2 = new Uint8ClampedArray(w2 * h2 * 4);
  for (let i = 0; i < w2 * h2; i++) { const v = 20 + Math.round(i * 200 / 99); px2[i * 4] = v; px2[i * 4 + 1] = v; px2[i * 4 + 2] = v; px2[i * 4 + 3] = 255; }
  px2.set([180, 120, 80, 255], 50 * 4);
  const o2 = E.applyLevels(px2, w2, h2, { low: 0.01, high: 0.99 });
  const [r2, g2, b2] = [o2[200], o2[201], o2[202]];
  assert.ok(r2 > g2 && g2 > b2, 'order of channels kept: ' + [r2, g2, b2]);
  assert.ok(Math.abs((r2 - b2) / (g2 - b2) - (180 - 80) / (120 - 80)) < 0.15, 'channel ratios kept');
});
test('boxBlur matches a naive kernel, keeps a flat image flat, keeps alpha', () => {
  const w = 5, h = 4, px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < px.length; i++) px[i] = i % 4 === 3 ? 200 : (i * 37) & 255;
  const naive = (r) => {
    const o = new Uint8ClampedArray(px.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      let s = 0, n = 0;
      for (let ky = -r; ky <= r; ky++) for (let kx = -r; kx <= r; kx++) { s += px[(Math.min(h - 1, Math.max(0, y + ky)) * w + Math.min(w - 1, Math.max(0, x + kx))) * 4 + c]; n++; }
      o[(y * w + x) * 4 + c] = Math.round(s / n);
    }
    return o;
  };
  const b1 = E.boxBlur(px, w, h, 1), n1 = naive(1);
  for (let i = 0; i < px.length; i++) { if (i % 4 === 3) assert.equal(b1[i], 200); else assert.ok(Math.abs(b1[i] - n1[i]) <= 1, 'pixel ' + i); }
  const flat = E.boxBlur(solid(4, 4, [9, 8, 7]), 4, 4, 3);
  deepEq(at(flat, 4, 2, 2), [9, 8, 7, 255]);
  deepEq(Array.from(E.boxBlur(px, w, h, 0)), Array.from(px), 'radius 0 is a copy');
});
test('sharpen raises edge contrast and leaves flat areas alone', () => {
  const w = 6, h = 1, px = new Uint8ClampedArray(w * 4);
  for (let x = 0; x < w; x++) { const v = x < 3 ? 50 : 200; px[x * 4] = v; px[x * 4 + 1] = v; px[x * 4 + 2] = v; px[x * 4 + 3] = 255; }
  const s = E.sharpen(px, w, h, 1);
  assert.ok(s[2 * 4] < 50 && s[3 * 4] > 200, 'edge pushed apart');
  assert.equal(s[0], 50, 'flat stays');
  assert.equal(E.sharpen(px, w, h, 0)[2 * 4], 50);
});
test('vignette darkens corners, not the centre', () => {
  const v = E.vignette(solid(21, 21, [200, 200, 200]), 21, 21, 0.5);
  assert.equal(at(v, 21, 10, 10)[0], 200);
  assert.ok(at(v, 21, 0, 0)[0] < 120);
  assert.equal(at(v, 21, 0, 0)[3], 255);
});
test('grain is seeded: same seed same noise, bounded by amount', () => {
  const px = solid(8, 8, [128, 128, 128]);
  const a = E.grain(px, 8, 8, 10, 's1'), b = E.grain(px, 8, 8, 10, 's1'), c = E.grain(px, 8, 8, 10, 's2');
  deepEq(Array.from(a), Array.from(b));
  assert.notEqual(JSON.stringify(Array.from(a)), JSON.stringify(Array.from(c)));
  let maxDev = 0; for (let i = 0; i < a.length; i += 4) maxDev = Math.max(maxDev, Math.abs(a[i] - 128));
  assert.ok(maxDev > 0 && maxDev <= 10);
});
test('resample: 2x of a flat image stays flat; a 2-pixel gradient interpolates', () => {
  const up = E.resample(solid(3, 2, [10, 20, 30]), 3, 2, 6, 4);
  assert.equal(up.length, 6 * 4 * 4); deepEq(at(up, 6, 5, 3), [10, 20, 30, 255]);
  const px = new Uint8ClampedArray([0, 0, 0, 255, 200, 200, 200, 255]);
  const mid = E.resample(px, 2, 1, 4, 1);
  assert.equal(mid[0], 0); assert.equal(mid[3 * 4], 200); assert.ok(mid[1 * 4] > 0 && mid[1 * 4] < mid[2 * 4]);
  assert.equal(E.resample(px, 2, 1, 0, 0).length, 4, 'never below 1×1');
});
test('subjectMask: a centred blob on a flat backdrop is the subject', () => {
  const w = 40, h = 40, px = solid(w, h, [230, 230, 230]);
  for (let y = 10; y < 30; y++) for (let x = 12; x < 28; x++) { const i = (y * w + x) * 4; px[i] = 40; px[i + 1] = 60; px[i + 2] = 90; }
  const m = E.subjectMask(px, w, h);
  assert.equal(m.length, w * h);
  assert.ok(m[20 * w + 20] > 0.9, 'blob centre is subject');
  assert.ok(m[2 * w + 2] < 0.1, 'corner is backdrop');
  assert.ok(m[20 * w + 2] < 0.1, 'edge mid is backdrop');
});
test('subjectMask: a figure touching the bottom edge, skin close to the wall, is still the subject', () => {
  const w = 48, h = 60, px = solid(w, h, [201, 184, 168]);           // warm wall
  for (let y = 44; y < h; y++) for (let x = 6; x < 42; x++) { const i = (y * w + x) * 4; px[i] = 45; px[i + 1] = 42; px[i + 2] = 51; }   // shoulders on the bottom edge
  for (let y = 12; y < 46; y++) for (let x = 14; x < 34; x++) { const i = (y * w + x) * 4; px[i] = 59; px[i + 1] = 47; px[i + 2] = 40; } // hair
  for (let y = 18; y < 44; y++) for (let x = 17; x < 31; x++) { const i = (y * w + x) * 4; px[i] = 217; px[i + 1] = 167; px[i + 2] = 132; } // face, near the wall colour
  const m = E.subjectMask(px, w, h);
  assert.ok(m[30 * w + 24] > 0.9, 'face kept even though it is close to the wall: ' + m[30 * w + 24]);
  assert.ok(m[52 * w + 24] > 0.9, 'shoulders kept: ' + m[52 * w + 24]);
  assert.ok(m[3 * w + 3] < 0.1, 'wall is backdrop');
  assert.ok(m[30 * w + 2] < 0.1, 'wall beside the figure is backdrop');
});
test('replaceBackground: colour, gradient and blur modes honour the matte', () => {
  const w = 40, h = 40, px = solid(w, h, [230, 230, 230]);
  for (let y = 10; y < 30; y++) for (let x = 12; x < 28; x++) { const i = (y * w + x) * 4; px[i] = 40; px[i + 1] = 60; px[i + 2] = 90; }
  const red = E.replaceBackground(px, w, h, { mode: 'color', color: [255, 0, 0] });
  deepEq(at(red, w, 1, 1), [255, 0, 0, 255]); deepEq(at(red, w, 20, 20), [40, 60, 90, 255]);
  const gr = E.replaceBackground(px, w, h, { mode: 'gradient', from: [0, 0, 0], to: [200, 200, 200] });
  assert.ok(at(gr, w, 1, 1)[0] < 20 && at(gr, w, 1, h - 2)[0] > 180);
  const bl = E.replaceBackground(px, w, h, { mode: 'blur', radius: 3 });
  deepEq(at(bl, w, 1, 1), [230, 230, 230, 255]); deepEq(at(bl, w, 20, 20), [40, 60, 90, 255]);
});
test('inpaint fills a hole from its surroundings, deterministically', () => {
  const w = 20, h = 20, px = solid(w, h, [120, 90, 60]);
  const mask = new Float32Array(w * h);
  for (let y = 6; y < 14; y++) for (let x = 6; x < 14; x++) { const i = (y * w + x) * 4; px[i] = 255; px[i + 1] = 0; px[i + 2] = 0; mask[y * w + x] = 1; }
  const out = E.inpaint(px, w, h, mask, { seed: 'a' });
  const c = at(out, w, 10, 10);
  assert.ok(Math.abs(c[0] - 120) <= 6 && Math.abs(c[1] - 90) <= 6 && Math.abs(c[2] - 60) <= 6, 'hole took the surround colour: ' + c);
  deepEq(at(out, w, 1, 1), [120, 90, 60, 255], 'outside untouched');
  deepEq(Array.from(out), Array.from(E.inpaint(px, w, h, mask, { seed: 'a' })));
  deepEq(Array.from(E.inpaint(px, w, h, new Float32Array(w * h), {})), Array.from(px), 'empty mask is a copy');
});
test('inpaint closes a hole much wider than any ring count, through the pipeline', () => {
  const w = 120, h = 100, px = solid(w, h, [90, 140, 200]);
  const mask = new Float32Array(w * h);
  for (let y = 10; y < 90; y++) for (let x = 20; x < 100; x++) { const i = (y * w + x) * 4; px[i] = 230; px[i + 1] = 30; px[i + 2] = 30; mask[y * w + x] = 1; }
  const r = E.runPipeline(px, w, h, [{ type: 'inpaint', smooth: 3 }], { mask, seed: 'z' });
  const c = at(r.px, w, 60, 50);
  assert.ok(c[0] < 110 && c[2] > 180, 'the very centre is filled with the surround, not left red: ' + c);
  const rim = at(r.px, w, 21, 11);
  assert.ok(rim[0] < 110, 'rim filled too: ' + rim);
  // a hole that is the whole frame has nothing to borrow from → unchanged
  deepEq(Array.from(E.inpaint(px, 4, 4, new Float32Array(16).fill(1), {})).slice(0, 4), [90, 140, 200, 255]);
});
test('runPipeline applies steps in order, resizes on upscale, skips unknowns', () => {
  const px = solid(8, 6, [100, 100, 100]);
  const r = E.runPipeline(px, 8, 6, [{ type: 'upscale', factor: 2 }, { type: 'tone', brightness: 10 }, { type: 'bogus' }, { type: 'preset', id: 'mono' }], { seed: 'x' });
  deepEq([r.w, r.h], [16, 12]);
  deepEq(r.applied, ['upscale', 'tone', 'tone']);
  assert.equal(r.px.length, 16 * 12 * 4);
  const noMask = E.runPipeline(px, 8, 6, [{ type: 'inpaint' }], {});
  deepEq(noMask.applied, ['inpaint']); deepEq(Array.from(noMask.px), Array.from(px), 'inpaint without a mask is a no-op');
});
test('every preset runs end to end on a small photo', () => {
  const w = 24, h = 24, px = solid(w, h, [200, 190, 180]);
  for (let y = 6; y < 18; y++) for (let x = 8; x < 16; x++) { const i = (y * w + x) * 4; px[i] = 60; px[i + 1] = 40; px[i + 2] = 30; }
  Object.keys(E.PRESETS).forEach((id) => {
    const r = E.runPipeline(px, w, h, E.PRESETS[id].steps, { seed: id });
    assert.equal(r.px.length, r.w * r.h * 4, id);
    assert.equal(r.applied.length, E.PRESETS[id].steps.length, id + ' applied every step');
  });
});

/* ---------- sizing, history, naming ---------- */
test('fitWithin caps the long edge and never upsizes', () => {
  deepEq(E.fitWithin(4000, 3000, 1024), { w: 1024, h: 768, scale: 0.256 });
  deepEq(E.fitWithin(300, 500, 1024), { w: 300, h: 500, scale: 1 });
});
test('history: newest first, de-duplicated by id, capped', () => {
  const job = E.buildJob('style', { preset: 'noir' }, NOW);
  const e1 = E.historyEntry(job, NOW, { w: 10, h: 10, thumb: 'data:x' });
  deepEq([e1.id, e1.tool, e1.cost, e1.thumb], [job.id, 'style', 1, 'data:x']);
  let list = E.pushHistory([], e1, 3);
  list = E.pushHistory(list, { ...e1, id: 'b' }, 3);
  list = E.pushHistory(list, { ...e1, id: 'c' }, 3);
  list = E.pushHistory(list, { ...e1, id: 'b' }, 3);
  deepEq(list.map((e) => e.id), ['b', 'c', e1.id]);
  list = E.pushHistory(list, { ...e1, id: 'd' }, 3);
  deepEq(list.map((e) => e.id), ['d', 'b', 'c']);
});
test('relTime and downloadName', () => {
  assert.equal(E.relTime(NOW - 10 * 1000, NOW), 'just now');
  assert.equal(E.relTime(NOW - 5 * E.MINUTE, NOW), '5 min ago');
  assert.equal(E.relTime(NOW - 3 * HOUR, NOW), '3 h ago');
  assert.equal(E.relTime(NOW - 2 * DAY, NOW), '2 d ago');
  assert.equal(E.downloadName({ tool: 'headshot' }, NOW), 'retouch-headshot-20261105-1330.jpg');
});

/* ---------- sample scenes ---------- */
test('sample scenes are deterministic draw lists', () => {
  deepEq(E.sampleSceneIds(), ['portrait', 'product', 'street']);
  const s = E.sampleScene('street');
  assert.ok(s.shapes.length > 15);
  deepEq(s.shapes, E.sampleScene('street').shapes);
  assert.ok(s.shapes.every((sh) => ['gradient', 'rect', 'ellipse'].includes(sh.type)));
  assert.equal(E.sampleScene('nope'), null);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { console.error('  ✗ ' + name + '\n    ' + (err && err.message)); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} retouch tests passed`);

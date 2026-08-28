#!/usr/bin/env node
/**
 * Unit tests for parrot/engine.js — the pure voice-board engine behind
 * Parrot (clip naming and validation, deterministic tile styling, sorting
 * and search, the play-all queue with shuffle/repeat, waveform peak
 * folding, and the little formatters the tiles are built from).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-parrot-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'parrot', 'engine.js'), 'utf8'), sandbox, { filename: 'parrot/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0); // 2026-08-28 12:00 UTC
const { MINUTE, HOUR, DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

const clip = (over = {}) => ({
  id: 'v1', name: 'Hello there', durationMs: 4200, bytes: 52000,
  type: 'audio/webm', ts: NOW - 2 * HOUR, plays: 0, ...over,
});

/* ---------- names ---------- */
test('cleanName trims and collapses whitespace', () => {
  assert.equal(E.cleanName('  Good   morning \n crew '), 'Good morning crew');
  assert.equal(E.cleanName(null), '');
});
test('validateName: good name passes cleaned, bad ones carry reasons', () => {
  const ok = E.validateName('  Morning  call ', []);
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'Morning call');
  assert.equal(E.validateName('', []).ok, false);
  assert.equal(E.validateName('   ', []).ok, false);
  assert.equal(E.validateName('x'.repeat(E.MAX_NAME + 1), []).ok, false);
});
test('validateName rejects duplicates case-insensitively', () => {
  const v = E.validateName('hello THERE', ['Hello there']);
  assert.equal(v.ok, false);
  assert.ok(v.reason.includes('already'), v.reason);
  assert.equal(E.validateName('Hello there 2', ['Hello there']).ok, true);
});
test('defaultName: next free Take number, case-insensitive, gap-proof', () => {
  assert.equal(E.defaultName([]), 'Take 1');
  assert.equal(E.defaultName(['Take 1', 'take 3', 'Hello']), 'Take 4');
  assert.equal(E.defaultName(['Take 007']), 'Take 8');
});
test('uniqueName: keeps a free name, numbers a taken one, falls back to Take', () => {
  assert.equal(E.uniqueName('Hello', []), 'Hello');
  assert.equal(E.uniqueName('Hello', ['Hello']), 'Hello 2');
  assert.equal(E.uniqueName('hello', ['Hello', 'Hello 2']), 'hello 3');
  assert.equal(E.uniqueName('', ['Take 1']), 'Take 2');
  const long = 'y'.repeat(60);
  const u = E.uniqueName(long, [long.slice(0, E.MAX_NAME)]);
  assert.ok(u.length <= E.MAX_NAME, `stays under the cap: ${u.length}`);
});

/* ---------- recording validation & clip records ---------- */
test('validateRecording: too short, too long, just right', () => {
  assert.equal(E.validateRecording(E.MIN_CLIP_MS - 1).ok, false);
  assert.equal(E.validateRecording(E.MIN_CLIP_MS).ok, true);
  assert.equal(E.validateRecording(E.MAX_CLIP_MS).ok, true);
  assert.equal(E.validateRecording(E.MAX_CLIP_MS + 1).ok, false);
  assert.equal(E.validateRecording(undefined).ok, false, 'no duration is too short');
});
test('makeClip: cleans fields, stamps the clock, ids are stable per input', () => {
  const c = E.makeClip({ name: ' Hello  world ', durationMs: 1234.6, bytes: 999.4, type: 'audio/webm' }, NOW);
  assert.equal(c.name, 'Hello world');
  assert.equal(c.durationMs, 1235);
  assert.equal(c.bytes, 999);
  assert.equal(c.ts, NOW);
  assert.equal(c.plays, 0);
  assert.ok(/^v[a-z0-9]+-[a-z0-9]+$/.test(c.id), c.id);
  deepEq(c, E.makeClip({ name: ' Hello  world ', durationMs: 1234.6, bytes: 999.4, type: 'audio/webm' }, NOW), 'deterministic');
});
test('makeClip: different content at the same instant gets different ids', () => {
  const a = E.makeClip({ name: 'A', durationMs: 1000, bytes: 10 }, NOW);
  const b = E.makeClip({ name: 'B', durationMs: 1000, bytes: 10 }, NOW);
  assert.notEqual(a.id, b.id);
});
test('clipStyle: stable hue and face from the id alone', () => {
  const s = E.clipStyle('v-abc');
  deepEq(s, E.clipStyle('v-abc'));
  assert.ok(s.hue >= 0 && s.hue < 360);
  assert.ok(E.FEATHERS.includes(s.emoji));
  const hues = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => E.clipStyle(id).hue));
  assert.ok(hues.size >= 4, 'ids spread across hues');
});

/* ---------- the board: sorting & search ---------- */
const BOARD = [
  clip({ id: 'a', name: 'Wake up', ts: NOW - 3 * HOUR, durationMs: 2000 }),
  clip({ id: 'b', name: 'good night', ts: NOW - 1 * HOUR, durationMs: 9000 }),
  clip({ id: 'c', name: 'Battle cry', ts: NOW - 2 * HOUR, durationMs: 5000 }),
];
test('sortClips: newest, oldest, name, longest — non-mutating, unknown mode = newest', () => {
  deepEq(E.sortClips(BOARD, 'newest').map((c) => c.id), ['b', 'c', 'a']);
  deepEq(E.sortClips(BOARD, 'oldest').map((c) => c.id), ['a', 'c', 'b']);
  deepEq(E.sortClips(BOARD, 'name').map((c) => c.id), ['c', 'b', 'a'], 'case-insensitive alphabetical');
  deepEq(E.sortClips(BOARD, 'longest').map((c) => c.id), ['b', 'c', 'a']);
  deepEq(E.sortClips(BOARD, 'nonsense').map((c) => c.id), ['b', 'c', 'a']);
  deepEq(BOARD.map((c) => c.id), ['a', 'b', 'c'], 'input untouched');
});
test('sortClips breaks ties deterministically', () => {
  const tied = [clip({ id: 'z', ts: NOW }), clip({ id: 'y', ts: NOW })];
  deepEq(E.sortClips(tied, 'newest').map((c) => c.id), ['y', 'z']);
});
test('filterClips: case-insensitive substring, blank query returns a copy of all', () => {
  deepEq(E.filterClips(BOARD, 'NIGHT').map((c) => c.id), ['b']);
  deepEq(E.filterClips(BOARD, '  cry ').map((c) => c.id), ['c']);
  deepEq(E.filterClips(BOARD, 'zzz'), []);
  const all = E.filterClips(BOARD, '');
  deepEq(all.map((c) => c.id), ['a', 'b', 'c']);
  assert.notEqual(all, BOARD, 'a copy, not the same array');
});

/* ---------- the queue ---------- */
test('buildQueue: board order untouched without shuffle', () => {
  deepEq(E.buildQueue(BOARD, {}), ['a', 'b', 'c']);
  deepEq(E.buildQueue([], {}), []);
});
test('buildQueue shuffle: same seed same deal, different seeds differ, same members', () => {
  const many = Array.from({ length: 12 }, (_, i) => clip({ id: 'q' + i }));
  const s1 = E.buildQueue(many, { shuffle: true, seed: 'deal-1' });
  deepEq(s1, E.buildQueue(many, { shuffle: true, seed: 'deal-1' }), 'deterministic');
  assert.equal(s1.length, 12);
  deepEq(s1.slice().sort(), many.map((c) => c.id).sort(), 'nothing lost, nothing invented');
  const different = ['deal-2', 'deal-3', 'deal-4'].some(
    (seed) => JSON.stringify(E.buildQueue(many, { shuffle: true, seed })) !== JSON.stringify(s1));
  assert.ok(different, 'some other seed deals another order');
});
test('stepQueue: walks forward, ends at the edge unless repeat-all wraps', () => {
  assert.equal(E.stepQueue(3, 0, 1, 'off'), 1);
  assert.equal(E.stepQueue(3, 2, 1, 'off'), -1, 'end of the board');
  assert.equal(E.stepQueue(3, 2, 1, 'all'), 0, 'repeat-all wraps');
  assert.equal(E.stepQueue(3, 0, -1, 'off'), -1);
  assert.equal(E.stepQueue(3, 0, -1, 'all'), 2, 'skip-back wraps under repeat-all');
  assert.equal(E.stepQueue(0, 0, 1, 'all'), -1, 'empty queue is always done');
});
test('stepQueue: repeat-one replays forward but still allows skipping back', () => {
  assert.equal(E.stepQueue(3, 1, 1, 'one'), 1, 'the same voice again');
  assert.equal(E.stepQueue(3, 1, -1, 'one'), 0, 'manual back still moves');
});
test('nextRepeat cycles off → all → one → off', () => {
  assert.equal(E.nextRepeat('off'), 'all');
  assert.equal(E.nextRepeat('all'), 'one');
  assert.equal(E.nextRepeat('one'), 'off');
  assert.equal(E.nextRepeat('garbage'), 'off', 'unknown resets the cycle');
});

/* ---------- waveforms & progress ---------- */
test('normalizePeaks: folds samples into buckets, loudest bucket hits 1', () => {
  const samples = [0, 0.1, -0.8, 0.2, 0.4, -0.1, 0.1, 0.05];
  const peaks = E.normalizePeaks(samples, 4);
  assert.equal(peaks.length, 4);
  assert.equal(Math.max(...peaks), 1, 'normalised to the loudest bucket');
  assert.equal(peaks[1], 1, 'the -0.8 spike lands in bucket 1');
  assert.ok(peaks.every((p) => p >= 0 && p <= 1));
});
test('normalizePeaks: empty or silent input gives flat zeros, junk-safe', () => {
  deepEq(E.normalizePeaks([], 3), [0, 0, 0]);
  deepEq(E.normalizePeaks([0, 0, 0, 0], 2), [0, 0]);
  const junk = E.normalizePeaks(['x', null, 0.5, undefined], 2);
  assert.equal(junk.length, 2);
  assert.ok(junk.every((p) => isFinite(p)));
});
test('normalizePeaks handles more buckets than samples', () => {
  const peaks = E.normalizePeaks([0.5, 1], 6);
  assert.equal(peaks.length, 6);
  assert.equal(Math.max(...peaks), 1);
});
test('pseudoPeaks: stable per id, in range, shaped like speech (louder middle)', () => {
  const p = E.pseudoPeaks('v-abc', 48);
  deepEq(p, E.pseudoPeaks('v-abc', 48));
  assert.equal(p.length, 48);
  assert.ok(p.every((v) => v >= 0 && v <= 1));
  const mid = Math.max(p[23], p[24]), edge = Math.max(p[0], p[47]);
  assert.ok(mid > edge, `envelope peaks in the middle (${mid} vs ${edge})`);
});
test('playbackProgress clamps to [0,1] and survives zero duration', () => {
  assert.equal(E.playbackProgress(2000, 4000), 0.5);
  assert.equal(E.playbackProgress(9000, 4000), 1);
  assert.equal(E.playbackProgress(-50, 4000), 0);
  assert.equal(E.playbackProgress(1000, 0), 0);
});

/* ---------- formatters & stats ---------- */
test('formatClock: m:ss, rounding, hour rollover', () => {
  assert.equal(E.formatClock(0), '0:00');
  assert.equal(E.formatClock(7400), '0:07');
  assert.equal(E.formatClock(65000), '1:05');
  assert.equal(E.formatClock(600000), '10:00');
  assert.equal(E.formatClock(3661000), '1:01:01');
  assert.equal(E.formatClock(-500), '0:00', 'never negative');
});
test('formatBytes: B, KB, MB', () => {
  assert.equal(E.formatBytes(512), '512 B');
  assert.equal(E.formatBytes(3481), '3.4 KB');
  assert.equal(E.formatBytes(1258291), '1.2 MB');
  assert.equal(E.formatBytes(0), '0 B');
});
test('timeAgo buckets', () => {
  assert.equal(E.timeAgo(NOW - 20 * 1000, NOW), 'just now');
  assert.equal(E.timeAgo(NOW - 5 * MINUTE, NOW), '5m ago');
  assert.equal(E.timeAgo(NOW - 3 * HOUR, NOW), '3h ago');
  assert.equal(E.timeAgo(NOW - 2 * DAY, NOW), '2d ago');
  assert.equal(E.timeAgo(NOW - 15 * DAY, NOW), '2w ago');
});
test('libraryStats: totals and the header label, singular and empty', () => {
  const s = E.libraryStats(BOARD);
  assert.equal(s.count, 3);
  assert.equal(s.totalMs, 16000);
  assert.equal(s.totalBytes, 156000);
  assert.equal(s.label, '3 voices · 0:16');
  assert.equal(E.libraryStats([clip()]).label, '1 voice · 0:04');
  assert.equal(E.libraryStats([]).label, 'No voices yet');
});
test('escapeHTML neutralises markup in voice names', () => {
  const out = E.escapeHTML('<img src=x onerror=1> "hi"');
  assert.ok(!out.includes('<img'));
  assert.ok(out.includes('&lt;img'));
  assert.ok(out.includes('&quot;hi&quot;'));
});
test('rand01/hashStr are stable and spread', () => {
  assert.equal(E.hashStr('parrot'), E.hashStr('parrot'));
  assert.notEqual(E.hashStr('a'), E.hashStr('b'));
  const r = E.rand01('seed-x');
  assert.equal(r, E.rand01('seed-x'));
  assert.ok(r >= 0 && r < 1);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nparrot: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

#!/usr/bin/env node
/**
 * Unit tests for bloom/engine.js — the pure social engine behind Bloom
 * (the user-owned feed ranker with per-post receipts, caught-up split,
 * heat-check nudge, transparent trending, the giving-only Garden, daily
 * Spark prompts, grouped activity and the session timekeeper).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-bloom-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'bloom', 'engine.js'), 'utf8'), sandbox, { filename: 'bloom/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0); // 2026-08-01 12:00
const { MINUTE, HOUR, DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

const post = (over = {}) => ({
  id: 'p1', authorId: 'maya', authorName: 'Maya', text: 'morning run done #running',
  ts: NOW - 2 * HOUR, audience: 'everyone', ...over,
});
const ctx = (over = {}) => ({
  myId: 'me', following: ['maya'], closeness: {}, interests: [],
  followerOf: {}, innerOf: {}, ...over,
});

/* ---------- text safety & extraction ---------- */
test('renderText escapes HTML before decorating (no injection)', () => {
  const out = E.renderText('<img src=x onerror=1> *bold* #hi');
  assert.ok(!out.includes('<img'), 'raw tag must be escaped');
  assert.ok(out.includes('&lt;img'), 'angle bracket escaped');
  assert.ok(out.includes('<strong>bold</strong>'), 'bold still applied');
  assert.ok(out.includes('data-tag="hi"'), 'hashtag still decorated');
});
test('renderText links URLs without trailing punctuation', () => {
  const out = E.renderText('see https://bloom.example/a_b, ok');
  assert.ok(out.includes('href="https://bloom.example/a_b"'), 'comma not swallowed into href');
  assert.ok(out.includes('rel="noopener noreferrer"'));
});
test('extractTags: unique, lowercased, unicode-friendly', () => {
  deepEq(E.extractTags('Go #Running and #running and #café_life!'), ['running', 'café_life']);
});
test('extractTags ignores mid-word # and &#39; entities', () => {
  deepEq(E.extractTags('x#nope and it&#39;s fine'), []);
});
test('extractMentions returns unique lowercased handles', () => {
  deepEq(E.extractMentions('hey @Maya and @maya and @jo_1'), ['maya', 'jo_1']);
});
test('validatePost rejects empty and over-length, trims', () => {
  assert.equal(E.validatePost('   ').ok, false);
  assert.equal(E.validatePost('x'.repeat(E.MAX_POST + 1)).ok, false);
  const v = E.validatePost('  hi  ');
  assert.equal(v.ok, true); assert.equal(v.text, 'hi');
});

/* ---------- the ranker & its receipts ---------- */
test('postScore: receipt parts sum to the score', () => {
  const s = E.postScore(post(), ctx({ closeness: { maya: 0.8 }, interests: ['running'] }), E.DEFAULT_WEIGHTS, NOW);
  const sum = s.reasons.reduce((a, r) => a + r.pts, 0);
  assert.ok(Math.abs(sum - s.score) < 0.15, `receipts (${sum}) ≈ score (${s.score})`);
  assert.ok(s.reasons.some((r) => r.key === 'fresh'));
  assert.ok(s.reasons.some((r) => r.key === 'close'));
  assert.ok(s.reasons.some((r) => r.key === 'follow'));
  assert.ok(s.reasons.some((r) => r.key === 'interest'));
});
test('fresh slider: newer beats older, more so at high fresh', () => {
  const newer = post({ id: 'a', ts: NOW - 1 * HOUR });
  const older = post({ id: 'b', ts: NOW - 30 * HOUR });
  const hi = { ...E.DEFAULT_WEIGHTS, fresh: 100 };
  const sNew = E.postScore(newer, ctx(), hi, NOW).score;
  const sOld = E.postScore(older, ctx(), hi, NOW).score;
  assert.ok(sNew > sOld, 'newer scores higher');
});
test('close slider: someone you interact with outranks a stranger', () => {
  const friendPost = post({ id: 'f', authorId: 'maya' });
  const strangerPost = post({ id: 's', authorId: 'zed', authorName: 'Zed' });
  const c = ctx({ closeness: { maya: 0.9 }, following: [] });
  const w = { fresh: 0, close: 80, spark: 0, calm: 0 };
  assert.ok(E.postScore(friendPost, c, w, NOW).score > E.postScore(strangerPost, c, w, NOW).score);
});
test('calm slider: heated post sinks, and the receipt says so', () => {
  const hot = post({ id: 'h', text: 'You people are all IDIOTS AND LOSERS!!! ABSOLUTE TRASH' });
  const s = E.postScore(hot, ctx({ following: [] }), { fresh: 0, close: 0, spark: 0, calm: 100 }, NOW);
  assert.ok(s.score < 0, 'net negative under max calm');
  assert.ok(s.reasons.some((r) => r.key === 'calm' && r.pts < 0), 'receipt shows the deduction');
});
test('spark is deterministic within a day and only for non-followed authors', () => {
  const stranger = post({ id: 'lucky-1', authorId: 'zed' });
  const w = { fresh: 0, close: 0, spark: 100, calm: 0 };
  const a = E.postScore(stranger, ctx({ following: [] }), w, NOW);
  const b = E.postScore(stranger, ctx({ following: [] }), w, NOW + 5 * MINUTE);
  deepEq(a.reasons, b.reasons, 'same luck all day');
  const followed = E.postScore(stranger, ctx({ following: ['zed'] }), w, NOW);
  assert.ok(!followed.reasons.some((r) => r.key === 'spark'), 'no spark for people you follow');
});
test('rankFeed sorts by score then recency; chrono mode is purely newest-first', () => {
  const posts = [
    post({ id: 'old-friend', ts: NOW - 20 * HOUR, authorId: 'maya' }),
    post({ id: 'new-stranger', ts: NOW - 10 * MINUTE, authorId: 'zed', authorName: 'Zed' }),
  ];
  const c = ctx({ closeness: { maya: 1 }, following: ['maya'] });
  const ranked = E.rankFeed(posts, c, { fresh: 10, close: 100, spark: 0, calm: 0 }, NOW);
  assert.equal(ranked[0].post.id, 'old-friend', 'closeness outweighs recency at these weights');
  const chrono = E.rankFeed(posts, c, { chrono: true }, NOW);
  assert.equal(chrono[0].post.id, 'new-stranger', 'chrono = newest first');
  assert.equal(chrono[0].reasons[0].key, 'chrono');
});
test('rankFeed filters posts the viewer has no audience for', () => {
  const posts = [
    post({ id: 'pub' }),
    post({ id: 'inner-only', authorId: 'zed', audience: 'inner' }),
  ];
  const ranked = E.rankFeed(posts, ctx(), E.DEFAULT_WEIGHTS, NOW);
  deepEq(ranked.map((r) => r.post.id), ['pub']);
});

/* ---------- circles ---------- */
test('audienceCan: everyone / followers / inner / author', () => {
  const p = post({ authorId: 'zed', audience: 'followers' });
  assert.equal(E.audienceCan(p, 'me', { followerOf: {} }), false);
  assert.equal(E.audienceCan(p, 'me', { followerOf: { zed: true } }), true);
  assert.equal(E.audienceCan(post({ authorId: 'zed', audience: 'inner' }), 'me', { innerOf: { zed: true } }), true);
  assert.equal(E.audienceCan(post({ authorId: 'me', audience: 'inner' }), 'me', {}), true, 'author always sees their own');
  assert.equal(E.audienceCan(post({ audience: 'everyone' }), 'anyone', {}), true);
});

/* ---------- caught up ---------- */
test('caughtUpSplit divides at the last visit', () => {
  const items = [
    { post: post({ id: 'n', ts: NOW - 1 * HOUR }) },
    { post: post({ id: 'o', ts: NOW - 30 * HOUR }) },
  ];
  const s = E.caughtUpSplit(items, NOW - 2 * HOUR);
  deepEq(s.fresh.map((i) => i.post.id), ['n']);
  deepEq(s.older.map((i) => i.post.id), ['o']);
});
test('caughtUpSplit with no last visit treats everything as fresh', () => {
  const s = E.caughtUpSplit([{ post: post() }], 0);
  assert.equal(s.fresh.length, 1);
});

/* ---------- heat check ---------- */
test('heatCheck: calm text passes clean', () => {
  const h = E.heatCheck('Congratulations, this is wonderful news! So happy for you.');
  assert.equal(h.level, 0);
  assert.equal(h.suggestion, null);
});
test('heatCheck: name-calling raises level with a reason', () => {
  const h = E.heatCheck('what an idiot take');
  assert.ok(h.level >= 1);
  assert.ok(h.reasons.some((r) => r.includes('name-calling')));
});
test('heatCheck: pile-on (insults + caps + !!!) reaches level 2', () => {
  const h = E.heatCheck('YOU PEOPLE ARE PATHETIC LOSERS AND FOOLS!!!');
  assert.equal(h.level, 2);
  assert.ok(h.suggestion && h.suggestion.length > 10);
});
test('heatCheck: enthusiasm alone (caps in short text) is not flagged', () => {
  assert.equal(E.heatCheck('GOAL!!').level, 0);
});

/* ---------- trending ---------- */
test('trendingTopics: fresher tags outrank stale ones at equal volume', () => {
  const posts = [
    post({ id: 't1', text: 'a #now', ts: NOW - 1 * HOUR }),
    post({ id: 't2', text: 'b #now', ts: NOW - 2 * HOUR, authorId: 'b' }),
    post({ id: 't3', text: 'c #then', ts: NOW - 40 * HOUR, authorId: 'c' }),
    post({ id: 't4', text: 'd #then', ts: NOW - 44 * HOUR, authorId: 'd' }),
  ];
  const tr = E.trendingTopics(posts, NOW, { limit: 5 });
  assert.equal(tr[0].tag, 'now');
  assert.ok(tr[0].score > tr[1].score);
  assert.equal(tr[0].posts, 2);
  assert.equal(tr[0].voices, 2, 'distinct authors counted');
});
test('trendingTopics never counts non-public posts', () => {
  const tr = E.trendingTopics([post({ text: 'secret #leak', audience: 'inner' })], NOW, {});
  deepEq(tr, []);
});

/* ---------- the Garden ---------- */
test('givingScore weighs comments > posts > reactions', () => {
  assert.equal(E.givingScore({ commentsGiven: 1 }), 4);
  assert.equal(E.givingScore({ postsMade: 1 }), 2);
  assert.equal(E.givingScore({ reactionsGiven: 1 }), 1);
  assert.equal(E.givingScore({}), 0);
});
test('gardenStage: thresholds, progress and next stage', () => {
  const seed = E.gardenStage(0);
  assert.equal(seed.name, 'Seed');
  assert.equal(seed.next.name, 'Sprout');
  const bloom = E.gardenStage(100);
  assert.equal(bloom.name, 'Bloom');
  const grove = E.gardenStage(9999);
  assert.equal(grove.name, 'Grove');
  assert.equal(grove.next, null);
  const mid = E.gardenStage(20); // Sprout(10) → Seedling(30)
  assert.equal(mid.name, 'Sprout');
  assert.ok(Math.abs(mid.progress - 0.5) < 1e-9);
  assert.equal(mid.next.needed, 10);
});
test('gardenStage is monotonic in score', () => {
  let last = -1;
  for (const s of [0, 5, 10, 29, 30, 59, 60, 99, 100, 179, 180, 299, 300]) {
    const idx = E.GARDEN.findIndex((g) => g.name === E.gardenStage(s).name);
    assert.ok(idx >= last, `stage never regresses (score ${s})`);
    last = idx;
  }
});

/* ---------- Spark ---------- */
test('sparkPrompt: stable for a date, varies across dates, always from the list', () => {
  const a = E.sparkPrompt('2026-08-01');
  const b = E.sparkPrompt('2026-08-01');
  deepEq(a, b);
  assert.ok(E.PROMPTS.includes(a.prompt));
  const seen = new Set();
  for (let d = 1; d <= 16; d++) seen.add(E.sparkPrompt('2026-08-' + String(d).padStart(2, '0')).prompt);
  assert.ok(seen.size >= 5, 'prompts rotate across days');
});

/* ---------- activity grouping ---------- */
test('groupActivity collapses same type+target into one humane line', () => {
  const ev = (over) => ({ type: 'react', targetId: 'p1', actorId: 'a', actorName: 'Ana', ts: NOW, emoji: '💛', ...over });
  const groups = E.groupActivity([
    ev({}), ev({ actorId: 'b', actorName: 'Ben', ts: NOW - 10 * MINUTE }),
    ev({ actorId: 'c', actorName: 'Cy', ts: NOW - 20 * MINUTE }),
    ev({ type: 'comment', actorId: 'b', actorName: 'Ben', ts: NOW - 5 * MINUTE }),
  ], NOW);
  assert.equal(groups.length, 2);
  const react = groups.find((g) => g.type === 'react');
  assert.equal(react.actors.length, 3);
  assert.ok(react.text.includes('Ana and 2 others'), react.text);
  const comment = groups.find((g) => g.type === 'comment');
  assert.ok(comment.text.includes('Ben commented'));
});
test('groupActivity: same actor twice counts once in the actor list', () => {
  const groups = E.groupActivity([
    { type: 'react', targetId: 'p1', actorId: 'a', actorName: 'Ana', ts: NOW },
    { type: 'react', targetId: 'p1', actorId: 'a', actorName: 'Ana', ts: NOW - MINUTE },
  ], NOW);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].actors.length, 1);
  assert.equal(groups[0].text, 'Ana reacted 💛 to your post');
});
test('groupActivity: events far apart stay separate groups', () => {
  const groups = E.groupActivity([
    { type: 'react', targetId: 'p1', actorId: 'a', actorName: 'Ana', ts: NOW },
    { type: 'react', targetId: 'p1', actorId: 'b', actorName: 'Ben', ts: NOW - 10 * HOUR },
  ], NOW);
  assert.equal(groups.length, 2);
});

/* ---------- timekeeper & formatters ---------- */
test('sessionAdvice: silent, gentle, firm', () => {
  assert.equal(E.sessionAdvice(5 * MINUTE).level, 0);
  const g = E.sessionAdvice(25 * MINUTE);
  assert.equal(g.level, 1);
  assert.ok(g.msg.includes('25 minutes'));
  assert.equal(E.sessionAdvice(45 * MINUTE).level, 2);
});
test('formatCount: 0, hundreds, k, m', () => {
  assert.equal(E.formatCount(0), '0');
  assert.equal(E.formatCount(999), '999');
  assert.equal(E.formatCount(1234), '1.2k');
  assert.equal(E.formatCount(3400000), '3.4m');
});
test('timeAgo buckets', () => {
  assert.equal(E.timeAgo(NOW - 20 * 1000, NOW), 'just now');
  assert.equal(E.timeAgo(NOW - 5 * MINUTE, NOW), '5m ago');
  assert.equal(E.timeAgo(NOW - 3 * HOUR, NOW), '3h ago');
  assert.equal(E.timeAgo(NOW - 2 * DAY, NOW), '2d ago');
  assert.equal(E.timeAgo(NOW - 15 * DAY, NOW), '2w ago');
});

/* ---------- closeness ---------- */
test('closenessMap: saturating, comments weigh double, bounded by 1', () => {
  const one = E.closenessMap([{ authorId: 'a', kind: 'react' }]).a;
  const chat = E.closenessMap([{ authorId: 'a', kind: 'comment' }]).a;
  assert.ok(chat > one, 'comment > reaction');
  const many = E.closenessMap(Array.from({ length: 200 }, () => ({ authorId: 'a', kind: 'comment' }))).a;
  assert.ok(many <= 1, 'saturates at 1');
  assert.ok(many > 0.99);
});
test('rand01/hashStr are stable and spread', () => {
  assert.equal(E.hashStr('bloom'), E.hashStr('bloom'));
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
console.log(`\nbloom: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

#!/usr/bin/env node
/**
 * Unit tests for glimpse/engine.js — the pure "what the world is seeing"
 * engine behind Glimpse (geo distance/bearing, solar time-of-day, the
 * globe-hopping world feed, the near feed, world map cells, the passport
 * and horizon stages, daily prompts and the seeded demo world).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-glimpse-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'glimpse', 'engine.js'), 'utf8'), sandbox, { filename: 'glimpse/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0); // 2026-08-14 12:00 UTC
const { MINUTE, HOUR, DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

const TOKYO = E.placeByName('Tokyo');
const LONDON = E.placeByName('London');
const PARIS = E.placeByName('Paris');
const glimpse = (over = {}) => ({
  id: 'g1', authorId: 'kenji', authorName: 'Kenji', caption: 'the station tree #spring',
  place: { name: 'Tokyo', country: 'Japan', cc: 'JP', flag: '🇯🇵', lat: TOKYO.lat, lon: TOKYO.lon },
  scene: { emoji: '🌸' }, ts: NOW - 2 * HOUR, reactions: {}, ...over,
});

/* ---------- text safety & extraction ---------- */
test('renderCaption escapes HTML before decorating (no injection)', () => {
  const out = E.renderCaption('<img src=x onerror=1> look #sky');
  assert.ok(!out.includes('<img'), 'raw tag must be escaped');
  assert.ok(out.includes('&lt;img'), 'angle bracket escaped');
  assert.ok(out.includes('data-tag="sky"'), 'hashtag still decorated');
});
test('renderCaption links URLs without swallowing trailing punctuation', () => {
  const out = E.renderCaption('view https://glimpse.example/win, wow');
  assert.ok(out.includes('href="https://glimpse.example/win"'));
  assert.ok(out.includes('rel="noopener noreferrer"'));
});
test('extractTags: unique, lowercased, unicode-friendly, ignores entities', () => {
  deepEq(E.extractTags('Go #Sunset and #sunset and #café_view!'), ['sunset', 'café_view']);
  deepEq(E.extractTags('x#nope and it&#39;s fine'), []);
});

/* ---------- accounts & glimpse validation ---------- */
test('validateAccount: good input passes, handle normalised', () => {
  const v = E.validateAccount({ name: '  Rafa ', handle: '@Rafa_28', email: 'rafa@example.com', password: 'longenough' });
  assert.equal(v.ok, true);
  assert.equal(v.name, 'Rafa');
  assert.equal(v.handle, 'rafa_28');
});
test('validateAccount rejects bad email, short password, bad handle, empty name', () => {
  const v = E.validateAccount({ name: '', handle: 'a b!', email: 'nope', password: 'short' });
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 4);
});
test('validateGlimpse: caption+place passes and is cleaned', () => {
  const v = E.validateGlimpse({ caption: '  the harbour  ', place: TOKYO });
  assert.equal(v.ok, true);
  assert.equal(v.caption, 'the harbour');
  assert.equal(v.place.cc, 'JP');
});
test('validateGlimpse: photo alone is enough, caption alone is enough, neither is not', () => {
  assert.equal(E.validateGlimpse({ photo: 'data:image/jpeg;base64,x', place: TOKYO }).ok, true);
  assert.equal(E.validateGlimpse({ caption: 'words', place: TOKYO }).ok, true);
  assert.equal(E.validateGlimpse({ caption: '   ', place: TOKYO }).ok, false);
});
test('validateGlimpse: over-length caption and bad coordinates rejected', () => {
  assert.equal(E.validateGlimpse({ caption: 'x'.repeat(E.MAX_CAPTION + 1), place: TOKYO }).ok, false);
  assert.equal(E.validateGlimpse({ caption: 'hi', place: { name: 'Nowhere', lat: 99, lon: 0 } }).ok, false);
  assert.equal(E.validateGlimpse({ caption: 'hi', place: { name: '', lat: 0, lon: 0 } }).ok, false);
  assert.equal(E.validateGlimpse({ caption: 'hi' }).ok, false, 'no place at all');
});

/* ---------- geography ---------- */
test('haversineKm: London→Paris ≈ 344 km, symmetric, zero to itself', () => {
  const d = E.haversineKm(LONDON, PARIS);
  assert.ok(Math.abs(d - 344) < 15, `got ${d}`);
  assert.ok(Math.abs(d - E.haversineKm(PARIS, LONDON)) < 1e-9);
  assert.equal(E.haversineKm(TOKYO, TOKYO), 0);
});
test('haversineKm: London→Tokyo ≈ 9,560 km (long haul sanity)', () => {
  const d = E.haversineKm(LONDON, TOKYO);
  assert.ok(Math.abs(d - 9560) < 120, `got ${d}`);
});
test('bearingDeg + compassDir: London→Paris points SE-ish, north pole is N', () => {
  const b = E.bearingDeg(LONDON, PARIS);
  assert.ok(b > 100 && b < 170, `got ${b}`);
  assert.equal(E.compassDir(b), 'SE');
  assert.equal(E.compassDir(E.bearingDeg(LONDON, { lat: 89, lon: -0.13 })), 'N');
  assert.equal(E.compassDir(359), 'N');
  assert.equal(E.compassDir(226), 'SW');
});
test('formatKm: metres, whole km, thousands separator', () => {
  assert.equal(E.formatKm(0.8), '800 m');
  assert.equal(E.formatKm(42.4), '42 km');
  assert.equal(E.formatKm(9560), '9,560 km');
});

/* ---------- solar time ---------- */
test('solarHour: Greenwich noon is 12, Tokyo (+139.69°) is evening, wraps 0..24', () => {
  const noonUTC = Date.UTC(2026, 7, 14, 12, 0, 0);
  assert.ok(Math.abs(E.solarHour(0, noonUTC) - 12) < 1e-9);
  const tokyoH = E.solarHour(TOKYO.lon, noonUTC);
  assert.ok(tokyoH > 20 && tokyoH < 22.5, `got ${tokyoH}`); // ~21:19 solar
  const h = E.solarHour(-179, Date.UTC(2026, 7, 14, 23, 0, 0));
  assert.ok(h >= 0 && h < 24);
});
test('timeOfDay buckets: dawn/day/dusk/night boundaries', () => {
  assert.equal(E.timeOfDay(5).key, 'dawn');
  assert.equal(E.timeOfDay(7.9).key, 'dawn');
  assert.equal(E.timeOfDay(8).key, 'day');
  assert.equal(E.timeOfDay(16.9).key, 'day');
  assert.equal(E.timeOfDay(17).key, 'dusk');
  assert.equal(E.timeOfDay(20.9).key, 'dusk');
  assert.equal(E.timeOfDay(21).key, 'night');
  assert.equal(E.timeOfDay(3).key, 'night');
  assert.equal(E.timeOfDay(-1).key, 'night', 'negative hours wrap');
});
test('timeOfDayAt: at 12:00 UTC London is day and Tokyo is night-ish evening', () => {
  assert.equal(E.timeOfDayAt(LONDON.lon, NOW).key, 'day');
  const tokyo = E.timeOfDayAt(TOKYO.lon, NOW).key;
  assert.ok(tokyo === 'night' || tokyo === 'dusk', `got ${tokyo}`);
});

/* ---------- the world feed ---------- */
test('worldFeed: freshest glimpse leads', () => {
  const feed = E.worldFeed([
    glimpse({ id: 'a', ts: NOW - 1 * HOUR }),
    glimpse({ id: 'b', ts: NOW - 9 * HOUR, authorId: 'x' }),
  ], {}, NOW);
  assert.equal(feed[0].glimpse.id, 'a');
});
test('worldFeed hops countries: an older window from elsewhere beats the second from the same country', () => {
  const feed = E.worldFeed([
    glimpse({ id: 'jp1', ts: NOW - 1 * HOUR, authorId: 'a1' }),
    glimpse({ id: 'jp2', ts: NOW - 2 * HOUR, authorId: 'a2' }),
    glimpse({ id: 'fr1', ts: NOW - 20 * HOUR, authorId: 'a3',
      place: { name: 'Paris', country: 'France', cc: 'FR', flag: '🇫🇷', lat: PARIS.lat, lon: PARIS.lon } }),
  ], {}, NOW);
  deepEq(feed.map((f) => f.glimpse.id), ['jp1', 'fr1', 'jp2'], 'the scroll leaves Japan before returning');
});
test('worldFeed: same author sinks harder than same country', () => {
  const feed = E.worldFeed([
    glimpse({ id: 'k1', ts: NOW - 1 * HOUR, authorId: 'kenji' }),
    glimpse({ id: 'k2', ts: NOW - 1.2 * HOUR, authorId: 'kenji' }),
    glimpse({ id: 'j2', ts: NOW - 6 * HOUR, authorId: 'other' }),
  ], {}, NOW);
  assert.equal(feed[0].glimpse.id, 'k1');
  assert.equal(feed[1].glimpse.id, 'j2', 'a different voice from the same city beats the same voice again');
});
test('worldFeed is deterministic and carries receipts', () => {
  const posts = [glimpse({ id: 'a' }), glimpse({ id: 'b', authorId: 'z', ts: NOW - 5 * HOUR })];
  const f1 = E.worldFeed(posts, {}, NOW);
  const f2 = E.worldFeed(posts, {}, NOW);
  deepEq(f1, f2);
  assert.ok(f1[0].reasons.some((r) => r.key === 'fresh'));
  assert.ok(f1[0].reasons.some((r) => r.key === 'hop'), 'first window from a country is a hop');
});
test('worldFeed: new-horizon receipt only for countries the passport lacks', () => {
  const posts = [glimpse({ id: 'a' })];
  const unseen = E.worldFeed(posts, { seenCC: {} }, NOW);
  assert.ok(unseen[0].reasons.some((r) => r.key === 'new-horizon'));
  const seen = E.worldFeed(posts, { seenCC: { JP: { flag: '🇯🇵', country: 'Japan' } } }, NOW);
  assert.ok(!seen[0].reasons.some((r) => r.key === 'new-horizon'));
});
test('worldFeed respects limit', () => {
  const many = Array.from({ length: 30 }, (_, i) => glimpse({ id: 'g' + i, ts: NOW - i * HOUR }));
  assert.equal(E.worldFeed(many, { limit: 7 }, NOW).length, 7);
});
test('feedHops: labels the jump between countries, silent within one', () => {
  const items = E.worldFeed([
    glimpse({ id: 'jp1', ts: NOW - 1 * HOUR, authorId: 'a1' }),
    glimpse({ id: 'fr1', ts: NOW - 2 * HOUR, authorId: 'a3',
      place: { name: 'Paris', country: 'France', cc: 'FR', flag: '🇫🇷', lat: PARIS.lat, lon: PARIS.lon } }),
  ], {}, NOW);
  const hops = E.feedHops(items);
  assert.equal(hops[0], null, 'first item has no hop');
  assert.ok(hops[1], 'country change gets a hop');
  assert.ok(hops[1].label.includes('km'), hops[1].label);
  assert.ok(hops[1].km > 9000, 'Tokyo→Paris is a long haul');
  const sameCountry = E.feedHops([{ glimpse: glimpse({ id: 'x' }) }, { glimpse: glimpse({ id: 'y' }) }]);
  assert.equal(sameCountry[1], null);
});

/* ---------- the near feed ---------- */
test('nearFeed sorts by distance and labels direction', () => {
  const here = LONDON;
  const near = E.nearFeed([
    glimpse({ id: 'tokyo' }),
    glimpse({ id: 'paris', place: { name: 'Paris', country: 'France', cc: 'FR', flag: '🇫🇷', lat: PARIS.lat, lon: PARIS.lon } }),
    glimpse({ id: 'home', place: { name: 'London', country: 'UK', cc: 'GB', flag: '🇬🇧', lat: LONDON.lat, lon: LONDON.lon } }),
  ], here, NOW);
  deepEq(near.map((n) => n.glimpse.id), ['home', 'paris', 'tokyo']);
  assert.equal(near[0].distanceLabel, 'right around you');
  assert.ok(near[1].distanceLabel.includes('SE of you'), near[1].distanceLabel);
});

/* ---------- the world map ---------- */
test('worldMapCells: places land in the right cells with counts and freshest scene', () => {
  const map = E.worldMapCells([
    glimpse({ id: 'a', ts: NOW - 3 * HOUR, scene: { emoji: '🌸' } }),
    glimpse({ id: 'b', ts: NOW - 1 * HOUR, scene: { emoji: '🏮' } }),
    glimpse({ id: 'c', place: { name: 'Rio de Janeiro', country: 'Brazil', cc: 'BR', flag: '🇧🇷', lat: -22.91, lon: -43.17 }, scene: { emoji: '🏖️' } }),
  ], 12, 6, NOW);
  assert.equal(map.cols, 12);
  assert.equal(map.cells.length, 2, 'two occupied cells');
  const tokyoCell = map.cells.find((c) => c.count === 2);
  assert.ok(tokyoCell, 'both Tokyo glimpses share a cell');
  assert.equal(tokyoCell.emoji, '🏮', 'freshest scene wins the cell');
  assert.equal(tokyoCell.x, Math.floor((TOKYO.lon + 180) / 360 * 12));
  assert.equal(tokyoCell.y, Math.floor((90 - TOKYO.lat) / 180 * 6));
  const rioCell = map.cells.find((c) => c.count === 1);
  assert.ok(rioCell.y > tokyoCell.y, 'southern hemisphere sits lower on the map');
  assert.ok(tokyoCell.tod && tokyoCell.tod.key, 'cell knows its time of day');
});
test('worldMapCells clamps the antimeridian and poles into the grid', () => {
  const edge = E.worldMapCells([
    glimpse({ id: 'e', place: { name: 'Edge', country: 'X', cc: 'X', lat: 90, lon: 180 } }),
  ], 12, 6, NOW);
  assert.equal(edge.cells.length, 1);
  assert.equal(edge.cells[0].x, 11);
  assert.equal(edge.cells[0].y, 0);
});
test('sunStrip covers every column with a valid time of day', () => {
  const strip = E.sunStrip(12, NOW);
  assert.equal(strip.length, 12);
  assert.ok(strip.every((t) => ['dawn', 'day', 'dusk', 'night'].includes(t.key)));
  const keys = new Set(strip.map((t) => t.key));
  assert.ok(keys.size >= 2, 'somewhere it is day and somewhere it is not');
});

/* ---------- passport & horizon ---------- */
test('passport lists collected countries sorted by name', () => {
  const list = E.passport({ JP: { flag: '🇯🇵', country: 'Japan' }, BR: { flag: '🇧🇷', country: 'Brazil' } });
  deepEq(list.map((c) => c.cc), ['BR', 'JP']);
  assert.equal(list[1].flag, '🇯🇵');
});
test('horizonStage: thresholds, progress and next stage', () => {
  const sill = E.horizonStage(0);
  assert.equal(sill.name, 'Windowsill');
  assert.equal(sill.next.name, 'First Light');
  const mid = E.horizonStage(4); // Wanderer(3) → Pathfinder(6)
  assert.equal(mid.name, 'Wanderer');
  assert.ok(Math.abs(mid.progress - 1 / 3) < 1e-9);
  assert.equal(mid.next.needed, 2);
  const top = E.horizonStage(99);
  assert.equal(top.name, 'Worldeye');
  assert.equal(top.next, null);
});
test('horizonStage is monotonic in countries seen', () => {
  let last = -1;
  for (const n of [0, 1, 2, 3, 5, 6, 11, 12, 19, 20, 50]) {
    const idx = E.HORIZONS.findIndex((h) => h.name === E.horizonStage(n).name);
    assert.ok(idx >= last, `stage never regresses (n=${n})`);
    last = idx;
  }
});

/* ---------- finding people ---------- */
const USERS = [
  { id: 'kenji', name: 'Kenji', handle: 'kenji_sees', avatar: '🍜' },
  { id: 'ken', name: 'Ken Adams', handle: 'ken', avatar: '🎸' },
  { id: 'maya', name: 'Maya', handle: 'maya_nyc', avatar: '🗽' },
  { id: 'z', name: 'Zed Kenwright', handle: 'zed', avatar: '🦉' },
];
test('searchUsers: exact handle beats prefix beats substring', () => {
  const r = E.searchUsers('ken', USERS);
  deepEq(r.map((x) => x.user.id), ['ken', 'kenji', 'z'], 'exact > prefix > name-word');
  assert.equal(r[0].score, 100);
  assert.ok(r[0].score > r[1].score && r[1].score > r[2].score);
});
test('searchUsers: @-prefixed query restricts matching to handles', () => {
  const r = E.searchUsers('@ken', USERS);
  deepEq(r.map((x) => x.user.id), ['ken', 'kenji'], 'name-only matches drop out');
  assert.ok(r.every((x) => x.match === 'handle'));
});
test('searchUsers: case-insensitive, trims, empty query returns nothing', () => {
  deepEq(E.searchUsers('  KENJI_SEES ', USERS).map((x) => x.user.id), ['kenji']);
  deepEq(E.searchUsers('', USERS), []);
  deepEq(E.searchUsers('   ', USERS), []);
  deepEq(E.searchUsers('zzz-no-match', USERS), []);
});
test('searchUsers: deterministic order, alphabetical tiebreak, respects limit', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: 'u' + i, name: 'Same Name', handle: 'h' + (8 - i) }));
  const r = E.searchUsers('same', many, { limit: 4 });
  assert.equal(r.length, 4);
  deepEq(r.map((x) => x.user.handle), ['h0', 'h1', 'h2', 'h3'], 'equal scores sort by handle');
  deepEq(E.searchUsers('same', many, { limit: 4 }), r, 'stable across calls');
});

/* ---------- daily prompt ---------- */
test('dailyPrompt: stable for a date, rotates across dates, always from the list', () => {
  const a = E.dailyPrompt('2026-08-14');
  deepEq(a, E.dailyPrompt('2026-08-14'));
  assert.ok(E.PROMPTS.includes(a.prompt));
  const seen = new Set();
  for (let d = 1; d <= 16; d++) seen.add(E.dailyPrompt('2026-08-' + String(d).padStart(2, '0')).prompt);
  assert.ok(seen.size >= 5, 'prompts rotate across days');
});

/* ---------- formatters & hashing ---------- */
test('formatCount and timeAgo buckets', () => {
  assert.equal(E.formatCount(999), '999');
  assert.equal(E.formatCount(1234), '1.2k');
  assert.equal(E.formatCount(3400000), '3.4m');
  assert.equal(E.timeAgo(NOW - 20 * 1000, NOW), 'just now');
  assert.equal(E.timeAgo(NOW - 5 * MINUTE, NOW), '5m ago');
  assert.equal(E.timeAgo(NOW - 3 * HOUR, NOW), '3h ago');
  assert.equal(E.timeAgo(NOW - 2 * DAY, NOW), '2d ago');
  assert.equal(E.timeAgo(NOW - 15 * DAY, NOW), '2w ago');
});
test('rand01/hashStr are stable and spread', () => {
  assert.equal(E.hashStr('glimpse'), E.hashStr('glimpse'));
  assert.notEqual(E.hashStr('a'), E.hashStr('b'));
  const r = E.rand01('seed-x');
  assert.equal(r, E.rand01('seed-x'));
  assert.ok(r >= 0 && r < 1);
});

/* ---------- the demo world ---------- */
test('seedWorld is deterministic and well-formed', () => {
  const w1 = E.seedWorld('seed-1', NOW);
  const w2 = E.seedWorld('seed-1', NOW);
  deepEq(w1, w2);
  assert.ok(w1.length >= E.PERSONAS.length * 2, 'at least two glimpses per persona');
  for (const g of w1) {
    assert.ok(g.place && isFinite(g.place.lat) && isFinite(g.place.lon), 'every glimpse has coordinates');
    assert.ok(g.ts <= NOW && g.ts > NOW - 40 * HOUR, 'timestamps within the demo window');
    assert.ok(E.validateGlimpse(g).ok, 'every demo glimpse passes validation');
    assert.ok(['dawn', 'day', 'dusk', 'night'].includes(g.scene.tod), 'scene knows its sky');
  }
  const w3 = E.seedWorld('seed-2', NOW);
  assert.notEqual(JSON.stringify(w1), JSON.stringify(w3), 'different seed, different world');
});
test('seedWorld spans many countries (the demo feed can actually hop)', () => {
  const ccs = new Set(E.seedWorld('s', NOW).map((g) => g.place.cc));
  assert.ok(ccs.size >= 8, `got ${ccs.size}`);
});
test('seedWorld sorts newest-first', () => {
  const w = E.seedWorld('s', NOW);
  for (let i = 1; i < w.length; i++) assert.ok(w[i - 1].ts >= w[i].ts);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nglimpse: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

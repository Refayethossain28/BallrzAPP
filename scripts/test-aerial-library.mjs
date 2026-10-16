#!/usr/bin/env node
// Tests for the LIBRARY section of the Aerial engine: the immutable reducers behind favourites, recents,
// resume positions, subscriptions, the play queue, settings, the sleep timer, localStorage (de)serialisation,
// export/import merging, lock-screen metadata and share links. Every input is deep-frozen so a reducer that
// mutates its argument throws; caps, eviction order, validation branches and a junk sweep are tabled.
// Run: node scripts/test-aerial-library.mjs
import * as __fs from 'node:fs';
import * as __url from 'node:url';
import * as __path from 'node:path';
import * as __vm from 'node:vm';
import __assert from 'node:assert/strict';

// The engine is a classic script (the repo is type:module), so load it in a vm sandbox and
// read the module.exports it sets — the same way every prototype test in this repo does.
const __ROOT = __path.join(__path.dirname(__url.fileURLToPath(import.meta.url)), '..');
function loadEngine() {
  const sandbox = { module: { exports: {} }, TextEncoder, TextDecoder, console };
  sandbox.self = sandbox;
  __vm.createContext(sandbox);
  __vm.runInContext(__fs.readFileSync(__path.join(__ROOT, 'aerial', 'engine.js'), 'utf8'), sandbox, { filename: 'aerial/engine.js' });
  return sandbox.module.exports;
}
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => __assert.equal(JSON.stringify(a), JSON.stringify(b), m);
function runner(name) {
  const tests = [];
  const test = (n, f) => tests.push([n, f]);
  const run = () => {
    let passed = 0, failed = 0;
    for (const [n, f] of tests) {
      try { f(); passed++; console.log(`  ✓ ${n}`); }
      catch (e) { failed++; console.log(`  ✗ ${n}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`); }
    }
    console.log(`\n${name}: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  };
  return { test, run, assert: __assert };
}
const E = loadEngine();
const { test, run, assert } = runner('library');
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60 * 1000;
const T = (m) => NOW + m * MIN;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach((k) => deepFreeze(o[k])); }
  return o;
}
const F = deepFreeze;
const J = (x) => JSON.parse(JSON.stringify(x));
const keysOf = (list) => list.map(E.libraryItemKey);

/* ---------- fixtures: the shapes RADIO / PODCAST / the UI hand to the library ---------- */
const FEED = 'https://feeds.example.com/show.xml';
const STATION = F({
  type: 'radio', id: '960b4e0b-0601-11e8-ae97-52543be04c81', name: 'SomaFM: Groove Salad', url: 'https://ice1.somafm.com/groovesalad-128-mp3',
  homepage: 'https://somafm.com/groovesalad/', favicon: 'https://somafm.com/img3/groovesalad-400.jpg',
  tags: ['ambient', 'chillout', 'downtempo', 'electronic'], country: 'The United States Of America', countryCode: 'US', state: 'California',
  language: 'english', languages: ['english'], codec: 'MP3', bitrate: 128, votes: 12345, clicks: 4567, clickTrend: 12,
  https: true, hls: false, ok: true, geo: { lat: 37.77, lon: -122.42 }
});
const STATION_HLS = F({ type: 'radio', id: 'hls-1', name: 'BBC Radio 4', url: 'https://as-hls.example.net/radio4/live', codec: 'AAC', bitrate: 96, hls: true, country: 'The United Kingdom', tags: 'news,talk,bbc' });
const SHOW = F({ type: 'show', id: '123456', title: 'Lingthusiasm', author: 'Gretchen McCulloch and Lauren Gawne', feedUrl: FEED, image: 'https://img.example.com/ling.jpg', genre: 'Science', episodeCount: 100, link: 'https://lingthusiasm.com' });
const EP = (n, extra) => Object.assign({
  type: 'podcast', id: 'guid-' + n, title: 'Episode ' + n, description: 'Long show notes '.repeat(50), url: 'https://cdn.example.com/ep' + n + '.mp3',
  length: 50_000_000, duration: 3600, published: Date.UTC(2026, 8, n), image: '', link: 'https://lingthusiasm.com/ep' + n, season: 1, episode: n, explicit: false,
  feedUrl: FEED, show: { title: 'Lingthusiasm', feedUrl: FEED, image: 'https://img.example.com/ling.jpg', junk: 1 }
}, extra || {});
const VIDEO = F({ type: 'video', url: 'https://test-streams.example.com/x36xhzz/x36xhzz.m3u8', title: 'Big Buck Bunny (HLS)', image: 'https://img.example.com/bbb.png' });
const EP_KEY = (n) => 'podcast:' + FEED + '#guid-' + n;

/* ===================== libraryEmpty ===================== */
test('libraryEmpty: the documented shape, fresh object each call', () => {
  deepEq(E.libraryEmpty(), {
    v: 1, favourites: [], recents: [], resume: {}, subscriptions: [], queue: [],
    settings: { httpsOnly: true, dataSaver: false, maxHeight: 1080, autoplay: true, theme: 'auto', visualiser: true, startTab: 'radio' },
    sleep: null, updatedAt: 0
  });
  assert.notEqual(E.libraryEmpty(), E.libraryEmpty());
  assert.notEqual(E.libraryEmpty().favourites, E.libraryEmpty().favourites);
  assert.equal(E.LIBRARY_VERSION, 1);
  deepEq(E.LIBRARY_CAPS, { favourites: 500, recents: 60, queue: 200, subscriptions: 500, resume: 500 });
});

/* ===================== libraryItemKey ===================== */
test('libraryItemKey: one key per type, from the identity fields', () => {
  assert.equal(E.libraryItemKey(STATION), 'radio:960b4e0b-0601-11e8-ae97-52543be04c81');
  assert.equal(E.libraryItemKey(F(EP(1))), EP_KEY(1));
  assert.equal(E.libraryItemKey(VIDEO), 'video:' + VIDEO.url);
  assert.equal(E.libraryItemKey(SHOW), 'show:' + FEED);
});
test('libraryItemKey: an episode without feedUrl uses its show feed; without a guid uses its enclosure url', () => {
  assert.equal(E.libraryItemKey(F(EP(2, { feedUrl: undefined }))), EP_KEY(2));
  assert.equal(E.libraryItemKey(F(EP(3, { id: '' }))), 'podcast:' + FEED + '#https://cdn.example.com/ep3.mp3');
  assert.equal(E.libraryItemKey(F(EP(3, { id: null, url: 'ftp://x' }))), null);
  assert.equal(E.libraryItemKey(F({ type: 'radio', id: 42 })), 'radio:42');
  assert.equal(E.libraryItemKey(F({ type: 'radio', id: '  padded  ' })), 'radio:padded');
});
test('libraryItemKey: junk and incomplete items → null; a well-formed key string passes through', () => {
  const nulls = [null, undefined, 1, 'radio', '', [], {}, { type: 'radio' }, { type: 'radio', id: '' }, { type: 'Radio', id: 'x' },
    { type: 'video', url: 'javascript:alert(1)' }, { type: 'video', url: 'spotify:track:1' }, { type: 'show', feedUrl: 'feeds.example.com/x' },
    { type: 'podcast', id: 'g' }, { type: 'mix', id: 'x' }, 'bogus:x', 'radio:', 'radio:' + 'x'.repeat(5000)];
  nulls.forEach((x) => assert.equal(E.libraryItemKey(F(x)), null, JSON.stringify(x)));
  assert.equal(E.libraryItemKey('radio:abc'), 'radio:abc');
  assert.equal(E.libraryItemKey('show:' + FEED), 'show:' + FEED);
});

/* ===================== libraryCompactItem ===================== */
test('libraryCompactItem: keeps only the rendered fields in a fixed order, drops the rest', () => {
  deepEq(E.libraryCompactItem(STATION), {
    type: 'radio', id: STATION.id, name: 'SomaFM: Groove Salad', url: STATION.url, favicon: STATION.favicon, homepage: STATION.homepage,
    country: 'The United States Of America', codec: 'MP3', bitrate: 128, tags: ['ambient', 'chillout', 'downtempo', 'electronic']
  });
  deepEq(E.libraryCompactItem(F(EP(1))), {
    type: 'podcast', id: 'guid-1', title: 'Episode 1', url: 'https://cdn.example.com/ep1.mp3', feedUrl: FEED,
    duration: 3600, published: Date.UTC(2026, 8, 1), show: { title: 'Lingthusiasm', feedUrl: FEED, image: 'https://img.example.com/ling.jpg' }
  });
  deepEq(E.libraryCompactItem(SHOW), { type: 'show', id: '123456', title: 'Lingthusiasm', feedUrl: FEED, image: SHOW.image, author: SHOW.author });
  deepEq(E.libraryCompactItem(VIDEO), { type: 'video', title: VIDEO.title, url: VIDEO.url, image: VIDEO.image });
});
test('libraryCompactItem: the hls flag survives for radio (the player needs it); tags ≤ 8, lowercased, unique; comma tags split', () => {
  deepEq(E.libraryCompactItem(STATION_HLS), { type: 'radio', id: 'hls-1', name: 'BBC Radio 4', url: STATION_HLS.url, country: 'The United Kingdom', codec: 'AAC', bitrate: 96, hls: true, tags: ['news', 'talk', 'bbc'] });
  const many = E.libraryCompactItem(F({ type: 'radio', id: 'x', tags: ['A', 'b', ' a ', 'C', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], hls: 'true' }));
  deepEq(many.tags, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.equal(many.hls, undefined, 'a string "true" is not the boolean flag');
});
test('libraryCompactItem: strings cut at 300, URLs at 2048, numbers coerced, bad URLs and empty values dropped', () => {
  const longUrl = 'https://cdn.example.com/' + 'a'.repeat(1000) + '.mp3';
  const c = E.libraryCompactItem(F({
    type: 'podcast', id: 'g', title: 'x'.repeat(400), url: longUrl, feedUrl: FEED, image: 'data:image/png;base64,AAAA', author: 'Ann \n\t Lee ',
    bitrate: '128', duration: '3723.5', published: '1700000000000', tags: [], show: { title: '', feedUrl: 'not a url', image: '' }
  }));
  assert.equal(c.title.length, 300);
  assert.equal(c.url, longUrl);
  assert.equal(c.image, undefined);
  assert.equal(c.author, 'Ann Lee');
  assert.equal(c.bitrate, 128);
  assert.equal(c.duration, 3723.5);
  assert.equal(c.published, 1700000000000);
  assert.equal(c.tags, undefined);
  assert.equal(c.show, undefined);
  const tooLong = E.libraryCompactItem(F({ type: 'video', url: 'https://h/' + 'b'.repeat(2100) }));
  assert.equal(tooLong, null, 'a URL over 2048 chars cannot be a key');
  assert.equal(E.libraryCompactItem(F({ type: 'radio', id: 'x', bitrate: -5, duration: 0, published: NaN, codec: '' })).bitrate, undefined);
});
test('libraryCompactItem: never cuts a surrogate pair in half, strips control characters', () => {
  const c = E.libraryCompactItem(F({ type: 'radio', id: 'x', name: 'a'.repeat(299) + '😀', title: 'bad\u0000\u0007chars\u001f here' }));
  assert.equal(c.name, 'a'.repeat(299));
  assert.equal(c.title, 'badchars here');
  assert.equal(E.libraryCompactItem(F({ type: 'radio', id: 'x', name: 'tab\tand\r\nnewline' })).name, 'tab and newline');
  assert.doesNotThrow(() => encodeURIComponent(c.name));
});
test('libraryCompactItem: key(compact(x)) === key(x) for every fixture; junk → null', () => {
  [STATION, STATION_HLS, SHOW, VIDEO, F(EP(1)), F(EP(2, { feedUrl: undefined })), F(EP(3, { id: '' }))].forEach((x) => {
    assert.equal(E.libraryItemKey(E.libraryCompactItem(x)), E.libraryItemKey(x));
  });
  [null, undefined, 'x', 1, [], {}, { type: 'show' }, { type: 'video', url: 'http://' }, { type: 'nope', id: 1 }].forEach((x) => assert.equal(E.libraryCompactItem(F(x)), null));
});

/* ===================== scenario walk-through ===================== */
test('scenario: favourite → play → resume → finish → unsubscribe, with frozen inputs at every step', () => {
  const lib0 = F(E.libraryEmpty());
  const lib1 = F(E.toggleFavourite(lib0, STATION, T(0)));
  assert.notEqual(lib1, lib0);
  deepEq(lib0, E.libraryEmpty(), 'input untouched');
  assert.equal(lib1.updatedAt, T(0));
  assert.equal(E.isFavourite(lib1, STATION), true);
  assert.equal(E.isFavourite(lib0, STATION), false);

  const lib2 = F(E.recordPlay(lib1, STATION, T(1)));
  deepEq(keysOf(lib2.recents), [E.libraryItemKey(STATION)]);
  assert.equal(lib2.recents[0].updatedAt, T(1));
  assert.equal(lib2.recents[0].votes, undefined, 'stored compact');
  deepEq(lib1.recents, [], 'input untouched');

  const lib3 = F(E.subscribe(lib2, SHOW, T(2)));
  assert.equal(E.isSubscribed(lib3, SHOW), true);
  assert.equal(E.isSubscribed(lib3, FEED), true, 'by feed url');
  assert.equal(E.isSubscribed(lib3, F(EP(1))), true, 'an episode asks about its show');

  const ep = F(EP(1));
  const lib4 = F(E.recordPlay(lib3, ep, T(3)));
  deepEq(keysOf(lib4.recents), [EP_KEY(1), E.libraryItemKey(STATION)], 'newest first');
  const lib5 = F(E.setResume(lib4, EP_KEY(1), 5, 3600, T(4)));
  assert.equal(lib5, lib4, 'under 10 s is not a session: no-op returns the same object');
  const lib6 = F(E.setResume(lib4, EP_KEY(1), 1234.5, 3600, T(5)));
  deepEq(E.getResume(lib6, EP_KEY(1)), { position: 1234.5, duration: 3600, finished: false, updatedAt: T(5) });
  deepEq(E.getResume(lib6, ep), E.getResume(lib6, EP_KEY(1)), 'getResume accepts the item too');
  assert.equal(E.getResume(lib4, EP_KEY(1)), null, 'input untouched');
  deepEq(E.continueListening(lib6).map((x) => [E.libraryItemKey(x), x.resume.position]), [[EP_KEY(1), 1234.5]]);
  deepEq(E.libraryStats(lib6), { favourites: 1, favouritesByType: { radio: 1, podcast: 0, video: 0, show: 0 }, recents: 2, subscriptions: 1, queue: 0, resume: 1, inProgress: 1, finished: 0 });

  const lib7 = F(E.setResume(lib6, EP_KEY(1), 3600 * 0.96, 3600, T(6)));
  assert.equal(E.getResume(lib7, EP_KEY(1)).finished, true);
  deepEq(E.continueListening(lib7), [], 'finished episodes leave continue-listening');
  deepEq(E.libraryStats(lib7).finished, 1);

  const lib8 = F(E.unsubscribe(lib7, FEED, T(7)));
  assert.equal(E.isSubscribed(lib8, SHOW), false);
  assert.equal(E.isSubscribed(lib7, SHOW), true, 'input untouched');
  assert.equal(lib8.updatedAt, T(7));
  const lib9 = F(E.toggleFavourite(lib8, STATION, T(8)));
  deepEq(lib9.favourites, []);
  deepEq(J(E.libraryDeserialize(E.librarySerialize(lib9))), J(lib9), 'round trip');
});

/* ===================== favourites ===================== */
test('toggleFavourite: newest first, dedupe by key, toggle off, junk item is a no-op', () => {
  let lib = F(E.libraryEmpty());
  lib = F(E.toggleFavourite(lib, STATION, T(0)));
  lib = F(E.toggleFavourite(lib, SHOW, T(1)));
  lib = F(E.toggleFavourite(lib, VIDEO, T(2)));
  deepEq(keysOf(lib.favourites), ['video:' + VIDEO.url, 'show:' + FEED, 'radio:' + STATION.id]);
  const again = E.toggleFavourite(lib, F({ type: 'radio', id: STATION.id }), T(3));
  deepEq(keysOf(again.favourites), ['video:' + VIDEO.url, 'show:' + FEED], 'a bare key-bearing item toggles off');
  assert.equal(E.toggleFavourite(lib, F({ type: 'radio' }), T(4)), lib);
  assert.equal(E.toggleFavourite(lib, null, T(4)), lib);
  assert.equal(E.toggleFavourite(lib, 'radio:' + STATION.id, T(5)).favourites.length, 2, 'a key string can only remove');
  assert.equal(E.toggleFavourite(lib, 'radio:unknown', T(5)), lib, 'a key string for an absent item cannot add');
  assert.equal(E.isFavourite(lib, 'show:' + FEED), true);
  assert.equal(E.isFavourite(lib, null), false);
});
test('toggleFavourite: without a clock the entry inherits the library stamp; junk lib is rebuilt', () => {
  const lib = F(E.toggleFavourite(E.toggleFavourite(E.libraryEmpty(), STATION, T(0)), VIDEO));
  assert.equal(lib.favourites[0].updatedAt, T(0));
  assert.equal(lib.updatedAt, T(0));
  const fromJunk = E.toggleFavourite(F({ favourites: 'nope' }), STATION, T(1));
  deepEq(keysOf(fromJunk.favourites), ['radio:' + STATION.id]);
  deepEq(fromJunk.settings, E.libraryEmpty().settings);
});
test('favourites cap 500: evicts the oldest by updatedAt, not by position', () => {
  let lib = E.libraryEmpty();
  for (let i = 0; i < 500; i++) lib = E.toggleFavourite(lib, { type: 'radio', id: 'st' + i }, T(i));
  assert.equal(lib.favourites.length, 500);
  // The oldest entry by stamp is 'st0' (last position). An import-shaped list where the stamp order and
  // position disagree must still evict by stamp: reorder so the oldest sits in front.
  const shuffled = F(E.libraryDeserialize({ favourites: [lib.favourites[499]].concat(lib.favourites.slice(0, 499)) }));
  const full = F(E.toggleFavourite(shuffled, { type: 'radio', id: 'new' }, T(600)));
  assert.equal(full.favourites.length, 500);
  assert.equal(E.isFavourite(full, 'radio:st0'), false, 'st0 (oldest stamp, front position) was evicted');
  assert.equal(E.isFavourite(full, 'radio:st1'), true);
  assert.equal(E.isFavourite(full, 'radio:new'), true);
  assert.equal(full.favourites[0].id, 'new');
});

/* ===================== recents ===================== */
test('recordPlay: newest first, replay moves to the front with a fresh stamp, cap 60, shows are not playable', () => {
  let lib = E.libraryEmpty();
  for (let i = 0; i < 70; i++) lib = E.recordPlay(lib, { type: 'radio', id: 'st' + i, name: 'S' + i }, T(i));
  assert.equal(lib.recents.length, 60);
  assert.equal(lib.recents[0].id, 'st69');
  assert.equal(lib.recents[59].id, 'st10');
  const replay = F(E.recordPlay(F(lib), { type: 'radio', id: 'st30' }, T(100)));
  assert.equal(replay.recents.length, 60);
  assert.equal(replay.recents[0].id, 'st30');
  assert.equal(replay.recents[0].updatedAt, T(100));
  assert.equal(replay.recents[0].name, undefined, 'the entry is rebuilt from the item passed in');
  assert.equal(keysOf(replay.recents).filter((k) => k === 'radio:st30').length, 1);
  assert.equal(E.recordPlay(lib, SHOW, T(101)), lib);
  assert.equal(E.recordPlay(lib, {}, T(101)), lib);
});

/* ===================== resume ===================== */
test('setResume: the spec rules — position < 10 or no duration ignored, clamp to duration, finished at 95%', () => {
  const lib = F(E.libraryEmpty());
  const table = [
    [9.99, 3600, null], [10, 3600, { position: 10, duration: 3600, finished: false }], [100, 0, null], [100, -1, null],
    [100, null, null], [100, undefined, null], [100, NaN, null], [100, Infinity, null], [100, '3600', { position: 100, duration: 3600, finished: false }],
    ['200', 3600, { position: 200, duration: 3600, finished: false }], [3420, 3600, { position: 3420, duration: 3600, finished: true }],
    [3419.9, 3600, { position: 3419.9, duration: 3600, finished: false }], [5000, 3600, { position: 3600, duration: 3600, finished: true }],
    [NaN, 3600, null], [-50, 3600, null], ['x', 3600, null], [{}, 3600, null], [60, 60, { position: 60, duration: 60, finished: true }]
  ];
  table.forEach(([p, d, want]) => {
    const next = E.setResume(lib, 'video:https://h/v.mp4', p, d, NOW);
    if (want === null) assert.equal(next, lib, `ignored: ${p}/${d}`);
    else deepEq(E.getResume(next, 'video:https://h/v.mp4'), Object.assign(want, { updatedAt: NOW }), `${p}/${d}`);
  });
  assert.equal(E.setResume(lib, 'bogus', 100, 200, NOW), lib);
  assert.equal(E.setResume(lib, null, 100, 200, NOW), lib);
  assert.equal(E.getResume(lib, 'video:https://h/v.mp4'), null);
  assert.equal(E.getResume(lib, null), null);
  const longEp = F({ type: 'podcast', feedUrl: 'https://feeds.example.com/' + 'f'.repeat(2000), url: 'https://cdn.example.com/' + 'u'.repeat(2000) + '.mp3' });
  const longKey = E.libraryItemKey(longEp);
  assert.equal(longKey.length > 4000, true);
  deepEq(E.getResume(E.setResume(lib, longKey, 100, 200, NOW), longEp), { position: 100, duration: 200, finished: false, updatedAt: NOW }, 'the longest legal key (guid-less episode, max URLs) still stores');
});
test('setResume: replaying a finished episode from the start makes it unfinished again; clearResume removes one key', () => {
  let lib = F(E.setResume(E.libraryEmpty(), EP_KEY(1), 3600, 3600, T(0)));
  assert.equal(E.getResume(lib, EP_KEY(1)).finished, true);
  lib = F(E.setResume(lib, EP_KEY(1), 30, 3600, T(1)));
  assert.equal(E.getResume(lib, EP_KEY(1)).finished, false);
  lib = F(E.setResume(lib, EP_KEY(2), 30, 3600, T(2)));
  const cleared = F(E.clearResume(lib, EP_KEY(1), T(3)));
  deepEq(Object.keys(cleared.resume), [EP_KEY(2)]);
  assert.equal(cleared.updatedAt, T(3));
  deepEq(Object.keys(lib.resume), [EP_KEY(1), EP_KEY(2)], 'input untouched');
  assert.equal(E.clearResume(lib, EP_KEY(9), T(4)), lib, 'absent key: no-op');
  assert.equal(E.clearResume(lib, F(EP(2)), T(4)).resume[EP_KEY(2)], undefined, 'clear by item');
});
test('resume cap 500: the oldest stamps go first', () => {
  let lib = E.libraryEmpty();
  for (let i = 0; i < 500; i++) lib = E.setResume(lib, 'radio:st' + i, 100, 200, T(i));
  assert.equal(Object.keys(lib.resume).length, 500);
  lib = E.setResume(lib, 'radio:st3', 150, 200, T(1000));   // refreshing st3 makes it the newest
  lib = E.setResume(lib, 'radio:new', 100, 200, T(1001));
  assert.equal(Object.keys(lib.resume).length, 500);
  assert.equal(E.getResume(lib, 'radio:st0'), null);
  assert.equal(E.getResume(lib, 'radio:st1').position, 100);
  assert.equal(E.getResume(lib, 'radio:st3').position, 150);
  assert.equal(E.getResume(lib, 'radio:new').position, 100);
});
test('continueListening: unfinished podcasts from recents, most recently listened first, resume attached', () => {
  let lib = E.libraryEmpty();
  lib = E.recordPlay(lib, EP(1), T(0));
  lib = E.recordPlay(lib, EP(2), T(1));
  lib = E.recordPlay(lib, EP(3), T(2));
  lib = E.recordPlay(lib, STATION, T(3));
  lib = E.recordPlay(lib, VIDEO, T(4));
  lib = E.setResume(lib, EP_KEY(1), 600, 3600, T(10));
  lib = E.setResume(lib, EP_KEY(2), 3500, 3600, T(11));    // finished
  lib = E.setResume(lib, EP_KEY(3), 900, 3600, T(5));
  lib = E.setResume(lib, 'video:' + VIDEO.url, 100, 600, T(12));   // not a podcast
  lib = E.setResume(lib, EP_KEY(7), 100, 600, T(13));              // resume without a recent: nothing to render
  const cl = E.continueListening(F(lib));
  deepEq(cl.map((x) => [x.id, x.resume]), [
    ['guid-1', { position: 600, duration: 3600, finished: false, updatedAt: T(10) }],
    ['guid-3', { position: 900, duration: 3600, finished: false, updatedAt: T(5) }]
  ]);
  assert.equal(cl[0].show.title, 'Lingthusiasm');
  assert.equal(cl[0].updatedAt, T(0), 'the recents stamp rides along');
  deepEq(E.continueListening(E.libraryEmpty()), []);
  deepEq(E.continueListening(null), []);
});

/* ===================== subscriptions ===================== */
test('subscribe: newest first, by feed identity; type-less OPML rows and episodes subscribe their show; dedupe', () => {
  let lib = F(E.libraryEmpty());
  lib = F(E.subscribe(lib, SHOW, T(0)));
  lib = F(E.subscribe(lib, F({ title: 'From OPML', feedUrl: 'https://feeds.example.com/opml.xml' }), T(1)));
  lib = F(E.subscribe(lib, F(EP(1, { feedUrl: 'https://feeds.example.com/other.xml', show: { title: 'Other Show', feedUrl: 'https://feeds.example.com/other.xml', image: 'https://img.example.com/o.png' } })), T(2)));
  deepEq(lib.subscriptions.map((s) => [s.type, s.title, s.feedUrl, s.updatedAt]), [
    ['show', 'Other Show', 'https://feeds.example.com/other.xml', T(2)],
    ['show', 'From OPML', 'https://feeds.example.com/opml.xml', T(1)],
    ['show', 'Lingthusiasm', FEED, T(0)]
  ]);
  assert.equal(lib.subscriptions[0].image, 'https://img.example.com/o.png');
  assert.equal(E.subscribe(lib, SHOW, T(3)), lib, 'already subscribed: no-op');
  assert.equal(E.subscribe(lib, F({ title: 'no feed' }), T(3)), lib);
  assert.equal(E.subscribe(lib, 'https://feeds.example.com/x.xml', T(3)), lib, 'a bare string is not a show');
  assert.equal(E.subscribe(lib, null, T(3)), lib);
});
test('unsubscribe / isSubscribed: by show, feed url, key or episode; unknown is a no-op', () => {
  const lib = F(E.subscribe(E.libraryEmpty(), SHOW, T(0)));
  [SHOW, FEED, 'show:' + FEED, F(EP(1)), ' ' + FEED + ' '].forEach((x) => {
    assert.equal(E.isSubscribed(lib, x), true);
    deepEq(E.unsubscribe(lib, x, T(1)).subscriptions, []);
  });
  assert.equal(E.unsubscribe(lib, 'https://feeds.example.com/none.xml', T(1)), lib);
  assert.equal(E.unsubscribe(lib, null, T(1)), lib);
  assert.equal(E.isSubscribed(lib, 'podcast:' + FEED + '#x'), false, 'an episode key is not a show key');
  assert.equal(E.isSubscribed(null, SHOW), false);
});
test('updateShow: merges only the compact fields, pins feedUrl/type, keeps the subscribed-at stamp, no-op when unchanged', () => {
  const lib = F(E.subscribe(E.libraryEmpty(), SHOW, T(0)));
  const patch = F({ title: 'Lingthusiasm (renamed)', image: 'https://img.example.com/new.jpg', description: 'dropped', feedUrl: 'https://evil.example.com/x', type: 'video', published: Date.UTC(2026, 9, 1), episodeCount: 101 });
  const next = F(E.updateShow(lib, FEED, patch, T(5)));
  deepEq(next.subscriptions, [{ type: 'show', id: '123456', title: 'Lingthusiasm (renamed)', feedUrl: FEED, image: 'https://img.example.com/new.jpg', author: SHOW.author, published: Date.UTC(2026, 9, 1), updatedAt: T(0) }]);
  assert.equal(next.updatedAt, T(5));
  assert.equal(lib.subscriptions[0].title, 'Lingthusiasm', 'input untouched');
  assert.equal(E.updateShow(next, FEED, patch, T(6)), next, 'same patch again: nothing changes');
  assert.equal(E.updateShow(lib, 'https://feeds.example.com/none.xml', patch, T(6)), lib);
  assert.equal(E.updateShow(lib, FEED, 'junk', T(6)), lib);
  assert.equal(E.updateShow(lib, FEED, null, T(6)), lib);
  assert.equal(E.updateShow(lib, FEED, F({ image: '' }), T(6)).subscriptions[0].image, undefined, 'an explicit empty clears a field');
  assert.equal(E.updateShow(lib, FEED, JSON.parse('{"__proto__":{"title":"polluted"}}'), T(6)), lib, 'a __proto__ key carries nothing');
});
test('subscriptions cap 500: oldest stamp evicted', () => {
  let lib = E.libraryEmpty();
  for (let i = 0; i < 501; i++) lib = E.subscribe(lib, { title: 'S' + i, feedUrl: 'https://feeds.example.com/' + i + '.xml' }, T(i));
  assert.equal(lib.subscriptions.length, 500);
  assert.equal(E.isSubscribed(lib, 'https://feeds.example.com/0.xml'), false);
  assert.equal(E.isSubscribed(lib, 'https://feeds.example.com/500.xml'), true);
});

/* ===================== queue ===================== */
test('queue: add appends (dedupe, playable only), remove by key or item, move, shift, clear — all immutable', () => {
  let lib = F(E.libraryEmpty());
  lib = F(E.queueAdd(lib, STATION, T(0)));
  lib = F(E.queueAdd(lib, F(EP(1)), T(1)));
  lib = F(E.queueAdd(lib, VIDEO, T(2)));
  assert.equal(E.queueAdd(lib, STATION, T(3)), lib, 'duplicate: no-op');
  assert.equal(E.queueAdd(lib, SHOW, T(3)), lib, 'a show is not playable');
  assert.equal(E.queueAdd(lib, {}, T(3)), lib);
  deepEq(keysOf(lib.queue), ['radio:' + STATION.id, EP_KEY(1), 'video:' + VIDEO.url]);
  assert.equal(lib.queue[0].updatedAt, undefined, 'queue entries carry no stamp: position is their age');
  assert.equal(lib.updatedAt, T(2));

  const moved = F(E.queueMove(lib, 2, 0, T(4)));
  deepEq(keysOf(moved.queue), ['video:' + VIDEO.url, 'radio:' + STATION.id, EP_KEY(1)]);
  deepEq(keysOf(E.queueMove(lib, 0, 2).queue), [EP_KEY(1), 'video:' + VIDEO.url, 'radio:' + STATION.id]);
  [[1, 1], [3, 0], [0, 3], [-1, 0], [0.5, 1], ['a', 0], [null, 0], [0, undefined]].forEach(([a, b]) => assert.equal(E.queueMove(lib, a, b, T(4)), lib, `move ${a}→${b}`));
  deepEq(keysOf(lib.queue), ['radio:' + STATION.id, EP_KEY(1), 'video:' + VIDEO.url], 'input untouched');

  const removed = F(E.queueRemove(lib, EP_KEY(1), T(5)));
  deepEq(keysOf(removed.queue), ['radio:' + STATION.id, 'video:' + VIDEO.url]);
  deepEq(keysOf(E.queueRemove(lib, VIDEO).queue), ['radio:' + STATION.id, EP_KEY(1)]);
  assert.equal(E.queueRemove(lib, 'radio:none', T(5)), lib);
  assert.equal(E.queueRemove(lib, null, T(5)), lib);

  const shifted = E.queueShift(lib, T(6));
  assert.equal(E.libraryItemKey(shifted.item), 'radio:' + STATION.id);
  deepEq(keysOf(shifted.lib.queue), [EP_KEY(1), 'video:' + VIDEO.url]);
  assert.equal(shifted.lib.updatedAt, T(6));
  const empty = E.queueShift(E.libraryEmpty(), T(6));
  assert.equal(empty.item, null);
  deepEq(empty.lib, E.libraryEmpty());
  const emptyFrozen = F(E.libraryEmpty());
  assert.equal(E.queueShift(emptyFrozen).lib, emptyFrozen, 'nothing to shift: same object');

  deepEq(E.queueClear(lib, T(7)).queue, []);
  assert.equal(E.queueClear(lib, T(7)).updatedAt, T(7));
  assert.equal(E.queueClear(emptyFrozen, T(7)), emptyFrozen);
});
test('queue cap 200: a full queue ignores further adds (the front is what plays next)', () => {
  let lib = E.libraryEmpty();
  for (let i = 0; i < 205; i++) lib = E.queueAdd(lib, { type: 'radio', id: 'q' + i }, T(i));
  assert.equal(lib.queue.length, 200);
  assert.equal(lib.queue[0].id, 'q0');
  assert.equal(lib.queue[199].id, 'q199');
  assert.equal(lib.updatedAt, T(199));
});

/* ===================== settings ===================== */
test('setSetting: every validation branch', () => {
  const lib = F(E.libraryEmpty());
  const accepted = [
    ['httpsOnly', false], ['dataSaver', true], ['autoplay', false], ['visualiser', false],
    ['maxHeight', 360], ['maxHeight', 480], ['maxHeight', 720], ['maxHeight', 2160], ['maxHeight', '720', 720],
    ['theme', 'light'], ['theme', 'dark'], ['startTab', 'podcasts'], ['startTab', 'tv'], ['startTab', 'library']
  ];
  accepted.forEach(([k, v, want]) => {
    const next = E.setSetting(lib, k, v, NOW);
    assert.notEqual(next, lib, `${k}=${JSON.stringify(v)} accepted`);
    assert.equal(next.settings[k], want === undefined ? v : want);
    assert.equal(next.updatedAt, NOW);
    deepEq(Object.keys(next.settings), Object.keys(lib.settings), 'key order stable');
  });
  const rejected = [
    ['httpsOnly', 'true'], ['httpsOnly', 1], ['httpsOnly', 0], ['dataSaver', null], ['autoplay', 'yes'], ['visualiser', undefined],
    ['maxHeight', 900], ['maxHeight', '1080p'], ['maxHeight', null], ['maxHeight', -720], ['maxHeight', true],
    ['theme', 'neon'], ['theme', 'Light'], ['theme', 1], ['startTab', 'settings'], ['startTab', ''], ['startTab', ['radio']],
    ['volume', 0.5], ['__proto__', { x: 1 }], ['constructor', 'x'], ['toString', 'x'], [null, true], [undefined, true]
  ];
  rejected.forEach(([k, v]) => assert.equal(E.setSetting(lib, k, v, NOW), lib, `${k}=${JSON.stringify(v)} rejected`));
  assert.equal(E.setSetting(lib, 'theme', 'auto', NOW), lib, 'unchanged value: no-op');
  assert.equal(E.setSetting(lib, 'maxHeight', '1080', NOW), lib, 'unchanged value through coercion: no-op');
  deepEq(lib.settings, E.libraryEmpty().settings, 'input untouched');
  assert.equal(({}).x, undefined, 'no prototype pollution');
});

/* ===================== sleep timer ===================== */
test('sleep timer maths: endsAt = now + minutes, remaining counts down in whole seconds, expired exactly at the deadline', () => {
  const lib = F(E.libraryEmpty());
  assert.equal(E.sleepRemaining(lib, NOW), null);
  assert.equal(E.sleepExpired(lib, NOW), false);
  const s = F(E.startSleep(lib, 30, NOW));
  deepEq(s.sleep, { startedAt: NOW, endsAt: NOW + 30 * MIN, minutes: 30 });
  assert.equal(s.updatedAt, NOW);
  assert.equal(lib.sleep, null, 'input untouched');
  assert.equal(E.sleepRemaining(s, NOW), 1800);
  assert.equal(E.sleepRemaining(s, NOW + 10 * MIN), 1200);
  assert.equal(E.sleepRemaining(s, NOW + 30 * MIN - 400), 1, 'ceil: 0.4 s left still reads 1');
  assert.equal(E.sleepRemaining(s, NOW + 30 * MIN), 0);
  assert.equal(E.sleepRemaining(s, NOW + 31 * MIN), 0, 'never negative');
  assert.equal(E.sleepExpired(s, NOW + 30 * MIN - 1), false);
  assert.equal(E.sleepExpired(s, NOW + 30 * MIN), true);
  assert.equal(E.sleepExpired(s, NOW + 5 * 60 * MIN), true);
  assert.equal(E.sleepRemaining(s, 'soon'), null);
  assert.equal(E.sleepExpired(s, null), false, 'unknown clock: not expired');
  const c = F(E.cancelSleep(s, NOW + MIN));
  assert.equal(c.sleep, null);
  assert.equal(c.updatedAt, NOW + MIN);
  assert.equal(E.cancelSleep(lib, NOW), lib, 'nothing to cancel: same object');
  assert.equal(E.sleepRemaining(c, NOW), null);
  const restarted = E.startSleep(s, 0.5, NOW + MIN);
  deepEq(restarted.sleep, { startedAt: NOW + MIN, endsAt: NOW + MIN + 30000, minutes: 0.5 }, 'restarting replaces the timer');
  deepEq(E.startSleep(lib, '15', NOW).sleep, { startedAt: NOW, endsAt: NOW + 15 * MIN, minutes: 15 }, 'numeric string from a <select>');
  deepEq(E.startSleep(lib, 1e9, NOW).sleep.minutes, 1440, 'capped at a day');
  [0, -5, NaN, 'abc', null, undefined, {}, Infinity].forEach((m) => assert.equal(E.startSleep(lib, m, NOW), lib, `minutes ${m}`));
  [NaN, 'x', null, undefined, -1].forEach((t) => assert.equal(E.startSleep(lib, 30, t), lib, `now ${t}: no clock, no timer`));
});

/* ===================== serialize / deserialize ===================== */
test('librarySerialize/libraryDeserialize: a lossless round trip for a worked library; the string is canonical JSON', () => {
  let lib = E.libraryEmpty();
  lib = E.toggleFavourite(lib, STATION, T(0));
  lib = E.toggleFavourite(lib, SHOW, T(1));
  lib = E.recordPlay(lib, EP(1), T(2));
  lib = E.setResume(lib, EP_KEY(1), 600, 3600, T(3));
  lib = E.subscribe(lib, SHOW, T(4));
  lib = E.queueAdd(lib, VIDEO, T(5));
  lib = E.setSetting(lib, 'theme', 'dark', T(6));
  lib = E.startSleep(lib, 20, T(7));
  const s = E.librarySerialize(F(lib));
  assert.equal(typeof s, 'string');
  assert.equal(s, JSON.stringify(lib), 'a valid library serialises as-is');
  deepEq(J(E.libraryDeserialize(s)), J(lib));
  deepEq(J(E.libraryDeserialize(J(lib))), J(lib), 'an already-parsed object is accepted too');
  assert.equal(E.librarySerialize(null), JSON.stringify(E.libraryEmpty()));
  assert.equal(E.librarySerialize('junk'), JSON.stringify(E.libraryEmpty()));
});
test('libraryDeserialize: junk fuzz table → always a valid library, never a throw', () => {
  const empty = E.libraryEmpty();
  const junk = ['', ' ', 'null', 'undefined', '42', '"x"', 'true', '[]', '[1,2]', '{', '{"v":', 'not json at all', '\u0000', '{"v":"x"}',
    '{"favourites":"nope","recents":42,"resume":[1,2],"subscriptions":{},"queue":null,"settings":"dark","sleep":"soon","updatedAt":"later"}',
    '{"favourites":[1,null,"x",{},[],{"type":"radio"},{"type":"radio","id":""}]}', '{"resume":{"radio:x":"abc","radio:y":{"position":"a"},"radio:z":null,"":{"position":20,"duration":100},"bogus:k":{"position":20,"duration":100}}}',
    '{"settings":{"maxHeight":"big","theme":"neon","httpsOnly":"true","startTab":5,"extra":1}}', '{"sleep":{"endsAt":"never"}}', '{"sleep":{"endsAt":-1}}',
    null, undefined, 0, 42, NaN, true, [], [{ v: 1 }], 'a'.repeat(10000), '{"a":'.repeat(2000), { v: 99, favourites: { length: 1e9 } }, { updatedAt: -5 }, { updatedAt: Infinity }];
  junk.forEach((x) => {
    const lib = E.libraryDeserialize(x);
    assert.equal(lib.v, 1);
    deepEq(Object.keys(lib), Object.keys(empty), 'canonical keys: ' + String(x).slice(0, 40));
    deepEq(lib.settings.theme, 'auto');
    assert.equal(Array.isArray(lib.favourites) && Array.isArray(lib.recents) && Array.isArray(lib.subscriptions) && Array.isArray(lib.queue), true);
    assert.equal(typeof lib.resume === 'object' && lib.resume !== null, true);
    assert.equal(lib.sleep, null);
    assert.equal(lib.updatedAt, 0);
    assert.doesNotThrow(() => E.librarySerialize(lib));
  });
  deepEq(J(E.libraryDeserialize('{"settings":{"maxHeight":"720","theme":"neon","httpsOnly":"true","dataSaver":true,"extra":1}}').settings),
    { httpsOnly: true, dataSaver: true, maxHeight: 720, autoplay: true, theme: 'auto', visualiser: true, startTab: 'radio' }, 'valid keys kept, invalid ones fall back, unknown ignored');
});
test('libraryDeserialize: migrates older shapes — missing fields → defaults, v missing → 1, partial entries cleaned', () => {
  const lib = E.libraryDeserialize({ favourites: [Object.assign({}, STATION, { updatedAt: 'yesterday' })], resume: { [EP_KEY(1)]: { position: 50, duration: 100 } }, updatedAt: 5 });
  assert.equal(lib.v, 1);
  deepEq(lib.favourites, [Object.assign(E.libraryCompactItem(STATION), { updatedAt: 0 })]);
  deepEq(lib.resume, { [EP_KEY(1)]: { position: 50, duration: 100, finished: false, updatedAt: 0 } });
  deepEq(lib.settings, E.libraryEmpty().settings);
  assert.equal(lib.updatedAt, 5);
  assert.equal(E.libraryDeserialize({ v: '2', favourites: [] }).v, 1);
  deepEq(E.libraryDeserialize({ sleep: { endsAt: NOW + MIN } }).sleep, { startedAt: NOW + MIN, endsAt: NOW + MIN, minutes: 0 });
  deepEq(E.libraryDeserialize({ sleep: { endsAt: NOW + MIN, startedAt: NOW, minutes: 'x' } }).sleep, { startedAt: NOW, endsAt: NOW + MIN, minutes: 1 });
  const resumeRules = E.libraryDeserialize({ resume: { 'radio:a': { position: 5, duration: 100 }, 'radio:b': { position: 99, duration: 100, finished: false }, 'radio:c': { position: 500, duration: 100 }, 'radio:d': { position: 20, duration: 0 } } }).resume;
  deepEq(resumeRules, { 'radio:b': { position: 99, duration: 100, finished: true, updatedAt: 0 }, 'radio:c': { position: 100, duration: 100, finished: true, updatedAt: 0 } }, 'the resume rules apply on load; finished is derived');
});
test('libraryDeserialize: prototype-polluting keys are ignored everywhere', () => {
  const lib = E.libraryDeserialize('{"__proto__":{"v":9},"resume":{"__proto__":{"position":20,"duration":100},"constructor":{"position":20,"duration":100},"radio:ok":{"position":20,"duration":100}},"settings":{"__proto__":{"theme":"dark"}},"favourites":[{"__proto__":{"type":"radio","id":"x"}}]}');
  deepEq(Object.keys(lib.resume), ['radio:ok']);
  assert.equal(JSON.stringify(lib.resume).indexOf('__proto__'), -1);
  deepEq(lib.favourites, []);
  assert.equal(lib.settings.theme, 'auto');
  assert.equal(({}).position, undefined);
  assert.equal(({}).v, undefined);
  assert.equal(E.setResume(lib, 'radio:ok', 50, 100, NOW).resume['radio:ok'].position, 50, 'the cleaned map still works');
});
test('libraryDeserialize: huge arrays are capped (newest stamps kept), dedupes, shows out of recents/queue, junk entries dropped', () => {
  const favourites = [];
  for (let i = 0; i < 2000; i++) favourites.push({ type: 'radio', id: 'st' + (i % 1500), updatedAt: i });
  const recents = [];
  for (let i = 0; i < 300; i++) recents.push({ type: i % 2 ? 'show' : 'video', url: 'https://h/' + i, feedUrl: 'https://f/' + i, updatedAt: i });
  const queue = [];
  for (let i = 0; i < 500; i++) queue.push({ type: 'video', url: 'https://h/' + i });
  const resume = {};
  for (let i = 0; i < 800; i++) resume['radio:r' + i] = { position: 20, duration: 100, updatedAt: i };
  const lib = E.libraryDeserialize({ favourites, recents, subscriptions: favourites, queue, resume });
  assert.equal(lib.favourites.length, 500);
  assert.equal(lib.favourites[0].id, 'st0', 'duplicate keys: the newest stamp wins in the first position, then the oldest stamps are evicted');
  assert.equal(lib.favourites[0].updatedAt, 1500);
  assert.equal(lib.favourites[499].id, 'st499');
  assert.equal(lib.favourites.every((e) => e.updatedAt >= 1500), true);
  assert.equal(lib.recents.length, 60);
  assert.equal(lib.recents.every((e) => e.type === 'video'), true, 'shows are not playable');
  assert.equal(lib.recents[0].url, 'https://h/180');
  deepEq(lib.subscriptions, [], 'radio stations are not subscriptions');
  assert.equal(lib.queue.length, 200);
  assert.equal(lib.queue[0].url, 'https://h/0', 'the queue keeps its front');
  assert.equal(Object.keys(lib.resume).length, 500);
  assert.equal(lib.resume['radio:r299'], undefined);
  assert.equal(lib.resume['radio:r300'].updatedAt, 300);
});

/* ===================== export / import ===================== */
test('libraryExport: a portable snapshot without the sleep timer', () => {
  let lib = E.toggleFavourite(E.libraryEmpty(), STATION, T(0));
  lib = E.startSleep(lib, 10, T(1));
  const ex = E.libraryExport(F(lib));
  deepEq(Object.keys(ex), ['app', 'v', 'updatedAt', 'favourites', 'recents', 'resume', 'subscriptions', 'queue', 'settings']);
  assert.equal(ex.app, 'aerial');
  assert.equal(ex.updatedAt, T(1));
  deepEq(ex.favourites, lib.favourites);
  deepEq(E.libraryExport(null).favourites, []);
  deepEq(J(E.libraryDeserialize(JSON.stringify(ex))).favourites, J(lib.favourites), 'an export reloads as a library');
});
test('libraryImport: union by key, newer stamp wins, settings only when explicit and valid, local sleep kept', () => {
  let local = E.libraryEmpty();
  local = E.toggleFavourite(local, STATION, T(0));
  local = E.toggleFavourite(local, { type: 'radio', id: 'shared', name: 'Local name' }, T(5));
  local = E.recordPlay(local, EP(1), T(1));
  local = E.setResume(local, EP_KEY(1), 600, 3600, T(10));
  local = E.setResume(local, EP_KEY(2), 100, 3600, T(10));
  local = E.subscribe(local, SHOW, T(2));
  local = E.queueAdd(local, VIDEO);
  local = E.setSetting(local, 'theme', 'dark');
  local = E.startSleep(local, 10, T(3));
  local = F(local);

  let other = E.libraryEmpty();
  other = E.toggleFavourite(other, VIDEO, T(20));
  other = E.toggleFavourite(other, { type: 'radio', id: 'shared', name: 'Other name' }, T(4));      // older than local's copy
  other = E.toggleFavourite(other, { type: 'radio', id: STATION.id, name: 'Renamed' }, T(30));       // newer than local's copy
  other = E.setResume(other, EP_KEY(1), 1200, 3600, T(9));    // older: local wins
  other = E.setResume(other, EP_KEY(2), 200, 3600, T(11));    // newer: incoming wins
  other = E.setResume(other, EP_KEY(3), 300, 3600, T(12));    // new key
  other = E.subscribe(other, { title: 'Other', feedUrl: 'https://feeds.example.com/other.xml' }, T(25));
  other = E.queueAdd(other, VIDEO);
  other = E.queueAdd(other, STATION);
  other = E.startSleep(other, 99, T(26));
  const ex = J(E.libraryExport(other));
  ex.settings = { maxHeight: '480', theme: 'neon', dataSaver: true, httpsOnly: 'nope' };

  const merged = F(E.libraryImport(local, F(ex), T(40)));
  assert.equal(merged.updatedAt, T(40));
  deepEq(merged.favourites.map((f) => [f.id || f.url, f.name, f.updatedAt]), [
    [STATION.id, 'Renamed', T(30)], [VIDEO.url, undefined, T(20)], ['shared', 'Local name', T(5)]
  ], 'newest first, newer copy wins per key');
  deepEq(merged.resume, {
    [EP_KEY(1)]: { position: 600, duration: 3600, finished: false, updatedAt: T(10) },
    [EP_KEY(2)]: { position: 200, duration: 3600, finished: false, updatedAt: T(11) },
    [EP_KEY(3)]: { position: 300, duration: 3600, finished: false, updatedAt: T(12) }
  });
  deepEq(merged.subscriptions.map((s) => s.feedUrl), ['https://feeds.example.com/other.xml', FEED]);
  deepEq(keysOf(merged.queue), ['video:' + VIDEO.url, 'radio:' + STATION.id], 'queue appended without duplicates');
  deepEq(merged.settings, { httpsOnly: true, dataSaver: true, maxHeight: 480, autoplay: true, theme: 'dark', visualiser: true, startTab: 'radio' });
  deepEq(merged.sleep, local.sleep, 'the sleep timer does not travel');
  deepEq(keysOf(merged.recents), [EP_KEY(1)]);
  assert.equal(local.favourites.length, 2, 'input untouched');
  deepEq(J(E.libraryImport(local, JSON.stringify(ex), T(40))), J(merged), 'a JSON string imports the same');
});
test('libraryImport: junk or empty incoming is a no-op; an identical snapshot changes nothing', () => {
  const lib = F(E.toggleFavourite(E.libraryEmpty(), STATION, T(0)));
  ['', 'nope', '[]', '42', null, undefined, 7, [], [1], '{"favourites":"x"}', {}, E.libraryExport(E.libraryEmpty())].forEach((x) => assert.equal(E.libraryImport(lib, x, T(1)), lib, JSON.stringify(x)));
  assert.equal(E.libraryImport(lib, E.libraryExport(lib), T(1)), lib);
  assert.equal(E.libraryImport(lib, { settings: { theme: 'auto' } }, T(1)), lib, 'an explicit setting equal to the current one changes nothing');
  assert.equal(E.libraryImport(lib, { settings: { theme: 'light' } }, T(1)).settings.theme, 'light');
  deepEq(keysOf(E.libraryImport(null, E.libraryExport(lib), T(1)).favourites), ['radio:' + STATION.id], 'junk local is rebuilt');
});
test('libraryImport: caps apply after the union', () => {
  let a = E.libraryEmpty(), b = E.libraryEmpty();
  for (let i = 0; i < 400; i++) a = E.toggleFavourite(a, { type: 'radio', id: 'a' + i }, T(i));
  for (let i = 0; i < 400; i++) b = E.toggleFavourite(b, { type: 'radio', id: 'b' + i }, T(1000 + i));
  const m = E.libraryImport(a, E.libraryExport(b), T(5000));
  assert.equal(m.favourites.length, 500);
  assert.equal(m.favourites.filter((f) => f.id[0] === 'b').length, 400, 'all newer incoming kept');
  assert.equal(E.isFavourite(m, 'radio:a0'), false);
  assert.equal(E.isFavourite(m, 'radio:a399'), true);
});

/* ===================== media session ===================== */
test('mediaSessionMetadata: title/artist/album per type, artwork from the right image', () => {
  deepEq(E.mediaSessionMetadata(STATION), {
    title: 'SomaFM: Groove Salad', artist: 'The United States Of America · ambient, chillout, downtempo', album: 'Aerial radio',
    artwork: [{ src: STATION.favicon, sizes: '', type: 'image/jpeg' }]
  });
  deepEq(E.mediaSessionMetadata(F({ type: 'radio', id: 'x', name: 'Tagless', url: 'https://stream.example.org:8000/;' })), { title: 'Tagless', artist: '', album: 'Aerial radio', artwork: [] });
  deepEq(E.mediaSessionMetadata(F(EP(1, { author: 'Gretchen & Lauren' }))), {
    title: 'Episode 1', artist: 'Lingthusiasm', album: 'Gretchen & Lauren', artwork: [{ src: 'https://img.example.com/ling.jpg', sizes: '', type: 'image/jpeg' }]
  });
  deepEq(E.mediaSessionMetadata(F(EP(1, { show: null, image: 'https://img.example.com/ep1.webp' })), SHOW), {
    title: 'Episode 1', artist: 'Lingthusiasm', album: SHOW.author, artwork: [{ src: 'https://img.example.com/ep1.webp', sizes: '', type: 'image/webp' }]
  }, 'the show argument supplies show title and author');
  deepEq(E.mediaSessionMetadata(F({ type: 'podcast', id: 'g', feedUrl: FEED, title: 'Orphan' })), { title: 'Orphan', artist: 'Podcast', album: 'Aerial podcasts', artwork: [] });
  deepEq(E.mediaSessionMetadata(VIDEO), { title: 'Big Buck Bunny (HLS)', artist: 'test-streams.example.com', album: 'Aerial', artwork: [{ src: VIDEO.image, sizes: '', type: 'image/png' }] });
  deepEq(E.mediaSessionMetadata(F({ type: 'video', url: 'https://Media.Example.com:8443/live/stream.m3u8' })), { title: 'media.example.com', artist: 'media.example.com', album: 'Aerial', artwork: [] });
  deepEq(E.mediaSessionMetadata(SHOW), { title: 'Lingthusiasm', artist: SHOW.author, album: 'Aerial podcasts', artwork: [{ src: SHOW.image, sizes: '', type: 'image/jpeg' }] });
  deepEq(E.mediaSessionMetadata(F({ type: 'radio', id: 'x', favicon: 'https://x/icon.svg' })).artwork, [{ src: 'https://x/icon.svg', sizes: '', type: 'image/svg+xml' }]);
  deepEq(E.mediaSessionMetadata(F({ type: 'radio', id: 'x', favicon: 'https://x/icon' })).artwork, [{ src: 'https://x/icon', sizes: '', type: '' }]);
  [null, undefined, 'x', 1, [], {}].forEach((x) => deepEq(E.mediaSessionMetadata(x), { title: 'Aerial', artist: '', album: 'Aerial', artwork: [] }, JSON.stringify(x)));
  deepEq(E.mediaSessionMetadata(F({ type: 'radio', id: 'x', name: 'x'.repeat(500), favicon: 'data:image/png;base64,AAAA' })), { title: 'x'.repeat(300), artist: '', album: 'Aerial radio', artwork: [] });
});

/* ===================== share links ===================== */
test('shareLink: baseUrl + #play=&title=&type=, encoded; an existing hash on the base is replaced', () => {
  assert.equal(E.shareLink(STATION, 'https://x.app/aerial/'), 'https://x.app/aerial/#play=https%3A%2F%2Fice1.somafm.com%2Fgroovesalad-128-mp3&title=SomaFM%3A%20Groove%20Salad&type=radio');
  assert.equal(E.shareLink(VIDEO, 'https://x.app/aerial/index.html#play=old'), 'https://x.app/aerial/index.html#play=' + encodeURIComponent(VIDEO.url) + '&title=Big%20Buck%20Bunny%20(HLS)&type=video');
  assert.equal(E.shareLink(SHOW, 'https://x.app/'), 'https://x.app/#play=' + encodeURIComponent(FEED) + '&title=Lingthusiasm&type=show');
  assert.equal(E.shareLink(F(EP(1)), ''), '#play=https%3A%2F%2Fcdn.example.com%2Fep1.mp3&title=Episode%201&type=podcast');
  assert.equal(E.shareLink(F({ type: 'video', url: 'https://h/v.mp4' }), null), '#play=https%3A%2F%2Fh%2Fv.mp4&type=video', 'no title, junk base');
  assert.equal(E.shareLink(F({ url: 'https://h/v.mp4', title: 'typeless' }), 'https://x.app/'), 'https://x.app/#play=https%3A%2F%2Fh%2Fv.mp4&title=typeless');
  [null, 'x', {}, { type: 'radio', id: 'x' }, { type: 'video', url: 'javascript:alert(1)' }, { type: 'video', url: 'http://' }, { type: 'show', feedUrl: 'feed://x' },
    { type: 'video', url: 'https://h/' + 'a'.repeat(2100) }, { type: 'video', url: 'https://h/a b' }].forEach((x) => assert.equal(E.shareLink(F(x), 'https://x.app/'), null, JSON.stringify(x)));
});
test('share hash round trip: ascii, unicode, emoji, injection attempts, a 200-char title cap', () => {
  const titles = ['Plain', 'Café ☕ — “quotes” & <b>bold</b>', '日本語のタイトル', '🎧🎶 emoji 🎙️', 'a&b=c#d%e+f', '  spaced   out  ', '<script>alert(1)</script>', '"; DROP TABLE; --', 'x'.repeat(400), 'ends with emoji ' + '😀'.repeat(100)];
  titles.forEach((title) => {
    const item = F({ type: 'video', url: 'https://h/v.mp4?a=1&b=2#frag', title });
    const link = E.shareLink(item, 'https://x.app/aerial/');
    assert.equal(link.indexOf('https://x.app/aerial/#play='), 0);
    const parsed = E.parseShareHash(link.slice(link.indexOf('#')));
    assert.equal(parsed.url, 'https://h/v.mp4?a=1&b=2#frag');
    assert.equal(parsed.type, 'video');
    const want = title.replace(/\s+/g, ' ').trim();
    assert.equal(parsed.title, want.length > 200 ? parsed.title : want, title.slice(0, 20));
    assert.equal(parsed.title.length <= 200, true);
    assert.doesNotThrow(() => encodeURIComponent(parsed.title), 'never a lone surrogate');
    deepEq(E.parseShareHash(link), parsed, 'a whole URL parses the same as its hash');
  });
  const lone = E.shareLink(F({ type: 'video', url: 'https://h/v.mp4', title: 'broken \ud83d surrogate' }), '');
  assert.equal(lone, '#play=https%3A%2F%2Fh%2Fv.mp4&title=broken%20%EF%BF%BD%20surrogate&type=video', 'a lone surrogate becomes U+FFFD rather than a throw');
});
test('parseShareHash: # optional, http(s) only, ≤ 2048, first occurrence decides, junk → null', () => {
  deepEq(E.parseShareHash('play=https%3A%2F%2Fh%2Fs.mp3'), { url: 'https://h/s.mp3', title: '', type: null });
  deepEq(E.parseShareHash('#play=http://h/s.mp3&type=radio&title=Hi'), { url: 'http://h/s.mp3', title: 'Hi', type: 'radio' });
  deepEq(E.parseShareHash('#title=First&play=https://h/a&play=https://h/b&title=Second&type=junk&type=video'), { url: 'https://h/a', title: 'First', type: null }, 'first play, first title, first type (invalid) decide');
  deepEq(E.parseShareHash('#play=javascript:alert(1)&play=https://h/ok'), null, 'a junk first play is not rescued by a second');
  deepEq(E.parseShareHash('#foo=1&play=https://h/x&bar'), { url: 'https://h/x', title: '', type: null }, 'unknown params ignored');
  deepEq(E.parseShareHash('#play=https://h/x&title=%E2%9C%93%20ok%ZZ%E2'), { url: 'https://h/x', title: '✓ ok%ZZ%E2', type: null }, 'valid escape runs decode, a stray % or truncated sequence stays as typed');
  deepEq(E.parseShareHash('#play=https://h/x?q=100%&title=100%25%20real'), { url: 'https://h/x?q=100%', title: '100% real', type: null });
  deepEq(E.parseShareHash('#play=https://h/x&title=line%0Abreak%00nul'), { url: 'https://h/x', title: 'line breaknul', type: null }, 'newline-class controls become spaces, NUL vanishes');
  deepEq(E.parseShareHash('#%70lay=https://h/x'), { url: 'https://h/x', title: '', type: null }, 'encoded key decoded');
  deepEq(E.parseShareHash('#play=' + encodeURIComponent('https://h/' + 'a'.repeat(2030))), { url: 'https://h/' + 'a'.repeat(2030), title: '', type: null });
  const junk = ['', '#', '#play=', '#play', '#title=x', 'play=ftp://h/x', '#play=data:text/html,hi', '#play=javascript:alert(1)', '#play=//h/x', '#play=https://', '#play=http://h/x y',
    '#play=' + encodeURIComponent('https://h/' + 'a'.repeat(2100)), '#play=https://h/x%0d%0aLocation:evil', null, undefined, 42, {}, [], ['#play=https://h/x'], 'x'.repeat(20000) + '&play=https://h/x'];
  junk.forEach((h) => assert.equal(E.parseShareHash(h), null, String(JSON.stringify(h)).slice(0, 60)));
});

/* ===================== stats ===================== */
test('libraryStats: counts by container and favourites by type', () => {
  let lib = E.libraryEmpty();
  deepEq(E.libraryStats(lib), { favourites: 0, favouritesByType: { radio: 0, podcast: 0, video: 0, show: 0 }, recents: 0, subscriptions: 0, queue: 0, resume: 0, inProgress: 0, finished: 0 });
  lib = E.toggleFavourite(lib, STATION, T(0));
  lib = E.toggleFavourite(lib, STATION_HLS, T(0));
  lib = E.toggleFavourite(lib, EP(1), T(0));
  lib = E.toggleFavourite(lib, SHOW, T(0));
  lib = E.recordPlay(lib, VIDEO, T(1));
  lib = E.subscribe(lib, SHOW, T(1));
  lib = E.queueAdd(lib, VIDEO);
  lib = E.setResume(lib, EP_KEY(1), 100, 200, T(2));
  lib = E.setResume(lib, EP_KEY(2), 199, 200, T(2));
  lib = E.setResume(lib, 'video:' + VIDEO.url, 199, 200, T(2));
  deepEq(E.libraryStats(F(lib)), { favourites: 4, favouritesByType: { radio: 2, podcast: 1, video: 0, show: 1 }, recents: 1, subscriptions: 1, queue: 1, resume: 3, inProgress: 1, finished: 2 });
  deepEq(E.libraryStats(null), E.libraryStats(E.libraryEmpty()));
});

/* ===================== determinism ===================== */
test('determinism: the same sequence of operations yields byte-identical libraries, exports and links', () => {
  const build = () => {
    let lib = E.libraryEmpty();
    for (let i = 0; i < 80; i++) {
      lib = E.toggleFavourite(lib, { type: 'radio', id: 'st' + (i % 50), name: 'Station ' + i, tags: ['Jazz', 'LoFi'] }, T(i));
      lib = E.recordPlay(lib, EP(i % 70), T(i));
      lib = E.setResume(lib, EP_KEY(i % 70), 10 + i * 7, 600, T(i));
      lib = E.queueAdd(lib, { type: 'video', url: 'https://h/' + (i % 30) + '.mp4' });
      if (i % 9 === 0) lib = E.subscribe(lib, { title: 'S' + i, feedUrl: 'https://feeds.example.com/' + i + '.xml' }, T(i));
      if (i % 11 === 0) lib = E.setSetting(lib, 'maxHeight', [360, 480, 720][i % 3], T(i));
    }
    lib = E.libraryImport(lib, E.libraryExport(E.recordPlay(E.libraryEmpty(), STATION, T(500))), T(600));
    return lib;
  };
  const a = build(), b = build();
  assert.equal(E.librarySerialize(a), E.librarySerialize(b));
  assert.equal(JSON.stringify(E.libraryExport(a)), JSON.stringify(E.libraryExport(b)));
  assert.equal(JSON.stringify(E.continueListening(a)), JSON.stringify(E.continueListening(b)));
  assert.equal(JSON.stringify(E.libraryStats(a)), JSON.stringify(E.libraryStats(b)));
  assert.equal(E.shareLink(a.favourites[0], 'https://x.app/'), E.shareLink(b.favourites[0], 'https://x.app/'));
  assert.equal(E.librarySerialize(E.libraryDeserialize(E.librarySerialize(a))), E.librarySerialize(a), 'serialise is a fixed point');
});

/* ===================== junk sweep ===================== */
test('junk sweep: every export survives every junk argument without throwing', () => {
  const junk = [undefined, null, 0, -1, 1e21, NaN, Infinity, '', 'x', '__proto__', 'radio:x', '{', [], [null], {}, { type: 'radio' }, { type: 'video', url: 'https://h/x' },
    F({ favourites: 1, recents: 'a', resume: [], subscriptions: null, queue: {}, settings: 3, sleep: 9, updatedAt: 'now' }), () => 1, Symbol('s'), 12345678901234567890n, new Date(NOW), /re/];
  const fns = Object.keys(E.library).filter((k) => typeof E[k] === 'function');
  assert.equal(fns.length, 32);
  fns.forEach((name) => {
    junk.forEach((a) => junk.forEach((b) => {
      assert.doesNotThrow(() => E[name](a, b, a, b, a), `${name}(${String(a)}, ${String(b)})`);
    }));
    assert.doesNotThrow(() => E[name](), name + '()');
  });
});

run();

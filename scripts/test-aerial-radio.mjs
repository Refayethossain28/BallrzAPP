#!/usr/bin/env node
// Tests for the RADIO section of the Aerial engine: Radio Browser API URL builders (exact query strings),
// station normalisation from realistic raw directory records (padded names, comma tags, numbers-as-strings,
// nulls, missing fields), dedupe/rank/filter tables, badges, click rate limiting, the curated browse lists,
// the built-in starter list, search planning, and a junk sweep over every export.
// Run: node scripts/test-aerial-radio.mjs
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
const { test, run, assert } = runner('radio');
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60 * 1000;
const S = 'https://de1.api.radio-browser.info';
const S2 = 'https://nl1.api.radio-browser.info';
const UUID_A = '960b4e0b-0601-11e8-ae97-52543be04c81';
const UUID_B = '9617a958-0601-11e8-ae97-52543be04c81';

/* ---------- realistic raw records, as the directory sends them ---------- */
const RAW_GROOVE = {
  changeuuid: '9b6f5f5a-0601-11e8-ae97-52543be04c81', stationuuid: UUID_A,
  serveruuid: null, name: '  SomaFM: Groove Salad  ',
  url: 'http://ice1.somafm.com/groovesalad-128-mp3', url_resolved: 'https://ice1.somafm.com/groovesalad-128-mp3',
  homepage: 'https://somafm.com/groovesalad/', favicon: 'https://somafm.com/img3/groovesalad-400.jpg',
  tags: 'ambient, Chillout,downtempo,electronic,,ambient', country: 'The United States Of America', countrycode: 'US',
  iso_3166_2: 'US-CA', state: 'California', language: 'English,french', languagecodes: 'en,fr',
  votes: '12345', lastchangetime: '2024-01-02 03:04:05', lastchangetime_iso8601: '2024-01-02T03:04:05Z',
  codec: 'mp3', bitrate: '128', hls: 0, lastcheckok: 1, lastchecktime: '2026-10-15 11:00:00',
  lastcheckoktime: '2026-10-15 11:00:00', lastlocalchecktime: '', clicktimestamp: '2026-10-16 10:00:00',
  clickcount: 4567, clicktrend: '12', ssl_error: 0, geo_lat: '37.77', geo_long: -122.42, has_extended_info: false
};
const RAW_HLS = {
  stationuuid: UUID_B, name: 'BBC Radio 4', url: 'https://as-hls-ww-live.akamaized.net/pool_904/live/ww/bbc_radio_fourfm/bbc_radio_fourfm.isml/bbc_radio_fourfm-audio%3d96000.norewind.m3u8',
  url_resolved: '', homepage: 'http://www.bbc.co.uk/radio4', favicon: '', tags: 'news,talk,bbc', country: 'The United Kingdom Of Great Britain And Northern Ireland',
  countrycode: 'GB', state: '', language: 'english', votes: 9000, codec: 'AAC', bitrate: 96, hls: '1', lastcheckok: '1',
  clickcount: '20000', clicktrend: -3, ssl_error: 0, geo_lat: null, geo_long: null
};
const RAW_SPARSE = { stationuuid: 'c1a5d5b2-1234-4abc-9def-0123456789ab', url: 'http://stream.example.org:8000/;' };

/* ===================== servers ===================== */
test('RADIO_SERVERS: the six documented mirrors, all https, "all" alias last', () => {
  deepEq(E.RADIO_SERVERS, [
    'https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info', 'https://fi1.api.radio-browser.info',
    'https://at1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://all.api.radio-browser.info'
  ]);
});
test('radioNextServer: walks the list and wraps; junk restarts at 0', () => {
  deepEq([0, 1, 2, 3, 4, 5].map(E.radioNextServer), [1, 2, 3, 4, 5, 0]);
  deepEq([null, undefined, -1, 99, NaN, 'x', '2', 2.9, {}, []].map(E.radioNextServer), [0, 0, 0, 0, 0, 0, 3, 3, 0, 0]);
});
test('RADIO_CLICK_INTERVAL is ten minutes', () => assert.equal(E.RADIO_CLICK_INTERVAL, 10 * MIN));

/* ===================== radioUrl ===================== */
test('radioUrl: server + path + encoded params in insertion order', () => {
  assert.equal(E.radioUrl(S, '/json/stations/search', { name: 'Radio Café', limit: 10 }), S + '/json/stations/search?name=Radio%20Caf%C3%A9&limit=10');
  assert.equal(E.radioUrl(S, '/json/countries'), S + '/json/countries');
  assert.equal(E.radioUrl(S, '/json/countries', {}), S + '/json/countries');
});
test('radioUrl: trailing slashes on the server and a missing leading slash on the path are normalised', () => {
  assert.equal(E.radioUrl(S + '///', 'json/tags', { limit: 5 }), S + '/json/tags?limit=5');
  assert.equal(E.radioUrl(' ' + S2 + '/ ', '/json/tags'), S2 + '/json/tags');
});
test('radioUrl: null/undefined/empty/NaN/object values are skipped; booleans become true/false', () => {
  assert.equal(E.radioUrl(S, '/p', { a: null, b: undefined, c: '', d: NaN, e: Infinity, f: {}, g: () => 1, h: true, i: false, j: 0 }), S + '/p?h=true&i=false&j=0');
  assert.equal(E.radioUrl(S, '/p', { a: null }), S + '/p');
});
test('radioUrl: arrays are comma-joined (entries encoded), empty/junk arrays skipped, nested arrays dropped', () => {
  assert.equal(E.radioUrl(S, '/p', { tagList: ['jazz', 'smooth jazz', '', null, 7, true] }), S + '/p?tagList=jazz%2Csmooth%20jazz%2C7%2Ctrue');
  assert.equal(E.radioUrl(S, '/p', { tagList: [], x: [null, ''], y: [['nested'], 'kept'] }), S + '/p?y=kept');
});
test('radioUrl: unicode, spaces, ampersands, plus, hash and slashes are percent-encoded; keys too', () => {
  assert.equal(E.radioUrl(S, '/p', { 'na me': 'a&b=c+d/e#f?g', q: 'Ünïcødé 日本' }), S + '/p?na%20me=a%26b%3Dc%2Bd%2Fe%23f%3Fg&q=%C3%9Cn%C3%AFc%C3%B8d%C3%A9%20%E6%97%A5%E6%9C%AC');
});
test('radioUrl: a lone surrogate (torn emoji) does not throw, it becomes U+FFFD', () => {
  assert.equal(E.radioUrl(S, '/p', { name: 'ab\ud83d' }), S + '/p?name=ab%EF%BF%BD');
  assert.equal(E.radioUrl(S, '/p', { name: '\udc00x' }), S + '/p?name=%EF%BF%BDx');
  assert.equal(E.radioUrl(S, '/p', { name: '😀' }), S + '/p?name=%F0%9F%98%80');
});
test('radioUrl: a junk server falls back to the first mirror; a junk path becomes "/"; query/hash in path dropped', () => {
  assert.equal(E.radioUrl(null, '/json/tags'), E.RADIO_SERVERS[0] + '/json/tags');
  assert.equal(E.radioUrl('ftp://nope', '/json/tags'), E.RADIO_SERVERS[0] + '/json/tags');
  assert.equal(E.radioUrl(42, null), E.RADIO_SERVERS[0] + '/');
  assert.equal(E.radioUrl(S, '/json/tags?inline=1#frag', { limit: 1 }), S + '/json/tags?limit=1');
  assert.equal(E.radioUrl(S, '/p', 'not an object'), S + '/p');
  assert.equal(E.radioUrl(S, '/p', [1, 2]), S + '/p');
});

/* ===================== radioSearchUrl ===================== */
test('radioSearchUrl: empty query → top-voted, broken hidden, 50 per page', () => {
  const want = S + '/json/stations/search?order=votes&reverse=true&limit=50&hidebroken=true';
  assert.equal(E.radioSearchUrl(S, {}), want);
  assert.equal(E.radioSearchUrl(S), want);
  assert.equal(E.radioSearchUrl(S, null), want);
  assert.equal(E.radioSearchUrl(S, 'jazz'), want);
});
test('radioSearchUrl: every documented field, exact string, fixed parameter order', () => {
  const url = E.radioSearchUrl(S2, {
    name: '  Radio   Café ', nameExact: false, tag: ' Smooth Jazz ', tagExact: true, tagList: ['Jazz', 'Blues'],
    country: 'United Kingdom', countryExact: true, countrycode: 'gb', state: 'London', language: 'English', languageExact: false,
    codec: 'aac', bitrateMin: '64', bitrateMax: 320, hasGeo: true, isHttps: true, order: 'clickcount', reverse: false,
    limit: 20, offset: 40, hideBroken: false
  });
  assert.equal(url, S2 + '/json/stations/search?name=Radio%20Caf%C3%A9&nameExact=false&tag=smooth%20jazz&tagExact=true&tagList=jazz%2Cblues'
    + '&country=United%20Kingdom&countryExact=true&countrycode=GB&state=London&language=english&languageExact=false&codec=AAC'
    + '&bitrateMin=64&bitrateMax=320&has_geo_info=true&is_https=true&order=clickcount&reverse=false&offset=40&limit=20&hidebroken=false');
});
test('radioSearchUrl: order is validated; default reverse follows the order ("bigger is better" → true)', () => {
  const tail = (o, r) => S + '/json/stations/search?order=' + o + '&reverse=' + r + '&limit=50&hidebroken=true';
  assert.equal(E.radioSearchUrl(S, { order: 'name' }), tail('name', 'false'));
  assert.equal(E.radioSearchUrl(S, { order: 'random' }), tail('random', 'false'));
  assert.equal(E.radioSearchUrl(S, { order: 'bitrate' }), tail('bitrate', 'true'));
  assert.equal(E.radioSearchUrl(S, { order: 'clicktrend' }), tail('clicktrend', 'true'));
  assert.equal(E.radioSearchUrl(S, { order: 'ClickCount ' }), tail('clickcount', 'true'));
  assert.equal(E.radioSearchUrl(S, { order: 'drop table' }), tail('votes', 'true'));
  assert.equal(E.radioSearchUrl(S, { order: 42 }), tail('votes', 'true'));
  assert.equal(E.radioSearchUrl(S, { order: 'name', reverse: true }), tail('name', 'true'));
  assert.equal(E.radioSearchUrl(S, { order: 'votes', reverse: 'yes' }), tail('votes', 'true'));
});
test('radioSearchUrl: limit is clamped to 1..1000 and parsed from strings; offset only when positive', () => {
  const q = (extra) => E.radioSearchUrl(S, extra).split('?')[1];
  assert.equal(q({ limit: 0 }), 'order=votes&reverse=true&limit=1&hidebroken=true');
  assert.equal(q({ limit: -5 }), 'order=votes&reverse=true&limit=1&hidebroken=true');
  assert.equal(q({ limit: 99999 }), 'order=votes&reverse=true&limit=1000&hidebroken=true');
  assert.equal(q({ limit: '25' }), 'order=votes&reverse=true&limit=25&hidebroken=true');
  assert.equal(q({ limit: 7.9 }), 'order=votes&reverse=true&limit=7&hidebroken=true');
  assert.equal(q({ limit: 'lots' }), 'order=votes&reverse=true&limit=50&hidebroken=true');
  assert.equal(q({ offset: 0 }), 'order=votes&reverse=true&limit=50&hidebroken=true');
  assert.equal(q({ offset: -3 }), 'order=votes&reverse=true&limit=50&hidebroken=true');
  assert.equal(q({ offset: '100' }), 'order=votes&reverse=true&offset=100&limit=50&hidebroken=true');
});
test('radioSearchUrl: country code must be two letters (uppercased); junk codes are dropped', () => {
  const q = (cc) => E.radioSearchUrl(S, { countrycode: cc }).split('?')[1];
  assert.equal(q('de'), 'countrycode=DE&order=votes&reverse=true&limit=50&hidebroken=true');
  assert.equal(q(' Fr '), 'countrycode=FR&order=votes&reverse=true&limit=50&hidebroken=true');
  for (const junk of ['GBR', 'G', '12', '', null, 7, {}, 'a b']) assert.equal(q(junk), 'order=votes&reverse=true&limit=50&hidebroken=true', String(junk));
});
test('radioSearchUrl: tag list as a comma string works too; isHttps/hideBroken accept only real booleans (or "true"/"false")', () => {
  const q = (o) => E.radioSearchUrl(S, o).split('?')[1];
  assert.equal(q({ tagList: 'Jazz, blues,,' }), 'tagList=jazz%2Cblues&order=votes&reverse=true&limit=50&hidebroken=true');
  assert.equal(q({ isHttps: 'true', hideBroken: 'false' }), 'is_https=true&order=votes&reverse=true&limit=50&hidebroken=false');
  assert.equal(q({ isHttps: 1, hideBroken: 0 }), 'order=votes&reverse=true&limit=50&hidebroken=true');
  assert.equal(q({ isHttps: false }), 'is_https=false&order=votes&reverse=true&limit=50&hidebroken=true');
  assert.equal(q({ bitrateMin: -1, bitrateMax: 'x', name: null, tag: {}, country: [] }), 'order=votes&reverse=true&limit=50&hidebroken=true');
});
test('radioSearchUrl: a search plan can be passed straight in', () => {
  const plan = E.radioSearchPlan('smooth jazz uk');
  assert.equal(E.radioSearchUrl(S, Object.assign({}, plan, { limit: 10 })).split('?')[1],
    'name=smooth&tag=jazz&country=United%20Kingdom&countrycode=GB&order=votes&reverse=true&limit=10&hidebroken=true');
});

/* ===================== list endpoints ===================== */
test('radioTopUrl: votes/clicks use the list endpoints, trend is a click-trend search', () => {
  assert.equal(E.radioTopUrl(S, 'votes', 30), S + '/json/stations/topvote/30?hidebroken=true');
  assert.equal(E.radioTopUrl(S, 'clicks', 30), S + '/json/stations/topclick/30?hidebroken=true');
  assert.equal(E.radioTopUrl(S, 'trend', 30), S + '/json/stations/search?order=clicktrend&reverse=true&limit=30&hidebroken=true');
});
test('radioTopUrl: unknown kind → votes; limit defaults to 50 and is clamped', () => {
  assert.equal(E.radioTopUrl(S, 'nope'), S + '/json/stations/topvote/50?hidebroken=true');
  assert.equal(E.radioTopUrl(S, null, null), S + '/json/stations/topvote/50?hidebroken=true');
  assert.equal(E.radioTopUrl(S, 'CLICKS ', '5'), S + '/json/stations/topclick/5?hidebroken=true');
  assert.equal(E.radioTopUrl(S, 'votes', 1e9), S + '/json/stations/topvote/1000?hidebroken=true');
  assert.equal(E.radioTopUrl(S, 'votes', -1), S + '/json/stations/topvote/1?hidebroken=true');
  assert.equal(E.radioTopUrl(undefined, 'trend', 'x'), E.RADIO_SERVERS[0] + '/json/stations/search?order=clicktrend&reverse=true&limit=50&hidebroken=true');
});
test('radioTagsUrl: most-used first by default, alphabetical on request, limit 100 default', () => {
  assert.equal(E.radioTagsUrl(S), S + '/json/tags?order=stationcount&reverse=true&limit=100&hidebroken=true');
  assert.equal(E.radioTagsUrl(S, { limit: 25 }), S + '/json/tags?order=stationcount&reverse=true&limit=25&hidebroken=true');
  assert.equal(E.radioTagsUrl(S, { order: 'name', limit: '10' }), S + '/json/tags?order=name&reverse=false&limit=10&hidebroken=true');
  assert.equal(E.radioTagsUrl(S, { order: 'bogus' }), S + '/json/tags?order=stationcount&reverse=true&limit=100&hidebroken=true');
  assert.equal(E.radioTagsUrl(S, 'junk'), S + '/json/tags?order=stationcount&reverse=true&limit=100&hidebroken=true');
});
test('radioCountriesUrl / radioLanguagesUrl', () => {
  assert.equal(E.radioCountriesUrl(S), S + '/json/countries?order=stationcount&reverse=true&hidebroken=true');
  assert.equal(E.radioLanguagesUrl(S2), S2 + '/json/languages?order=stationcount&reverse=true&hidebroken=true');
  assert.equal(E.radioCountriesUrl(), E.RADIO_SERVERS[0] + '/json/countries?order=stationcount&reverse=true&hidebroken=true');
});

/* ===================== uuid endpoints ===================== */
test('radioClickUrl / radioVoteUrl: real UUIDs only, lowercased and trimmed', () => {
  assert.equal(E.radioClickUrl(S, UUID_A), S + '/json/url/' + UUID_A);
  assert.equal(E.radioVoteUrl(S, UUID_A), S + '/json/vote/' + UUID_A);
  assert.equal(E.radioClickUrl(S, '  ' + UUID_A.toUpperCase() + ' '), S + '/json/url/' + UUID_A);
});
test('radioClickUrl / radioVoteUrl: starter ids, path tricks and junk → null', () => {
  for (const bad of ['starter:groovesalad', '../json/stations', UUID_A + '/x', UUID_A.slice(1), '', null, undefined, 42, {}, [], [UUID_A], 'zzzzzzzz-0601-11e8-ae97-52543be04c81']) {
    assert.equal(E.radioClickUrl(S, bad), null, 'click ' + String(bad));
    assert.equal(E.radioVoteUrl(S, bad), null, 'vote ' + String(bad));
  }
});
test('radioByUuidUrl: joined, deduped, validated; single string accepted; nothing valid → null', () => {
  assert.equal(E.radioByUuidUrl(S, [UUID_A, UUID_B]), S + '/json/stations/byuuid?uuids=' + UUID_A + '%2C' + UUID_B);
  assert.equal(E.radioByUuidUrl(S, [UUID_A, UUID_A.toUpperCase(), 'junk', null, UUID_B]), S + '/json/stations/byuuid?uuids=' + UUID_A + '%2C' + UUID_B);
  assert.equal(E.radioByUuidUrl(S, UUID_B), S + '/json/stations/byuuid?uuids=' + UUID_B);
  for (const bad of [[], ['x', null], null, 'nope', 7, {}, [[UUID_A]]]) assert.equal(E.radioByUuidUrl(S, bad), null, JSON.stringify(bad));
});
test('radioByUuidUrl: caps at 100 ids', () => {
  const ids = Array.from({ length: 150 }, (_, i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0'));
  const url = E.radioByUuidUrl(S, ids);
  assert.equal(decodeURIComponent(url.split('uuids=')[1]).split(',').length, 100);
});

/* ===================== radioNormalizeStation ===================== */
test('radioNormalizeStation: a full realistic record', () => {
  deepEq(E.radioNormalizeStation(RAW_GROOVE), {
    type: 'radio', id: UUID_A, name: 'SomaFM: Groove Salad',
    url: 'https://ice1.somafm.com/groovesalad-128-mp3', homepage: 'https://somafm.com/groovesalad/', favicon: 'https://somafm.com/img3/groovesalad-400.jpg',
    tags: ['ambient', 'chillout', 'downtempo', 'electronic'], country: 'The United States Of America', countryCode: 'US', state: 'California',
    language: 'english,french', languages: ['english', 'french'], codec: 'MP3', bitrate: 128, votes: 12345, clicks: 4567, clickTrend: 12,
    https: true, hls: false, ok: true, sslError: false, geo: { lat: 37.77, lon: -122.42 }
  });
});
test('radioNormalizeStation: hls flag as string, empty url_resolved falls back to url, http homepage kept, negative trend', () => {
  const st = E.radioNormalizeStation(RAW_HLS);
  assert.equal(st.url, RAW_HLS.url);
  assert.equal(st.hls, true);
  assert.equal(st.https, true);
  assert.equal(st.ok, true);
  assert.equal(st.homepage, 'http://www.bbc.co.uk/radio4');
  assert.equal(st.favicon, '');
  assert.equal(st.clicks, 20000);
  assert.equal(st.clickTrend, -3);
  assert.equal(st.geo, null);
  deepEq(st.tags, ['news', 'talk', 'bbc']);
});
test('radioNormalizeStation: a sparse record gets defaults; name falls back to the host', () => {
  deepEq(E.radioNormalizeStation(RAW_SPARSE), {
    type: 'radio', id: 'c1a5d5b2-1234-4abc-9def-0123456789ab', name: 'stream.example.org', url: 'http://stream.example.org:8000/;',
    homepage: '', favicon: '', tags: [], country: '', countryCode: '', state: '', language: '', languages: [], codec: 'UNKNOWN',
    bitrate: 0, votes: 0, clicks: 0, clickTrend: 0, https: false, hls: false, ok: false, sslError: false, geo: null
  });
});
test('radioNormalizeStation: hls from a .m3u8 url or a codec of "HLS"; ssl_error and lastcheckok as "1"/1/true', () => {
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://x.org/live/playlist.m3u8?x=1' }).hls, true);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://x.org/live', codec: 'hls' }).hls, true);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://x.org/live', codec: 'hls' }).codec, 'HLS');
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://x.org/live', hls: 1 }).hls, true);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://x.org/live', hls: '0' }).hls, false);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://x.org/live', ssl_error: '1' }).sslError, true);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://x.org/live', lastcheckok: true }).ok, true);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://x.org/live', lastcheckok: '0' }).ok, false);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://x.org/live', lastcheckok: 2 }).ok, false);
});
test('radioNormalizeStation: url_resolved wins only when it is a real http(s) url; non-http streams → null', () => {
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'http://a.org/s', url_resolved: 'https://b.org/s' }).url, 'https://b.org/s');
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'http://a.org/s', url_resolved: 'garbage' }).url, 'http://a.org/s');
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'http://a.org/s', url_resolved: null }).url, 'http://a.org/s');
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: ' http://a.org/s ' }).url, 'http://a.org/s');
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'rtmp://a.org/s' }), null);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'mms://a.org/s', url_resolved: 'rtsp://b' }), null);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://' }), null);
});
test('radioNormalizeStation: missing id or url → null; junk input → null', () => {
  assert.equal(E.radioNormalizeStation({ url: 'https://a.org/s' }), null);
  assert.equal(E.radioNormalizeStation({ stationuuid: '   ', url: 'https://a.org/s' }), null);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a' }), null);
  assert.equal(E.radioNormalizeStation({ stationuuid: 'a', url: '' }), null);
  for (const junk of [null, undefined, 'string', 42, true, [], [RAW_GROOVE], () => 1]) assert.equal(E.radioNormalizeStation(junk), null, String(junk));
});
test('radioNormalizeStation: numbers-as-strings, junk numbers, negative counts, long names', () => {
  const st = E.radioNormalizeStation({ stationuuid: 'a', url: 'https://a.org/s', votes: '-5', bitrate: 'high', clickcount: '1e3', clicktrend: '2.7', name: 'x'.repeat(500) });
  assert.equal(st.votes, 0);
  assert.equal(st.bitrate, 0);
  assert.equal(st.clicks, 1000);
  assert.equal(st.clickTrend, 2);
  assert.equal(st.name.length, 200);
  const st2 = E.radioNormalizeStation({ stationuuid: 12345, url: 'https://a.org/s', name: 101, votes: 3.9, bitrate: '64.5', codec: '  aac+ ' });
  assert.equal(st2.id, '12345');
  assert.equal(st2.name, '101');
  assert.equal(st2.votes, 3);
  assert.equal(st2.bitrate, 64);
  assert.equal(st2.codec, 'AAC+');
});
test('radioNormalizeStation: bidi overrides, zero-width space, word joiner, BOM and controls are stripped from text; ZWJ/ZWNJ survive', () => {
  const raw = (name, extra) => Object.assign({ stationuuid: 'u', url: 'https://h/s', name: name }, extra || {});
  const st = E.radioNormalizeStation(raw('SomaFM\u202e detaredom\u2066\u200b\ufeff', { country: 'A\u0000B\u2069\u2060', tags: 'ja\u202azz, rock', codec: 'M\u200bP3', state: 'tab\tand\r\nnewline' }));
  assert.equal(st.name, 'SomaFM detaredom');
  assert.equal(st.country, 'AB');
  assert.equal(st.tags.join(','), 'jazz,rock');
  assert.equal(st.codec, 'MP3');
  assert.equal(st.state, 'tab and newline', 'whitespace controls become one space');
  for (const ch of ['\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\u200b', '\u2060', '\ufeff', '\u0000', '\u001f', '\u007f', '\u009f']) {
    assert.equal(E.radioNormalizeStation(raw('a' + ch + 'b')).name, 'ab', 'U+' + ch.charCodeAt(0).toString(16));
  }
  const kept = 'ZWJ 👨\u200d👩\u200d👧 ZWNJ می\u200cخواهم LRM \u200e RLM \u200f é 中';
  assert.equal(E.radioNormalizeStation(raw(kept)).name, kept, 'emoji joiners, Persian ZWNJ, bidi marks and plain Unicode are not touched');
  // an invisible character no longer makes a lookalike that dodges dedupe
  const d = E.radioDedupe([{ name: 'Soma\u200bFM', url: 'https://h/a', votes: 1 }, { name: 'SomaFM', url: 'https://h/b', votes: 5 }]);
  assert.equal(d.length, 1);
  assert.equal(d[0].votes, 5);
});
test('radioNormalizeStation: nested junk in every field never throws and degrades to defaults', () => {
  const st = E.radioNormalizeStation({ stationuuid: 'a', url: 'https://a.org/s', name: {}, tags: { a: 1 }, country: [], countrycode: null, language: 7, codec: [], bitrate: {}, votes: [], hls: 'yes', lastcheckok: 'ok', geo_lat: 'north', geo_long: {}, homepage: 5, favicon: ['x'] });
  assert.equal(st.name, 'a.org');
  deepEq(st.tags, []);
  assert.equal(st.country, '');
  assert.equal(st.language, '7');
  deepEq(st.languages, ['7']);
  assert.equal(st.codec, 'UNKNOWN');
  assert.equal(st.hls, false);
  assert.equal(st.ok, false);
  assert.equal(st.geo, null);
  assert.equal(st.homepage, '');
  assert.equal(st.favicon, '');
});
test('radioNormalizeStation: geo accepts numbers or numeric strings, rejects out-of-range, nulls and the 0,0 placeholder', () => {
  const geo = (lat, lon) => E.radioNormalizeStation({ stationuuid: 'a', url: 'https://a.org/s', geo_lat: lat, geo_long: lon }).geo;
  deepEq(geo(51.5, -0.12), { lat: 51.5, lon: -0.12 });
  deepEq(geo('51.5', ' -0.12 '), { lat: 51.5, lon: -0.12 });
  deepEq(geo(-33.9, 151.2), { lat: -33.9, lon: 151.2 });
  assert.equal(geo(null, null), null);
  assert.equal(geo(undefined, 1), null);
  assert.equal(geo(91, 0), null);
  assert.equal(geo(0, 181), null);
  assert.equal(geo(0, 0), null);
  assert.equal(geo('', ''), null);
  assert.equal(geo(NaN, 1), null);
});
test('radioNormalizeStation: tags/languages are lowercased, trimmed, deduped and capped; arrays accepted', () => {
  const st = E.radioNormalizeStation({ stationuuid: 'a', url: 'https://a.org/s', tags: ' Jazz , JAZZ,smooth jazz ,,  ,Blues', language: ' English , english,Deutsch ' });
  deepEq(st.tags, ['jazz', 'smooth jazz', 'blues']);
  assert.equal(st.language, 'english , english,deutsch');
  deepEq(st.languages, ['english', 'deutsch']);
  const many = E.radioNormalizeStation({ stationuuid: 'a', url: 'https://a.org/s', tags: Array.from({ length: 100 }, (_, i) => 't' + i).join(',') });
  assert.equal(many.tags.length, 40);
  deepEq(E.radioNormalizeStation({ stationuuid: 'a', url: 'https://a.org/s', tags: ['Rock', 'rock', 3, null, {}] }).tags, ['rock', '3']);
});
test('radioNormalizeStation: re-normalising a normalised station is the identity (library round trip)', () => {
  const once = E.radioNormalizeStation(RAW_GROOVE), twice = E.radioNormalizeStation(once);
  deepEq(twice, once);
  const hls1 = E.radioNormalizeStation(RAW_HLS);
  deepEq(E.radioNormalizeStation(hls1), hls1);
  const sparse = E.radioNormalizeStation(RAW_SPARSE);
  deepEq(E.radioNormalizeStation(sparse), sparse);
});
test('radioNormalizeStation: deterministic and does not mutate its input', () => {
  const copy = JSON.parse(JSON.stringify(RAW_GROOVE));
  const a = E.radioNormalizeStation(copy), b = E.radioNormalizeStation(copy);
  deepEq(a, b);
  deepEq(copy, RAW_GROOVE);
});

/* ===================== radioDedupe ===================== */
const dup = (name, url, votes, id) => ({ id: id || name + url, name, url, votes });
test('radioDedupe: same name (case/whitespace-insensitive) + same host collapse; most votes wins', () => {
  const list = [dup('Jazz FM', 'http://a.org/s', 5, 'x'), dup('  jazz   fm ', 'https://a.org:8000/other', 50, 'y'), dup('JAZZ FM', 'https://a.org/s', 20, 'z')];
  deepEq(E.radioDedupe(list).map((s) => s.id), ['y']);
});
test('radioDedupe: equal votes → the https copy wins; equal again → the earlier entry stays', () => {
  deepEq(E.radioDedupe([dup('A', 'http://a.org/1', 5, 'http'), dup('a', 'https://a.org/2', 5, 'https')]).map((s) => s.id), ['https']);
  deepEq(E.radioDedupe([dup('A', 'https://a.org/1', 5, 'first'), dup('a', 'https://a.org/2', 5, 'second')]).map((s) => s.id), ['first']);
  deepEq(E.radioDedupe([dup('A', 'http://a.org/1', 5, 'first'), dup('a', 'http://a.org/2', 5, 'second')]).map((s) => s.id), ['first']);
  deepEq(E.radioDedupe([dup('A', 'https://a.org/1', 5, 'https'), dup('a', 'http://a.org/2', 9, 'http')]).map((s) => s.id), ['http']);
});
test('radioDedupe: different host or different name → both kept; output keeps first-seen order', () => {
  const list = [dup('A', 'https://a.org/1', 1, '1'), dup('B', 'https://a.org/1', 1, '2'), dup('A', 'https://b.org/1', 1, '3'), dup('b', 'https://A.ORG:80/x', 9, '4')];
  deepEq(E.radioDedupe(list).map((s) => s.id), ['1', '4', '3']);
});
test('radioDedupe: votes as strings and missing; junk entries skipped; junk list → []', () => {
  deepEq(E.radioDedupe([dup('A', 'https://a.org/1', '7', 'str'), dup('a', 'https://a.org/2', 7, 'num'), dup('a', 'https://a.org/3', undefined, 'none')]).map((s) => s.id), ['str']);
  deepEq(E.radioDedupe([null, 'x', 4, [], dup('A', 'https://a.org/1', 1, 'ok'), undefined]).map((s) => s.id), ['ok']);
  deepEq(E.radioDedupe(null), []);
  deepEq(E.radioDedupe('list'), []);
  deepEq(E.radioDedupe({}), []);
  deepEq(E.radioDedupe([{}, { name: null, url: 5 }]).length, 1);
});
test('radioDedupe: does not mutate its input', () => {
  const list = [dup('A', 'https://a.org/1', 1, '1'), dup('a', 'https://a.org/2', 2, '2')];
  const before = JSON.stringify(list);
  E.radioDedupe(list);
  assert.equal(JSON.stringify(list), before);
});

/* ===================== radioRank ===================== */
const st = (id, name, votes, clicks, clickTrend) => ({ id, name, votes, clicks, clickTrend });
test('radioRank: votes + 0.1·clicks + 50·trend, descending', () => {
  const list = [st('a', 'A', 100, 0, 0), st('b', 'B', 0, 1500, 0), st('c', 'C', 0, 0, 3), st('d', 'D', 90, 100, 0), st('e', 'E', 10, 0, -1)];
  // scores: a 100, b 150, c 150, d 100, e -40
  deepEq(E.radioRank(list).map((s) => s.id), ['b', 'c', 'a', 'd', 'e']);
});
test('radioRank: ties break by name (case-insensitive), then id; float noise does not break a tie', () => {
  deepEq(E.radioRank([st('2', 'zeta', 1, 0, 0), st('1', 'Alpha', 1, 0, 0), st('0', 'alpha', 1, 0, 0)]).map((s) => s.id), ['0', '1', '2']);
  // 10 + 0.1*30 = 13.000000000000002 in IEEE floats; it must still tie with 13 and fall through to the name.
  deepEq(E.radioRank([st('x', 'B', 10, 30, 0), st('y', 'A', 13, 0, 0)]).map((s) => s.id), ['y', 'x']);
  deepEq(E.radioRank([st('x', 'B', 13, 0, 0), st('y', 'A', 10, 30, 0)]).map((s) => s.id), ['y', 'x']);
});
test('radioRank: stable for identical entries; string numbers and missing fields; junk skipped; input untouched', () => {
  const same = [st('p', 'Same', 1, 0, 0), st('p', 'Same', 1, 0, 0), st('p', 'Same', 1, 0, 0)];
  deepEq(E.radioRank(same), same);
  deepEq(E.radioRank([st('a', 'A', '5', 'x', null), st('b', 'B', 6), { id: 'c', name: 'C' }]).map((s) => s.id), ['b', 'a', 'c']);
  const list = [st('b', 'B', 1, 0, 0), null, 'x', st('a', 'A', 2, 0, 0)];
  const before = JSON.stringify(list);
  deepEq(E.radioRank(list).map((s) => s.id), ['a', 'b']);
  assert.equal(JSON.stringify(list), before);
  deepEq(E.radioRank(null), []);
  deepEq(E.radioRank('abc'), []);
  deepEq(E.radioRank({ 0: st('a', 'A', 1, 0, 0), length: 1 }), []);
});
test('radioRank: negative votes/clicks do not count below zero; negative trend does', () => {
  deepEq(E.radioRank([st('a', 'A', -100, -100, 0), st('b', 'B', 0, 0, -1)]).map((s) => s.id), ['a', 'b']);
});

/* ===================== radioNormalizeList ===================== */
test('radioNormalizeList: normalise → dedupe → rank, end to end', () => {
  const raw = [
    RAW_SPARSE,
    Object.assign({}, RAW_GROOVE, { stationuuid: 'dup-http', url: 'http://ice1.somafm.com/groovesalad-128-mp3', url_resolved: '', votes: '12345', clickcount: 0, clicktrend: 0 }),
    RAW_HLS,
    null, 'junk', 42,
    { stationuuid: 'no-url', name: 'Nothing' },
    RAW_GROOVE,
    Object.assign({}, RAW_GROOVE, { stationuuid: 'dup-low', name: 'somafm: groove salad', votes: 1 })
  ];
  const out = E.radioNormalizeList(raw);
  deepEq(out.map((s) => s.id), [UUID_A, UUID_B, 'c1a5d5b2-1234-4abc-9def-0123456789ab']);
  assert.equal(out[0].url, 'https://ice1.somafm.com/groovesalad-128-mp3');
  deepEq(E.radioNormalizeList(raw), out);
});
test('radioNormalizeList: junk → []', () => {
  for (const junk of [null, undefined, {}, 'x', 7, [null, 'a', 1, [], {}]]) deepEq(E.radioNormalizeList(junk), []);
});

/* ===================== radioFilter ===================== */
const F = [
  { id: 'h', url: 'https://a.org/1', ok: true, bitrate: 128, codec: 'MP3' },
  { id: 'p', url: 'http://a.org/2', ok: true, bitrate: 64, codec: 'AAC' },
  { id: 'o', url: 'https://a.org/3', ok: false, bitrate: 320, codec: 'AAC+' },
  { id: 'u', url: 'https://a.org/4', ok: true, bitrate: 0, codec: 'UNKNOWN' },
  { id: 'g', url: 'https://a.org/5', ok: true, bitrate: '192', codec: 'ogg' }
];
const ids = (l) => l.map((s) => s.id);
test('radioFilter: no options → everything (objects only)', () => {
  deepEq(ids(E.radioFilter(F)), ['h', 'p', 'o', 'u', 'g']);
  deepEq(ids(E.radioFilter(F, {})), ['h', 'p', 'o', 'u', 'g']);
  deepEq(ids(E.radioFilter(F.concat([null, 'x', 5]), { httpsOnly: false })), ['h', 'p', 'o', 'u', 'g']);
});
test('radioFilter: httpsOnly / onlineOnly', () => {
  deepEq(ids(E.radioFilter(F, { httpsOnly: true })), ['h', 'o', 'u', 'g']);
  deepEq(ids(E.radioFilter(F, { onlineOnly: true })), ['h', 'p', 'u', 'g']);
  deepEq(ids(E.radioFilter(F, { httpsOnly: true, onlineOnly: true })), ['h', 'u', 'g']);
});
test('radioFilter: minBitrate excludes unknown (0); maxBitrate keeps unknown; strings parsed', () => {
  deepEq(ids(E.radioFilter(F, { minBitrate: 128 })), ['h', 'o', 'g']);
  deepEq(ids(E.radioFilter(F, { minBitrate: '64' })), ['h', 'p', 'o', 'g']);
  deepEq(ids(E.radioFilter(F, { maxBitrate: 128 })), ['h', 'p', 'u']);
  deepEq(ids(E.radioFilter(F, { minBitrate: 64, maxBitrate: 192 })), ['h', 'p', 'g']);
  deepEq(ids(E.radioFilter(F, { minBitrate: 0, maxBitrate: -1 })), ['h', 'p', 'o', 'u', 'g']);
  deepEq(ids(E.radioFilter(F, { minBitrate: 'x', maxBitrate: null })), ['h', 'p', 'o', 'u', 'g']);
});
test('radioFilter: codecs match case-insensitively as prefixes (AAC keeps AAC+); empty list = no filter', () => {
  deepEq(ids(E.radioFilter(F, { codecs: ['aac'] })), ['p', 'o']);
  deepEq(ids(E.radioFilter(F, { codecs: ['AAC+'] })), ['o']);
  deepEq(ids(E.radioFilter(F, { codecs: ['MP3', 'OGG'] })), ['h', 'g']);
  deepEq(ids(E.radioFilter(F, { codecs: 'mp3, ogg' })), ['h', 'g']);
  deepEq(ids(E.radioFilter(F, { codecs: [] })), ['h', 'p', 'o', 'u', 'g']);
  deepEq(ids(E.radioFilter(F, { codecs: ['', null] })), ['h', 'p', 'o', 'u', 'g']);
  deepEq(ids(E.radioFilter(F, { codecs: ['FLAC'] })), []);
  deepEq(ids(E.radioFilter(F, { codecs: ['unknown'] })), ['u']);
});
test('radioFilter: all options together; junk list/options', () => {
  deepEq(ids(E.radioFilter(F, { httpsOnly: true, onlineOnly: true, minBitrate: 100, codecs: ['MP3', 'OGG'] })), ['h', 'g']);
  deepEq(E.radioFilter(null, { httpsOnly: true }), []);
  deepEq(E.radioFilter('x'), []);
  deepEq(ids(E.radioFilter(F, 'junk')), ['h', 'p', 'o', 'u', 'g']);
  deepEq(ids(E.radioFilter(F, null)), ['h', 'p', 'o', 'u', 'g']);
});
test('radioFilter: the starter list passes the strictest default settings', () => {
  assert.equal(E.radioFilter(E.RADIO_STARTER, { httpsOnly: true, onlineOnly: true, minBitrate: 128, codecs: ['MP3'] }).length, E.RADIO_STARTER.length);
});

/* ===================== badge / stream kind ===================== */
test('radioBadge table', () => {
  assert.equal(E.radioBadge({ bitrate: 128, codec: 'AAC' }), '128k AAC');
  assert.equal(E.radioBadge({ bitrate: '320', codec: 'mp3' }), '320k MP3');
  assert.equal(E.radioBadge({ bitrate: 0, codec: 'AAC+' }), 'AAC+');
  assert.equal(E.radioBadge({ bitrate: 96, codec: 'UNKNOWN' }), '96k');
  assert.equal(E.radioBadge({ bitrate: 96, codec: '' }), '96k');
  assert.equal(E.radioBadge({ bitrate: 0, codec: 'UNKNOWN' }), '');
  assert.equal(E.radioBadge({}), '');
  assert.equal(E.radioBadge({ hls: true, bitrate: 128, codec: 'AAC' }), 'HLS');
  assert.equal(E.radioBadge({ hls: '1' }), 'HLS');
  assert.equal(E.radioBadge({ url: 'https://x.org/live.m3u8', bitrate: 64, codec: 'AAC' }), 'HLS');
  assert.equal(E.radioBadge({ bitrate: -5, codec: 'MP3' }), 'MP3');
  assert.equal(E.radioBadge({ bitrate: 'fast', codec: {} }), '');
  assert.equal(E.radioBadge(E.radioNormalizeStation(RAW_GROOVE)), '128k MP3');
  assert.equal(E.radioBadge(E.radioNormalizeStation(RAW_HLS)), 'HLS');
  for (const junk of [null, undefined, 'x', 7, [], () => 1]) assert.equal(E.radioBadge(junk), '', String(junk));
});
test('radioStreamKind table', () => {
  assert.equal(E.radioStreamKind({ hls: true }), 'hls');
  assert.equal(E.radioStreamKind({ hls: 1, url: 'https://x.org/s' }), 'hls');
  assert.equal(E.radioStreamKind({ hls: false, url: 'https://x.org/s.m3u8' }), 'hls');
  assert.equal(E.radioStreamKind({ url: 'https://x.org/s.M3U8?x' }), 'hls');
  assert.equal(E.radioStreamKind({ hls: false, url: 'https://x.org/s.mp3' }), 'direct');
  assert.equal(E.radioStreamKind({ hls: 'no', url: 'http://x.org:8000/;' }), 'direct');
  assert.equal(E.radioStreamKind({}), 'direct');
  assert.equal(E.radioStreamKind(E.RADIO_STARTER[0]), 'direct');
  for (const junk of [null, undefined, 'x', 7, [], true]) assert.equal(E.radioStreamKind(junk), 'direct', String(junk));
});

/* ===================== click rate limit ===================== */
test('radioClickAllowed: never clicked → yes; within 10 minutes → no; at/after → yes', () => {
  assert.equal(E.radioClickAllowed(null, NOW), true);
  assert.equal(E.radioClickAllowed(undefined, NOW), true);
  assert.equal(E.radioClickAllowed(NOW - 1, NOW), false);
  assert.equal(E.radioClickAllowed(NOW - 10 * MIN + 1, NOW), false);
  assert.equal(E.radioClickAllowed(NOW - 10 * MIN, NOW), true);
  assert.equal(E.radioClickAllowed(NOW - 11 * MIN, NOW), true);
  assert.equal(E.radioClickAllowed(NOW, NOW), false);
  assert.equal(E.radioClickAllowed(NOW + MIN, NOW), false, 'clock went backwards → treat as recent');
  assert.equal(E.radioClickAllowed(String(NOW - 11 * MIN), NOW), true);
});
test('radioClickAllowed: junk timestamps count as never clicked; a junk clock never allows', () => {
  for (const junk of ['', 'x', NaN, {}, [], true]) assert.equal(E.radioClickAllowed(junk, NOW), true, String(junk));
  for (const junk of [null, undefined, NaN, 'x', {}, Infinity]) assert.equal(E.radioClickAllowed(NOW - 60 * MIN, junk), false, String(junk));
});

/* ===================== curated lists ===================== */
test('RADIO_GENRES: ~24+ entries with tag/label/emoji/aliases; tags unique, lowercase, directory-style', () => {
  assert.ok(E.RADIO_GENRES.length >= 24 && E.RADIO_GENRES.length <= 40, String(E.RADIO_GENRES.length));
  const tags = E.RADIO_GENRES.map((g) => g.tag);
  assert.equal(new Set(tags).size, tags.length);
  for (const g of E.RADIO_GENRES) {
    assert.equal(typeof g.tag, 'string'); assert.equal(g.tag, g.tag.toLowerCase().trim()); assert.ok(g.tag.length > 0);
    assert.equal(typeof g.label, 'string'); assert.ok(g.label.length > 0);
    assert.equal(typeof g.emoji, 'string'); assert.ok(g.emoji.length > 0 && g.emoji.length <= 4, g.emoji);
    assert.ok(Array.isArray(g.aliases));
  }
  for (const want of ['pop', 'rock', 'jazz', 'classical', 'news', 'talk', 'sports', 'hip hop', 'electronic', 'dance', 'lofi', 'chillout', 'ambient', 'country', 'latin', 'reggae', 'metal', 'blues', 'soul', 'folk', 'kids', '80s', 'oldies']) assert.ok(tags.includes(want), want);
});
test('RADIO_COUNTRIES: ~30 entries; unique ISO codes; flags derived from the code', () => {
  assert.ok(E.RADIO_COUNTRIES.length >= 30 && E.RADIO_COUNTRIES.length <= 40, String(E.RADIO_COUNTRIES.length));
  const codes = E.RADIO_COUNTRIES.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of E.RADIO_COUNTRIES) {
    assert.match(c.code, /^[A-Z]{2}$/);
    assert.equal(typeof c.name, 'string'); assert.ok(c.name.length > 1);
    const want = String.fromCodePoint(0x1f1e6 + c.code.charCodeAt(0) - 65, 0x1f1e6 + c.code.charCodeAt(1) - 65);
    assert.equal(c.flag, want, c.code);
    assert.ok(Array.isArray(c.aliases));
  }
  for (const want of ['US', 'GB', 'DE', 'FR', 'ES', 'IT', 'NL', 'BR', 'JP', 'AU', 'CA', 'IN']) assert.ok(codes.includes(want), want);
  assert.equal(E.RADIO_COUNTRIES.find((c) => c.code === 'US').flag, '🇺🇸');
});
test('RADIO_STARTER: 8–12 SomaFM https mounts in normalised shape, marked starter', () => {
  const L = E.RADIO_STARTER;
  assert.ok(L.length >= 8 && L.length <= 12, String(L.length));
  assert.equal(new Set(L.map((s) => s.id)).size, L.length);
  for (const s of L) {
    assert.equal(s.type, 'radio');
    assert.match(s.id, /^starter:[a-z0-9]+$/);
    const channel = s.id.slice('starter:'.length);
    assert.equal(s.url, 'https://ice1.somafm.com/' + channel + '-128-mp3');
    assert.equal(s.homepage, 'https://somafm.com/' + channel + '/');
    assert.equal(s.favicon, '');
    assert.ok(s.name.startsWith('SomaFM '), s.name);
    assert.ok(Array.isArray(s.tags) && s.tags.length >= 2 && s.tags.every((t) => t === t.toLowerCase()), s.id);
    assert.equal(s.country, 'United States'); assert.equal(s.countryCode, 'US');
    assert.equal(s.codec, 'MP3'); assert.equal(s.bitrate, 128);
    assert.equal(s.https, true); assert.equal(s.hls, false); assert.equal(s.ok, true); assert.equal(s.starter, true);
    assert.equal(E.radioBadge(s), '128k MP3');
    assert.equal(E.radioStreamKind(s), 'direct');
    assert.equal(E.radioClickUrl(S, s.id), null, 'built-ins are not directory stations');
    // Same shape as a normalised station, plus the starter flag.
    const { starter, ...rest } = s;
    deepEq(E.radioNormalizeStation(s), rest);
  }
  for (const want of ['groovesalad', 'dronezone', 'lush', 'secretagent', 'indiepop']) assert.ok(L.some((s) => s.id === 'starter:' + want), want);
  deepEq(E.radioDedupe(L).length, L.length, 'no two starters collide');
});

/* ===================== search planning ===================== */
test('radioSearchPlan: genre + country + name split', () => {
  deepEq(E.radioSearchPlan('jazz uk'), { name: '', tag: 'jazz', tags: ['jazz'], country: 'United Kingdom', countrycode: 'GB' });
  deepEq(E.radioSearchPlan('BBC Radio 4'), { name: 'BBC Radio 4', tag: null, tags: [], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('jazz'), { name: '', tag: 'jazz', tags: ['jazz'], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('germany'), { name: '', tag: null, tags: [], country: 'Germany', countrycode: 'DE' });
  deepEq(E.radioSearchPlan('smooth jazz'), { name: 'smooth', tag: 'jazz', tags: ['jazz'], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('Radio Paradise rock'), { name: 'Radio Paradise', tag: 'rock', tags: ['rock'], country: null, countrycode: null });
});
test('radioSearchPlan: multi-word genres and countries are matched as phrases, longest first', () => {
  deepEq(E.radioSearchPlan('hip hop'), { name: '', tag: 'hip hop', tags: ['hip hop'], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('new zealand folk'), { name: '', tag: 'folk', tags: ['folk'], country: 'New Zealand', countrycode: 'NZ' });
  deepEq(E.radioSearchPlan('United States of America news'), { name: '', tag: 'news', tags: ['news'], country: 'United States', countrycode: 'US' });
  deepEq(E.radioSearchPlan('lofi hip hop beats'), { name: 'beats', tag: 'lofi', tags: ['lofi'], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('czech republic'), { name: '', tag: null, tags: [], country: 'Czechia', countrycode: 'CZ' });
  deepEq(E.radioSearchPlan('world music'), { name: '', tag: 'world music', tags: ['world music'], country: null, countrycode: null });
});
test('radioSearchPlan: aliases (hip-hop, rap, r&b, usa, holland, eighties) map to the directory tag/country', () => {
  assert.equal(E.radioSearchPlan('hip-hop').tag, 'hip hop');
  assert.equal(E.radioSearchPlan('rap').tag, 'hip hop');
  assert.equal(E.radioSearchPlan('r&b').tag, 'soul');
  assert.equal(E.radioSearchPlan('eighties').tag, '80s');
  assert.equal(E.radioSearchPlan('chill').tag, 'chillout');
  assert.equal(E.radioSearchPlan('usa').countrycode, 'US');
  assert.equal(E.radioSearchPlan('holland').countrycode, 'NL');
  assert.equal(E.radioSearchPlan('españa').countrycode, 'ES');
  assert.equal(E.radioSearchPlan('Türkiye').countrycode, 'TR');
});
test('radioSearchPlan: several genres → first is the tag, all are in tags; a second country stays in the name', () => {
  deepEq(E.radioSearchPlan('jazz blues'), { name: '', tag: 'jazz', tags: ['jazz', 'blues'], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('jazz jazz'), { name: '', tag: 'jazz', tags: ['jazz'], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('jazz france germany'), { name: 'germany', tag: 'jazz', tags: ['jazz'], country: 'France', countrycode: 'FR' });
});
test('radioSearchPlan: two-letter codes count when capitalised or unambiguous, not when they are English words', () => {
  deepEq(E.radioSearchPlan('news US'), { name: '', tag: 'news', tags: ['news'], country: 'United States', countrycode: 'US' });
  deepEq(E.radioSearchPlan('news us'), { name: 'us', tag: 'news', tags: ['news'], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('jazz in paris'), { name: 'in paris', tag: 'jazz', tags: ['jazz'], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('jazz IN'), { name: '', tag: 'jazz', tags: ['jazz'], country: 'India', countrycode: 'IN' });
  deepEq(E.radioSearchPlan('make it funky'), { name: 'make it funky', tag: null, tags: [], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('radio de música'), { name: 'radio de música', tag: null, tags: [], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('radio nl'), { name: 'radio', tag: null, tags: [], country: 'Netherlands', countrycode: 'NL' });
  deepEq(E.radioSearchPlan('classical jp'), { name: '', tag: 'classical', tags: ['classical'], country: 'Japan', countrycode: 'JP' });
  deepEq(E.radioSearchPlan('fr'), { name: '', tag: null, tags: [], country: 'France', countrycode: 'FR' });
  deepEq(E.radioSearchPlan('Fr'), { name: '', tag: null, tags: [], country: 'France', countrycode: 'FR' }, 'an unambiguous code matches in any case');
  deepEq(E.radioSearchPlan('In'), { name: 'In', tag: null, tags: [], country: null, countrycode: null }, 'an ambiguous code needs capitals');
});
test('radioSearchPlan: whitespace, commas, quotes and case are tolerated; name keeps its casing', () => {
  deepEq(E.radioSearchPlan('  "Jazz",  UK ;  Smooth   '), { name: 'Smooth', tag: 'jazz', tags: ['jazz'], country: 'United Kingdom', countrycode: 'GB' });
  deepEq(E.radioSearchPlan('(rock)'), { name: '', tag: 'rock', tags: ['rock'], country: null, countrycode: null });
  deepEq(E.radioSearchPlan('KEXP'), { name: 'KEXP', tag: null, tags: [], country: null, countrycode: null });
});
test('radioSearchPlan: empty or junk query → null; a huge query is capped and never throws', () => {
  for (const junk of ['', '   ', null, undefined, {}, [], true, NaN, () => 1, '\t\n', ',,,', '""']) assert.equal(E.radioSearchPlan(junk), null, String(junk));
  assert.equal(E.radioSearchPlan(101).name, '101');
  const big = E.radioSearchPlan('jazz ' + 'x'.repeat(10000));
  assert.equal(big.tag, 'jazz');
  assert.ok(big.name.length < 200);
  const many = E.radioSearchPlan(Array.from({ length: 500 }, (_, i) => 'w' + i).join(' '));
  assert.ok(many.name.length <= 200);
});
test('radioSearchPlan: deterministic', () => {
  for (const q of ['jazz uk', 'hip hop france', 'KEXP seattle', 'lofi']) deepEq(E.radioSearchPlan(q), E.radioSearchPlan(q));
});

/* ===================== junk sweep ===================== */
test('every export survives junk arguments without throwing', () => {
  const junk = [undefined, null, 0, -1, NaN, Infinity, '', 'x', 'https://', ' ', true, [], {}, [null], [1, 'a'], [[]], [{}], () => 1, Symbol('s'), 10n, new Date(0), /re/];
  const fns = Object.keys(E.radio).filter((k) => typeof E.radio[k] === 'function');
  assert.ok(fns.length >= 19, fns.join(','));
  for (const name of fns) {
    for (const a of junk) {
      for (const b of junk) {
        try { E.radio[name](a, b, a); E.radio[name](a); E.radio[name](); }
        catch (e) { assert.fail(name + '(' + String(a) + ', ' + String(b) + ') threw: ' + e.message); }
      }
    }
  }
});
test('exports: exactly the SPEC names (plus RADIO_CLICK_INTERVAL) and the E.radio namespace matches the flat exports', () => {
  const want = ['RADIO_SERVERS', 'radioNextServer', 'radioUrl', 'radioSearchUrl', 'radioTopUrl', 'radioTagsUrl', 'radioCountriesUrl', 'radioLanguagesUrl',
    'radioClickUrl', 'radioVoteUrl', 'radioByUuidUrl', 'radioNormalizeStation', 'radioNormalizeList', 'radioDedupe', 'radioRank', 'radioFilter',
    'radioBadge', 'radioStreamKind', 'radioClickAllowed', 'RADIO_GENRES', 'RADIO_COUNTRIES', 'RADIO_STARTER', 'radioSearchPlan', 'RADIO_CLICK_INTERVAL'];
  for (const k of want) { assert.ok(k in E.radio, k); assert.equal(E[k], E.radio[k], k); }
  deepEq(Object.keys(E.radio).sort(), want.slice().sort());
});

run();

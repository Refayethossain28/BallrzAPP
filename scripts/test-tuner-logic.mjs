#!/usr/bin/env node
/**
 * Unit tests for tuner/engine.js — the pure engine behind Tuner, the IPTV
 * player for playlists the user already has: M3U parsing (attributes, names
 * with commas, #EXTGRP, stable ids), classification into live / movie /
 * episode and series grouping from "Show S01E02" names, the browsable index
 * with category counts and the adult filter, Xtream Codes address handling,
 * API → item mapping and stream URLs, search, favourites, watch history and
 * the resume rule, next/previous stepping, and the player's error copy.
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-tuner-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'tuner', 'engine.js'), 'utf8'), sandbox, { filename: 'tuner/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 9, 20, 19, 0, 0); // 2026-10-20 19:00 UTC
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

const SAMPLE = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://x/l.png" group-title="UK | News, Sport",BBC One HD, London',
  'http://host:8080/live/u/p/1.ts',
  '#EXTINF:-1 group-title="UK | Movies",Inception (2010)',
  'http://host:8080/movie/u/p/55.mkv',
  '#EXTINF:-1 group-title="UK | Series",The Crown S02E03 Lisbon',
  'http://host:8080/series/u/p/900.mp4',
  '#EXTINF:-1 group-title="UK | Series",The Crown - S02 E04',
  'http://host:8080/series/u/p/901.mp4',
  '#EXTINF:-1 group-title="UK | Series",The Crown S01E01 Wolferton Splash',
  'http://host:8080/series/u/p/800.mp4',
  '#EXTINF:-1 group-title="Docs",Planet Earth 1x02',
  'https://cdn/x/pe.m3u8',
  '#EXTGRP:Sport',
  '#EXTINF:-1,Sky Sports Main Event',
  'https://cdn/sky.m3u8',
  '#EXTVLCOPT:http-user-agent=Tuner',
  '#EXTINF:-1 group-title="XXX Adult",Blocked one',
  'https://cdn/x.m3u8',
  '#EXTINF:-1 tvg-name="Fallback name",',
  'https://cdn/fallback.m3u8',
  'https://cdn/bare%20name.m3u8',
].join('\n');

/* ---------- text helpers ---------- */
test('escapeHtml neutralises markup and quotes', () => {
  assert.equal(E.escapeHtml('<b a="1">&\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;');
  assert.equal(E.escapeHtml(null), '');
});
test('hash is stable, short and url-sensitive', () => {
  assert.equal(E.hash('https://cdn/a.m3u8'), E.hash('https://cdn/a.m3u8'));
  assert.notEqual(E.hash('https://cdn/a.m3u8'), E.hash('https://cdn/b.m3u8'));
  assert.ok(/^[0-9a-z]{1,8}$/.test(E.hash('anything')));
});
test('initials, slug, fmtTime, ago', () => {
  assert.equal(E.initials('BBC One HD'), 'BO');
  assert.equal(E.initials('sky'), 'S');
  assert.equal(E.initials(''), '?');
  assert.equal(E.slug('  BBC-One_HD!! '), 'bbc one hd');
  assert.equal(E.fmtTime(0), '0:00');
  assert.equal(E.fmtTime(65), '1:05');
  assert.equal(E.fmtTime(3725), '1:02:05');
  assert.equal(E.ago(NOW - 30 * 1000, NOW), 'just now');
  assert.equal(E.ago(NOW - 5 * MIN, NOW), '5 min ago');
  assert.equal(E.ago(NOW - 3 * HOUR, NOW), '3 h ago');
  assert.equal(E.ago(NOW - DAY, NOW), '1 day ago');
  assert.equal(E.ago(NOW - 3 * DAY, NOW), '3 days ago');
});
test('hostOf reads the host out of a url, ignoring credentials and ports', () => {
  assert.equal(E.hostOf('http://user:pw@panel.example.com:8080/get.php?x=1'), 'panel.example.com');
  assert.equal(E.hostOf('not a url'), 'Playlist');
});
test('isAdult matches the usual markers and nothing else', () => {
  for (const g of ['XXX', 'Adult | UK', '18+ Movies', 'FOR ADULTS', 'Erotic']) assert.ok(E.isAdult(g), g);
  for (const g of ['Kids', 'Adultos no', 'Sports 18 Plus Football', 'News']) assert.ok(!E.isAdult(g), g);
});

/* ---------- series names & classification ---------- */
test('parseSeriesName: SxxExx, "S02 E04", 1x02 and plain names', () => {
  deepEq(E.parseSeriesName('The Crown S02E03 Lisbon'), { title: 'The Crown', season: 2, episode: 3, epTitle: 'Lisbon' });
  deepEq(E.parseSeriesName('The Crown - S02 E04'), { title: 'The Crown', season: 2, episode: 4, epTitle: '' });
  deepEq(E.parseSeriesName('Planet Earth 1x02'), { title: 'Planet Earth', season: 1, episode: 2, epTitle: '' });
  deepEq(E.parseSeriesName('Dark.S01E10.Alpha.und.Omega'), { title: 'Dark', season: 1, episode: 10, epTitle: 'Alpha.und.Omega' });
  assert.equal(E.parseSeriesName('BBC One HD'), null);
  assert.equal(E.parseSeriesName('Formula 1 2026'), null, 'years are not episodes');
});
test('classify: url shape wins over group names; group keywords fill in', () => {
  assert.equal(E.classify('BBC One', 'http://h/live/u/p/1.ts', 'Movies channel').k, 'live');
  assert.equal(E.classify('Inception', 'http://h/movie/u/p/5.mkv', 'UK').k, 'movie');
  assert.equal(E.classify('Something', 'http://h/stream.mp4', 'Live').k, 'movie');
  assert.equal(E.classify('Something', 'https://cdn/a.m3u8', 'VOD | Films').k, 'movie');
  assert.equal(E.classify('Something', 'https://cdn/a.m3u8', 'UK Series').k, 'ep');
  assert.equal(E.classify('Show S01E01', 'https://cdn/a.m3u8', 'News').k, 'ep');
  assert.equal(E.classify('Sky Sports', 'https://cdn/a.m3u8', 'Sport').k, 'live');
});

/* ---------- M3U parsing ---------- */
test('parseM3U: attributes, names with commas, #EXTGRP, fallbacks and stable ids', () => {
  const items = E.parseM3U(SAMPLE);
  assert.equal(items.length, 10);
  const bbc = items[0];
  assert.equal(bbc.n, 'BBC One HD, London', 'display name keeps its comma');
  assert.equal(bbc.g, 'UK | News, Sport', 'group keeps its comma');
  assert.equal(bbc.l, 'http://x/l.png');
  assert.equal(bbc.tid, 'bbc1.uk');
  assert.equal(bbc.k, 'live');
  assert.equal(bbc.id, E.hash('http://host:8080/live/u/p/1.ts'), 'id derives from the url');
  assert.equal(items[1].k, 'movie');
  const crown = items.filter((i) => i.st === 'The Crown');
  assert.equal(crown.length, 3);
  assert.equal(new Set(crown.map((i) => i.sk)).size, 1, 'episodes of one show share a series key');
  assert.equal(crown[0].et, 'Lisbon');
  assert.equal(items[5].st, 'Planet Earth');
  assert.equal(items[6].g, 'Sport', '#EXTGRP fills a missing group');
  assert.equal(items[6].k, 'live');
  assert.equal(items[8].n, 'Fallback name', 'tvg-name stands in for an empty display name');
  assert.equal(items[9].n, 'bare name.m3u8', 'a bare url is named after its file');
  assert.equal(items[9].g, 'Sport', 'the running #EXTGRP applies to bare urls too');
});
test('parseM3U tolerates CRLF, blank lines and lowercase tags', () => {
  const items = E.parseM3U('#extm3u\r\n\r\n#extinf:-1 group-title="A",One\r\nhttps://a/1.m3u8\r\n');
  assert.equal(items.length, 1);
  assert.equal(items[0].n, 'One');
  assert.equal(items[0].g, 'A');
  deepEq(E.parseM3U(''), []);
});
test('countKinds counts shows once, not per episode', () => {
  deepEq(E.countKinds(E.parseM3U(SAMPLE)), { live: 5, movie: 1, series: 2 });
});

/* ---------- index ---------- */
test('buildIndex: numbering, category counts in playlist order, series grouping, adult filter', () => {
  const idx = E.buildIndex(E.parseM3U(SAMPLE), { hideAdult: true });
  assert.equal(idx.live.length, 4, 'adult channel hidden');
  deepEq(idx.live.map((i) => i.num), [1, 2, 3, 4]);
  deepEq(idx.groups.live, [['UK | News, Sport', 1], ['Sport', 3]], 'hidden groups are not listed');
  deepEq(idx.groups.movie, [['UK | Movies', 1]]);
  deepEq(idx.groups.series, [['UK | Series', 1], ['Docs', 1]]);
  assert.equal(idx.series.length, 2);
  const crown = idx.series[0];
  assert.equal(crown.title, 'The Crown');
  deepEq(crown.eps.map((e) => [e.se, e.ep]), [[1, 1], [2, 3], [2, 4]], 'episodes sorted by season then episode');
  deepEq(E.seasonsOf(crown), [1, 2]);
  assert.equal(E.epLabel(crown.eps[1]), 'S02 E03');
  assert.ok(idx.byId[crown.eps[0].id], 'byId still indexes everything, hidden or not');
  const all = E.buildIndex(E.parseM3U(SAMPLE), { hideAdult: false });
  assert.equal(all.live.length, 5, 'filter off shows the adult channel');
});
test('buildIndex keeps Xtream channel numbers and series shells', () => {
  const idx = E.buildIndex([
    { id: 'l5', n: 'Five', u: 'http://h/live/u/p/5.m3u8', g: 'A', k: 'live', num: 5 },
    { id: 'l9', n: 'Nine', u: 'http://h/live/u/p/9.m3u8', g: 'A', k: 'live', num: 9 },
    { id: 's1', n: 'Show', l: '', g: 'S', k: 'series', x: 1 },
  ], {});
  deepEq(idx.live.map((i) => i.num), [5, 9]);
  assert.equal(idx.series[0].eps, null, 'shell: episodes load on demand');
  assert.equal(idx.series[0].x, 1);
});

/* ---------- Xtream Codes ---------- */
test('normalizeServer accepts host:port, trailing paths and pasted links; rejects junk', () => {
  assert.equal(E.normalizeServer('panel.example.com:8080'), 'http://panel.example.com:8080');
  assert.equal(E.normalizeServer('HTTPS://Panel.Example.com/c/'), 'https://Panel.Example.com');
  assert.equal(E.normalizeServer('http://u:p@panel:80/get.php?username=a&password=b'), 'http://panel:80');
  assert.equal(E.normalizeServer('http://[2001:db8::1]:8080/'), 'http://[2001:db8::1]:8080');
  assert.throws(() => E.normalizeServer(''), /Enter the server/);
  assert.throws(() => E.normalizeServer('http://'), /doesn.t look right/);
  assert.throws(() => E.normalizeServer('ftp://x y'), /doesn.t look right/);
});
test('xtreamFromText reads a login out of a pasted M3U link', () => {
  deepEq(E.xtreamFromText('http://panel:8080/get.php?username=ra%20fa&password=p%26w&type=m3u_plus'),
    { server: 'http://panel:8080', username: 'ra fa', password: 'p&w' });
  assert.equal(E.xtreamFromText('http://panel:8080/get.php?username=only'), null);
  assert.equal(E.xtreamFromText('panel:8080'), null);
});
test('xtreamApiUrl and xtreamStreamUrl encode credentials and pick the right path', () => {
  assert.equal(E.xtreamApiUrl('http://p:80', 'u s', 'p&w', 'get_series_info', '&series_id=7'),
    'http://p:80/player_api.php?username=u%20s&password=p%26w&action=get_series_info&series_id=7');
  assert.equal(E.xtreamApiUrl('http://p:80', 'u', 'p'), 'http://p:80/player_api.php?username=u&password=p');
  assert.equal(E.xtreamStreamUrl('http://p:80', 'u', 'p', 'live', 12), 'http://p:80/live/u/p/12.m3u8');
  assert.equal(E.xtreamStreamUrl('http://p:80', 'u', 'p', 'movie', 12, 'mkv'), 'http://p:80/movie/u/p/12.mkv');
  assert.equal(E.xtreamStreamUrl('http://p:80', 'u', 'p', 'ep', 12), 'http://p:80/series/u/p/12.mp4');
});
test('xtreamAuthCheck: only an active, authenticated account passes', () => {
  assert.equal(E.xtreamAuthCheck({ user_info: { auth: 1, status: 'Active' } }), true);
  assert.equal(E.xtreamAuthCheck({ user_info: { auth: '1' } }), true);
  assert.throws(() => E.xtreamAuthCheck({ user_info: { auth: 0 } }), /rejected/);
  assert.throws(() => E.xtreamAuthCheck(null), /rejected/);
  assert.throws(() => E.xtreamAuthCheck({ user_info: { auth: 1, status: 'Expired' } }), /expired/);
});
test('xtreamItems maps the six catalogue answers to items with category names', () => {
  const items = E.xtreamItems('http://p:80', 'u', 'p', {
    liveCategories: [{ category_id: '1', category_name: 'News' }],
    liveStreams: [{ stream_id: 10, name: 'BBC', num: 3, stream_icon: 'http://i/b.png', category_id: '1', epg_channel_id: 'bbc.uk' },
                  { stream_id: 11, name: 'Nocat', category_id: '99' }, { name: 'no id' }],
    vodCategories: [{ category_id: 5, category_name: 'Action' }],
    vodStreams: [{ stream_id: 20, name: 'Film', container_extension: 'mkv', category_id: 5, rating: '7.1' }],
    seriesCategories: [],
    series: [{ series_id: 30, name: 'Show', cover: 'http://i/s.png', category_id: 2 }],
  });
  assert.equal(items.length, 4);
  deepEq(items[0], { id: 'l10', n: 'BBC', u: 'http://p:80/live/u/p/10.m3u8', l: 'http://i/b.png', g: 'News', k: 'live', num: 3, tid: 'bbc.uk' });
  assert.equal(items[1].g, 'Uncategorised');
  deepEq(items[2], { id: 'm20', n: 'Film', u: 'http://p:80/movie/u/p/20.mkv', l: '', g: 'Action', k: 'movie', r: '7.1' });
  deepEq(items[3], { id: 's30', n: 'Show', l: 'http://i/s.png', g: 'Uncategorised', k: 'series', x: 30 });
  deepEq(E.xtreamItems('http://p:80', 'u', 'p', {}), []);
});
test('xtreamEpisodes flattens season-keyed and flat answers, sorted', () => {
  const show = { key: 's30', title: 'Show', logo: 'http://i/s.png', g: 'Drama' };
  const keyed = E.xtreamEpisodes('http://p:80', 'u', 'p', show, { episodes: {
    '2': [{ id: 202, episode_num: '2', season: 2, title: 'Two', container_extension: 'mkv', info: { duration: '00:42:00', movie_image: 'http://i/e.png' } }],
    '1': [{ id: 101, episode_num: 1, season: 1, title: 'One' }, { id: 102, episode_num: 2, season: 1 }],
  } });
  deepEq(keyed.map((e) => e.id), ['e101', 'e102', 'e202']);
  deepEq(keyed[2], { id: 'e202', n: 'Two', u: 'http://p:80/series/u/p/202.mkv', l: 'http://i/e.png', g: 'Drama', k: 'ep', sk: 's30', st: 'Show', se: 2, ep: 2, d: '00:42:00' });
  assert.equal(keyed[1].n, 'Episode 2', 'untitled episodes get a name');
  assert.equal(keyed[1].l, 'http://i/s.png', 'episode art falls back to the series cover');
  const flat = E.xtreamEpisodes('http://p:80', 'u', 'p', show, { episodes: [[{ id: 1, episode_num: 1, season: 1 }], { a: { id: 2, episode_num: 2, season: 1 } }] });
  deepEq(flat.map((e) => e.id), ['e1', 'e2']);
  deepEq(E.xtreamEpisodes('http://p:80', 'u', 'p', show, {}), []);
});

/* ---------- playback rules ---------- */
test('isHlsUrl: .m3u8 anywhere, or an extensionless live url', () => {
  assert.ok(E.isHlsUrl('https://cdn/a.m3u8?token=1', 'movie'));
  assert.ok(E.isHlsUrl('http://p/live/u/p/1', 'live'));
  assert.ok(!E.isHlsUrl('http://p/live/u/p/1.ts', 'live'));
  assert.ok(!E.isHlsUrl('http://p/movie/u/p/1.mp4', 'movie'));
});
test('mixed content and the hints the viewer sees', () => {
  assert.ok(E.isMixedContent('http://p/x', true));
  assert.ok(!E.isMixedContent('http://p/x', false));
  assert.ok(!E.isMixedContent('https://p/x', true));
  assert.match(E.netHint('http://p/x', true), /https/);
  assert.match(E.netHint('http://p/x', false), /VLC/);
  assert.equal(E.mediaErrorMessage(4, 'https://p/x.ts', true).title, 'Format not supported');
  assert.match(E.mediaErrorMessage(4, 'https://p/x.ts', true).msg, /\.ts/);
  assert.equal(E.mediaErrorMessage(2, 'https://p/x', true).title, 'Connection lost');
  assert.equal(E.mediaErrorMessage(3, 'https://p/x', true).title, 'Couldn’t decode the video');
  assert.equal(E.mediaErrorMessage(undefined, 'https://p/x', true).title, 'Playback failed');
});
test('vlcUrl per platform; fit cycles; stepIndex bounds', () => {
  assert.equal(E.vlcUrl('http://p/a b.m3u8', true), 'vlc-x-callback://x-callback-url/stream?url=http%3A%2F%2Fp%2Fa%20b.m3u8');
  assert.equal(E.vlcUrl('http://p/a.m3u8', false), 'vlc://http://p/a.m3u8');
  assert.equal(E.fitNext('contain'), 'cover');
  assert.equal(E.fitNext('fill'), 'contain');
  assert.equal(E.fitNext('nonsense'), 'contain');
  assert.equal(E.fitLabel('cover'), 'Zoom');
  assert.equal(E.stepIndex(['a', 'b', 'c'], 'b', 1), 2);
  assert.equal(E.stepIndex(['a', 'b', 'c'], 'c', 1), -1);
  assert.equal(E.stepIndex(['a', 'b', 'c'], 'a', -1), -1);
  assert.equal(E.stepIndex(['a', 'b', 'c'], 'zz', 1), -1);
});

/* ---------- search, favourites, history ---------- */
test('search: every word must match, slugged, capped, across kinds', () => {
  const idx = E.buildIndex(E.parseM3U(SAMPLE), { hideAdult: true });
  assert.ok(E.searchMatch('bbc one', 'BBC One HD, London'));
  assert.ok(E.searchMatch('one bbc', 'BBC One HD, London'), 'order does not matter');
  assert.ok(!E.searchMatch('bbc two', 'BBC One HD, London'));
  assert.ok(!E.searchMatch('b', 'BBC'), 'one letter is not a search');
  const r = E.search(idx, 'crown');
  deepEq([r.live.length, r.movie.length, r.series.length], [0, 0, 1]);
  assert.equal(r.series[0].title, 'The Crown');
  deepEq(E.search(idx, 'x'), { live: [], movie: [], series: [] });
  assert.equal(E.search(idx, 'sky', 1).live.length, 1);
});
test('toggleFav adds to the front, removes in place, reports the new state', () => {
  deepEq(E.toggleFav([], 'a'), { list: ['a'], on: true });
  deepEq(E.toggleFav(['a'], 'b'), { list: ['b', 'a'], on: true });
  deepEq(E.toggleFav(['b', 'a'], 'a'), { list: ['b'], on: false });
  assert.equal(E.favTarget({ k: 'ep', id: 'e1', sk: 's1' }), 's1', 'an episode favourites its series');
  assert.equal(E.favTarget({ k: 'live', id: 'l1' }), 'l1');
});
test('touchRecent: front of the list, keeps the last position unless given one, capped, snapshotted', () => {
  const ep = { id: 'e1', n: 'Show S01E02 Two', u: 'u', l: '', g: 'G', k: 'ep', sk: 's', st: 'Show', se: 1, ep: 2, et: 'Two', extra: 'dropped' };
  let r = E.touchRecent([], 'p1', ep, 0, 0, NOW);
  r = E.touchRecent(r, 'p1', ep, 600, 2400, NOW + MIN);
  assert.equal(r.length, 1);
  assert.equal(r[0].pos, 600);
  r = E.touchRecent(r, 'p1', ep, undefined, undefined, NOW + 2 * MIN);
  assert.equal(r[0].pos, 600, 'replaying keeps the saved position');
  assert.equal(r[0].dur, 2400);
  assert.equal(r[0].at, NOW + 2 * MIN);
  assert.equal(r[0].it.extra, undefined, 'snapshot keeps only what the shelf needs');
  assert.equal(r[0].it.et, 'Two');
  for (let i = 0; i < 50; i++) r = E.touchRecent(r, 'p1', { id: 'l' + i, n: 'C' + i, u: 'u' + i, l: '', g: 'G', k: 'live' }, 0, 0, NOW + i);
  assert.equal(r.length, E.RECENT_MAX);
  assert.equal(r[0].id, 'l49');
  const other = E.touchRecent(r, 'p2', ep, 5, 10, NOW);
  assert.equal(other[0].pid, 'p2');
  assert.equal(other.length, E.RECENT_MAX, 'another playlist entry still respects the cap');
});
test('continueWatching / recentLive split the shelf by kind and playlist', () => {
  let r = [];
  r = E.touchRecent(r, 'p1', { id: 'm1', n: 'Film', u: 'u', l: '', g: 'G', k: 'movie' }, 100, 1000, NOW);
  r = E.touchRecent(r, 'p1', { id: 'l1', n: 'Chan', u: 'u', l: '', g: 'G', k: 'live' }, 0, 0, NOW + 1);
  r = E.touchRecent(r, 'p2', { id: 'm2', n: 'Other', u: 'u', l: '', g: 'G', k: 'movie' }, 0, 0, NOW + 2);
  deepEq(E.continueWatching(r, 'p1').map((x) => x.id), ['m1']);
  deepEq(E.recentLive(r, 'p1').map((x) => x.id), ['l1']);
  deepEq(E.continueWatching(r, 'p2').map((x) => x.id), ['m2']);
});
test('resumeAt: past the opening, not into the credits, only with a real duration', () => {
  assert.equal(E.resumeAt({ pos: 600 }, 2400), 600);
  assert.equal(E.resumeAt({ pos: 10 }, 2400), null, 'too early to bother');
  assert.equal(E.resumeAt({ pos: 2380 }, 2400), null, 'in the credits: start over');
  assert.equal(E.resumeAt({ pos: 600 }, Infinity), null, 'live / unknown length');
  assert.equal(E.resumeAt({ pos: 600 }, 0), null);
  assert.equal(E.resumeAt(null, 2400), null);
  assert.equal(E.progressPct(600, 2400), 25);
  assert.equal(E.progressPct(5, 0), 0);
  assert.equal(E.minutesLeft(600, 2400), 30);
  assert.equal(E.minutesLeft(0, 0), 0);
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} passed`);

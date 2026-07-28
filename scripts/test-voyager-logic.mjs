#!/usr/bin/env node
/**
 * Unit tests for voyager/engine.js — the chrome behind Voyager, the internet
 * browser. Pins the properties browser chrome must never lose: the omnibox
 * classifier (URL vs search vs internal, every edge), URL display/security
 * rules, the single navigation door (forward-stack truncation, consecutive
 * dedupe), tab lifecycle (close focuses the right-hand neighbour, the browser
 * is never empty), frecency-ranked suggestions and top sites, bookmarks,
 * incognito-writes-nothing, and versioned session round-trips that drop
 * private tabs by construction.
 * Loaded in a vm sandbox (repo is type:module). Run: node scripts/test-voyager-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'voyager', 'engine.js'), 'utf8'), sandbox, { filename: 'voyager/engine.js' });
const V = sandbox.module.exports;

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 26); // 2026-07-26

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// Engine objects come from a vm context (foreign prototypes), so structural
// equality is checked by value, not by assert.deepEqual's prototype-strict walk.
const eq = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

/* ---- the omnibox classifier ---- */

test('classify: bare domains, paths, ports and IPs are URLs (https assumed)', () => {
  eq(V.classify('example.com'), { kind: 'url', url: 'https://example.com' });
  assert.equal(V.classify('example.com/a/b?q=1#f').url, 'https://example.com/a/b?q=1#f');
  assert.equal(V.classify('news.ycombinator.com').url, 'https://news.ycombinator.com');
  assert.equal(V.classify('example.co.uk:8443/x').url, 'https://example.co.uk:8443/x');
  assert.equal(V.classify('localhost:3000').url, 'https://localhost:3000');
  assert.equal(V.classify('192.168.1.1:8080/admin').url, 'https://192.168.1.1:8080/admin');
  assert.equal(V.classify('  example.com  ').url, 'https://example.com'); // trimmed
});

test('classify: explicit schemes pass through untouched', () => {
  assert.equal(V.classify('https://Example.com/Path').url, 'https://Example.com/Path');
  assert.equal(V.classify('http://old.example.com').url, 'http://old.example.com');
  assert.equal(V.classify('http://old.example.com').kind, 'url');
});

test('classify: questions, phrases and non-hosts are searches through the engine', () => {
  const s = V.classify('how do browsers work');
  assert.equal(s.kind, 'search');
  assert.equal(s.url, 'https://refayethossain28.github.io/BallrzAPP/seeker/?q=how%20do%20browsers%20work');
  assert.equal(V.classify('example com').kind, 'search');          // space kills URL-ness
  assert.equal(V.classify('what is example.com').kind, 'search');  // even with a domain inside
  assert.equal(V.classify('hello').kind, 'search');                // no dot, no host
  assert.equal(V.classify('3.14159').kind, 'search');              // numeric non-IP, bad TLD
  assert.equal(V.classify('999.1.1.1').kind, 'search');            // octet out of range
  assert.equal(V.classify('cats!?').kind, 'search');
});

test('classify: chosen engine is honoured, unknown engine falls back to the first (Seeker)', () => {
  assert.equal(V.classify('cats', { engine: 'google' }).url, 'https://www.google.com/search?q=cats');
  assert.equal(V.classify('cats', { engine: 'duckduckgo' }).url, 'https://duckduckgo.com/?q=cats');
  assert.equal(V.classify('cats', { engine: 'nope' }).url, 'https://refayethossain28.github.io/BallrzAPP/seeker/?q=cats');
});

test('Seeker is the default engine: browsers are born searching their own', () => {
  const s = V.createBrowser();
  assert.equal(s.settings.engine, 'seeker');
  assert.equal(V.SEARCH_ENGINES[0].id, 'seeker');
  assert.equal(V.searchUrl('seeker', 'quantum networking'),
    'https://refayethossain28.github.io/BallrzAPP/seeker/?q=quantum%20networking');
  const r = V.restore(JSON.stringify({ v: 1, tabs: [{ id: 1, stack: ['voyager://start'], pos: 0 }], settings: {} }));
  assert.equal(r.settings.engine, 'seeker');                       // absent setting → the new default
  const kept = V.restore(V.serialize(V.setSetting(s, 'engine', 'duckduckgo')));
  assert.equal(kept.settings.engine, 'duckduckgo');                // an explicit choice is honoured
});

test('engine migration: a legacy default upgrades to Seeker, a real choice never does', () => {
  const legacyTab = [{ id: 1, stack: ['voyager://start'], pos: 0 }];
  // pre-Seeker session: engine 'duckduckgo' was the default, never chosen
  const legacy = V.restore(JSON.stringify({ v: 1, tabs: legacyTab, settings: { engine: 'duckduckgo' } }));
  assert.equal(legacy.settings.engine, 'seeker');
  // a legacy session where the user picked something else keeps it
  const google = V.restore(JSON.stringify({ v: 1, tabs: legacyTab, settings: { engine: 'google' } }));
  assert.equal(google.settings.engine, 'google');
  // choosing duckduckgo NOW stamps engineChosen, and it survives every future restore
  let s = V.setSetting(V.createBrowser(), 'engine', 'duckduckgo');
  assert.equal(s.settings.engineChosen, true);
  s = V.restore(V.serialize(s));
  s = V.restore(V.serialize(s));                                   // twice: the migration must not creep
  assert.equal(s.settings.engine, 'duckduckgo');
});

test('classify: voyager:// pages are internal; unknown internal pages become searches', () => {
  eq(V.classify('voyager://history'), { kind: 'internal', url: 'voyager://history' });
  assert.equal(V.classify('VOYAGER://Settings').url, 'voyager://settings'); // case-blind
  assert.equal(V.classify('voyager://').url, 'voyager://start');            // empty → start
  assert.equal(V.classify('voyager://nope').kind, 'search');
  assert.equal(V.classify('').kind, 'empty');
  assert.equal(V.classify('   ').kind, 'empty');
});

test('searchUrl encodes the query safely', () => {
  assert.equal(V.searchUrl('duckduckgo', 'a&b=c'), 'https://duckduckgo.com/?q=a%26b%3Dc');
});

/* ---- URL display & security ---- */

test('hostOf extracts the lowercased host, dropping port and credentials', () => {
  assert.equal(V.hostOf('https://WWW.Example.COM:8443/a?b#c'), 'www.example.com');
  assert.equal(V.hostOf('http://user:pass@example.com/x'), 'example.com');
  assert.equal(V.hostOf('voyager://start'), '');
  assert.equal(V.hostOf('not a url'), '');
});

test('displayUrl hides https/www but keeps http visible as a warning', () => {
  assert.equal(V.displayUrl('https://www.example.com/'), 'example.com');
  assert.equal(V.displayUrl('https://news.site.org/story/1'), 'news.site.org/story/1');
  assert.equal(V.displayUrl('http://www.example.com/'), 'http://example.com');
  assert.equal(V.displayUrl('voyager://start'), 'voyager://start');
});

test('securityOf maps scheme → chip; onion is its own posture, not "insecure"', () => {
  assert.equal(V.securityOf('https://example.com'), 'secure');
  assert.equal(V.securityOf('http://example.com'), 'insecure');
  assert.equal(V.securityOf('voyager://history'), 'internal');
  assert.equal(V.securityOf('data:text/html,x'), 'neutral');
  // Tor authenticates .onion by the address, so plain-http onion is NOT "insecure".
  assert.equal(V.securityOf('http://duskgytldkxiuqc6.onion'), 'onion');
  assert.equal(V.securityOf('https://protonmailrmez3lotccipshtkleegetolb73fuirgj7r4o4vfu7ozyd.onion/inbox'), 'onion');
});

/* ---- dark web: onion recognition & gateway routing ---- */

test('isOnion recognises hidden-service hosts and only those', () => {
  assert.equal(V.isOnion('http://duskgytldkxiuqc6.onion'), true);
  assert.equal(V.isOnion('https://sub.facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshg7kx5tfyd.onion/x'), true);
  assert.equal(V.isOnion('https://example.com'), false);
  assert.equal(V.isOnion('https://onionsoup.com'), false);   // "onion" in the name ≠ .onion TLD
  assert.equal(V.isOnion('voyager://start'), false);
});

test('classify treats an .onion address as a navigable URL', () => {
  assert.equal(V.classify('duskgytldkxiuqc6.onion').kind, 'url');
  assert.equal(V.classify('duskgytldkxiuqc6.onion').url, 'https://duskgytldkxiuqc6.onion');
  assert.equal(V.classify('http://abc.onion/path').url, 'http://abc.onion/path');
});

test('torGatewayUrl rewrites .onion through a gateway, https, path/query preserved', () => {
  assert.equal(
    V.torGatewayUrl('http://duskgytldkxiuqc6.onion/wiki?x=1#f', 'onion.ws'),
    'https://duskgytldkxiuqc6.onion.ws/wiki?x=1#f');
  assert.equal(
    V.torGatewayUrl('https://abc.onion', 'onion.ly'),
    'https://abc.onion.ly');
  // gateway given with scheme / trailing slash is normalised
  assert.equal(
    V.torGatewayUrl('http://abc.onion/p', 'https://onion.ws/'),
    'https://abc.onion.ws/p');
});

test('torGatewayUrl is a safe no-op for clearnet URLs or when no gateway is set', () => {
  assert.equal(V.torGatewayUrl('https://example.com/x', 'onion.ws'), 'https://example.com/x');
  assert.equal(V.torGatewayUrl('http://abc.onion/x', ''), 'http://abc.onion/x');
  assert.equal(V.torGatewayUrl('http://abc.onion/x', '   '), 'http://abc.onion/x');
});

/* ---- tabs ---- */

test('a fresh browser has one tab on the start page, active', () => {
  const s = V.createBrowser();
  assert.equal(s.tabs.length, 1);
  assert.equal(s.activeId, s.tabs[0].id);
  assert.equal(V.tabUrl(V.activeTab(s)), 'voyager://start');
  assert.equal(s.history.length, 0); // internal pages never touch history
});

test('newTab focuses by default, background:true keeps focus put, ids never repeat', () => {
  let s = V.createBrowser();
  const first = s.activeId;
  s = V.newTab(s, { url: 'https://a.com', ts: NOW });
  assert.equal(s.tabs.length, 2);
  assert.notEqual(s.activeId, first);
  const focused = s.activeId;
  s = V.newTab(s, { url: 'https://b.com', ts: NOW, background: true });
  assert.equal(s.activeId, focused);
  const ids = s.tabs.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('closeTab focuses the right-hand neighbour, else the left one', () => {
  let s = V.createBrowser();
  s = V.newTab(s, { url: 'https://a.com', ts: NOW });
  s = V.newTab(s, { url: 'https://b.com', ts: NOW });
  s = V.newTab(s, { url: 'https://c.com', ts: NOW });
  const [t1, t2, t3, t4] = s.tabs.map((t) => t.id);
  s = V.activateTab(s, t2);
  s = V.closeTab(s, t2);           // middle closed → right-hand neighbour
  assert.equal(s.activeId, t3);
  s = V.activateTab(s, t4);
  s = V.closeTab(s, t4);           // last closed → left neighbour
  assert.equal(s.activeId, t3);
  s = V.closeTab(s, t1);           // closing an inactive tab keeps focus
  assert.equal(s.activeId, t3);
});

test('closing the last tab opens a fresh start tab — the browser is never empty', () => {
  let s = V.createBrowser();
  s = V.closeTab(s, s.activeId);
  assert.equal(s.tabs.length, 1);
  assert.equal(V.tabUrl(V.activeTab(s)), 'voyager://start');
});

/* ---- navigation ---- */

test('navigate pushes onto the stack; back/forward walk it; canBack/canForward gate the ends', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://a.com', { ts: NOW });
  s = V.navigate(s, id, 'https://b.com', { ts: NOW });
  let t = V.activeTab(s);
  eq(t.stack, ['voyager://start', 'https://a.com', 'https://b.com']);
  assert.equal(V.canBack(t), true);
  assert.equal(V.canForward(t), false);
  s = V.back(s, id);
  assert.equal(V.tabUrl(V.activeTab(s)), 'https://a.com');
  assert.equal(V.canForward(V.activeTab(s)), true);
  s = V.forward(s, id);
  assert.equal(V.tabUrl(V.activeTab(s)), 'https://b.com');
  s = V.forward(s, id);                                   // at the end: no-op
  assert.equal(V.tabUrl(V.activeTab(s)), 'https://b.com');
});

test('navigating after going back truncates the forward stack (branching rewrites the future)', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://a.com', { ts: NOW });
  s = V.navigate(s, id, 'https://b.com', { ts: NOW });
  s = V.back(s, id);
  s = V.navigate(s, id, 'https://c.com', { ts: NOW });
  const t = V.activeTab(s);
  eq(t.stack, ['voyager://start', 'https://a.com', 'https://c.com']);
  assert.equal(V.canForward(t), false);
});

test('navigate to the current URL is a reload: stack unchanged, no duplicate history', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://a.com', { ts: NOW });
  const len = V.activeTab(s).stack.length;
  s = V.navigate(s, id, 'https://a.com', { ts: NOW + 1000 });
  assert.equal(V.activeTab(s).stack.length, len);
  assert.equal(s.history.length, 1); // consecutive dedupe
});

test('engine ops never mutate their input state', () => {
  const s0 = V.createBrowser();
  const frozen = JSON.stringify(s0);
  V.navigate(s0, s0.activeId, 'https://a.com', { ts: NOW });
  V.newTab(s0, { url: 'https://b.com', ts: NOW });
  V.closeTab(s0, s0.activeId);
  V.toggleBookmark(s0, 'https://a.com', 'A', NOW);
  V.setZoom(s0, s0.activeId, 150);
  assert.equal(JSON.stringify(s0), frozen);
});

test('setTitle updates the tab and back-fills the latest matching history entry', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://a.com', { ts: NOW });
  s = V.setTitle(s, id, 'Site A');
  assert.equal(V.activeTab(s).title, 'Site A');
  assert.equal(s.history[s.history.length - 1].title, 'Site A');
});

test('zoom clamps to 25–500', () => {
  let s = V.createBrowser();
  s = V.setZoom(s, s.activeId, 900);
  assert.equal(V.activeTab(s).zoom, 500);
  s = V.setZoom(s, s.activeId, 3);
  assert.equal(V.activeTab(s).zoom, 25);
});

/* ---- history ---- */

test('history records url/title/ts; internal pages are never recorded', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://a.com', { title: 'A', ts: NOW });
  s = V.navigate(s, id, 'voyager://history', { ts: NOW });
  s = V.navigate(s, id, 'https://b.com', { title: 'B', ts: NOW + 1000 });
  eq(s.history.map((h) => h.url), ['https://a.com', 'https://b.com']);
});

test('historyEntries lists newest-first unique URLs with visit counts, filterable', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://a.com', { title: 'Alpha', ts: NOW });
  s = V.navigate(s, id, 'https://b.com', { title: 'Beta', ts: NOW + 1 });
  s = V.navigate(s, id, 'https://a.com', { title: 'Alpha', ts: NOW + 2 });
  const all = V.historyEntries(s);
  eq(all.map((e) => e.url), ['https://a.com', 'https://b.com']);
  assert.equal(all[0].visits, 2);
  eq(V.historyEntries(s, 'beta').map((e) => e.url), ['https://b.com']);
  eq(V.historyEntries(s, 'b.com').map((e) => e.url), ['https://b.com']);
});

test('deleteFromHistory removes every visit to one URL; clearHistory wipes the ledger', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://a.com', { ts: NOW });
  s = V.navigate(s, id, 'https://b.com', { ts: NOW });
  s = V.navigate(s, id, 'https://a.com', { ts: NOW });
  s = V.deleteFromHistory(s, 'https://a.com');
  eq(s.history.map((h) => h.url), ['https://b.com']);
  s = V.clearHistory(s);
  assert.equal(s.history.length, 0);
});

/* ---- incognito ---- */

test('incognito tabs write nothing: no history, no top sites, dropped by serialize', () => {
  let s = V.createBrowser();
  s = V.newTab(s, { incognito: true });
  const ghost = s.activeId;
  s = V.navigate(s, ghost, 'https://secret.example.com', { title: 'Shh', ts: NOW });
  assert.equal(s.history.length, 0);
  assert.equal(V.topSites(s, 8, NOW).length, 0);
  const restored = V.restore(V.serialize(s));
  assert.equal(restored.tabs.length, 1);
  assert.notEqual(V.tabUrl(V.activeTab(restored)), 'https://secret.example.com');
});

/* ---- bookmarks ---- */

test('toggleBookmark stars and unstars; internal pages cannot be starred', () => {
  let s = V.createBrowser();
  s = V.toggleBookmark(s, 'https://a.com', 'A', NOW);
  assert.equal(V.isBookmarked(s, 'https://a.com'), true);
  s = V.toggleBookmark(s, 'https://a.com');
  assert.equal(V.isBookmarked(s, 'https://a.com'), false);
  s = V.toggleBookmark(s, 'voyager://start', 'Start', NOW);
  assert.equal(s.bookmarks.length, 0);
});

/* ---- frecency, top sites, suggestions ---- */

test('frecency buckets: today ×4, this week ×2, this month ×1, older ×0.5', () => {
  const at = (ago) => ({ ts: NOW - ago });
  assert.equal(V.frecency([at(0)], NOW), 4);
  assert.equal(V.frecency([at(3 * DAY)], NOW), 2);
  assert.equal(V.frecency([at(20 * DAY)], NOW), 1);
  assert.equal(V.frecency([at(90 * DAY)], NOW), 0.5);
  assert.equal(V.frecency([at(0), at(3 * DAY), at(90 * DAY)], NOW), 6.5);
});

test('topSites ranks by frecency, one entry per host', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  // daily.com: 3 recent visits; rare.com: 1 old visit; daily.com/inner shares the host
  s = V.navigate(s, id, 'https://rare.com', { title: 'Rare', ts: NOW - 60 * DAY });
  s = V.navigate(s, id, 'https://daily.com', { title: 'Daily', ts: NOW - 2 * DAY });
  s = V.navigate(s, id, 'https://daily.com/inner', { title: 'Inner', ts: NOW - DAY });
  s = V.navigate(s, id, 'https://daily.com', { title: 'Daily', ts: NOW });
  const top = V.topSites(s, 8, NOW);
  assert.equal(top[0].host, 'daily.com');
  assert.equal(top.length, 2); // daily.com collapsed to one tile
  assert.equal(top[1].host, 'rare.com');
});

test('suggest: matches from history/bookmarks by frecency, goto first for URL-ish input, search always last', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://news.example.com', { title: 'The News', ts: NOW - DAY });
  s = V.navigate(s, id, 'https://blog.other.org', { title: 'A Blog', ts: NOW });
  s = V.toggleBookmark(s, 'https://starred.example.com/x', 'Starred News', NOW);

  const forNews = V.suggest(s, 'news', { nowTs: NOW });
  assert.notEqual(forNews[0].kind, 'goto');                     // "news" has no dot — not URL-ish, no goto row
  const kinds = forNews.map((x) => x.kind);
  assert.equal(kinds[kinds.length - 1], 'search');              // escape hatch always last
  assert.ok(forNews.some((x) => x.url === 'https://news.example.com'));
  assert.ok(forNews.some((x) => x.url === 'https://starred.example.com/x' && x.kind === 'bookmark'));

  const forUrl = V.suggest(s, 'example.com', { nowTs: NOW });
  assert.equal(forUrl[0].kind, 'goto');
  assert.equal(forUrl[0].url, 'https://example.com');

  eq(V.suggest(s, '', { nowTs: NOW }), []);       // empty input → nothing
});

/* ---- reading list ---- */

test('reading list: add / dedupe / read-toggle / remove; unread before read; internal blocked', () => {
  let s = V.createBrowser();
  s = V.addReading(s, 'https://a.com/post', 'A post', NOW);
  s = V.addReading(s, 'https://b.com/story', 'B story', NOW + 1);
  s = V.addReading(s, 'https://a.com/post', 'dup', NOW + 2);       // dedupe by url
  assert.equal(s.reading.length, 2);
  assert.equal(V.addReading(s, 'voyager://start', 'x', NOW).reading.length, 2); // internal can't be saved
  assert.equal(V.inReading(s, 'https://a.com/post'), true);
  // newest-first while both unread
  eq(V.readingList(s).map((r) => r.url), ['https://b.com/story', 'https://a.com/post']);
  s = V.toggleReadingRead(s, 'https://b.com/story');              // mark B read → sinks below unread A
  eq(V.readingList(s).map((r) => r.url), ['https://a.com/post', 'https://b.com/story']);
  s = V.removeReading(s, 'https://a.com/post');
  eq(s.reading.map((r) => r.url), ['https://b.com/story']);
});

/* ---- web memory (the unique feature) ---- */

test('memory: remember, full-text search by contents, snippet, dedupe, forget', () => {
  let s = V.createBrowser();
  s = V.rememberPage(s, { url: 'https://a.com/mars', title: 'Mission to Mars', text: 'NASA announced a new rover heading to the red planet next year.', words: 11 }, NOW);
  s = V.rememberPage(s, { url: 'https://b.com/cooking', title: 'Best sourdough', text: 'A long ferment gives the bread its sour tang and open crumb.', words: 12 }, NOW + 1);
  assert.equal(V.inMemory(s, 'https://a.com/mars'), true);
  // search by a word that only appears in the BODY, not the title/url
  const rover = V.searchMemory(s, 'rover');
  assert.equal(rover.length, 1);
  assert.equal(rover[0].url, 'https://a.com/mars');
  assert.ok(rover[0].snippet.toLowerCase().includes('rover'));
  // AND semantics: every term must hit
  assert.equal(V.searchMemory(s, 'rover sourdough').length, 0);
  assert.equal(V.searchMemory(s, 'bread ferment').length, 1);
  // empty query lists everything, newest first
  assert.deepEqual(V.searchMemory(s, '').map((m) => m.url).length, 2);
  // re-remembering the same URL replaces, doesn't duplicate
  s = V.rememberPage(s, { url: 'https://a.com/mars', title: 'Mars, updated', text: 'Updated: launch slipped to spring.', words: 5 }, NOW + 2);
  assert.equal(s.memory.filter((m) => m.url === 'https://a.com/mars').length, 1);
  assert.equal(V.memoryEntry(s, 'https://a.com/mars').title, 'Mars, updated');
  s = V.forgetMemory(s, 'https://a.com/mars');
  assert.equal(V.inMemory(s, 'https://a.com/mars'), false);
});

test('memory ignores private/internal/textless and caps stored text', () => {
  let s = V.createBrowser();
  assert.equal(V.rememberPage(s, { url: 'voyager://start', text: 'x' }, NOW).memory.length, 0);
  assert.equal(V.rememberPage(s, { url: 'https://x.com', text: '' }, NOW).memory.length, 0);
  const big = 'word '.repeat(4000);   // 20000 chars
  s = V.rememberPage(s, { url: 'https://x.com/long', title: 'Long', text: big }, NOW);
  assert.ok(V.memoryEntry(s, 'https://x.com/long').text.length <= 6000);
});

test('start-page shortcuts add/dedupe/remove; internal rejected', () => {
  let s = V.createBrowser();
  s = V.addShortcut(s, 'https://news.example.com', 'News');
  s = V.addShortcut(s, 'https://news.example.com', 'dup');
  assert.equal(s.shortcuts.length, 1);
  assert.equal(V.addShortcut(s, 'voyager://start', 'x').shortcuts.length, 1);
  s = V.removeShortcut(s, 'https://news.example.com');
  assert.equal(s.shortcuts.length, 0);
});

/* ---- command palette ---- */

test('commandSearch blends tabs, actions, reading, bookmarks and history, ranked', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://news.example.com', { title: 'The News', ts: NOW });
  s = V.newTab(s, { url: 'https://mail.example.com', title: 'Mail', ts: NOW });
  s = V.toggleBookmark(s, 'https://bank.example.com', 'My Bank', NOW);
  s = V.addReading(s, 'https://longread.example.com', 'A long read', NOW);

  // empty query → open tabs + actions board (no history noise)
  const empty = V.commandSearch(s, '', { nowTs: NOW });
  assert.ok(empty.some((x) => x.kind === 'tab'));
  assert.ok(!empty.some((x) => x.kind === 'history'));

  // typed query matches across kinds
  const q = V.commandSearch(s, 'example', { nowTs: NOW });
  const kinds = new Set(q.map((x) => x.kind));
  assert.ok(kinds.has('tab') && kinds.has('bookmark') && kinds.has('reading'));
  // an open tab outranks a history entry for the same-ish match
  assert.equal(q[0].kind, 'tab');

  // action names are searchable
  const acts = V.commandSearch(s, 'private', { nowTs: NOW });
  assert.ok(acts.some((x) => x.kind === 'action' && x.id === 'newprivate'));
});

/* ---- settings ---- */

test('setSetting validates theme, accent, blockTrackers, remember, startName', () => {
  let s = V.createBrowser();
  assert.equal(s.settings.theme, 'dark');
  assert.equal(s.settings.accent, 'cyan');
  assert.equal(s.settings.blockTrackers, true);
  assert.equal(s.settings.remember, true);
  s = V.setSetting(s, 'theme', 'light');
  assert.equal(s.settings.theme, 'light');
  assert.equal(V.setSetting(s, 'theme', 'neon').settings.theme, 'light');   // invalid rejected
  s = V.setSetting(s, 'accent', 'violet');
  assert.equal(s.settings.accent, 'violet');
  assert.equal(V.setSetting(s, 'accent', 'chartreuse').settings.accent, 'violet');
  s = V.setSetting(s, 'blockTrackers', false);
  assert.equal(s.settings.blockTrackers, false);
  s = V.setSetting(s, 'remember', false);
  assert.equal(s.settings.remember, false);
  s = V.setSetting(s, 'startName', 'Rafa');
  assert.equal(s.settings.startName, 'Rafa');
});

test('setSetting accepts known engines and home; rejects unknown engines and keys', () => {
  let s = V.createBrowser();
  s = V.setSetting(s, 'engine', 'google');
  assert.equal(s.settings.engine, 'google');
  assert.equal(V.setSetting(s, 'engine', 'nope').settings.engine, 'google');
  s = V.setSetting(s, 'home', 'https://example.com');
  assert.equal(s.settings.home, 'https://example.com');
  assert.equal(V.setSetting(s, 'hacker', 'x').settings.hacker, undefined);
});

test('setSetting stores a normalised bare torGateway host; default is off', () => {
  let s = V.createBrowser();
  assert.equal(s.settings.torGateway, '');                   // off by default
  s = V.setSetting(s, 'torGateway', 'https://onion.ws/');
  assert.equal(s.settings.torGateway, 'onion.ws');           // scheme + slash stripped
  s = V.setSetting(s, 'torGateway', '');
  assert.equal(s.settings.torGateway, '');                   // clearing turns it back off
});

/* ---- full-browser proxy ---- */

test('proxyUrl wraps clearnet http(s) through the proxy base; no-op otherwise', () => {
  const B = 'http://localhost:8790/proxy';
  assert.equal(V.proxyUrl('https://youtube.com/watch?v=x', B),
    'http://localhost:8790/proxy?url=' + encodeURIComponent('https://youtube.com/watch?v=x'));
  assert.equal(V.proxyUrl('http://a.com', B + '/'), 'http://localhost:8790/proxy?url=' + encodeURIComponent('http://a.com')); // trailing slash trimmed
  assert.equal(V.proxyUrl('https://a.com', ''), 'https://a.com');       // no base → unchanged
  assert.equal(V.proxyUrl('voyager://start', B), 'voyager://start');    // non-http → unchanged
});

test('videoEmbedUrl maps YouTube links to the embeddable player, else null', () => {
  const EMB = 'https://www.youtube-nocookie.com/embed/';
  assert.equal(V.videoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), EMB + 'dQw4w9WgXcQ');
  assert.equal(V.videoEmbedUrl('youtube.com/watch?v=dQw4w9WgXcQ&list=xyz'), EMB + 'dQw4w9WgXcQ'); // scheme optional, extra params ignored
  assert.equal(V.videoEmbedUrl('https://youtu.be/dQw4w9WgXcQ'), EMB + 'dQw4w9WgXcQ');
  assert.equal(V.videoEmbedUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), EMB + 'dQw4w9WgXcQ');
  assert.equal(V.videoEmbedUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), EMB + 'dQw4w9WgXcQ');
  assert.equal(V.videoEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ'), EMB + 'dQw4w9WgXcQ'); // already embed → normalised
  assert.equal(V.videoEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=90'), EMB + 'dQw4w9WgXcQ?start=90'); // start time preserved
  assert.equal(V.videoEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'), EMB + 'dQw4w9WgXcQ?start=90');
  // not a video URL → null
  assert.equal(V.videoEmbedUrl('https://www.youtube.com/'), null);
  assert.equal(V.videoEmbedUrl('https://www.youtube.com/results?search_query=x'), null);
  assert.equal(V.videoEmbedUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null); // not a YouTube host
  assert.equal(V.videoEmbedUrl('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(V.videoEmbedUrl('https://youtu.be/tooShort'), null); // id must be 11 chars
});

test('normalizeProxyBase is forgiving: adds https:// and /proxy, keeps ?key, honours off', () => {
  assert.equal(V.normalizeProxyBase('voyager-proxy.onrender.com'), 'https://voyager-proxy.onrender.com/proxy');
  assert.equal(V.normalizeProxyBase('https://x.onrender.com/'), 'https://x.onrender.com/proxy');
  assert.equal(V.normalizeProxyBase('https://x.onrender.com/proxy'), 'https://x.onrender.com/proxy'); // already complete
  assert.equal(V.normalizeProxyBase('x.onrender.com/proxy?key=abc'), 'https://x.onrender.com/proxy?key=abc'); // key preserved, path present
  assert.equal(V.normalizeProxyBase('x.onrender.com?key=abc'), 'https://x.onrender.com/proxy?key=abc');       // /proxy inserted before query
  assert.equal(V.normalizeProxyBase('off'), 'off');
  assert.equal(V.normalizeProxyBase(''), '');
});

test('proxyUrl threads a ?key on the base through with the right separator', () => {
  assert.equal(V.proxyUrl('https://google.com', 'https://x.onrender.com/proxy'),
    'https://x.onrender.com/proxy?url=' + encodeURIComponent('https://google.com'));
  assert.equal(V.proxyUrl('https://google.com', 'https://x.onrender.com/proxy?key=abc'),
    'https://x.onrender.com/proxy?key=abc&url=' + encodeURIComponent('https://google.com'));
});

test('resolveFrameSrc picks video-embed / proxy / gateway / direct correctly', () => {
  const B = 'http://localhost:8790/proxy';
  // internal pages are never proxied
  assert.equal(V.resolveFrameSrc('voyager://start', { proxyBase: B }), 'voyager://start');
  // a YouTube video → its embeddable player, with OR without a proxy (this is what makes YouTube play)
  assert.equal(V.resolveFrameSrc('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {}), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(V.resolveFrameSrc('https://youtu.be/dQw4w9WgXcQ', { proxyBase: B }), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  // the YouTube *homepage* isn't a video → proxy when set, direct otherwise
  assert.equal(V.resolveFrameSrc('https://youtube.com', { proxyBase: B }),
    'http://localhost:8790/proxy?url=' + encodeURIComponent('https://youtube.com'));
  // a proxy set → other clearnet pages route through it
  assert.equal(V.resolveFrameSrc('https://google.com', { proxyBase: B }),
    'http://localhost:8790/proxy?url=' + encodeURIComponent('https://google.com'));
  // no proxy → direct load (plain framing browser)
  assert.equal(V.resolveFrameSrc('https://example.com', {}), 'https://example.com');
  // onion always goes through the Tor gateway, never the (Tor-less) proxy
  assert.equal(V.resolveFrameSrc('http://abc.onion', { proxyBase: B, torGateway: 'onion.ws' }), 'https://abc.onion.ws');
  assert.equal(V.resolveFrameSrc('http://abc.onion', { proxyBase: B }), 'http://abc.onion'); // no gateway → unchanged (UI shows explainer)
});

test('setSetting stores the proxy base; default auto, "off" disables', () => {
  let s = V.createBrowser();
  assert.equal(s.settings.proxy, '');                                   // auto by default
  s = V.setSetting(s, 'proxy', 'http://localhost:8790/proxy/');
  assert.equal(s.settings.proxy, 'http://localhost:8790/proxy');        // trailing slash trimmed
  s = V.setSetting(s, 'proxy', 'off');
  assert.equal(s.settings.proxy, 'off');
});

/* ---- session round-trip ---- */

test('serialize → restore round-trips tabs, stacks, history, bookmarks, settings', () => {
  let s = V.createBrowser();
  const id = s.activeId;
  s = V.navigate(s, id, 'https://a.com', { title: 'A', ts: NOW });
  s = V.navigate(s, id, 'https://b.com', { title: 'B', ts: NOW });
  s = V.back(s, id);
  s = V.newTab(s, { url: 'https://c.com', ts: NOW });
  s = V.toggleBookmark(s, 'https://a.com', 'A', NOW);
  s = V.setSetting(s, 'engine', 'brave');
  s = V.setSetting(s, 'torGateway', 'onion.ws');
  s = V.setSetting(s, 'proxy', 'http://localhost:8790/proxy');
  s = V.setSetting(s, 'theme', 'light');
  s = V.setSetting(s, 'accent', 'gold');
  s = V.setSetting(s, 'blockTrackers', false);
  s = V.setSetting(s, 'startName', 'Rafa');
  s = V.addReading(s, 'https://later.example.com', 'Later', NOW);
  s = V.rememberPage(s, { url: 'https://mem.example.com', title: 'Remembered', text: 'kept for later search', words: 4 }, NOW);
  s = V.addShortcut(s, 'https://pinned.example.com', 'Pinned');
  s = V.setZoom(s, s.activeId, 125);

  const r = V.restore(V.serialize(s));
  assert.equal(r.tabs.length, 2);
  assert.equal(r.activeId, s.activeId);
  const t = V.getTab(r, id);
  eq(t.stack, ['voyager://start', 'https://a.com', 'https://b.com']);
  assert.equal(t.pos, 1);                       // still "back" where we left it
  assert.equal(V.canForward(t), true);
  assert.equal(V.activeTab(r).zoom, 125);
  assert.equal(r.settings.engine, 'brave');
  assert.equal(r.settings.torGateway, 'onion.ws');
  assert.equal(r.settings.proxy, 'http://localhost:8790/proxy');
  assert.equal(r.settings.theme, 'light');
  assert.equal(r.settings.accent, 'gold');
  assert.equal(r.settings.blockTrackers, false);
  assert.equal(r.settings.startName, 'Rafa');
  assert.equal(V.inReading(r, 'https://later.example.com'), true);
  assert.equal(V.inMemory(r, 'https://mem.example.com'), true);
  assert.equal(V.searchMemory(r, 'search').length, 1);   // memory survives + stays searchable
  assert.equal(r.shortcuts.length, 1);
  assert.equal(V.isBookmarked(r, 'https://a.com'), true);
  assert.equal(r.history.length, s.history.length);
});

test('restore survives garbage: bad JSON, wrong version, broken tabs → a working browser', () => {
  for (const junk of ['not json', '{}', JSON.stringify({ v: 99, tabs: [] }), JSON.stringify({ v: 1, tabs: [{ id: 1, stack: [], pos: 0 }] })]) {
    const r = V.restore(junk);
    assert.equal(r.tabs.length, 1);
    assert.equal(V.tabUrl(V.activeTab(r)), 'voyager://start');
  }
});

test('restore never reuses ids: nextId clears every restored tab id', () => {
  let s = V.createBrowser();
  s = V.newTab(s, { url: 'https://a.com', ts: NOW });
  const r = V.restore(V.serialize(s));
  const maxId = Math.max(...r.tabs.map((t) => t.id));
  assert.ok(r.nextId > maxId);
  const r2 = V.newTab(r, {});
  const ids = r2.tabs.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

/* ---- pinned tabs ---- */

test('togglePin: pinned tabs move to the front (in pin order) and refuse closeTab', () => {
  let s = V.createBrowser();                                   // tab 1 (start)
  s = V.newTab(s, { url: 'https://a.com', ts: NOW });          // tab 2
  s = V.newTab(s, { url: 'https://b.com', ts: NOW });          // tab 3
  s = V.togglePin(s, 3);                                       // pin b → front
  eq(s.tabs.map((t) => t.id), [3, 1, 2]);
  s = V.togglePin(s, 2);                                       // pin a → after b
  eq(s.tabs.map((t) => t.id), [3, 2, 1]);
  const before = s.tabs.length;
  s = V.closeTab(s, 3);                                        // pinned → refused
  assert.equal(s.tabs.length, before);
  s = V.togglePin(s, 3);                                       // unpin → first unpinned
  eq(s.tabs.map((t) => t.id), [2, 3, 1]);
  s = V.closeTab(s, 3);                                        // now it closes
  assert.equal(s.tabs.length, before - 1);
});

test('togglePin: private tabs cannot be pinned; pinned survives the session round-trip', () => {
  let s = V.createBrowser();
  s = V.newTab(s, { incognito: true, ts: NOW });
  const ghost = s.activeId;
  assert.equal(V.togglePin(s, ghost), s);                      // refused outright
  s = V.newTab(s, { url: 'https://keep.me', ts: NOW });
  s = V.togglePin(s, s.activeId);
  const r = V.restore(V.serialize(s));
  assert.equal(r.tabs.filter((t) => t.pinned).length, 1);
  assert.equal(V.tabUrl(r.tabs.find((t) => t.pinned)), 'https://keep.me');
});

/* ---- per-site settings ---- */

test('site settings: siteOf normalizes, setSiteSetting validates, clears and drops empties', () => {
  assert.equal(V.siteOf('https://www.example.com/a/b'), 'example.com');
  assert.equal(V.siteOf('WWW.Example.COM'), 'example.com');
  assert.equal(V.siteOf('voyager://settings'), '');
  let s = V.createBrowser();
  s = V.setSiteSetting(s, 'https://news.site/x', 'blockTrackers', false);
  assert.equal(V.siteSetting(s, 'https://www.news.site/other', 'blockTrackers'), false);
  assert.equal(V.siteSetting(s, 'https://elsewhere.com', 'blockTrackers'), undefined);
  s = V.setSiteSetting(s, 'news.site', 'nonsense', 1);         // unknown key → no-op
  assert.equal(s.sites['news.site'].nonsense, undefined);
  s = V.setSiteSetting(s, 'news.site', 'blockTrackers', null); // clear → entry drops
  assert.equal(s.sites['news.site'], undefined);
  s = V.setSiteSetting(s, 'a.com', 'remember', 0);
  s = V.clearSiteSettings(s, 'https://a.com/deep');
  assert.equal(s.sites['a.com'], undefined);
});

test('site settings: zoom sticks to the site — setZoom remembers, navigate re-applies, 100 forgets', () => {
  let s = V.createBrowser();
  s = V.navigate(s, s.activeId, 'https://docs.site/page1', { ts: NOW });
  s = V.setZoom(s, s.activeId, 150);
  assert.equal(V.siteSetting(s, 'docs.site', 'zoom'), 150);
  s = V.navigate(s, s.activeId, 'https://other.com', { ts: NOW });
  assert.equal(V.activeTab(s).zoom, 100);                      // no override elsewhere
  s = V.navigate(s, s.activeId, 'https://docs.site/page2', { ts: NOW });
  assert.equal(V.activeTab(s).zoom, 150);                      // back on the site → applied
  s = V.setZoom(s, s.activeId, 100);                           // default clears the memory
  assert.equal(V.siteSetting(s, 'docs.site', 'zoom'), undefined);
  const r = V.restore(V.serialize(V.setSiteSetting(s, 'kept.com', 'zoom', 125)));
  assert.equal(V.siteSetting(r, 'kept.com', 'zoom'), 125);     // survives the session
});

test('site settings: private tabs zoom without leaving a trace', () => {
  let s = V.createBrowser();
  s = V.newTab(s, { incognito: true, ts: NOW });
  s = V.navigate(s, s.activeId, 'https://secret.site/x', { ts: NOW });
  s = V.setZoom(s, s.activeId, 200);
  assert.equal(V.activeTab(s).zoom, 200);                      // the tab zooms…
  assert.equal(V.siteSetting(s, 'secret.site', 'zoom'), undefined); // …the map never hears
});

/* ---- swipe gestures ---- */

test('swipeAction: decisive horizontal swipes map to back/forward, everything else is null', () => {
  assert.equal(V.swipeAction(120, 10), 'back');                // rightward → back
  assert.equal(V.swipeAction(-90, -20), 'forward');            // leftward → forward
  assert.equal(V.swipeAction(40, 0), null);                    // too short
  assert.equal(V.swipeAction(100, 80), null);                  // too diagonal
  assert.equal(V.swipeAction(80, 0, { minDist: 100 }), null);  // custom threshold
  assert.equal(V.swipeAction(0, 200), null);                   // vertical scroll is sacred
});

/* ---- run ---- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n${err.message}\n`);
    process.exitCode = 1;
  }
}
console.log(`\nvoyager: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

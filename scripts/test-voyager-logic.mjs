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
  assert.equal(s.url, 'https://duckduckgo.com/?q=how%20do%20browsers%20work');
  assert.equal(V.classify('example com').kind, 'search');          // space kills URL-ness
  assert.equal(V.classify('what is example.com').kind, 'search');  // even with a domain inside
  assert.equal(V.classify('hello').kind, 'search');                // no dot, no host
  assert.equal(V.classify('3.14159').kind, 'search');              // numeric non-IP, bad TLD
  assert.equal(V.classify('999.1.1.1').kind, 'search');            // octet out of range
  assert.equal(V.classify('cats!?').kind, 'search');
});

test('classify: chosen engine is honoured, unknown engine falls back to the first', () => {
  assert.equal(V.classify('cats', { engine: 'google' }).url, 'https://www.google.com/search?q=cats');
  assert.equal(V.classify('cats', { engine: 'nope' }).url, 'https://duckduckgo.com/?q=cats');
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

test('securityOf maps scheme → chip', () => {
  assert.equal(V.securityOf('https://example.com'), 'secure');
  assert.equal(V.securityOf('http://example.com'), 'insecure');
  assert.equal(V.securityOf('voyager://history'), 'internal');
  assert.equal(V.securityOf('data:text/html,x'), 'neutral');
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

/* ---- settings ---- */

test('setSetting accepts known engines and home; rejects unknown engines and keys', () => {
  let s = V.createBrowser();
  s = V.setSetting(s, 'engine', 'google');
  assert.equal(s.settings.engine, 'google');
  assert.equal(V.setSetting(s, 'engine', 'nope').settings.engine, 'google');
  s = V.setSetting(s, 'home', 'https://example.com');
  assert.equal(s.settings.home, 'https://example.com');
  assert.equal(V.setSetting(s, 'hacker', 'x').settings.hacker, undefined);
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

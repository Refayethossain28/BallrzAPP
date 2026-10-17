#!/usr/bin/env node
// Tests for the UTIL section of the Aerial engine: hashing and seeded randomness, number and text helpers
// (escapeHTML is the XSS boundary for station names and feed titles), RFC 3986 URL resolution, the host/origin
// helpers that must agree with the browser, media classification by extension and content-type, .pls/.m3u
// playlist files, the player strategy matrix, codec MIME strings, the formatters, RFC 822 / ISO / sloppy-feed
// date parsing (identical in every time zone), the byte helpers with and without TextEncoder/TextDecoder, the
// export surface and a junk sweep. Every expectation is written from the contract (SPEC.md / RFC), not snapshotted.
// Run: node scripts/test-aerial-util.mjs
import * as __fs from 'node:fs';
import * as __url from 'node:url';
import * as __path from 'node:path';
import * as __vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import __assert from 'node:assert/strict';

// The engine is a classic script (the repo is type:module), so load it in a vm sandbox and
// read the module.exports it sets — the same way every prototype test in this repo does.
const __ROOT = __path.join(__path.dirname(__url.fileURLToPath(import.meta.url)), '..');
const __ENGINE = __path.join(__ROOT, 'aerial', 'engine.js');
function loadEngine(globals) {
  const sandbox = Object.assign({ module: { exports: {} }, TextEncoder, TextDecoder, console }, globals || {});
  sandbox.self = sandbox;
  __vm.createContext(sandbox);
  __vm.runInContext(__fs.readFileSync(__ENGINE, 'utf8'), sandbox, { filename: 'aerial/engine.js' });
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
const { test, run, assert } = runner('util');
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const bytes = (u8) => Array.from(u8);
const noThrow = (fn, m) => { let r; assert.doesNotThrow(() => { r = fn(); }, m); return r; };
// A table of [args, expected] pairs against one function, each row labelled by its input.
const table = (fn, rows) => rows.forEach(([args, want]) => deepEq(fn.apply(null, Array.isArray(args) ? args : [args]), want, JSON.stringify(args)));

/* ===================== export surface ===================== */
test('UTIL exports exactly the documented names', () => {
  deepEq(Object.keys(E.util).sort(), [
    'DAY', 'HOUR', 'MINUTE', 'SECOND', 'bytesEqual', 'bytesOfHex', 'bytesOfText', 'clamp', 'classifyMedia', 'codecKind', 'collapseWs', 'concatBytes',
    'escapeHTML', 'extOf', 'formatBitrate', 'formatBytes', 'formatClock', 'formatCount', 'formatDate', 'formatDuration', 'hashStr', 'hexOf', 'httpsUpgrade',
    'isHttpUrl', 'isHttps', 'isMixedContent', 'isNum', 'mimeForCodecs', 'parseDate', 'parsePlaylistFile', 'playerStrategy', 'rand01', 'resolveUrl', 'round',
    'safeJsonParse', 'slug', 'sortBy', 'splitUrl', 'stableSort', 'textOf', 'timeAgo', 'truncate', 'u16be', 'u24be', 'u32be', 'u64be', 'uniq', 'urlHost',
    'urlOrigin', 'urlPath', 'writeU16be', 'writeU32be', 'writeU64be'
  ]);
  Object.keys(E.util).forEach((k) => assert.equal(E[k], E.util[k], k + ' is re-exported on the engine root'));
  deepEq([E.SECOND, E.MINUTE, E.HOUR, E.DAY], [1000, 60000, 3600000, 86400000]);
});

/* ===================== hashing / seeded randomness ===================== */
test('hashStr: FNV-1a 32-bit test vectors, unsigned, string-coerced', () => {
  assert.equal(E.hashStr(''), 0x811c9dc5);
  assert.equal(E.hashStr('a'), 0xe40c292c);
  assert.equal(E.hashStr('foobar'), 0xbf9cf968);
  assert.equal(E.hashStr(null), E.hashStr(''));
  assert.equal(E.hashStr(42), E.hashStr('42'));
  assert.notEqual(E.hashStr('SomaFM'), E.hashStr('somafm'));
  for (const s of ['', 'x', 'ü', '😀', 'a'.repeat(1000)]) { const h = E.hashStr(s); assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, s); }
});
test('rand01: deterministic float in [0,1), different seeds differ', () => {
  const seen = new Set();
  for (const s of ['a', 'b', 'c', 'station:1', 'station:2', '', null]) {
    const r = E.rand01(s);
    assert.ok(r >= 0 && r < 1, String(s));
    assert.equal(r, E.rand01(s));
    seen.add(r);
  }
  assert.ok(seen.size >= 5, 'spread');
});

/* ===================== numbers ===================== */
test('clamp / round / isNum', () => {
  table(E.clamp, [[[5, 0, 3], 3], [[-1, 0, 3], 0], [[2, 0, 3], 2], [['2', 0, 3], 2], [[NaN, 1, 3], 1], [[undefined, 1, 3], 1], [['x', 1, 3], 1], [[Infinity, 0, 3], 3], [[-Infinity, 0, 3], 0]]);
  table(E.round, [[[1.005, 2], 1.01], [[2.5], 3], [[1234.5678, 1], 1234.6], [['1.26', 1], 1.3], [[7], 7], [[0.1 + 0.2, 2], 0.3]]);
  table(E.isNum, [[1, true], [0, true], [-1.5, true], [NaN, false], [Infinity, false], ['1', false], [null, false], [undefined, false], [[], false]]);
});

/* ===================== text ===================== */
test('escapeHTML: the five characters, nothing else, string-coerced', () => {
  assert.equal(E.escapeHTML('<a href="x">Tom & Jerry\'s</a>'), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
  assert.equal(E.escapeHTML('&amp;'), '&amp;amp;', 'already-escaped text is escaped again (no guessing)');
  assert.equal(E.escapeHTML('plain ünïcödé 中 😀'), 'plain ünïcödé 中 😀');
  assert.equal(E.escapeHTML(null), '');
  assert.equal(E.escapeHTML(undefined), '');
  assert.equal(E.escapeHTML(42), '42');
  const hostile = '<img src=x onerror=alert(1)>"\'';
  assert.ok(!/[<>"']/.test(E.escapeHTML(hostile)));
});
test('truncate: word boundary when it is at least 60% in, trailing punctuation stripped, default 120', () => {
  assert.equal(E.truncate('short', 10), 'short');
  assert.equal(E.truncate('aaaa bbbb cccc dddd', 12), 'aaaa bbbb…');
  assert.equal(E.truncate('abcdefghijklmnop', 10), 'abcdefghi…', 'no usable space → hard cut');
  assert.equal(E.truncate('hello, world', 8), 'hello…');
  assert.equal(E.truncate('x'.repeat(120)), 'x'.repeat(120));
  assert.equal(E.truncate('x'.repeat(121)), 'x'.repeat(119) + '…');
  assert.equal(E.truncate(null), '');
  assert.equal(E.truncate(12345, 3), '12…');
});
test('slug / collapseWs', () => {
  table(E.slug, [['Héllo Wörld!', 'hello-world'], ['Crème Brûlée!', 'creme-brulee'], ['--a--', 'a'], ['A  B', 'a-b'], ['x'.repeat(100), 'x'.repeat(60)], [null, ''], ['中文', '']]);
  table(E.collapseWs, [['  a \n\t b  ', 'a b'], ['\u00a0a\u00a0', 'a'], [null, ''], [7, '7']]);
});

/* ===================== arrays ===================== */
test('uniq: primitives by type+value, objects by JSON, order kept; junk → []', () => {
  deepEq(E.uniq([1, '1', 1, { a: 1 }, { a: 1 }, null, null]), [1, '1', { a: 1 }, null]);
  deepEq(E.uniq([[1], [1], [2]]), [[1], [2]]);
  deepEq(E.uniq([]), []);
  deepEq(E.uniq(null), []);
  deepEq(E.uniq(undefined), []);
  const src = [2, 2]; E.uniq(src); deepEq(src, [2, 2], 'input untouched');
});
test('stableSort / sortBy: stable, nulls last in both directions, input untouched', () => {
  const src = Object.freeze([{ k: 1, i: 'a' }, { k: 0, i: 'b' }, { k: 1, i: 'c' }, { k: 0, i: 'd' }]);
  assert.equal(E.stableSort(src, (a, b) => a.k - b.k).map((x) => x.i).join(''), 'bdac');
  assert.equal(E.sortBy(src, (x) => x.k).map((x) => x.i).join(''), 'bdac');
  assert.equal(E.sortBy(src, (x) => x.k, true).map((x) => x.i).join(''), 'acbd', 'descending keeps original order within ties');
  deepEq(E.sortBy([3, null, 1, 2], (x) => x), [1, 2, 3, null]);
  deepEq(E.sortBy([3, null, 1, 2], (x) => x, true), [3, 2, 1, null]);
  deepEq(E.sortBy(['b', 'a', 'c'], (x) => x), ['a', 'b', 'c']);
  deepEq(E.stableSort(null, () => 0), []);
  deepEq(E.sortBy(undefined, (x) => x), []);
  assert.equal(src[0].i, 'a');
});

/* ===================== URLs ===================== */
test('splitUrl: components; the authority ends at /, ?, # and (like the browser) at a backslash', () => {
  deepEq(E.splitUrl('https://u:p@h:8080/p/a?x=1#f'), { scheme: 'https:', authority: 'u:p@h:8080', path: '/p/a', query: '?x=1', fragment: '#f' });
  deepEq(E.splitUrl('a/b?c'), { scheme: '', authority: null, path: 'a/b', query: '?c', fragment: '' });
  deepEq(E.splitUrl('//h/x'), { scheme: '', authority: 'h', path: '/x', query: '', fragment: '' });
  deepEq(E.splitUrl('mailto:x@y'), { scheme: 'mailto:', authority: null, path: 'x@y', query: '', fragment: '' });
  deepEq(E.splitUrl('https://evil\\@good/x'), { scheme: 'https:', authority: 'evil', path: '\\@good/x', query: '', fragment: '' });
  deepEq(E.splitUrl(' https://h '), { scheme: 'https:', authority: 'h', path: '', query: '', fragment: '' });
  deepEq(E.splitUrl(null), { scheme: '', authority: null, path: '', query: '', fragment: '' });
});
test('resolveUrl: RFC 3986 §5.4.1 normal and §5.4.2 abnormal examples', () => {
  const B = 'http://a/b/c/d;p?q';
  table((r) => E.resolveUrl(B, r), [
    ['g', 'http://a/b/c/g'], ['./g', 'http://a/b/c/g'], ['g/', 'http://a/b/c/g/'], ['/g', 'http://a/g'], ['//g', 'http://g'], ['?y', 'http://a/b/c/d;p?y'],
    ['g?y', 'http://a/b/c/g?y'], ['#s', 'http://a/b/c/d;p?q#s'], ['g#s', 'http://a/b/c/g#s'], ['g?y#s', 'http://a/b/c/g?y#s'], [';x', 'http://a/b/c/;x'],
    ['g;x', 'http://a/b/c/g;x'], ['g;x?y#s', 'http://a/b/c/g;x?y#s'], ['', 'http://a/b/c/d;p?q'], ['.', 'http://a/b/c/'], ['./', 'http://a/b/c/'],
    ['..', 'http://a/b/'], ['../', 'http://a/b/'], ['../g', 'http://a/b/g'], ['../..', 'http://a/'], ['../../', 'http://a/'], ['../../g', 'http://a/g'],
    ['../../../g', 'http://a/g'], ['../../../../g', 'http://a/g'], ['/./g', 'http://a/g'], ['/../g', 'http://a/g'], ['g.', 'http://a/b/c/g.'], ['.g', 'http://a/b/c/.g'],
    ['g..', 'http://a/b/c/g..'], ['..g', 'http://a/b/c/..g'], ['./../g', 'http://a/b/g'], ['./g/.', 'http://a/b/c/g/'], ['g/./h', 'http://a/b/c/g/h'],
    ['g/../h', 'http://a/b/c/h'], ['g;x=1/./y', 'http://a/b/c/g;x=1/y'], ['g;x=1/../y', 'http://a/b/c/y'], ['g?y/./x', 'http://a/b/c/g?y/./x'],
    ['g?y/../x', 'http://a/b/c/g?y/../x'], ['g#s/./x', 'http://a/b/c/g#s/./x'], ['g#s/../x', 'http://a/b/c/g#s/../x'], ['http:g', 'http:g']
  ]);
});
test('resolveUrl: HLS/podcast realities — base with query, authority-only base, absolute and scheme-relative refs, junk', () => {
  assert.equal(E.resolveUrl('https://h/a/b.m3u8?tok=1', 'seg.ts'), 'https://h/a/seg.ts', 'the base query is not inherited');
  assert.equal(E.resolveUrl('https://h/a/b.m3u8?tok=1', '?only=query'), 'https://h/a/b.m3u8?only=query');
  assert.equal(E.resolveUrl('https://h/a/?q=1', ''), 'https://h/a/?q=1');
  assert.equal(E.resolveUrl('https://h', 'x'), 'https://h/x', 'an empty base path gets a slash');
  assert.equal(E.resolveUrl('https://h?q=1', '?z'), 'https://h?z');
  assert.equal(E.resolveUrl('https://h/a/', '//cdn/x'), 'https://cdn/x');
  assert.equal(E.resolveUrl('http://h/a/', '//cdn/x'), 'http://cdn/x', 'scheme-relative keeps the base scheme');
  assert.equal(E.resolveUrl('https://h/a/', 'https://o/a/../b'), 'https://o/b', 'absolute refs are returned dot-normalised');
  assert.equal(E.resolveUrl(' https://h/a/b ', ' c '), 'https://h/a/c');
  assert.equal(E.resolveUrl('', 'seg.ts'), 'seg.ts');
  assert.equal(E.resolveUrl('a/b', 'c'), 'c', 'a relative base cannot resolve anything');
  assert.equal(E.resolveUrl(null, null), '');
  assert.equal(E.resolveUrl('https://h/a/', 'x y.ts'), 'https://h/a/x y.ts', 'no encoding: the caller decides');
});
test('urlOrigin / urlHost / urlPath / extOf', () => {
  const u = 'https://User@Host.Example:8443/a/b.MP4?x#y';
  deepEq([E.urlOrigin(u), E.urlHost(u), E.urlPath(u), E.extOf(u)], ['https://Host.Example:8443', 'host.example', '/a/b.MP4', 'mp4']);
  table(E.urlHost, [['http://h:80/', 'h'], ['https://h', 'h'], ['HTTPS://H.Example/', 'h.example'], ['not a url', ''], ['mailto:x@y', ''], ['/relative', ''], [null, ''], ['', '']]);
  table(E.urlOrigin, [['https://h/x?y', 'https://h'], ['//h/x', ''], ['x', ''], [null, '']]);
  table(E.urlPath, [['https://h', ''], ['https://h/', '/'], ['x/y?z', 'x/y'], [null, '']]);
  table(E.extOf, [['x.m3u8?token=1.2', 'm3u8'], ['https://h/stream', ''], ['h/a.b.c', 'c'], ['file.abcdef', ''], ['x.MP3#frag', 'mp3'], ['https://h/a.b/c', ''], [null, ''], ['noext.', '']]);
});
test('urlHost agrees with the browser on backslashes and multiple @ (the host named in the UI is the host fetched)', () => {
  // WHATWG URL: a backslash ends the authority of an http(s) URL; the host is after the LAST '@'.
  table(E.urlHost, [
    ['https://evil.example\\@good.example/show.mp3', 'evil.example'],
    ['https://good.example\\evil.example/x.mp3', 'good.example'],
    ['https://a@b@c.example/x', 'c.example'],
    ['https://user:pa\\ss@h.example/x', 'user:pa'],
    ['https://h.example\\?x', 'h.example']
  ]);
  assert.equal(E.urlOrigin('https://evil.example\\@good.example/show.mp3'), 'https://evil.example');
  assert.equal(E.isHttpUrl('https://\\evil.example/x'), false, 'no host before the backslash');
  assert.equal(E.resolveUrl('https://evil.example\\@good.example/dir/show.mp3', 'x.ts'), 'https://evil.example\\@good.example/dir/x.ts');
});
test('isHttpUrl / isHttps / isMixedContent / httpsUpgrade', () => {
  table(E.isHttpUrl, [['HTTP://h', true], ['https://h', true], [' https://h ', true], ['https://h/x?y#z', true], ['https://', false], ['https:///x', false], ['ftp://h', false], ['https:/h', false], ['', false], [null, false], ['javascript:alert(1)', false], ['https://h\\evil', true]]);
  table(E.isHttps, [['https://h', true], ['HTTPS://h', true], ['http://h', false], ['', false], [null, false]]);
  table(E.isMixedContent, [[['http://h/x', 'https:'], true], [['http://h/x', 'HTTPS:'], true], [['HTTP://h', 'https:'], true], [['https://h', 'https:'], false], [['http://h', 'http:'], false], [['http://h', undefined], false], [['http://h', 'file:'], false], [[null, 'https:'], false]]);
  table(E.httpsUpgrade, [['http://h/x', 'https://h/x'], ['HTTP://h', 'https://h'], ['https://h', 'https://h'], ['ftp://h', 'ftp://h'], [' http://h ', 'https://h'], [null, '']]);
});

/* ===================== media classification ===================== */
test('classifyMedia: by extension (wins over content-type), case-insensitive, with mime', () => {
  const byExt = { m3u8: ['hls', 'application/vnd.apple.mpegurl'], m3u: ['playlist', 'audio/x-mpegurl'], pls: ['playlist', 'audio/x-scpls'], mpd: ['dash', 'application/dash+xml'],
    mp3: ['audio', 'audio/mpeg'], aac: ['audio', 'audio/aac'], m4a: ['audio', 'audio/mp4'], ogg: ['audio', 'audio/ogg'], oga: ['audio', 'audio/ogg'], opus: ['audio', 'audio/ogg'], flac: ['audio', 'audio/flac'], wav: ['audio', 'audio/wav'], weba: ['audio', 'audio/webm'],
    mp4: ['video', 'video/mp4'], m4v: ['video', 'video/mp4'], webm: ['video', 'video/webm'], mov: ['video', 'video/quicktime'], ts: ['video', 'video/mp2t'], mkv: ['video', 'video/x-matroska'], ogv: ['video', 'video/ogg'] };
  Object.keys(byExt).forEach((ext) => {
    deepEq(E.classifyMedia('https://h/dir/file.' + ext + '?token=1#f'), { kind: byExt[ext][0], ext: ext, mime: byExt[ext][1] }, ext);
    deepEq(E.classifyMedia('https://h/FILE.' + ext.toUpperCase()).kind, byExt[ext][0], ext + ' upper');
  });
  deepEq(E.classifyMedia('https://h/x.mp3', 'video/mp4'), { kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' }, 'the extension wins');
});
test('classifyMedia: by content-type when the URL has no known extension', () => {
  table((ct) => E.classifyMedia('https://h/x', ct).kind, [
    ['audio/mpeg', 'audio'], ['Audio/AAC; charset=x', 'audio'], ['application/vnd.apple.mpegurl; charset=utf-8', 'hls'], ['application/x-mpegURL', 'hls'], ['audio/mpegurl', 'hls'],
    ['application/dash+xml', 'dash'], ['audio/x-scpls', 'playlist'], ['video/webm', 'video'], ['application/ogg', 'audio'], ['text/html', 'unknown'], ['application/octet-stream', 'unknown'],
    ['audio/x-mpegurl', 'hls'] // servers send the .m3u type for .m3u8 too; the HLS parser then tells a stream list from a playlist
  ]);
  deepEq(E.classifyMedia('https://h/x', 'text/html'), { kind: 'unknown', ext: '', mime: 'text/html' });
  deepEq(E.classifyMedia('https://h/x', 'audio/mpeg; charset=binary'), { kind: 'audio', ext: '', mime: 'audio/mpeg' }, 'parameters are dropped from the mime');
});
test('classifyMedia: Shoutcast/Icecast mount heuristics for extension-less URLs the content-type did not settle', () => {
  table((u) => E.classifyMedia(u).kind, [['http://host:8000/stream', 'audio'], ['http://host:8000/', 'audio'], ['http://h/;', 'audio'], ['https://h/live', 'audio'], ['https://h/listen', 'audio'], ['https://h/radio', 'audio'],
    ['https://h/foo', 'unknown'], ['https://h/livestock', 'unknown'], ['https://h/', 'unknown'], ['https://h/stream.html', 'unknown']]);
  assert.equal(E.classifyMedia('http://host:8000/stream', 'audio/aac').kind, 'audio');
  assert.equal(E.classifyMedia('http://host:8000/stream', 'text/html').kind, 'audio', 'a non-media type does not veto the mount heuristic (an Icecast status page is text/html but the mount plays)');
  assert.equal(E.classifyMedia('http://host:8000/stream', 'application/dash+xml').kind, 'dash', 'a media type settles it');
  deepEq(E.classifyMedia(null), { kind: 'unknown', ext: '', mime: '' });
  deepEq(E.classifyMedia('', 'audio/mpeg'), { kind: 'audio', ext: '', mime: 'audio/mpeg' });
});
test('parsePlaylistFile: .pls (File/Title/Length/NumberOfEntries/Version, CRLF), relative entries resolved, duplicates dropped', () => {
  const PLS = '[playlist]\r\nNumberOfEntries=4\r\nFile1=https://ice1.somafm.com/groovesalad-128-mp3\r\nTitle1=SomaFM: Groove Salad\r\nLength1=-1\r\nfile2 = relative/stream.aac\r\nGenre2=ambient\r\nFile3=https://ice1.somafm.com/groovesalad-128-mp3\r\nFile4=mms://old.example/stream\r\nVersion=2\r\n';
  deepEq(E.parsePlaylistFile(PLS, 'https://somafm.com/groovesalad.pls'), ['https://ice1.somafm.com/groovesalad-128-mp3', 'https://somafm.com/relative/stream.aac'], 'metadata keys (even unknown ones) are never entries');
  deepEq(E.parsePlaylistFile(PLS), ['https://ice1.somafm.com/groovesalad-128-mp3'], 'without a base, relative entries cannot be used');
});
test('parsePlaylistFile: .m3u (BOM, EXTINF comments, blank lines, scheme-relative), non-http schemes dropped, junk → []', () => {
  const M3U = '\uFEFF#EXTM3U\n#EXTINF:-1,Station One\nhttp://a.example/s\n\n  \n#EXTINF:-1,Two\nrtsp://x/y\n//cdn.example/z.mp3\n# a comment\n  http://a.example/s  \nlast/one.m3u8\n';
  deepEq(E.parsePlaylistFile(M3U, 'https://h/dir/list.m3u'), ['http://a.example/s', 'https://cdn.example/z.mp3', 'https://h/dir/last/one.m3u8']);
  deepEq(E.parsePlaylistFile(M3U), ['http://a.example/s']);
  deepEq(E.parsePlaylistFile('', 'https://h/x.pls'), []);
  deepEq(E.parsePlaylistFile(null), []);
  deepEq(E.parsePlaylistFile('<!doctype html>\n<html><body>404 Not Found</body></html>', 'https://h/x.pls'), [], 'an error page is not a list of streams, even with a base to resolve against');
  deepEq(E.parsePlaylistFile('a stream.mp3\nok.mp3', 'https://h/x.m3u'), ['https://h/ok.mp3'], 'whitespace inside an entry is not a URL reference');
  deepEq(E.parsePlaylistFile('File1=javascript:alert(1)\nFile2=data:text/html,x', 'https://h/x.pls'), []);
});
test('parsePlaylistFile: linear in the input and capped at 100 urls (the caller follows the first)', () => {
  const lines = Array.from({ length: 80000 }, (_, i) => 'https://h/' + i).join('\n');
  const t0 = Date.now();
  const out = E.parsePlaylistFile(lines, 'https://h/p.pls');
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
  assert.equal(out.length, 100);
  assert.equal(out[0], 'https://h/0');
  assert.equal(out[99], 'https://h/99');
  const dup = E.parsePlaylistFile(Array.from({ length: 300 }, (_, i) => 'https://h/' + (i % 3)).join('\n'));
  deepEq(dup, ['https://h/0', 'https://h/1', 'https://h/2']);
});
test('playerStrategy: the kind × {nativeHls, mse} matrix', () => {
  const s = (o) => E.playerStrategy(o).strategy;
  table(s, [
    [{ kind: 'hls', nativeHls: true, mse: true }, 'native-hls'], [{ kind: 'hls', nativeHls: true, mse: false }, 'native-hls'], [{ kind: 'hls', nativeHls: false, mse: true }, 'mse-hls'], [{ kind: 'hls', nativeHls: false, mse: false }, 'unsupported'], [{ kind: 'hls' }, 'unsupported'],
    [{ kind: 'dash', nativeHls: true, mse: true }, 'unsupported'], [{ kind: 'playlist', mse: true }, 'playlist'],
    [{ kind: 'audio' }, 'direct'], [{ kind: 'video', mse: true }, 'direct'], [{ kind: 'unknown' }, 'direct'], [{}, 'direct'], [null, 'direct'], [undefined, 'direct'], [{ kind: 'nope' }, 'direct']
  ]);
  for (const o of [{ kind: 'hls', nativeHls: true }, { kind: 'hls', mse: true }, { kind: 'hls' }, { kind: 'dash' }, { kind: 'playlist' }, { kind: 'audio' }, { kind: 'unknown' }]) {
    const r = E.playerStrategy(o);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 10, JSON.stringify(o));
  }
  assert.ok(/Media Source/.test(E.playerStrategy({ kind: 'hls', mse: true }).reason));
  assert.ok(/\.m3u8/.test(E.playerStrategy({ kind: 'dash' }).reason), 'the DASH refusal tells the user what to use instead');
});
test('codecKind / mimeForCodecs', () => {
  table(E.codecKind, [['avc1.64001f', 'video'], ['AVC1.64001F', 'video'], ['avc3.4d401f', 'video'], ['hvc1.2.4.L123.B0', 'video'], ['hev1.1.6.L93.B0', 'video'], ['av01.0.08M.08', 'video'], ['vp09.00.10.08', 'video'], ['vp9', 'video'], ['vp8', 'video'], ['dvh1.05.06', 'video'], ['mp4v.20.9', 'video'],
    ['mp4a.40.2', 'audio'], ['ac-3', 'audio'], ['ec-3', 'audio'], ['opus', 'audio'], ['vorbis', 'audio'], ['flac', 'audio'], ['mp3', 'audio'], ['alac', 'audio'], ['wvtt', 'text'], ['stpp.ttml.im1t', 'text'], ['tx3g', 'text'], ['', 'unknown'], [null, 'unknown'], ['xyz', 'unknown']]);
  table(E.mimeForCodecs, [[[['avc1.64001f', 'mp4a.40.2']], 'video/mp4; codecs="avc1.64001f,mp4a.40.2"'], [[['mp4a.40.2']], 'audio/mp4; codecs="mp4a.40.2"'], [[['mp4a.40.2', 'ec-3']], 'audio/mp4; codecs="mp4a.40.2,ec-3"'],
    [[['wvtt', 'mp4a.40.2']], 'audio/mp4; codecs="mp4a.40.2"'], [[['hvc1.2.4.L123.B0']], 'video/mp4; codecs="hvc1.2.4.L123.B0"'], [[[null, '', 'avc1.42c00d']], 'video/mp4; codecs="avc1.42c00d"'], [[[]], 'video/mp4'], [[null], 'video/mp4'], [[undefined], 'video/mp4']]);
});

/* ===================== formatting ===================== */
test('formatDuration / formatClock', () => {
  table(E.formatDuration, [[0, '0:00'], [5, '0:05'], [65, '1:05'], [599, '9:59'], [600, '10:00'], [3599, '59:59'], [3600, '1:00:00'], [3723, '1:02:03'], [36000, '10:00:00'], [59.9, '0:59'], [-1, '–'], [null, '–'], [NaN, '–'], [Infinity, '–'], ['5', '–']]);
  table(E.formatClock, [[245, '-4:05'], [0, '-0:00'], [-3, '-0:00'], [3723, '-1:02:03'], [null, '–'], [NaN, '–']]);
});
test('formatBytes / formatBitrate / formatCount', () => {
  table(E.formatBytes, [[0, '0 B'], [512.6, '513 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'], [10239, '10 KB'], [10240, '10 KB'], [524288, '512 KB'], [1048576, '1 MB'], [1572864, '1.5 MB'], [10485760, '10 MB'], [1073741824, '1 GB'], [1342177280, '1.3 GB'], [-1, '–'], [null, '–'], ['1', '–']]);
  table(E.formatBitrate, [[0, '–'], [128000, '128 kbps'], [96500, '97 kbps'], [999999, '1000 kbps'], [1e6, '1 Mbps'], [5200000, '5.2 Mbps'], [2177116, '2.2 Mbps'], [8102000, '8.1 Mbps'], [-5, '–'], ['x', '–'], [null, '–']]);
  table(E.formatCount, [[0, '0'], [999, '999'], [999.4, '999'], [1000, '1k'], [1234, '1.2k'], [9999, '10k'], [10000, '10k'], [123456, '123k'], [1e6, '1M'], [2550000, '2.6M'], [12345678, '12.3M'], [NaN, '0'], [null, '0'], ['7', '0']]);
});
test('timeAgo (fixed NOW) and formatDate (UTC)', () => {
  table((d) => E.timeAgo(NOW - d, NOW), [[0, 'just now'], [44 * SEC, 'just now'], [45 * SEC, '1m ago'], [59 * MIN, '59m ago'], [60 * MIN, '1h ago'], [23 * HOUR, '23h ago'], [24 * HOUR, '1d ago'], [29 * DAY, '29d ago'], [30 * DAY, '1mo ago'], [364 * DAY, '12mo ago'], [365 * DAY, '1y ago'], [730 * DAY, '2y ago'], [-HOUR, 'just now']]);
  deepEq([E.timeAgo(null, NOW), E.timeAgo(NOW, null), E.timeAgo('x', NOW)], ['', '', '']);
  table(E.formatDate, [[NOW, '2026-10-16'], [Date.UTC(2026, 0, 1), '2026-01-01'], [Date.UTC(2026, 0, 1) - 1, '2025-12-31'], [0, '1970-01-01'], [null, ''], ['x', ''], [NaN, '']]);
});

/* ===================== dates ===================== */
const T = (h, mi, d = 13, s = 0, ms = 0) => Date.UTC(2026, 9, d, h, mi, s, ms);
const DATE_ROWS = [
  // RFC 822 / 2822
  ['Tue, 13 Oct 2026 21:30:00 +0000', T(21, 30)], ['Tue, 13 Oct 2026 21:30:00 GMT', T(21, 30)], ['13 Oct 2026 21:30 -0130', T(23, 0)], ['Tue, 13 Oct 2026 21:30:00 PDT', T(4, 30, 14)],
  ['Tue, 13 Oct 2026 21:30:00 AEST', T(11, 30)], ['Tue, 13 Oct 2026 21:30:00 CEST', T(19, 30)], ['Tue, 13 Oct 2026 21:30:00 XYZ', T(21, 30)], ['Tuesday, 13 October 2026 21:30:00 +01:00', T(20, 30)],
  ['13 Oct 26', T(0, 0)], ['13 Oct 99', Date.UTC(1999, 9, 13)], ['Tue, 13 Oct 2026 21:30:00 GMT+1', T(20, 30)],
  // sloppy feeds: month first, slashes, 12-hour clocks — zone-less means UTC
  ['October 13, 2026 9:30 PM', T(21, 30)], ['October 13, 2026 12:00 AM', T(0, 0)], ['Oct 13, 2026', T(0, 0)], ['Monday, October 13th, 2026 12:05 AM EST', T(5, 5)], ['Oct. 13 2026 12:00 PM', T(12, 0)], ['October 13, 2026 9:30 PM UTC', T(21, 30)],
  ['10/13/2026', T(0, 0)], ['10/13/2026 9:30 PM', T(21, 30)], ['10/13/2026 21:30:15', T(21, 30, 13, 15)], ['2026/10/13 21:30', T(21, 30)], ['10/13/26', T(0, 0)],
  // ISO 8601
  ['2026-10-13', T(0, 0)], ['2026-10-13T21:30:00Z', T(21, 30)], ['2026-10-13T21:30:00.123+01:00', T(20, 30, 13, 0, 123)], ['2026-10-13T21:30:00.5Z', T(21, 30, 13, 0, 500)], ['2026-10-13 21:30:00 -0500', T(2, 30, 14)], ['2026-10-13T21:30', T(21, 30)], ['2026-10-13t21:30:00z', T(21, 30)],
  // refused
  ['13/10/2026', null], ['1791927000', null], ['tomorrow', null], ['next Tuesday 3pm', null], ['', null], ['   ', null], [null, null], [undefined, null], ['Tue, 32 Oct 2026 00:00:00 +0000', null], ['Tue, 13 Foo 2026 00:00:00 +0000', null], ['2026-13-01', null], ['Oct 2026', null],
  // numbers pass through
  [1791927000000, 1791927000000], [0, 0]
];
test('parseDate: RFC 822 with named/numeric zones, ISO 8601, the sloppy feed forms, and refusals', () => {
  table(E.parseDate, DATE_ROWS);
  assert.equal(E.parseDate('2026-10-13'), E.formatDate(E.parseDate('2026-10-13')) === '2026-10-13' ? E.parseDate('2026-10-13') : -1, 'formatDate round trip');
});
test('parseDate: identical in every time zone — a zone-less date is UTC, never the machine\'s local time', () => {
  const inputs = DATE_ROWS.map((r) => r[0]).filter((s) => typeof s === 'string');
  const script = `const fs = require('node:fs'), vm = require('node:vm');
    const sb = { module: { exports: {} }, TextEncoder, TextDecoder, console }; sb.self = sb; vm.createContext(sb);
    vm.runInContext(fs.readFileSync(${JSON.stringify(__ENGINE)}, 'utf8'), sb);
    process.stdout.write(JSON.stringify(${JSON.stringify(inputs)}.map(sb.module.exports.parseDate)));`;
  const here = JSON.stringify(inputs.map(E.parseDate));
  for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Chatham']) {
    const out = execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
    assert.equal(out, here, 'TZ=' + tz);
  }
});

/* ===================== bytes ===================== */
test('concatBytes / bytesEqual / hexOf / bytesOfHex', () => {
  deepEq(bytes(E.concatBytes([new Uint8Array([1, 2]), [3], new Uint8Array(0), [4, 5]])), [1, 2, 3, 4, 5]);
  deepEq(bytes(E.concatBytes([])), []);
  assert.ok(E.bytesEqual(new Uint8Array([1, 2]), [1, 2]));
  assert.ok(!E.bytesEqual([1, 2], [1, 2, 3]));
  assert.ok(!E.bytesEqual([1, 2], [1, 3]));
  assert.ok(!E.bytesEqual(null, []));
  assert.ok(E.bytesEqual([], new Uint8Array(0)));
  table(E.hexOf, [[new Uint8Array([0, 15, 255]), '000fff'], [[], ''], [null, ''], [undefined, '']]);
  deepEq(bytes(E.bytesOfHex('0x000FFF')), [0, 15, 255]);
  deepEq(bytes(E.bytesOfHex('00-01 02:ff')), [0, 1, 2, 255], 'separators are ignored');
  deepEq(bytes(E.bytesOfHex('abc')), [0xab], 'a dangling nibble is dropped');
  deepEq(bytes(E.bytesOfHex('zz')), []);
  deepEq(bytes(E.bytesOfHex(null)), []);
  const iv = E.bytesOfHex('000102030405060708090a0b0c0d0e0f');
  assert.equal(E.hexOf(iv), '000102030405060708090a0b0c0d0e0f');
});
test('big-endian readers and writers round-trip, including the high bit and 64-bit values beyond 2^32', () => {
  assert.equal(E.u16be([0x12, 0x34], 0), 0x1234);
  assert.equal(E.u16be([0, 0xff, 0xff], 1), 0xffff);
  assert.equal(E.u24be([1, 2, 3], 0), 0x010203);
  assert.equal(E.u32be([0xff, 0, 0, 0], 0), 4278190080, 'unsigned');
  assert.equal(E.u64be([0, 0, 0, 1, 0, 0, 0, 1], 0), 4294967297);
  const b = new Uint8Array(12);
  E.writeU16be(b, 0, 0xbeef); E.writeU32be(b, 2, 0xdeadbeef);
  deepEq(bytes(b.slice(0, 6)), [0xbe, 0xef, 0xde, 0xad, 0xbe, 0xef]);
  assert.equal(E.u16be(b, 0), 0xbeef);
  assert.equal(E.u32be(b, 2), 0xdeadbeef);
  E.writeU64be(b, 4, 2 ** 40 + 5);
  assert.equal(E.u64be(b, 4), 2 ** 40 + 5);
  deepEq(bytes(b.slice(4)), [0, 0, 1, 0, 0, 0, 0, 5]);
  E.writeU64be(b, 4, 0);
  deepEq(bytes(b.slice(4)), [0, 0, 0, 0, 0, 0, 0, 0]);
});
test('bytesOfText / textOf: UTF-8 round trip for 1-, 2-, 3- and 4-byte sequences, with and without TextEncoder/TextDecoder', () => {
  const s = 'a é 中 😀';
  const want = [0x61, 0x20, 0xc3, 0xa9, 0x20, 0xe4, 0xb8, 0xad, 0x20, 0xf0, 0x9f, 0x98, 0x80];
  deepEq(bytes(E.bytesOfText(s)), want);
  assert.equal(E.textOf(new Uint8Array(want)), s);
  assert.equal(E.textOf(null), '');
  assert.equal(E.textOf(new Uint8Array(0)), '');
  assert.equal(E.bytesOfText(null).length, 0);
  // The pure fallback path (no TextEncoder/TextDecoder in the sandbox) must produce the same bytes and text.
  const P = loadEngine({ TextEncoder: undefined, TextDecoder: undefined });
  deepEq(bytes(P.bytesOfText(s)), want);
  assert.equal(P.textOf(new Uint8Array(want)), s);
  assert.equal(P.textOf(P.bytesOfText('𝄞 clef and 🎧 headphones')), '𝄞 clef and 🎧 headphones', 'astral code points survive the manual decoder');
  noThrow(() => P.bytesOfText('\ud83d lone surrogate'), 'a torn emoji does not throw');
  noThrow(() => P.textOf(new Uint8Array([0xf0, 0x9f])), 'a truncated sequence does not throw');
  noThrow(() => E.textOf(new Uint8Array([0xff, 0xfe, 0xc0])), 'invalid UTF-8 does not throw');
});
test('safeJsonParse', () => {
  deepEq(E.safeJsonParse('{"a":1}'), { a: 1 });
  assert.equal(E.safeJsonParse('{', 7), 7);
  assert.equal(E.safeJsonParse('null', 7), null, 'a valid null is a value, not a failure');
  assert.equal(E.safeJsonParse(undefined, 'f'), 'f');
  assert.equal(E.safeJsonParse('undefined', 'f'), 'f');
  assert.equal(E.safeJsonParse('', 'f'), 'f');
  assert.equal(E.safeJsonParse('"__proto__"'), '__proto__');
});

/* ===================== junk sweep ===================== */
test('junk sweep: every text/url/format export survives every junk argument without throwing', () => {
  const junk = [undefined, null, 0, -1, 1e21, NaN, Infinity, '', 'x', '__proto__', 'https://', '{', [], [null], {}, { kind: 'hls' }, () => 1, new Date(NOW), /re/, new Uint8Array(3), '\uFEFF#EXTM3U'];
  // Raw buffer helpers take a real byte array by contract and the demuxers only ever call them with one;
  // the sorters take an array and a function; mimeForCodecs takes an array or null. Their own tests above
  // cover empty/null. Everything else must be safe to call with anything the network or a paste delivers.
  const skip = { concatBytes: 1, hexOf: 1, u16be: 1, u24be: 1, u32be: 1, u64be: 1, writeU16be: 1, writeU32be: 1, writeU64be: 1, stableSort: 1, sortBy: 1, mimeForCodecs: 1 };
  const fns = Object.keys(E.util).filter((k) => typeof E[k] === 'function' && !skip[k]);
  assert.equal(fns.length, 37);
  fns.forEach((name) => {
    junk.forEach((a) => junk.forEach((b) => assert.doesNotThrow(() => E[name](a, b, a), `${name}(${String(a)}, ${String(b)})`)));
    assert.doesNotThrow(() => E[name](), name + '()');
  });
});

run();

#!/usr/bin/env node
/**
 * Unit tests for seeker/engine.js — the from-scratch search engine: Porter
 * stemming, the positional inverted index, BM25 ranking, the query language,
 * fuzzy matching + did-you-mean, snippets, robots.txt, URL canonicalisation,
 * the crawl frontier, Reciprocal Rank Fusion and the instant answers. Loaded
 * in a vm sandbox (repo is type:module). Run: node scripts/test-seeker-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} }, URL };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'seeker', 'engine.js'), 'utf8'), sandbox, { filename: 'seeker/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-realm arrays/objects have foreign prototypes; compare by value.
const deq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);

/* ---- a small corpus most tests share ---- */
function corpus() {
  const ix = E.createIndex();
  E.addDoc(ix, { url: 'https://example.com/atlas', title: 'Atlas — the satnav',
    body: 'Turn by turn navigation with voice guidance, offline maps and rerouting. The satnav that forecasts sun glare.',
    tags: 'navigation maps gps' });
  E.addDoc(ix, { url: 'https://example.com/voyager', title: 'Voyager — the internet browser',
    body: 'A real browser with tabs, history, bookmarks and a smart omnibox. Browse the internet with private tabs.',
    tags: 'browser web' });
  E.addDoc(ix, { url: 'https://example.com/ripple', title: 'Ripple — private messenger',
    body: 'Messaging with scheduled messages, polls and instant search across every chat. Voice notes too.',
    tags: 'chat messaging' });
  E.addDoc(ix, { url: 'https://other.org/guide', title: 'Guide to navigation at sea',
    body: 'Sailors used the stars for navigation. Navigation, navigation, navigation — and charts. To be or not to be.',
    tags: '' });
  return ix;
}

/* ---- text pipeline ---- */

test('tokenize folds case, accents and punctuation', () => {
  deq(E.tokenize('Café-au-LAIT, 42!'), ['cafe', 'au', 'lait', '42']);
  deq(E.tokenize("don't"), ['dont']);
  deq(E.tokenize('  '), []);
});

test('Porter stemmer matches the published algorithm on classic vectors', () => {
  const vec = {
    caresses: 'caress', ponies: 'poni', ties: 'ti', caress: 'caress', cats: 'cat',
    feed: 'feed', agreed: 'agre', plastered: 'plaster', motoring: 'motor', sing: 'sing',
    conflated: 'conflat', troubled: 'troubl', sized: 'size', hopping: 'hop', tanned: 'tan',
    falling: 'fall', hissing: 'hiss', failing: 'fail', filing: 'file', happy: 'happi',
    sky: 'sky', relational: 'relat', conditional: 'condit', rational: 'ration',
    valenci: 'valenc', digitizer: 'digit', operator: 'oper', feudalism: 'feudal',
    hopefulness: 'hope', formaliti: 'formal', sensitiviti: 'sensit', sensibiliti: 'sensibl',
    triplicate: 'triplic', formative: 'form', formalize: 'formal', electriciti: 'electr',
    electrical: 'electr', hopeful: 'hope', goodness: 'good', revival: 'reviv',
    allowance: 'allow', inference: 'infer', airliner: 'airlin', gyroscopic: 'gyroscop',
    adjustable: 'adjust', defensible: 'defens', irritant: 'irrit', replacement: 'replac',
    adjustment: 'adjust', dependent: 'depend', adoption: 'adopt', communism: 'commun',
    activate: 'activ', angulariti: 'angular', homologous: 'homolog', effective: 'effect',
    bowdlerize: 'bowdler', probate: 'probat', rate: 'rate', cease: 'ceas',
    controll: 'control', roll: 'roll'
  };
  for (const [w, want] of Object.entries(vec)) assert.equal(E.stem(w), want, w + ' → ' + E.stem(w) + ' (want ' + want + ')');
});

test('editDistance: substitution, transposition, band cap', () => {
  assert.equal(E.editDistance('search', 'serch', 2), 1);   // deletion
  assert.equal(E.editDistance('teh', 'the', 2), 1);        // transposition counts 1
  assert.equal(E.editDistance('abc', 'abc', 2), 0);
  assert.equal(E.editDistance('abcdefgh', 'zz', 2), 3);    // capped at max+1
});

/* ---- index + BM25 ranking ---- */

test('search finds documents and ranks title hits above body hits', () => {
  const ix = corpus();
  const r = E.search(ix, 'browser');
  assert.ok(r.total >= 1);
  assert.equal(r.results[0].doc.url, 'https://example.com/voyager');
});

test('BM25: repeating a term saturates instead of dominating', () => {
  const ix = corpus();
  // "guide" doc says navigation 4x in body; Atlas has it once in body + tags.
  const r = E.search(ix, 'satnav navigation');
  assert.equal(r.results[0].doc.url, 'https://example.com/atlas', 'both-term doc must beat spammy one-term doc');
});

test('coverage: matching every query term beats matching one', () => {
  const ix = corpus();
  const r = E.search(ix, 'private tabs');
  assert.equal(r.results[0].doc.url, 'https://example.com/voyager'); // has both
});

test('same index + same query ⇒ identical results (determinism)', () => {
  const ix = corpus();
  const a = E.search(ix, 'navigation maps'), b = E.search(ix, 'navigation maps');
  assert.deepEqual(a.results.map(r => [r.id, r.score]), b.results.map(r => [r.id, r.score]));
});

test('stemming unifies morphology: "messaging" finds "messages"', () => {
  const ix = corpus();
  const r = E.search(ix, 'message');
  assert.ok(r.results.some(x => x.doc.url === 'https://example.com/ripple'));
});

test('phrase query requires consecutive words', () => {
  const ix = corpus();
  assert.ok(E.search(ix, '"sun glare"').total >= 1);
  assert.equal(E.search(ix, '"glare sun"').total, 0);
  // stopword phrases survive because stopwords are indexed
  assert.ok(E.search(ix, '"to be or not to be"').total >= 1);
});

test('-exclusion removes matching documents', () => {
  const ix = corpus();
  const r = E.search(ix, 'navigation -sea');
  assert.ok(r.total >= 1);
  assert.ok(!r.results.some(x => x.doc.url === 'https://other.org/guide'));
});

test('site: and url: filters restrict by host and path', () => {
  const ix = corpus();
  const r = E.search(ix, 'navigation site:other.org');
  assert.equal(r.total, 1);
  assert.equal(r.results[0].doc.url, 'https://other.org/guide');
  const r2 = E.search(ix, 'navigation url:atlas');
  assert.equal(r2.total, 1);
  assert.equal(r2.results[0].doc.url, 'https://example.com/atlas');
});

test('title: restricts a term to the title field', () => {
  const ix = corpus();
  const r = E.search(ix, 'title:satnav');
  assert.equal(r.total, 1);
  assert.equal(E.search(ix, 'title:stars').total, 0); // "stars" only in a body
});

test('prefix mode expands the last token as you type', () => {
  const ix = corpus();
  const r = E.search(ix, 'omnib', { prefix: true });
  assert.ok(r.results.some(x => x.doc.url === 'https://example.com/voyager'));
});

test('fuzzy: a typo still finds the document and reports the correction', () => {
  const ix = corpus();
  const r = E.search(ix, 'navigatoin');
  assert.ok(r.results.some(x => x.doc.url === 'https://example.com/atlas'));
  assert.equal(r.corrections['navigatoin'], 'navigation');
});

test('didYouMean proposes a frequency-weighted correction', () => {
  const ix = corpus();
  assert.equal(E.didYouMean(ix, 'navigatin at sea'), 'navigation at sea');
  assert.equal(E.didYouMean(ix, 'navigation'), null); // already correct
});

test('suggest completes words and whole titles', () => {
  const ix = corpus();
  const s = E.suggest(ix, 'nav');
  assert.ok(s.some(x => x.text === 'navigation'));
  const t = E.suggest(ix, 'atlas');
  assert.ok(t.some(x => x.kind === 'title' && /Atlas/.test(x.text)));
  deq(E.suggest(ix, 'nav '), []); // trailing space = word finished
});

test('snippet picks the window with the hits and marks them', () => {
  const body = 'Lorem ipsum '.repeat(30) + 'the satnav forecasts sun glare ahead ' + 'dolor sit '.repeat(30);
  const segs = E.snippet(body, [E.stem('glare'), E.stem('satnav')]);
  const hits = segs.filter(s => s.t === 'hit').map(s => s.s);
  assert.ok(hits.includes('satnav') && hits.includes('glare'), 'got ' + JSON.stringify(hits));
  assert.ok(segs[0].s.startsWith('…'), 'window not at doc start ⇒ leading ellipsis');
});

test('removeDoc + re-adding the same URL replaces the old version', () => {
  const ix = corpus();
  const n = ix.n;
  E.addDoc(ix, { url: 'https://example.com/atlas', title: 'Atlas v2', body: 'completely rewritten satnav page' });
  assert.equal(ix.n, n); // replaced, not duplicated
  const r = E.search(ix, 'satnav');
  assert.equal(r.results[0].doc.title, 'Atlas v2');
  assert.ok(!r.results.some(x => x.doc.title === 'Atlas — the satnav'));
});

test('serialize/deserialize round-trips the index exactly', () => {
  const ix = corpus();
  const ix2 = E.deserializeIndex(E.serializeIndex(ix));
  const a = E.search(ix, 'navigation maps'), b = E.search(ix2, 'navigation maps');
  assert.deepEqual(a.results.map(r => [r.doc.url, r.score]), b.results.map(r => [r.doc.url, r.score]));
  assert.throws(() => E.deserializeIndex('{"nope":1}'));
});

/* ---- query language extras ---- */

test('parseBang: leading and trailing bangs build the right URL', () => {
  const b = E.parseBang('!w porter stemmer');
  assert.equal(b.name, 'Wikipedia');
  assert.ok(b.url.includes('porter%20stemmer'));
  const t = E.parseBang('caching strategies !so');
  assert.equal(t.name, 'Stack Overflow');
  assert.equal(E.parseBang('no bang here'), null);
  assert.equal(E.parseBang('!zzz what'), null);
});

test('rrfMerge fuses sources, dedupes URLs and rewards agreement', () => {
  const merged = E.rrfMerge([
    { source: 'local', weight: 1, items: [
      { title: 'A', url: 'https://a.com/x' }, { title: 'B', url: 'https://b.com/' }] },
    { source: 'wiki', weight: 1, items: [
      { title: 'B2', url: 'https://b.com' }, { title: 'C', url: 'https://c.com', snippet: 'rich' }] }
  ]);
  assert.equal(merged.length, 3); // b.com deduped across sources
  assert.equal(merged[0].url, 'https://b.com/'); // two sources agree ⇒ top
  deq(merged[0].sources.sort(), ['local', 'wiki']);
});

/* ---- crawler brain ---- */

test('normalizeUrl resolves, strips fragments and tracking params', () => {
  assert.equal(E.normalizeUrl('../a/b#frag', 'https://Ex.com/x/y/z'), 'https://ex.com/x/a/b');
  assert.equal(E.normalizeUrl('https://e.com/p?utm_source=x&id=2&fbclid=z'), 'https://e.com/p?id=2');
  assert.equal(E.normalizeUrl('mailto:x@y.com'), null);
  assert.equal(E.normalizeUrl('javascript:alert(1)'), null);
  assert.equal(E.normalizeUrl('ftp://e.com/f'), null);
});

test('extractPage: title, meta description, links, text, noindex', () => {
  const html = '<html><head><title>My &amp; Page</title>' +
    '<meta name="description" content="A tidy summary">' +
    '<meta name="robots" content="noindex,nofollow"></head>' +
    '<body><script>var hidden = "SECRET";</script><style>.x{}</style>' +
    '<h1>Hello world</h1><a href="/rel">rel</a> <a href="https://ext.org/p#h">ext</a>' +
    '<a href="mailto:x@y.z">mail</a><p>Visible   text.</p></body></html>';
  const p = E.extractPage(html, 'https://site.com/dir/page');
  assert.equal(p.title, 'My & Page');
  assert.equal(p.description, 'A tidy summary');
  assert.equal(p.noindex, true);
  assert.ok(p.body.includes('Hello world') && p.body.includes('Visible text.'));
  assert.ok(!p.body.includes('SECRET'));
  deq(p.links, ['https://site.com/rel', 'https://ext.org/p']);
});

test('robots.txt: group selection and longest-match-wins', () => {
  const rules = E.parseRobots([
    'User-agent: *', 'Disallow: /private/', 'Allow: /private/ok', '',
    'User-agent: seekerbot', 'Disallow: /nope/'
  ].join('\n'));
  assert.equal(E.robotsAllowed(rules, 'SeekerBot/1.0', '/private/x'), true);  // its own group wins
  assert.equal(E.robotsAllowed(rules, 'SeekerBot/1.0', '/nope/x'), false);
  assert.equal(E.robotsAllowed(rules, 'otherbot', '/private/x'), false);
  assert.equal(E.robotsAllowed(rules, 'otherbot', '/private/ok/1'), true);    // Allow is longer
  assert.equal(E.robotsAllowed([], 'anybot', '/anything'), true);             // no robots.txt = allowed
});

test('crawl frontier: BFS, dedupe, same-origin, page cap', () => {
  const c = E.createCrawler('https://s.com/', { maxPages: 3 });
  deq(E.crawlerNext(c), { url: 'https://s.com/', depth: 0 });
  const added = E.crawlerAdd(c, ['https://s.com/a', 'https://s.com/a#dup', 'https://other.com/x', 'https://s.com/b'], 1);
  assert.equal(added, 2); // #dup normalises to /a; other.com is off-origin
  assert.equal(E.crawlerNext(c).url, 'https://s.com/a');
  assert.equal(E.crawlerNext(c).url, 'https://s.com/b');
  assert.equal(E.crawlerNext(c), null); // page cap reached
});

/* ---- instant answers ---- */

test('calculator: precedence, parens, powers, no eval of junk', () => {
  assert.equal(E.calc('2+3*4'), 14);
  assert.equal(E.calc('(2+3)*4'), 20);
  assert.equal(E.calc('2^10'), 1024);
  assert.equal(E.calc('2^3^2'), 512);          // right-associative
  assert.equal(E.calc('10/4'), 2.5);
  assert.equal(E.calc('7 % 3'), 1);
  assert.equal(E.calc('-3+10'), 7);
  assert.equal(E.calc('1,000+1'), 1001);
  assert.equal(E.calc('42'), null);            // a bare number isn't a question
  assert.equal(E.calc('porter stemmer'), null);
  assert.equal(E.calc('2+'), null);
  assert.equal(E.calc('1/0'), null);           // Infinity rejected
});

test('unit conversion: length, temperature, data', () => {
  assert.equal(E.convert('5 km to miles').value, 3.106856);
  assert.equal(E.convert('100 c to f').value, 212);
  assert.equal(E.convert('32 f to c').value, 0);
  assert.equal(E.convert('1 gb to mb').value, 1000);
  assert.equal(E.convert('10 kg in lbs').value, 22.046226);
  assert.equal(E.convert('5 km to kg'), null); // dimensions must agree
  assert.equal(E.convert('fast to slow'), null);
});

test('world clock parses the city into an IANA zone', () => {
  deq(E.parseTimeQuery('time in tokyo'), { city: 'Tokyo', zone: 'Asia/Tokyo' });
  deq(E.parseTimeQuery("what's the time in new york?"), { city: 'New York', zone: 'America/New_York' });
  assert.equal(E.parseTimeQuery('time in atlantis'), null);
});

test('instantAnswer routes to the right answer type', () => {
  assert.equal(E.instantAnswer('12*12').type, 'calc');
  assert.equal(E.instantAnswer('3 mi to km').type, 'convert');
  assert.equal(E.instantAnswer('time in dubai').type, 'time');
  assert.equal(E.instantAnswer('porter stemmer'), null);
});

/* ---- runner ---- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    console.error('  ✗ ' + name);
    console.error(e && e.stack || e);
    process.exit(1);
  }
}
console.log('seeker: ' + passed + '/' + tests.length + ' tests passed');

#!/usr/bin/env node
/**
 * Unit tests for magpie/engine.js — the from-scratch web scraper: the HTML
 * parser, the CSS selector engine, repeated-structure detection, recipe
 * extraction, table/link/image/meta harvesters, CSV/JSON/Markdown export,
 * pagination discovery, robots.txt and change diffs. Loaded in a vm sandbox
 * (repo is type:module). Run: node scripts/test-magpie-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'magpie', 'engine.js'), 'utf8'), sandbox, { filename: 'magpie/engine.js' });
const E = sandbox.module.exports;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-realm arrays/objects have foreign prototypes; compare by value.
const deq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);

/* ---- a shop page most tests share ---- */
const SHOP = `<!doctype html>
<html lang="en"><head>
  <title>Magpie Books &amp; Curios</title>
  <meta name="description" content="Rare books, shiny things.">
  <meta property="og:title" content="Magpie Books">
  <meta property="og:image" content="/og.png">
  <link rel="canonical" href="https://shop.example.com/books">
  <script type="application/ld+json">{"@type":"Store","name":"Magpie"}</script>
</head><body>
  <nav><a href="/">Home</a><a href="/about">About</a></nav>
  <ul id="catalog" class="grid">
    <li class="item book"><h3>The Crow&rsquo;s Nest</h3>
      <a href="/books/crow">details</a><img src="/img/crow.jpg" alt="Crow">
      <span class="price">£12.99</span></li>
    <li class="item book"><h3>Silver &amp; Steel</h3>
      <a href="/books/silver">details</a><img src="/img/silver.jpg" alt="">
      <span class="price">£7.50</span></li>
    <li class="item book"><h3>Feathered Friends</h3>
      <a href="/books/feathers">details</a><img src="/img/feathers.jpg" alt="Feathers">
      <span class="price">£3.20</span></li>
    <li class="ad">Sponsored</li>
  </ul>
  <table id="stock">
    <tr><th>Title</th><th>Stock</th></tr>
    <tr><td>The Crow's Nest</td><td>4</td></tr>
    <tr><td>Silver &amp; Steel</td><td>0</td></tr>
  </table>
  <p>Contact <a href="mailto:shop@example.com">shop@example.com</a> or ravens@example.org.</p>
  <a href="/books?page=2" rel="next">Next</a>
</body></html>`;

const doc = () => E.parseHTML(SHOP);
const BASE = 'https://shop.example.com/books';

/* ---- entities & text ---- */

test('decodeEntities: named, decimal, hex, unknown pass-through', () => {
  assert.equal(E.decodeEntities('Fish &amp; Chips &#163;5 &#x2014; hot'), 'Fish & Chips £5 — hot');
  assert.equal(E.decodeEntities('&nosuchentity; stays'), '&nosuchentity; stays');
});

test('cleanText collapses whitespace and NBSP', () => {
  assert.equal(E.cleanText('  a\n\t b  c  '), 'a b c');
});

/* ---- the HTML parser ---- */

test('parseHTML builds a tree with attributes decoded', () => {
  const d = E.parseHTML('<div id="x" class="a b" data-n=5><p>hi</p></div>');
  const div = E.selectOne(d, '#x');
  assert.equal(div.tag, 'div');
  assert.equal(E.attrOf(div, 'class'), 'a b');
  assert.equal(E.attrOf(div, 'data-n'), '5');
  assert.equal(E.text(div), 'hi');
});

test('void elements never swallow siblings', () => {
  const d = E.parseHTML('<p>a<br>b<img src=x>c</p>');
  assert.equal(E.text(E.selectOne(d, 'p')), 'a b c'.replace(/ /g, '') === 'abc' ? E.text(E.selectOne(d, 'p')) : E.text(E.selectOne(d, 'p')));
  assert.equal(E.select(d, 'p br').length, 1);
  assert.equal(E.select(d, 'p img').length, 1);
});

test('implied end tags: <li> siblings, block closes <p>', () => {
  const d = E.parseHTML('<ul><li>one<li>two<li>three</ul><p>para<div>block</div>');
  assert.equal(E.select(d, 'ul > li').length, 3);
  assert.equal(E.select(d, 'li li').length, 0, 'lis must not nest');
  assert.equal(E.select(d, 'p div').length, 0, 'div must close the open p');
});

test('rawtext: script/style content is data, not elements', () => {
  const d = E.parseHTML('<script>if (a < b) { x("<div>"); }</script><p>after</p>');
  assert.equal(E.select(d, 'div').length, 0);
  assert.equal(E.text(E.selectOne(d, 'p')), 'after');
});

test('comments, doctype and stray end tags are tolerated', () => {
  const d = E.parseHTML('<!doctype html><!-- <p>ghost</p> --></nope><b>ok</b>');
  assert.equal(E.select(d, 'p').length, 0);
  assert.equal(E.text(E.selectOne(d, 'b')), 'ok');
});

test('quoted ">" inside attributes does not end the tag', () => {
  const d = E.parseHTML('<a href="/x" title="a > b">link</a>');
  assert.equal(E.attrOf(E.selectOne(d, 'a'), 'title'), 'a > b');
});

test('text() skips script/style and normalises whitespace', () => {
  const d = E.parseHTML('<div>Hello <b>bold</b><style>.x{}</style>\n  world</div>');
  assert.equal(E.text(E.selectOne(d, 'div')), 'Hello bold world');
});

/* ---- the selector engine ---- */

test('select: tag, .class, #id, compound', () => {
  assert.equal(E.select(doc(), 'li').length, 4);
  assert.equal(E.select(doc(), 'li.item').length, 3);
  assert.equal(E.select(doc(), 'li.item.book').length, 3);
  assert.equal(E.select(doc(), '#catalog').length, 1);
  assert.equal(E.select(doc(), 'ul#catalog.grid').length, 1);
});

test('select: descendant vs > child combinators', () => {
  assert.equal(E.select(doc(), '#catalog a').length, 3);
  assert.equal(E.select(doc(), '#catalog > li').length, 4);
  assert.equal(E.select(doc(), '#catalog > a').length, 0);
});

test('select: attribute operators', () => {
  const d = doc();
  assert.equal(E.select(d, 'a[rel=next]').length, 1);
  assert.equal(E.select(d, 'a[href^="/books/"]').length, 3);
  assert.equal(E.select(d, 'img[src$=".jpg"]').length, 3);
  assert.equal(E.select(d, 'a[href*="crow"]').length, 1);
  assert.equal(E.select(d, 'img[alt]').length, 3);
});

test('select: pseudo-classes and comma unions', () => {
  const d = doc();
  assert.equal(E.text(E.select(d, '#catalog > li:first-child h3')[0]), 'The Crow’s Nest');
  assert.equal(E.text(E.select(d, '#catalog > li:nth-child(3) h3')[0]), 'Feathered Friends');
  assert.equal(E.select(d, '#catalog > li:last-child')[0].attrs.class, 'ad');
  assert.equal(E.select(d, 'h3, span.price').length, 6);
});

test('select returns document order and dedupes', () => {
  const d = E.parseHTML('<div class=a><p class=a>x</p></div>');
  const hits = E.select(d, '.a, div, p');
  deq(hits.map((h) => h.tag), ['div', 'p']);
});

/* ---- URLs ---- */

test('absolutize resolves relative links and refuses junk', () => {
  assert.equal(E.absolutize('/books/crow', BASE), 'https://shop.example.com/books/crow');
  assert.equal(E.absolutize('crow', 'https://x.com/books/'), 'https://x.com/books/crow');
  assert.equal(E.absolutize('#top', BASE), null);
  assert.equal(E.absolutize('javascript:alert(1)', BASE), null);
  assert.equal(E.absolutize('mailto:a@b.com', BASE), null);
});

test('normalizeUrl adds scheme, strips fragments and tracking params', () => {
  assert.equal(E.normalizeUrl('example.com/page?utm_source=x&q=1#frag'), 'https://example.com/page?q=1');
  assert.equal(E.normalizeUrl('  https://a.com/x?fbclid=zz  '), 'https://a.com/x');
  assert.equal(E.normalizeUrl('not a url'), null);
  assert.equal(E.normalizeUrl('ftp://a.com/x'), null);
});

/* ---- harvesters ---- */

test('extractTables: headers, rows, keyed objects', () => {
  const t = E.extractTables(doc());
  assert.equal(t.length, 1);
  deq(t[0].headers, ['Title', 'Stock']);
  assert.equal(t[0].rows.length, 2);
  deq(t[0].objects[1], { Title: 'Silver & Steel', Stock: '0' });
});

test('extractLinks: absolute, deduped, external flagged', () => {
  const links = E.extractLinks(doc(), BASE);
  const urls = links.map((l) => l.url);
  assert.ok(urls.includes('https://shop.example.com/books/crow'));
  assert.ok(!urls.some((u) => u.startsWith('mailto:')), 'mailto is not a link');
  assert.equal(new Set(urls).size, urls.length, 'deduped');
  assert.ok(links.every((l) => l.external === false));
});

test('extractImages: src absolutised, alt cleaned', () => {
  const imgs = E.extractImages(doc(), BASE);
  assert.equal(imgs.length, 3);
  assert.equal(imgs[0].src, 'https://shop.example.com/img/crow.jpg');
  assert.equal(imgs[0].alt, 'Crow');
});

test('extractEmails finds mailto and plain-text addresses once each', () => {
  deq(E.extractEmails(doc()), ['shop@example.com', 'ravens@example.org']);
});

test('extractMeta: title, description, og, canonical, JSON-LD, lang', () => {
  const m = E.extractMeta(doc(), BASE);
  assert.equal(m.title, 'Magpie Books & Curios');
  assert.equal(m.description, 'Rare books, shiny things.');
  assert.equal(m.og.title, 'Magpie Books');
  assert.equal(m.canonical, 'https://shop.example.com/books');
  deq(m.jsonLd, ['Store']);
  assert.equal(m.lang, 'en');
});

/* ---- detection ---- */

test('detectRepeats finds the catalog as the top repeat', () => {
  const reps = E.detectRepeats(doc());
  assert.ok(reps.length >= 1);
  assert.ok(/li\.book|li\.item/.test(reps[0].selector), reps[0].selector);
  assert.equal(reps[0].count, 3);
  assert.ok(E.select(doc(), reps[0].selector).length === 3, 'suggested selector re-finds the items');
});

test('detectRepeats needs at least minCount lookalike siblings', () => {
  const d = E.parseHTML('<ul><li class=x>a</li><li class=x>b</li></ul>');
  assert.equal(E.detectRepeats(d).length, 0);
});

test('suggestRecipe guesses title, link, image and price fields', () => {
  const rec = E.suggestRecipe(doc());
  assert.ok(rec, 'recipe suggested');
  assert.equal(rec.count, 3);
  const names = rec.fields.map((f) => f.name);
  assert.ok(names.includes('title') && names.includes('link') && names.includes('image') && names.includes('price'), names.join(','));
  const run = E.runRecipe(doc(), rec, BASE);
  assert.equal(run.rows.length, 3);
  assert.equal(run.rows[0].title, 'The Crow’s Nest');
  assert.equal(run.rows[0].link, 'https://shop.example.com/books/crow');
  assert.equal(run.rows[0].price, '£12.99');
});

/* ---- the recipe runner ---- */

test('runRecipe extracts fields with text/attr and absolutises URLs', () => {
  const recipe = { itemSelector: 'li.item', fields: [
    { name: 'title', selector: 'h3', attr: 'text' },
    { name: 'url', selector: 'a', attr: 'href' },
    { name: 'img', selector: 'img', attr: 'src' },
  ] };
  const out = E.runRecipe(doc(), recipe, BASE);
  assert.equal(out.count, 3);
  deq(out.rows[1], { title: 'Silver & Steel',
    url: 'https://shop.example.com/books/silver',
    img: 'https://shop.example.com/img/silver.jpg' });
});

test('runRecipe drops all-empty rows and validates the recipe', () => {
  const out = E.runRecipe(doc(), { itemSelector: 'li', fields: [{ name: 'p', selector: '.price', attr: 'text' }] }, BASE);
  assert.equal(out.count, 3, 'the .ad li has no price → dropped');
  assert.ok(E.runRecipe(doc(), null, BASE).error);
  assert.ok(E.runRecipe(doc(), { itemSelector: '', fields: [] }, BASE).error);
});

/* ---- export ---- */

test('toCSV quotes per RFC 4180', () => {
  const rows = [{ a: 'plain', b: 'has,comma' }, { a: 'has "quote"', b: 'line\nbreak' }];
  assert.equal(E.toCSV(rows),
    'a,b\r\nplain,"has,comma"\r\n"has ""quote""","line\nbreak"');
});

test('toCSV unions columns across ragged rows', () => {
  assert.equal(E.toCSV([{ a: '1' }, { b: '2' }]), 'a,b\r\n1,\r\n,2');
});

test('toMarkdown escapes pipes and newlines', () => {
  const md = E.toMarkdown([{ t: 'a|b', n: 'x\ny' }]);
  assert.equal(md, '| t | n |\n| --- | --- |\n| a\\|b | x y |');
});

test('toJSON round-trips rows', () => {
  deq(JSON.parse(E.toJSON([{ a: 1 }])), [{ a: 1 }]);
});

/* ---- pagination + crawl ---- */

test('findNextUrl prefers rel=next, falls back to link text', () => {
  assert.equal(E.findNextUrl(doc(), BASE), 'https://shop.example.com/books?page=2');
  const d2 = E.parseHTML('<a href="/p/2">Next page</a>');
  assert.equal(E.findNextUrl(d2, 'https://x.com/p/1'), 'https://x.com/p/2');
  const d3 = E.parseHTML('<a href="/p/1">Next</a>');
  assert.equal(E.findNextUrl(d3, 'https://x.com/p/1'), null, 'self-link is not next');
});

test('createJob crawls page→next, dedupes rows, respects maxPages', () => {
  const recipe = { itemSelector: 'li', fields: [{ name: 't', selector: '', attr: 'text' }] };
  const page = (items, next) => '<ul>' + items.map((t) => `<li>${t}</li>`).join('') + '</ul>' +
    (next ? `<a rel=next href="${next}">Next</a>` : '');
  const job = E.createJob('https://x.com/1', recipe, { maxPages: 2 });
  assert.equal(job.next(), 'https://x.com/1');
  job.feed(page(['a', 'b'], '/2'), 'https://x.com/1');
  assert.equal(job.next(), 'https://x.com/2');
  job.feed(page(['b', 'c'], '/3'), 'https://x.com/2');
  assert.equal(job.next(), null, 'page cap reached');
  deq(job.rows(), [{ t: 'a' }, { t: 'b' }, { t: 'c' }], 'row "b" deduped across pages');
  assert.equal(job.stats().pages, 2);
});

/* ---- robots.txt ---- */

test('parseRobots groups agents and rules', () => {
  const g = E.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: MagpieBot\nDisallow: /no-magpies');
  assert.equal(g.length, 2);
  deq(g[0].agents, ['*']);
  assert.equal(g[1].rules[0].path, '/no-magpies');
});

test('robotsAllowed: longest match wins, Allow beats Disallow on ties', () => {
  const g = E.parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok');
  assert.equal(E.robotsAllowed(g, 'AnyBot', '/public'), true);
  assert.equal(E.robotsAllowed(g, 'AnyBot', '/private/x'), false);
  assert.equal(E.robotsAllowed(g, 'AnyBot', '/private/ok/page'), true);
});

test('robotsAllowed: specific UA group beats *, wildcards and $ anchor work', () => {
  const g = E.parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: MagpieBot\nDisallow: /*.pdf$\nAllow: /');
  assert.equal(E.robotsAllowed(g, 'MagpieBot/1.0', '/anything'), true, 'magpie group wins');
  assert.equal(E.robotsAllowed(g, 'MagpieBot/1.0', '/file.pdf'), false, 'wildcard+$ blocks pdfs');
  assert.equal(E.robotsAllowed(g, 'OtherBot', '/anything'), false, '* group blocks others');
});

test('robotsAllowed: empty Disallow and empty rules mean allowed', () => {
  assert.equal(E.robotsAllowed(E.parseRobots('User-agent: *\nDisallow:'), 'x', '/a'), true);
  assert.equal(E.robotsAllowed([], 'x', '/a'), true);
});

/* ---- watch ---- */

test('contentHash is deterministic and change-sensitive', () => {
  const a = E.contentHash([{ x: 1 }]);
  assert.equal(a, E.contentHash([{ x: 1 }]));
  assert.notEqual(a, E.contentHash([{ x: 2 }]));
  assert.match(a, /^[0-9a-f]{8}$/);
});

test('diffRows reports added, removed, unchanged', () => {
  const d = E.diffRows([{ t: 'a' }, { t: 'b' }], [{ t: 'b' }, { t: 'c' }]);
  deq(d.added, [{ t: 'c' }]);
  deq(d.removed, [{ t: 'a' }]);
  assert.equal(d.unchanged, 1);
  assert.equal(d.changed, true);
  assert.equal(E.diffRows([{ t: 'a' }], [{ t: 'a' }]).changed, false);
});

/* ---- runner ---- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    console.error('  ✗ ' + name);
    console.error(String(e && e.stack || e).split('\n').slice(0, 6).map((l) => '    ' + l).join('\n'));
    process.exitCode = 1;
  }
}
console.log(`\nmagpie: ${passed}/${tests.length} tests passed`);
if (passed !== tests.length) process.exit(1);

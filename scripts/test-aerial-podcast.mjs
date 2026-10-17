#!/usr/bin/env node
// Tests for the PODCAST section of the Aerial engine: the tolerant XML parser (tree shape, attribute forms,
// CDATA/comments/PI/DOCTYPE, entity table, recovery from mismatched/unclosed/stray tags, depth cap, junk),
// RSS 2.0 + Atom feed parsing from realistic fixtures (itunes/media/content/dc namespaces, CDATA HTML, relative
// URLs, mixed enclosures, named-zone dates, broken item structure), durations, stripHtml, the iTunes directory
// URL builders and normalisation, feed URL normalisation, OPML round trip, episode merging, and determinism.
// Run: node scripts/test-aerial-podcast.mjs
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
const { test, run, assert } = runner('podcast');
// Hostile-input cases assert the shape of their result (caps honoured, output derived from input) rather than a
// per-case wall clock; their elapsed time is summed and checked once, generously, by the last test in this file.
// A quadratic regression in any of them costs minutes, so the bound discriminates without being flaky on a
// loaded runner.
let hostileMs = 0;
const hostile = (name, fn) => test(name, () => { const t0 = Date.now(); fn(); hostileMs += Date.now() - t0; });
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const FEED_URL = 'https://feeds.example.com/night-signals.xml';

/* ---------- fixtures ---------- */
const RSS_FULL = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:podcast="https://podcastindex.org/namespace/1.0"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Night Signals &amp; Static</title>
    <atom:link href="https://feeds.example.com/night-signals.xml" rel="self" type="application/rss+xml"/>
    <link>https://nightsignals.example.com/</link>
    <description><![CDATA[<p>Stories from the <b>small hours</b> of shortwave radio.</p>]]></description>
    <itunes:summary>Stories from the small hours of shortwave radio &mdash; every Tuesday.</itunes:summary>
    <itunes:subtitle>Shortwave stories</itunes:subtitle>
    <language>en-GB</language>
    <managingEditor>mara@example.com (Mara Lindqvist)</managingEditor>
    <itunes:author>Mara Lindqvist &amp; Co.</itunes:author>
    <itunes:owner><itunes:name>Mara</itunes:name><itunes:email>mara@example.com</itunes:email></itunes:owner>
    <itunes:explicit>no</itunes:explicit>
    <itunes:image href="/art/cover-3000.jpg"/>
    <image><url>https://cdn.example.com/art/cover-1400.jpg</url><title>Night Signals</title><link>https://nightsignals.example.com/</link></image>
    <itunes:category text="Society &amp; Culture"><itunes:category text="Documentary"/></itunes:category>
    <itunes:category text="Technology"/>
    <itunes:category text="technology"/>
    <category>Radio</category>
    <podcast:guid>917393e3-1b1e-5cef-ace4-edaa54e1f810</podcast:guid>
    <item>
      <title>Ep. 3 &#8212; The numbers station</title>
      <guid isPermaLink="false">ns-003</guid>
      <link>https://nightsignals.example.com/episodes/3</link>
      <pubDate>Tue, 13 Oct 2026 21:30:00 EST</pubDate>
      <description><![CDATA[<p>We tune into <a href="https://example.com/x">UVB-76</a>.<br>Plus: listener mail &amp; more.</p><ul><li>Segment one</li><li>Segment two</li></ul>]]></description>
      <content:encoded><![CDATA[<h2>Show notes</h2><p>We tune into <em>UVB-76</em> &amp; friends.</p><p>Second paragraph.</p><script>alert(1)</script>]]></content:encoded>
      <itunes:summary>Short summary.</itunes:summary>
      <enclosure url="/media/ns-003.mp3" length="48211034" type="audio/mpeg"/>
      <itunes:duration>1:02:03</itunes:duration>
      <itunes:image href="https://cdn.example.com/art/ep3.jpg"/>
      <itunes:season>1</itunes:season>
      <itunes:episode>3</itunes:episode>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:explicit>yes</itunes:explicit>
    </item>
    <item>
      <title>Ep. 2 — Static</title>
      <guid>https://nightsignals.example.com/episodes/2</guid>
      <pubDate>Tue, 06 Oct 2026 20:00:00 GMT</pubDate>
      <description>Plain &lt;b&gt;escaped&lt;/b&gt; description with &quot;quotes&quot;.</description>
      <media:content url="https://cdn.example.com/media/ns-002.m4a" type="audio/x-m4a" fileSize="12345"/>
      <media:thumbnail url="https://cdn.example.com/art/ep2.jpg"/>
      <itunes:duration>62:03</itunes:duration>
      <podcast:season>2</podcast:season>
    </item>
    <item>
      <title>Video special</title>
      <guid>ns-video</guid>
      <pubDate>Mon, 05 Oct 2026 10:00:00 PDT</pubDate>
      <enclosure url="https://cdn.example.com/media/special.pdf" type="application/pdf" length="100"/>
      <enclosure url="https://cdn.example.com/media/special.mp4" type="video/mp4" length="0"/>
      <itunes:duration>3723</itunes:duration>
      <itunes:episodeType>Trailer</itunes:episodeType>
    </item>
    <item>
      <title>Transcript only (no audio)</title>
      <guid>ns-nomedia</guid>
      <pubDate>Sun, 04 Oct 2026 10:00:00 +0000</pubDate>
      <description>No enclosure here.</description>
      <enclosure url="https://cdn.example.com/transcripts/4.txt" type="text/plain"/>
    </item>
    <item>
      <title>Undated bonus</title>
      <guid>ns-bonus</guid>
      <enclosure url="https://cdn.example.com/media/bonus.mp3" type="audio/mpeg" length="100"/>
      <itunes:duration>3723.5</itunes:duration>
      <itunes:episodeType>bonus</itunes:episodeType>
      <itunes:subtitle>Only a subtitle</itunes:subtitle>
    </item>
    <item>
      <title>Ep. 1 — First light</title>
      <guid>ns-001</guid>
      <dc:date>2026-09-29T20:00:00Z</dc:date>
      <enclosure url="https://cdn.example.com/media/ns-001.mp3?x=1&amp;y=2" type="audio/mpeg" length="1"/>
      <itunes:duration>PT45M</itunes:duration>
    </item>
    <item>
      <title>Ep. 1 duplicate guid</title>
      <guid>ns-001</guid>
      <enclosure url="https://cdn.example.com/media/dup.mp3" type="audio/mpeg"/>
    </item>
  </channel>
</rss>
`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xml:lang="en">
  <title type="html">Atom &amp; Audio</title>
  <subtitle>An Atom feed with enclosures</subtitle>
  <link rel="alternate" type="text/html" href="https://atom.example.org/"/>
  <link rel="self" href="https://atom.example.org/feed.atom"/>
  <logo>https://atom.example.org/logo.png</logo>
  <author><name>Priya Natarajan</name></author>
  <updated>2026-10-10T08:00:00Z</updated>
  <id>urn:uuid:60a76c80-d399-11d9-b93C-0003939e0af6</id>
  <category term="Science"/>
  <entry>
    <title>Entry two</title>
    <id>urn:uuid:2</id>
    <link rel="alternate" href="/posts/2"/>
    <link rel="enclosure" type="audio/mpeg" length="2048" href="/media/2.mp3"/>
    <published>2026-10-09T07:00:00+02:00</published>
    <updated>2026-10-10T08:00:00Z</updated>
    <summary type="html">&lt;p&gt;Summary &lt;i&gt;two&lt;/i&gt;&lt;/p&gt;</summary>
    <content type="html"><![CDATA[<p>Full content two</p>]]></content>
    <itunes:duration>00:30:00</itunes:duration>
  </entry>
  <entry>
    <title>Entry one</title>
    <id>urn:uuid:1</id>
    <link href="https://atom.example.org/posts/1"/>
    <link rel="enclosure" type="audio/mp4" href="https://atom.example.org/media/1.m4a"/>
    <updated>2026-10-01T00:00:00Z</updated>
    <summary type="html">&lt;p&gt;Summary &lt;i&gt;one&lt;/i&gt;&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title>No enclosure</title>
    <id>urn:uuid:3</id>
    <link href="https://atom.example.org/posts/3"/>
    <updated>2026-10-02T00:00:00Z</updated>
  </entry>
</feed>
`;

const RSS_MESSY = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n' +
`<!DOCTYPE rss [ <!ENTITY custom "unused"> <!-- a comment inside the subset --> ]>
<!-- generator: hand-rolled, with love -->
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
<title>Messy &amp; Proud</title>
<description>Line one<br>Line two<p>Para</description>
<managingEditor>editor@example.com (Sam O&#8217;Neill)</managingEditor>
<image><url>/img/cover.png</url></image>
<link>/</link>
<item>
<title>Raw HTML item</title>
<guid>m1</guid>
<description>First<br>Second<p>Third</description>
<enclosure url="https://m.example.com/1.mp3" type="audio/mpeg"/>
<pubDate>Thu, 01 Oct 2026 00:00:00 GMT</pubDate>
</item>
<item>
<title>CDATA item</title>
<guid>m2</guid>
<description><![CDATA[Alpha<br>Beta<p>Gamma]]></description>
<enclosure url="https://m.example.com/2.mp3" type="audio/mpeg"/>
<pubDate>Fri, 02 Oct 2026 00:00:00 GMT</pubDate>
</item>
<item>
<title>Escaped item</title>
<guid>m3</guid>
<description>Uno&lt;br&gt;Dos&lt;p&gt;Tres</description>
<enclosure url="https://m.example.com/3.mp3" type="audio/mpeg"/>
<pubDate>Sat, 03 Oct 2026 00:00:00 GMT</pubDate>
</item>
</channel>
</rss>
<!-- trailing comment -->
`;

const RSS_BROKEN = `<rss version="2.0"><channel><title>Broken</title>
<item><title>A</title><guid>a</guid><enclosure url="https://b.example.com/a.mp3" type="audio/mpeg"/><pubDate>Thu, 01 Oct 2026 00:00:00 GMT</pubDate>
<item><title>B</title><guid>b</guid><enclosure url="https://b.example.com/b.mp3" type="audio/mpeg"/><pubDate>Fri, 02 Oct 2026 00:00:00 GMT</pubDate></item>
<item><title>C</title><guid>c</guid><enclosure url="https://b.example.com/c.mp3"/></item>
</channel></rss>`;

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>404 Not Found</title><style>body{color:red}</style></head>
<body><h1>Not Found</h1><p>The requested URL was not found.</p><script>console.log("x")</script></body></html>`;

// Deterministic "binary": a small LCG over bytes 0..255 (includes NULs, high bytes and the odd '<').
function junkBytes(n, seed) {
  const out = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}
const JUNK = junkBytes(4096, 42);
const JUNK_STR = Array.from(JUNK, b => String.fromCharCode(b)).join('');

const SHOW_FULL = E.podcastParseFeed(RSS_FULL, FEED_URL);
const EP = id => SHOW_FULL.episodes.find(e => e.id === id);

/* ===================== xmlParse: trees ===================== */
test('xmlParse: elements, every attribute form, self-closing, mixed text order, direct text', () => {
  const r = E.xmlParse('<a x="1" y=\'2\' z=3 w><b/>text<c>in</c>tail</a>');
  assert.equal(r.ok, true);
  deepEq(r.errors, []);
  deepEq(r.root, {
    name: 'a', attrs: { x: '1', y: '2', z: '3', w: '' },
    children: [
      { name: 'b', attrs: {}, children: [], text: '' },
      { name: '#text', attrs: {}, children: [], text: 'text' },
      { name: 'c', attrs: {}, children: [{ name: '#text', attrs: {}, children: [], text: 'in' }], text: 'in' },
      { name: '#text', attrs: {}, children: [], text: 'tail' }
    ],
    text: 'texttail'
  });
});
test('xmlParse: namespace prefixes kept in element and attribute names; attribute entities decoded', () => {
  const r = E.xmlParse('<rss xmlns:itunes="u"><itunes:image href="https://x/y?a=1&amp;b=2" xml:lang="en"/></rss>');
  const img = r.root.children[0];
  assert.equal(img.name, 'itunes:image');
  deepEq(img.attrs, { href: 'https://x/y?a=1&b=2', 'xml:lang': 'en' });
});
test('xmlParse: BOM, XML declaration, DOCTYPE with internal subset, comments and PIs are skipped; CRLF normalised', () => {
  const r = E.xmlParse('\uFEFF<?xml version="1.0"?>\r\n<!DOCTYPE x [ <!ENTITY e "v"> <!ELEMENT x (#PCDATA)> ]>\r\n<!-- c --><?pi target?>\r\n<x>a\r\nb<!-- inner -->c</x><!-- after -->');
  assert.equal(r.ok, true);
  deepEq(r.errors, []);
  assert.equal(r.root.name, 'x');
  assert.equal(r.root.text, 'a\nbc');
  assert.equal(r.root.children.length, 1, 'text around an inner comment merges into one text node');
});
test('xmlParse: CDATA is literal (no entity decoding, tags are text) and merges with surrounding text', () => {
  const r = E.xmlParse('<d>pre &amp; <![CDATA[<b>raw &amp;</b>]]> post</d>');
  assert.equal(r.root.text, 'pre & <b>raw &amp;</b> post');
  assert.equal(r.root.children.length, 1);
});
test('xmlParse: whitespace-only text between elements is kept as text nodes (xmlChildren skips them)', () => {
  const r = E.xmlParse('<a>\n  <b/>\n  <c/>\n</a>');
  assert.equal(r.root.children.length, 5);
  deepEq(E.xmlChildren(r.root).map(n => n.name), ['b', 'c']);
});
test('xmlParse: document-level text and multiple roots: first element is the root, extra content noted', () => {
  const r = E.xmlParse('junk before <a/> between <b/>');
  assert.equal(r.ok, true);
  assert.equal(r.root.name, 'a');
  assert.ok(r.errors.some(e => /after the root/.test(e)));
});

/* ===================== xmlParse: recovery ===================== */
test('xmlParse: mismatched close pops to the nearest matching open element', () => {
  const r = E.xmlParse('<a><b><c></b><d/></a>');
  deepEq(E.xmlChildren(r.root).map(n => n.name), ['b', 'd']);
  deepEq(E.xmlChildren(r.root.children[0]).map(n => n.name), ['c']);
  deepEq(r.errors, ['line 1: unclosed <c> closed by </b>']);
});
test('xmlParse: stray close tag is ignored, structure intact', () => {
  const r = E.xmlParse('<a><b/></x></a>');
  deepEq(E.xmlChildren(r.root).map(n => n.name), ['b']);
  deepEq(r.errors, ['line 1: stray </x> ignored']);
});
test('xmlParse: close tag matches case-insensitively as a fallback', () => {
  const r = E.xmlParse('<Item><title>t</title></ITEM>');
  assert.equal(r.root.name, 'Item');
  deepEq(r.errors, []);
});
test('xmlParse: unclosed elements at end of input are closed and reported with line numbers', () => {
  const r = E.xmlParse('<a>\n<b>\n<c>x');
  assert.equal(r.ok, true);
  assert.equal(E.xmlText(r.root), 'x');
  deepEq(r.errors, ['line 3: unclosed <c> at end of input', 'line 3: unclosed <b> at end of input', 'line 3: unclosed <a> at end of input']);
});
test('xmlParse: stray "<" (space, digit, EOF after it) is text', () => {
  const r = E.xmlParse('<m>1 < 2 and <3 and <</m>');
  assert.equal(r.root.text, '1 < 2 and <3 and <');
  assert.equal(r.errors.length, 3);
  assert.equal(E.xmlParse('<m>tail<').root.text, 'tail<');
});
test('xmlParse: unclosed start tag ends at the next "<"; unterminated comment/CDATA/PI/DOCTYPE do not throw', () => {
  const r = E.xmlParse('<a><b x="1" <c/></a>');
  deepEq(E.xmlChildren(r.root).map(n => n.name), ['b']);
  deepEq(E.xmlChildren(r.root.children[0]).map(n => n.name), ['c']);
  assert.ok(r.errors.some(e => /unclosed start tag <b>/.test(e)));
  for (const s of ['<a>x<!-- never closed', '<a>x<![CDATA[open', '<a>x<?pi open', '<!DOCTYPE x [ open', '<a', '</', '<a x="open', '<a x=\'open']) {
    const q = E.xmlParse(s);
    assert.ok(Array.isArray(q.errors) && q.errors.length >= 1, s);
  }
  assert.equal(E.xmlParse('<a>x<![CDATA[open').root.text, 'xopen');
});
test('xmlParse: an unbalanced quote does not swallow the document', () => {
  const r = E.xmlParse('<a href="broken>text</a><b>after</b>');
  assert.equal(r.ok, true);
  assert.equal(r.root.name, 'a');
  assert.equal(r.root.attrs.href, 'broken');
  assert.equal(r.root.text, 'text');
  assert.ok(r.errors.some(e => /unterminated attribute value/.test(e)));
});
test('xmlParse: duplicate attributes keep the first; __proto__ is never written', () => {
  const r = E.xmlParse('<a x="1" x="2" __proto__="p"/>');
  deepEq(r.root.attrs, { x: '1' });
  assert.equal(typeof r.root.attrs.__proto__, 'object', 'the prototype is still the ordinary one');
  assert.equal(r.errors.length, 2);
});
test('xmlParse: junk inside a tag is skipped one character at a time', () => {
  const r = E.xmlParse('<a " = x="1">t</a>');
  deepEq(r.root.attrs, { x: '1' });
  assert.equal(r.root.text, 't');
});
// Timing lives in the hostile battery at the end of this file (one generous bound over every case); the tests
// here assert the structural caps that make the work bounded.
hostile('xmlParse: 10k nested elements: capped depth, capped error list, serialisable tree', () => {
  const r = E.xmlParse('<a>'.repeat(10000) + '</a>'.repeat(10000));
  assert.equal(r.ok, true);
  let depth = 0, n = r.root;
  while (n.children.length) { n = n.children[0]; depth++; }
  assert.ok(depth <= 256, `depth ${depth}`);
  assert.ok(r.errors.length <= 101, `errors ${r.errors.length}`);
  assert.ok(/nesting deeper than/.test(r.errors[0]));
  assert.ok(/more error\(s\) not shown/.test(r.errors[r.errors.length - 1]));
  assert.ok(JSON.stringify(r).length > 0, 'the tree must be serialisable');
});
hostile('xmlParse: pathological inputs never throw, keep the documented shape and the error cap', () => {
  const cases = ['<'.repeat(50000), '<a '.repeat(20000), '</a>'.repeat(20000), '&#'.repeat(20000), '&amp'.repeat(20000) + ';', '<!--'.repeat(5000), '<![CDATA['.repeat(5000), '"'.repeat(20000), '<a x="' + 'y'.repeat(100000), JUNK_STR.repeat(4)];
  for (const s of cases) {
    const r = E.xmlParse(s);
    assert.equal(typeof r.ok, 'boolean', s.slice(0, 10));
    assert.ok(Array.isArray(r.errors) && r.errors.length <= 102, 'error cap on ' + s.slice(0, 10));
    assert.equal(r.ok, r.root !== null);
  }
  assert.equal(E.xmlParse('<a>' + '<'.repeat(50000) + '</a>').root.text, '<'.repeat(50000), 'every stray "<" is text');
  assert.equal(E.xmlChildren(E.xmlParse('<a>' + '</a>'.repeat(20000)).root).length, 0, 'stray close tags change nothing');
});
test('xmlParse: empty / non-text / binary input → ok:false with a reason, no throw', () => {
  deepEq(E.xmlParse(''), { ok: false, root: null, errors: ['empty document'] });
  deepEq(E.xmlParse('   \n'), { ok: false, root: null, errors: ['empty document'] });
  deepEq(E.xmlParse(null), { ok: false, root: null, errors: ['input is not text'] });
  deepEq(E.xmlParse(12), { ok: false, root: null, errors: ['input is not text'] });
  deepEq(E.xmlParse({}), { ok: false, root: null, errors: ['input is not text'] });
  assert.equal(E.xmlParse('no tags here').ok, false);
  assert.equal(E.xmlParse('no tags here').errors[0], 'no root element');
  assert.equal(E.xmlParse('<?xml version="1.0"?><!-- only -->').ok, false);
  const bin = E.xmlParse(JUNK);
  assert.equal(typeof bin.ok, 'boolean');
});
test('xmlParse: accepts a Uint8Array (UTF-8 decoded, BOM stripped)', () => {
  const bytes = new TextEncoder().encode('\uFEFF<t>café</t>');
  assert.equal(E.xmlText(E.xmlParse(bytes).root), 'café');
});

/* ===================== entities ===================== */
test('entities: the XML five, numeric decimal/hex, astral, invalid code points, CP1252 remap', () => {
  const t = s => E.xmlText(E.xmlParse('<t>' + s + '</t>').root);
  assert.equal(t('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
  assert.equal(t('&#65;&#x42;&#x1F600;&#X43;'), 'AB\u{1F600}C');
  assert.equal(t('&#0;&#xD800;&#x110000;'), '\uFFFD\uFFFD\uFFFD');
  assert.equal(t('it&#146;s &#150; &#151; &#133;'), 'it’s – — …');
  assert.equal(t('&bogus; &amp &#; &#x; & plain'), '&bogus; &amp &#; &#x; & plain');
  assert.equal(t('a=1&b=2'), 'a=1&b=2');
});
test('entities: ~100 named HTML entities (full Latin-1 block plus common punctuation)', () => {
  const t = s => E.xmlText(E.xmlParse('<t>' + s + '</t>').root);
  const table = {
    nbsp: '\u00A0', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
    copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
    deg: '°', plusmn: '±', times: '×', divide: '÷', middot: '·', bull: '•', laquo: '«', raquo: '»',
    eacute: 'é', egrave: 'è', ecirc: 'ê', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', ntilde: 'ñ',
    ccedil: 'ç', aring: 'å', oslash: 'ø', aelig: 'æ', Eacute: 'É', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
    iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', sup2: '²', micro: 'µ', para: '¶', shy: '\u00AD',
    larr: '←', rarr: '→', hearts: '♥', dagger: '†', permil: '‰', lsaquo: '‹', rsaquo: '›', oelig: 'œ', yuml: 'ÿ', thorn: 'þ'
  };
  for (const [name, ch] of Object.entries(table)) assert.equal(t('[&' + name + ';]'), '[' + ch + ']', name);
});

/* ===================== xmlChild / xmlChildren / xmlText ===================== */
test('xmlChild/xmlChildren: case-insensitive exact name, prefix-aware, junk-safe', () => {
  const r = E.xmlParse('<c><title>A</title><itunes:image href="i"/><image><url>u</url></image><TITLE>B</TITLE></c>');
  assert.equal(E.xmlText(E.xmlChild(r.root, 'title')), 'A');
  deepEq(E.xmlChildren(r.root, 'title').map(E.xmlText), ['A', 'B']);
  assert.equal(E.xmlChild(r.root, 'image').name, 'image', 'plain "image" must not match itunes:image');
  assert.equal(E.xmlChild(r.root, 'itunes:image').attrs.href, 'i');
  assert.equal(E.xmlChild(r.root, 'nope'), null);
  deepEq(E.xmlChildren(r.root, 'nope'), []);
  assert.equal(E.xmlChild(null, 'x'), null);
  deepEq(E.xmlChildren(undefined), []);
  deepEq(E.xmlChildren('str', 'x'), []);
  assert.equal(E.xmlChild(r.root, null), null);
});
test('xmlText: deep text in document order, trimmed; strings and junk handled', () => {
  const r = E.xmlParse('<d>  Hello <b>big</b> world &amp; <i>co</i>  </d>');
  assert.equal(E.xmlText(r.root), 'Hello big world & co');
  assert.equal(E.xmlText(null), '');
  assert.equal(E.xmlText('  s  '), 's');
  assert.equal(E.xmlText(42), '');
  assert.equal(E.xmlText({ text: ' t ' }), 't');
});

/* ===================== stripHtml ===================== */
test('stripHtml: block tags → newlines, lists → bullets, inline tags dropped, entities decoded, whitespace collapsed', () => {
  assert.equal(E.stripHtml('<h2>Show notes</h2><p>We tune into <em>UVB-76</em> &amp; friends.</p><p>Second   paragraph.</p>'), 'Show notes\n\nWe tune into UVB-76 & friends.\n\nSecond paragraph.');
  assert.equal(E.stripHtml('<ul><li>one</li><li>two</li></ul>'), '• one\n• two');
  assert.equal(E.stripHtml('a<br>b<br/>c<br />d<BR>e'), 'a\nb\nc\nd\ne');
  assert.equal(E.stripHtml('<div>x</div>\n\n\n\n<div>y</div>'), 'x\n\ny');
  assert.equal(E.stripHtml('<a href="https://x.y">link</a> text'), 'link text');
  assert.equal(E.stripHtml('<table><tr><td>a</td><td>b</td></tr></table>'), 'a b');
});
test('stripHtml: script/style/comments removed, CDATA markers unwrapped, nbsp → space', () => {
  assert.equal(E.stripHtml('<p>keep</p><script>alert("<b>")</script><style>p{}</style><!-- gone -->'), 'keep');
  assert.equal(E.stripHtml('<![CDATA[<p>cdata &amp; more</p>]]>'), 'cdata & more');
  assert.equal(E.stripHtml('a&nbsp;&nbsp;b'), 'a b');
});
test('stripHtml: escaped tags stay literal text; bare "<" with space/digit survives; plain text newlines kept', () => {
  assert.equal(E.stripHtml('&lt;b&gt;not bold&lt;/b&gt;'), '<b>not bold</b>');
  assert.equal(E.stripHtml('1 < 2 and <3'), '1 < 2 and <3');
  assert.equal(E.stripHtml('Line one\nLine two\n\n\n\nLine three'), 'Line one\nLine two\n\nLine three');
  assert.equal(E.stripHtml('\r\nwin\r\ndows\r\n'), 'win\ndows');
});
test('stripHtml: junk input', () => {
  assert.equal(E.stripHtml(null), '');
  assert.equal(E.stripHtml(undefined), '');
  assert.equal(E.stripHtml(''), '');
  assert.equal(E.stripHtml(12), '12');
  assert.equal(E.stripHtml({}), '');
  assert.equal(E.stripHtml('<'.repeat(10000)).length, 10000);
  assert.equal(typeof E.stripHtml(JUNK_STR), 'string');
});

/* ===================== durations ===================== */
test('podcastDurationSeconds: every documented form', () => {
  const cases = [
    ['1:02:03', 3723], ['62:03', 3723], ['3723', 3723], ['3723.5', 3723.5], ['01:02:03', 3723], ['0:05', 5], ['00:30:00', 1800],
    ['1:02:03.5', 3723.5], ['  45:00 ', 2700], ['PT1H2M3S', 3723], ['PT45M', 2700], ['pt30s', 30], ['P1DT1H', 90000],
    ['1h 2m 3s', 3723], ['45 min', 2700], ['2 hours', 7200], ['90s', 90], [3723, 3723], [0, 0], ['0', 0], [3723.456, 3723.456],
    ['3723000', 3723], [3723000, 3723]
  ];
  for (const [input, want] of cases) assert.equal(E.podcastDurationSeconds(input), want, JSON.stringify(input));
});
test('podcastDurationSeconds: junk → null', () => {
  for (const v of ['', ' ', 'abc', '-5', '1:2:3:4', '1e3', 'PT', 'P', '12:', ':12', null, undefined, NaN, Infinity, -1, {}, [], '1,000', '1:xx']) {
    assert.equal(E.podcastDurationSeconds(v), null, JSON.stringify(v));
  }
});

/* ===================== podcastParseFeed: RSS 2.0 ===================== */
test('RSS: show-level fields (title entity, itunes:author over managingEditor, summary over description, image href resolved, link, language, nested categories deduped, explicit)', () => {
  assert.equal(SHOW_FULL.ok, true);
  assert.equal(SHOW_FULL.error, null);
  assert.equal(SHOW_FULL.kind, 'rss');
  assert.equal(SHOW_FULL.title, 'Night Signals & Static');
  assert.equal(SHOW_FULL.author, 'Mara Lindqvist & Co.');
  assert.equal(SHOW_FULL.description, 'Stories from the small hours of shortwave radio \u2014 every Tuesday.');
  assert.equal(SHOW_FULL.image, 'https://feeds.example.com/art/cover-3000.jpg');
  assert.equal(SHOW_FULL.link, 'https://nightsignals.example.com/');
  assert.equal(SHOW_FULL.language, 'en-gb');
  deepEq(SHOW_FULL.categories, ['Society & Culture', 'Documentary', 'Technology']);
  assert.equal(SHOW_FULL.explicit, false);
  deepEq(SHOW_FULL.warnings, []);
});
test('RSS: items without a playable enclosure and duplicate guids are skipped; count/skipped agree', () => {
  deepEq(SHOW_FULL.episodes.map(e => e.id), ['ns-003', 'https://nightsignals.example.com/episodes/2', 'ns-video', 'ns-001', 'ns-bonus']);
  assert.equal(SHOW_FULL.count, 5);
  assert.equal(SHOW_FULL.skipped, 2);
  assert.equal(EP('ns-nomedia'), undefined);
});
test('RSS: newest first by published, nulls last; RFC 822 named zones (EST, GMT, PDT) and dc:date ISO', () => {
  deepEq(SHOW_FULL.episodes.map(e => e.published), [
    Date.UTC(2026, 9, 14, 2, 30), Date.UTC(2026, 9, 6, 20), Date.UTC(2026, 9, 5, 17), Date.UTC(2026, 8, 29, 20), null
  ]);
});
test('RSS: full episode shape (content:encoded over summary, CDATA HTML stripped, relative enclosure resolved, numbers, explicit, type)', () => {
  deepEq(EP('ns-003'), {
    id: 'ns-003',
    title: 'Ep. 3 \u2014 The numbers station',
    description: 'Show notes\n\nWe tune into UVB-76 & friends.\n\nSecond paragraph.',
    url: 'https://feeds.example.com/media/ns-003.mp3',
    type: 'audio/mpeg',
    length: 48211034,
    duration: 3723,
    published: Date.UTC(2026, 9, 14, 2, 30),
    image: 'https://cdn.example.com/art/ep3.jpg',
    link: 'https://nightsignals.example.com/episodes/3',
    season: 1, episode: 3, explicit: true, episodeType: 'full'
  });
});
test('RSS: media:content fallback with fileSize, media:thumbnail image, escaped-HTML description, guid-as-link, podcast:season', () => {
  const ep = EP('https://nightsignals.example.com/episodes/2');
  assert.equal(ep.url, 'https://cdn.example.com/media/ns-002.m4a');
  assert.equal(ep.type, 'audio/x-m4a');
  assert.equal(ep.length, 12345);
  assert.equal(ep.duration, 3723);
  assert.equal(ep.image, 'https://cdn.example.com/art/ep2.jpg');
  assert.equal(ep.description, 'Plain escaped description with "quotes".');
  assert.equal(ep.link, 'https://nightsignals.example.com/episodes/2', 'guid isPermaLink (default true) serves as the link');
  assert.equal(ep.season, 2);
  assert.equal(ep.episode, null);
  assert.equal(ep.explicit, false, 'inherits the show when the item is silent');
});
test('RSS: first playable enclosure wins (pdf skipped, video kept), length=0 → null, episodeType normalised', () => {
  const ep = EP('ns-video');
  assert.equal(ep.url, 'https://cdn.example.com/media/special.mp4');
  assert.equal(ep.type, 'video/mp4');
  assert.equal(ep.length, null);
  assert.equal(ep.episodeType, 'trailer');
  assert.equal(ep.duration, 3723);
});
test('RSS: undated bonus has published null, float duration, subtitle fallback, no link', () => {
  const ep = EP('ns-bonus');
  assert.equal(ep.published, null);
  assert.equal(ep.duration, 3723.5);
  assert.equal(ep.episodeType, 'bonus');
  assert.equal(ep.description, 'Only a subtitle');
  assert.equal(ep.link, '');
  assert.equal(ep.image, '', 'no episode art: the UI falls back to the show image');
});
test('RSS: entity-encoded query strings in enclosure urls decode once; ISO duration', () => {
  const ep = EP('ns-001');
  assert.equal(ep.url, 'https://cdn.example.com/media/ns-001.mp3?x=1&y=2');
  assert.equal(ep.duration, 2700);
  assert.equal(ep.title, 'Ep. 1 \u2014 First light', 'the first of two items with this guid is kept');
});
test('RSS: fallback chain for author/description/image/link when itunes tags are absent', () => {
  const r = E.podcastParseFeed(`<rss><channel><title> Plain </title><link>/home</link><description>&lt;p&gt;Desc&lt;/p&gt;</description>
    <managingEditor>ed@example.com (Edna Krabappel)</managingEditor><image><url>img/c.png</url></image><category>Comedy</category><category>comedy</category>
    <item><guid>1</guid><enclosure url="x.mp3"/></item></channel></rss>`, 'http://plain.example.com/feeds/a.xml');
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Plain');
  assert.equal(r.author, 'Edna Krabappel');
  assert.equal(r.description, 'Desc');
  assert.equal(r.image, 'http://plain.example.com/feeds/img/c.png');
  assert.equal(r.link, 'http://plain.example.com/home');
  deepEq(r.categories, ['Comedy']);
  assert.equal(r.episodes[0].url, 'http://plain.example.com/feeds/x.mp3');
  assert.equal(r.episodes[0].type, 'audio/mpeg', 'type inferred from the extension when the enclosure has none');
  assert.equal(r.episodes[0].title, 'Untitled episode');
});
test('RSS: dc:creator, author <name> and itunes:owner fallbacks; media:group; atom:link enclosure in RSS', () => {
  const r = E.podcastParseFeed(`<rss xmlns:dc="d" xmlns:media="m" xmlns:atom="a"><channel><title>T</title><dc:creator>Jane Doe &lt;jane@example.com&gt;</dc:creator>
    <item><guid>g1</guid><media:group><media:content url="https://h/1.mp3" type="audio/mpeg" duration="120"/><media:thumbnail url="https://h/1.jpg"/></media:group></item>
    <item><guid>g2</guid><atom:link rel="enclosure" href="https://h/2.mp3" type="audio/mpeg" length="5"/></item>
    <item><guid>g3</guid><media:content url="https://h/3.jpg" medium="image"/><media:content url="https://h/3.mp4" medium="video"/></item>
    </channel></rss>`, FEED_URL);
  assert.equal(r.author, 'Jane Doe');
  deepEq(r.episodes.map(e => [e.id, e.url, e.type, e.length, e.duration, e.image]), [
    ['g1', 'https://h/1.mp3', 'audio/mpeg', null, 120, 'https://h/1.jpg'],
    ['g2', 'https://h/2.mp3', 'audio/mpeg', 5, null, ''],
    ['g3', 'https://h/3.mp4', 'video/mp4', null, null, '']
  ]);
  const owner = E.podcastParseFeed('<rss xmlns:itunes="i"><channel><itunes:owner><itunes:name>Owner Only</itunes:name></itunes:owner></channel></rss>', FEED_URL);
  assert.equal(owner.author, 'Owner Only');
  assert.equal(owner.title, 'feeds.example.com', 'untitled feed falls back to its host');
});
test('RSS 1.0 (rdf:RDF) and a bare <channel> root both parse as rss', () => {
  const rdf = E.podcastParseFeed('<rdf:RDF xmlns:rdf="r"><channel><title>RDF</title></channel><item><title>i</title><guid>i</guid><enclosure url="https://h/i.mp3" type="audio/mpeg"/></item></rdf:RDF>', FEED_URL);
  assert.equal(rdf.kind, 'rss');
  assert.equal(rdf.title, 'RDF');
  assert.equal(rdf.count, 1);
  const ch = E.podcastParseFeed('<channel><title>Bare</title><item><guid>b</guid><enclosure url="https://h/b.mp3"/></item></channel>', FEED_URL);
  assert.equal(ch.kind, 'rss');
  assert.equal(ch.count, 1);
});

/* ===================== podcastParseFeed: Atom ===================== */
test('Atom: show fields (html title decoded, subtitle, alternate link, logo, author/name, xml:lang, category term)', () => {
  const r = E.podcastParseFeed(ATOM, 'https://atom.example.org/feed.atom');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'atom');
  assert.equal(r.title, 'Atom & Audio');
  assert.equal(r.description, 'An Atom feed with enclosures');
  assert.equal(r.link, 'https://atom.example.org/');
  assert.equal(r.image, 'https://atom.example.org/logo.png');
  assert.equal(r.author, 'Priya Natarajan');
  assert.equal(r.language, 'en');
  deepEq(r.categories, ['Science']);
});
test('Atom: link rel=enclosure (relative, with type/length), published over updated, content over summary, entries without enclosure skipped', () => {
  const r = E.podcastParseFeed(ATOM, 'https://atom.example.org/feed.atom');
  deepEq(r.episodes.map(e => e.id), ['urn:uuid:2', 'urn:uuid:1']);
  assert.equal(r.skipped, 1);
  deepEq(r.episodes[0], {
    id: 'urn:uuid:2', title: 'Entry two', description: 'Full content two',
    url: 'https://atom.example.org/media/2.mp3', type: 'audio/mpeg', length: 2048, duration: 1800,
    published: Date.UTC(2026, 9, 9, 5, 0), image: '', link: 'https://atom.example.org/posts/2',
    season: null, episode: null, explicit: false, episodeType: 'full'
  });
  assert.equal(r.episodes[1].published, Date.UTC(2026, 9, 1), 'updated is the fallback date');
  assert.equal(r.episodes[1].description, 'Summary one');
  assert.equal(r.episodes[1].link, 'https://atom.example.org/posts/1', 'a link without rel is alternate');
});

/* ===================== podcastParseFeed: messy and broken ===================== */
test('messy feed: BOM + DOCTYPE with subset + comments + CRLF; raw/CDATA/escaped unclosed <br>/<p> all yield the same text and keep the items intact', () => {
  const r = E.podcastParseFeed(RSS_MESSY, 'https://m.example.com/feed.xml');
  assert.equal(r.ok, true);
  assert.equal(r.title, 'Messy & Proud');
  assert.equal(r.description, 'Line one\nLine two\nPara');
  assert.equal(r.author, 'Sam O\u2019Neill');
  assert.equal(r.image, 'https://m.example.com/img/cover.png');
  assert.equal(r.link, 'https://m.example.com/');
  deepEq(r.episodes.map(e => [e.id, e.title, e.description]), [
    ['m3', 'Escaped item', 'Uno\nDos\nTres'],
    ['m2', 'CDATA item', 'Alpha\nBeta\nGamma'],
    ['m1', 'Raw HTML item', 'First\nSecond\nThird']
  ]);
  assert.ok(r.warnings.some(w => /unclosed <br>/.test(w)), 'raw html recovery is reported');
  assert.ok(r.warnings.some(w => /unclosed <p>/.test(w)));
});
test('broken feed: an unclosed <item> swallows its successors, which are still recovered as episodes', () => {
  const r = E.podcastParseFeed(RSS_BROKEN, 'https://b.example.com/rss');
  assert.equal(r.ok, true);
  deepEq(r.episodes.map(e => [e.id, e.title, e.url]), [
    ['b', 'B', 'https://b.example.com/b.mp3'],
    ['a', 'A', 'https://b.example.com/a.mp3'],
    ['c', 'C', 'https://b.example.com/c.mp3']
  ]);
  assert.ok(r.warnings.some(w => /unclosed <item>/.test(w)));
});
test('not a feed: HTML page, binary junk, plain text, wrong root, empty, non-text → ok:false with the empty shape, no throw', () => {
  const html = E.podcastParseFeed(HTML_PAGE, 'https://x.example.com/');
  assert.equal(html.ok, false);
  assert.ok(/web page/.test(html.error), html.error);
  deepEq(html.episodes, []);
  assert.equal(html.count, 0);
  for (const bad of [JUNK, JUNK_STR, 'hello world', '<svg><rect/></svg>', '', null, undefined, 42, {}, [], '{"json":true}', '<?xml version="1.0"?>']) {
    const r = E.podcastParseFeed(bad, FEED_URL);
    assert.equal(r.ok, false, String(JSON.stringify(bad)).slice(0, 30));
    assert.equal(typeof r.error, 'string');
    assert.equal(r.kind, null);
    deepEq(Object.keys(r), ['ok', 'kind', 'title', 'author', 'description', 'image', 'link', 'language', 'categories', 'explicit', 'episodes', 'count', 'skipped', 'error', 'warnings']);
  }
});
test('feed with no items is ok with zero episodes; junk feedUrl leaves relative URLs unplayable', () => {
  const r = E.podcastParseFeed('<rss><channel><title>Empty</title></channel></rss>', null);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  const rel = E.podcastParseFeed('<rss><channel><item><guid>1</guid><enclosure url="/a.mp3"/></item><item><guid>2</guid><enclosure url="https://h/b.mp3"/></item></channel></rss>', 'not a url');
  deepEq(rel.episodes.map(e => e.id), ['2']);
  assert.equal(rel.skipped, 1);
});
hostile('hostile feed: oversized description is capped, 10k-deep item structure terminates, junk-typed values ignored', () => {
  const big = '<rss><channel><item><guid>g</guid><enclosure url="https://h/x.mp3"/><description>' + 'y'.repeat(60000) + '</description><itunes:season>abc</itunes:season><itunes:episode>-1</itunes:episode><itunes:explicit>maybe</itunes:explicit><itunes:duration>junk</itunes:duration><pubDate>yesterday-ish</pubDate></item></channel></rss>';
  const r = E.podcastParseFeed(big, FEED_URL);
  assert.ok(r.episodes[0].description.length <= 20000);
  assert.equal(r.episodes[0].season, null);
  assert.equal(r.episodes[0].episode, null);
  assert.equal(r.episodes[0].explicit, false);
  assert.equal(r.episodes[0].duration, null);
  assert.equal(r.episodes[0].published, null);
  const deep = E.podcastParseFeed('<rss><channel>' + '<item>'.repeat(10000) + '<guid>d</guid><enclosure url="https://h/d.mp3"/>' + '</item>'.repeat(10000) + '</channel></rss>', FEED_URL);
  assert.equal(deep.ok, true);
  assert.equal(deep.count, 1, 'the one real item is found below the depth cap; the rest are empty');
  assert.ok(deep.warnings.length <= 102 && deep.warnings.some(w => /nesting deeper than/.test(w)));
});

/* ===================== directory (iTunes Search API) ===================== */
test('itunesSearchUrl: exact query string, defaults, encoding, clamped limit, country validation', () => {
  assert.equal(E.itunesSearchUrl('planet money'), 'https://itunes.apple.com/search?media=podcast&entity=podcast&term=planet%20money&limit=25&country=GB');
  assert.equal(E.itunesSearchUrl('  Tom & Jerry/é ', { limit: 50, country: 'us' }), 'https://itunes.apple.com/search?media=podcast&entity=podcast&term=Tom%20%26%20Jerry%2F%C3%A9&limit=50&country=US');
  assert.equal(E.itunesSearchUrl('x', { limit: 9999 }).split('limit=')[1], '200&country=GB');
  assert.equal(E.itunesSearchUrl('x', { limit: -3, country: 'USA' }).split('limit=')[1], '1&country=GB');
  assert.equal(E.itunesSearchUrl('x', { limit: '10' }).split('limit=')[1], '10&country=GB');
  assert.equal(E.itunesSearchUrl(''), null);
  assert.equal(E.itunesSearchUrl('   '), null);
  assert.equal(E.itunesSearchUrl(null), null);
  assert.equal(E.itunesSearchUrl(42), 'https://itunes.apple.com/search?media=podcast&entity=podcast&term=42&limit=25&country=GB');
  assert.ok(E.itunesSearchUrl('a'.repeat(1000)).length < 400, 'term is capped');
});
test('itunesLookupUrl: numeric id, numeric string, Apple Podcasts page URL; junk → null', () => {
  assert.equal(E.itunesLookupUrl(1200361736), 'https://itunes.apple.com/lookup?id=1200361736&entity=podcast');
  assert.equal(E.itunesLookupUrl(' 510289 '), 'https://itunes.apple.com/lookup?id=510289&entity=podcast');
  assert.equal(E.itunesLookupUrl('https://podcasts.apple.com/gb/podcast/the-daily/id1200361736?i=1000'), 'https://itunes.apple.com/lookup?id=1200361736&entity=podcast');
  assert.equal(E.itunesLookupUrl('https://podcasts.apple.com/us/podcast/id510289'), 'https://itunes.apple.com/lookup?id=510289&entity=podcast');
  for (const v of ['', 'abc', '12a', null, undefined, {}, [], -5, 1.5, 'https://example.com/idx']) assert.equal(E.itunesLookupUrl(v), null, JSON.stringify(v));
});
test('podcastNormalizeItunes: full record, artwork fallback upscaled, missing fields, no feedUrl → null', () => {
  const full = {
    wrapperType: 'track', kind: 'podcast', collectionId: 510289, trackId: 510289, artistName: 'NPR', collectionName: 'Planet Money', trackName: 'Planet Money',
    collectionViewUrl: 'https://podcasts.apple.com/gb/podcast/planet-money/id510289?uo=4', feedUrl: 'https://feeds.npr.org/510289/podcast.xml',
    artworkUrl30: 'https://is1-ssl.mzstatic.com/image/thumb/x/30x30bb.jpg', artworkUrl60: 'https://is1-ssl.mzstatic.com/image/thumb/x/60x60bb.jpg',
    artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg', artworkUrl600: 'https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg',
    trackCount: 2087, primaryGenreName: 'Business', genres: ['Business', 'Podcasts'], genreIds: ['1321', '26'], country: 'USA', releaseDate: '2026-10-15T20:00:00Z'
  };
  deepEq(E.podcastNormalizeItunes(full), {
    type: 'show', id: 'itunes:510289', title: 'Planet Money', author: 'NPR', feedUrl: 'https://feeds.npr.org/510289/podcast.xml',
    image: 'https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg', genre: 'Business', episodeCount: 2087, link: 'https://podcasts.apple.com/gb/podcast/planet-money/id510289?uo=4'
  });
  deepEq(E.podcastNormalizeItunes({ feedUrl: 'feed://example.com/rss', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/y/100x100bb.jpg', genres: ['Podcasts', 'Comedy'], trackCount: '12', trackViewUrl: 'https://podcasts.apple.com/x' }), {
    type: 'show', id: 'feed:https://example.com/rss', title: 'example.com', author: '', feedUrl: 'https://example.com/rss',
    image: 'https://is1-ssl.mzstatic.com/image/thumb/y/600x600bb.jpg', genre: 'Comedy', episodeCount: 12, link: 'https://podcasts.apple.com/x'
  });
  deepEq(E.podcastNormalizeItunes({ collectionId: '7', collectionName: '  Spaced   Out ', feedUrl: 'example.org/feed', trackCount: -1, artworkUrl600: 'not a url' }),
    { type: 'show', id: 'itunes:7', title: 'Spaced Out', author: '', feedUrl: 'https://example.org/feed', image: '', genre: '', episodeCount: null, link: '' });
  for (const v of [null, undefined, {}, [], 'str', 7, { collectionName: 'No feed' }, { feedUrl: 'ftp://x.y/z' }, { feedUrl: 12 }]) assert.equal(E.podcastNormalizeItunes(v), null, JSON.stringify(v));
});

/* ===================== feed URLs ===================== */
test('podcastNormalizeFeedUrl: feed:/itpc:/pcast:/feed:https:, scheme-less, whitespace, case, fragment, empty path', () => {
  const cases = [
    ['feed://example.com/rss', 'https://example.com/rss'],
    ['itpc://Example.COM/Path/Case', 'https://example.com/Path/Case'],
    ['pcast://example.com/a.xml', 'https://example.com/a.xml'],
    ['feed:https://example.com/x', 'https://example.com/x'],
    ['feed:http://example.com/x', 'http://example.com/x'],
    ['FEED://example.com/x', 'https://example.com/x'],
    ['example.com/feed.xml', 'https://example.com/feed.xml'],
    ['www.example.com/feed', 'https://www.example.com/feed'],
    ['//cdn.example.com/feed', 'https://cdn.example.com/feed'],
    ['  https://example.com/feed?a=1&b=2#frag  ', 'https://example.com/feed?a=1&b=2'],
    ['<https://example.com/feed>', 'https://example.com/feed'],
    ['HTTP://EXAMPLE.com', 'http://example.com/'],
    ['https://user:Pass@example.com/x', 'https://user:Pass@example.com/x'],
    ['example.com:8080/feed', 'https://example.com:8080/feed'],
    ['localhost:3000/rss', 'https://localhost:3000/rss'],
    ['http://10.0.0.1/feed', 'http://10.0.0.1/feed'],
    ['https://例え.jp/feed', 'https://例え.jp/feed']
  ];
  for (const [input, want] of cases) assert.equal(E.podcastNormalizeFeedUrl(input), want, input);
});
test('podcastNormalizeFeedUrl: non-http schemes, bare words, spaces inside, junk → null', () => {
  for (const v of ['ftp://example.com/x', 'mailto:a@example.com', 'javascript:alert(1)', 'data:text/plain,hi', 'file:///etc/passwd', 'hello', 'planet money', 'https://exa mple.com/x', 'https://', 'https:///path', '', '   ', null, undefined, 42, {}, [], 'https://example.com/' + 'a'.repeat(3000), 'http://-/x', 'C:\\feeds\\x.xml']) {
    assert.equal(E.podcastNormalizeFeedUrl(v), null, String(JSON.stringify(v)).slice(0, 40));
  }
});
test('podcastIsFeedUrl: addresses vs search terms', () => {
  for (const yes of ['https://feeds.npr.org/510289/podcast.xml', 'http://example.com/rss', 'feed://example.com/x', 'itpc://example.com/x', 'example.com/feed', 'www.example.com/podcast.rss', 'feeds.megaphone.fm', 'rss.art19.com', '//cdn.example.com/feed', 'example.com:8080/x']) {
    assert.equal(E.podcastIsFeedUrl(yes), true, yes);
  }
  for (const no of ['planet money', 'npr.org', 'example.com/', 'radiolab', 'ftp://example.com/x', 'mailto:a@b.co', 'the daily', '', ' ', null, undefined, 12, {}, 'https://exa mple.com']) {
    assert.equal(E.podcastIsFeedUrl(no), false, JSON.stringify(no));
  }
});
test('podcastEpisodeKey: feed normalised, id from object/string, url fallback, null when either is missing', () => {
  assert.equal(E.podcastEpisodeKey('feed://example.com/rss', { id: 'ns-003', url: 'https://h/x.mp3' }), 'podcast:https://example.com/rss#ns-003');
  assert.equal(E.podcastEpisodeKey('https://example.com/rss', 'ns-003'), 'podcast:https://example.com/rss#ns-003');
  assert.equal(E.podcastEpisodeKey('https://example.com/rss', { url: 'https://h/x.mp3' }), 'podcast:https://example.com/rss#https://h/x.mp3');
  assert.equal(E.podcastEpisodeKey('https://example.com/rss', EP('ns-003')), 'podcast:https://example.com/rss#ns-003');
  assert.equal(E.podcastEpisodeKey('not a url', 'x'), 'podcast:not a url#x', 'an unnormalisable feed string is still a stable key');
  for (const [f, e] of [['', 'x'], ['https://example.com/rss', ''], ['https://example.com/rss', {}], [null, 'x'], ['https://example.com/rss', null], [undefined, undefined], [7, 7]]) {
    assert.equal(E.podcastEpisodeKey(f, e), null, JSON.stringify([f, e]));
  }
});

/* ===================== OPML ===================== */
test('opmlBuild: valid OPML 2.0 with escaped attributes, optional title/dateCreated, dedupe, junk entries skipped', () => {
  const subs = [
    { type: 'show', title: 'Night Signals & "Static" <live>', feedUrl: 'feed://example.com/rss', link: 'https://example.com/' },
    { title: 'Dup', feedUrl: 'https://example.com/rss' },
    { title: 'No feed' }, null, 'str', 7,
    { title: 'Ctrl\u0001chars\u0007here', feedUrl: 'https://other.example.com/feed.xml' },
    { feedUrl: 'https://untitled.example.com/x' }
  ];
  const out = E.opmlBuild(subs, { title: 'My <subs>', now: NOW });
  assert.equal(out, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    '    <title>My &lt;subs&gt;</title>',
    '    <dateCreated>Fri, 16 Oct 2026 12:00:00 GMT</dateCreated>',
    '  </head>',
    '  <body>',
    '    <outline type="rss" text="Night Signals &amp; &quot;Static&quot; &lt;live&gt;" title="Night Signals &amp; &quot;Static&quot; &lt;live&gt;" xmlUrl="https://example.com/rss" htmlUrl="https://example.com/"/>',
    '    <outline type="rss" text="Ctrlcharshere" title="Ctrlcharshere" xmlUrl="https://other.example.com/feed.xml"/>',
    '    <outline type="rss" text="untitled.example.com" title="untitled.example.com" xmlUrl="https://untitled.example.com/x"/>',
    '  </body>',
    '</opml>',
    ''
  ].join('\n'));
  assert.ok(E.opmlBuild([]).indexOf('<dateCreated>') === -1);
  assert.ok(E.opmlBuild([]).indexOf('<title>Aerial podcast subscriptions</title>') !== -1);
  assert.ok(E.xmlParse(out).errors.length === 0, 'the built OPML is clean XML');
  for (const v of [null, undefined, 'x', 7, {}]) assert.ok(/<opml version="2.0">/.test(E.opmlBuild(v)), 'junk subs still build an empty document');
});
test('opmlParse: nested folders, attribute case, text/title fallback, dedupe, non-feed outlines ignored', () => {
  const opml = `<?xml version="1.0"?><opml version="1.0"><head><title>x</title></head><body>
    <outline text="News" title="News">
      <outline type="rss" text="The Daily" title="The Daily (NYT)" XMLURL="https://feeds.simplecast.com/54nAGcIl" htmlUrl="https://www.nytimes.com/the-daily"/>
      <outline text="Folder in folder"><outline xmlurl="feed://example.com/a" title="Only title"/></outline>
    </outline>
    <outline type="rss" xmlUrl="https://example.com/a#dup" text="Duplicate of a"/>
    <outline type="link" url="https://example.com/not-a-feed" text="Just a link"/>
    <outline xmlUrl="ftp://example.com/nope" text="Bad scheme"/>
    <outline xmlUrl="https://untitled.example.com/feed"/>
  </body></opml>`;
  deepEq(E.opmlParse(opml), [
    { title: 'The Daily', feedUrl: 'https://feeds.simplecast.com/54nAGcIl' },
    { title: 'Only title', feedUrl: 'https://example.com/a' },
    { title: 'untitled.example.com', feedUrl: 'https://untitled.example.com/feed' }
  ]);
});
test('OPML round trip preserves titles with special characters and normalised feed URLs', () => {
  const subs = [
    { title: 'A & "B" <c> \u2019quotes\u2019', feedUrl: 'feed://example.com/rss' },
    { title: 'Caf\u00e9 \u00fcber', feedUrl: 'https://example.org/x?a=1&b=2' },
    { title: 'Third', feedUrl: 'example.net/feed.xml' }
  ];
  deepEq(E.opmlParse(E.opmlBuild(subs)), [
    { title: 'A & "B" <c> \u2019quotes\u2019', feedUrl: 'https://example.com/rss' },
    { title: 'Caf\u00e9 \u00fcber', feedUrl: 'https://example.org/x?a=1&b=2' },
    { title: 'Third', feedUrl: 'https://example.net/feed.xml' }
  ]);
});
test('opmlParse: junk → []', () => {
  for (const v of ['', 'not xml', '<html><body>x</body></html>', '<opml/>', '<opml><body><outline/></body></opml>', null, undefined, 7, {}, [], JUNK, JUNK_STR]) {
    deepEq(E.opmlParse(v), [], String(JSON.stringify(v)).slice(0, 30));
  }
});

/* ===================== featured ===================== */
test('PODCAST_FEATURED: the fifteen named shows, in order, with the documented shape and distinct https feeds', () => {
  const f = E.PODCAST_FEATURED;
  assert.equal(f.length, 15);
  deepEq(f.map(s => s.title), ['Planet Money', 'Hidden Brain', 'TED Talks Daily', 'The Daily', '99% Invisible', 'Radiolab', 'Freakonomics Radio', 'Darknet Diaries', 'Science Vs', 'The Vergecast', 'Huberman Lab', 'This American Life', 'Lex Fridman Podcast', 'Syntax', 'The Infinite Monkey Cage']);
  deepEq(f.map(s => s.feedUrl), [
    'https://feeds.npr.org/510289/podcast.xml', 'https://feeds.npr.org/510308/podcast.xml', 'https://feeds.feedburner.com/TEDTalks_audio', 'https://feeds.simplecast.com/54nAGcIl',
    'https://feeds.simplecast.com/BqbsxVfO', 'https://feeds.simplecast.com/EmVW7VGp', 'https://feeds.simplecast.com/Y8lFbOT4', 'https://feeds.megaphone.fm/darknetdiaries',
    'https://feeds.megaphone.fm/sciencevs', 'https://feeds.megaphone.fm/vergecast', 'https://feeds.megaphone.fm/hubermanlab', 'https://www.thisamericanlife.org/podcast/rss.xml',
    'https://lexfridman.com/feed/podcast/', 'https://feed.syntax.fm/', 'https://podcasts.files.bbci.co.uk/b00snr0w.rss'
  ]);
  deepEq(f[0], { type: 'show', id: 'featured:planet-money', title: 'Planet Money', author: 'NPR', feedUrl: 'https://feeds.npr.org/510289/podcast.xml', image: '', featured: true });
  for (const s of f) {
    deepEq(Object.keys(s), ['type', 'id', 'title', 'author', 'feedUrl', 'image', 'featured']);
    assert.ok(/^featured:[a-z0-9-]+$/.test(s.id), s.id);
    assert.equal(E.podcastNormalizeFeedUrl(s.feedUrl), s.feedUrl, 'already canonical: ' + s.feedUrl);
    assert.ok(s.author.length > 0);
  }
  assert.equal(new Set(f.map(s => s.id)).size, 15);
  assert.equal(new Set(f.map(s => s.feedUrl)).size, 15);
});

/* ===================== merging ===================== */
test('podcastMergeEpisodes: dedupe by id (fresh wins, known-only fields kept), newest first, nulls last, url fallback key, junk-safe', () => {
  const known = [
    { id: 'a', title: 'A old', published: 100, note: 'kept' },
    { id: 'b', title: 'B', published: 50 },
    { id: 'z', title: 'Z undated', published: null },
    { url: 'https://h/u.mp3', title: 'by url', published: 10 },
    null, 'junk', 7, {}, { id: '' }
  ];
  const fresh = [
    { id: 'c', title: 'C', published: 200 },
    { id: 'a', title: 'A new', published: 100 },
    { url: 'https://h/u.mp3', title: 'by url (fresh)', published: 10 },
    { id: 'y', title: 'Y undated', published: null }
  ];
  deepEq(E.podcastMergeEpisodes(known, fresh), [
    { id: 'c', title: 'C', published: 200 },
    { id: 'a', title: 'A new', published: 100, note: 'kept' },
    { id: 'b', title: 'B', published: 50 },
    { url: 'https://h/u.mp3', title: 'by url (fresh)', published: 10 },
    { id: 'y', title: 'Y undated', published: null },
    { id: 'z', title: 'Z undated', published: null }
  ]);
  deepEq(E.podcastMergeEpisodes(null, undefined), []);
  deepEq(E.podcastMergeEpisodes('x', 7), []);
  deepEq(E.podcastMergeEpisodes([], SHOW_FULL.episodes).map(e => e.id), SHOW_FULL.episodes.map(e => e.id));
  deepEq(E.podcastMergeEpisodes(SHOW_FULL.episodes, SHOW_FULL.episodes), SHOW_FULL.episodes, 'merging a feed with itself is the identity');
  assert.notEqual(E.podcastMergeEpisodes(known, fresh)[1], fresh[1], 'inputs are never returned by reference');
  deepEq(known[0], { id: 'a', title: 'A old', published: 100, note: 'kept' }, 'inputs are not mutated');
});

/* ===================== determinism ===================== */
test('determinism: identical input → identical output across every parser', () => {
  deepEq(E.podcastParseFeed(RSS_FULL, FEED_URL), SHOW_FULL);
  deepEq(E.podcastParseFeed(ATOM, 'https://atom.example.org/feed.atom'), E.podcastParseFeed(ATOM, 'https://atom.example.org/feed.atom'));
  deepEq(E.podcastParseFeed(RSS_MESSY, 'https://m.example.com/feed.xml'), E.podcastParseFeed(RSS_MESSY, 'https://m.example.com/feed.xml'));
  deepEq(E.xmlParse(RSS_BROKEN), E.xmlParse(RSS_BROKEN));
  deepEq(E.xmlParse(JUNK_STR), E.xmlParse(JUNK_STR));
  assert.equal(E.opmlBuild(E.PODCAST_FEATURED, { now: NOW }), E.opmlBuild(E.PODCAST_FEATURED, { now: NOW }));
  deepEq(E.opmlParse(E.opmlBuild(E.PODCAST_FEATURED)), E.PODCAST_FEATURED.map(s => ({ title: s.title, feedUrl: s.feedUrl })));
});
test('junk sweep: every export survives hostile arguments without throwing', () => {
  const junk = [undefined, null, 0, -1, NaN, Infinity, '', ' ', 'x', '<', '&', 12, 1e21, true, {}, [], [null], { id: null }, () => {}, new Uint8Array(0), new Uint8Array([0xff, 0xfe, 0x3c]), JUNK, JUNK_STR, RSS_FULL, '\uD83D', 'a'.repeat(199) + '\u{1F600}', 'constructor', '__proto__'];
  const fns = ['xmlParse', 'xmlChild', 'xmlChildren', 'xmlText', 'podcastParseFeed', 'podcastDurationSeconds', 'stripHtml', 'itunesSearchUrl', 'itunesLookupUrl', 'podcastNormalizeItunes', 'podcastNormalizeFeedUrl', 'podcastIsFeedUrl', 'podcastEpisodeKey', 'opmlParse', 'opmlBuild', 'podcastMergeEpisodes'];
  for (const name of fns) {
    assert.equal(typeof E[name], 'function', name);
    for (const a of junk) for (const b of junk) E[name](a, b);
  }
  deepEq(Object.keys(E.podcast).sort(), [...fns, 'PODCAST_FEATURED'].sort());
});

/* ===================== hostile input: bounded, linear-time work ===================== */
// Each case once cost its input squared (stripHtml rescanned to the end of the string from every unterminated
// tag; collectItems rebuilt its array per child; every field lookup rescanned the channel's siblings) or was
// unbounded (a 20 MB description was flattened whole before the cap). The assertions pin the result shapes;
// the wall clock is checked once over all of them by the last test in the file.
const ITEM = i => `<item><title>Ep ${i}</title><guid>g${i}</guid><enclosure url="https://h/${i}.mp3" type="audio/mpeg" length="100"/><pubDate>Thu, 01 Oct 2026 00:00:${String(i % 60).padStart(2, '0')} GMT</pubDate><description>d</description></item>`;
const FEED_WITH = inner => `<rss><channel><title>t</title><item><guid>g</guid><enclosure url="https://h/x.mp3"/>${inner}</item></channel></rss>`;
hostile('stripHtml: 50 KB of unterminated tags of every rule (block, inline, li, td, svg) is text', () => {
  for (const open of ['<p ', '<a ', '<li ', '<td ', '<svg ', '<P class="x" ']) {
    const s = open.repeat(Math.ceil(51200 / open.length));
    assert.equal(E.stripHtml(s), s.trim(), JSON.stringify(open));
  }
});
hostile('stripHtml: 1 MB of unterminated tags is text; unterminated comment/script swallow the rest', () => {
  assert.equal(E.stripHtml('<p '.repeat(349525)).length, 349525 * 3 - 1);
  assert.equal(E.stripHtml('keep<!--' + '<!--'.repeat(12800)), 'keep');
  assert.equal(E.stripHtml('keep<script>' + '<script>'.repeat(6400) + 'alert(1)'), 'keep');
});
hostile('podcastParseFeed: a 1 MB CDATA description of unterminated tags yields the capped text', () => {
  const r = E.podcastParseFeed(FEED_WITH('<description><![CDATA[' + '<p '.repeat(349525) + ']]></description>'), FEED_URL);
  assert.equal(r.episodes[0].description.length, 20000);
  assert.ok(r.episodes[0].description.startsWith('<p <p <p '));
});
hostile('podcastParseFeed: a 512 KB description of raw <p> elements is flattened within the markup budget, not whole', () => {
  const r = E.podcastParseFeed(FEED_WITH('<description>' + '<p>x</p>'.repeat(65536) + '</description>'), FEED_URL);
  assert.equal(r.episodes[0].description.length, 20000);
  assert.ok(r.episodes[0].description.startsWith('x\n\nx\n\nx'));
  const cdata = E.podcastParseFeed(FEED_WITH('<description><![CDATA[' + '<p>x</p>'.repeat(65536) + ']]></description>'), FEED_URL);
  assert.equal(cdata.episodes[0].description, r.episodes[0].description, 'raw and CDATA markup flatten alike');
});
hostile('podcastParseFeed: 30k items are all found, in date order, with no duplicates (collectItems is one pass)', () => {
  const N = 30000;
  const r = E.podcastParseFeed('<rss><channel><title>t</title>' + Array.from({ length: N }, (_, i) => ITEM(i)).join('') + '</channel></rss>', FEED_URL);
  assert.equal(r.ok, true);
  assert.equal(r.count, N);
  assert.equal(r.skipped, 0);
  assert.equal(new Set(r.episodes.map(e => e.id)).size, N);
  for (let k = 1; k < N; k++) assert.ok(r.episodes[k - 1].published >= r.episodes[k].published, 'newest first at ' + k);
  assert.equal(r.episodes[0].published, Date.UTC(2026, 9, 1, 0, 0, 59));
});
hostile('xmlParse: a parent keeps at most 200k children (with one warning); feed field lookups over them stay cheap', () => {
  const r = E.xmlParse('<c><title>t</title>' + '<i/>'.repeat(300000) + '</c>');
  assert.equal(r.ok, true);
  assert.equal(E.xmlChildren(r.root).length, 200000);
  assert.equal(r.errors.filter(e => /more than 200000 children in <c>/.test(e)).length, 1);
  const feed = E.podcastParseFeed('<rss><channel><title>t</title>' + '<i/>'.repeat(300000) + '</channel></rss>', FEED_URL);
  assert.equal(feed.ok, true);
  assert.equal(feed.title, 't');
  assert.equal(feed.count, 0);
  assert.ok(feed.warnings.some(w => /more than 200000 children/.test(w)));
});
hostile('podcastDurationSeconds: a long run of inner whitespace is junk, not a quadratic regex match', () => {
  assert.equal(E.podcastDurationSeconds('1h' + ' '.repeat(50000) + 'x'), null);
  assert.equal(E.podcastDurationSeconds('1h' + ' '.repeat(70) + '2m'), null, 'longer than any real duration');
  assert.equal(E.podcastDurationSeconds('1 h   2 \t m'), 3720, 'short inner runs collapse');
});
hostile('xmlParse: element and attribute names in diagnostics are cut to 60 characters', () => {
  const name = 'n'.repeat(300000);
  const r = E.xmlParse('<a>' + ('</' + name + '>').repeat(150) + '</a>');
  assert.ok(r.errors.every(e => e.length < 120), 'longest message ' + Math.max(...r.errors.map(e => e.length)));
  assert.ok(/^line 1: stray <\/n{59}…> ignored$/.test(r.errors[0]), r.errors[0]);
  const w = E.podcastParseFeed('<' + name + '>', FEED_URL).warnings;
  assert.ok(w.every(e => e.length < 120));
  assert.ok(/duplicate attribute n{59}… in <a> ignored/.test(E.xmlParse('<a ' + name + '="1" ' + name + '="2"/>').errors[0]));
});

/* ===================== correctness fixes found by the same review ===================== */
test('stripHtml: a quoted attribute may contain ">"; an unbalanced quote ends at the first ">"; declarations go', () => {
  assert.equal(E.stripHtml('<a title="x > y">link</a> rest'), 'link rest');
  assert.equal(E.stripHtml("<p data-x='a>b'>t</p>"), 't');
  assert.equal(E.stripHtml('<a href="x>text</a> more'), 'text more');
  assert.equal(E.stripHtml('<!DOCTYPE html><?xml version="1.0"?>x<!y>z'), 'xz');
  assert.equal(E.stripHtml('a <!b'), 'a <!b', 'an unterminated declaration is text');
});
test('podcastParseFeed: ids and categories named like Object.prototype properties are kept', () => {
  const ids = ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf', 'normal'];
  const r = E.podcastParseFeed('<rss><channel><itunes:category text="constructor"/><itunes:category text="Comedy"/><itunes:category text="comedy"/>'
    + ids.map(id => `<item><guid>${id}</guid><enclosure url="https://h/${id}.mp3" type="audio/mpeg"/></item>`).join('') + '</channel></rss>', FEED_URL);
  deepEq(r.episodes.map(e => e.id), ids);
  assert.equal(r.skipped, 0);
  deepEq(r.categories, ['constructor', 'Comedy']);
  const dup = E.podcastParseFeed('<rss><channel>' + '<item><guid>__proto__</guid><enclosure url="https://h/p.mp3"/></item>'.repeat(2) + '</channel></rss>', FEED_URL);
  assert.equal(dup.count, 1, 'a real duplicate is still a duplicate');
  assert.equal(dup.skipped, 1);
});
test('xmlChild/xmlChildren: a prefixed element stands in for an unprefixed name only when the node has no exact match', () => {
  const r = E.xmlParse('<c><a:title>P</a:title><a:entry/><itunes:image href="i"/></c>');
  assert.equal(E.xmlText(E.xmlChild(r.root, 'title')), 'P');
  assert.equal(E.xmlChild(r.root, 'TITLE').name, 'a:title');
  assert.equal(E.xmlChild(r.root, 'b:title'), null, 'a wanted prefix is exact');
  assert.equal(E.xmlChild(r.root, 'image').name, 'itunes:image', 'nothing else called image here');
  const both = E.xmlParse('<c><a:title>P</a:title><title>A</title><Title>B</Title></c>');
  deepEq(E.xmlChildren(both.root, 'title').map(E.xmlText), ['A', 'B']);
  const list = E.xmlChildren(both.root, 'title');
  list.push(null);
  assert.equal(E.xmlChildren(both.root, 'title').length, 2, 'callers get their own array');
  deepEq(JSON.parse(JSON.stringify(E.xmlParse('<a>t</a>').root.children[0])), { name: '#text', attrs: {}, children: [], text: 't' }, 'text node shape');
});
test('Atom: a feed that binds its namespace to a prefix (<a:feed>/<a:entry>) parses like a plain one', () => {
  const r = E.podcastParseFeed('<a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:title>prefixed atom</a:title><a:link rel="alternate" href="https://p.example.org/"/>'
    + '<a:entry><a:id>1</a:id><a:title>One</a:title><a:link rel="enclosure" href="https://h/1.mp3" type="audio/mpeg"/><a:updated>2026-10-01T00:00:00Z</a:updated></a:entry></a:feed>', 'https://feeds.example.com/x.xml');
  assert.equal(r.kind, 'atom');
  assert.equal(r.title, 'prefixed atom');
  assert.equal(r.link, 'https://p.example.org/');
  assert.equal(r.count, 1);
  deepEq([r.episodes[0].id, r.episodes[0].title, r.episodes[0].url, r.episodes[0].published], ['1', 'One', 'https://h/1.mp3', Date.UTC(2026, 9, 1)]);
});
test('xml:base on the feed, entry or link resolves relative enclosure/link hrefs; the feed URL is the fallback', () => {
  const r = E.podcastParseFeed('<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://media.example.org/pod/"><title>t</title>'
    + '<link rel="alternate" href="site/"/>'
    + '<entry><id>1</id><link rel="enclosure" href="ep1.mp3" type="audio/mpeg"/><link rel="alternate" href="ep1.html"/></entry>'
    + '<entry xml:base="/other/"><id>2</id><link rel="enclosure" href="ep2.mp3" type="audio/mpeg"/><link rel="alternate" xml:base="https://blog.example.net/" href="ep2.html"/></entry>'
    + '<entry xml:base="not a base"><id>3</id><link rel="enclosure" href="ep3.mp3" type="audio/mpeg"/></entry></feed>', 'https://feeds.example.com/atom.xml');
  assert.equal(r.link, 'https://media.example.org/pod/site/');
  deepEq(r.episodes.map(e => [e.id, e.url, e.link]), [
    ['1', 'https://media.example.org/pod/ep1.mp3', 'https://media.example.org/pod/ep1.html'],
    ['2', 'https://media.example.org/other/ep2.mp3', 'https://blog.example.net/ep2.html'],
    ['3', 'https://media.example.org/pod/ep3.mp3', '']
  ]);
  const rss = E.podcastParseFeed('<rss><channel xml:base="https://cdn.example.org/show/"><item><guid>1</guid><enclosure url="a.mp3" type="audio/mpeg"/></item></channel></rss>', FEED_URL);
  assert.equal(rss.episodes[0].url, 'https://cdn.example.org/show/a.mp3');
});
test('titles: known HTML tags are stripped, other angle-bracket text survives, entities decode', () => {
  const t = title => E.podcastParseFeed(`<rss><channel><title>${title}</title><item><title>${title}</title><guid>1</guid><enclosure url="https://h/1.mp3"/></item></channel></rss>`, FEED_URL);
  const r = t('Interview with &lt;Guest Name&gt; today &lt;LIVE&gt;');
  assert.equal(r.title, 'Interview with <Guest Name> today <LIVE>');
  assert.equal(r.episodes[0].title, r.title);
  assert.equal(t('<![CDATA[Ep 3: <b>Bold</b> &amp; <span class="x">plain</span><br>next]]>').title, 'Ep 3: Bold & plain next');
  assert.equal(t('Tom &amp;amp; Jerry &amp;#8212; 3').title, 'Tom & Jerry — 3', 'double-escaped entities (a common generator bug) still decode');
  assert.equal(t('5 &lt; 7 and &lt;3 and a&lt;b').title, '5 < 7 and <3 and a<b');
  assert.equal(t('a&lt;b and c&gt;d').title, 'ad', '"<b and c>" cannot be told from a bold tag');
});
test('enclosure type must be a media-type token (else derived from the URL) and length a sane byte count', () => {
  const ep = (attrs) => E.podcastParseFeed(`<rss><channel><item><guid>g</guid><enclosure url="https://h/x.mp3" ${attrs}/></item></channel></rss>`, FEED_URL).episodes[0];
  deepEq([ep('type="audio/' + 'x'.repeat(1000000) + '" length="1e308"').type, ep('type="audio/' + 'x'.repeat(1000000) + '" length="1e308"').length], ['audio/mpeg', null]);
  assert.equal(ep('type="audio/mpeg; codecs=mp3" length="12345.9"').type, 'audio/mpeg');
  assert.equal(ep('type="audio/mpeg; codecs=mp3" length="12345.9"').length, 12345);
  assert.equal(ep('type="audio/x-m4a"').type, 'audio/x-m4a');
  assert.equal(ep('type="AUDIO/MPEG"').type, 'audio/mpeg');
  assert.equal(ep('type="audio/<b>junk</b>"').type, 'audio/mpeg');
  assert.equal(ep('length="99999999999999"').length, null, '100 TB is not an episode');
  assert.equal(ep('length="99999999999999"').type, 'audio/mpeg');
});
test('podcastNormalizeFeedUrl: a backslash in the address, a port above 65535 → null; underscores in host labels pass', () => {
  for (const bad of ['https://evil.com\\@good.com/feed', 'https://good.com/feed\\x', 'https://example.com:99999/x', 'example.com:65536/feed']) assert.equal(E.podcastNormalizeFeedUrl(bad), null, bad);
  assert.equal(E.podcastNormalizeFeedUrl('https://example.com:65535/x'), 'https://example.com:65535/x');
  assert.equal(E.podcastNormalizeFeedUrl('https://feeds_x.example.com/feed'), 'https://feeds_x.example.com/feed');
  assert.equal(E.podcastIsFeedUrl('https://evil.com\\@good.com/feed'), false);
});
test('itunesSearchUrl: a term cut inside an emoji or holding a lone surrogate still encodes', () => {
  const cut = E.itunesSearchUrl('a'.repeat(199) + '\u{1F600}');
  assert.equal(cut, 'https://itunes.apple.com/search?media=podcast&entity=podcast&term=' + 'a'.repeat(199) + '&limit=25&country=GB');
  assert.equal(E.itunesSearchUrl('\uD83D'), 'https://itunes.apple.com/search?media=podcast&entity=podcast&term=%EF%BF%BD&limit=25&country=GB');
  assert.equal(E.itunesSearchUrl('x\uDE00y'), 'https://itunes.apple.com/search?media=podcast&entity=podcast&term=x%EF%BF%BDy&limit=25&country=GB');
  assert.equal(E.itunesSearchUrl('\u{1F600}'.repeat(100)).split('term=')[1].split('&')[0], '%F0%9F%98%80'.repeat(100), 'whole pairs survive');
});
test('podcastNormalizeItunes: ids are positive integers as written; episode counts are bounded', () => {
  assert.equal(E.podcastNormalizeItunes({ feedUrl: 'https://a.b/f', collectionId: 0.5 }).id, 'feed:https://a.b/f');
  assert.equal(E.podcastNormalizeItunes({ feedUrl: 'https://a.b/f', collectionId: 1e21 }).id, 'feed:https://a.b/f');
  assert.equal(E.podcastNormalizeItunes({ feedUrl: 'https://a.b/f', collectionId: -3, trackId: '42' }).id, 'itunes:42');
  assert.equal(E.podcastNormalizeItunes({ feedUrl: 'https://a.b/f', trackCount: 1e21 }).episodeCount, null);
  assert.equal(E.podcastNormalizeItunes({ feedUrl: 'https://a.b/f', trackCount: 2087.7 }).episodeCount, 2087);
});
test('xmlParse: a start tag reported after its attributes keeps its own line and does not inflate later ones', () => {
  deepEq(E.xmlParse('<a\n\n\n" x="1"').errors, ['line 4: unexpected """ in <a> skipped', 'line 1: unclosed start tag <a> at end of input', 'line 4: unclosed <a> at end of input']);
  deepEq(E.xmlParse('\n<a\n\n"\n<b/></a>').errors, ['line 4: unexpected """ in <a> skipped', 'line 5: unclosed start tag <a>']);
});
test('xmlParse: bytes honour a declared single-byte encoding; a UTF-8 BOM or an unknown label means UTF-8', () => {
  const enc = s => new TextEncoder().encode(s);
  const latin = Uint8Array.from([...enc('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf'), 0xE9, ...enc('</title></channel></rss>')]);
  assert.equal(E.podcastParseFeed(latin, FEED_URL).title, 'Café');
  // (0xE9 rather than a C1 byte: Node's ICU passes 0x80-0x9F through for this label where browsers remap them.)
  const cp = Uint8Array.from([...enc("<?xml version='1.0' encoding='windows-1252' ?><rss><channel><title>"), 0x41, 0xE9, ...enc('</title></channel></rss>')]);
  assert.equal(E.podcastParseFeed(cp, FEED_URL).title, 'Aé');
  const bom = Uint8Array.from([0xEF, 0xBB, 0xBF, ...enc('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Café</title></channel></rss>')]);
  assert.equal(E.podcastParseFeed(bom, FEED_URL).title, 'Café', 'a BOM outranks the declaration');
  const bogus = enc('<?xml version="1.0" encoding="x-no-such-label"?><rss><channel><title>Café</title></channel></rss>');
  assert.equal(E.podcastParseFeed(bogus, FEED_URL).title, 'Café');
  assert.equal(E.podcastParseFeed(enc('<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Café</title></channel></rss>').buffer, FEED_URL).title, 'Café');
});
test('hostile battery: the cases above together finish in well under 10 s (a quadratic regression takes minutes)', () => {
  assert.ok(hostileMs < 10000, `hostile cases took ${hostileMs} ms`);
});

run();

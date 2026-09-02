#!/usr/bin/env node
/**
 * Unit tests for sonar/engine.js — the pure realtime-web-search engine behind
 * Sonar (Messages API request building, SSE parsing, the stream reducer that
 * turns raw Anthropic events into Sonar's text/searching/found/cite/turn
 * events, source numbering and de-duplication, pause_turn content replay,
 * escape-first answer rendering, and the honest offline demo mode).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-sonar-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'sonar', 'engine.js'), 'utf8'), sandbox, { filename: 'sonar/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0); // 2026-09-02 12:00 UTC, a Wednesday
const { MINUTE, HOUR, DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

// Run a scripted list of raw Anthropic stream events through the reducer,
// collecting everything it emits.
const run = (state, events) => events.flatMap((evt) => E.reduceEvent(state, evt));

/* ---------- text safety & URLs ---------- */
test('escapeHTML escapes the five specials', () => {
  assert.equal(E.escapeHTML('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});
test('domainOf: strips scheme, www, creds, port; empty on junk', () => {
  assert.equal(E.domainOf('https://www.Example.com:8080/path?q=1'), 'example.com');
  assert.equal(E.domainOf('https://user:pw@news.site.co.uk/x'), 'news.site.co.uk');
  assert.equal(E.domainOf('not a url'), '');
});
test('canonicalURL: same page, one source', () => {
  assert.equal(E.canonicalURL('https://Example.com/a/'), E.canonicalURL('http://example.com/a#frag'));
  assert.notEqual(E.canonicalURL('https://example.com/a'), E.canonicalURL('https://example.com/b'));
});

/* ---------- question & history hygiene ---------- */
test('validateQuestion: trims, collapses whitespace, rejects empty and huge', () => {
  const v = E.validateQuestion('  what   is\n\nnew  ');
  assert.equal(v.ok, true);
  assert.equal(v.question, 'what is new');
  assert.equal(E.validateQuestion('   ').ok, false);
  assert.equal(E.validateQuestion('x'.repeat(E.QUESTION_MAX + 1)).ok, false);
});
test('sanitizeHistory: coerces roles, keeps last 12, caps content', () => {
  const long = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'weird', content: 'm' + i }));
  const out = E.sanitizeHistory(long);
  assert.equal(out.length, 12);
  assert.equal(out[0].content, 'm8');
  assert.ok(out.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.equal(E.sanitizeHistory([{ role: 'user', content: 'y'.repeat(9000) }])[0].content.length, 4000);
  assert.equal(E.sanitizeHistory([{ role: 'user' }])[0].content, '(empty)');
  deepEq(E.sanitizeHistory('junk'), []);
});

/* ---------- the request body ---------- */
test('systemPrompt carries today’s date so “today” means today', () => {
  const sys = E.systemPrompt(NOW);
  assert.ok(sys.includes('Wednesday, 2 September 2026'), sys.slice(0, 120));
  assert.ok(sys.includes('web_search'));
});
test('buildRequestBody: model default, streaming, web_search tool, question last', () => {
  const body = E.buildRequestBody('what is new', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], {}, NOW);
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.stream, true);
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].type, 'web_search_20260209');
  assert.equal(body.tools[0].name, 'web_search');
  assert.equal(body.tools[0].max_uses, 5);
  assert.equal(body.messages.length, 3);
  deepEq(body.messages[2], { role: 'user', content: 'what is new' });
});
test('buildRequestBody clamps knobs into sane ranges', () => {
  const b = E.buildRequestBody('q', [], { maxTokens: 999999, maxSearches: 99, model: 'claude-x' }, NOW);
  assert.equal(b.max_tokens, 8192);
  assert.equal(b.tools[0].max_uses, 8);
  assert.equal(b.model, 'claude-x');
  const c = E.buildRequestBody('q', [], { maxTokens: -5, maxSearches: 0 }, NOW);
  assert.equal(c.max_tokens, 256);
  assert.equal(c.tools[0].max_uses, 1);
});

/* ---------- SSE parsing ---------- */
test('sseParse: events split across chunks reassemble; carry holds the tail', () => {
  let r = E.sseParse('', 'data: {"type":"me');
  deepEq(r.events, []);
  assert.equal(r.carry, 'data: {"type":"me');
  r = E.sseParse(r.carry, 'ssage_start"}\r\ndata: {"type":"ping"}\n\nevent: ping\ndata: [DONE]\ndata: notjson\ndata: {"a":1');
  deepEq(r.events.map((e) => e.type), ['message_start', 'ping']);
  assert.equal(r.carry, 'data: {"a":1');
});

/* ---------- the stream reducer, happy path ---------- */
const searchStream = [
  { type: 'message_start', message: { id: 'msg_1' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig1' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'tu_1', name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"que' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ry":"news today"}' } },
  { type: 'content_block_stop', index: 1 },
  {
    type: 'content_block_start', index: 2, content_block: {
      type: 'web_search_tool_result', tool_use_id: 'tu_1', content: [
        { type: 'web_search_result', url: 'https://www.bbc.co.uk/news/live', title: 'BBC Live' },
        { type: 'web_search_result', url: 'https://reuters.com/world', title: 'Reuters World' },
        { type: 'web_search_result', url: 'https://apnews.com/hub', title: 'AP Hub' },
        { type: 'web_search_result', url: 'https://example.org/four', title: 'Four' },
      ],
    },
  },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'Big news: ' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://www.bbc.co.uk/news/live', title: 'BBC Live', cited_text: 'big' } } },
  { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'more news' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://bbc.co.uk/news/live/', title: 'BBC Live', cited_text: 'more' } } },
  { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://reuters.com/world', title: 'Reuters World', cited_text: 'also' } } },
  { type: 'content_block_stop', index: 3 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } },
  { type: 'message_stop' },
];

test('reducer narrates a full search turn in order', () => {
  const state = E.initStream();
  const out = run(state, searchStream);
  deepEq(out.map((e) => e.t),
    ['thinking', 'searching', 'search', 'found', 'text', 'cite', 'text', 'cite', 'cite', 'turn']);
  assert.equal(out[2].query, 'news today');
  assert.equal(out[3].count, 4);
  deepEq(out[3].top.map((s) => s.domain), ['bbc.co.uk', 'reuters.com', 'apnews.com']);
  assert.equal(out[out.length - 1].stop, 'end_turn');
  assert.equal(state.answer, 'Big news: more news');
});
test('reducer numbers sources once per page, in citation order', () => {
  const state = E.initStream();
  const out = run(state, searchStream);
  const cites = out.filter((e) => e.t === 'cite');
  deepEq(cites.map((c) => c.n), [1, 1, 2], 'same page (slash/www variants) keeps one number');
  assert.equal(state.sources.length, 2);
  assert.equal(state.sources[0].domain, 'bbc.co.uk');
  assert.equal(state.sources[1].title, 'Reuters World');
});
test('search errors come back as an object, not a list — branch survives both', () => {
  const state = E.initStream();
  const out = run(state, [
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', tool_use_id: 'tu', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } },
  ]);
  deepEq(out, [{ t: 'search_error', code: 'max_uses_exceeded' }]);
  assert.equal(state.searches, 0);
});
test('stream error events surface as {t:error}', () => {
  const out = run(E.initStream(), [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
  deepEq(out, [{ t: 'error', message: 'Overloaded' }]);
});
test('unknown/new event types are ignored, not fatal', () => {
  const state = E.initStream();
  deepEq(run(state, [{ type: 'brand_new_thing' }, null, 'junk', { type: 'ping' }]), []);
});

/* ---------- pause_turn replay ---------- */
test('replayContent echoes the paused message’s blocks faithfully', () => {
  const state = E.initStream();
  run(state, searchStream.slice(0, -2)); // everything before message_delta/stop
  run(state, [{ type: 'message_delta', delta: { stop_reason: 'pause_turn' } }]);
  const content = state && E.replayContent(state);
  deepEq(content.map((b) => b.type), ['thinking', 'server_tool_use', 'web_search_tool_result', 'text']);
  deepEq(content[1], { type: 'server_tool_use', id: 'tu_1', name: 'web_search', input: { query: 'news today' } });
  assert.equal(content[2].tool_use_id, 'tu_1');
  assert.equal(content[2].content.length, 4);
  assert.equal(content[0].signature, 'sig1');
  assert.equal(content[3].text, 'Big news: more news');
  assert.equal(content[3].citations.length, 3);
});
test('replay drops what cannot be echoed: unsigned thinking, empty text', () => {
  const state = E.initStream();
  run(state, [
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'blob' } },
    { type: 'content_block_stop', index: 2 },
  ]);
  deepEq(E.replayContent(state).map((b) => b.type), ['redacted_thinking']);
});
test('a resumed message keeps source numbering and the answer so far', () => {
  const state = E.initStream();
  run(state, searchStream.slice(0, -2));
  run(state, [{ type: 'message_delta', delta: { stop_reason: 'pause_turn' } }]);
  const out = run(state, [
    { type: 'message_start', message: { id: 'msg_2' } }, // resume: blocks reset…
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' And more.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { url: 'https://apnews.com/hub', title: 'AP Hub' } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]);
  const cite = out.find((e) => e.t === 'cite');
  assert.equal(cite.n, 3, '…but numbering continues across the pause');
  assert.equal(state.answer, 'Big news: more news And more.');
  deepEq(E.replayContent(state).map((b) => b.type), ['text'], 'replay describes only the latest message');
});

/* ---------- rendering ---------- */
test('renderAnswerHTML escapes model text before decorating (no injection)', () => {
  const html = E.renderAnswerHTML([{ text: '<script>alert(1)</script> is **bad** & `x<y`' }]);
  assert.ok(!html.includes('<script>'), 'raw tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<b>bad</b>'));
  assert.ok(html.includes('<code>x&lt;y</code>'));
});
test('renderAnswerHTML pins numbered cite buttons between text slices', () => {
  const html = E.renderAnswerHTML([{ text: 'Rain tomorrow' }, { cite: 2 }, { text: ', clearing later.' }]);
  assert.ok(html.includes('data-action="jump-source"'));
  assert.ok(html.includes('data-n="2"'));
  assert.ok(/Rain tomorrow<sup>/.test(html), 'pin lands right after the fact');
});
test('renderAnswerHTML: paragraphs on blank lines, control chars stripped', () => {
  const html = E.renderAnswerHTML([{ text: 'one\n\ntwo\nthree' }]);
  assert.equal(html, '<p>one</p><p>two<br>three</p>');
});

/* ---------- offline demo mode ---------- */
test('offlineAnswer is deterministic and says it is simulated', () => {
  const a = E.offlineAnswer('what is new', NOW);
  const b = E.offlineAnswer('what is new', NOW);
  deepEq(a, b);
  assert.equal(a.simulated, true);
  assert.ok(a.answer.includes('Offline demo mode'));
  assert.ok(a.sources[0].simulated);
});

/* ---------- daily chips & time ---------- */
test('dailySuggestions: four per day, deterministic, changes with the date', () => {
  const today = E.dailySuggestions(NOW);
  deepEq(today, E.dailySuggestions(NOW + 2 * HOUR), 'same day, same chips');
  assert.equal(today.length, 4);
  assert.ok(today.every((s) => E.SUGGESTIONS.includes(s)));
  let differs = false;
  for (let d = 1; d <= 5 && !differs; d++) {
    differs = JSON.stringify(E.dailySuggestions(NOW + d * DAY)) !== JSON.stringify(today);
  }
  assert.ok(differs, 'chips rotate within a few days');
});
test('timeAgo boundaries', () => {
  assert.equal(E.timeAgo(NOW - 20 * 1000, NOW), 'just now');
  assert.equal(E.timeAgo(NOW - 5 * MINUTE, NOW), '5m ago');
  assert.equal(E.timeAgo(NOW - 3 * HOUR, NOW), '3h ago');
  assert.equal(E.timeAgo(NOW - 2 * DAY, NOW), '2d ago');
  assert.equal(E.timeAgo(NOW + MINUTE, NOW), 'just now', 'clock skew never goes negative');
});

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}
console.log(`\nsonar: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

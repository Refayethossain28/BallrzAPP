#!/usr/bin/env node
/**
 * Integration tests for sonar/server.mjs — spawns the REAL proxy pointed at a
 * throwaway fake Anthropic upstream (SONAR_API_URL), then asserts over real
 * HTTP: the NDJSON event stream for a full web-searched answer including two
 * pause_turn resumes (echoed assistant blocks, accumulating), health, static
 * serving with the traversal guard, and the keyless degraded mode with its
 * rate limit. No network beyond 127.0.0.1; no real key is ever used.
 * Run: node scripts/test-sonar-proxy.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---- a fake Anthropic upstream that scripts one paused turn, then the rest ---- */
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const CALL_1 = sse([
  { type: 'message_start', message: { id: 'msg_1' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'tu_1', name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"latest node lts"}' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start', index: 1, content_block: {
      type: 'web_search_tool_result', tool_use_id: 'tu_1', content: [
        { type: 'web_search_result', url: 'https://nodejs.org/en/blog', title: 'Node.js Blog' },
        { type: 'web_search_result', url: 'https://endoflife.date/nodejs', title: 'endoflife.date' },
      ],
    },
  },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'The current LTS is fresh' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://nodejs.org/en/blog', title: 'Node.js Blog', cited_text: 'LTS' } } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 10 } },
  { type: 'message_stop' },
]);

const CALL_2 = sse([
  { type: 'message_start', message: { id: 'msg_2' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' — released this week' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 6 } },
  { type: 'message_stop' },
]);

const CALL_3 = sse([
  { type: 'message_start', message: { id: 'msg_3' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', enjoy.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
]);

const upstreamCalls = [];
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    upstreamCalls.push({ headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([CALL_1, CALL_2, CALL_3][upstreamCalls.length - 1] || CALL_3);
  });
});

/* ---- helpers over the real proxy ---- */
const PROXY_PORT = 8792, BARE_PORT = 8793;
const P = (path) => `http://127.0.0.1:${PROXY_PORT}${path}`;
const B = (path) => `http://127.0.0.1:${BARE_PORT}${path}`;

async function askNDJSON(base, question) {
  const res = await fetch(base + '/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  const text = await res.text();
  return {
    status: res.status,
    events: text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

// Raw request so the path is NOT client-normalized (traversal must reach the server).
function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ---- the tests ---- */
test('health reports live + the configured model', async () => {
  const h = await (await fetch(P('/api/health'))).json();
  deepEq(h, { ok: true, live: true, model: 'claude-test-1' });
});

test('a full ask streams NDJSON events in order, resuming through TWO pause_turns', async () => {
  const { status, events } = await askNDJSON(P(''), 'what is the latest node lts?');
  assert.equal(status, 200);
  deepEq(events.map((e) => e.t),
    ['hello', 'searching', 'search', 'found', 'text', 'cite', 'turn', 'text', 'turn', 'text', 'turn', 'done']);
  assert.equal(events[2].query, 'latest node lts');
  assert.equal(events[3].count, 2);
  assert.equal(events[5].n, 1);
  assert.equal(events[5].domain, 'nodejs.org');
  assert.equal(events[6].stop, 'pause_turn');
  assert.equal(events[8].stop, 'pause_turn');
  const done = events[events.length - 1];
  assert.equal(done.stop, 'end_turn');
  assert.equal(done.sources.length, 1);
  assert.equal(done.sources[0].title, 'Node.js Blog');
});

test('the upstream saw a real Messages request with the web_search tool', () => {
  assert.equal(upstreamCalls.length, 3, 'one original call + two pause_turn resumes');
  const { headers, body } = upstreamCalls[0];
  assert.equal(headers['x-api-key'], 'test-key-not-real');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(body.model, 'claude-test-1');
  assert.equal(body.stream, true);
  assert.equal(body.tools[0].type, 'web_search_20260209');
  assert.ok(body.system.includes('Sonar'));
  deepEq(body.messages, [{ role: 'user', content: 'what is the latest node lts?' }]);
});

test('the resume echoed the paused assistant blocks verbatim (parsed input, results, cited text)', () => {
  const { body } = upstreamCalls[1];
  assert.equal(body.messages.length, 2);
  const echo = body.messages[1];
  assert.equal(echo.role, 'assistant');
  deepEq(echo.content.map((b) => b.type), ['server_tool_use', 'web_search_tool_result', 'text']);
  deepEq(echo.content[0].input, { query: 'latest node lts' });
  assert.equal(echo.content[1].content.length, 2);
  assert.equal(echo.content[2].text, 'The current LTS is fresh');
  assert.equal(echo.content[2].citations.length, 1);
});

test('echoes ACCUMULATE across pauses: the second resume still carries the first', () => {
  const { body } = upstreamCalls[2];
  assert.equal(body.messages.length, 3, 'user + first echo + second echo');
  deepEq(body.messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
  deepEq(body.messages[1].content.map((b) => b.type), ['server_tool_use', 'web_search_tool_result', 'text'],
    'the first paused segment (its search + text) is not dropped');
  deepEq(body.messages[2].content.map((b) => b.type), ['text']);
  assert.equal(body.messages[2].content[0].text, ' — released this week');
});

test('an unanswerable question is refused before spending anything', async () => {
  const res = await fetch(P('/api/ask'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.includes('Ask something'));
});

test('static: / serves the app same-origin', async () => {
  const res = await fetch(P('/'));
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('text/html'));
  assert.ok((await res.text()).includes('SonarEngine'), 'the page loads the engine');
});

test('static: path traversal never escapes sonar/, unknown files 404', async () => {
  // The WHATWG URL parser collapses dot segments (encoded or not) before the
  // handler runs, and the normalize+startsWith guard backstops anything else —
  // either way, nothing outside sonar/ may be served.
  for (const path of ['/%2e%2e/package.json', '/../package.json', '/..%5cpackage.json']) {
    const t = await rawGet(PROXY_PORT, path);
    assert.notEqual(t.status, 200, `${path} must not be served`);
    assert.ok(!t.body.includes('ballrzapp-prototypes'), `${path} must not leak the root package.json`);
  }
  const miss = await fetch(P('/nope.js'));
  assert.equal(miss.status, 404);
});

test('keyless server still serves the page and says so on /api/health', async () => {
  const h = await (await fetch(B('/api/health'))).json();
  deepEq(h, { ok: true, live: false, model: 'claude-test-1' });
  const page = await fetch(B('/'));
  assert.equal(page.status, 200);
});

test('keyless ask degrades to a 503 the page turns into offline mode', async () => {
  const { status, events } = await askNDJSON(B(''), 'anything');
  assert.equal(status, 503);
  assert.ok(events[0].error.includes('ANTHROPIC_API_KEY'));
});

test('an oversized request gets a readable 413, not a dead socket', async () => {
  const res = await fetch(P('/api/ask'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'x', history: [{ role: 'user', content: 'y'.repeat(70_000) }] }),
  });
  assert.equal(res.status, 413);
  assert.ok((await res.json()).error.includes('too large'));
});

test('the per-IP rate limit brakes a hot loop with 429', async () => {
  // BARE runs with SONAR_RATE_MAX=2 and has seen 1 ask so far: the second is
  // still allowed through (to its keyless 503), the third hits the brake.
  const one = () => fetch(B('/api/ask'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'x' }) });
  assert.equal((await one()).status, 503);
  assert.equal((await one()).status, 429);
});

/* ---- boot both servers, run, tear down ---- */
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;

const bareEnv = { ...process.env, PORT: String(BARE_PORT), HOST: '127.0.0.1', SONAR_MODEL: 'claude-test-1', SONAR_RATE_MAX: '2' };
delete bareEnv.ANTHROPIC_API_KEY;

const srv = spawn(process.execPath, [join(ROOT, 'sonar', 'server.mjs')], {
  env: {
    ...process.env, PORT: String(PROXY_PORT), HOST: '127.0.0.1',
    ANTHROPIC_API_KEY: 'test-key-not-real', SONAR_MODEL: 'claude-test-1',
    SONAR_API_URL: `http://127.0.0.1:${upstreamPort}/v1/messages`,
  },
  stdio: 'ignore',
});
const bare = spawn(process.execPath, [join(ROOT, 'sonar', 'server.mjs')], { env: bareEnv, stdio: 'ignore' });

try {
  for (let i = 0; i < 40; i++) {
    try {
      const a = await fetch(P('/api/health'));
      const b = await fetch(B('/api/health'));
      if (a.ok && b.ok) break;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
  }
} finally {
  srv.kill();
  bare.kill();
  upstream.close();
}
console.log(`\nsonar proxy: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

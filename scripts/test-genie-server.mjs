#!/usr/bin/env node
/**
 * Integration tests for genie/server.mjs — spawns the REAL console server in
 * rehearsal mode (GENIE_DRIVER=rehearsal: no SDK, no credentials, nothing is
 * executed) against throwaway GENIE_HOME directories, then asserts over real
 * HTTP: bearer auth, the static allowlist with its traversal guard, a full
 * ask-mode run read from the NDJSON event stream (exact event order, the
 * approval round-trip answered while the stream is open, allow / deny /
 * always / timeout), transcript persistence rules, slash commands, the
 * schedules API including run-now, the global run queue, stop, 409/413/400,
 * an auto-mode server that never asks, and a restart with the same home.
 *
 * Server A: 8801 (mode ask, 5 s ask timeout)   Server B: 8802 (mode auto)
 * Server A': 8803 (A restarted on the same GENIE_HOME — persistence check)
 *
 * No network beyond 127.0.0.1; no real key is ever used.
 * Run: node scripts/test-genie-server.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'genie', 'server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// If our stdout/stderr pipe closes early (e.g. `| head`), keep running so the
// finally block still kills the spawned servers instead of orphaning them.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---- ports, homes, key ---- */
const PORT_A = 8801, PORT_B = 8802, PORT_A2 = 8803;
const KEY = 'test-key-not-real';
const HOME_A = mkdtempSync(join(tmpdir(), 'genie-test-a-'));
const HOME_B = mkdtempSync(join(tmpdir(), 'genie-test-b-'));
const TZ = -new Date().getTimezoneOffset() || 0; // `|| 0` folds -0 (UTC hosts) into 0 so it round-trips through JSON

/* ---- HTTP helpers (every /api call carries the bearer unless told otherwise) ---- */
const U = (port, path) => `http://127.0.0.1:${port}${path}`;

async function api(port, method, path, body, { auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth) h.authorization = `Bearer ${KEY}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(U(port, path), init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body: json, text };
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

async function until(fn, { timeout = 3000, every = 50, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(every);
  }
}

/* ---- the NDJSON stream reader ----
 * Opens GET /api/conversations/:id/events?since=N with the bearer header, parses
 * lines as they arrive and lets tests await a predicate with a timeout. The
 * stream must be OPEN while approvals are answered: the server blocks the run
 * on them, and the `ask` only reaches us through this stream. */
const STREAMS = new Set();
function openStream(port, convId, since = 0) {
  const events = [];
  const waiters = [];
  let closed = false, carry = '';
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  const req = http.request({
    host: '127.0.0.1', port, method: 'GET',
    path: `/api/conversations/${convId}/events?since=${since}`,
    headers: { authorization: `Bearer ${KEY}` },
  });
  const failWaiters = (err) => { for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); } };
  const seen = () => events.map((e) => e.t).join(',') || '(nothing yet)';
  const s = {
    events, status: null, headers: null, ready,
    close() { if (!closed) { closed = true; req.destroy(); } STREAMS.delete(s); failWaiters(new Error('stream closed')); },
    waitFor(pred, timeout = 10_000, label = 'event') {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      if (closed) return Promise.reject(new Error(`stream already closed while waiting for ${label}; saw: ${seen()}`));
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, reject, timer: null };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timed out after ${timeout} ms waiting for ${label}; saw: ${seen()}`));
        }, timeout);
        waiters.push(w);
      });
    },
  };
  req.on('response', (res) => {
    s.status = res.statusCode; s.headers = res.headers;
    if (res.statusCode !== 200) {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { const e = new Error(`events stream answered ${res.statusCode}: ${body}`); readyReject(e); failWaiters(e); });
      return;
    }
    readyResolve(res.headers);
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      carry += chunk;
      let i;
      while ((i = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, i).trim(); carry = carry.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { failWaiters(new Error(`bad NDJSON line: ${line.slice(0, 200)}`)); continue; }
        events.push(ev);
        for (const w of [...waiters]) {
          if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(ev); }
        }
      }
    });
    res.on('end', () => { closed = true; failWaiters(new Error(`stream ended; saw: ${seen()}`)); });
  });
  req.on('error', (e) => { if (!closed) { closed = true; readyReject(e); failWaiters(e); } });
  req.end();
  STREAMS.add(s);
  return s;
}

/* ---- run helpers ---- */
const isConvId = (id) => /^c[0-9a-z]{8,24}$/.test(String(id));
const isRunId = (id) => /^r[0-9a-z]{6,24}$/.test(String(id));
const isScheduleId = (id) => /^s[0-9a-z]{6,24}$/.test(String(id));
const isRequestId = (id) => /^q[0-9a-z]{6,24}$/.test(String(id));

async function newConversation(port, title) {
  const r = await api(port, 'POST', '/api/conversations', title ? { title } : {});
  assert.equal(r.status, 200, `create conversation: ${r.text}`);
  assert.ok(isConvId(r.body.id), `conversation id shape: ${r.body.id}`);
  return r.body.id;
}

async function say(port, convId, text) {
  return api(port, 'POST', `/api/conversations/${convId}/say`, { text, tz: TZ });
}

// Wait for this run's `ask` on an OPEN stream, answer it, return both.
async function approveWhenAsked(stream, runId, decision, port = PORT_A) {
  const ask = await stream.waitFor((e) => e.t === 'ask' && e.runId === runId, 10_000, `ask for ${runId}`);
  assert.ok(isRequestId(ask.requestId), `requestId shape: ${ask.requestId}`);
  const res = await api(port, 'POST', '/api/approve', { requestId: ask.requestId, decision });
  assert.equal(res.status, 200, `approve ${decision}: ${res.text}`);
  assert.equal(res.body.ok, true);
  return { ask, res };
}

const runEvents = (stream, runId) => stream.events.filter((e) => e.runId === runId);
const firstOf = (evs, t) => evs.find((e) => e.t === t);
// §2.7 transcriptEvent: what the server keeps once a run is over (deltas/thinking/progress/ping are not).
const TRANSCRIPT = new Set(['user', 'text_final', 'tool', 'tool_result', 'ask', 'ask_resolved', 'notify', 'system', 'result', 'error', 'run_start', 'run_end', 'init']);

// Best-effort cleanup so a failed test never leaves a blocked run that cascades into the next ones.
async function stopQuiet(port, convId) {
  try { await api(port, 'POST', '/api/stop', { conversationId: convId }); } catch { /* server may be gone */ }
}

// say → (answer the ask) → run_end, with the stream opened BEFORE the say so no
// delta is missed. Returns the run's events.
async function runPrompt(port, convId, text, { decision = null } = {}) {
  const s = openStream(port, convId, 0);
  let done = false;
  try {
    await s.ready;
    const r = await say(port, convId, text);
    assert.equal(r.status, 200, `say: ${r.text}`);
    assert.ok(isRunId(r.body.runId), `runId shape: ${r.body.runId}`);
    const runId = r.body.runId;
    let ask = null;
    if (decision) ({ ask } = await approveWhenAsked(s, runId, decision, port));
    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 15_000, `run_end of ${runId}`);
    done = true;
    return { runId, ask, end, events: runEvents(s, runId), all: s.events.slice() };
  } finally { s.close(); if (!done) await stopQuiet(port, convId); }
}

/* ---- server children ---- */
function childEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(GENIE_|ANTHROPIC_)/.test(k)) delete env[k];
  return { ...env, HOST: '127.0.0.1', GENIE_KEY: KEY, GENIE_DRIVER: 'rehearsal', ...extra };
}
function boot(port, home, extra = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: childEnv({ PORT: String(port), GENIE_HOME: home, ...extra }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  const keep = (c) => { child.log = (child.log + c).slice(-4000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return child;
}
// Refuse to run against a stale server: every test port must be free before we boot.
async function assertPortFree(port) {
  let answered = false;
  try {
    const r = await fetch(U(port, '/api/health'), { signal: AbortSignal.timeout(500) });
    answered = r.status > 0;
  } catch { /* nothing listening — good */ }
  if (answered) throw new Error(`port ${port} is already in use (a stale genie server? kill it and rerun)`);
}
async function waitHealthy(port, child, label) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`${label} exited early (code ${child.exitCode}):\n${child.log}`);
    try { const r = await fetch(U(port, '/api/health')); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`${label} never answered /api/health:\n${child.log}`);
}
function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
}

const ENV_A = { GENIE_MODE: 'ask', GENIE_ASK_TIMEOUT_MS: '5000', GENIE_SCHEDULER_MS: '500' };
let srvA = null, srvB = null, srvA2 = null;

/* ---- shared state across the ordered tests ---- */
let conv1 = null;            // the ask-mode conversation that collects the allow/deny/always runs
let run1 = null;             // { runId, events, all } of the first full run
let conv1Runs = 0;           // how many runs conv1 has completed
const P_ALWAYS = 'show me the git status of the workspace';
let schedId = null;          // the /schedule'd "every 30m" record
let keptSchedId = null;      // a schedule that must survive the restart
let transcriptBefore = null; // conv1's transcript right before the restart

/* =============================== tests =============================== */

test('health answers without a key and says one is needed', async () => {
  const r = await api(PORT_A, 'GET', '/api/health', undefined, { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.name, 'genie');
  assert.equal(r.body.needsKey, true);
  assert.equal(r.body.version, '1.0.0');
});

test('auth: status without a key, with a wrong key, or with a same-length wrong key → 401; ?key= works', async () => {
  const none = await api(PORT_A, 'GET', '/api/status', undefined, { auth: false });
  assert.equal(none.status, 401);
  deepEq(none.body, { error: 'unauthorized' });
  const wrong = await api(PORT_A, 'GET', '/api/status', undefined, { auth: false, headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
  const sameLen = await api(PORT_A, 'GET', '/api/status', undefined, { auth: false, headers: { authorization: `Bearer ${'x'.repeat(KEY.length)}` } });
  assert.equal(sameLen.status, 401);
  const q = await api(PORT_A, 'GET', `/api/status?key=${KEY}`, undefined, { auth: false });
  assert.equal(q.status, 200, `?key= must authenticate: ${q.text}`);
  const post = await api(PORT_A, 'POST', '/api/conversations', {}, { auth: false });
  assert.equal(post.status, 401, 'writes need the key too');
});

test('status with the key: rehearsal driver, not live, mode ask, catalogue attached', async () => {
  const r = await api(PORT_A, 'GET', '/api/status');
  assert.equal(r.status, 200, r.text);
  const s = r.body;
  assert.equal(s.ok, true);
  assert.equal(s.driver, 'rehearsal');
  assert.equal(s.live, false);
  assert.equal(s.mode, 'ask');
  assert.equal(s.busy, false);
  assert.equal(s.version, '1.0.0');
  assert.equal(s.memoryCount, 0);
  assert.equal(s.schedules, 0);
  assert.equal(typeof s.cwd, 'string');
  assert.equal(typeof s.sdk, 'object');
  deepEq(Object.keys(s.modes), ['ask', 'trust', 'auto']);
  deepEq(s.models.map((m) => m.id), ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5']);
  assert.ok(s.efforts.includes('high'));
  assert.ok(existsSync(join(HOME_A, 'workspace')), 'GENIE_HOME/workspace is created at boot');
});

test('static: / serves the console (loads GenieEngine) and /engine.js is served, no key needed', async () => {
  const page = await fetch(U(PORT_A, '/'));
  assert.equal(page.status, 200);
  assert.ok((page.headers.get('content-type') || '').includes('text/html'));
  assert.ok((await page.text()).includes('GenieEngine'), 'the page loads the engine');
  const eng = await fetch(U(PORT_A, '/engine.js'));
  assert.equal(eng.status, 200);
  assert.ok((eng.headers.get('content-type') || '').includes('javascript'));
  assert.ok((await eng.text()).includes('GenieEngine'));
  for (const p of ['/manifest.json', '/sw.js', '/icon.svg']) {
    assert.equal((await fetch(U(PORT_A, p))).status, 200, `${p} is on the allowlist`);
  }
});

test('static: traversal never escapes genie/, non-allowlisted files and unknown paths 404', async () => {
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%5cpackage.json', '/engine.js/../../package.json', '/%2e%2e%2fpackage.json']) {
    const t = await rawGet(PORT_A, path);
    assert.notEqual(t.status, 200, `${path} must not be served`);
    assert.ok(!t.body.includes('ballrzapp-prototypes'), `${path} must not leak the root package.json`);
  }
  for (const p of ['/nope.js', '/README.md', '/server.mjs', '/agent.mjs', '/package.json', '/index.htm']) {
    assert.equal((await fetch(U(PORT_A, p))).status, 404, `${p} must 404`);
  }
});

test('create a conversation → { id } in the conversation-id shape, listed as idle', async () => {
  conv1 = await newConversation(PORT_A);
  const list = await api(PORT_A, 'GET', '/api/conversations');
  assert.equal(list.status, 200);
  const me = list.body.conversations.find((c) => c.id === conv1);
  assert.ok(me, 'the new conversation is listed');
  assert.equal(me.runs, 0);
  assert.equal(me.status, 'idle');
  assert.equal(me.source, 'user');
});

test('a full ask-mode run: exact event order, the ask names Bash/exec, approving from a second request unblocks it', async () => {
  assert.ok(conv1, 'needs the conversation from the earlier test');
  const s = openStream(PORT_A, conv1, 0);
  let done = false;
  try {
    const headers = await s.ready;
    assert.ok((headers['content-type'] || '').includes('application/x-ndjson'), `content-type: ${headers['content-type']}`);
    assert.equal(headers['cache-control'], 'no-store');

    const r = await say(PORT_A, conv1, 'list the files in the workspace and tell me what is there');
    assert.equal(r.status, 200, r.text);
    assert.ok(isRunId(r.body.runId), `runId shape: ${r.body.runId}`);
    const runId = r.body.runId;

    // The server blocks the run on the approval: answer it while the stream is open.
    const { ask } = await approveWhenAsked(s, runId, 'allow');
    assert.equal(ask.name, 'Bash');
    assert.equal(ask.level, 'exec');
    assert.equal(typeof ask.title, 'string');
    assert.equal(typeof ask.reason, 'string');
    assert.equal(typeof ask.summary, 'string');
    assert.ok(/^echo /.test(ask.input.command), `the rehearsal tool is an echo: ${ask.input.command}`);
    assert.equal(ask.toolId, firstOf(runEvents(s, runId), 'tool').id, 'ask.toolId points at the tool card');

    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 15_000, 'run_end');
    done = true;
    const evs = runEvents(s, runId);
    const order = evs.map((e) => e.t);

    // Every listed type appears, and their first occurrences are in this order.
    const expected = ['run_start', 'user', 'init', 'text', 'text_final', 'tool', 'ask', 'ask_resolved', 'tool_result', 'result', 'run_end'];
    let last = -1;
    for (const t of expected) {
      const i = order.indexOf(t);
      assert.ok(i >= 0, `missing ${t} in [${order.join(', ')}]`);
      assert.ok(i > last, `${t} out of order in [${order.join(', ')}]`);
      last = i;
    }
    assert.ok(order.filter((t) => t === 'text').length >= 1, 'at least one streamed text delta');
    assert.equal(order[0], 'run_start');
    assert.equal(order[order.length - 1], 'run_end');
    for (const e of evs) {
      assert.equal(typeof e.seq, 'number', `${e.t} carries seq`);
      assert.equal(typeof e.at, 'number', `${e.t} carries at`);
    }
    for (let i = 1; i < s.events.length; i++) {
      if (s.events[i].t === 'ping') continue;
      assert.ok(s.events[i].seq > s.events[i - 1].seq, 'seq is strictly increasing on the stream');
    }

    const start = firstOf(evs, 'run_start');
    assert.equal(start.source, 'user');
    assert.equal(start.prompt, 'list the files in the workspace and tell me what is there');
    assert.equal(firstOf(evs, 'user').text, start.prompt);
    const init = firstOf(evs, 'init');
    assert.equal(init.permissionMode, 'default', 'ask mode runs the SDK in its default permission mode');
    assert.equal(init.model, 'rehearsal');
    assert.ok(Array.isArray(init.tools) && init.tools.includes('Bash'));
    assert.ok(/^rehearsal-/.test(init.sessionId), `rehearsal session id: ${init.sessionId}`);
    const tool = firstOf(evs, 'tool');
    assert.equal(tool.name, 'Bash');
    assert.equal(typeof tool.id, 'string');
    assert.equal(typeof tool.summary, 'string');
    assert.ok(tool.parent == null, 'top-level tool has no parent');
    const resolved = firstOf(evs, 'ask_resolved');
    assert.equal(resolved.requestId, ask.requestId);
    assert.equal(resolved.decision, 'allow');
    assert.equal(resolved.by, 'user');
    const tr = firstOf(evs, 'tool_result');
    assert.equal(tr.id, tool.id);
    assert.equal(tr.isError, false);
    assert.equal(typeof tr.output, 'string');
    const result = firstOf(evs, 'result');
    assert.equal(result.ok, true);
    assert.equal(result.cost, 0);
    assert.equal(result.subtype, 'success');
    assert.equal(end.status, 'done');
    assert.equal(end.cost, 0);
    run1 = { runId, events: evs, all: s.events.slice() };
    conv1Runs++;
  } finally { s.close(); if (!done) await stopQuiet(PORT_A, conv1); }
});

test('streamed text deltas concatenate to the first text_final (the UI replaces one with the other)', () => {
  assert.ok(run1, 'needs the first run');
  const deltas = run1.events.filter((e) => e.t === 'text' && e.parent == null).map((e) => e.text).join('');
  const final = run1.events.find((e) => e.t === 'text_final' && e.parent == null);
  assert.ok(final && typeof final.text === 'string' && final.text.length > 0);
  assert.equal(typeof final.msgId, 'string');
  assert.equal(deltas, final.text);
  assert.ok(/rehearsal/i.test(final.text), 'the rehearsal says so');
});

test('events?since=N replays exactly the stored events with seq > N (deltas of a finished run are gone)', async () => {
  assert.ok(run1, 'needs the first run');
  const initEv = run1.events.find((e) => e.t === 'init');
  const N = initEv.seq;
  // Once the run is over only transcript events remain (the text deltas were live-only).
  const expected = run1.all.filter((e) => e.seq > N && TRANSCRIPT.has(e.t)).map((e) => [e.seq, e.t]);
  assert.ok(expected.length >= 6 && run1.all.some((e) => e.seq > N && e.t === 'text'), 'the run had deltas after N to drop');
  const s = openStream(PORT_A, conv1, N);
  try {
    await s.waitFor((e) => e.t === 'run_end' && e.runId === run1.runId, 5000, 'replayed run_end');
    const got = s.events.filter((e) => e.t !== 'ping').map((e) => [e.seq, e.t]);
    deepEq(got, expected, 'replay = stored transcript events after N, in order, nothing at or below N');
    assert.ok(!got.some(([, t]) => t === 'text'), 'no text deltas after the run ended');
  } finally { s.close(); }
});

test('the conversation list shows runs:1 and cost 0 after the run', async () => {
  const list = await api(PORT_A, 'GET', '/api/conversations');
  const me = list.body.conversations.find((c) => c.id === conv1);
  assert.ok(me);
  assert.equal(me.runs, 1);
  assert.equal(me.cost, 0);
  assert.equal(me.status, 'idle');
  assert.ok(typeof me.title === 'string' && me.title.length > 0);
});

test('transcript: text_final is stored, text deltas are not; the file on disk matches', async () => {
  const r = await api(PORT_A, 'GET', `/api/conversations/${conv1}`);
  assert.equal(r.status, 200, r.text);
  const { meta, events } = r.body;
  assert.equal(meta.id, conv1);
  assert.equal(meta.runs, 1);
  const types = new Set(events.map((e) => e.t));
  for (const t of ['run_start', 'user', 'init', 'text_final', 'tool', 'ask', 'ask_resolved', 'tool_result', 'result', 'run_end']) {
    assert.ok(types.has(t), `${t} is persisted`);
  }
  for (const t of ['text', 'thinking', 'progress', 'ping']) assert.ok(!types.has(t), `${t} is NOT persisted`);
  const file = join(HOME_A, 'conversations', `${conv1}.json`);
  const disk = await until(() => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  }, { label: `${file} to be written` });
  assert.equal(disk.meta.id, conv1);
  assert.ok(Array.isArray(disk.events));
  assert.ok(disk.events.some((e) => e.t === 'text_final'));
  assert.ok(!disk.events.some((e) => e.t === 'text'));
});

test('deny: the tool_result comes back isError:true and the run still ends', async () => {
  const { ask, end, events } = await runPrompt(PORT_A, conv1, 'count the lines in every file here', { decision: 'deny' });
  assert.equal(ask.name, 'Bash');
  const resolved = firstOf(events, 'ask_resolved');
  assert.equal(resolved.decision, 'deny');
  assert.equal(resolved.by, 'user');
  const tr = firstOf(events, 'tool_result');
  assert.ok(tr, 'a tool_result is still emitted');
  assert.equal(tr.isError, true);
  assert.ok(firstOf(events, 'result'), 'the run still produces a result');
  assert.ok(['done', 'failed'].includes(end.status));
  conv1Runs++;
});

test('always: the rule Bash:echo … lands in settings, and the same prompt no longer asks', async () => {
  const { events } = await runPrompt(PORT_A, conv1, P_ALWAYS, { decision: 'always' });
  assert.equal(firstOf(events, 'ask_resolved').decision, 'always');
  assert.equal(firstOf(events, 'tool_result').isError, false);
  conv1Runs++;
  const st = await api(PORT_A, 'GET', '/api/settings');
  assert.equal(st.status, 200, st.text);
  const rules = st.body.rules;
  assert.ok(Array.isArray(rules) && rules.length >= 1, `rules: ${JSON.stringify(rules)}`);
  const rule = rules.find((r) => r.tool === 'Bash' && r.behavior === 'allow' && /^echo /.test(String(r.match)));
  assert.ok(rule, `an allow rule for the echo command: ${JSON.stringify(rules)}`);
  const disk = JSON.parse(readFileSync(join(HOME_A, 'settings.json'), 'utf8'));
  assert.ok((disk.rules || []).some((r) => r.tool === 'Bash' && r.match === rule.match && r.behavior === 'allow'), `settings.json persisted the rule: ${JSON.stringify(disk.rules)}`);
  // The rule matches the exact command, so repeating the prompt is allowed without an ask.
  const again = await runPrompt(PORT_A, conv1, P_ALWAYS);
  assert.ok(!again.events.some((e) => e.t === 'ask'), 'no ask on the second run');
  assert.equal(firstOf(again.events, 'tool_result').isError, false);
  assert.equal(again.end.status, 'done');
  conv1Runs++;
});

test('timeout: an unanswered ask resolves deny with by:timeout after GENIE_ASK_TIMEOUT_MS', async () => {
  const conv = await newConversation(PORT_A, 'timeout');
  const s = openStream(PORT_A, conv, 0);
  try {
    await s.ready;
    const r = await say(PORT_A, conv, 'tell me how big the workspace is');
    assert.equal(r.status, 200, r.text);
    const runId = r.body.runId;
    const ask = await s.waitFor((e) => e.t === 'ask' && e.runId === runId, 10_000, 'ask');
    const t0 = Date.now();
    const resolved = await s.waitFor((e) => e.t === 'ask_resolved' && e.requestId === ask.requestId, 15_000, 'ask_resolved by timeout');
    const waited = Date.now() - t0;
    assert.equal(resolved.by, 'timeout');
    assert.equal(resolved.decision, 'deny');
    assert.ok(waited >= 3500 && waited < 12_000, `resolved after ~5 s, not ${waited} ms`);
    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 10_000, 'run_end');
    assert.ok(['done', 'failed'].includes(end.status));
    assert.equal(firstOf(runEvents(s, runId), 'tool_result').isError, true);
    const late = await api(PORT_A, 'POST', '/api/approve', { requestId: ask.requestId, decision: 'allow' });
    assert.equal(late.status, 404, 'an already-resolved request is 404');
  } finally { s.close(); }
});

test('queue: a second conversation waits behind the active run and gets a system note', async () => {
  const cx = await newConversation(PORT_A, 'queue x');
  const cy = await newConversation(PORT_A, 'queue y');
  const sx = openStream(PORT_A, cx, 0);
  const sy = openStream(PORT_A, cy, 0);
  let done = false;
  try {
    await sx.ready; await sy.ready;
    const rx = await say(PORT_A, cx, 'read the readme in the workspace');
    assert.equal(rx.status, 200, rx.text);
    const runX = rx.body.runId;
    await sx.waitFor((e) => e.t === 'ask' && e.runId === runX, 10_000, 'ask x');
    const ry = await say(PORT_A, cy, 'read the changelog in the workspace');
    assert.equal(ry.status, 200, ry.text);
    const runY = ry.body.runId;
    assert.ok(ry.body.queued, `queued while x is active: ${ry.text}`);
    const note = await sy.waitFor((e) => e.t === 'system' && /queued behind 1 run/.test(e.text), 5000, 'queued note');
    assert.ok(note);
    // The driver has not been started for y: no init (and no ask) until x is out of the way.
    assert.ok(!sy.events.some((e) => e.runId === runY && (e.t === 'init' || e.t === 'ask')), 'y is waiting, not running');
    const status = await api(PORT_A, 'GET', '/api/status');
    assert.equal(status.body.busy, true);
    assert.ok(Number(status.body.queue) >= 1, `queue length reported: ${status.body.queue}`);
    await approveWhenAsked(sx, runX, 'allow');
    const endX = await sx.waitFor((e) => e.t === 'run_end' && e.runId === runX, 10_000, 'run_end x');
    assert.equal(endX.status, 'done');
    const initY = await sy.waitFor((e) => e.t === 'init' && e.runId === runY, 10_000, 'init y');
    assert.ok(initY.seq > 0 && initY.at >= endX.at, 'y only starts after x ended');
    await approveWhenAsked(sy, runY, 'allow');
    const endY = await sy.waitFor((e) => e.t === 'run_end' && e.runId === runY, 10_000, 'run_end y');
    assert.equal(endY.status, 'done');
    done = true;
  } finally {
    sx.close(); sy.close();
    if (!done) { await stopQuiet(PORT_A, cx); await stopQuiet(PORT_A, cy); }
  }
});

test('/remember → the memory API lists the fact, MEMORY.md is written, the conversation gets a system event', async () => {
  const r = await say(PORT_A, conv1, '/remember the cat is called Nimbus');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.handled, true);
  assert.equal(typeof r.body.reply, 'string');
  const mem = await api(PORT_A, 'GET', '/api/memory');
  assert.equal(mem.status, 200);
  assert.ok(mem.body.items.some((i) => i.fact === 'the cat is called Nimbus'), JSON.stringify(mem.body.items));
  const item = mem.body.items.find((i) => i.fact === 'the cat is called Nimbus');
  assert.equal(item.n, 1);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(item.date), `date stamp: ${item.date}`);
  assert.ok(mem.body.text.includes('- [') && mem.body.text.includes('Nimbus'));
  assert.ok(readFileSync(join(HOME_A, 'MEMORY.md'), 'utf8').includes('Nimbus'));
  const status = await api(PORT_A, 'GET', '/api/status');
  assert.equal(status.body.memoryCount, 1);
  const tr = await api(PORT_A, 'GET', `/api/conversations/${conv1}`);
  assert.ok(tr.body.events.some((e) => e.t === 'system' && /Nimbus/.test(e.text)), 'a system event tells every client');
});

test('/forget 1 removes it', async () => {
  const r = await say(PORT_A, conv1, '/forget 1');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.handled, true);
  const mem = await api(PORT_A, 'GET', '/api/memory');
  assert.ok(!mem.body.items.some((i) => /Nimbus/.test(i.fact)));
  assert.equal(mem.body.items.length, 0);
});

test('/schedule every 30m ping the build → schedules API: nextRunAt in [now+29m, now+31m], "every 30 min"', async () => {
  const t0 = Date.now();
  const r = await say(PORT_A, conv1, '/schedule every 30m ping the build');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.handled, true);
  const list = await api(PORT_A, 'GET', '/api/schedules');
  assert.equal(list.status, 200);
  const rec = list.body.schedules.find((s) => s.task === 'ping the build');
  assert.ok(rec, JSON.stringify(list.body));
  assert.ok(isScheduleId(rec.id), `schedule id shape: ${rec.id}`);
  assert.equal(rec.description, 'every 30 min');
  assert.equal(rec.enabled, true);
  assert.equal(rec.runs, 0);
  assert.equal(rec.lastRunAt, null);
  assert.equal(rec.schedule.kind, 'every');
  assert.equal(rec.schedule.everyMs, 30 * 60_000);
  assert.ok(rec.nextRunAt >= t0 + 29 * 60_000 && rec.nextRunAt <= Date.now() + 31 * 60_000, `nextRunAt ${rec.nextRunAt} vs now ${t0}`);
  schedId = rec.id;
  assert.ok(existsSync(join(HOME_A, 'schedules.json')));
  const status = await api(PORT_A, 'GET', '/api/status');
  assert.equal(status.body.schedules, 1);
  const ls = await say(PORT_A, conv1, '/schedules');
  assert.equal(ls.body.handled, true);
  assert.ok(/ping the build/.test(ls.body.reply), ls.body.reply);
});

test('POST /api/schedules/:id/run → a source:schedule run in the schedule\'s own conversation', async () => {
  assert.ok(schedId, 'needs the schedule');
  const t0 = Date.now();
  const r = await api(PORT_A, 'POST', `/api/schedules/${schedId}/run`, {});
  assert.equal(r.status, 200, r.text);
  const rec = (await api(PORT_A, 'GET', '/api/schedules')).body.schedules.find((s) => s.id === schedId);
  assert.ok(isConvId(rec.conversationId), `the schedule now owns a conversation: ${rec.conversationId}`);
  assert.equal(rec.runs, 1);
  assert.ok(rec.lastRunAt >= t0 - 1000 && rec.lastRunAt <= Date.now() + 1000);
  assert.ok(rec.nextRunAt >= rec.lastRunAt + 29 * 60_000 && rec.nextRunAt <= rec.lastRunAt + 31 * 60_000, 'nextRunAt recomputed from the run');
  const s = openStream(PORT_A, rec.conversationId, 0);
  let done = false;
  try {
    const start = await s.waitFor((e) => e.t === 'run_start' && e.scheduleId === schedId, 10_000, 'scheduled run_start');
    assert.equal(start.source, 'schedule');
    assert.equal(start.prompt, 'ping the build');
    const runId = start.runId;
    await approveWhenAsked(s, runId, 'allow');
    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 10_000, 'scheduled run_end');
    assert.equal(end.status, 'done');
    done = true;
  } finally { s.close(); if (!done) await stopQuiet(PORT_A, rec.conversationId); }
  const conv = (await api(PORT_A, 'GET', '/api/conversations')).body.conversations.find((c) => c.id === rec.conversationId);
  assert.ok(conv, 'the scheduled conversation is listed');
  assert.equal(conv.source, 'schedule');
  assert.ok(conv.title.startsWith('⏰'), `title: ${conv.title}`);
  assert.equal(conv.runs, 1);
});

test('PATCH enabled:false pauses the schedule, DELETE removes it (twice → 404)', async () => {
  const off = await api(PORT_A, 'PATCH', `/api/schedules/${schedId}`, { enabled: false });
  assert.equal(off.status, 200, off.text);
  let rec = (await api(PORT_A, 'GET', '/api/schedules')).body.schedules.find((s) => s.id === schedId);
  assert.equal(rec.enabled, false);
  const on = await api(PORT_A, 'PATCH', `/api/schedules/${schedId}`, { enabled: true });
  assert.equal(on.status, 200);
  rec = (await api(PORT_A, 'GET', '/api/schedules')).body.schedules.find((s) => s.id === schedId);
  assert.equal(rec.enabled, true);
  const del = await api(PORT_A, 'DELETE', `/api/schedules/${schedId}`);
  assert.equal(del.status, 200, del.text);
  assert.ok(!(await api(PORT_A, 'GET', '/api/schedules')).body.schedules.some((s) => s.id === schedId));
  assert.equal((await api(PORT_A, 'DELETE', `/api/schedules/${schedId}`)).status, 404);
});

test('POST /api/schedules accepts the grammar (weekdays at 08:30) and rejects nonsense with 400', async () => {
  const bad = await api(PORT_A, 'POST', '/api/schedules', { when: 'whenever you feel like it', task: 'x', tz: TZ });
  assert.equal(bad.status, 400, bad.text);
  const r = await api(PORT_A, 'POST', '/api/schedules', { when: 'weekdays at 08:30', task: 'run the tests and report', tz: TZ });
  assert.equal(r.status, 200, r.text);
  const rec = (await api(PORT_A, 'GET', '/api/schedules')).body.schedules.find((s) => s.task === 'run the tests and report');
  assert.ok(rec, 'listed');
  assert.equal(rec.description, 'weekdays at 08:30');
  assert.equal(rec.schedule.kind, 'daily');
  deepEq(rec.schedule.days, [1, 2, 3, 4, 5]);
  assert.equal(rec.schedule.tzOffsetMin, TZ);
  assert.ok(rec.nextRunAt > Date.now(), 'next run is in the future');
  keptSchedId = rec.id;
});

test('custom command: GENIE_HOME/commands/<name>.md is listed and /name args runs as a prompt', async () => {
  mkdirSync(join(HOME_A, 'commands'), { recursive: true });
  writeFileSync(join(HOME_A, 'commands', 'greet.md'), '# say hello to someone\nSay hello to $ARGUMENTS and nothing else.\n');
  const cmds = await api(PORT_A, 'GET', '/api/commands');
  assert.equal(cmds.status, 200);
  const me = cmds.body.commands.find((c) => c.name === 'greet');
  assert.ok(me, JSON.stringify(cmds.body));
  assert.equal(me.description, 'say hello to someone');
  const s = openStream(PORT_A, conv1, 0);
  let done = false;
  try {
    await s.ready;
    const r = await say(PORT_A, conv1, '/greet the world');
    assert.equal(r.status, 200, r.text);
    assert.ok(isRunId(r.body.runId), `a custom command runs: ${r.text}`);
    const runId = r.body.runId;
    const start = await s.waitFor((e) => e.t === 'run_start' && e.runId === runId, 5000, 'run_start');
    assert.equal(start.source, 'command');
    assert.ok(/the world/.test(start.prompt), `expanded prompt: ${start.prompt}`);
    await approveWhenAsked(s, runId, 'allow');
    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 10_000, 'run_end');
    assert.equal(end.status, 'done');
    done = true;
    conv1Runs++;
  } finally { s.close(); if (!done) await stopQuiet(PORT_A, conv1); }
});

test('/mode trust switches the setting and posts a system event; /help, /status, /new and /nonsense are handled', async () => {
  const r = await say(PORT_A, conv1, '/mode trust');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.handled, true);
  assert.equal((await api(PORT_A, 'GET', '/api/settings')).body.mode, 'trust');
  assert.equal((await api(PORT_A, 'GET', '/api/status')).body.mode, 'trust');
  const tr = await api(PORT_A, 'GET', `/api/conversations/${conv1}`);
  assert.ok(tr.body.events.some((e) => e.t === 'system' && /trust/.test(e.text)), 'a system event announces the mode');

  const help = await say(PORT_A, conv1, '/help');
  assert.equal(help.body.handled, true);
  assert.ok(/\/(remember|schedule|mode)/.test(help.body.reply), help.body.reply);

  const st = await say(PORT_A, conv1, '/status');
  assert.equal(st.body.handled, true);
  assert.equal(typeof st.body.reply, 'string');

  const nu = await say(PORT_A, conv1, '/new');
  assert.equal(nu.body.handled, true);
  assert.ok(isConvId(nu.body.conversationId), `/new returns the new id: ${nu.text}`);
  assert.ok((await api(PORT_A, 'GET', '/api/conversations')).body.conversations.some((c) => c.id === nu.body.conversationId));

  const no = await say(PORT_A, conv1, '/nonsense');
  assert.equal(no.status, 200, no.text);
  assert.equal(no.body.handled, true);
  assert.ok(/unknown/i.test(no.body.reply), no.body.reply);

  // Back to ask so the remaining tests can rely on the approval pause.
  const back = await api(PORT_A, 'PATCH', '/api/settings', { mode: 'ask' });
  assert.equal(back.status, 200, back.text);
  assert.equal((await api(PORT_A, 'GET', '/api/settings')).body.mode, 'ask');
});

test('stop mid-run → run_end.status stopped, pending ask resolved by:stop, conversation idle again', async () => {
  const conv = await newConversation(PORT_A, 'stop me');
  const s = openStream(PORT_A, conv, 0);
  try {
    await s.ready;
    const r = await say(PORT_A, conv, 'summarise the workspace for me');
    assert.equal(r.status, 200, r.text);
    const runId = r.body.runId;
    await s.waitFor((e) => e.t === 'run_start' && e.runId === runId, 5000, 'run_start');
    const st = await api(PORT_A, 'POST', '/api/stop', { conversationId: conv });
    assert.equal(st.status, 200, st.text);
    assert.equal(st.body.ok, true);
    assert.equal(st.body.stopped, true);
    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 10_000, 'run_end');
    assert.equal(end.status, 'stopped');
    const resolved = runEvents(s, runId).find((e) => e.t === 'ask_resolved');
    if (resolved) { assert.equal(resolved.by, 'stop'); assert.equal(resolved.decision, 'deny'); }
    const again = await api(PORT_A, 'POST', '/api/stop', { conversationId: conv });
    assert.equal(again.body.stopped, false, 'nothing left to stop');
    await until(async () => (await api(PORT_A, 'GET', '/api/conversations')).body.conversations.find((c) => c.id === conv)?.status === 'idle', { label: 'idle after stop' });
  } finally { s.close(); }
});

test('409: saying while a run is active in the same conversation, and deleting it, are refused', async () => {
  const conv = await newConversation(PORT_A, 'busy');
  const s = openStream(PORT_A, conv, 0);
  let done = false;
  try {
    await s.ready;
    const r = await say(PORT_A, conv, 'check the disk space');
    assert.equal(r.status, 200, r.text);
    const runId = r.body.runId;
    await s.waitFor((e) => e.t === 'ask' && e.runId === runId, 10_000, 'ask');
    const dup = await say(PORT_A, conv, 'and also the memory');
    assert.equal(dup.status, 409, dup.text);
    const del = await api(PORT_A, 'DELETE', `/api/conversations/${conv}`);
    assert.equal(del.status, 409, del.text);
    await approveWhenAsked(s, runId, 'allow');
    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 10_000, 'run_end');
    assert.equal(end.status, 'done');
    done = true;
  } finally { s.close(); if (!done) await stopQuiet(PORT_A, conv); }
  const del = await api(PORT_A, 'DELETE', `/api/conversations/${conv}`);
  assert.equal(del.status, 200, 'deletable once idle');
  assert.equal((await api(PORT_A, 'GET', `/api/conversations/${conv}`)).status, 404);
});

test('an oversized body gets a readable 413', async () => {
  const r = await api(PORT_A, 'POST', `/api/conversations/${conv1}/say`, { text: 'x'.repeat(300_000) });
  assert.equal(r.status, 413, r.text);
  assert.ok(r.body && typeof r.body.error === 'string');
});

test('400s: an invalid mode, a missing cwd, an empty prompt, bad JSON; 404 for an unknown approval', async () => {
  const mode = await api(PORT_A, 'PATCH', '/api/settings', { mode: 'yolo' });
  assert.equal(mode.status, 400, mode.text);
  assert.ok(typeof mode.body.error === 'string');
  const cwd = await api(PORT_A, 'PATCH', '/api/settings', { cwd: join(HOME_A, 'definitely-not-here') });
  assert.equal(cwd.status, 400, cwd.text);
  assert.equal((await api(PORT_A, 'GET', '/api/settings')).body.mode, 'ask', 'nothing changed');
  const empty = await say(PORT_A, conv1, '   ');
  assert.equal(empty.status, 400, empty.text);
  const badJson = await api(PORT_A, 'POST', `/api/conversations/${conv1}/say`, '{not json');
  assert.equal(badJson.status, 400, badJson.text);
  const nope = await api(PORT_A, 'POST', '/api/approve', { requestId: 'q0000000000', decision: 'allow' });
  assert.equal(nope.status, 404, nope.text);
  const badConv = await api(PORT_A, 'GET', '/api/conversations/cdoesnotexist1');
  assert.equal(badConv.status, 404, badConv.text);
});

test('auto mode (server B): a full run has NO ask and init.permissionMode is bypassPermissions', async () => {
  const st = await api(PORT_B, 'GET', '/api/status');
  assert.equal(st.status, 200, st.text);
  assert.equal(st.body.mode, 'auto');
  assert.equal(st.body.driver, 'rehearsal');
  const conv = await newConversation(PORT_B, 'auto');
  const { events, end } = await runPrompt(PORT_B, conv, 'clean up the temp files in the workspace');
  const order = events.map((e) => e.t);
  assert.ok(!order.includes('ask'), `no ask in auto mode: [${order.join(', ')}]`);
  assert.ok(!order.includes('ask_resolved'));
  for (const t of ['run_start', 'user', 'init', 'text_final', 'tool', 'tool_result', 'result', 'run_end']) assert.ok(order.includes(t), `${t} present`);
  assert.equal(firstOf(events, 'init').permissionMode, 'bypassPermissions');
  assert.equal(firstOf(events, 'tool_result').isError, false);
  assert.equal(firstOf(events, 'result').ok, true);
  assert.equal(end.status, 'done');
  assert.equal((await api(PORT_B, 'GET', '/api/status')).body.busy, false);
});

test('restart A on the same GENIE_HOME: conversations, transcript, memory, schedules and rules persist', async () => {
  const dog = await api(PORT_A, 'POST', '/api/memory', { fact: 'the dog is called Biscuit' });
  assert.equal(dog.status, 200, dog.text);
  transcriptBefore = (await api(PORT_A, 'GET', `/api/conversations/${conv1}`)).body;
  const listBefore = (await api(PORT_A, 'GET', '/api/conversations')).body.conversations;
  assert.ok(transcriptBefore.events.length > 10);
  assert.equal(transcriptBefore.meta.runs, conv1Runs);

  await stopChild(srvA);
  assert.notEqual(srvA.exitCode, null, 'A exited on SIGTERM');
  srvA2 = boot(PORT_A2, HOME_A, ENV_A);
  await waitHealthy(PORT_A2, srvA2, 'server A (restarted)');

  const list = (await api(PORT_A2, 'GET', '/api/conversations')).body.conversations;
  deepEq(list.map((c) => c.id).sort(), listBefore.map((c) => c.id).sort(), 'the same conversations are back');
  const me = list.find((c) => c.id === conv1);
  assert.equal(me.runs, conv1Runs);
  assert.equal(me.title, listBefore.find((c) => c.id === conv1).title);

  const after = (await api(PORT_A2, 'GET', `/api/conversations/${conv1}`)).body;
  deepEq(after.events.map((e) => [e.seq, e.t]), transcriptBefore.events.map((e) => [e.seq, e.t]), 'the transcript is intact');
  deepEq(after.events, transcriptBefore.events, 'event for event');
  assert.equal(after.meta.runs, conv1Runs);
  assert.equal(after.meta.sessionId, transcriptBefore.meta.sessionId);

  const mem = await api(PORT_A2, 'GET', '/api/memory');
  assert.ok(mem.body.items.some((i) => i.fact === 'the dog is called Biscuit'), JSON.stringify(mem.body.items));
  assert.ok(!mem.body.items.some((i) => /Nimbus/.test(i.fact)), 'the forgotten fact stays forgotten');

  const sched = (await api(PORT_A2, 'GET', '/api/schedules')).body.schedules;
  const kept = sched.find((s) => s.id === keptSchedId);
  assert.ok(kept, 'the weekdays schedule survived');
  assert.equal(kept.description, 'weekdays at 08:30');
  assert.ok(!sched.some((s) => s.id === schedId), 'the deleted one stays deleted');

  const rules = (await api(PORT_A2, 'GET', '/api/settings')).body.rules;
  assert.ok(rules.some((r) => r.tool === 'Bash' && /^echo /.test(String(r.match))), 'the always-rule survived');
});

test('after the restart the persisted conversation still runs (and the transcript keeps growing)', async () => {
  const { events, end } = await runPrompt(PORT_A2, conv1, 'what did we do so far', { decision: 'allow' });
  assert.equal(end.status, 'done');
  assert.equal(firstOf(events, 'tool_result').isError, false);
  conv1Runs++;
  const seqBefore = transcriptBefore.events[transcriptBefore.events.length - 1].seq;
  assert.ok(events.every((e) => e.seq > seqBefore), 'seq continues from the persisted transcript');
  const after = (await api(PORT_A2, 'GET', `/api/conversations/${conv1}`)).body;
  assert.equal(after.meta.runs, conv1Runs);
  assert.ok(after.events.length > transcriptBefore.events.length);
});

/* ---- boot both servers, run, tear down ---- */
const t0 = Date.now();
try {
  await Promise.all([PORT_A, PORT_B, PORT_A2].map(assertPortFree));
  srvA = boot(PORT_A, HOME_A, ENV_A);
  srvB = boot(PORT_B, HOME_B, { GENIE_MODE: 'auto', GENIE_SCHEDULER_MS: '500' });
  await waitHealthy(PORT_A, srvA, 'server A');
  await waitHealthy(PORT_B, srvB, 'server B');
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) {
      console.error(`  ✗ ${name}\n    ${err.message}`);
      process.exitCode = 1;
    }
  }
} catch (err) {
  console.error(`boot failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  for (const s of STREAMS) { try { s.close(); } catch { /* fine */ } }
  await Promise.all([stopChild(srvA), stopChild(srvB), stopChild(srvA2)]);
  if (process.exitCode) {
    for (const [label, c] of [['A', srvA], ['B', srvB], ["A'", srvA2]]) {
      if (c && c.log.trim()) console.error(`\n--- server ${label} log tail ---\n${c.log.trim()}`);
    }
  }
  for (const dir of [HOME_A, HOME_B]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } }
}
console.log(`\ngenie server: ${passed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (passed !== tests.length) process.exit(1);

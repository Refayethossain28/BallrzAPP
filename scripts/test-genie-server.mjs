#!/usr/bin/env node
/**
 * Integration tests for genie/server.mjs — spawns the REAL console server in
 * rehearsal mode (GENIE_DRIVER=rehearsal: no SDK, no credentials, nothing is
 * executed) against throwaway GENIE_HOME directories, then asserts over real
 * HTTP: bearer auth, CORS for a listed origin (on the API and on the event
 * stream), the static allowlist with its traversal guard, a full ask-mode run
 * read from the NDJSON event stream (exact event order, the approval
 * round-trip answered while the stream is open, allow / deny / always /
 * timeout), the exact-rule guarantee behind "Always allow" and the rule
 * precedence a user can write through the API, the agent's own questions
 * (AskUserQuestion) answered from the phone in ask AND auto mode, transcript
 * persistence rules, slash commands, the schedules API including run-now, a
 * due `every` order re-arming from its due time rather than the tick, cron
 * with a Quartz `?`, the global run queue, stop, 409/413/400, an auto-mode
 * server that never asks for permission, a restart with the same home, and a
 * run cut off by a hard crash being closed at the next boot — also when the
 * run outgrew the stored transcript and its run_start is no longer on disk.
 *
 * Server A: 8801 (mode ask, 5 s ask timeout, two CORS origins)   Server B: 8802 (mode auto)
 * Server A': 8803 (A restarted on the same GENIE_HOME — persistence check)
 * Server C: 8804 (booted twice on a home holding two overlong crashed runs — reconciliation check)
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
const PORT_A = 8801, PORT_B = 8802, PORT_A2 = 8803, PORT_C = 8804;
const KEY = 'test-key-not-real';
const HOME_A = mkdtempSync(join(tmpdir(), 'genie-test-a-'));
const HOME_B = mkdtempSync(join(tmpdir(), 'genie-test-b-'));
const HOME_C = mkdtempSync(join(tmpdir(), 'genie-test-c-'));
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

// Raw request: the path is NOT client-normalized (traversal must reach the
// server) and headers go out exactly as given (an Origin the browser would set).
function raw(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const rawGet = (port, path) => raw(port, path);

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
function openStream(port, convId, since = 0, headers = {}) {
  const events = [];
  const waiters = [];
  let closed = false, carry = '';
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  const req = http.request({
    host: '127.0.0.1', port, method: 'GET',
    path: `/api/conversations/${convId}/events?since=${since}`,
    headers: { authorization: `Bearer ${KEY}`, ...headers },
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

// Two exact origins: the hosted console may be served from either of two hosts.
const ORIGINS = ['https://a.example', 'https://b.example'];
const ENV_A = { GENIE_MODE: 'ask', GENIE_ASK_TIMEOUT_MS: '5000', GENIE_SCHEDULER_MS: '500', GENIE_ALLOW_ORIGIN: ORIGINS.join(',') };
let srvA = null, srvB = null, srvA2 = null, srvC = null;

/* ---- shared state across the ordered tests ---- */
let conv1 = null;            // the ask-mode conversation that collects the allow/deny/always runs
let run1 = null;             // { runId, events, all } of the first full run
let conv1Runs = 0;           // how many runs conv1 has completed
const P_ALWAYS = 'show me the git status of the workspace';
const P_QUESTION = 'please ask me which path to take';   // the word "ask" makes the rehearsal ask a question
const QUESTION = 'Which way should the rehearsal go?';   // the one question the rehearsal asks
let schedId = null;          // the /schedule'd "every 30m" record
let keptSchedId = null;      // a schedule that must survive the restart
let transcriptBefore = null; // conv1's transcript right before the restart

// Seeded into HOME_B before B boots: an `every 1 min` order that fell due 10 s
// ago, i.e. late by less than one period. The first scheduler tick fires it;
// what we then read back tells us what the server re-armed it from.
const DRIFT_ID = 'sdrift0001';
const DRIFT_DUE = Date.now() - 10_000;
const DRIFT_PERIOD = 60_000;
// Written into HOME_A between A's exit and A' boot: the transcript a hard
// crash (SIGKILL, OOM, power) leaves behind — a run with an open ask and no
// run_end. Same shape the server writes, ids in the shapes it validates.
const CUT_ID = 'ccutoff00001', CUT_RUN = 'rcutoff01', CUT_REQ = 'qcutoff001', CUT_TOOL = 'toolu_cutoff';
// Planted into HOME_C before C boots: the same crash after a run of 1100 tool
// calls — more than the 2000 transcript events a file keeps. One file holds
// only the run's tail (no run_start, no init); the other has its run_start
// pinned in front of the tail, the way the server writes it.
const LONG_ID = 'clongtail001', LONG_RUN = 'rlongtail1', LONG_REQ = 'qlongtail01';
const PIN_ID = 'clongpinned01', PIN_RUN = 'rlongpin01', PIN_REQ = 'qlongpin001';

// A crashed run of 1100 tool calls as its file holds it: 2205 events with ids
// in the shapes the server validates, ending in a tool still "running" and an
// approval nobody can answer. `stored` is the file's window — the newest 2000
// events, with the run_start pinned in front of them or not.
function plantLongCrashedRun(id, runId, reqId, { pinned }) {
  const at = Date.now() - 60_000;
  const all = [];
  const put = (e) => all.push({ ...e, seq: all.length + 1, at, runId });
  put({ t: 'run_start', prompt: 'read every file', source: 'user' });
  put({ t: 'user', text: 'read every file' });
  put({ t: 'init', sessionId: `rehearsal-${id}`, model: 'rehearsal', tools: ['Read', 'Bash'], cwd: HOME_C, permissionMode: 'default', version: '1.0.0' });
  for (let i = 1; i <= 1100; i++) {
    put({ t: 'tool', id: `toolu_${id}_${i}`, name: 'Read', input: { file_path: `/f/${i}` }, summary: `/f/${i}`, icon: '📄', parent: null });
    put({ t: 'tool_result', toolId: `toolu_${id}_${i}`, output: `file ${i}`, isError: false, parent: null });
  }
  put({ t: 'tool', id: `toolu_${id}_last`, name: 'Bash', input: { command: 'rm -rf build' }, summary: 'rm -rf build', icon: '💻', parent: null });
  put({ t: 'ask', requestId: reqId, toolId: `toolu_${id}_last`, name: 'Bash', kind: 'permission', input: { command: 'rm -rf build' }, summary: 'rm -rf build', title: 'Genie wants to run `rm -rf build`', level: 'exec', reason: 'runs a shell command' });
  const stored = pinned ? [all[0], ...all.slice(-1999)] : all.slice(-2000);
  const file = join(HOME_C, 'conversations', `${id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    meta: { id, title: 'a long one', createdAt: at, updatedAt: at, sessionId: `rehearsal-${id}`, runs: 0, cost: 0, status: 'running', source: 'user', scheduleId: null, seq: all.length },
    events: stored,
  }));
  return { id, runId, reqId, all, stored, file };
}

/* =============================== tests =============================== */

test('health answers without a key and says one is needed', async () => {
  const r = await api(PORT_A, 'GET', '/api/health', undefined, { auth: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.name, 'genie');
  assert.equal(r.body.needsKey, true);
  assert.equal(r.body.version, '1.0.0');
});

test('scheduler (server B): a due `every` order re-arms from the time it was DUE, not from the tick that noticed it', async () => {
  // Seeded 10 s overdue, so B's first 500 ms tick fired it a little late. The
  // lateness must not carry into the next firing (it would compound forever).
  const rec = await until(async () => (await api(PORT_B, 'GET', '/api/schedules')).body.schedules.find((s) => s.id === DRIFT_ID && s.runs >= 1),
    { timeout: 6000, label: 'the seeded schedule to fire' });
  assert.equal(rec.runs, 1);
  assert.equal(rec.description, 'every 1 min');
  assert.ok(rec.lastRunAt > DRIFT_DUE, `the tick came after the due time (${rec.lastRunAt - DRIFT_DUE} ms late)`);
  assert.equal(rec.nextRunAt, DRIFT_DUE + DRIFT_PERIOD, `next = due + period, not tick + period (tick was ${rec.lastRunAt - DRIFT_DUE} ms late)`);
  assert.ok(isConvId(rec.conversationId), `it got its own conversation: ${rec.conversationId}`);
  const s = openStream(PORT_B, rec.conversationId, 0);
  try {
    const end = await s.waitFor((e) => e.t === 'run_end', 10_000, 'the scheduled run_end');
    assert.equal(end.status, 'done', 'auto mode: the run went through without a tap');
    const start = s.events.find((e) => e.t === 'run_start');
    assert.equal(start.source, 'schedule');
    assert.equal(start.scheduleId, DRIFT_ID);
    assert.equal(start.prompt, 'drift probe');
  } finally { s.close(); }
  // Its job is done; it must not fire again while the rest of the suite runs on B.
  assert.equal((await api(PORT_B, 'DELETE', `/api/schedules/${DRIFT_ID}`)).status, 200);
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
  // Root outside a sandbox is reported for the console's benefit, but in
  // rehearsal it never blocks anything (this suite may well run as root).
  assert.equal(typeof s.rootUnsandboxed, 'boolean');
  assert.equal(s.autoBlockedReason, null, 'nothing is blocked in rehearsal');
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

test('CORS: each listed origin is echoed back (API, preflight and the event stream); an unlisted one gets nothing', async () => {
  const auth = { authorization: `Bearer ${KEY}` };
  for (const origin of ORIGINS) {
    const r = await raw(PORT_A, '/api/status', { headers: { ...auth, origin } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], origin, `${origin} gets itself back, not the whole list`);
    assert.ok(/origin/i.test(r.headers.vary || ''), 'vary: origin, so a shared cache keeps the origins apart');
    const pre = await raw(PORT_A, '/api/status', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    assert.equal(pre.status, 204, 'the preflight the Authorization header forces');
    assert.equal(pre.headers['access-control-allow-origin'], origin);
    assert.ok(/authorization/i.test(pre.headers['access-control-allow-headers'] || ''), 'the bearer header is allowed');
  }
  // The stream is what the hosted console lives on; it carries the header too.
  const sb = openStream(PORT_A, conv1, 0, { origin: ORIGINS[1] });
  try { assert.equal((await sb.ready)['access-control-allow-origin'], ORIGINS[1]); } finally { sb.close(); }

  // Not on the list: the API still answers (CORS is the browser's gate, not
  // ours), but without the header the browser will not hand over the response.
  const stranger = 'https://c.example';
  const c = await raw(PORT_A, '/api/status', { headers: { ...auth, origin: stranger } });
  assert.equal(c.status, 200);
  assert.equal(c.headers['access-control-allow-origin'], undefined);
  const preC = await raw(PORT_A, '/api/status', { method: 'OPTIONS', headers: { origin: stranger, 'access-control-request-method': 'GET' } });
  assert.equal(preC.headers['access-control-allow-origin'], undefined);
  const sc = openStream(PORT_A, conv1, 0, { origin: stranger });
  try { assert.equal((await sc.ready)['access-control-allow-origin'], undefined); } finally { sc.close(); }

  // Server B has no GENIE_ALLOW_ORIGIN at all: no CORS headers for anyone, and no preflight route.
  const nb = await raw(PORT_B, '/api/status', { headers: { ...auth, origin: ORIGINS[1] } });
  assert.equal(nb.status, 200);
  assert.equal(nb.headers['access-control-allow-origin'], undefined);
  assert.equal((await raw(PORT_B, '/api/status', { method: 'OPTIONS', headers: { origin: ORIGINS[1] } })).status, 404);
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
    assert.equal(ask.kind, 'permission', 'an ordinary approval card, as opposed to a question');
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

test('always: an EXACT rule for the echo command lands in settings; the same command stops asking, a longer one still asks', async () => {
  const { ask, events } = await runPrompt(PORT_A, conv1, P_ALWAYS, { decision: 'always' });
  assert.equal(firstOf(events, 'ask_resolved').decision, 'always');
  assert.equal(firstOf(events, 'tool_result').isError, false);
  conv1Runs++;
  const command = ask.input.command;
  assert.ok(/^echo "rehearsal: /.test(command), `the rehearsal tool is an echo: ${command}`);
  const st = await api(PORT_A, 'GET', '/api/settings');
  assert.equal(st.status, 200, st.text);
  const rules = st.body.rules;
  assert.ok(Array.isArray(rules) && rules.length >= 1, `rules: ${JSON.stringify(rules)}`);
  // "Always allow" names the one command it was tapped on, in full — never a
  // prefix. (Had the command ended in a bare `*`, the engine would have stored
  // it escaped as `\*`; a rehearsal echo ends in a quote, so this one is stored
  // as-is.) Either way the stored match must not read as a prefix pattern.
  const rule = rules.find((r) => r.tool === 'Bash' && r.behavior === 'allow' && r.match === command);
  assert.ok(rule, `an allow rule naming exactly ${JSON.stringify(command)}: ${JSON.stringify(rules)}`);
  assert.ok(!/[^\\]\*$/.test(rule.match), `a minted rule never ends in a bare *: ${rule.match}`);
  assert.ok(events.some((e) => e.t === 'system' && e.text.includes(`always allow Bash:${command}`)), 'every client is told which rule was added');
  const disk = JSON.parse(readFileSync(join(HOME_A, 'settings.json'), 'utf8'));
  assert.ok((disk.rules || []).some((r) => r.tool === 'Bash' && r.match === rule.match && r.behavior === 'allow'), `settings.json persisted the rule: ${JSON.stringify(disk.rules)}`);
  // The rule matches the exact command, so repeating the prompt is allowed without an ask.
  const again = await runPrompt(PORT_A, conv1, P_ALWAYS);
  assert.ok(!again.events.some((e) => e.t === 'ask'), 'no ask on the second run');
  assert.equal(firstOf(again.events, 'tool_result').isError, false);
  assert.equal(again.end.status, 'done');
  conv1Runs++;
  // Exact means exact: a command that merely STARTS with the allowed one asks again.
  const longer = await runPrompt(PORT_A, conv1, `${P_ALWAYS} please`, { decision: 'deny' });
  assert.ok(longer.ask, 'the longer command is not covered');
  assert.ok(longer.ask.input.command.startsWith(command.slice(0, -1)), `and it does start the same way: ${longer.ask.input.command}`);
  assert.equal(longer.ask.level, 'exec');
  conv1Runs++;
});

test('rules through the API: a prefix rule covers everyday commands but never the destructive check; an exact rule does; deny beats all', async () => {
  const before = (await api(PORT_A, 'GET', '/api/settings')).body.rules;
  const conv = await newConversation(PORT_A, 'rules');
  const risky = 'sudo rm -rf / please'; // its rehearsal echo still reads as destructive to the classifier
  const set = async (rules) => { const r = await api(PORT_A, 'PATCH', '/api/settings', { rules }); assert.equal(r.status, 200, r.text); };
  try {
    // A user-authored prefix rule (a trailing bare `*`) is honoured for ordinary commands…
    await set([{ tool: 'Bash', match: 'echo *', behavior: 'allow' }]);
    const plain = await runPrompt(PORT_A, conv, 'list the files in the workspace');
    assert.ok(!plain.events.some((e) => e.t === 'ask'), 'the prefix rule covers an ordinary echo');
    assert.equal(firstOf(plain.events, 'tool_result').isError, false);
    // …but it never talks the destructive-command check out of asking.
    const danger = await runPrompt(PORT_A, conv, risky, { decision: 'deny' });
    assert.equal(danger.ask.level, 'danger', `a prefix rule does not silence danger: ${JSON.stringify(danger.ask)}`);
    assert.equal(danger.ask.kind, 'permission');
    assert.ok(/⚠️|destructive/i.test(danger.ask.title), danger.ask.title);
    assert.equal(firstOf(danger.events, 'tool_result').isError, true);
    // An exact rule for that very command (what "Always allow" mints) does hold, danger or not.
    const command = danger.ask.input.command;
    await set([{ tool: 'Bash', match: command, behavior: 'allow' }]);
    const exact = await runPrompt(PORT_A, conv, risky);
    assert.ok(!exact.events.some((e) => e.t === 'ask'), 'an exact rule on the full command is honoured even for danger');
    assert.equal(firstOf(exact.events, 'tool_result').isError, false);
    // A deny rule wins over any allow, in ask mode too — no card, the tool just hears no.
    await set([{ tool: 'Bash', match: command, behavior: 'allow' }, { tool: 'Bash', match: '*', behavior: 'deny' }]);
    const denied = await runPrompt(PORT_A, conv, risky);
    assert.ok(!denied.events.some((e) => e.t === 'ask'), 'no card for a rule-denied tool');
    const tr = firstOf(denied.events, 'tool_result');
    assert.equal(tr.isError, true);
    assert.ok(/denied by rule/i.test(tr.output), tr.output);
    assert.ok(['done', 'failed'].includes(denied.end.status));
  } finally { await set(before); }
  deepEq((await api(PORT_A, 'GET', '/api/settings')).body.rules, before, 'the always-rule is back for the tests that follow');
});

test('a question (AskUserQuestion) lands on the phone as a question card in ask mode, and the answer reads back to the tool', async () => {
  const conv = await newConversation(PORT_A, 'question');
  const s = openStream(PORT_A, conv, 0);
  let done = false;
  try {
    await s.ready;
    const r = await say(PORT_A, conv, P_QUESTION);
    assert.equal(r.status, 200, r.text);
    const runId = r.body.runId;
    const q = await s.waitFor((e) => e.t === 'ask' && e.runId === runId, 10_000, 'the question');
    assert.equal(q.kind, 'question');
    assert.equal(q.name, 'AskUserQuestion');
    assert.equal(q.level, 'question');
    assert.equal(q.title, 'Genie has a question for you');
    assert.equal(typeof q.reason, 'string');
    assert.ok(isRequestId(q.requestId));
    assert.ok(Array.isArray(q.questions) && q.questions.length === 1, JSON.stringify(q.questions));
    const [qq] = q.questions;
    assert.equal(qq.question, QUESTION);
    assert.equal(qq.header, 'Path');
    deepEq(qq.options.map((o) => o.label), ['Quick', 'Thorough']);
    assert.ok(qq.options.every((o) => typeof o.description === 'string'));
    assert.equal(qq.multiSelect, false);
    assert.equal(q.summary, QUESTION, 'the summary is the question itself');
    const qTool = firstOf(runEvents(s, runId), 'tool');
    assert.equal(qTool.name, 'AskUserQuestion');
    assert.equal(q.toolId, qTool.id, 'the card sits on the AskUserQuestion tool card');
    assert.equal(qTool.icon, '❓');

    const ans = await api(PORT_A, 'POST', '/api/approve', { requestId: q.requestId, decision: 'allow', answers: { [QUESTION]: 'Quick' } });
    assert.equal(ans.status, 200, ans.text);
    const resolved = await s.waitFor((e) => e.t === 'ask_resolved' && e.requestId === q.requestId, 5000, 'the question resolved');
    assert.equal(resolved.decision, 'allow');
    assert.equal(resolved.by, 'user');
    deepEq(resolved.answers, { [QUESTION]: 'Quick' }, 'ask_resolved carries the answers');
    const tr = await s.waitFor((e) => e.t === 'tool_result' && e.id === q.toolId, 5000, 'the question tool_result');
    assert.equal(tr.isError, false);
    assert.ok(tr.output.includes('Quick') && tr.output.includes(QUESTION), `the tool reads the answer back: ${tr.output}`);

    // The rehearsal's Bash step follows and is an ordinary permission ask — an
    // answered question answers nothing else.
    const perm = await s.waitFor((e) => e.t === 'ask' && e.runId === runId && e.requestId !== q.requestId, 10_000, 'the Bash ask');
    assert.equal(perm.kind, 'permission');
    assert.equal(perm.name, 'Bash');
    assert.equal(perm.level, 'exec');
    assert.equal(perm.questions, undefined, 'a permission ask carries no questions');
    assert.equal((await api(PORT_A, 'POST', '/api/approve', { requestId: perm.requestId, decision: 'allow' })).status, 200);
    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 10_000, 'run_end');
    done = true;
    assert.equal(end.status, 'done');
    const evs = runEvents(s, runId);
    assert.equal(evs.filter((e) => e.t === 'ask').length, 2, 'one question, one permission');
    assert.equal(firstOf(evs, 'result').ok, true);
  } finally { s.close(); if (!done) await stopQuiet(PORT_A, conv); }
  // The transcript keeps the question and what was answered, so history renders the same card.
  const stored = (await api(PORT_A, 'GET', `/api/conversations/${conv}`)).body.events;
  const sq = stored.find((e) => e.t === 'ask' && e.kind === 'question');
  assert.ok(sq && sq.questions[0].question === QUESTION, 'the question is persisted');
  assert.ok(stored.some((e) => e.t === 'ask_resolved' && e.answers && e.answers[QUESTION] === 'Quick'), 'so are the answers');
});

test('declining a question: malformed answers are a 400 and leave it pending; Deny tells the tool the owner declined', async () => {
  const conv = await newConversation(PORT_A, 'declined question');
  const s = openStream(PORT_A, conv, 0);
  let done = false;
  try {
    await s.ready;
    const r = await say(PORT_A, conv, P_QUESTION);
    assert.equal(r.status, 200, r.text);
    const runId = r.body.runId;
    const q = await s.waitFor((e) => e.t === 'ask' && e.runId === runId && e.kind === 'question', 10_000, 'the question');
    const bad = await api(PORT_A, 'POST', '/api/approve', { requestId: q.requestId, decision: 'allow', answers: 'Quick' });
    assert.equal(bad.status, 400, bad.text);
    assert.ok(!s.events.some((e) => e.t === 'ask_resolved' && e.requestId === q.requestId), 'still pending after the bad body');
    const no = await api(PORT_A, 'POST', '/api/approve', { requestId: q.requestId, decision: 'deny' });
    assert.equal(no.status, 200, no.text);
    const resolved = await s.waitFor((e) => e.t === 'ask_resolved' && e.requestId === q.requestId, 5000, 'declined');
    assert.equal(resolved.decision, 'deny');
    assert.equal(resolved.answers, undefined, 'no answers on a decline');
    const tr = await s.waitFor((e) => e.t === 'tool_result' && e.id === q.toolId, 5000, 'the question tool_result');
    assert.equal(tr.isError, true);
    assert.ok(/declined/i.test(tr.output), tr.output);
    // The run carries on to its Bash step regardless.
    const perm = await s.waitFor((e) => e.t === 'ask' && e.runId === runId && e.kind === 'permission', 10_000, 'the Bash ask');
    assert.equal((await api(PORT_A, 'POST', '/api/approve', { requestId: perm.requestId, decision: 'allow' })).status, 200);
    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 10_000, 'run_end');
    done = true;
    assert.equal(end.status, 'done');
  } finally { s.close(); if (!done) await stopQuiet(PORT_A, conv); }
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
  // Run-now comes AHEAD of the due time, so the cadence restarts from this run
  // (spec: afterRun → now + period). Only a DUE firing re-arms from its due
  // time — the scheduler test on B covers that.
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

test('POST /api/schedules: a cron with a Quartz "?" day field is a Saturday-only order (? is a wildcard, not "any day")', async () => {
  const r = await api(PORT_A, 'POST', '/api/schedules', { when: 'cron 0 9 ? * 6', task: 'run the weekly report', tz: TZ });
  assert.equal(r.status, 200, r.text);
  const rec = r.body.schedule;
  assert.ok(isScheduleId(rec.id));
  assert.equal(rec.schedule.kind, 'cron');
  assert.ok(/^cron /.test(rec.description), rec.description);
  const local = new Date(rec.nextRunAt + TZ * 60_000); // wall clock in the request's tz
  assert.equal(local.getUTCDay(), 6, `the next firing is a Saturday in the request's tz, not tomorrow: ${local.toISOString()}`);
  assert.equal(local.getUTCHours(), 9);
  assert.equal(local.getUTCMinutes(), 0);
  assert.ok(rec.nextRunAt > Date.now() && rec.nextRunAt <= Date.now() + 7 * 86_400_000, 'within the week');
  // Written with a * instead, it is the very same order.
  const star = await api(PORT_A, 'POST', '/api/schedules', { when: 'cron 0 9 * * 6', task: 'run the weekly report (control)', tz: TZ });
  assert.equal(star.status, 200, star.text);
  assert.equal(star.body.schedule.nextRunAt, rec.nextRunAt, '? and * agree on the next firing');
  for (const id of [rec.id, star.body.schedule.id]) assert.equal((await api(PORT_A, 'DELETE', `/api/schedules/${id}`)).status, 200);
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
  assert.ok(/rehearsal/.test(st.body.reply) && /mode trust/.test(st.body.reply), st.body.reply);
  assert.ok(/spent \$\d/.test(st.body.reply), `/status shows the spend so far (a $ figure): ${st.body.reply}`);

  // In rehearsal auto is never refused — root or not, nothing runs for real.
  const auto = await api(PORT_A, 'PATCH', '/api/settings', { mode: 'auto' });
  assert.equal(auto.status, 200, auto.text);
  assert.equal((await api(PORT_A, 'GET', '/api/status')).body.mode, 'auto');

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

test('auto mode (server B): a question STILL asks — one ask, kind question, and nothing else waits for a tap', async () => {
  const conv = await newConversation(PORT_B, 'auto question');
  const s = openStream(PORT_B, conv, 0);
  let done = false;
  try {
    await s.ready;
    const r = await say(PORT_B, conv, P_QUESTION);
    assert.equal(r.status, 200, r.text);
    const runId = r.body.runId;
    const q = await s.waitFor((e) => e.t === 'ask' && e.runId === runId, 10_000, 'the question');
    assert.equal(q.kind, 'question');
    assert.equal(q.name, 'AskUserQuestion');
    assert.equal(q.level, 'question');
    deepEq(q.questions[0].options.map((o) => o.label), ['Quick', 'Thorough']);
    const ans = await api(PORT_B, 'POST', '/api/approve', { requestId: q.requestId, decision: 'allow', answers: { [QUESTION]: 'Thorough' } });
    assert.equal(ans.status, 200, ans.text);
    const end = await s.waitFor((e) => e.t === 'run_end' && e.runId === runId, 10_000, 'run_end');
    done = true;
    const evs = runEvents(s, runId);
    assert.equal(evs.filter((e) => e.t === 'ask').length, 1, `the question is the only ask: [${evs.map((e) => e.t).join(', ')}]`);
    assert.equal(firstOf(evs, 'init').permissionMode, 'bypassPermissions');
    const qr = evs.find((e) => e.t === 'tool_result' && e.id === q.toolId);
    assert.ok(qr && qr.isError === false && qr.output.includes('Thorough'), `the answer reached the tool: ${JSON.stringify(qr)}`);
    const bash = evs.find((e) => e.t === 'tool' && e.name === 'Bash');
    const br = evs.find((e) => e.t === 'tool_result' && e.id === bash.id);
    assert.equal(br.isError, false, 'the Bash step ran without asking');
    assert.equal(end.status, 'done');
  } finally { s.close(); if (!done) await stopQuiet(PORT_B, conv); }
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
  // While nothing is running, plant what a hard crash leaves on disk: a run
  // that got as far as its approval card and no further (see the next test).
  const at = Date.now() - 60_000;
  const cut = (n, e) => ({ ...e, seq: n, at, runId: CUT_RUN });
  writeFileSync(join(HOME_A, 'conversations', `${CUT_ID}.json`), JSON.stringify({
    meta: { id: CUT_ID, title: 'cut off', createdAt: at, updatedAt: at, sessionId: null, runs: 0, cost: 0, status: 'running', source: 'user', scheduleId: null, seq: 6 },
    events: [
      cut(1, { t: 'run_start', prompt: 'count the files', source: 'user' }),
      cut(2, { t: 'user', text: 'count the files' }),
      cut(3, { t: 'init', sessionId: 'rehearsal-cutoff', model: 'rehearsal', tools: ['Bash'], cwd: HOME_A, permissionMode: 'default', version: '1.0.0' }),
      cut(4, { t: 'text_final', text: 'On it.', parent: null, msgId: 'msg_cutoff' }),
      cut(5, { t: 'tool', id: CUT_TOOL, name: 'Bash', input: { command: 'ls | wc -l' }, summary: 'ls | wc -l', icon: '💻', parent: null }),
      cut(6, { t: 'ask', requestId: CUT_REQ, toolId: CUT_TOOL, name: 'Bash', kind: 'permission', input: { command: 'ls | wc -l' }, summary: 'ls | wc -l', title: 'Genie wants to run `ls | wc -l`', level: 'exec', reason: 'runs a shell command' }),
    ],
  }));
  srvA2 = boot(PORT_A2, HOME_A, ENV_A);
  await waitHealthy(PORT_A2, srvA2, 'server A (restarted)');

  const list = (await api(PORT_A2, 'GET', '/api/conversations')).body.conversations;
  deepEq(list.map((c) => c.id).sort(), [...listBefore.map((c) => c.id), CUT_ID].sort(), 'the same conversations are back (plus the planted one)');
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

test('a run cut off by a hard crash is closed at boot: its ask resolved by stop, an error and a stopped run_end appended', async () => {
  const { meta, events } = (await api(PORT_A2, 'GET', `/api/conversations/${CUT_ID}`)).body;
  assert.equal(meta.status, 'idle');
  assert.equal(meta.runs, 1, 'the run had started (init), so it counts');
  deepEq(events.slice(0, 6).map((e) => [e.seq, e.t]), [[1, 'run_start'], [2, 'user'], [3, 'init'], [4, 'text_final'], [5, 'tool'], [6, 'ask']], 'what was on disk is untouched');
  deepEq(events.slice(6).map((e) => e.t), ['ask_resolved', 'error', 'run_end'], `closed the way a stop would: [${events.map((e) => e.t).join(', ')}]`);
  const [resolved, error, end] = events.slice(6);
  assert.equal(resolved.requestId, CUT_REQ);
  assert.equal(resolved.decision, 'deny');
  assert.equal(resolved.by, 'stop');
  assert.ok(/restart/i.test(error.message), error.message);
  assert.equal(end.status, 'stopped');
  assert.equal(end.runId, CUT_RUN);
  for (let i = 1; i < events.length; i++) assert.ok(events[i].seq > events[i - 1].seq, 'seq keeps climbing past the planted tail');
  assert.equal(meta.seq, events[events.length - 1].seq, 'meta.seq caught up');
  // The stale card can no longer be answered, and the closure is on disk, not just in memory.
  assert.equal((await api(PORT_A2, 'POST', '/api/approve', { requestId: CUT_REQ, decision: 'allow' })).status, 404);
  const disk = JSON.parse(readFileSync(join(HOME_A, 'conversations', `${CUT_ID}.json`), 'utf8'));
  assert.equal(disk.events[disk.events.length - 1].t, 'run_end');
  assert.equal(disk.meta.runs, 1);
  // And the conversation is simply usable again.
  const { end: again, events: evs } = await runPrompt(PORT_A2, CUT_ID, 'and again', { decision: 'allow' });
  assert.equal(again.status, 'done');
  assert.ok(evs.every((e) => e.seq > end.seq), 'the new run continues the sequence');
  assert.equal((await api(PORT_A2, 'GET', `/api/conversations/${CUT_ID}`)).body.meta.runs, 2);
});

test('a crashed run that outgrew the stored transcript is closed at boot too, once, with or without its run_start on disk', async () => {
  const tail = plantLongCrashedRun(LONG_ID, LONG_RUN, LONG_REQ, { pinned: false });
  const pinned = plantLongCrashedRun(PIN_ID, PIN_RUN, PIN_REQ, { pinned: true });
  assert.equal(tail.stored.length, 2000);
  assert.ok(!tail.stored.some((e) => e.t === 'run_start' || e.t === 'init'), 'the tail file holds neither boundary');
  assert.equal(pinned.stored[0].t, 'run_start');
  assert.ok(!pinned.stored.some((e) => e.t === 'init'), 'the pinned file lost its init all the same');

  // Closed the way a stop would, on top of what was on disk, untouched.
  const expectClosed = async (label, planted) => {
    const { meta, events } = (await api(PORT_C, 'GET', `/api/conversations/${planted.id}`)).body;
    assert.equal(meta.status, 'idle', label);
    assert.equal(meta.runs, 1, `${label}: it had run (tool cards), so it counts`);
    const kept = events.slice(0, -3);
    deepEq(kept.map((e) => [e.seq, e.t]), planted.stored.slice(-kept.length).map((e) => [e.seq, e.t]), `${label}: what was on disk is untouched`);
    deepEq(events.slice(-3).map((e) => e.t), ['ask_resolved', 'error', 'run_end'], `${label}: closed the way a stop would: […${events.slice(-5).map((e) => e.t).join(', ')}]`);
    const [resolved, error, end] = events.slice(-3);
    assert.equal(resolved.requestId, planted.reqId, label);
    assert.equal(resolved.decision, 'deny', label);
    assert.equal(resolved.by, 'stop', label);
    assert.ok(/restart/i.test(error.message), error.message);
    assert.equal(end.status, 'stopped', label);
    assert.equal(end.runId, planted.runId, label);
    assert.equal(events.filter((e) => e.t === 'run_end').length, 1, `${label}: one run_end`);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].seq > events[i - 1].seq, `${label}: seq keeps climbing past the planted tail`);
    assert.equal(end.seq, planted.all.length + 3, `${label}: the closure continues the run's own sequence`);
    assert.equal(meta.seq, end.seq, `${label}: meta.seq caught up`);
    // On disk: still at the cap, one run_end, and the closure is the last word.
    const disk = JSON.parse(readFileSync(planted.file, 'utf8'));
    assert.equal(disk.meta.status, 'idle', label);
    assert.equal(disk.meta.runs, 1, label);
    assert.equal(disk.events.length, 2000, `${label}: the file stays at the cap`);
    assert.equal(disk.events.filter((e) => e.t === 'run_end').length, 1, `${label}: one run_end on disk`);
    assert.equal(disk.events[disk.events.length - 1].seq, end.seq, label);
    return { end, first: disk.events[0] };
  };

  srvC = boot(PORT_C, HOME_C, ENV_A);
  try {
    await waitHealthy(PORT_C, srvC, 'server C');
    await until(() => /cut off by a restart/.test(srvC.log), { label: 'the boot log naming a cut-off run' });
    for (const p of [tail, pinned]) assert.match(srvC.log, new RegExp(`run ${p.runId} in ${p.id} was cut off by a restart`), `${p.id} is named in the boot log`);
    const first = { tail: await expectClosed('first boot (tail)', tail), pinned: await expectClosed('first boot (pinned)', pinned) };
    assert.notEqual(first.tail.first.t, 'run_start', 'a file without a run_start stays the run\'s tail');
    assert.equal(first.pinned.first.t, 'run_start', 'a pinned run_start survives the re-cap after the closure');
    assert.equal(first.pinned.first.seq, 1);
    assert.equal((await api(PORT_C, 'POST', '/api/approve', { requestId: LONG_REQ, decision: 'allow' })).status, 404, 'the stale card cannot be answered');

    // Booting again on the same home finds two closed runs and leaves them be.
    await stopChild(srvC);
    srvC = boot(PORT_C, HOME_C, ENV_A);
    await waitHealthy(PORT_C, srvC, 'server C (rebooted)');
    await until(() => /G E N I E/.test(srvC.log), { label: 'the banner' });
    assert.ok(!/cut off by a restart/.test(srvC.log), `nothing to close the second time:\n${srvC.log}`);
    assert.equal((await expectClosed('second boot (tail)', tail)).end.seq, first.tail.end.seq, 'no second closure');
    assert.equal((await expectClosed('second boot (pinned)', pinned)).end.seq, first.pinned.end.seq, 'no second closure');

    // And the conversation is simply usable again.
    const { end: again, events: evs } = await runPrompt(PORT_C, LONG_ID, 'and again', { decision: 'allow' });
    assert.equal(again.status, 'done');
    assert.ok(evs.every((e) => e.seq > first.tail.end.seq), 'the new run continues the sequence');
    assert.equal((await api(PORT_C, 'GET', `/api/conversations/${LONG_ID}`)).body.meta.runs, 2);
  } finally {
    await stopChild(srvC);
  }
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
  await Promise.all([PORT_A, PORT_B, PORT_A2, PORT_C].map(assertPortFree));
  // B boots with one overdue standing order on disk (see the scheduler test).
  writeFileSync(join(HOME_B, 'schedules.json'), JSON.stringify([{
    id: DRIFT_ID, task: 'drift probe',
    schedule: { kind: 'every', everyMs: DRIFT_PERIOD, label: 'every 1 min', tzOffsetMin: 0 },
    createdAt: DRIFT_DUE - DRIFT_PERIOD, lastRunAt: null, nextRunAt: DRIFT_DUE, enabled: true, runs: 0, conversationId: null,
  }]));
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
  await Promise.all([stopChild(srvA), stopChild(srvB), stopChild(srvA2), stopChild(srvC)]);
  if (process.exitCode) {
    for (const [label, c] of [['A', srvA], ['B', srvB], ["A'", srvA2], ['C', srvC]]) {
      if (c && c.log.trim()) console.error(`\n--- server ${label} log tail ---\n${c.log.trim()}`);
    }
  }
  for (const dir of [HOME_A, HOME_B, HOME_C]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* fine */ } }
}
console.log(`\ngenie server: ${passed}/${tests.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (passed !== tests.length) process.exit(1);

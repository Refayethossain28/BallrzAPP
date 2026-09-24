#!/usr/bin/env node
/**
 * genie/server.mjs — Genie's home: the console server.
 *
 * The one process behind "the agent that does what you tell it": a node:http
 * server that serves the phone console, takes instructions as JSON, runs them
 * through the driver (agent.mjs → Claude Agent SDK, or the offline rehearsal)
 * one at a time from a FIFO queue, streams every Genie event to open clients
 * as NDJSON, answers approvals from your phone, fires standing orders on a
 * clock, and persists everything under GENIE_HOME with atomic writes.
 *
 *   npm run genie                      # http://127.0.0.1:8800/?key=… (printed at boot)
 *   HOST=0.0.0.0 node genie/server.mjs # reachable on your LAN — only on a network you trust
 *
 * Every rule (permission policy, schedule grammar, stream reducer, memory
 * format, slash commands, system prompt) lives in the pure engine.js — the
 * same file the console runs — evaluated here in a node:vm sandbox. This file
 * is plumbing: HTTP, disk, the queue, timers, signals.
 *
 * Env: PORT (8800) · HOST (127.0.0.1) · GENIE_HOME (~/.genie) · GENIE_KEY ·
 * GENIE_MODEL · GENIE_MODE · GENIE_EFFORT · GENIE_CWD · GENIE_OWNER ·
 * GENIE_MAX_TURNS · GENIE_MAX_USD · GENIE_DRIVER (auto|live|rehearsal) ·
 * GENIE_ALLOW_ORIGIN (comma-separated exact origins, or *) ·
 * GENIE_ASK_TIMEOUT_MS (600000) · GENIE_SETTING_SOURCES · GENIE_SCHEDULER_MS (20000).
 *
 * Safety posture (candidly): the agent's Bash/Edit reach whatever this process
 * user can reach; `auto` mode never asks (except when the agent itself has a
 * question for you — that always reaches your phone). The key is the only
 * lock. Bind loopback by default; run untrusted jobs in a container, and as
 * a non-root user: the Claude Code CLI refuses auto mode for root outside a
 * declared sandbox (IS_SANDBOX=1).
 */
import http from 'node:http';
import vm from 'node:vm';
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, chmodSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createDriver, loadSdk, buildGenieMcp, courtiers } from './agent.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));

/* ────────────────────────────── the engine (same file the page runs) ────────────────────────────── */
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(DIR, 'engine.js'), 'utf8'), sandbox, { filename: 'genie/engine.js' });
const E = sandbox.module.exports;

/* ────────────────────────────── configuration ────────────────────────────── */
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const PORT = num(process.env.PORT, 8800);
const HOST = process.env.HOST || '127.0.0.1';
const HOME = resolvePath(process.env.GENIE_HOME || join(homedir(), '.genie'));
const WORKSPACE = resolvePath(process.env.GENIE_CWD || join(HOME, 'workspace'));
const DRIVER_KIND = String(process.env.GENIE_DRIVER || 'auto').toLowerCase();
const ALLOW_ORIGINS = String(process.env.GENIE_ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
// Node truncates a timer above 2^31-1 ms to ONE millisecond, so an operator's
// "never expire" (30 days) must become "24.8 days", not "deny everything at once".
const TIMER_MAX_MS = 2 ** 31 - 1;
const ASK_TIMEOUT_MS = Math.min(TIMER_MAX_MS, Math.max(1000, num(process.env.GENIE_ASK_TIMEOUT_MS, 600000)));
const SCHEDULER_MS = Math.min(TIMER_MAX_MS, Math.max(250, num(process.env.GENIE_SCHEDULER_MS, 20000)));
const BODY_MAX = 256 * 1024;
const NOTIFY_TITLE_MAX = 200;  // a phone notification, not a report
const NOTIFY_BODY_MAX = 2000;
// The Claude Code CLI refuses bypassPermissions for root unless the process
// declares itself sandboxed, so live auto mode cannot work here.
const ROOT_UNSANDBOXED = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0
  && process.env.IS_SANDBOX !== '1' && !process.env.CLAUDE_CODE_BUBBLEWRAP;
const AUTO_BLOCKED_REASON = 'auto mode needs a non-root user, or IS_SANDBOX=1 inside a disposable container';
const PING_MS = 15000;
const TRANSCRIPT_MAX = 2000;   // transcript events kept per conversation on disk
const TRANSCRIPT_GET = 500;    // returned by GET /api/conversations/:id
const PERSIST_DEBOUNCE_MS = 200;
const PATHS = {
  key: join(HOME, 'key'),
  settings: join(HOME, 'settings.json'),
  memory: join(HOME, 'MEMORY.md'),
  schedules: join(HOME, 'schedules.json'),
  conversations: join(HOME, 'conversations'),
  commands: join(HOME, 'commands'),
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const warn = (...a) => console.warn(new Date().toISOString().slice(11, 19), '⚠', ...a);

/* ────────────────────────────── persistence (atomic) ────────────────────────────── */
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
const writeJSON = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 1));
function readJSON(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadKey() {
  if (process.env.GENIE_KEY) return String(process.env.GENIE_KEY).trim();
  try {
    const k = readFileSync(PATHS.key, 'utf8').trim();
    if (k) return k;
  } catch { /* first boot */ }
  const k = randomBytes(16).toString('hex');
  writeAtomic(PATHS.key, `${k}\n`);
  try { chmodSync(PATHS.key, 0o600); } catch { /* best effort */ }
  return k;
}

function id36(n) {
  let s = '';
  while (s.length < n) s += randomBytes(6).readUIntBE(0, 6).toString(36);
  return s.slice(0, n);
}
const newId = (prefix, n) => prefix + id36(n);

/* ────────────────────────────── state ────────────────────────────── */
let KEY = '';
let settings = E.defaultSettings();
let memoryText = '';
let schedules = [];
const convs = new Map(); // id → { meta, events, listeners:Set<res>, seq, activeRun, dirty, timer }
let driver = null;
let sdk = null;
let driverInfo = { kind: 'rehearsal', sdkInstalled: false, sdkVersion: null, credentials: false, reason: 'booting' };
let lastTz = -new Date().getTimezoneOffset(); // the phone's offset, once it has told us
let shuttingDown = false;

const queue = [];   // FIFO of runs waiting for the single slot
let active = null;  // the run in flight

/* ── settings ── */
function loadSettings() {
  let s = E.defaultSettings();
  const stored = readJSON(PATHS.settings, null);
  if (stored && typeof stored === 'object') {
    const r = E.applySettings(s, stored);
    if (r.ok) s = r.settings; else warn(`settings.json ignored: ${r.error}`);
  }
  // Env vars are explicit operator intent at launch — they win over the file.
  const envPatch = {};
  if (process.env.GENIE_MODEL) envPatch.model = process.env.GENIE_MODEL;
  if (process.env.GENIE_MODE) envPatch.mode = String(process.env.GENIE_MODE).toLowerCase();
  if (process.env.GENIE_EFFORT) envPatch.effort = String(process.env.GENIE_EFFORT).toLowerCase();
  if (process.env.GENIE_OWNER) envPatch.owner = process.env.GENIE_OWNER;
  if (process.env.GENIE_MAX_TURNS) envPatch.maxTurns = Number(process.env.GENIE_MAX_TURNS);
  if (process.env.GENIE_MAX_USD) envPatch.maxUsd = Number(process.env.GENIE_MAX_USD);
  if (process.env.GENIE_CWD) envPatch.cwd = WORKSPACE;
  for (const [k, v] of Object.entries(envPatch)) {
    const r = E.applySettings(s, { [k]: v });
    if (r.ok) s = r.settings; else warn(`env ${k}=${v} ignored: ${r.error}`);
  }
  if (!s.cwd || !isDir(s.cwd)) {
    if (s.cwd) warn(`cwd ${s.cwd} is not a directory — using ${WORKSPACE}`);
    const r = E.applySettings(s, { cwd: WORKSPACE });
    s = r.ok ? r.settings : { ...s, cwd: WORKSPACE };
  }
  settings = s;
}
const persistSettings = () => writeJSON(PATHS.settings, settings);

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/* ── memory ── */
function loadMemory() {
  try { memoryText = readFileSync(PATHS.memory, 'utf8'); } catch { memoryText = ''; }
}
const persistMemory = () => writeAtomic(PATHS.memory, memoryText);
const memoryItems = () => { try { return E.memoryParse(memoryText); } catch { return []; } };

/* ── schedules ── */
function loadSchedules() {
  const list = readJSON(PATHS.schedules, []);
  schedules = Array.isArray(list) ? list.filter((s) => s && typeof s === 'object' && s.id && s.schedule) : [];
}
const persistSchedules = () => writeJSON(PATHS.schedules, schedules);
function describe(rec) {
  let description = '';
  try { description = E.describeSchedule(rec.schedule); } catch { description = rec.schedule?.label || ''; }
  return { ...rec, description };
}

/* ── conversations ── */
function loadConversations() {
  mkdirSync(PATHS.conversations, { recursive: true });
  for (const f of readdirSync(PATHS.conversations)) {
    if (!f.endsWith('.json')) continue;
    const data = readJSON(join(PATHS.conversations, f), null);
    if (!data || !data.meta || !E.isConversationId(data.meta.id)) continue;
    const events = Array.isArray(data.events) ? data.events : [];
    const seq = Math.max(Number(data.meta.seq) || 0, ...events.map((e) => Number(e?.seq) || 0));
    const conv = {
      meta: { ...data.meta, status: 'idle', seq },
      events, listeners: new Set(), seq, activeRun: null, dirty: false, timer: null,
    };
    convs.set(conv.meta.id, conv);
    const cutOff = closeInterruptedRun(conv);
    if (cutOff) {
      log(`run ${cutOff} in ${conv.meta.id} was cut off by a restart — closed`);
      safe(() => persistConv(conv));
    }
  }
}

/**
 * A run cut off by a hard crash (SIGKILL, OOM, power) leaves its transcript
 * open on disk: a run_start with no run_end, tool cards with no result and
 * maybe an ask nobody can answer any more. Close it the way a stop would, so
 * the console replays a finished run instead of live cards. Returns the
 * closed run's id, or null when the last run ended properly.
 */
function closeInterruptedRun(conv) {
  const events = conv.events;
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.t;
    if (t === 'run_end') return null;
    if (t === 'run_start') { start = i; break; }
  }
  if (start < 0) return null;
  const runId = events[start].runId ?? null;
  const tail = events.slice(start);
  const answered = new Set(tail.filter((e) => e.t === 'ask_resolved').map((e) => e.requestId));
  const now = Date.now();
  const push = (evt) => events.push({ ...evt, seq: ++conv.seq, at: now, runId });
  for (const ask of tail) if (ask.t === 'ask' && !answered.has(ask.requestId)) push({ t: 'ask_resolved', requestId: ask.requestId, decision: 'deny', by: 'stop' });
  push({ t: 'error', message: 'server restarted mid-run' });
  push({ t: 'run_end', runId, status: 'stopped', cost: 0 });
  if (tail.some((e) => e.t === 'init')) conv.meta.runs = (conv.meta.runs || 0) + 1; // it had started, so it counts
  conv.meta.seq = conv.seq;
  return runId;
}
function persistConv(conv) {
  if (conv.timer) { clearTimeout(conv.timer); conv.timer = null; }
  conv.dirty = false;
  let transcript = conv.events.filter((e) => E.transcriptEvent(e));
  if (transcript.length > TRANSCRIPT_MAX) transcript = transcript.slice(-TRANSCRIPT_MAX);
  conv.meta.seq = conv.seq;
  writeJSON(join(PATHS.conversations, `${conv.meta.id}.json`), { meta: conv.meta, events: transcript });
}
function schedulePersist(conv) {
  conv.dirty = true;
  if (conv.timer) return;
  conv.timer = setTimeout(() => { conv.timer = null; if (conv.dirty) safe(() => persistConv(conv)); }, PERSIST_DEBOUNCE_MS);
}
function safe(fn) {
  try { return fn(); } catch (err) { warn(String(err?.message || err)); return undefined; }
}

function createConversation({ title, source = 'user', scheduleId = null } = {}) {
  const now = Date.now();
  const id = newId('c', 12);
  const meta = { ...E.newConversation({ id, now, title: title || 'New conversation', source }), scheduleId: scheduleId || null, seq: 0 };
  const conv = { meta, events: [], listeners: new Set(), seq: 0, activeRun: null, dirty: false, timer: null };
  convs.set(id, conv);
  persistConv(conv);
  return conv;
}

function lastLine(conv) {
  for (let i = conv.events.length - 1; i >= 0; i--) {
    const e = conv.events[i];
    if (e.t === 'text_final' || e.t === 'user') return E.truncate(E.sanitize(e.text || '').replace(/\s+/g, ' ').trim(), 120);
  }
  return null;
}
function convSummary(conv) {
  const m = conv.meta;
  return { id: m.id, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt, status: m.status, runs: m.runs, cost: m.cost, source: m.source, last: lastLine(conv) };
}

/* ────────────────────────────── events ────────────────────────────── */
function emit(conv, evt, runId) {
  const e = { ...evt, seq: ++conv.seq, at: Date.now(), runId: runId ?? conv.activeRun?.runId ?? null };
  conv.events.push(e);
  if (E.transcriptEvent(e)) schedulePersist(conv);
  // Bound the live tail of a very chatty run: drop the oldest 3000 deltas (all are pruned at run_end anyway).
  if (conv.events.length > TRANSCRIPT_MAX + 6000) {
    let dropped = 0;
    conv.events = conv.events.filter((x) => E.transcriptEvent(x) || dropped++ >= 3000);
  }
  const line = `${JSON.stringify(e)}\n`;
  for (const res of conv.listeners) { try { res.write(line); } catch { /* closing */ } }
  return e;
}
function system(conv, text, runId) { return emit(conv, { t: 'system', text: E.sanitize(text) }, runId); }

/** After a run: keep only what belongs on disk, so memory and replay stay small. */
function pruneEphemeral(conv) {
  conv.events = conv.events.filter((e) => E.transcriptEvent(e));
  if (conv.events.length > TRANSCRIPT_MAX) conv.events = conv.events.slice(-TRANSCRIPT_MAX);
}

/* ────────────────────────────── runs: one at a time, FIFO ────────────────────────────── */
function hasPending(conv) {
  return Boolean(conv.activeRun) || queue.some((r) => r.conv === conv);
}

function enqueue(conv, prompt, { source = 'user', scheduleId = null, shownText = null, tz = lastTz } = {}) {
  const run = {
    runId: newId('r', 8), conv, prompt, source, scheduleId, tz,
    abortController: new AbortController(), startedAt: null, pendingAsks: new Map(),
    state: null, resultEvent: null, stopped: false, finished: false, status: 'queued',
  };
  conv.activeRun = run;
  conv.meta.status = 'queued';
  conv.meta.updatedAt = Date.now();
  emit(conv, { t: 'run_start', runId: run.runId, prompt, source, ...(scheduleId ? { scheduleId } : {}) }, run.runId);
  emit(conv, { t: 'user', text: shownText ?? prompt }, run.runId);
  const ahead = (active ? 1 : 0) + queue.length;
  if (ahead) system(conv, `queued behind ${ahead} run${ahead === 1 ? '' : 's'}`, run.runId);
  queue.push(run);
  setImmediate(pump);
  return { run, queued: ahead };
}

async function pump() {
  if (active || shuttingDown) return;
  const run = queue.shift();
  if (!run) return;
  active = run;
  run.status = 'running';
  run.startedAt = Date.now();
  run.conv.meta.status = 'running';
  log(`run ${run.runId} (${run.source}) in ${run.conv.meta.id}: ${E.truncate(run.prompt.replace(/\s+/g, ' '), 80)}`);
  try {
    await executeRun(run);
  } catch (err) {
    emit(run.conv, { t: 'error', message: `server: ${E.sanitize(String(err?.message || err)).slice(0, 300)}` }, run.runId);
    finishRun(run, 'failed');
  }
  if (active === run) active = null;
  setImmediate(pump);
}

async function executeRun(run) {
  const conv = run.conv;
  const state = E.initRun(run.runId);
  run.state = state;
  const onMessage = (msg) => {
    if (run.finished) return;
    let evts = [];
    try { evts = E.reduce(state, msg, Date.now()) || []; } catch (err) { evts = [{ t: 'error', message: `reducer: ${String(err?.message || err).slice(0, 200)}` }]; }
    for (const ev of evts) {
      // A tool card shows the input, it does not archive it: a Write of a large
      // file must not become a multi-MB transcript event replayed on every
      // reconnect. The reducer's state keeps the untouched input.
      const e = emit(conv, ev.t === 'tool' ? { ...ev, input: clipInput(ev.input) } : ev, run.runId);
      if (e.t === 'result') run.resultEvent = e;
    }
  };

  const mcpServers = {};
  if (driver.kind === 'live' && sdk) {
    try { mcpServers.genie = await buildGenieMcp(sdk, mcpHandlers(run)); } catch (err) { warn(`genie tools unavailable: ${err?.message || err}`); }
  }
  const systemAppend = safe(() => E.buildSystemAppend({
    owner: settings.owner, memory: E.memoryForPrompt(memoryText), schedules: schedules.filter((s) => s.enabled).map(describe),
    mode: settings.mode, cwd: settings.cwd, now: Date.now(), tzOffsetMin: run.tz, commands: listCommands(), driver: driver.kind,
  })) || '';

  const out = await driver.run({
    prompt: run.prompt, conversation: conv.meta, settings, systemAppend, mcpServers,
    agents: courtiers(settings.model),
    canUseTool: makeCanUseTool(run), getRules: () => settings.rules || [],
    abortController: run.abortController, onMessage,
  });
  if (run.finished) return; // shutdown already closed it
  const sessionId = out?.sessionId || state.sessionId;
  if (sessionId) conv.meta.sessionId = sessionId;
  const ok = run.resultEvent ? run.resultEvent.ok === true : (out?.result?.subtype === 'success' && !out?.result?.is_error);
  finishRun(run, run.stopped ? 'stopped' : ok ? 'done' : 'failed');
}

function finishRun(run, status) {
  if (run.finished) return;
  run.finished = true;
  run.status = status;
  const conv = run.conv;
  for (const p of run.pendingAsks.values()) p.resolve('deny', 'stop');
  const cost = Number(run.state?.cost) || 0;
  conv.meta.cost = Math.round(((Number(conv.meta.cost) || 0) + cost) * 1e6) / 1e6;
  if (run.startedAt) conv.meta.runs = (conv.meta.runs || 0) + 1; // a run stopped while still queued never ran
  conv.meta.updatedAt = Date.now();
  conv.meta.status = 'idle';
  emit(conv, { t: 'run_end', runId: run.runId, status, cost }, run.runId);
  if (conv.activeRun === run) conv.activeRun = null;
  pruneEphemeral(conv);
  safe(() => persistConv(conv));
  log(`run ${run.runId}: ${status}${cost ? ` ($${cost.toFixed(4)})` : ''}`);
}

/** Stop a conversation's run: abort the active one, drop queued ones. */
function stopConversation(conv) {
  let stopped = false;
  if (active && active.conv === conv && !active.finished) {
    active.stopped = true;
    for (const p of active.pendingAsks.values()) p.resolve('deny', 'stop');
    active.abortController.abort();
    stopped = true;
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].conv !== conv) continue;
    const [run] = queue.splice(i, 1);
    run.stopped = true;
    finishRun(run, 'stopped');
    stopped = true;
  }
  return stopped;
}

/* ────────────────────────────── approvals ────────────────────────────── */
/**
 * An event's copy of a tool input: every long string (a Write body, a
 * MultiEdit's new_string) clipped to OUTPUT_MAX, nested a few levels deep.
 * The SDK still gets the real thing; only what we show and store is clipped.
 */
function clipInput(input, depth = 0) {
  if (!input || typeof input !== 'object' || depth > 4) return input;
  const max = Number(E.OUTPUT_MAX) || 4000;
  const out = Array.isArray(input) ? [] : {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = v.length > max ? `${v.slice(0, max)}… (+${v.length - max} chars)` : v;
    else if (v && typeof v === 'object') out[k] = clipInput(v, depth + 1);
    else out[k] = v;
  }
  return out;
}

/**
 * The questions of an AskUserQuestion, in the shape the console renders:
 * `{ question, header, options:[{ label, description }], multiSelect }`.
 * Texts are kept verbatim (capped, not sanitized) because the answer keys
 * must round-trip to the tool exactly.
 */
function questionsOf(input) {
  const cap = (v, n) => String(v ?? '').slice(0, n);
  const list = Array.isArray(input?.questions) ? input.questions : [];
  return list.filter((q) => q && typeof q === 'object').slice(0, 20).map((q) => ({
    question: cap(q.question, Number(E.OUTPUT_MAX) || 4000),
    header: cap(q.header, 80),
    options: (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o === 'object').slice(0, 20)
      .map((o) => ({ label: cap(o.label, 200), description: cap(o.description, 500) })),
    multiSelect: q.multiSelect === true,
  }));
}

/** The owner's answers from POST /api/approve, keyed by question text. */
function answersOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [q, a] of Object.entries(raw).slice(0, 20)) {
    if (!q) continue;
    const text = Array.isArray(a) ? a.map((x) => String(x ?? '')).join(', ') : String(a ?? '');
    out[q] = E.sanitize(text).slice(0, 2000);
  }
  return out;
}

/**
 * The SDK's permission callback. Two kinds of ask reach the phone:
 *   permission  — the policy said ask; Allow / Always allow / Deny.
 *   question    — the agent called AskUserQuestion; it is not a permission
 *                 at all but a question for the owner, so it asks in every
 *                 mode (auto included), no rule can answer it, and the
 *                 answers go back to the tool as `updatedInput.answers`.
 */
function makeCanUseTool(run) {
  return async (name, input, opts = {}) => {
    const conv = run.conv;
    const safeInput = input && typeof input === 'object' ? input : {};
    let decision;
    try {
      decision = E.decide({ mode: settings.mode, name, input: safeInput, rules: settings.rules });
    } catch (err) {
      return { behavior: 'deny', message: `policy error: ${String(err?.message || err).slice(0, 120)}` };
    }
    const question = name === 'AskUserQuestion' || decision.level === 'question';
    if (!question) {
      if (decision.behavior === 'allow') return { behavior: 'allow' };
      if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.reason || 'denied by a rule' };
    }
    if (run.finished || run.abortController.signal.aborted) return { behavior: 'deny', message: 'stopped' };

    const requestId = newId('q', 10);
    const toolId = opts.toolUseID || opts.toolUseId || null;
    let ask;
    if (question) {
      const questions = questionsOf(safeInput);
      const reason = decision.level === 'question' && decision.reason ? decision.reason : 'the agent is asking you something';
      ask = {
        t: 'ask', requestId, toolId, name, kind: 'question',
        title: safe(() => E.askTitle(name, safeInput, 'question', reason)) || 'Genie has a question for you',
        summary: safe(() => E.summarizeInput(name, safeInput)) || questions[0]?.question || name,
        questions, level: 'question', reason,
      };
    } else {
      ask = {
        t: 'ask', requestId, toolId, name, kind: 'permission',
        input: clipInput(safeInput),
        summary: safe(() => E.summarizeInput(name, safeInput)) || name,
        title: opts.title || safe(() => E.askTitle(name, safeInput, decision.level, decision.reason)) || `Genie wants to use ${name}`,
        level: decision.level, reason: decision.reason,
      };
      if (Array.isArray(opts.suggestions) && opts.suggestions.length) ask.suggestions = opts.suggestions;
    }
    const event = emit(conv, ask, run.runId);

    return new Promise((resolve) => {
      let done = false;
      const finish = (verdict, by, answers) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        run.pendingAsks.delete(requestId);
        try { opts.signal?.removeEventListener('abort', onAbort); } catch { /* fine */ }
        const allowed = verdict === 'allow' || verdict === 'always';
        if (question) {
          const given = allowed ? answersOf(answers) : null;
          emit(conv, { t: 'ask_resolved', requestId, decision: verdict, by, ...(given ? { answers: given } : {}) }, run.runId);
          if (allowed) resolve({ behavior: 'allow', updatedInput: { ...safeInput, answers: given } });
          else resolve({ behavior: 'deny', message: by === 'timeout' ? 'the owner did not answer in time' : by === 'stop' ? 'stopped by the owner' : 'the owner declined to answer' });
          return;
        }
        emit(conv, { t: 'ask_resolved', requestId, decision: verdict, by }, run.runId);
        if (verdict === 'always') {
          // The engine's key is always an exact rule (a trailing * is escaped), so
          // one tap on "git add *" never becomes a blanket "git add …" grant.
          safe(() => {
            const key = E.ruleKey(name, safeInput);
            settings = { ...settings, rules: E.addRule(settings.rules || [], key, 'allow') };
            persistSettings();
            system(conv, `always allow ${key}`, run.runId);
          });
        }
        if (allowed) resolve({ behavior: 'allow' });
        else resolve({ behavior: 'deny', message: by === 'timeout' ? 'the owner did not answer in time' : by === 'stop' ? 'stopped by the owner' : 'the owner declined' });
      };
      const timer = setTimeout(() => finish('deny', 'timeout'), ASK_TIMEOUT_MS);
      const onAbort = () => finish('deny', 'stop');
      try { opts.signal?.addEventListener('abort', onAbort, { once: true }); } catch { /* no signal */ }
      run.pendingAsks.set(requestId, { resolve: finish, event, timer });
    });
  };
}

function approve(requestId, decision, answers) {
  if (!E.isRequestId(requestId)) return false;
  const runs = active ? [active, ...queue] : [...queue];
  for (const run of runs) {
    const p = run.pendingAsks.get(requestId);
    if (p) { p.resolve(decision, 'user', answers); return true; }
  }
  return false;
}

/* ────────────────────────────── Genie's own tools (MCP handlers) ────────────────────────────── */
function addSchedule(when, task, tz, conversationId = null) {
  const parsed = E.parseSchedule(String(when ?? ''), { tzOffsetMin: Number.isFinite(Number(tz)) ? Number(tz) : lastTz });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const rest = String(when ?? '').slice(parsed.consumed).trim();
  const finalTask = String(task ?? '').trim() || rest;
  const vt = E.validateTask(finalTask);
  if (!vt.ok) return { ok: false, error: vt.error };
  const now = Date.now();
  const rec = E.newSchedule({ id: newId('s', 8), task: vt.task || finalTask, schedule: parsed.schedule, now, conversationId });
  if (typeof rec.nextRunAt !== 'number') return { ok: false, error: 'that schedule would never fire' };
  schedules.push(rec);
  persistSchedules();
  return { ok: true, schedule: describe(rec) };
}

function removeSchedule(id) {
  const i = schedules.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const [rec] = schedules.splice(i, 1);
  persistSchedules();
  return rec;
}

function scheduleLine(rec) {
  const d = describe(rec);
  const next = typeof rec.nextRunAt === 'number' ? E.relTime(Date.now(), rec.nextRunAt) : 'never';
  return `${rec.id} · ${d.description} · next ${next}${rec.enabled ? '' : ' · paused'} — ${rec.task}`;
}

function mcpHandlers(run) {
  const conv = run.conv;
  return {
    async remember({ fact }) {
      const r = E.memoryAdd(memoryText, String(fact ?? ''), Date.now());
      if (!r.ok) throw new Error(r.error);
      memoryText = r.text;
      persistMemory();
      system(conv, `remembered: ${r.item.fact}`, run.runId);
      return `remembered #${r.item.n}: ${r.item.fact}`;
    },
    async forget({ n }) {
      const which = String(n).trim().toLowerCase() === 'all' ? 'all' : Number(n);
      const r = E.memoryForget(memoryText, which);
      if (!r.ok) throw new Error(r.error || 'no such entry');
      memoryText = r.text;
      persistMemory();
      const what = which === 'all' ? 'everything' : (r.removed?.fact || `#${which}`);
      system(conv, `forgot: ${what}`, run.runId);
      return `forgot ${what}`;
    },
    async schedule({ when, task }) {
      const r = addSchedule(when, task, run.tz);
      if (!r.ok) throw new Error(r.error);
      system(conv, `⏰ scheduled ${r.schedule.id}: ${r.schedule.description} — ${r.schedule.task}`, run.runId);
      return `scheduled ${r.schedule.id}: ${r.schedule.description} — next ${E.relTime(Date.now(), r.schedule.nextRunAt)}`;
    },
    async unschedule({ id }) {
      const rec = removeSchedule(String(id ?? '').trim());
      if (!rec) throw new Error(`no schedule ${id}`);
      system(conv, `⏰ unscheduled ${rec.id}: ${rec.task}`, run.runId);
      return `unscheduled ${rec.id}`;
    },
    async list_schedules() {
      return schedules.length ? schedules.map(scheduleLine).join('\n') : 'no standing orders';
    },
    async notify({ title, body }) {
      emit(conv, {
        t: 'notify',
        title: E.truncate(E.sanitize(title || 'Genie'), NOTIFY_TITLE_MAX),
        body: E.truncate(E.sanitize(body || ''), NOTIFY_BODY_MAX),
      }, run.runId);
      return 'notified';
    },
  };
}

/* ────────────────────────────── scheduler ────────────────────────────── */
function fireSchedule(rec, now = Date.now()) {
  const i = schedules.findIndex((s) => s.id === rec.id);
  if (i < 0) return { ok: false, error: 'no such schedule' };
  const due = schedules[i].nextRunAt;
  let updated = E.afterRun(schedules[i], now);
  // An `every` cadence stays anchored to when it was DUE, not to the tick that
  // noticed (which lands 0…SCHEDULER_MS late, and that lateness would compound).
  // A firing missed by more than a whole period restarts from now, and a
  // "run now" ahead of time keeps afterRun's next = now + period.
  if (updated.schedule?.kind === 'every' && typeof due === 'number' && due <= now) {
    const anchored = safe(() => E.nextFrom(updated.schedule, due));
    if (typeof anchored === 'number' && anchored > now) updated = { ...updated, nextRunAt: anchored };
  }
  let conv = updated.conversationId ? convs.get(updated.conversationId) : null;
  if (!conv) {
    conv = createConversation({ title: `⏰ ${E.titleFrom(updated.task)}`, source: 'schedule', scheduleId: updated.id });
    updated = { ...updated, conversationId: conv.meta.id };
  }
  schedules[i] = updated;
  persistSchedules();
  if (hasPending(conv)) {
    system(conv, `⏰ ${updated.id} skipped — the previous run is still going`);
    return { ok: true, conversationId: conv.meta.id, runId: null, skipped: true };
  }
  const { run } = enqueue(conv, updated.task, { source: 'schedule', scheduleId: updated.id });
  return { ok: true, conversationId: conv.meta.id, runId: run.runId, skipped: false };
}

function tickScheduler() {
  if (shuttingDown) return;
  const now = Date.now();
  let due = [];
  try { due = E.dueSchedules(schedules, now) || []; } catch (err) { warn(`scheduler: ${err?.message || err}`); return; }
  for (const rec of due) {
    if (typeof rec.nextRunAt !== 'number') continue;
    log(`⏰ ${rec.id} due: ${E.truncate(rec.task, 60)}`);
    safe(() => fireSchedule(rec, now));
  }
}

/* ────────────────────────────── custom commands ────────────────────────────── */
const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
function listCommands() {
  const out = [];
  try {
    for (const f of readdirSync(PATHS.commands)) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -3);
      if (!COMMAND_NAME.test(name)) continue;
      const cmd = safe(() => E.parseCommandFile(name, readFileSync(join(PATHS.commands, f), 'utf8')));
      if (cmd) out.push({ name: cmd.name, description: cmd.description || '' });
    }
  } catch { /* no commands dir */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function loadCommand(name) {
  if (!COMMAND_NAME.test(name)) return null;
  const file = join(PATHS.commands, `${name}.md`);
  if (!existsSync(file)) return null;
  return safe(() => E.parseCommandFile(name, readFileSync(file, 'utf8'))) || null;
}

/* ────────────────────────────── slash commands (server-side) ────────────────────────────── */
/** Live auto mode cannot work as root outside a declared sandbox — the CLI refuses it on every run. */
const autoBlocked = () => Boolean(driver && driver.kind === 'live' && ROOT_UNSANDBOXED);

function patchSettings(patch) {
  if (patch.cwd !== undefined) {
    const vc = E.validateCwd(patch.cwd);
    if (!vc.ok) return { ok: false, error: vc.error || 'bad cwd' };
    if (!isDir(patch.cwd)) return { ok: false, error: `cwd must be an existing directory: ${patch.cwd}` };
  }
  if (String(patch.mode ?? '').trim().toLowerCase() === 'auto' && autoBlocked()) return { ok: false, error: AUTO_BLOCKED_REASON };
  const r = E.applySettings(settings, patch);
  if (!r.ok) return r;
  settings = r.settings;
  persistSettings();
  return r;
}

function statusText(conv) {
  const chip = safe(() => E.statusChip({ driver: driver.kind, live: driver.kind === 'live', model: settings.model })) || driver.kind;
  const spentAll = [...convs.values()].reduce((sum, c) => sum + (Number(c.meta.cost) || 0), 0);
  const lines = [
    `**${chip}** · mode ${settings.mode} · effort ${settings.effort}`,
    `cwd ${settings.cwd}`,
    `${active ? `running ${active.runId} in ${active.conv.meta.id}` : 'idle'}${queue.length ? ` · ${queue.length} queued` : ''}`,
    `spent ${E.formatUsd(conv.meta.cost)} in this conversation · ${E.formatUsd(spentAll)} across all`,
    `${memoryItems().length} memories · ${schedules.length} standing orders · ${convs.size} conversations`,
  ];
  if (driver.kind !== 'live') lines.push(`rehearsal: ${driverInfo.reason}`);
  if (autoBlocked()) lines.push(`auto mode unavailable: ${AUTO_BLOCKED_REASON}`);
  return lines.join('\n');
}

function handleCommand(conv, cmd, body) {
  const args = String(cmd.args || '').trim();
  const reply = (text, extra = {}) => {
    system(conv, text);
    return { status: 200, body: { handled: true, reply: text, ...extra } };
  };
  switch (cmd.name) {
    case 'help': return reply(E.helpText());
    case 'new': {
      const fresh = createConversation({ title: args || 'New conversation' });
      return reply(`started a new conversation: ${fresh.meta.title}`, { conversationId: fresh.meta.id });
    }
    case 'stop': return reply(stopConversation(conv) ? 'stopping…' : 'nothing is running here');
    case 'status': return reply(statusText(conv));
    case 'mode': case 'model': case 'effort': {
      if (!args) return reply(`${cmd.name} is ${settings[cmd.name]}`);
      const r = patchSettings({ [cmd.name]: cmd.name === 'model' ? args : args.toLowerCase() });
      return r.ok ? reply(`${cmd.name} → ${settings[cmd.name]}`) : { status: 400, body: { handled: true, reply: r.error, error: r.error } };
    }
    case 'cwd': {
      if (!args) return reply(`cwd is ${settings.cwd}`);
      const r = patchSettings({ cwd: args });
      return r.ok ? reply(`cwd → ${settings.cwd}`) : { status: 400, body: { handled: true, reply: r.error, error: r.error } };
    }
    case 'remember': {
      const r = E.memoryAdd(memoryText, args, Date.now());
      if (!r.ok) return { status: 400, body: { handled: true, reply: r.error, error: r.error } };
      memoryText = r.text; persistMemory();
      return reply(`remembered: ${r.item.fact}`);
    }
    case 'forget': {
      const which = args.toLowerCase() === 'all' ? 'all' : Number(args);
      if (which !== 'all' && !Number.isInteger(which)) return { status: 400, body: { handled: true, reply: 'usage: /forget <n|all>', error: 'usage: /forget <n|all>' } };
      const r = E.memoryForget(memoryText, which);
      if (!r.ok) return { status: 400, body: { handled: true, reply: r.error || 'no such entry', error: r.error || 'no such entry' } };
      memoryText = r.text; persistMemory();
      return reply(which === 'all' ? 'forgot everything' : `forgot: ${r.removed?.fact || `#${which}`}`);
    }
    case 'memory': {
      const items = memoryItems();
      return reply(items.length ? items.map((m) => `${m.n}. ${m.fact} _(${m.date})_`).join('\n') : 'nothing remembered yet — try /remember <fact>');
    }
    case 'schedule': {
      if (!args) return reply('usage: /schedule <when> <task> — e.g. /schedule weekdays at 08:30 run the tests and report');
      const r = addSchedule(args, '', body.tz);
      if (!r.ok) return { status: 400, body: { handled: true, reply: r.error, error: r.error } };
      return reply(`⏰ scheduled ${r.schedule.id}: ${r.schedule.description} — ${r.schedule.task} (next ${E.relTime(Date.now(), r.schedule.nextRunAt)})`, { scheduleId: r.schedule.id });
    }
    case 'schedules': return reply(schedules.length ? schedules.map(scheduleLine).join('\n') : 'no standing orders — try /schedule every day at 09:00 …');
    case 'unschedule': {
      const rec = args && removeSchedule(args);
      return rec ? reply(`⏰ unscheduled ${rec.id}: ${rec.task}`) : { status: 404, body: { handled: true, reply: `no schedule ${args || '?'}`, error: 'no such schedule' } };
    }
    case 'run': {
      const rec = schedules.find((s) => s.id === args);
      if (!rec) return { status: 404, body: { handled: true, reply: `no schedule ${args || '?'}`, error: 'no such schedule' } };
      const r = fireSchedule(rec);
      return reply(r.skipped ? `⏰ ${rec.id} is already running` : `⏰ running ${rec.id} now`, { conversationId: r.conversationId, runId: r.runId });
    }
    case 'commands': {
      const list = listCommands();
      return reply(list.length ? list.map((c) => `/${c.name}${c.description ? ` — ${c.description}` : ''}`).join('\n') : `no custom commands — add ${join(PATHS.commands, '<name>.md')}`);
    }
    default: return null; // not a built-in
  }
}

/* ────────────────────────────── http plumbing ────────────────────────────── */
/** CORS for a hosted console: echo the request's origin when it is on the list (or `*`). */
function corsHeaders(req) {
  if (!ALLOW_ORIGINS.length) return {};
  const origin = String(req.headers.origin || '');
  const allow = ALLOW_ORIGINS.includes('*') ? '*' : (origin && ALLOW_ORIGINS.includes(origin) ? origin : null);
  if (!allow) return {};
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}
function sendJSON(req, res, status, obj) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(req) });
  res.end(JSON.stringify(obj));
}

function readBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return; // keep draining so the 413 reliably reaches the client
      size += c.length;
      if (size > BODY_MAX) { tooBig = true; chunks.length = 0; sendJSON(req, res, 413, { error: 'request too large (256 KB max)' }); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => { if (!res.headersSent) sendJSON(req, res, 400, { error: 'bad request body' }); resolve(null); });
  });
}
async function readJSONBody(req, res) {
  const raw = await readBody(req, res);
  if (raw === null) return null; // already answered
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) { sendJSON(req, res, 400, { error: 'body must be a JSON object' }); return null; }
    return v;
  } catch {
    sendJSON(req, res, 400, { error: 'bad JSON' });
    return null;
  }
}

function tokenOf(req, url) {
  const h = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (m && m[1].trim()) return m[1].trim();
  const q = url.searchParams.get('key');
  return q && q.trim() ? q.trim() : null;
}
function authorized(req, url) {
  const token = tokenOf(req, url);
  if (!token || !KEY) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ── the PWA shell: an allowlist, so no path ever escapes genie/ ── */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['engine.js', 'text/javascript; charset=utf-8'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

function streamEvents(req, res, conv, since) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
    ...corsHeaders(req),
  });
  res.flushHeaders?.();
  try { req.socket?.setNoDelay?.(true); req.socket?.setTimeout?.(0); } catch { /* fine */ }
  res.on('error', () => {});
  for (const e of conv.events) if (e.seq > since) res.write(`${JSON.stringify(e)}\n`);
  conv.listeners.add(res);
  const ping = setInterval(() => { try { res.write('{"t":"ping"}\n'); } catch { /* closing */ } }, PING_MS);
  const done = () => { clearInterval(ping); conv.listeners.delete(res); };
  res.on('close', done);
  req.on('close', done);
  // No upstream abort here on purpose: the run continues; the client reconnects with ?since=.
}

function convOr404(req, res, id) {
  if (!E.isConversationId(id)) { sendJSON(req, res, 400, { error: 'bad conversation id' }); return null; }
  const conv = convs.get(id);
  if (!conv) { sendJSON(req, res, 404, { error: 'no such conversation' }); return null; }
  return conv;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(ALLOW_ORIGINS.length ? 204 : 404, corsHeaders(req));
    return res.end();
  }

  /* unauthenticated: health + the static console */
  if (method === 'GET' && p === '/api/health') return sendJSON(req, res, 200, { ok: true, name: 'genie', version: E.VERSION, needsKey: true });
  if (method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC, p)) {
    const [file, type] = STATIC[p];
    try {
      const body = readFileSync(join(DIR, file));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      return res.end(body);
    } catch {
      return sendJSON(req, res, 404, { error: `asset missing — ${file.endsWith('.png') ? 'run: npm run icons:genie' : file}` });
    }
  }
  if (!p.startsWith('/api/')) return sendJSON(req, res, 404, { error: 'not found' });

  /* everything under /api/ needs the key */
  if (!authorized(req, url)) return sendJSON(req, res, 401, { error: 'unauthorized' });

  if (method === 'GET' && p === '/api/status') {
    return sendJSON(req, res, 200, {
      ok: true, driver: driver.kind, live: driver.kind === 'live',
      model: settings.model, mode: settings.mode, effort: settings.effort, cwd: settings.cwd, owner: settings.owner,
      version: E.VERSION, busy: Boolean(active), queue: queue.length,
      memoryCount: memoryItems().length, schedules: schedules.length,
      sdk: { installed: driverInfo.sdkInstalled, version: driverInfo.sdkVersion }, credentials: driverInfo.credentials,
      reason: driverInfo.reason, host: HOST, port: PORT,
      rootUnsandboxed: ROOT_UNSANDBOXED, autoBlockedReason: autoBlocked() ? AUTO_BLOCKED_REASON : null,
      modes: E.MODE_INFO, models: E.MODELS.map(({ id, label, note }) => ({ id, label, note })), efforts: [...E.EFFORTS],
    });
  }

  if (p === '/api/settings') {
    if (method === 'GET') return sendJSON(req, res, 200, { ok: true, ...settings, settings });
    if (method === 'PATCH' || method === 'POST') {
      const body = await readJSONBody(req, res); if (!body) return undefined;
      const r = patchSettings(body);
      if (!r.ok) return sendJSON(req, res, 400, { error: r.error });
      if (r.changed?.length) log(`settings: ${r.changed.map((k) => `${k}=${JSON.stringify(settings[k])}`).join(' ')}`);
      return sendJSON(req, res, 200, { ok: true, ...settings, settings, changed: r.changed || [] });
    }
  }

  if (p === '/api/conversations') {
    if (method === 'GET') {
      const list = [...convs.values()].map(convSummary).sort((a, b) => b.updatedAt - a.updatedAt);
      return sendJSON(req, res, 200, { conversations: list });
    }
    if (method === 'POST') {
      const body = await readJSONBody(req, res); if (!body) return undefined;
      const title = body.title ? E.truncate(E.sanitize(String(body.title)).trim(), 80) : '';
      const conv = createConversation({ title: title || 'New conversation' });
      return sendJSON(req, res, 200, { id: conv.meta.id, meta: conv.meta });
    }
  }

  let m = /^\/api\/conversations\/([^/]+)$/.exec(p);
  if (m) {
    const conv = convOr404(req, res, m[1]); if (!conv) return undefined;
    if (method === 'GET') {
      const events = conv.events.filter((e) => E.transcriptEvent(e)).slice(-TRANSCRIPT_GET);
      return sendJSON(req, res, 200, { meta: conv.meta, events, seq: conv.seq });
    }
    if (method === 'DELETE') {
      if (hasPending(conv)) return sendJSON(req, res, 409, { error: 'a run is active in this conversation — stop it first' });
      for (const l of conv.listeners) { try { l.end(); } catch { /* fine */ } }
      if (conv.timer) clearTimeout(conv.timer);
      convs.delete(conv.meta.id);
      try { unlinkSync(join(PATHS.conversations, `${conv.meta.id}.json`)); } catch { /* already gone */ }
      for (const s of schedules) if (s.conversationId === conv.meta.id) s.conversationId = null;
      persistSchedules();
      return sendJSON(req, res, 200, { ok: true });
    }
  }

  m = /^\/api\/conversations\/([^/]+)\/say$/.exec(p);
  if (m && method === 'POST') {
    const conv = convOr404(req, res, m[1]); if (!conv) return undefined;
    const body = await readJSONBody(req, res); if (!body) return undefined;
    const text = typeof body.text === 'string' ? body.text : '';
    if (Number.isFinite(Number(body.tz))) lastTz = Math.max(-840, Math.min(840, Number(body.tz)));
    const tz = lastTz;
    const cmd = E.parseCommand(text);
    if (cmd.kind === 'command') {
      const out = handleCommand(conv, cmd, { ...body, tz });
      if (out) return sendJSON(req, res, out.status, out.body);
      const custom = loadCommand(cmd.name);
      if (!custom) {
        const reply = `unknown command /${cmd.name} — try /help`;
        system(conv, reply);
        return sendJSON(req, res, 200, { handled: true, reply, unknown: true });
      }
      const expanded = E.expandCommand(custom, cmd.args || '');
      const v = E.validatePrompt(expanded);
      if (!v.ok) return sendJSON(req, res, 400, { error: v.error });
      if (hasPending(conv)) return sendJSON(req, res, 409, { error: 'a run is already active in this conversation' });
      const { run, queued } = enqueue(conv, v.text, { source: 'command', shownText: E.sanitize(text.trim()), tz });
      return sendJSON(req, res, 200, { runId: run.runId, queued, command: custom.name });
    }
    const v = E.validatePrompt(text);
    if (!v.ok) return sendJSON(req, res, 400, { error: v.error });
    if (hasPending(conv)) return sendJSON(req, res, 409, { error: 'a run is already active in this conversation' });
    if (conv.meta.runs === 0 && (!conv.meta.title || conv.meta.title === 'New conversation')) conv.meta.title = E.titleFrom(v.text);
    const { run, queued } = enqueue(conv, v.text, { source: 'user', tz });
    return sendJSON(req, res, 200, { runId: run.runId, queued });
  }

  m = /^\/api\/conversations\/([^/]+)\/events$/.exec(p);
  if (m && method === 'GET') {
    const conv = convOr404(req, res, m[1]); if (!conv) return undefined;
    const since = Math.max(0, num(url.searchParams.get('since'), 0));
    return streamEvents(req, res, conv, since);
  }

  if (p === '/api/approve' && method === 'POST') {
    const body = await readJSONBody(req, res); if (!body) return undefined;
    const decision = String(body.decision || '').toLowerCase();
    if (!['allow', 'deny', 'always'].includes(decision)) return sendJSON(req, res, 400, { error: 'decision must be allow, deny or always' });
    if (body.answers !== undefined && (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers))) return sendJSON(req, res, 400, { error: 'answers must be an object of question → answer' });
    const ok = approve(String(body.requestId || ''), decision, body.answers);
    return ok ? sendJSON(req, res, 200, { ok: true }) : sendJSON(req, res, 404, { error: 'unknown or already resolved request' });
  }

  if (p === '/api/stop' && method === 'POST') {
    const body = await readJSONBody(req, res); if (!body) return undefined;
    const conv = convOr404(req, res, String(body.conversationId || '')); if (!conv) return undefined;
    return sendJSON(req, res, 200, { ok: true, stopped: stopConversation(conv) });
  }

  if (p === '/api/memory') {
    if (method === 'GET') return sendJSON(req, res, 200, { text: memoryText, items: memoryItems() });
    if (method === 'POST') {
      const body = await readJSONBody(req, res); if (!body) return undefined;
      const r = E.memoryAdd(memoryText, String(body.fact ?? ''), Date.now());
      if (!r.ok) return sendJSON(req, res, 400, { error: r.error });
      memoryText = r.text; persistMemory();
      return sendJSON(req, res, 200, { ok: true, item: r.item, items: memoryItems() });
    }
  }
  m = /^\/api\/memory\/([^/]+)$/.exec(p);
  if (m && method === 'DELETE') {
    const which = m[1].toLowerCase() === 'all' ? 'all' : Number(m[1]);
    if (which !== 'all' && !Number.isInteger(which)) return sendJSON(req, res, 400, { error: 'bad entry number' });
    const r = E.memoryForget(memoryText, which);
    if (!r.ok) return sendJSON(req, res, 404, { error: r.error || 'no such entry' });
    memoryText = r.text; persistMemory();
    return sendJSON(req, res, 200, { ok: true, removed: r.removed ?? null, items: memoryItems() });
  }

  if (p === '/api/schedules') {
    if (method === 'GET') return sendJSON(req, res, 200, { schedules: schedules.map(describe) });
    if (method === 'POST') {
      const body = await readJSONBody(req, res); if (!body) return undefined;
      if (Number.isFinite(Number(body.tz))) lastTz = Math.max(-840, Math.min(840, Number(body.tz)));
      const r = addSchedule(body.when, body.task, body.tz);
      if (!r.ok) return sendJSON(req, res, 400, { error: r.error });
      return sendJSON(req, res, 200, { ok: true, schedule: r.schedule });
    }
  }
  m = /^\/api\/schedules\/([^/]+)(\/run)?$/.exec(p);
  if (m) {
    const id = m[1];
    if (!E.isScheduleId(id)) return sendJSON(req, res, 400, { error: 'bad schedule id' });
    const rec = schedules.find((s) => s.id === id);
    if (!rec) return sendJSON(req, res, 404, { error: 'no such schedule' });
    if (m[2] && method === 'POST') {
      const r = fireSchedule(rec);
      return sendJSON(req, res, 200, { ok: true, conversationId: r.conversationId, runId: r.runId, skipped: r.skipped, schedule: describe(schedules.find((s) => s.id === id)) });
    }
    if (!m[2] && method === 'DELETE') { removeSchedule(id); return sendJSON(req, res, 200, { ok: true }); }
    if (!m[2] && (method === 'PATCH' || method === 'POST')) {
      const body = await readJSONBody(req, res); if (!body) return undefined;
      if (typeof body.enabled !== 'boolean') return sendJSON(req, res, 400, { error: 'enabled must be a boolean' });
      const i = schedules.findIndex((s) => s.id === id);
      let next = schedules[i];
      next = { ...next, enabled: body.enabled };
      if (body.enabled && (typeof next.nextRunAt !== 'number' || next.nextRunAt <= Date.now())) {
        next.nextRunAt = safe(() => E.nextRun(next.schedule, Date.now())) ?? next.nextRunAt;
      }
      schedules[i] = next;
      persistSchedules();
      return sendJSON(req, res, 200, { ok: true, schedule: describe(next) });
    }
  }

  if (p === '/api/commands' && method === 'GET') return sendJSON(req, res, 200, { commands: listCommands() });

  return sendJSON(req, res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    warn(`${req.method} ${req.url}: ${err?.stack || err}`);
    if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
    sendJSON(req, res, 500, { error: 'server error' });
  });
});
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

/* ────────────────────────────── boot & shutdown ────────────────────────────── */
function lanAddress() {
  if (HOST !== '0.0.0.0' && HOST !== '::' && HOST !== '') return HOST === '127.0.0.1' ? 'localhost' : HOST;
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}

function banner() {
  const phone = `http://${lanAddress()}:${PORT}/?key=${KEY}`;
  console.log('');
  console.log('  🪔  G E N I E — the agent that does what you tell it');
  console.log(`      driver  ${driver.kind === 'live' ? `live · ${settings.model}` : 'rehearsal (nothing runs for real)'} — ${driverInfo.reason}`);
  console.log(`      phone   ${phone}`);
  console.log(`      mode    ${settings.mode} · effort ${settings.effort} · cwd ${settings.cwd}`);
  console.log(`      home    ${HOME}  (${convs.size} conversations · ${memoryItems().length} memories · ${schedules.length} standing orders)`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.log(`      ⚠⚠⚠   bound to ${HOST} — reachable beyond this machine. The agent can run commands and edit files as ${process.env.USER || 'this user'}; the key is the only lock.`);
  }
  if (autoBlocked()) {
    console.log('      ⚠⚠⚠   running as root outside a declared sandbox — the Claude Code CLI refuses auto mode here, so switching to auto is blocked.');
    console.log('             Run Genie as a non-root user (docker run --user node …), or set IS_SANDBOX=1 inside a container you accept as disposable.');
    if (settings.mode === 'auto') console.log('             settings already say auto: every live run will fail with the CLI\'s own message until one of those changes.');
  }
  if (ALLOW_ORIGINS.length) console.log(`      cors    ${ALLOW_ORIGINS.join(', ')}`);
  console.log('');
}

let schedulerTimer = null;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} — stopping`);
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (active && !active.finished) { active.stopped = true; finishRun(active, 'stopped'); active.abortController.abort(); }
  while (queue.length) { const run = queue.shift(); run.stopped = true; finishRun(run, 'stopped'); }
  for (const conv of convs.values()) {
    if (conv.dirty || conv.timer) safe(() => persistConv(conv));
    for (const l of conv.listeners) { try { l.end(); } catch { /* fine */ } }
  }
  safe(persistSettings);
  safe(persistSchedules);
  server.close();
  setTimeout(() => process.exit(0), 150).unref();
}

async function main() {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(WORKSPACE, { recursive: true });
  mkdirSync(PATHS.commands, { recursive: true });
  KEY = loadKey();
  loadSettings();
  loadMemory();
  loadSchedules();
  loadConversations();
  driver = await createDriver({ kind: DRIVER_KIND, env: process.env, engine: E, log });
  driverInfo = driver.status || driverInfo;
  sdk = driver.kind === 'live' ? await loadSdk() : null;

  server.on('error', (err) => {
    console.error(`cannot listen on ${HOST}:${PORT} — ${err?.message || err}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    banner();
    schedulerTimer = setInterval(tickScheduler, SCHEDULER_MS);
    schedulerTimer.unref?.();
    tickScheduler();
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // A closed stdout/stderr pipe (the parent died) must not become a hot loop:
  // swallow write errors on the log streams, and never re-log an EPIPE.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  process.on('uncaughtException', (err) => { if (err?.code !== 'EPIPE') warn(`uncaught: ${err?.stack || err}`); });
  process.on('unhandledRejection', (err) => warn(`unhandled: ${err?.stack || err}`));
}

main().catch((err) => {
  console.error(`genie failed to start: ${err?.stack || err}`);
  process.exit(1);
});

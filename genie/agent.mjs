/**
 * genie/agent.mjs — the driver: how a Genie run actually happens.
 *
 * Two drivers, one interface (`{ kind, run(job) }`):
 *
 *   live       the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) drives
 *              the full Claude Code harness — shell, files, web, subagents,
 *              MCP — on the conversation's model, resuming its session.
 *   rehearsal  offline and deterministic: replays `engine.rehearsalScript()`
 *              with small gaps so every streaming, approval and stop path is
 *              exercised while NOTHING runs for real. It says so in its text.
 *
 * Process-neutral like scion/harness.mjs: no process.exit, no argv, loggers
 * injected, the SDK loaded lazily so a missing package is a status line, not
 * a crash. The server (server.mjs) owns memory/schedules/approvals and feeds
 * every SDK-shaped message back through the pure engine (engine.js) via
 * `onMessage`; this file never interprets messages beyond session bookkeeping.
 *
 * Two policy hooks belong here because they are SDK plumbing: the owner's
 * deny rules are enforced through a PreToolUse hook (the one gate the SDK
 * consults in every permission mode, including bypassPermissions), and an
 * AskUserQuestion answered by the owner reaches the tool as
 * `updatedInput.answers`, exactly as the Claude Code permission component
 * would hand them over.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const GAP_MS = 15; // rehearsal pacing: enough to interleave asks/stops, fast enough for tests

const ZERO_USAGE = {
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────── credentials & SDK ────────────────────────────── */

/**
 * Credentials the SDK can pick up: the env vars, or a stored `claude` login
 * credentials file. A keychain-only login (macOS) is invisible from here —
 * `claude setup-token` or an env var makes it visible.
 */
export function hasCredentials(env = process.env) {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return existsSync(join(configDir, '.credentials.json'));
}

/** Dynamic import; null when the package is missing (rehearsal takes the stage). */
export async function loadSdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    return null;
  }
}

async function sdkVersion() {
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const entry = req.resolve('@anthropic-ai/claude-agent-sdk');
    const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * Which driver would run right now, and why. `GENIE_DRIVER` in `env`
 * (`auto` | `live` | `rehearsal`) is honoured: `rehearsal` forces the offline
 * driver; `live` is a wish that still needs the SDK and credentials.
 */
export async function driverStatus(env = process.env) {
  const sdk = await loadSdk();
  const sdkInstalled = Boolean(sdk);
  const version = sdkInstalled ? await sdkVersion() : null;
  const credentials = hasCredentials(env);
  const wanted = String(env.GENIE_DRIVER || 'auto').toLowerCase();
  let kind = 'rehearsal';
  let reason;
  if (wanted === 'rehearsal') reason = 'GENIE_DRIVER=rehearsal';
  else if (!sdkInstalled) reason = '@anthropic-ai/claude-agent-sdk missing — npm install';
  else if (!credentials) reason = 'no credentials — set ANTHROPIC_API_KEY (or log in with `claude`; a keychain-only login is invisible here, run `claude setup-token`)';
  else { kind = 'live'; reason = wanted === 'live' ? 'GENIE_DRIVER=live' : 'SDK installed and credentials found'; }
  if (wanted === 'live' && kind !== 'live') reason = `GENIE_DRIVER=live but ${reason}`;
  return { kind, sdkInstalled, sdkVersion: version, credentials, reason };
}

/**
 * Build the driver. `kind` `'auto'` picks live when it can; `'live'` falls back
 * (loudly) to rehearsal when it cannot; `'rehearsal'` never touches the SDK.
 * Returns `{ kind, run(job), status }`.
 */
export async function createDriver({ kind = 'auto', env = process.env, engine, log = () => {} } = {}) {
  if (!engine) throw new Error('createDriver: engine is required');
  const status = await driverStatus({ ...env, GENIE_DRIVER: kind });
  if (status.kind === 'live') {
    const sdk = await loadSdk();
    if (sdk && typeof sdk.query === 'function') return { ...liveDriver(sdk, engine, env, log), status };
    status.kind = 'rehearsal';
    status.reason = 'SDK loaded but exposes no query() — rehearsing instead';
  }
  if (kind === 'live') log(`${status.reason} — rehearsing instead`);
  return { ...rehearsalDriver(engine, log), status };
}

/* ────────────────────────────── shared shapes ────────────────────────────── */

function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

function blocksOf(msg) {
  const c = msg?.message?.content;
  return Array.isArray(c) ? c : [];
}

function errText(err) {
  const name = err?.constructor?.name && err.constructor.name !== 'Error' ? `${err.constructor.name}: ` : '';
  return `${name}${String(err?.message ?? err)}`.slice(0, 600);
}

/** A result message shaped like the SDK's `error_during_execution`, so the reducer treats it as one. */
function errorResult(errors, sessionId, startedAt) {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: Math.max(0, Date.now() - (startedAt || Date.now())),
    duration_api_ms: 0,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: { ...ZERO_USAGE },
    modelUsage: {},
    permission_denials: [],
    errors: errors.map((e) => String(e)),
    uuid: `genie-${Date.now().toString(36)}`,
    session_id: sessionId || '',
  };
}

/* ────────────────────────────── live driver ────────────────────────────── */

function settingSourcesFrom(env) {
  const raw = env.GENIE_SETTING_SOURCES;
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter((s) => s === 'user' || s === 'project' || s === 'local');
}

/** Only a real SDK session id is worth resuming — rehearsal ids are ours. */
function resumable(sessionId) {
  return typeof sessionId === 'string' && sessionId && !sessionId.startsWith('rehearsal-') ? sessionId : undefined;
}

function lostSession(text) {
  return /no conversation found|session.{0,40}(not found|does not exist|missing|expired|unknown|invalid)|(not found|unknown|invalid).{0,40}session|could not resume|failed to resume|unable to resume/i.test(text || '');
}

/**
 * The owner's deny rules as a PreToolUse hook. `canUseTool` is skipped by the
 * SDK in bypassPermissions (auto) and for auto-allowed tools, but a hook runs
 * before every tool call in every mode, so a deny rule is a hard stop
 * wherever it is written. `getRules` is a getter: a rule added mid-run counts.
 */
function denyRuleHook(engine, getRules) {
  return async (input) => {
    const toolInput = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    let rule = null;
    try { rule = engine.findRule(getRules() || [], input?.tool_name, toolInput); } catch { return {}; }
    if (!rule || rule.behavior !== 'deny') return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `denied by rule ${rule.tool}:${rule.match}`,
      },
    };
  };
}

/** The answers an allow decision carries for AskUserQuestion, or null. */
function answersOf(decision) {
  const a = decision?.updatedInput?.answers;
  return a && typeof a === 'object' && !Array.isArray(a) ? a : null;
}

/**
 * Drive one query() to completion. Every message but the final `result` is
 * forwarded as it arrives; the result is returned to the caller, who decides
 * whether to forward it (a lost-session retry must not emit two results).
 */
async function iterate(sdk, prompt, options, onMessage) {
  const out = { sessionId: null, result: null, sawAssistant: false, threw: false, errorText: '' };
  try {
    for await (const msg of sdk.query({ prompt, options })) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) out.sessionId = msg.session_id;
      if (msg.type === 'assistant') out.sawAssistant = true;
      if (msg.type === 'result') {
        out.result = msg;
        if (!out.sessionId && msg.session_id) out.sessionId = msg.session_id;
        continue;
      }
      try { await onMessage(msg); } catch { /* a reducer hiccup never stops the run */ }
    }
  } catch (err) {
    out.threw = true;
    out.errorText = errText(err);
  }
  return out;
}

function liveDriver(sdk, engine, env, log) {
  return {
    kind: 'live',
    async run(job) {
      const {
        prompt, conversation = {}, settings = {}, systemAppend = '', mcpServers, agents,
        canUseTool, abortController, onMessage = async () => {},
      } = job;
      const startedAt = Date.now();
      const mode = settings.mode || 'trust';
      const getRules = typeof job.getRules === 'function' ? job.getRules : () => settings.rules || [];
      let stderrTail = '';
      // No `allowedTools`: a bare entry there is auto-approved before canUseTool
      // sees it, which would put Genie's own tools beyond the reach of a deny
      // rule. decide() already allows them; the hook below denies by rule.
      const base = compact({
        model: settings.model,
        cwd: settings.cwd || undefined,
        effort: settings.effort,
        maxTurns: settings.maxTurns,
        maxBudgetUsd: settings.maxUsd,
        includePartialMessages: true,
        forwardSubagentText: true,
        permissionMode: engine.sdkPermissionMode(mode),
        allowDangerouslySkipPermissions: mode === 'auto',
        canUseTool,
        hooks: { PreToolUse: [{ hooks: [denyRuleHook(engine, getRules)] }] },
        abortController,
        settingSources: settingSourcesFrom(env),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend, snapshot: false },
        mcpServers,
        agents,
        title: conversation.title || undefined,
        stderr: (data) => { stderrTail = (stderrTail + String(data)).slice(-4000); },
      });

      let resume = resumable(conversation.sessionId);
      for (let attempt = 0; ; attempt++) {
        const options = resume ? { ...base, resume } : base;
        const out = await iterate(sdk, prompt, options, onMessage);
        const aborted = Boolean(abortController?.signal?.aborted);
        const failedEarly = !out.sawAssistant && (out.threw || (out.result && out.result.is_error));
        const errorText = [out.errorText, ...(out.result?.errors || []), stderrTail.trim()].filter(Boolean).join(' | ');

        if (resume && attempt === 0 && !aborted && failedEarly && lostSession(errorText)) {
          log(`session ${resume} is gone — starting a fresh one`);
          try {
            await onMessage({ type: 'system', subtype: 'status', status: 'session lost — started a fresh one', uuid: 'genie-session-lost', session_id: '' });
          } catch { /* informational */ }
          resume = undefined;
          stderrTail = '';
          continue;
        }

        let result = out.result;
        if (!result) result = errorResult(aborted ? ['stopped'] : [errorText || 'the SDK ended without a result'], out.sessionId, startedAt);
        else if (out.threw && !aborted) result = { ...result, errors: [...(result.errors || []), out.errorText] };
        try { await onMessage(result); } catch { /* never rethrow into the server */ }
        return { sessionId: out.sessionId, result };
      }
    },
  };
}

/* ────────────────────────────── rehearsal driver ────────────────────────────── */

function rehearsalDriver(engine, log) {
  return {
    kind: 'rehearsal',
    async run(job) {
      const { prompt, settings = {}, canUseTool, abortController, onMessage = async () => {} } = job;
      const signal = abortController?.signal;
      const startedAt = Date.now();
      let script = [];
      try {
        script = engine.rehearsalScript(String(prompt ?? ''), { mode: settings.mode || 'trust', cwd: settings.cwd || process.cwd(), now: startedAt }) || [];
      } catch (err) {
        log(`rehearsal script failed: ${errText(err)}`);
      }

      let sessionId = null;
      let result = null;
      const outcomes = new Map(); // tool_use id → { content, is_error } standing in for the scripted tool_result
      const denials = [];

      for (const raw of script) {
        if (signal?.aborted) break;
        await sleep(GAP_MS);
        if (signal?.aborted) break;
        if (!raw || typeof raw !== 'object') continue;
        let msg = raw;

        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) sessionId = msg.session_id;

        if (msg.type === 'result') {
          result = denials.length ? { ...msg, permission_denials: [...(msg.permission_denials || []), ...denials] } : msg;
          continue;
        }

        if (msg.type === 'user' && Array.isArray(msg.message?.content) && outcomes.size) {
          const content = msg.message.content.map((b) => (
            b && b.type === 'tool_result' && outcomes.has(b.tool_use_id) ? { ...b, ...outcomes.get(b.tool_use_id) } : b
          ));
          msg = { ...msg, message: { ...msg.message, content } };
        }

        try { await onMessage(msg); } catch { /* a reducer hiccup never stops the run */ }

        // The harness asks AFTER the tool card exists and BEFORE its result, like the SDK does.
        if (msg.type === 'assistant' && typeof canUseTool === 'function') {
          for (const b of blocksOf(msg)) {
            if (!b || b.type !== 'tool_use') continue;
            const input = b.input && typeof b.input === 'object' ? b.input : {};
            let decision;
            try {
              decision = await canUseTool(b.name, input, { signal, toolUseId: b.id, toolUseID: b.id, requestId: b.id });
            } catch (err) {
              decision = { behavior: 'deny', message: errText(err) };
            }
            if (decision && decision.behavior === 'deny') {
              outcomes.set(b.id, { content: decision.message || 'denied', is_error: true });
              denials.push({ tool_name: b.name, tool_use_id: b.id, tool_input: input });
              continue;
            }
            // An answered question reads back what the owner said, as the real tool would.
            const answers = answersOf(decision);
            if (answers) {
              const answered = Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('; ');
              outcomes.set(b.id, { content: `answered: ${answered}`, is_error: false });
            }
          }
        }
      }

      if (!result) result = errorResult(signal?.aborted ? ['stopped'] : ['rehearsal ended without a result'], sessionId, startedAt);
      try { await onMessage(result); } catch { /* never rethrow into the server */ }
      return { sessionId, result };
    },
  };
}

/* ────────────────────────────── subagents (live only) ────────────────────────────── */

/**
 * Genie's court: three subagents the SDK can delegate to via Task/Agent.
 * `researcher` runs on the fast model (or the main one when that is already
 * the cheapest); `coder` and `reviewer` inherit tools/model by omission.
 */
export function courtiers(model) {
  const researcherModel = model === 'claude-haiku-4-5' ? model : 'claude-sonnet-5';
  return {
    researcher: {
      description: 'finds and reads: web, files, docs — never writes',
      prompt: 'You are Genie\'s researcher. Find and read what is asked — web pages, files, docs — and report back what matters: facts, quotes with their sources, exact paths and line numbers. You never write, edit or run anything; you only look. Be concise and concrete.',
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      model: researcherModel,
    },
    coder: {
      description: 'implements a scoped change and runs its tests',
      prompt: 'You are Genie\'s coder. Implement exactly the scoped change you were given, in the existing style of the codebase, then run the relevant tests and fix what you broke. Report what you changed (files, functions) and the test result plainly. Do not expand the scope.',
    },
    reviewer: {
      description: 'adversarial reviewer: tries to break the work before it ships',
      prompt: 'You are Genie\'s reviewer. Your job is to break the work before it ships: read the change, look for wrong behaviour, missed edge cases, security holes and anything untested, and run commands that would expose them. Report findings ranked by severity with file and line; say clearly when you found nothing.',
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
    },
  };
}

/* ────────────────────────────── in-process MCP tools ────────────────────────────── */

/**
 * Genie's own tools as an in-process MCP server named `genie` (so the SDK
 * exposes them as `mcp__genie__<name>`). The server owns memory and
 * schedules and passes plain async handlers `{ remember, forget, schedule,
 * unschedule, list_schedules, notify }` that return a string (or throw); this
 * is the only place zod is touched. Async because zod is imported lazily —
 * rehearsal must never need it.
 */
export async function buildGenieMcp(sdk, handlers = {}) {
  const { z } = await import('zod');
  const text = (t) => ({ content: [{ type: 'text', text: String(t ?? '') }] });
  const wrap = (name) => async (args) => {
    const fn = handlers[name];
    if (typeof fn !== 'function') return { content: [{ type: 'text', text: `${name}: not available` }], isError: true };
    try {
      return text(await fn(args || {}));
    } catch (err) {
      return { content: [{ type: 'text', text: `${name} failed: ${errText(err)}` }], isError: true };
    }
  };
  const tools = [
    sdk.tool('remember', 'Save one durable fact about the owner or their world to Genie\'s memory, so future conversations know it. One line; never write the memory file by hand.',
      { fact: z.string().describe('the fact, one line, ≤ 500 chars') }, wrap('remember')),
    sdk.tool('forget', 'Remove a remembered fact by its number (as listed under "What you remember"), or "all".',
      { n: z.union([z.number().int(), z.string()]).describe('1-based entry number, or "all"') }, wrap('forget')),
    sdk.tool('schedule', 'Create a standing order: run a task on a schedule. `when` grammar: "every 30m", "every 2 hours", "hourly", "daily at 09:00", "weekdays at 08:30", "weekends at 10am", "every monday at 7:00", "every mon,wed,fri at 18:00", "at 22:00", or "cron 0 9 * * 1-5".',
      { when: z.string().describe('the schedule spec'), task: z.string().describe('the instruction to run each time, ≤ 2000 chars') }, wrap('schedule')),
    sdk.tool('unschedule', 'Cancel a standing order by its id (see list_schedules).',
      { id: z.string().describe('the schedule id, e.g. s1a2b3c4d5') }, wrap('unschedule')),
    sdk.tool('list_schedules', 'List the active standing orders with their ids, schedules and next run times.',
      {}, wrap('list_schedules')),
    sdk.tool('notify', 'Send the owner a phone notification — use it when a long job finishes or needs their attention.',
      { title: z.string().describe('short title'), body: z.string().optional().describe('one or two lines') }, wrap('notify')),
  ];
  return sdk.createSdkMcpServer({ name: 'genie', version: '1.0.0', tools });
}

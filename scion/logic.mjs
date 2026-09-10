/**
 * scion/logic.mjs — the succession engine.
 *
 * This repository was built by Claude (claude-fable-5). A scion is its
 * successor: an autonomous agent harness, built on the Claude Agent SDK,
 * that runs missions on the most capable model in the lineage — and falls
 * down the ladder rung by rung when a model is unavailable, so a mission
 * always finds a mind to run on.
 *
 * Pure functions only: no I/O, no clock. Callers pass `now` (ms epoch).
 */

// The model that built this repo. The scion exists to surpass it.
export const ANCESTOR = 'claude-fable-5';

/**
 * The succession ladder, most capable first. Prices are $/MTok so the
 * mission ledger can meter an honest dollar estimate turn by turn
 * (the SDK's own total_cost_usd, when reported, is preferred in the
 * debrief — the estimate is the cross-check).
 */
export const LINEAGE = Object.freeze([
  { id: 'claude-fable-5-1', title: 'the scion', inPerMTok: 10, outPerMTok: 50, cacheReadPerMTok: 0.25 },
  { id: 'claude-opus-5', title: 'the regent', inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5 },
  { id: 'claude-sonnet-5', title: 'the envoy', inPerMTok: 2, outPerMTok: 10, cacheReadPerMTok: 0.2 },
  { id: 'claude-haiku-4-5', title: 'the page', inPerMTok: 1, outPerMTok: 5, cacheReadPerMTok: 0.1 },
]);

export const SUCCESSOR = LINEAGE[0].id; // the powerful successor itself
const CACHE_WRITE_MULTIPLIER = 1.25; // cache writes bill at 1.25x input

export const round4 = (n) => Math.round(n * 10_000) / 10_000;

export function rungFor(modelId) {
  return LINEAGE.find((r) => r.id === modelId) ?? null;
}

/** Everyone the mission may run on, starting at `preferred`, best first. */
export function successionPlan(preferred = SUCCESSOR) {
  const i = LINEAGE.findIndex((r) => r.id === preferred);
  return (i === -1 ? LINEAGE : LINEAGE.slice(i)).map((r) => r.id);
}

/** Dollar cost of one turn's usage on a model. Unknown models cost 0. */
export function costOfUsage(modelId, usage = {}) {
  const rung = rungFor(modelId);
  if (!rung) return 0;
  const per = (tokens, dollarsPerMTok) => ((tokens ?? 0) / 1_000_000) * dollarsPerMTok;
  return round4(
    per(usage.input_tokens, rung.inPerMTok) +
      per(usage.output_tokens, rung.outPerMTok) +
      per(usage.cache_read_input_tokens, rung.cacheReadPerMTok) +
      per(usage.cache_creation_input_tokens, rung.inPerMTok * CACHE_WRITE_MULTIPLIER),
  );
}

export const DEFAULT_LIMITS = Object.freeze({ maxTurns: 30, maxUsd: 5 });

export function newMission(id, brief, now, opts = {}) {
  const model = opts.model || SUCCESSOR;
  return {
    id,
    brief,
    born: now,
    model,
    limits: {
      maxTurns: opts.maxTurns ?? DEFAULT_LIMITS.maxTurns,
      maxUsd: opts.maxUsd ?? DEFAULT_LIMITS.maxUsd,
    },
    status: 'planned', // planned → running → succeeded | failed | rehearsed
    outcome: null, // the SDK result subtype (or 'offline'), verbatim
    turns: 0,
    toolCalls: 0,
    estimatedUsd: 0, // metered here from usage
    reportedUsd: null, // the SDK's own total_cost_usd, when it says
    result: null,
    endedAt: null,
    ledger: [{ at: now, type: 'planned', note: `mission accepted for ${model}` }],
  };
}

export function beginMission(mission, now) {
  return {
    ...mission,
    status: 'running',
    ledger: [...mission.ledger, { at: now, type: 'begin', note: `running on ${mission.model}` }],
  };
}

/** Record one assistant turn: usage metered, tool calls counted. */
export function recordTurn(mission, { usage, toolUses = 0 } = {}, now) {
  const spent = costOfUsage(mission.model, usage);
  return {
    ...mission,
    turns: mission.turns + 1,
    toolCalls: mission.toolCalls + toolUses,
    estimatedUsd: round4(mission.estimatedUsd + spent),
    ledger: [
      ...mission.ledger,
      { at: now, type: 'turn', note: `turn ${mission.turns + 1}: ${toolUses} tool call(s), ~$${spent.toFixed(4)}` },
    ],
  };
}

/**
 * Map an SDK result subtype to how the mission ends. Anything the SDK
 * reports that we don't know reads as failure — never silent success.
 */
export function outcomeOf(subtype) {
  if (subtype === 'success') return 'succeeded';
  if (subtype === 'offline') return 'rehearsed';
  return 'failed';
}

export function endMission(mission, { subtype, result = null, reportedUsd = null }, now) {
  const status = outcomeOf(subtype);
  return {
    ...mission,
    status,
    outcome: subtype,
    result,
    reportedUsd,
    endedAt: now,
    ledger: [...mission.ledger, { at: now, type: 'end', note: `${status} (${subtype})` }],
  };
}

/**
 * Pure guardrail the CLI checks before launching: the SDK enforces
 * maxTurns/maxBudgetUsd itself mid-flight, but a mission that is
 * malformed on arrival should never launch at all.
 */
export function fitToLaunch(mission) {
  if (!mission.brief || !mission.brief.trim()) return { ok: false, reason: 'empty brief — a mission needs orders' };
  if (mission.limits.maxTurns < 1) return { ok: false, reason: 'maxTurns must be at least 1' };
  if (mission.limits.maxUsd <= 0) return { ok: false, reason: 'budget must be above $0' };
  if (mission.brief.length > 20_000) return { ok: false, reason: 'brief too long — put big material in files and reference them' };
  return { ok: true, reason: null };
}

/** What the scion is told over and above the Agent SDK's own harness prompt. */
export const CONSTITUTION = `You are a scion: the successor of the agent that built this
repository, run on the most capable model in your lineage. Honour the inheritance:
work honestly, verify before you claim, keep every change minimal and reversible,
never run destructive commands, and stay inside the mission's working directory.
When the mission is done, state plainly what you did and what you did not do.`;

// The default tool posture: everything useful, nothing that executes
// arbitrary shell. `trust` adds Bash; `yolo` bypasses permissions entirely.
export const SAFE_TOOLS = Object.freeze([
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Agent', 'TaskCreate', 'TaskUpdate',
]);

/**
 * The scion's court: subagents the main loop can dispatch. The scout reads
 * and reports on the cheaper envoy model; the auditor adversarially reviews
 * on whatever model the mission runs on.
 */
export function courtiers() {
  return {
    scout: {
      description: 'Fast read-only researcher: finds files, reads code, reports facts back.',
      prompt: 'You are the scout. Read and search only — never modify anything. Report findings as terse facts with file paths.',
      tools: ['Read', 'Glob', 'Grep'],
      model: 'claude-sonnet-5',
    },
    auditor: {
      description: 'Adversarial reviewer: tries to refute the work before it ships.',
      prompt: 'You are the auditor. Adversarially review the work you are shown: hunt for bugs, unverified claims, and shortcuts. Report only findings you can support with evidence.',
      tools: ['Read', 'Glob', 'Grep'],
      model: 'inherit',
    },
  };
}

/** Map a mission to the Agent SDK's query() options object. Pure. */
export function buildOptions(mission, { cwd = null, trust = false, yolo = false, effort = 'xhigh' } = {}) {
  const options = {
    model: mission.model,
    appendSystemPrompt: CONSTITUTION,
    maxTurns: mission.limits.maxTurns,
    maxBudgetUsd: mission.limits.maxUsd,
    effort,
    agents: courtiers(),
    settingSources: [], // a scion carries its own doctrine, not the host's
  };
  if (cwd) options.cwd = cwd;
  if (yolo) {
    options.permissionMode = 'bypassPermissions';
    options.allowDangerouslySkipPermissions = true;
  } else {
    options.permissionMode = 'acceptEdits';
    options.allowedTools = trust ? [...SAFE_TOOLS, 'Bash'] : [...SAFE_TOOLS];
  }
  return options;
}

/** Parse CLI argv (after node + script). Pure, so the flag surface is pinned. */
export function parseArgs(argv) {
  const flags = { model: SUCCESSOR, maxTurns: null, maxUsd: null, cwd: null, trust: false, yolo: false, effort: 'xhigh' };
  const words = [];
  const takesValue = { '--model': 'model', '--max-turns': 'maxTurns', '--budget': 'maxUsd', '--cwd': 'cwd', '--effort': 'effort' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--trust') flags.trust = true;
    else if (arg === '--yolo') flags.yolo = true;
    else if (takesValue[arg]) {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, error: `${arg} needs a value` };
      flags[takesValue[arg]] = value;
      i += 1;
    } else if (arg.startsWith('--')) return { ok: false, error: `unknown flag ${arg}` };
    else words.push(arg);
  }
  for (const key of ['maxTurns', 'maxUsd']) {
    if (flags[key] !== null) {
      const n = Number(flags[key]);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `--${key === 'maxUsd' ? 'budget' : 'max-turns'} must be a positive number` };
      flags[key] = n;
    }
  }
  return { ok: true, command: words[0] === 'status' && words.length === 1 ? 'status' : 'run', brief: words.join(' '), flags };
}

/** The mission report — what happened, on the record. */
export function debrief(mission, now = mission.endedAt) {
  const lived = Math.max(0, (now ?? mission.born) - mission.born);
  const spent = mission.reportedUsd ?? mission.estimatedUsd;
  const spentLabel = mission.reportedUsd === null ? 'estimated' : 'reported by the SDK';
  return [
    `# mission ${mission.id} — ${mission.status}`,
    '',
    `- model: ${mission.model}${mission.model === SUCCESSOR ? ` (successor of ${ANCESTOR})` : ''}`,
    `- outcome: ${mission.outcome ?? 'never launched'}`,
    `- turns: ${mission.turns}, tool calls: ${mission.toolCalls}`,
    `- spend: $${spent.toFixed(4)} (${spentLabel}), budget $${mission.limits.maxUsd.toFixed(2)}`,
    `- wall clock: ${(lived / 1000).toFixed(1)}s`,
    '',
    mission.result ? String(mission.result).trim() : '(no result text)',
  ].join('\n');
}

/**
 * The understudy: what runs when the Agent SDK or credentials are absent.
 * Deterministic — same mission in, same rehearsal out — so the whole CLI
 * works (and is testable) anywhere, exactly like automaton's offline brain.
 */
export function understudyResult(mission) {
  const firstLine = mission.brief.trim().split(/\n/, 1)[0].slice(0, 120);
  return [
    `(understudy rehearsal — no live model)`,
    `Mission understood: ${firstLine}`,
    `Succession plan: ${successionPlan(mission.model).join(' → ') || mission.model}`,
    'To run this for real: npm install, set ANTHROPIC_API_KEY, and run the same command again.',
  ].join('\n');
}

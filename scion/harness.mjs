/**
 * scion/harness.mjs — how a mission actually runs.
 *
 * If the Claude Agent SDK and credentials are present, the mission runs
 * live: query() drives the full Claude Code harness (file tools, search,
 * subagents) on the mission's model. Otherwise the deterministic
 * understudy rehearses the mission so the CLI works anywhere.
 *
 * Process-neutral like automaton/agent.mjs: no process.exit, no argv,
 * loggers injected.
 */
import {
  beginMission, recordTurn, endMission, buildOptions, understudyResult,
} from './logic.mjs';

/** Credentials any of the SDK's auth paths can pick up. */
export function hasCredentials(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN);
}

async function loadSdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    return null; // not installed — the understudy takes the stage
  }
}

/** Which harness would run right now, and why. Used by `scion status`. */
export async function harnessStatus(env = process.env) {
  const sdk = Boolean(await loadSdk());
  const creds = hasCredentials(env);
  return {
    harness: sdk && creds ? 'live' : 'understudy',
    sdk: sdk ? '@anthropic-ai/claude-agent-sdk installed' : '@anthropic-ai/claude-agent-sdk missing — npm install',
    credentials: creds
      ? 'found (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN)'
      : 'none — set ANTHROPIC_API_KEY',
  };
}

/**
 * Run one mission to completion. Returns the ended mission state.
 * `say` narrates progress; `clock` supplies time (ms epoch) so tests
 * can drive it deterministically.
 */
export async function runMission(mission, opts = {}, say = () => {}, clock = Date.now) {
  const sdk = await loadSdk();
  if (!sdk || !hasCredentials(opts.env ?? process.env)) {
    say('no live harness (SDK or credentials missing) — the understudy rehearses instead.');
    let m = beginMission(mission, clock());
    return endMission(m, { subtype: 'offline', result: understudyResult(m) }, clock());
  }

  const options = buildOptions(mission, opts);
  let m = beginMission(mission, clock());
  say(`mission ${m.id} live on ${m.model} (≤${m.limits.maxTurns} turns, ≤$${m.limits.maxUsd.toFixed(2)})`);

  let ended = null;
  try {
    for await (const message of sdk.query({ prompt: m.brief, options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        say(`  session ${message.session_id}`);
      } else if (message.type === 'assistant') {
        const blocks = message.message?.content ?? [];
        const toolUses = blocks.filter((b) => b.type === 'tool_use').length;
        for (const b of blocks) {
          if (b.type === 'text' && b.text.trim()) say(`  ${b.text.trim().split('\n', 1)[0].slice(0, 100)}`);
          if (b.type === 'tool_use') say(`  → ${b.name}`);
        }
        m = recordTurn(m, { usage: message.message?.usage, toolUses }, clock());
      } else if (message.type === 'result') {
        ended = endMission(
          m,
          {
            subtype: message.subtype,
            result: message.subtype === 'success' ? message.result : `(${message.subtype})`,
            reportedUsd: message.total_cost_usd ?? null,
          },
          clock(),
        );
      }
    }
  } catch (err) {
    if (!ended) {
      const note = `${err?.constructor?.name ?? 'Error'} — ${String(err?.message ?? err).slice(0, 200)}`;
      say(`  harness error: ${note}`);
      ended = endMission(m, { subtype: 'error_during_execution', result: note }, clock());
    }
  }
  return ended ?? endMission(m, { subtype: 'error_during_execution', result: '(no result message)' }, clock());
}

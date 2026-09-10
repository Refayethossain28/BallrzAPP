#!/usr/bin/env node
/**
 * Unit tests for scion/ — the succession engine: the lineage ladder and
 * fallback plan, per-model dollar metering (cache reads and writes
 * included), the mission ledger and its outcomes, launch guardrails,
 * the Agent SDK options mapping (tool posture: safe by default, Bash
 * only with --trust, bypass only with --yolo), CLI flag parsing, the
 * debrief, and the deterministic offline understudy.
 * Run: node scripts/test-scion-logic.mjs
 */
import assert from 'node:assert/strict';
import {
  ANCESTOR, LINEAGE, SUCCESSOR, rungFor, successionPlan, costOfUsage, round4,
  DEFAULT_LIMITS, newMission, beginMission, recordTurn, outcomeOf, endMission,
  fitToLaunch, CONSTITUTION, SAFE_TOOLS, WEB_TOOLS, EFFORT_LEVELS, sanitize,
  powersLabel, courtiers, buildOptions, parseArgs, debrief, understudyResult,
} from '../scion/logic.mjs';

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

test('lineage: the successor of claude-fable-5 leads, prices strictly descend', () => {
  assert.equal(SUCCESSOR, 'claude-fable-5-1');
  assert.equal(LINEAGE[0].id, SUCCESSOR);
  assert.equal(LINEAGE.some((r) => r.id === ANCESTOR), false); // the ancestor is succeeded, not a rung
  for (let i = 1; i < LINEAGE.length; i += 1) {
    assert.ok(LINEAGE[i].outPerMTok < LINEAGE[i - 1].outPerMTok, `${LINEAGE[i].id} cheaper than ${LINEAGE[i - 1].id}`);
  }
  assert.equal(rungFor('claude-opus-5').title, 'the regent');
  assert.equal(rungFor('gpt-99'), null);
});

test('succession plan: starts at the preferred rung and walks down', () => {
  assert.deepEqual(successionPlan(), LINEAGE.map((r) => r.id));
  assert.deepEqual(successionPlan('claude-sonnet-5'), ['claude-sonnet-5', 'claude-haiku-4-5']);
  assert.deepEqual(successionPlan('not-a-model'), LINEAGE.map((r) => r.id)); // unknown → full ladder
});

test('metering: input, output, cache reads and 1.25x cache writes, to 4dp', () => {
  const usage = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 };
  // fable-5-1: 0.01 in + 0.10 out + 0.025 cache read + 0.125 cache write
  assert.equal(costOfUsage('claude-fable-5-1', usage), 0.26);
  assert.equal(costOfUsage('claude-haiku-4-5', { output_tokens: 1_000_000 }), 5);
  assert.equal(costOfUsage('claude-opus-5', {}), 0);
  assert.equal(costOfUsage('unknown-model', usage), 0);
  assert.equal(round4(0.1 + 0.2), 0.3); // no float drift in the ledger
});

test('mission: born planned on the successor with sane default limits', () => {
  const m = newMission('m1', 'audit the fare engine', T0);
  assert.equal(m.status, 'planned');
  assert.equal(m.model, SUCCESSOR);
  assert.deepEqual(m.limits, { maxTurns: DEFAULT_LIMITS.maxTurns, maxUsd: DEFAULT_LIMITS.maxUsd });
  assert.equal(m.ledger.length, 1);
  assert.match(m.ledger[0].note, /claude-fable-5-1/);
});

test('mission ledger: turns and tool calls accumulate with metered dollars', () => {
  let m = newMission('m2', 'brief', T0, { model: 'claude-opus-5' });
  m = beginMission(m, T0 + 1);
  assert.equal(m.status, 'running');
  m = recordTurn(m, { usage: { input_tokens: 1_000_000 }, toolUses: 3 }, T0 + 2);
  m = recordTurn(m, { usage: { output_tokens: 1_000_000 }, toolUses: 1 }, T0 + 3);
  assert.equal(m.turns, 2);
  assert.equal(m.toolCalls, 4);
  assert.equal(m.estimatedUsd, 30); // $5 input + $25 output on opus-5
  assert.equal(m.ledger.at(-1).type, 'turn');
});

test('outcomes: success succeeds, offline rehearses, everything else fails', () => {
  assert.equal(outcomeOf('success'), 'succeeded');
  assert.equal(outcomeOf('offline'), 'rehearsed');
  assert.equal(outcomeOf('error_max_turns'), 'failed');
  assert.equal(outcomeOf('error_max_budget_usd'), 'failed');
  assert.equal(outcomeOf('error_during_execution'), 'failed');
  assert.equal(outcomeOf('some_future_subtype'), 'failed'); // never silent success
});

test('ending a mission records the verdict, the result and the SDK bill', () => {
  let m = beginMission(newMission('m3', 'brief', T0), T0 + 1);
  m = endMission(m, { subtype: 'success', result: 'done.', reportedUsd: 0.42 }, T0 + 9);
  assert.equal(m.status, 'succeeded');
  assert.equal(m.outcome, 'success');
  assert.equal(m.result, 'done.');
  assert.equal(m.reportedUsd, 0.42);
  assert.equal(m.endedAt, T0 + 9);
  assert.match(m.ledger.at(-1).note, /succeeded \(success\)/);
});

test('launch guardrails: no empty briefs, no zero budgets, no epic briefs', () => {
  assert.equal(fitToLaunch(newMission('m', 'do the work', T0)).ok, true);
  assert.equal(fitToLaunch(newMission('m', '   ', T0)).ok, false);
  assert.equal(fitToLaunch(newMission('m', 'x', T0, { maxTurns: 0 })).ok, false);
  assert.equal(fitToLaunch(newMission('m', 'x', T0, { maxUsd: 0 })).ok, false);
  assert.equal(fitToLaunch(newMission('m', 'x'.repeat(20_001), T0)).ok, false);
});

test('options: safe posture RESTRICTS the surface — no Bash, no web, edits accepted', () => {
  const o = buildOptions(newMission('m', 'brief', T0));
  assert.equal(o.model, SUCCESSOR);
  assert.equal(o.appendSystemPrompt, CONSTITUTION);
  assert.equal(o.permissionMode, 'acceptEdits');
  // `tools` limits what exists (allowedTools alone only pre-approves);
  // the same list is pre-approved so a headless run never stalls.
  assert.deepEqual(o.tools, [...SAFE_TOOLS]);
  assert.deepEqual(o.allowedTools, [...SAFE_TOOLS]);
  assert.equal(o.tools.includes('Bash'), false);
  for (const webTool of WEB_TOOLS) assert.equal(o.tools.includes(webTool), false);
  assert.equal(o.maxTurns, DEFAULT_LIMITS.maxTurns);
  assert.equal(o.maxBudgetUsd, DEFAULT_LIMITS.maxUsd);
  assert.equal(o.effort, 'xhigh');
  assert.deepEqual(o.settingSources, []);
  assert.equal('cwd' in o, false);
  assert.equal('allowDangerouslySkipPermissions' in o, false);
});

test('options: --web adds the web tools, --trust adds Bash, sources unmutated', () => {
  const webbed = buildOptions(newMission('m', 'brief', T0), { web: true });
  for (const webTool of WEB_TOOLS) assert.equal(webbed.tools.includes(webTool), true);
  assert.equal(webbed.tools.includes('Bash'), false);
  const trusted = buildOptions(newMission('m', 'brief', T0), { trust: true, cwd: '/tmp/ws' });
  assert.equal(trusted.tools.includes('Bash'), true);
  assert.equal(trusted.allowedTools.includes('Bash'), true);
  assert.equal(trusted.tools.includes('WebFetch'), false);
  assert.equal(SAFE_TOOLS.includes('Bash'), false); // frozen source untouched
  assert.equal(trusted.cwd, '/tmp/ws');
});

test('options: --yolo bypasses permissions and lifts the surface restriction', () => {
  const yolo = buildOptions(newMission('m', 'brief', T0), { yolo: true });
  assert.equal(yolo.permissionMode, 'bypassPermissions');
  assert.equal(yolo.allowDangerouslySkipPermissions, true);
  assert.equal('allowedTools' in yolo, false);
  assert.equal('tools' in yolo, false);
});

test('the court: scout and auditor are read-only, scout on the cheap envoy', () => {
  const court = courtiers();
  assert.deepEqual(Object.keys(court).sort(), ['auditor', 'scout']);
  for (const agent of Object.values(court)) {
    assert.deepEqual(agent.tools, ['Read', 'Glob', 'Grep']);
    assert.ok(agent.description && agent.prompt);
  }
  assert.equal(court.scout.model, 'claude-sonnet-5');
  assert.equal(court.auditor.model, 'inherit');
});

test('argv: flags parse, briefs join, garbage is refused', () => {
  const p = parseArgs(['--model', 'claude-opus-5', '--budget', '2.5', '--trust', '--web', 'fix', 'the', 'tests']);
  assert.equal(p.ok, true);
  assert.equal(p.command, 'run');
  assert.equal(p.brief, 'fix the tests');
  assert.equal(p.flags.model, 'claude-opus-5');
  assert.equal(p.flags.maxUsd, 2.5);
  assert.equal(p.flags.trust, true);
  assert.equal(p.flags.web, true);
  assert.equal(parseArgs(['status']).command, 'status');
  assert.equal(parseArgs(['status', 'extra']).command, 'run'); // "status" can still open a brief
  assert.equal(parseArgs(['--warp-speed']).ok, false);
  assert.equal(parseArgs(['--model']).ok, false);
  assert.equal(parseArgs(['--budget', '-1', 'x']).ok, false);
  assert.equal(parseArgs(['--max-turns', 'many', 'x']).ok, false);
});

test('argv: Object.prototype words are brief words, never flags', () => {
  const p = parseArgs(['fix', 'the', 'constructor', 'of', 'the', 'class']);
  assert.equal(p.ok, true);
  assert.equal(p.brief, 'fix the constructor of the class'); // nothing swallowed
  for (const word of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const q = parseArgs([word, 'is', 'broken']);
    assert.equal(q.ok, true);
    assert.equal(q.brief, `${word} is broken`);
    assert.equal(q.flags.model, SUCCESSOR); // flags untouched by prototype lookups
  }
});

test('argv: a flag is never accepted as another flag\'s value', () => {
  assert.equal(parseArgs(['--model', '--trust', 'brief']).ok, false); // --trust not silently eaten
  assert.equal(parseArgs(['--cwd', '--yolo', 'brief']).ok, false);
  assert.equal(parseArgs(['--effort', '--trust', 'brief']).ok, false);
});

test('argv: --effort only accepts the five SDK levels', () => {
  for (const level of EFFORT_LEVELS) assert.equal(parseArgs(['--effort', level, 'x']).ok, true);
  assert.equal(parseArgs(['--effort', 'ultra', 'x']).ok, false);
  assert.equal(parseArgs(['--effort', 'xigh', 'x']).ok, false);
});

test('powers: one honest label per posture, recorded on the mission', () => {
  assert.equal(powersLabel(), 'safe');
  assert.equal(powersLabel({ web: true }), 'safe+web');
  assert.equal(powersLabel({ trust: true }), 'safe+bash');
  assert.equal(powersLabel({ web: true, trust: true }), 'safe+web+bash');
  assert.equal(powersLabel({ yolo: true, trust: true }), 'yolo (permissions bypassed)');
  const m = newMission('m', 'brief', T0, { powers: powersLabel({ trust: true }) });
  assert.equal(m.powers, 'safe+bash');
  assert.match(m.ledger[0].note, /powers: safe\+bash/);
  assert.equal(newMission('m', 'brief', T0).powers, 'safe');
});

test('sanitize: strips ANSI escapes and control chars, keeps tabs and newlines', () => {
  assert.equal(sanitize('a\x1b[31mred\x1b[0mb'), 'a[31mred[0mb'); // ESC gone, text stays
  assert.equal(sanitize('ding\x07\x00\x9b31m'), 'ding31m');
  assert.equal(sanitize('line1\nline2\tend'), 'line1\nline2\tend');
});

test('debrief: reports the verdict, the lineage note and whose bill it quotes', () => {
  let m = beginMission(newMission('m4', 'brief', T0), T0);
  m = recordTurn(m, { usage: { output_tokens: 100_000 }, toolUses: 1 }, T0 + 1);
  const estimated = debrief(endMission(m, { subtype: 'error_max_turns', result: null }, T0 + 5000));
  assert.match(estimated, /mission m4 — failed/);
  assert.match(estimated, new RegExp(`successor of ${ANCESTOR}`));
  assert.match(estimated, /powers: safe/);
  assert.match(estimated, /\(estimated\)/);
  assert.match(estimated, /5\.0s/);
  assert.match(estimated, /\(no result text\)/);
  const reported = debrief(endMission(m, { subtype: 'success', result: 'shipped\x1b[2Jclean', reportedUsd: 1.5 }, T0 + 5000));
  assert.match(reported, /\$1\.5000 \(reported by the SDK\)/);
  assert.match(reported, /shipped\[2Jclean/); // result text is control-stripped
});

test('the understudy rehearses deterministically and names the succession plan', () => {
  const m = newMission('m5', 'refactor the engine\nwith care', T0);
  const once = understudyResult(m);
  assert.equal(understudyResult(m), once); // same mission, same rehearsal
  assert.match(once, /understudy rehearsal/);
  assert.match(once, /Mission understood: refactor the engine/);
  assert.match(once, /claude-fable-5-1 → claude-opus-5 → claude-sonnet-5 → claude-haiku-4-5/);
  assert.match(once, /ANTHROPIC_API_KEY/);
});

console.log(`\nscion logic: ${passed} tests passed`);

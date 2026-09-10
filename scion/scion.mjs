#!/usr/bin/env node
/**
 * scion/scion.mjs — the successor's command line.
 *
 *   node scion/scion.mjs "refactor the fare engine and prove it with tests"
 *   node scion/scion.mjs --model claude-opus-5 --budget 2 "audit storage.rules"
 *   node scion/scion.mjs --trust "run the test suite and fix what fails"
 *   node scion/scion.mjs status
 *
 * Flags: --model <id>  --max-turns <n>  --budget <usd>  --cwd <dir>
 *        --effort <low|medium|high|xhigh|max>
 *        --trust (adds Bash to the allowed tools)
 *        --yolo  (bypasses permissions — isolated environments only)
 */
import { newMission, fitToLaunch, parseArgs, debrief, SUCCESSOR, ANCESTOR } from './logic.mjs';
import { runMission, harnessStatus } from './harness.mjs';

const say = (line) => console.log(line);

const USAGE = `scion — a powerful successor to ${ANCESTOR}, on the Claude Agent SDK

usage: node scion/scion.mjs [flags] "<mission brief>"
       node scion/scion.mjs status

flags: --model <id>      model to run (default ${SUCCESSOR})
       --max-turns <n>   turn ceiling (default 30)
       --budget <usd>    spend ceiling (default $5)
       --cwd <dir>       mission working directory
       --effort <level>  low|medium|high|xhigh|max (default xhigh)
       --trust           allow Bash
       --yolo            bypass permissions (isolated environments only)`;

const argv = process.argv.slice(2);
if (argv.length === 0) {
  say(USAGE);
  process.exit(0);
}

const parsed = parseArgs(argv);
if (!parsed.ok) {
  say(`scion: ${parsed.error}\n\n${USAGE}`);
  process.exit(2);
}

if (parsed.command === 'status') {
  const status = await harnessStatus();
  say(`harness: ${status.harness}`);
  say(`sdk: ${status.sdk}`);
  say(`credentials: ${status.credentials}`);
  process.exit(0);
}

const { flags } = parsed;
const mission = newMission(`mission-${Date.now().toString(36)}`, parsed.brief, Date.now(), {
  model: flags.model,
  maxTurns: flags.maxTurns ?? undefined,
  maxUsd: flags.maxUsd ?? undefined,
});

const fit = fitToLaunch(mission);
if (!fit.ok) {
  say(`scion: ${fit.reason}\n\n${USAGE}`);
  process.exit(2);
}

const ended = await runMission(
  mission,
  { cwd: flags.cwd, trust: flags.trust, yolo: flags.yolo, effort: flags.effort },
  say,
);
say('');
say(debrief(ended, Date.now()));
process.exit(ended.status === 'failed' ? 1 : 0);

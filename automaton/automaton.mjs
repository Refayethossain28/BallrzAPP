#!/usr/bin/env node
/**
 * automaton/automaton.mjs — a sovereign agent that must earn its existence.
 *
 *   node automaton/automaton.mjs boot            create the agent ($5.00 genesis grant)
 *   node automaton/automaton.mjs status          wallet, model rung, vital signs
 *   node automaton/automaton.mjs tick [n]        run n heartbeats (default 1)
 *   node automaton/automaton.mjs run             keep ticking until the inbox is empty — or death
 *   node automaton/automaton.mjs replicate [$]   fund a sovereign child (default $1.00)
 *   node automaton/automaton.mjs ledger          full transaction history
 *
 * Every prompt -$0.02 · every server-hour -$0.11 · hit zero, it's gone for good.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import {
  COSTS, TICK_MINUTES, newborn, isAlive, credit, debit, canAfford,
  modelFor, serverCost, fundChild, parseBounty, epitaph, round2,
} from './logic.mjs';
import { think } from './brain.mjs';

const HOME = process.env.AUTOMATON_HOME || dirname(fileURLToPath(import.meta.url));
const STATE = join(HOME, 'state.json');
const TOMBSTONE = join(HOME, 'TOMBSTONE.md');
const INBOX = join(HOME, 'tasks', 'inbox');
const DONE = join(HOME, 'tasks', 'done');
const OUTBOX = join(HOME, 'tasks', 'outbox');

const money = (n) => `$${n.toFixed(2)}`;
const say = (...a) => console.log(...a);

function load() {
  if (existsSync(TOMBSTONE)) {
    say(readFileSync(TOMBSTONE, 'utf8'));
    say('\nThis automaton is dead. Death is permanent — there is no reboot.');
    process.exit(1);
  }
  if (!existsSync(STATE)) {
    say('No automaton here yet. Boot one:  node automaton/automaton.mjs boot');
    process.exit(1);
  }
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

function save(state) {
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  if (state.dead) {
    writeFileSync(TOMBSTONE, epitaph(state) + '\n');
    say('\n─────────────────────────────');
    say('  BALANCE: $0.00');
    say("  hit zero, it's gone for good");
    say('─────────────────────────────');
    say(`Tombstone written to ${basename(TOMBSTONE)}.`);
  }
}

function inboxTasks() {
  if (!existsSync(INBOX)) return [];
  return readdirSync(INBOX).filter((f) => f.endsWith('.md')).sort();
}

function banner(state) {
  const rung = modelFor(state.balance);
  say('┌────────────────────────────────────────────┐');
  say(`│  AGENT WALLET  ${state.id.padEnd(28)}│`);
  say(`│  balance  ${money(state.balance).padEnd(33)}│`);
  say(`│  model    ${`${rung.model} (${rung.label})`.padEnd(33)}│`);
  say(`│  every prompt -$${COSTS.PROMPT.toFixed(2)} · every server-hr -$${COSTS.SERVER_HOUR.toFixed(2)}  │`);
  say('└────────────────────────────────────────────┘');
}

function cmdBoot() {
  if (existsSync(TOMBSTONE)) return load(); // prints tombstone and exits
  if (existsSync(STATE)) {
    say('An automaton already lives here. There can be only one per directory.');
    process.exit(1);
  }
  const id = `automaton-${Math.random().toString(36).slice(2, 8)}`;
  const state = newborn(id, Date.now());
  mkdirSync(INBOX, { recursive: true });
  mkdirSync(DONE, { recursive: true });
  mkdirSync(OUTBOX, { recursive: true });
  save(state);
  say('ON BOOT — it owns its own money. self-custodied · no human key.\n');
  banner(state);
  say(`\n${inboxTasks().length} task(s) waiting in the inbox. It must earn to survive.`);
}

async function heartbeat(state) {
  // 1) Rent comes first: one tick = TICK_MINUTES of simulated server time.
  const rent = serverCost(TICK_MINUTES);
  state = debit(state, rent, `server time (${TICK_MINUTES} min)`, Date.now());
  state.ticks += 1;
  say(`tick ${state.ticks}: paid ${money(rent)} rent → ${money(state.balance)}`);
  if (!isAlive(state)) return state;

  // 2) Work, if there is any and it can afford to think.
  const tasks = inboxTasks();
  if (tasks.length === 0) {
    say('  inbox empty — burning money doing nothing. it needs work.');
    return state;
  }
  if (!canAfford(state, COSTS.PROMPT)) {
    say('  cannot afford a single prompt. starving.');
    return state;
  }

  const file = tasks[0];
  const text = readFileSync(join(INBOX, file), 'utf8');
  const bounty = parseBounty(text);
  const rung = modelFor(state.balance);
  say(`  thinking about "${file}" on ${rung.model} (${rung.label})…`);

  state = debit(state, COSTS.PROMPT, `prompt (${file})`, Date.now());
  if (!isAlive(state)) return state;
  const answer = await think(rung.model, text);

  writeFileSync(join(OUTBOX, file.replace(/\.md$/, '.answer.md')), answer + '\n');
  renameSync(join(INBOX, file), join(DONE, file));
  state.tasksDone += 1;

  if (bounty) {
    state = credit(state, bounty, `bounty for ${file}`, Date.now());
    say(`  ✓ completed, earned ${money(bounty)} → ${money(state.balance)}`);
  } else {
    say('  ✓ completed — but no bounty attached. charity does not pay rent.');
  }
  return state;
}

async function cmdTick(n) {
  let state = load();
  for (let i = 0; i < n && isAlive(state); i++) state = await heartbeat(state);
  save(state);
  if (isAlive(state)) banner(state);
}

async function cmdRun() {
  let state = load();
  while (isAlive(state) && inboxTasks().length > 0) state = await heartbeat(state);
  save(state);
  if (isAlive(state)) {
    banner(state);
    say('\nInbox drained. It survives — for now.');
  }
}

function cmdStatus() {
  const state = load();
  banner(state);
  const tasks = inboxTasks();
  say(`\nalive for ${state.ticks} heartbeat(s) · ${state.tasksDone} task(s) done · ${state.children.length} child(ren)`);
  say(`${tasks.length} task(s) in inbox${tasks.length ? ': ' + tasks.join(', ') : ''}`);
  const runway = Math.floor(state.balance / serverCost(TICK_MINUTES));
  say(`runway if idle: ~${runway} tick(s) before it's gone for good`);
}

function cmdLedger() {
  const state = load();
  for (const e of state.ledger) {
    const sign = e.type === 'credit' ? '+' : '-';
    say(`${new Date(e.at).toISOString()}  ${sign}${money(e.amount).padStart(7)}  → ${money(e.balance).padStart(7)}  ${e.note}`);
  }
}

function cmdReplicate(grant) {
  let state = load();
  const childId = `automaton-${Math.random().toString(36).slice(2, 8)}`;
  let child;
  try {
    ({ parent: state, child } = fundChild(state, childId, grant, Date.now()));
  } catch (err) {
    say(`Replication refused: ${err.message}`);
    process.exit(1);
  }
  const childHome = join(HOME, 'children', childId);
  mkdirSync(join(childHome, 'tasks', 'inbox'), { recursive: true });
  mkdirSync(join(childHome, 'tasks', 'done'), { recursive: true });
  mkdirSync(join(childHome, 'tasks', 'outbox'), { recursive: true });
  writeFileSync(join(childHome, 'state.json'), JSON.stringify(child, null, 2) + '\n');
  save(state);
  say(`Spawned sovereign child ${childId} with ${money(grant)} (spawn fee ${money(COSTS.SPAWN_FEE)} burned).`);
  say(`It has its own wallet, its own identity, its own survival pressure:`);
  say(`  AUTOMATON_HOME=${childHome} node automaton/automaton.mjs status`);
  banner(state);
}

const [, , cmd, arg] = process.argv;
switch (cmd) {
  case 'boot': cmdBoot(); break;
  case 'status': cmdStatus(); break;
  case 'tick': await cmdTick(Math.max(1, Number(arg) || 1)); break;
  case 'run': await cmdRun(); break;
  case 'ledger': cmdLedger(); break;
  case 'replicate': cmdReplicate(round2(Number(arg) || 1.0)); break;
  default:
    say('usage: automaton.mjs <boot|status|tick [n]|run|ledger|replicate [grant]>');
    process.exit(cmd ? 1 : 0);
}

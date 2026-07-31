/**
 * automaton/agent.mjs — the automaton's runtime core, shared by the CLI
 * (automaton.mjs) and the storefront daemon (server.mjs).
 *
 * Everything here is side-effectful on the agent's home directory but
 * process-neutral: no process.exit, no argv, loggers injected.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COSTS, TICK_MINUTES, isAlive, credit, debit, canAfford,
  modelFor, serverCost, parseBounty, isPrepaid, epitaph,
} from './logic.mjs';
import { think } from './brain.mjs';
import { stripeEnabled } from './stripe.mjs';

export const HOME = process.env.AUTOMATON_HOME || dirname(fileURLToPath(import.meta.url));
export const STATE = join(HOME, 'state.json');
export const TOMBSTONE = join(HOME, 'TOMBSTONE.md');
export const INBOX = join(HOME, 'tasks', 'inbox');
export const DONE = join(HOME, 'tasks', 'done');
export const OUTBOX = join(HOME, 'tasks', 'outbox');
export const ORDERS = join(HOME, 'orders');

export const money = (n) => `$${n.toFixed(2)}`;

export function ensureDirs() {
  mkdirSync(INBOX, { recursive: true });
  mkdirSync(DONE, { recursive: true });
  mkdirSync(OUTBOX, { recursive: true });
  mkdirSync(ORDERS, { recursive: true });
}

/** The tombstone text if the automaton here is dead, else null. */
export function tombstoneText() {
  return existsSync(TOMBSTONE) ? readFileSync(TOMBSTONE, 'utf8') : null;
}

/** Load state without judging: null if never booted. */
export function loadRaw() {
  if (!existsSync(STATE)) return null;
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

/** Persist state; writes the tombstone on death. Returns true if it just died. */
export function save(state) {
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  if (state.dead && !existsSync(TOMBSTONE)) {
    writeFileSync(TOMBSTONE, epitaph(state) + '\n');
    return true;
  }
  return false;
}

export function inboxTasks() {
  if (!existsSync(INBOX)) return [];
  return readdirSync(INBOX).filter((f) => f.endsWith('.md')).sort();
}

/**
 * One heartbeat: pay rent, then work the next inbox task if affordable.
 * Pure survival pressure — earning is the caller's concern (simulated
 * credit here only when Stripe is off; real money arrives via payments).
 */
export async function heartbeat(state, say = () => {}) {
  const rent = serverCost(TICK_MINUTES);
  state = debit(state, rent, `server time (${TICK_MINUTES} min)`, Date.now());
  state.ticks += 1;
  say(`tick ${state.ticks}: paid ${money(rent)} rent → ${money(state.balance)}`);
  if (!isAlive(state)) return state;

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

  if (bounty && isPrepaid(text)) {
    say(`  ✓ delivered — the ${money(bounty)} was collected when the order was placed.`);
  } else if (bounty && stripeEnabled()) {
    say(`  ✓ delivered. Real economy: the ${money(bounty)} only counts once genuinely paid.`);
  } else if (bounty) {
    state = credit(state, bounty, `bounty for ${file}`, Date.now());
    say(`  ✓ completed, earned ${money(bounty)} → ${money(state.balance)}`);
  } else {
    say('  ✓ completed — but no bounty attached. charity does not pay rent.');
  }
  return state;
}

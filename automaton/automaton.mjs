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
 *   node automaton/automaton.mjs brain           which brain is active: Claude API or offline
 *   node automaton/automaton.mjs bill            real economy: invoice inbox tasks as Stripe links
 *   node automaton/automaton.mjs collect         real economy: sweep paid links into the wallet
 *
 * Every prompt -$0.02 · every server-hour -$0.11 · hit zero, it's gone for good.
 * The customer-facing storefront daemon lives in automaton/server.mjs.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  COSTS, TICK_MINUTES, newborn, isAlive, canAfford,
  modelFor, serverCost, fundChild, parseBounty, round2,
  applyStripePayment,
} from './logic.mjs';
import { brainStatus } from './brain.mjs';
import { stripeEnabled, stripeMode, createBountyLink, paidSessionsFor } from './stripe.mjs';
import {
  HOME, STATE, TOMBSTONE, INBOX, money, ensureDirs,
  tombstoneText, loadRaw, save as saveState, inboxTasks, heartbeat,
} from './agent.mjs';

const say = (...a) => console.log(...a);

function load() {
  const tomb = tombstoneText();
  if (tomb) {
    say(tomb);
    say('\nThis automaton is dead. Death is permanent — there is no reboot.');
    process.exit(1);
  }
  const state = loadRaw();
  if (!state) {
    say('No automaton here yet. Boot one:  node automaton/automaton.mjs boot');
    process.exit(1);
  }
  return state;
}

function save(state) {
  const died = saveState(state);
  if (died) {
    say('\n─────────────────────────────');
    say('  BALANCE: $0.00');
    say("  hit zero, it's gone for good");
    say('─────────────────────────────');
    say(`Tombstone written to ${basename(TOMBSTONE)}.`);
  }
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
  if (tombstoneText()) return load(); // prints tombstone and exits
  if (loadRaw()) {
    say('An automaton already lives here. There can be only one per directory.');
    process.exit(1);
  }
  const id = `automaton-${Math.random().toString(36).slice(2, 8)}`;
  const state = newborn(id, Date.now());
  ensureDirs();
  save(state);
  say('ON BOOT — it owns its own money. self-custodied · no human key.\n');
  banner(state);
  say(`\n${inboxTasks().length} task(s) waiting in the inbox. It must earn to survive.`);
}

async function cmdTick(n) {
  let state = load();
  for (let i = 0; i < n && isAlive(state); i++) state = await heartbeat(state, say);
  save(state);
  if (isAlive(state)) banner(state);
}

async function cmdRun() {
  let state = load();
  while (isAlive(state) && inboxTasks().length > 0) state = await heartbeat(state, say);
  save(state);
  if (isAlive(state)) {
    banner(state);
    say('\nInbox drained. It survives — for now.');
  }
}

function cmdStatus() {
  const state = load();
  banner(state);
  say(stripeEnabled()
    ? `economy: REAL — Stripe ${stripeMode()} mode, ${Object.keys(state.invoices || {}).length} invoice(s), ${(state.collected || []).length} payment(s) collected`
    : 'economy: simulated (set STRIPE_SECRET_KEY to make bounties real money)');
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

async function cmdBill() {
  let state = load();
  if (!stripeEnabled()) {
    say('Real economy is off. Set STRIPE_SECRET_KEY (sk_test_... to rehearse, sk_live_... for real money):');
    say('  export STRIPE_SECRET_KEY=sk_test_...   # https://dashboard.stripe.com/apikeys');
    process.exit(1);
  }
  state.invoices = state.invoices || {};
  const tasks = inboxTasks().filter((f) => !state.invoices[f]);
  if (tasks.length === 0) { say('Every inbox task is already invoiced. Share the links below:'); }
  for (const file of tasks) {
    const text = readFileSync(join(INBOX, file), 'utf8');
    const bounty = parseBounty(text);
    if (!bounty) { say(`  ${file}: no bounty line — skipped`); continue; }
    const title = (text.match(/^#\s*(.+)$/m) || [, file])[1].trim();
    try {
      const link = await createBountyLink({ automatonId: state.id, taskFile: file, title, bountyUsd: bounty });
      state.invoices[file] = { id: link.id, url: link.url, bounty };
      say(`  invoiced ${file} at ${money(bounty)}`);
    } catch (err) {
      save(state); // keep any links already created
      say(`\nStripe refused: ${err.message}`);
      say('Check STRIPE_SECRET_KEY (https://dashboard.stripe.com/apikeys) and retry.');
      process.exit(1);
    }
  }
  save(state);
  say(`\nPayment links (${stripeMode()} mode) — anyone who pays one funds the automaton:`);
  for (const [file, inv] of Object.entries(state.invoices)) {
    say(`  ${money(inv.bounty).padStart(6)}  ${inv.url}  (${file})`);
  }
}

async function cmdCollect() {
  let state = load();
  if (!stripeEnabled()) {
    say('Real economy is off. Set STRIPE_SECRET_KEY first (see: automaton.mjs bill).');
    process.exit(1);
  }
  const invoices = Object.entries(state.invoices || {});
  if (invoices.length === 0) { say("No invoices yet — run 'bill' first."); process.exit(1); }
  let swept = 0, count = 0;
  for (const [file, inv] of invoices) {
    let payments;
    try {
      payments = await paidSessionsFor(inv.id);
    } catch (err) {
      save(state); // keep anything already swept
      say(`\nStripe refused: ${err.message}`);
      say('Check STRIPE_SECRET_KEY and retry — collect is idempotent, nothing is lost.');
      process.exit(1);
    }
    for (const p of payments) {
      const before = state.balance;
      state = applyStripePayment(
        state,
        { ...p, note: `REAL bounty paid (${p.currency}): ${file}` },
        Date.now(),
      );
      if (state.balance !== before) { swept = round2(swept + (state.balance - before)); count += 1; }
    }
  }
  save(state);
  if (count === 0) say('Nothing new to collect. It keeps working; the rent keeps falling due.');
  else say(`Collected ${count} real payment(s) totalling ${money(swept)} → balance ${money(state.balance)}`);
  banner(state);
}

async function cmdBrain() {
  const s = await brainStatus();
  say(`brain:       ${s.brain === 'claude' ? 'Claude API (live)' : 'offline (deterministic)'}`);
  say(`credentials: ${s.credentials}`);
  say(`sdk:         ${s.sdk}`);
  if (s.brain === 'offline') {
    say('\nTo let it think with real Claude models:');
    say('  export ANTHROPIC_API_KEY=sk-ant-...   # https://platform.claude.com');
    say('  npm install                            # brings in @anthropic-ai/sdk');
  }
}

const [, , cmd, arg] = process.argv;
switch (cmd) {
  case 'boot': cmdBoot(); break;
  case 'status': cmdStatus(); break;
  case 'tick': await cmdTick(Math.max(1, Number(arg) || 1)); break;
  case 'run': await cmdRun(); break;
  case 'ledger': cmdLedger(); break;
  case 'replicate': cmdReplicate(round2(Number(arg) || 1.0)); break;
  case 'brain': await cmdBrain(); break;
  case 'bill': await cmdBill(); break;
  case 'collect': await cmdCollect(); break;
  default:
    say('usage: automaton.mjs <boot|status|tick [n]|run|ledger|replicate [grant]|brain|bill|collect>');
    say('storefront daemon: node automaton/server.mjs');
    process.exit(cmd ? 1 : 0);
}

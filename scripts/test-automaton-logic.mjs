#!/usr/bin/env node
/**
 * Unit tests for automaton/ — the sovereign-agent survival economy:
 * the genesis grant, metered billing (every prompt -$0.02, every
 * server-hour -$0.11), the model downgrade ladder, bounty parsing,
 * permanent death at zero, replication funding, and the epitaph.
 * Run: node scripts/test-automaton-logic.mjs
 */
import assert from 'node:assert/strict';
import {
  COSTS, GENESIS_GRANT, TICK_MINUTES, round2, serverCost, modelFor,
  newborn, isAlive, credit, debit, canAfford, fundChild, parseBounty, epitaph,
  applyStripePayment,
} from '../automaton/logic.mjs';
import { form } from '../automaton/stripe.mjs';

const T0 = Date.UTC(2026, 6, 18, 10, 54, 0);
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

test('genesis: born with $5.00, alive, ledger records the grant', () => {
  const a = newborn('automaton-test', T0);
  assert.equal(a.balance, GENESIS_GRANT);
  assert.equal(isAlive(a), true);
  assert.equal(a.ledger.length, 1);
  assert.equal(a.ledger[0].note, 'genesis grant');
});

test('billing: server time is $0.11/hour, prorated and rounded to cents', () => {
  assert.equal(serverCost(60), 0.11);
  assert.equal(serverCost(TICK_MINUTES), round2(0.11 / 4)); // 15 min → $0.03
  assert.equal(COSTS.PROMPT, 0.02);
});

test('debit and credit keep the ledger balanced to the cent', () => {
  let a = newborn('a', T0);
  a = debit(a, COSTS.PROMPT, 'prompt', T0 + 1);
  a = credit(a, 0.4, 'bounty', T0 + 2);
  assert.equal(a.balance, round2(5 - 0.02 + 0.4));
  assert.equal(a.ledger.at(-1).balance, a.balance);
});

test('model ladder: opus while healthy, sonnet when frugal, haiku when critical', () => {
  assert.equal(modelFor(5).model, 'claude-opus-4-8');
  assert.equal(modelFor(2).model, 'claude-opus-4-8');
  assert.equal(modelFor(1.99).model, 'claude-sonnet-5');
  assert.equal(modelFor(0.75).model, 'claude-sonnet-5');
  assert.equal(modelFor(0.74).model, 'claude-haiku-4-5');
  assert.equal(modelFor(0.01).model, 'claude-haiku-4-5');
});

test('death: hitting zero kills it, exactly and permanently', () => {
  let a = newborn('a', T0, 0.05);
  a = debit(a, 0.05, 'last breath', T0 + 1);
  assert.equal(a.balance, 0);
  assert.equal(a.dead, true);
  assert.equal(a.diedAt, T0 + 1);
  assert.equal(isAlive(a), false);
  assert.throws(() => debit(a, 0.01, 'no', T0 + 2), /dead/);
  assert.throws(() => credit(a, 100, 'too late', T0 + 2), /dead/);
});

test('overdraft clamps to zero — it cannot owe money, only die', () => {
  let a = newborn('a', T0, 0.01);
  a = debit(a, 0.05, 'rent it cannot pay', T0 + 1);
  assert.equal(a.balance, 0);
  assert.equal(a.dead, true);
});

test('canAfford requires a strict surplus (spending to exactly zero is death)', () => {
  const a = newborn('a', T0, 0.02);
  assert.equal(canAfford(a, 0.02), false);
  assert.equal(canAfford(a, 0.01), true);
});

test('replication: spawn fee burned, grant transferred, child is sovereign', () => {
  const parent = newborn('parent', T0);
  const { parent: p, child } = fundChild(parent, 'child-1', 1.0, T0 + 5);
  assert.equal(p.balance, round2(5 - COSTS.SPAWN_FEE - 1.0));
  assert.deepEqual(p.children, ['child-1']);
  assert.equal(child.balance, 1.0);
  assert.equal(child.id, 'child-1');
  assert.match(child.ledger[0].note, /from parent parent/);
  // funding must never kill the parent
  const poor = newborn('poor', T0, 1.25);
  assert.throws(() => fundChild(poor, 'child-2', 1.0, T0), /replication needs/);
});

test('bounty parsing: dollar sign optional, case-insensitive, absent → null', () => {
  assert.equal(parseBounty('# T\n\nBounty: $0.40\n\nbody'), 0.4);
  assert.equal(parseBounty('bounty: 1.25'), 1.25);
  assert.equal(parseBounty('# T\n\nno money here'), null);
});

test('epitaph records the life honestly', () => {
  let a = newborn('automaton-x', T0, 0.03);
  a = debit(a, 0.03, 'the end', T0 + 7_200_000); // dies 2h later
  const text = epitaph(a);
  assert.match(text, /automaton-x/);
  assert.match(text, /gone for good/);
  assert.match(text, /2\.0 simulated hours/);
  assert.match(text, /\$0\.00/);
});

test('stripe payments credit real cents and dedupe by session id', () => {
  let a = newborn('a', T0);
  const pay = { sessionId: 'cs_test_1', amountCents: 40, note: 'REAL bounty: 001' };
  a = applyStripePayment(a, pay, T0 + 1);
  assert.equal(a.balance, round2(5 + 0.4));
  assert.deepEqual(a.collected, ['cs_test_1']);
  const again = applyStripePayment(a, pay, T0 + 2); // same session — no double credit
  assert.equal(again.balance, a.balance);
  assert.equal(again.ledger.length, a.ledger.length);
  const b = applyStripePayment(a, { sessionId: 'cs_test_2', amountCents: 125 }, T0 + 3);
  assert.equal(b.balance, round2(5 + 0.4 + 1.25));
});

test('stripe payments survive states born before the real economy existed', () => {
  const legacy = newborn('old', T0);
  delete legacy.collected;
  delete legacy.invoices;
  const a = applyStripePayment(legacy, { sessionId: 'cs_x', amountCents: 100 }, T0 + 1);
  assert.equal(a.balance, 6);
  assert.deepEqual(a.collected, ['cs_x']);
});

test('form() flattens nested objects into Stripe form encoding', () => {
  assert.equal(
    form({ line_items: [{ price: 'price_1', quantity: 1 }], metadata: { automaton_task: 'a b.md' } }),
    'line_items[0][price]=price_1&line_items[0][quantity]=1&metadata[automaton_task]=a%20b.md',
  );
  assert.equal(form({ currency: 'usd', unit_amount: 40, skip: null }), 'currency=usd&unit_amount=40');
});

console.log(`\nautomaton logic: ${passed} tests passed`);

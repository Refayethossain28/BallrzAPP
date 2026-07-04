#!/usr/bin/env node
/**
 * Unit tests for concierge/engine.js — the Membership Engine behind Velvet,
 * the subscription-based all-in-one VIP concierge. Covers the money paths
 * (trial → renewal invoices, proration, cancellation), quota, the request
 * state machine, SLA states, priority ordering and the deterministic desk.
 * Loaded in a vm sandbox (repo is type:module). Run: node scripts/test-concierge-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'concierge', 'engine.js'), 'utf8'), sandbox, { filename: 'concierge/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0); // 2026-07-01 12:00
const MIN = 60000, DAY = 86400000;
const req = (over = {}) => ({ id: 'r1', title: 'Table for four', category: 'dining',
  status: 'submitted', submittedAt: NOW, firstResponseAt: null, ...over });

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ---- tiers ---- */

test('tiers: ranked Silver < Gold < Black; Black is unlimited with the tightest SLA', () => {
  assert.deepEqual([...E.TIER_ORDER], ['silver', 'gold', 'black']);
  assert.ok(E.TIERS.silver.rank < E.TIERS.gold.rank && E.TIERS.gold.rank < E.TIERS.black.rank);
  assert.ok(E.TIERS.silver.pricePence < E.TIERS.gold.pricePence);
  assert.ok(E.TIERS.gold.pricePence < E.TIERS.black.pricePence);
  assert.equal(E.TIERS.black.requestsPerMonth, null);
  assert.ok(E.TIERS.black.slaMinutes < E.TIERS.gold.slaMinutes);
  assert.ok(E.TIERS.gold.slaMinutes < E.TIERS.silver.slaMinutes);
  assert.throws(() => E.tier('platinum'), /unknown tier/);
});

/* ---- subscription lifecycle ---- */

test('startSubscription: 7-day free trial, no invoice yet', () => {
  const s = E.startSubscription('gold', NOW);
  assert.equal(s.status, 'trialing');
  assert.equal(s.periodEnd - s.periodStart, E.TRIAL_DAYS * DAY);
  assert.equal(E.trialDaysLeft(s, NOW), 7);
  assert.equal(E.trialDaysLeft(s, NOW + 6.5 * DAY), 1);
  assert.ok(E.isLive(s));
});

test('advance: trial converts to a paid 30-day period with one invoice', () => {
  const s0 = E.startSubscription('gold', NOW);
  const { sub, invoices } = E.advance(s0, NOW + 8 * DAY);
  assert.equal(sub.status, 'active');
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].amountPence, E.TIERS.gold.pricePence);
  assert.equal(invoices[0].at, s0.periodEnd);
  assert.equal(sub.periodEnd - sub.periodStart, 30 * DAY);
  assert.equal(s0.status, 'trialing', 'advance must not mutate its input');
});

test('advance: several missed renewals emit one invoice each, back-to-back', () => {
  const s0 = E.startSubscription('silver', NOW);
  const { sub, invoices } = E.advance(s0, NOW + (7 + 65) * DAY);
  assert.equal(invoices.length, 3); // trial end + 2 renewals
  assert.equal(sub.status, 'active');
  for (let i = 1; i < invoices.length; i++) {
    assert.equal(invoices[i].periodStart, invoices[i - 1].periodEnd);
  }
});

test('cancel takes effect at period end; resume undoes it before then', () => {
  const s0 = E.advance(E.startSubscription('silver', NOW), NOW + 8 * DAY).sub;
  const c = E.cancel(s0);
  assert.ok(E.isLive(c), 'still live until the period ends');
  const ended = E.advance(c, c.periodEnd + DAY);
  assert.equal(ended.sub.status, 'canceled');
  assert.equal(ended.invoices.length, 0, 'no charge after cancellation');
  assert.equal(ended.sub.endedAt, c.periodEnd);
  const r = E.resume(c);
  assert.equal(E.advance(r, r.periodEnd + 1).sub.status, 'active');
  assert.throws(() => E.resume(ended.sub), /ended/);
});

/* ---- proration & tier changes ---- */

test('prorationPence: half the period left ⇒ half the price difference', () => {
  const s = E.advance(E.startSubscription('silver', NOW), NOW + 7 * DAY).sub;
  const mid = s.periodStart + 15 * DAY;
  const diff = E.TIERS.gold.pricePence - E.TIERS.silver.pricePence;
  assert.equal(E.prorationPence('silver', 'gold', s, mid), Math.round(diff / 2));
  assert.equal(E.prorationPence('silver', 'gold', s, s.periodStart), diff);
  assert.equal(E.prorationPence('silver', 'gold', s, s.periodEnd + DAY), 0, 'clamped');
  assert.equal(E.prorationPence('gold', 'silver', s, mid), 0, 'downgrades never charge');
});

test('changeTier: upgrade is immediate with a prorated invoice', () => {
  const s = E.advance(E.startSubscription('silver', NOW), NOW + 7 * DAY).sub;
  const mid = s.periodStart + 15 * DAY;
  const { sub, invoice } = E.changeTier(s, 'black', mid);
  assert.equal(sub.tierId, 'black');
  assert.equal(invoice.amountPence,
    Math.round((E.TIERS.black.pricePence - E.TIERS.silver.pricePence) / 2));
  assert.equal(invoice.periodEnd, s.periodEnd, 'no new period on upgrade');
});

test('changeTier: upgrade during trial is free; first charge is the new tier', () => {
  const s = E.startSubscription('silver', NOW);
  const { sub, invoice } = E.changeTier(s, 'gold', NOW + DAY);
  assert.equal(sub.tierId, 'gold');
  assert.equal(invoice, null);
  const renewed = E.advance(sub, sub.periodEnd + 1);
  assert.equal(renewed.invoices[0].amountPence, E.TIERS.gold.pricePence);
});

test('changeTier: downgrade waits for renewal, then bills the lower price', () => {
  const s = E.advance(E.startSubscription('black', NOW), NOW + 7 * DAY).sub;
  const { sub, invoice } = E.changeTier(s, 'silver', s.periodStart + 3 * DAY);
  assert.equal(invoice, null);
  assert.equal(sub.tierId, 'black', 'keeps what was paid for');
  assert.equal(sub.pendingTierId, 'silver');
  const renewed = E.advance(sub, sub.periodEnd + 1);
  assert.equal(renewed.sub.tierId, 'silver');
  assert.equal(renewed.invoices[0].amountPence, E.TIERS.silver.pricePence);
});

/* ---- quota ---- */

test('quota: counts this period only, refunds cancellations, Black unlimited', () => {
  const start = NOW, end = NOW + 30 * DAY;
  const rs = [
    req({ id: 'a', submittedAt: start + DAY }),
    req({ id: 'b', submittedAt: start + 2 * DAY, status: 'cancelled' }),
    req({ id: 'c', submittedAt: start - DAY }),          // previous period
    req({ id: 'd', submittedAt: start + 3 * DAY }),
  ];
  assert.equal(E.usedInPeriod(rs, start, end), 2);
  assert.equal(E.remainingQuota('silver', 2), 3);
  assert.equal(E.remainingQuota('silver', 9), 0, 'never negative');
  assert.equal(E.remainingQuota('black', 999), null);
  assert.equal(E.canSubmit('silver', 5), false);
  assert.equal(E.canSubmit('black', 999), true);
});

/* ---- request state machine ---- */

test('lifecycle: the happy path walks the whole flow; illegal jumps throw', () => {
  let r = req();
  for (const next of ['triaged', 'sourcing', 'options', 'confirmed', 'completed']) {
    r = E.transition(r, next, NOW + MIN);
    assert.equal(r.status, next);
  }
  assert.equal(r.completedAt, NOW + MIN);
  assert.throws(() => E.transition(req(), 'options', NOW), /illegal/);
  assert.throws(() => E.transition(req({ status: 'completed' }), 'submitted', NOW), /illegal/);
});

test('cancel allowed only before confirmation', () => {
  for (const from of ['submitted', 'triaged', 'sourcing', 'options']) {
    assert.ok(E.canTransition(from, 'cancelled'), from + ' should be cancellable');
  }
  assert.ok(!E.canTransition('confirmed', 'cancelled'));
  assert.ok(!E.canTransition('completed', 'cancelled'));
  assert.ok(!E.canTransition('cancelled', 'triaged'));
});

test('first response is stamped once, at triage', () => {
  const r = E.transition(req(), 'triaged', NOW + 5 * MIN);
  assert.equal(r.firstResponseAt, NOW + 5 * MIN);
  const later = E.transition(r, 'sourcing', NOW + 20 * MIN);
  assert.equal(later.firstResponseAt, NOW + 5 * MIN, 'not overwritten');
});

/* ---- SLA ---- */

test('slaState: ok → warning → breached while waiting; met/breached after response', () => {
  const t0 = NOW; // black = 15 min window
  assert.equal(E.slaState(t0, 'black', t0 + 5 * MIN, null), 'ok');
  assert.equal(E.slaState(t0, 'black', t0 + 12 * MIN, null), 'warning'); // <25% left
  assert.equal(E.slaState(t0, 'black', t0 + 16 * MIN, null), 'breached');
  assert.equal(E.slaState(t0, 'black', t0 + 60 * MIN, t0 + 10 * MIN), 'met');
  assert.equal(E.slaState(t0, 'black', t0 + 60 * MIN, t0 + 20 * MIN), 'breached');
  assert.equal(E.slaDeadline(t0, 'silver') - t0, 240 * MIN);
});

/* ---- priority ---- */

test('queueOrder: tier always beats patience; within a tier, longest wait first', () => {
  const entries = [
    { request: req({ id: 's', submittedAt: NOW - 300 * MIN }), tierRank: 1 }, // silver, waited 5h
    { request: req({ id: 'g1', submittedAt: NOW - 10 * MIN }), tierRank: 2 },
    { request: req({ id: 'g2', submittedAt: NOW - 50 * MIN }), tierRank: 2 },
    { request: req({ id: 'b', submittedAt: NOW }), tierRank: 3 },             // black, just arrived
  ];
  const order = E.queueOrder(entries, NOW).map(e => e.request.id);
  assert.deepEqual(order, ['b', 'g2', 'g1', 's']);
});

/* ---- desk simulation ---- */

test('deskDelays: Black is served fastest, stages strictly ordered', () => {
  const b = E.deskDelays('black'), s = E.deskDelays('silver');
  assert.ok(b.triaged < s.triaged && b.options < s.options);
  for (const d of [b, s]) assert.ok(d.triaged < d.sourcing && d.sourcing < d.options);
});

test('proposeOptions: deterministic, three ascending prices in £5 steps', () => {
  for (const c of E.CATEGORIES) {
    const r = req({ id: 'seed-' + c.id, category: c.id });
    const a = E.proposeOptions(r), b = E.proposeOptions(r);
    assert.deepEqual(a, b, 'same request ⇒ same options');
    assert.equal(a.length, 3);
    assert.ok(a[0].pricePence < a[1].pricePence && a[1].pricePence < a[2].pricePence);
    for (const o of a) {
      assert.equal(o.pricePence % 500, 0, 'rounded to £5');
      assert.ok(o.name && o.detail);
    }
  }
  assert.notDeepEqual(E.proposeOptions(req({ id: 'x', category: 'dining' })).map(o => o.pricePence),
                      E.proposeOptions(req({ id: 'y', category: 'dining' })).map(o => o.pricePence),
                      'different requests get different prices');
});

test('deskLine: a scripted line for every stage, personalised at triage', () => {
  const r = req();
  for (const stage of [...E.FLOW, 'cancelled']) {
    assert.ok(E.deskLine(r, stage, 'Rafa').length > 20, stage);
  }
  assert.match(E.deskLine(r, 'triaged', 'Rafa'), /Rafa/);
  assert.match(E.deskLine(r, 'triaged', 'Rafa'), /Table for four/);
  assert.throws(() => E.deskLine(r, 'nope'), /no desk line/);
});

/* ---- points & status ---- */

test('points: £1 = 1pt × tier multiplier; status levels climb', () => {
  assert.equal(E.pointsEarned(10000, 'silver'), 100);
  assert.equal(E.pointsEarned(10000, 'gold'), 150);
  assert.equal(E.pointsEarned(10000, 'black'), 200);
  assert.equal(E.pointsEarned(199, 'silver'), 1, 'floors, never rounds up');
  assert.equal(E.statusFor(0).name, 'Member');
  assert.equal(E.statusFor(500).name, 'Insider');
  assert.equal(E.statusFor(2000).name, 'Icon');
  assert.equal(E.statusFor(99999).name, 'Legend');
  assert.equal(E.pointsToNext(450), 50);
  assert.equal(E.pointsToNext(99999), null);
});

/* ---- cloud sync merge ---- */

test('mergeRequests: later updatedAt wins per id; more messages breaks ties; union sorted', () => {
  const stale = req({ id: 'a', status: 'submitted', updatedAt: NOW, messages: [1] });
  const fresh = req({ id: 'a', status: 'options', updatedAt: NOW + MIN, messages: [1, 2, 3] });
  const localOnly = req({ id: 'b', submittedAt: NOW - MIN });
  const remoteOnly = req({ id: 'c', submittedAt: NOW + MIN });
  const out = E.mergeRequests([stale, localOnly], [fresh, remoteOnly]);
  assert.deepEqual([...out.map(r => r.id)], ['b', 'a', 'c'], 'union, ordered by submittedAt');
  assert.equal(out.find(r => r.id === 'a').status, 'options');
  // tie on updatedAt → the copy with more messages (a desk reply) wins
  const m1 = { from: 'desk', text: 'hi', at: NOW };
  const m2 = { from: 'desk', text: 'update', at: NOW + 1 };
  const tied = E.mergeRequests(
    [req({ id: 'a', updatedAt: NOW, messages: [m1] })],
    [req({ id: 'a', updatedAt: NOW, messages: [m1, m2] })]);
  assert.equal(tied[0].messages.length, 2);
});

test('mergeInvoices: de-duplicates identical charges, keeps both renewals, oldest first', () => {
  const i1 = { at: NOW, tierId: 'gold', amountPence: 19900 };
  const i2 = { at: NOW + 30 * DAY, tierId: 'gold', amountPence: 19900 };
  const out = E.mergeInvoices([i2, i1], [i1]);
  assert.equal(out.length, 2);
  assert.ok(out[0].at < out[1].at);
});

test('mergeStates: the Stripe-billed server copy owns the subscription', () => {
  const local = { memberName: 'Rafa', memberSince: NOW, billing: 'local',
    sub: { tierId: 'black', status: 'active', periodStart: NOW + 5 * DAY, periodEnd: NOW + 35 * DAY },
    invoices: [], requests: [], points: 900, spentPence: 0 };
  const remote = { memberName: '', memberSince: NOW - DAY, billing: 'stripe',
    sub: { tierId: 'silver', status: 'trialing', periodStart: NOW, periodEnd: NOW + 7 * DAY },
    invoices: [], requests: [], points: 100, spentPence: 0 };
  const m = E.mergeStates(local, remote);
  assert.equal(m.sub.tierId, 'silver', 'local simulation must not override webhook truth');
  assert.equal(m.billing, 'stripe');
  assert.equal(m.points, 900, 'points only ever grow — max wins');
  assert.equal(m.memberName, 'Rafa');
  assert.equal(m.memberSince, NOW - DAY);
});

test('mergeStates: on local billing the further-advanced period wins; null sides pass through', () => {
  const behind = { billing: 'local', sub: { tierId: 'gold', periodStart: NOW, periodEnd: NOW + 7 * DAY },
    invoices: [], requests: [], points: 0, spentPence: 0, memberName: 'R', memberSince: NOW };
  const ahead = { billing: 'local', sub: { tierId: 'gold', periodStart: NOW + 7 * DAY, periodEnd: NOW + 37 * DAY },
    invoices: [], requests: [], points: 0, spentPence: 0, memberName: 'R', memberSince: NOW };
  assert.equal(E.mergeStates(behind, ahead).sub.periodStart, NOW + 7 * DAY);
  assert.equal(E.mergeStates(ahead, behind).sub.periodStart, NOW + 7 * DAY, 'symmetric');
  assert.equal(E.mergeStates(behind, null), behind);
  assert.equal(E.mergeStates(null, ahead), ahead);
});

/* ---- concurrent chat safety ---- */

test('mergeRequests: concurrent messages on both copies all survive (union)', () => {
  const base = req({ id: 'a', updatedAt: NOW, messages: [{ from: 'desk', text: 'hello', at: NOW }] });
  const localCopy = { ...base, messages: [...base.messages, { from: 'me', text: 'member msg', at: NOW + 1 }] };
  const remoteCopy = { ...base, updatedAt: NOW + 2, status: 'triaged',
    messages: [...base.messages, { from: 'desk', text: 'desk reply', at: NOW + 2 }] };
  const merged = E.mergeRequests([localCopy], [remoteCopy])[0];
  assert.equal(merged.status, 'triaged', 'newer copy still wins the request fields');
  assert.deepEqual([...merged.messages.map(m => m.text)], ['hello', 'member msg', 'desk reply'],
    'no message lost, ordered by time');
  // exact duplicates collapse
  assert.equal(E.mergeMessages(localCopy.messages, localCopy.messages).length, 2);
});

/* ---- desk actions ---- */

test('DESK_ACTIONS: every offered action is a legal transition; every status covered', () => {
  for (const status of [...E.FLOW, 'cancelled']) {
    assert.ok(status in E.DESK_ACTIONS, status + ' missing from DESK_ACTIONS');
    for (const [to] of E.DESK_ACTIONS[status]) {
      assert.ok(E.canTransition(status, to), status + ' → ' + to + ' offered but illegal');
    }
  }
  assert.equal(E.DESK_ACTIONS.options.length, 0, 'options stage waits on the member');
});

/* ---- backend price parity ---- */

test('VELVET_TIERS in functions/src/velvet.ts matches the engine TIERS', () => {
  const src = readFileSync(join(ROOT, 'functions', 'src', 'velvet.ts'), 'utf8');
  const m = /const VELVET_TIERS[^=]*=\s*({[\s\S]*?});/.exec(src);
  assert.ok(m, 'VELVET_TIERS literal not found in velvet.ts');
  const serverTiers = new Function('return (' + m[1] + ')')();
  for (const id of E.TIER_ORDER) {
    assert.ok(serverTiers[id], 'server missing tier ' + id);
    assert.equal(serverTiers[id].pricePence, E.TIERS[id].pricePence, id + ' price drifted');
    assert.equal(serverTiers[id].pointsMultiplier, E.TIERS[id].pointsMultiplier, id + ' multiplier drifted');
    assert.equal(serverTiers[id].name, E.TIERS[id].name, id + ' name drifted');
  }
  assert.deepEqual(Object.keys(serverTiers).sort(), [...E.TIER_ORDER].sort(), 'tier sets differ');
});

/* ---- money formatting ---- */

test('fmtGBP: pence-exact, thousands separators, no Intl', () => {
  assert.equal(E.fmtGBP(4900), '£49');
  assert.equal(E.fmtGBP(49900), '£499');
  assert.equal(E.fmtGBP(123456789), '£1,234,567.89');
  assert.equal(E.fmtGBP(105), '£1.05');
  assert.equal(E.fmtGBP(-2500), '−£25');
});

/* ---- run ---- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) {
    console.error('  ✗ ' + name);
    console.error(String(err && err.stack || err).split('\n').map(l => '    ' + l).join('\n'));
    process.exitCode = 1;
  }
}
console.log(`\nconcierge engine: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

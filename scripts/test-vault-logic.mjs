#!/usr/bin/env node
/**
 * Unit tests for vault/engine.js — the ledger-with-rules behind Vault, the
 * digital bank. Pins the properties money code must never lose: integer-pence
 * arithmetic, double-entry balances derived from the ledger, the posting gate
 * (insufficient funds, overdraft floor, card freeze/limits), Luhn and IBAN
 * mod-97 check digits, daily-compounded AER interest, month-end-clamped
 * standing orders with catch-up, analytics, CSV escaping, and a fully
 * deterministic demo seed.
 * Loaded in a vm sandbox (repo is type:module). Run: node scripts/test-vault-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'vault', 'engine.js'), 'utf8'), sandbox, { filename: 'vault/engine.js' });
const V = sandbox.module.exports;

const NOW = '2026-07-23';
const bank = (seed = 42) => V.openBank({ name: 'Test', rng: V.mulberry32(seed), nowISO: NOW });
const topUp = (s, pence) => V.post(s, { amount: pence, from: null, to: 'current', desc: 'Top up', ts: NOW + 'T09:00:00Z' }).state;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);

/* ---- money ---- */

test('fmt renders integer pence with thousands separators and sign', () => {
  assert.equal(V.fmt(123456), '£1,234.56');
  assert.equal(V.fmt(5), '£0.05');
  assert.equal(V.fmt(-250), '−£2.50');
  assert.equal(V.fmt(100000, { showPlus: true }), '+£1,000.00');
});

test('parseAmount accepts human input, rejects garbage, returns pence', () => {
  assert.equal(V.parseAmount('12'), 1200);
  assert.equal(V.parseAmount('12.3'), 1230);
  assert.equal(V.parseAmount('£1,234.56'), 123456);
  assert.equal(V.parseAmount('0.01'), 1);
  assert.equal(V.parseAmount('0'), null);
  assert.equal(V.parseAmount('-5'), null);
  assert.equal(V.parseAmount('1.234'), null);
  assert.equal(V.parseAmount('12,34'), 123400); // commas read as thousands separators
  assert.equal(V.parseAmount('abc'), null);
  assert.equal(V.parseAmount(''), null);
});

test('roundUp is the to-the-next-pound remainder', () => {
  assert.equal(V.roundUp(350), 50);
  assert.equal(V.roundUp(400), 0);
  assert.equal(V.roundUp(1), 99);
});

/* ---- card & account rails ---- */

test('generated cards are Luhn-valid, 16 digits, expiry 4 years out', () => {
  const card = V.makeCard(V.mulberry32(7), NOW);
  assert.match(card.pan, /^\d{16}$/);
  assert.ok(V.luhnValid(card.pan));
  assert.equal(card.expiry, '07/30');
  assert.match(card.cvv, /^\d{3}$/);
  // flipping any single digit breaks Luhn (that's the whole point of the check)
  const flipped = card.pan.slice(0, -1) + ((+card.pan.slice(-1) + 1) % 10);
  assert.equal(V.luhnValid(flipped), false);
});

test('luhnValid agrees with the canonical test number', () => {
  assert.ok(V.luhnValid('4539578763621486'));
  assert.equal(V.luhnValid('4539578763621487'), false);
  assert.equal(V.luhnValid('not a pan'), false);
});

test('IBANs carry genuine mod-97 check digits', () => {
  const iban = V.ibanFor('04-29-09', '12345678');
  assert.match(iban, /^GB\d{2}VAUL04290912345678$/);
  assert.ok(V.ibanValid(iban));
  // a known-good real-world IBAN validates; a corrupted one does not
  assert.ok(V.ibanValid('GB82WEST12345698765432'));
  assert.equal(V.ibanValid('GB82WEST12345698765431'), false);
  assert.equal(V.ibanValid('XX'), false);
});

test('openBank is deterministic: same seed ⇒ same rails, same card', () => {
  const a = bank(9), b = bank(9), c = bank(10);
  assert.equal(a.sortCode, b.sortCode);
  assert.equal(a.iban, b.iban);
  assert.equal(a.card.pan, b.card.pan);
  assert.notEqual(a.card.pan, c.card.pan);
  assert.ok(V.ibanValid(a.iban));
});

/* ---- pin ---- */

test('PIN set/verify round-trips; wrong PIN and no PIN fail', () => {
  let s = bank();
  assert.equal(V.verifyPin(s, '1234'), false);
  s = V.setPin(s, '1234', 'salty');
  assert.ok(V.verifyPin(s, '1234'));
  assert.equal(V.verifyPin(s, '1235'), false);
  assert.notEqual(V.hashPin('1234', 'a'), V.hashPin('1234', 'b'), 'salt matters');
});

/* ---- the posting gate ---- */

test('post is double-entry: one txn moves both balances, total conserved', () => {
  let s = topUp(bank(), 10000);
  const r = V.post(s, { amount: 2500, from: 'current', to: 'pot-1', desc: 'Pot transfer', ts: NOW + 'T10:00:00Z' });
  assert.ok(!r.error);
  assert.equal(V.balanceOf(r.state, 'current'), 7500);
  assert.equal(V.balanceOf(r.state, 'pot-1'), 2500);
  assert.equal(V.totalBalance(r.state), 10000);
});

test('post never mutates its input state', () => {
  const s = topUp(bank(), 5000);
  const before = JSON.stringify(s);
  V.post(s, { amount: 1000, from: 'current', to: null, desc: 'x', ts: NOW + 'T10:00:00Z' });
  assert.equal(JSON.stringify(s), before);
});

test('the gate rejects: bad amounts, unknown accounts, self-transfers', () => {
  const s = topUp(bank(), 5000);
  assert.equal(V.post(s, { amount: 0, from: 'current', to: null, ts: NOW }).error, 'bad-amount');
  assert.equal(V.post(s, { amount: -5, from: 'current', to: null, ts: NOW }).error, 'bad-amount');
  assert.equal(V.post(s, { amount: 100, from: 'nope', to: null, ts: NOW }).error, 'no-account');
  assert.equal(V.post(s, { amount: 100, from: null, to: null, ts: NOW }).error, 'no-account');
  assert.equal(V.post(s, { amount: 100, from: 'current', to: 'current', ts: NOW }).error, 'same-account');
});

test('insufficient funds bounce; an arranged overdraft moves the floor; pots never go negative', () => {
  let s = topUp(bank(), 1000);
  assert.equal(V.post(s, { amount: 1001, from: 'current', to: null, desc: 'x', ts: NOW }).error, 'insufficient');
  s = JSON.parse(JSON.stringify(s));
  s.accounts[0].overdraft = 5000;
  const r = V.post(s, { amount: 1001, from: 'current', to: null, desc: 'x', ts: NOW + 'T10:00:00Z' });
  assert.ok(!r.error, 'overdraft absorbs it');
  assert.equal(V.balanceOf(r.state, 'current'), -1);
  // pot: exact drain OK, one penny more is not (no overdraft on savings)
  let s2 = topUp(bank(), 1000);
  s2 = V.post(s2, { amount: 500, from: 'current', to: 'pot-1', desc: 'save', ts: NOW + 'T10:00:00Z' }).state;
  assert.ok(!V.post(s2, { amount: 500, from: 'pot-1', to: 'current', desc: 'back', ts: NOW + 'T11:00:00Z' }).error);
  assert.equal(V.post(s2, { amount: 501, from: 'pot-1', to: 'current', desc: 'back', ts: NOW + 'T11:00:00Z' }).error, 'insufficient');
});

test('card gate: freeze blocks, per-purchase and daily limits enforce', () => {
  let s = topUp(bank(), 500000);
  const frozen = JSON.parse(JSON.stringify(s)); frozen.card.frozen = true;
  assert.equal(V.post(frozen, { amount: 100, from: 'current', to: null, method: 'card', ts: NOW + 'T10:00:00Z' }).error, 'card-frozen');
  assert.equal(V.post(s, { amount: 50001, from: 'current', to: null, method: 'card', ts: NOW + 'T10:00:00Z' }).error, 'card-limit');
  // two £500s fine, the third passes £1,000/day
  let r = V.post(s, { amount: 50000, from: 'current', to: null, desc: 'a', method: 'card', ts: NOW + 'T10:00:00Z' });
  r = V.post(r.state, { amount: 50000, from: 'current', to: null, desc: 'b', method: 'card', ts: NOW + 'T11:00:00Z' });
  assert.ok(!r.error);
  assert.equal(V.post(r.state, { amount: 100, from: 'current', to: null, desc: 'c', method: 'card', ts: NOW + 'T12:00:00Z' }).error, 'card-daily');
  // …but tomorrow the meter resets
  assert.ok(!V.post(r.state, { amount: 100, from: 'current', to: null, desc: 'c', method: 'card', ts: '2026-07-24T09:00:00Z' }).error);
});

test('cardPurchase round-ups hop into the pot only when enabled', () => {
  let s = topUp(bank(), 10000);
  let r = V.cardPurchase(s, 350, 'Costa Coffee', NOW + 'T10:00:00Z');
  assert.ok(!r.error && !r.roundUpTxn, 'round-ups off by default');
  s = JSON.parse(JSON.stringify(s)); s.roundUpsTo = 'pot-1';
  r = V.cardPurchase(s, 350, 'Costa Coffee', NOW + 'T10:00:00Z');
  assert.ok(r.roundUpTxn);
  assert.equal(r.roundUpTxn.amount, 50);
  assert.equal(V.balanceOf(r.state, 'pot-1'), 50);
  assert.equal(V.balanceOf(r.state, 'current'), 10000 - 350 - 50);
  // an exact-pound spend produces no round-up txn
  r = V.cardPurchase(s, 400, 'Costa Coffee', NOW + 'T10:00:00Z');
  assert.ok(!r.roundUpTxn);
});

/* ---- pots & interest ---- */

test('createPot numbers ids past every existing pot', () => {
  let s = V.createPot(bank(), { name: 'Holiday', goal: 100000, nowISO: NOW });
  assert.equal(s.accounts[2].id, 'pot-2');
  s = V.createPot(s, { name: 'Car', nowISO: NOW });
  assert.equal(s.accounts[3].id, 'pot-3');
  assert.equal(s.accounts[3].aerPct, 4.0, 'default AER');
});

test('365 days of daily-compounded interest equals the quoted AER', () => {
  let s = topUp(bank(), 1000000);
  s = V.post(s, { amount: 1000000, from: 'current', to: 'pot-1', desc: 'save', ts: NOW + 'T10:00:00Z' }).state;
  const after = V.accrueInterest(s, V.isoPlusDays(NOW, 365));
  const interest = V.balanceOf(after, 'pot-1') - 1000000;
  // £10,000 at 4.0% AER ⇒ £400, floored to the penny
  assert.equal(interest, 40000);
});

test('interest is idempotent for the same date and waits below a penny', () => {
  let s = topUp(bank(), 1000000);
  s = V.post(s, { amount: 100, from: 'current', to: 'pot-1', desc: 'save', ts: NOW + 'T10:00:00Z' }).state;
  const one = V.accrueInterest(s, V.isoPlusDays(NOW, 1));
  assert.equal(V.balanceOf(one, 'pot-1'), 100, '£1 for one day is sub-penny — nothing posts');
  assert.equal(V.accountById(one, 'pot-1').lastAccrualISO, NOW, 'accrual date holds so the drip is not rounded away');
  const again = V.accrueInterest(one, V.isoPlusDays(NOW, 1));
  assert.equal(JSON.stringify(again.txns), JSON.stringify(one.txns), 'same day twice posts nothing');
});

/* ---- standing orders ---- */

test('nextMonthly clamps month-ends but remembers the anchor day', () => {
  assert.equal(V.nextMonthly('2026-01-31', 31), '2026-02-28');
  assert.equal(V.nextMonthly('2026-02-28', 31), '2026-03-31', 'clamp does not erode the anchor');
  assert.equal(V.nextMonthly('2028-01-31', 31), '2028-02-29', 'leap year');
  assert.equal(V.nextMonthly('2026-12-15', 15), '2027-01-15', 'year rollover');
});

test('runDueOrders catches up every missed occurrence in order', () => {
  let s = topUp(bank(), 100000);
  s = V.addOrder(s, { to: 'Gym', amount: 3000, freq: 'monthly', startISO: '2026-05-31', desc: 'Gym membership' });
  const r = V.runDueOrders(s, '2026-07-23');
  assert.equal(r.posted.length, 2, 'May 31 + Jun 30 due; Jul 31 not yet');
  assert.equal(r.posted[0].ts.slice(0, 10), '2026-05-31');
  assert.equal(r.posted[1].ts.slice(0, 10), '2026-06-30');
  assert.equal(s.orders[0].nextISO, '2026-05-31', 'input untouched');
  assert.equal(r.state.orders[0].nextISO, '2026-07-31');
  assert.equal(V.balanceOf(r.state, 'current'), 100000 - 6000);
});

test('weekly orders advance by 7 days; short funds skip without advancing', () => {
  let s = topUp(bank(), 1000);
  s = V.addOrder(s, { to: 'Club', amount: 800, freq: 'weekly', startISO: '2026-07-01', desc: 'Club subs' });
  const r = V.runDueOrders(s, '2026-07-15');
  assert.equal(r.posted.length, 1, 'first pays, second bounces on funds');
  assert.equal(r.state.orders[0].nextISO, '2026-07-08', 'unpaid occurrence still queued to retry');
});

/* ---- insight ---- */

test('categorise maps merchants to categories; unknown inbound is income', () => {
  assert.equal(V.categorise('Tesco Express'), 'groceries');
  assert.equal(V.categorise('TfL Travel'), 'transport');
  assert.equal(V.categorise('Netflix'), 'subs');
  assert.equal(V.categorise('Salary · Acme'), 'income');
  assert.equal(V.categorise('Something odd'), 'other');
  assert.equal(V.categorise('Mystery', { from: null, to: 'current' }), 'income');
});

test('spendByCategory counts only money that left the bank, sorted desc', () => {
  let s = topUp(bank(), 100000);
  s = V.post(s, { amount: 3000, from: 'current', to: null, desc: 'Tesco Express', ts: '2026-07-02T10:00:00Z' }).state;
  s = V.post(s, { amount: 2000, from: 'current', to: null, desc: 'Tesco Express', ts: '2026-07-03T10:00:00Z' }).state;
  s = V.post(s, { amount: 4000, from: 'current', to: null, desc: 'Netflix', ts: '2026-07-04T10:00:00Z' }).state;
  s = V.post(s, { amount: 9000, from: 'current', to: 'pot-1', desc: 'Pot transfer', ts: '2026-07-05T10:00:00Z' }).state; // internal — not spend
  const cats = V.spendByCategory(s, '2026-07');
  assert.equal(cats.length, 2);
  // JSON compare: engine objects come from another vm realm, so deepStrictEqual would balk at prototypes
  assert.equal(JSON.stringify(cats.map((c) => [c.category, c.amount])), JSON.stringify([['groceries', 5000], ['subs', 4000]]));
  assert.equal(V.spendByCategory(s, '2026-06').length, 0, 'other months empty');
});

test('inOut nets external flows only', () => {
  let s = topUp(bank(), 50000); // in
  s = V.post(s, { amount: 12000, from: 'current', to: null, desc: 'Rent', ts: NOW + 'T10:00:00Z' }).state; // out
  s = V.post(s, { amount: 5000, from: 'current', to: 'pot-1', desc: 'save', ts: NOW + 'T11:00:00Z' }).state; // internal
  const io = V.inOut(s, '2026-07');
  assert.equal(io.moneyIn, 50000);
  assert.equal(io.moneyOut, 12000);
  assert.equal(io.net, 38000);
});

/* ---- statements ---- */

test('toCSV: running balance, only this account, quotes escaped', () => {
  let s = topUp(bank(), 10000);
  s = V.post(s, { amount: 2500, from: 'current', to: null, desc: 'Say "cheese", ok?', ts: NOW + 'T10:00:00Z' }).state;
  s = V.post(s, { amount: 1000, from: 'current', to: 'pot-1', desc: 'save', ts: NOW + 'T11:00:00Z' }).state;
  const csv = V.toCSV(s, 'current');
  const lines = csv.split('\n');
  assert.equal(lines[0], 'Date,Description,Category,In,Out,Balance');
  assert.equal(lines.length, 4);
  assert.ok(lines[2].includes('"Say ""cheese"", ok?"'), 'RFC-4180 escaping');
  assert.ok(lines[3].endsWith('65.00'), 'running balance 100 − 25 − 10');
  const potCsv = V.toCSV(s, 'pot-1');
  assert.equal(potCsv.split('\n').length, 2, 'pot statement sees only its own line');
});

/* ---- demo seed ---- */

test('seedDemo is deterministic and internally consistent', () => {
  const a = V.seedDemo(bank(5), V.mulberry32(99), NOW);
  const b = V.seedDemo(bank(5), V.mulberry32(99), NOW);
  assert.equal(JSON.stringify(a.txns), JSON.stringify(b.txns), 'same seed ⇒ same ledger');
  assert.ok(a.txns.length > 60, 'three months of life');
  assert.ok(V.balanceOf(a, 'current') > 0, 'demo person is solvent');
  assert.ok(V.balanceOf(a, 'pot-1') > 0, 'pot got its transfers + interest');
  assert.ok(a.txns.some((t) => t.category === 'interest'), 'interest accrued');
  assert.equal(a.orders.length, 1, 'rent standing order registered');
  assert.ok(a.orders[0].nextISO > NOW, 'next rent is in the future');
  const c = V.seedDemo(bank(5), V.mulberry32(100), NOW);
  assert.notEqual(JSON.stringify(a.txns), JSON.stringify(c.txns), 'different seed ⇒ different life');
});

/* ---- run ---- */

for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nvault: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

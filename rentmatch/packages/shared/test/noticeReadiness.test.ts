import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessSection21Readiness, type Section21Inputs } from '../src/noticeReadiness.ts';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00Z');
const NOW = START + 200 * DAY; // well past the 4-month rule

/** A fully-compliant, ready-to-serve baseline. */
const ready = (over: Partial<Section21Inputs> = {}): Section21Inputs => ({
  tenancyStartDate: START,
  monthlyRentPence: 130_000,
  deposit: { depositPence: 150_000, receivedAt: START, scheme: 'dps', protectedAt: START + DAY, prescribedInfoServedAt: START + DAY },
  gasSafetyProvided: true,
  eicrValid: true,
  epcProvided: true,
  howToRentProvided: true,
  ...over,
});

test('a fully compliant tenancy is ready to serve', () => {
  const r = assessSection21Readiness(ready(), NOW);
  assert.equal(r.ready, true);
  assert.equal(r.blockers.length, 0);
});

test('an unprotected, overdue deposit blocks and warns of the penalty', () => {
  const r = assessSection21Readiness(ready({ deposit: { depositPence: 150_000, receivedAt: START } }), NOW);
  assert.equal(r.ready, false);
  assert.ok(r.blockers.some((b) => b.id === 'deposit-overdue'));
  assert.match(r.blockers.find((b) => b.id === 'deposit-overdue')!.message, /1–3×/);
});

test('deposit still inside its 30-day window is a warning, not a blocker', () => {
  const freshStart = NOW - 5 * DAY;
  const r = assessSection21Readiness(ready({
    tenancyStartDate: NOW - 200 * DAY, // still past 4-month rule
    deposit: { depositPence: 150_000, receivedAt: freshStart },
  }), NOW);
  assert.ok(r.warnings.some((w) => w.id === 'deposit-due'));
  assert.ok(!r.blockers.some((b) => b.id.startsWith('deposit-overdue')));
});

test('an over-cap deposit blocks (Tenant Fees Act)', () => {
  // 5-week cap on £1,300pcm ≈ £1,500; £2,000 is over.
  const r = assessSection21Readiness(ready({
    deposit: { depositPence: 200_000, receivedAt: START, scheme: 'dps', protectedAt: START + DAY, prescribedInfoServedAt: START + DAY },
  }), NOW);
  assert.ok(r.blockers.some((b) => b.id === 'deposit-cap'));
});

test('each missing compliance document is a distinct blocker', () => {
  for (const [field, id] of [['gasSafetyProvided', 'gas'], ['epcProvided', 'epc'], ['eicrValid', 'eicr'], ['howToRentProvided', 'how-to-rent']] as const) {
    const r = assessSection21Readiness(ready({ [field]: false } as Partial<Section21Inputs>), NOW);
    assert.ok(r.blockers.some((b) => b.id === id), `${field} should block via ${id}`);
  }
});

test('the four-month rule blocks a brand-new tenancy', () => {
  const r = assessSection21Readiness(ready({ tenancyStartDate: NOW - 30 * DAY }), NOW);
  assert.ok(r.blockers.some((b) => b.id === 'four-month'));
  assert.equal(r.ready, false);
});

test('blockers sort before warnings in the combined items list', () => {
  const r = assessSection21Readiness(ready({
    gasSafetyProvided: false,
    tenancyStartDate: NOW - 200 * DAY,
    deposit: { depositPence: 150_000, receivedAt: NOW - 5 * DAY }, // due → warning
  }), NOW);
  assert.equal(r.items[0].severity, 'blocker');
  assert.equal(r.items[r.items.length - 1].severity, 'warning');
});

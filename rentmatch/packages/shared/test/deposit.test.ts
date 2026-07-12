import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  depositProtectionStatus, isDepositProtected, DEPOSIT_PROTECTION_DEADLINE_DAYS,
  type DepositProtection,
} from '../src/deposit.ts';

const DAY = 86_400_000;
const RECEIVED = Date.parse('2026-01-01T00:00:00Z');
const deadline = RECEIVED + DEPOSIT_PROTECTION_DEADLINE_DAYS * DAY;

const base = (over: Partial<DepositProtection> = {}): DepositProtection => ({
  depositPence: 150_000, receivedAt: RECEIVED, ...over,
});

test('no deposit → state none', () => {
  assert.equal(depositProtectionStatus(null, RECEIVED).state, 'none');
  assert.equal(depositProtectionStatus(base({ depositPence: 0 }), RECEIVED).state, 'none');
});

test('within the window, unprotected → due with days remaining', () => {
  const s = depositProtectionStatus(base(), RECEIVED + 5 * DAY);
  assert.equal(s.state, 'due');
  assert.equal(s.daysRemaining, 25);
  assert.equal(s.deadline, deadline);
});

test('protected in time but no prescribed info → info-outstanding, then blocked once late', () => {
  const dep = base({ scheme: 'dps', protectedAt: RECEIVED + 3 * DAY });
  assert.equal(depositProtectionStatus(dep, RECEIVED + 4 * DAY).state, 'info-outstanding');
  // window passes with info still not served → overdue (S21 blocked)
  assert.equal(depositProtectionStatus(dep, deadline + DAY).state, 'overdue');
});

test('fully protected in time → protected (and stays protected after the deadline)', () => {
  const dep = base({ scheme: 'tds', protectedAt: RECEIVED + 3 * DAY, prescribedInfoServedAt: RECEIVED + 3 * DAY });
  assert.equal(depositProtectionStatus(dep, RECEIVED + 10 * DAY).state, 'protected');
  assert.equal(depositProtectionStatus(dep, deadline + 400 * DAY).state, 'protected');
  assert.ok(isDepositProtected(dep, deadline + DAY));
});

test('protection recorded AFTER the deadline does not count → overdue', () => {
  const late = base({ scheme: 'mydeposits', protectedAt: deadline + DAY, prescribedInfoServedAt: deadline + DAY });
  assert.equal(depositProtectionStatus(late, deadline + 2 * DAY).state, 'overdue');
  assert.ok(!isDepositProtected(late, deadline + 2 * DAY));
});

test('unprotected and window passed → overdue', () => {
  assert.equal(depositProtectionStatus(base(), deadline + DAY).state, 'overdue');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConciergeContext, firstName } from './context.ts';

test('firstName takes the first token only', () => {
  assert.equal(firstName('Refayet Hossain'), 'Refayet');
  assert.equal(firstName('  Alexandra  Stone '), 'Alexandra');
  assert.equal(firstName(undefined), '');
});

test('builds a compact context from real state', () => {
  const ctx = buildConciergeContext({
    name: 'Refayet Hossain', tier: 'Gold',
    savedAddresses: [{ label: 'Home', addr: '14 Park Lane, Mayfair' }, { label: 'Work', addr: 'Canary Wharf E14' }],
    prefs: { temperature: 'cool', music: 'jazz', convo: 'friendly', discrete: true, extra: 'ignored' },
    rateCard: { airport_s: 185, airport_v: 225, hourly_s_rate: 65, day_s: 450, junk: 0, per_km_s: 2.2 },
    location: 'The Ritz, Piccadilly',
  })!;
  assert.deepEqual(ctx.guest, { firstName: 'Refayet', tier: 'Gold' });
  assert.equal(ctx.saved!.length, 2);
  assert.deepEqual(ctx.prefs, { temperature: 'cool', music: 'jazz', convo: 'friendly', discrete: true });
  assert.equal(ctx.rateCard!.airport_s, 185);
  assert.ok(!('junk' in ctx.rateCard!));      // zero/unknown keys dropped
  assert.equal(ctx.location, 'The Ritz, Piccadilly');
});

test('returns undefined when there is nothing useful', () => {
  assert.equal(buildConciergeContext(null), undefined);
  assert.equal(buildConciergeContext({}), undefined);
  assert.equal(buildConciergeContext({ savedAddresses: [{ label: 'X' }] }), undefined); // no addr
});

test('caps sizes: at most 6 saved places, fields truncated', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ label: 'L'.repeat(50), addr: 'A'.repeat(300) }));
  const ctx = buildConciergeContext({ savedAddresses: many })!;
  assert.equal(ctx.saved!.length, 6);
  assert.ok(ctx.saved![0].addr.length <= 120);
  assert.ok(ctx.saved![0].label.length <= 24);
});

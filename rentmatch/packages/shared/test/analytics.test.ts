import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  postcodeDistrict, percentile, median, aggregateMarketStats, aggregateDistrictOps,
  K_ANONYMITY_MIN, type AnalyticsEvent,
} from '../src/analytics.ts';

test('postcodeDistrict extracts the outward code', () => {
  assert.equal(postcodeDistrict('E8 3JN'), 'E8');
  assert.equal(postcodeDistrict('SW1A 1AA'), 'SW1A');
  assert.equal(postcodeDistrict('m1 1ae'), 'M1');
  assert.equal(postcodeDistrict('E83JN'), 'E8'); // no space
  assert.equal(postcodeDistrict(''), '');
  assert.equal(postcodeDistrict('not a postcode'), '');
});

test('percentile interpolates and median is p50', () => {
  assert.equal(percentile([1, 2, 3, 4], 25), 1.75);
  assert.equal(median([100, 200, 300]), 200);
  assert.equal(median([100, 200, 300, 400]), 250);
  assert.equal(median([7]), 7);
});

const letEvent = (rentPence: number, extra: Partial<AnalyticsEvent> = {}): AnalyticsEvent => ({
  type: 'let_agreed', ts: 1, district: 'E8', beds: 2, rentPence, ...extra,
});

test('market stats aggregate rents by district+beds with order statistics only', () => {
  const events = [150_000, 160_000, 170_000, 180_000, 190_000].map((r) => letEvent(r));
  const [stat] = aggregateMarketStats(events);
  assert.equal(stat.district, 'E8');
  assert.equal(stat.beds, 2);
  assert.equal(stat.n, 5);
  assert.equal(stat.medianRentPence, 170_000);
  assert.equal(stat.meanRentPence, 170_000);
  assert.equal(stat.p25RentPence, 160_000);
  assert.equal(stat.p75RentPence, 180_000);
  // No min/max exposed — they would leak an individual's rent.
  assert.ok(!('minRentPence' in stat) && !('maxRentPence' in stat));
});

test('k-anonymity: segments below the threshold are suppressed entirely', () => {
  const four = [1, 2, 3, 4].map((i) => letEvent(100_000 + i));
  assert.deepEqual(aggregateMarketStats(four), []);
  const five = [...four, letEvent(100_005)];
  assert.equal(aggregateMarketStats(five).length, 1);
  assert.equal(K_ANONYMITY_MIN, 5);
});

test('time-to-let median only appears with enough let observations', () => {
  const DAY = 86_400_000;
  const noTimes = [1, 2, 3, 4, 5].map((i) => letEvent(100_000 + i));
  assert.equal(aggregateMarketStats(noTimes)[0].medianTimeToLetDays, undefined);
  const withTimes = [10, 20, 30, 40, 50].map((d, i) => letEvent(100_000 + i, { timeToLetMs: d * DAY }));
  assert.equal(aggregateMarketStats(withTimes)[0].medianTimeToLetDays, 30);
});

test('events without rent, district or beds are ignored, as are non-rent events', () => {
  const events: AnalyticsEvent[] = [
    letEvent(100_000, { district: '' }),
    letEvent(100_000, { beds: undefined }),
    letEvent(0),
    { type: 'enquiry_started', ts: 1, district: 'E8', beds: 2, rentPence: 100_000 },
  ];
  assert.deepEqual(aggregateMarketStats(events), []);
});

test('district ops: arrears rate with k-anonymity suppression', () => {
  const ev = (type: AnalyticsEvent['type'], district = 'E8'): AnalyticsEvent => ({ type, ts: 1, district });
  const events = [
    ...Array.from({ length: 8 }, () => ev('rent_payment_recorded')),
    ...Array.from({ length: 2 }, () => ev('arrears_flagged')),
    ev('compliance_lapsed'),
    // Too few observations in N1 → suppressed.
    ev('rent_payment_recorded', 'N1'),
    ev('arrears_flagged', 'N1'),
  ];
  const ops = aggregateDistrictOps(events);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].district, 'E8');
  assert.equal(ops[0].paymentsObserved, 10);
  assert.equal(ops[0].arrearsRatePct, 20);
  assert.equal(ops[0].lapses, 1);
});

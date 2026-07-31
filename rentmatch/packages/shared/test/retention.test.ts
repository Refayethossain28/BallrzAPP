import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isStale, anonymiseParty, withinLegalRetention, REDACTED, RETENTION,
} from '../src/retention.ts';

const now = 2_000_000_000_000;
const daysAgo = (d: number) => now - d * 86_400_000;

test('draft listings are stale only past their window', () => {
  assert.equal(isStale('draft-listing', daysAgo(RETENTION.draftListingDays - 1), now), false);
  assert.equal(isStale('draft-listing', daysAgo(RETENTION.draftListingDays + 1), now), true);
});

test('abandoned enquiries use the longer window', () => {
  assert.equal(isStale('abandoned-enquiry', daysAgo(100), now), false);
  assert.equal(isStale('abandoned-enquiry', daysAgo(RETENTION.abandonedEnquiryDays + 1), now), true);
});

test('anonymiseParty redacts name and email', () => {
  assert.deepEqual(anonymiseParty({ name: 'Tom Baxter', email: 't@example.co.uk' }), {
    name: REDACTED,
    email: REDACTED,
  });
});

test('completed tenancies stay within legal retention for ~7 years', () => {
  assert.equal(withinLegalRetention(daysAgo(365), now), true);
  assert.equal(withinLegalRetention(daysAgo(RETENTION.completedTenancyYears * 365 + 1), now), false);
});

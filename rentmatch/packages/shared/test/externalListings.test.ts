import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeExternalListing, dedupeExternalListings, searchExternalListings,
  externalListingId, externalListingExpired, EXTERNAL_LISTING_TTL_DAYS,
  type ExternalFeedItem,
} from '../src/externalListings.ts';

const item = (over: Partial<ExternalFeedItem> = {}): ExternalFeedItem => ({
  id: 'p-101',
  url: 'https://example-lettings.co.uk/p/101',
  title: 'Bright 2-bed flat',
  area: 'Hackney',
  city: 'London',
  postcode: 'E8 3JN',
  beds: 2,
  rentPcm: 1850,
  ...over,
});

test('normalize: a well-formed feed item maps to a stored listing', () => {
  const l = normalizeExternalListing(item({ baths: 1, furnished: 'Furnished', availableFrom: '2026-08-01' }), 'OpenLet');
  assert.ok(l);
  assert.equal(l.id, 'openlet:p-101');
  assert.equal(l.source, 'OpenLet');
  assert.equal(l.rentPence, 185_000); // £1,850 pcm → pence
  assert.equal(l.district, 'E8'); // coarse geography only
  assert.equal(l.baths, 1);
  assert.equal(l.availableFromMs, Date.parse('2026-08-01'));
});

test('normalize: exact pence takes precedence over pcm pounds', () => {
  const l = normalizeExternalListing(item({ rentPence: 199_900, rentPcm: 1850 }), 'OpenLet');
  assert.equal(l?.rentPence, 199_900);
});

test('normalize: junk rows are dropped, never fixed up', () => {
  const bad: Array<Partial<ExternalFeedItem>> = [
    { url: 'http://insecure.example.com/p/1' }, // https only
    { url: 'javascript:alert(1)' },
    { title: '   ' },
    { city: '' },
    { beds: 2.5 },
    { beds: -1 },
    { beds: 99 },
    { rentPcm: undefined, rentPence: undefined }, // no rent at all
    { rentPcm: 5 }, // £5 pcm — junk
    { rentPcm: 2_000_000 }, // £2m pcm — junk
    { id: '' },
  ];
  for (const over of bad) {
    assert.equal(normalizeExternalListing(item(over), 'OpenLet'), null, JSON.stringify(over));
  }
  // A junk image or unparseable date degrades gracefully instead of dropping the row.
  const l = normalizeExternalListing(item({ imageUrl: 'http://not-https', availableFrom: 'soon' }), 'OpenLet');
  assert.ok(l && !('imageUrl' in l) && !('availableFromMs' in l));
});

test('normalize: ids are deterministic and Firestore-safe', () => {
  assert.equal(externalListingId('Open Let!', 'P/101 x'), 'open-let:p-101-x');
  const a = normalizeExternalListing(item(), 'OpenLet');
  const b = normalizeExternalListing(item(), 'OpenLet');
  assert.equal(a?.id, b?.id); // re-ingestion upserts in place
});

test('dedupe: same id and cross-source syndication collapse to one card', () => {
  const a = normalizeExternalListing(item(), 'OpenLet')!;
  const again = normalizeExternalListing(item(), 'OpenLet')!;
  const syndicated = normalizeExternalListing(item({ id: 'z-9', url: 'https://other.example.com/9' }), 'HomeFeed')!;
  const different = normalizeExternalListing(item({ id: 'p-202', title: 'Garden studio', beds: 0, rentPcm: 1200 }), 'OpenLet')!;
  const out = dedupeExternalListings([a, again, syndicated, different]);
  assert.deepEqual(out.map((l) => l.id), ['openlet:p-101', 'openlet:p-202']);
});

test('search: filters match Browse semantics and sort is cheapest-first', () => {
  const mk = (id: string, city: string, beds: number, rentPcm: number) =>
    normalizeExternalListing(item({ id, city, beds, rentPcm }), 'OpenLet')!;
  const all = [mk('a', 'London', 2, 1900), mk('b', 'Leeds', 1, 900), mk('c', 'London', 3, 1500)];
  assert.deepEqual(searchExternalListings(all, { city: 'London' }).map((l) => l.rentPence), [150_000, 190_000]);
  assert.equal(searchExternalListings(all, { minBeds: 3 }).length, 1);
  assert.equal(searchExternalListings(all, { maxRentPence: 100_000 })[0].city, 'Leeds');
});

test('staleness: listings unseen for the TTL have left the market', () => {
  const now = Date.parse('2026-07-01');
  const day = 86_400_000;
  assert.equal(externalListingExpired(now - (EXTERNAL_LISTING_TTL_DAYS - 1) * day, now), false);
  assert.equal(externalListingExpired(now - (EXTERNAL_LISTING_TTL_DAYS + 1) * day, now), true);
});

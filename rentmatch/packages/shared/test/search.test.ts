import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchListings,
  filterListings,
  sortListings,
  listedCities,
  type ListingSummary,
} from '../src/search.ts';

const base: Omit<ListingSummary, 'id'> = {
  title: 'Flat',
  area: 'Hackney',
  city: 'London',
  postcode: 'E8 3JN',
  type: 'Flat',
  beds: 2,
  baths: 1,
  rentPence: 220000,
  furnished: 'Furnished',
  epcRating: 'C',
  availableFrom: 0,
  createdAt: 100,
  status: 'live',
};

const listings: ListingSummary[] = [
  { ...base, id: 'a', city: 'London', postcode: 'E8 3JN', beds: 2, rentPence: 220000, createdAt: 300 },
  { ...base, id: 'b', city: 'Leeds', postcode: 'LS6 1LJ', beds: 3, rentPence: 165000, createdAt: 200, title: 'Terrace house' },
  { ...base, id: 'c', city: 'Manchester', postcode: 'M4 1LW', beds: 0, rentPence: 95000, createdAt: 400, type: 'Studio' },
  { ...base, id: 'd', city: 'London', postcode: 'SE1 9SG', beds: 1, rentPence: 110000, createdAt: 100, status: 'let' },
];

test('search excludes non-live listings', () => {
  const ids = searchListings(listings).map((l) => l.id);
  assert.ok(!ids.includes('d'));
  assert.equal(ids.length, 3);
});

test('newest sort is the default', () => {
  assert.deepEqual(searchListings(listings).map((l) => l.id), ['c', 'a', 'b']);
});

test('filter by city', () => {
  assert.deepEqual(searchListings(listings, { city: 'London' }).map((l) => l.id), ['a']);
});

test('minBeds includes studios when 0, excludes below threshold', () => {
  assert.deepEqual(filterListings(listings, { minBeds: 0 }).map((l) => l.id).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterListings(listings, { minBeds: 2 }).map((l) => l.id).sort(), ['a', 'b']);
});

test('maxRentPence cap', () => {
  assert.deepEqual(
    searchListings(listings, { maxRentPence: 120000 }, 'price-asc').map((l) => l.id),
    ['c'],
  );
});

test('free-text query spans title/area/city/postcode', () => {
  assert.deepEqual(searchListings(listings, { query: 'terrace' }).map((l) => l.id), ['b']);
  assert.deepEqual(searchListings(listings, { query: 'e8' }).map((l) => l.id).sort(), ['a']);
});

test('price sorts', () => {
  assert.deepEqual(sortListings(listings, 'price-asc').map((l) => l.rentPence)[0], 95000);
  assert.deepEqual(sortListings(listings, 'price-desc').map((l) => l.rentPence)[0], 220000);
});

test('listedCities is distinct and sorted', () => {
  assert.deepEqual(listedCities(listings), ['Leeds', 'London', 'Manchester']);
});

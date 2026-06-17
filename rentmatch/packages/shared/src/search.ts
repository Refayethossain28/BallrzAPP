/**
 * Listing search — pure filtering/sorting shared by the web client (live,
 * client-side over fetched listings at MVP) and any server-side search later.
 * Keeping it here means the same semantics are testable in isolation.
 */
import type { EpcRating } from './types.ts';

export type ListingStatus = 'draft' | 'live' | 'let';

/** Denormalised listing shape used for browsing and search. */
export interface ListingSummary {
  id: string;
  title: string;
  area: string;
  city: string;
  postcode: string;
  type: string;
  beds: number; // 0 = studio
  baths: number;
  rentPence: number;
  furnished: string;
  epcRating: EpcRating;
  availableFrom: number; // epoch ms
  createdAt: number; // epoch ms
  status: ListingStatus;
}

export interface ListingFilter {
  city?: string;
  /** Minimum bedrooms; 0 matches studios and up. */
  minBeds?: number;
  maxRentPence?: number;
  furnished?: string;
  /** Free-text across title, area, city and postcode. */
  query?: string;
}

export type ListingSort = 'newest' | 'price-asc' | 'price-desc' | 'beds-desc';

function matches(listing: ListingSummary, filter: ListingFilter): boolean {
  if (filter.city && listing.city !== filter.city) return false;
  if (filter.minBeds != null && listing.beds < filter.minBeds) return false;
  if (filter.maxRentPence != null && listing.rentPence > filter.maxRentPence) return false;
  if (filter.furnished && listing.furnished !== filter.furnished) return false;
  if (filter.query && filter.query.trim()) {
    const q = filter.query.trim().toLowerCase();
    const hay = `${listing.title} ${listing.area} ${listing.city} ${listing.postcode}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function filterListings(listings: ListingSummary[], filter: ListingFilter): ListingSummary[] {
  return listings.filter((l) => matches(l, filter));
}

export function sortListings(listings: ListingSummary[], sort: ListingSort): ListingSummary[] {
  const copy = listings.slice();
  switch (sort) {
    case 'price-asc':
      return copy.sort((a, b) => a.rentPence - b.rentPence);
    case 'price-desc':
      return copy.sort((a, b) => b.rentPence - a.rentPence);
    case 'beds-desc':
      return copy.sort((a, b) => b.beds - a.beds || a.rentPence - b.rentPence);
    case 'newest':
    default:
      return copy.sort((a, b) => b.createdAt - a.createdAt);
  }
}

/**
 * The browse query: only live listings, filtered then sorted. `let`/`draft`
 * listings never appear in renter search results.
 */
export function searchListings(
  listings: ListingSummary[],
  filter: ListingFilter = {},
  sort: ListingSort = 'newest',
): ListingSummary[] {
  const live = listings.filter((l) => l.status === 'live');
  return sortListings(filterListings(live, filter), sort);
}

/** Distinct cities present in a set of listings, for the city filter dropdown. */
export function listedCities(listings: ListingSummary[]): string[] {
  return [...new Set(listings.map((l) => l.city))].sort();
}

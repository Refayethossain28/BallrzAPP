/**
 * External listings — aggregating homes from across the web into Browse.
 *
 * Reality of the UK market: the big portals (Rightmove, Zoopla, OnTheMarket)
 * publish no public API and prohibit scraping, so a legitimate aggregator
 * ingests **licensed feeds** — from data partners, agency CRMs pushing their
 * stock, or providers with permissive terms. This module defines the one
 * generic feed contract every source is normalised through, so plugging in a
 * new provider is configuration (a URL), not code.
 *
 * Pure and unit-tested: validation, normalisation, cross-source de-dup and
 * staleness policy live here; fetching and Firestore I/O live in functions.
 */
import { postcodeDistrict } from './analytics.ts';

/**
 * The generic feed item Apex ingests — the JSON contract a licensed provider
 * (or a partner agency's CRM export) supplies. Rent may be quoted in pounds
 * per calendar month (`rentPcm`, the industry convention) or exact pence.
 */
export interface ExternalFeedItem {
  /** Stable id within the source — re-runs must yield the same id. */
  id: string;
  /** Canonical listing page on the source site (https only). */
  url: string;
  title: string;
  area?: string;
  city: string;
  postcode?: string;
  /** 0 = studio. */
  beds: number;
  baths?: number;
  /** Pounds per calendar month (portal convention)… */
  rentPcm?: number;
  /** …or exact pence; takes precedence when both are present. */
  rentPence?: number;
  furnished?: string;
  propertyType?: string;
  /** ISO date. */
  availableFrom?: string;
  /** https only. */
  imageUrl?: string;
}

/** A normalised external listing as stored and shown in Browse. */
export interface ExternalListing {
  /** Deterministic: `source:sourceId` slugged — re-ingestion upserts in place. */
  id: string;
  source: string;
  url: string;
  title: string;
  area: string;
  city: string;
  /** Coarse geography (outward code), '' when the feed has no postcode. */
  district: string;
  beds: number;
  baths?: number;
  rentPence: number;
  furnished?: string;
  propertyType?: string;
  availableFromMs?: number;
  imageUrl?: string;
}

/** External listings unseen by any feed for this long have left the market. */
export const EXTERNAL_LISTING_TTL_DAYS = 14;

export function externalListingExpired(lastSeenMs: number, now: number): boolean {
  return now - lastSeenMs > EXTERNAL_LISTING_TTL_DAYS * 86_400_000;
}

/** Sane pcm bounds — outside these the feed row is junk, not a home. */
const MIN_RENT_PENCE = 10_000; // £100
const MAX_RENT_PENCE = 10_000_000; // £100k

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Deterministic Firestore-safe doc id, stable across re-ingestions. */
export function externalListingId(source: string, itemId: string): string {
  return `${slug(source)}:${slug(itemId)}`;
}

const cleanText = (v: unknown, maxLen: number): string =>
  typeof v === 'string' ? v.trim().slice(0, maxLen) : '';

const httpsUrl = (v: unknown, maxLen = 500): string => {
  if (typeof v !== 'string' || v.length > maxLen) return '';
  try {
    return new URL(v).protocol === 'https:' ? v : '';
  } catch {
    return '';
  }
};

/**
 * Validate + normalise one feed item. Returns null when the row can't be
 * trusted (bad url, no title/city, junk rent) — a bad row is dropped, never
 * "fixed up", so garbage in a feed can't reach renters.
 */
export function normalizeExternalListing(
  item: ExternalFeedItem,
  source: string,
): ExternalListing | null {
  const src = cleanText(source, 40);
  const id = cleanText(item?.id, 120);
  const url = httpsUrl(item?.url);
  const title = cleanText(item?.title, 140);
  const city = cleanText(item?.city, 60);
  if (!src || !id || !url || !title || !city) return null;

  const beds = item.beds;
  if (typeof beds !== 'number' || !Number.isInteger(beds) || beds < 0 || beds > 20) return null;

  const rentPence =
    typeof item.rentPence === 'number' && Number.isInteger(item.rentPence)
      ? item.rentPence
      : typeof item.rentPcm === 'number' && Number.isFinite(item.rentPcm)
        ? Math.round(item.rentPcm * 100)
        : NaN;
  if (!Number.isInteger(rentPence) || rentPence < MIN_RENT_PENCE || rentPence > MAX_RENT_PENCE) return null;

  const baths = item.baths;
  const availableFromMs = item.availableFrom ? Date.parse(item.availableFrom) : NaN;

  return {
    id: externalListingId(src, id),
    source: src,
    url,
    title,
    area: cleanText(item.area, 60),
    city,
    district: postcodeDistrict(cleanText(item.postcode, 12)),
    beds,
    ...(typeof baths === 'number' && Number.isInteger(baths) && baths >= 1 && baths <= 10 ? { baths } : {}),
    rentPence,
    ...(cleanText(item.furnished, 40) ? { furnished: cleanText(item.furnished, 40) } : {}),
    ...(cleanText(item.propertyType, 40) ? { propertyType: cleanText(item.propertyType, 40) } : {}),
    ...(Number.isFinite(availableFromMs) ? { availableFromMs } : {}),
    ...(httpsUrl(item.imageUrl) ? { imageUrl: httpsUrl(item.imageUrl) } : {}),
  };
}

/** Near-dup key: the same home syndicated to two sources lists with the same
 *  city, beds, rent and (normalised) title — one card, not three. */
const nearDupKey = (l: ExternalListing): string =>
  `${l.city.toLowerCase()}|${l.beds}|${l.rentPence}|${l.title.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;

/** Drop exact re-ingestions (same id) and cross-source syndication dupes. */
export function dedupeExternalListings(listings: ExternalListing[]): ExternalListing[] {
  const byId = new Set<string>();
  const byShape = new Set<string>();
  const out: ExternalListing[] = [];
  for (const l of listings) {
    const shape = nearDupKey(l);
    if (byId.has(l.id) || byShape.has(shape)) continue;
    byId.add(l.id);
    byShape.add(shape);
    out.push(l);
  }
  return out;
}

export interface ExternalListingFilter {
  city?: string;
  minBeds?: number;
  maxRentPence?: number;
}

/** The Browse query over external stock: filter, then cheapest-first within
 *  a stable ordering (price is the one field renters compare across sites). */
export function searchExternalListings(
  listings: ExternalListing[],
  filter: ExternalListingFilter = {},
): ExternalListing[] {
  return listings
    .filter((l) =>
      (!filter.city || l.city === filter.city)
      && (filter.minBeds == null || l.beds >= filter.minBeds)
      && (filter.maxRentPence == null || l.rentPence <= filter.maxRentPence))
    .sort((a, b) => a.rentPence - b.rentPence || a.id.localeCompare(b.id));
}

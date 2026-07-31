/**
 * Sample external listings for the static demo build (VITE_DEMO_SAMPLES=1,
 * set by the GitHub Pages workflow). The demo has no backend, so without
 * these the aggregated-listings section would be invisible; in a real
 * deployment the section is fed by the `syncExternalListings` cron and these
 * samples are never used. Clearly flagged as examples in the UI.
 */
import type { ExternalListing } from '@rentmatch/shared';
import { fetchExternalListings } from './db';

const sample = (l: Omit<ExternalListing, 'url'> & { url?: string }): ExternalListing => ({
  url: `https://example.com/demo/${l.id}`,
  ...l,
});

export const DEMO_EXTERNAL_LISTINGS: ExternalListing[] = [
  sample({ id: 'openlet:d1', source: 'OpenLet', title: 'Sunny 1-bed flat by London Fields', area: 'Hackney', city: 'London', district: 'E8', beds: 1, baths: 1, rentPence: 172_500, furnished: 'Furnished' }),
  sample({ id: 'openlet:d2', source: 'OpenLet', title: 'Warehouse-conversion 2-bed loft', area: 'Ancoats', city: 'Manchester', district: 'M4', beds: 2, baths: 2, rentPence: 145_000, furnished: 'Unfurnished' }),
  sample({ id: 'homefeed:d3', source: 'HomeFeed', title: 'Georgian garden flat', area: 'Clifton', city: 'Bristol', district: 'BS8', beds: 2, baths: 1, rentPence: 160_000, furnished: 'Furnished' }),
  sample({ id: 'homefeed:d4', source: 'HomeFeed', title: 'Modern studio near the station', area: 'Headingley', city: 'Leeds', district: 'LS6', beds: 0, baths: 1, rentPence: 87_500, furnished: 'Furnished' }),
  sample({ id: 'openlet:d5', source: 'OpenLet', title: '3-bed terrace with parking', area: 'Jesmond', city: 'Newcastle', district: 'NE2', beds: 3, baths: 2, rentPence: 135_000, furnished: 'Part-furnished' }),
];

export interface ExternalFeedResult {
  listings: ExternalListing[];
  /** True when showing bundled example data (static demo, no backend). */
  sample: boolean;
}

/** Reject slow reads: with no backend the Firestore SDK retries forever
 *  rather than failing, so a deadline is the only way to reach the fallback. */
const deadline = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([
  p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('firestore deadline')), ms)),
]);

/** External stock for Browse: the real aggregated collection, or — only in
 *  the demo build — bundled samples when the backend is absent/empty/silent. */
export async function fetchExternalForBrowse(): Promise<ExternalFeedResult> {
  const demo = import.meta.env.VITE_DEMO_SAMPLES === '1';
  try {
    const listings = await deadline(fetchExternalListings(), 6_000);
    if (listings.length > 0 || !demo) return { listings, sample: false };
  } catch (err) {
    if (!demo) throw err;
  }
  return { listings: DEMO_EXTERNAL_LISTINGS, sample: true };
}

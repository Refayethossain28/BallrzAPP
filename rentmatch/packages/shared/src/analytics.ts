/**
 * Property-industry analytics — pure event taxonomy + aggregation.
 *
 * Privacy is a design constraint, not an afterthought:
 * - Events are **pseudonymous**: they may carry a uid for internal dedup and
 *   GDPR erasure, but never names, emails, or full addresses.
 * - Geography is coarsened to the **postcode district** ("E8 3JN" → "E8"),
 *   which cannot identify a property.
 * - Published aggregates are **k-anonymised**: a (district, beds) group is
 *   suppressed entirely unless it contains at least `K_ANONYMITY_MIN`
 *   observations, and only order statistics (median/quartiles) are exposed —
 *   never minima/maxima, which would leak individual rents.
 *
 * The result is the dataset the industry actually values — achieved rents,
 * time-to-let, arrears and compliance rates by area — without trading away
 * any user's privacy. Pure and unit-tested; I/O lives in the app/functions.
 */

export type AnalyticsEventType =
  | 'listing_published'
  | 'enquiry_started'
  | 'viewing_confirmed'
  | 'let_agreed' // deal completed: rent achieved + time-to-let
  | 'tenancy_created'
  | 'tenancy_renewed' // rent change on renewal
  | 'rent_payment_recorded'
  | 'arrears_flagged'
  | 'compliance_doc_uploaded'
  | 'compliance_lapsed'
  | 'dd_mandate_active'
  | 'subscription_started'
  | 'statement_exported'
  | 'external_listing_click'; // demand signal: renter followed an aggregated listing out

/** One pseudonymous event. Only coarse, non-identifying fields. */
export interface AnalyticsEvent {
  type: AnalyticsEventType;
  /** Epoch ms. */
  ts: number;
  /** Pseudonymous actor (uid) — internal only, enables GDPR erasure. */
  actorId?: string;
  /** Coarse geography: postcode district, e.g. "E8", "SW1A". */
  district?: string;
  beds?: number;
  rentPence?: number;
  termMonths?: number;
  /** Enquiry → completion, for let_agreed. */
  timeToLetMs?: number;
  /** Renewal rent movement, percent. */
  rentChangePct?: number;
  /** Document type for compliance events. */
  docType?: string;
  /** Plan id for subscription events. */
  plan?: string;
}

/**
 * Postcode district (the outward code: "E8 3JN" → "E8", "SW1A 1AA" → "SW1A").
 * Tolerates missing space and lowercase; returns '' when it can't parse, so
 * callers simply omit the field rather than storing junk.
 */
export function postcodeDistrict(postcode: string): string {
  const cleaned = (postcode ?? '').trim().toUpperCase().replace(/[^A-Z0-9 ]/g, '');
  if (!cleaned) return '';
  // With a space: outward code is the first token. Without: strip the inward
  // code (digit + two letters) off the end.
  const outward = cleaned.includes(' ')
    ? cleaned.split(/\s+/)[0]
    : cleaned.replace(/[0-9][A-Z]{2}$/, '');
  return /^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(outward) ? outward : '';
}

/** Suppress aggregates for groups smaller than this (k-anonymity). */
export const K_ANONYMITY_MIN = 5;

/** Interpolated percentile (p in 0–100) of a non-empty numeric list. */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export const median = (values: number[]): number => percentile(values, 50);

/** Aggregated market picture for one (district, beds) segment. */
export interface MarketStat {
  district: string;
  beds: number;
  /** Observations in the segment (always ≥ the k-anonymity minimum). */
  n: number;
  medianRentPence: number;
  meanRentPence: number;
  p25RentPence: number;
  p75RentPence: number;
  /** Median days from enquiry to a completed let, when observed. */
  medianTimeToLetDays?: number;
}

/** District-level operational rates (arrears / compliance), k-anonymised. */
export interface DistrictOps {
  district: string;
  /** Tenancies observed making payments in the window. */
  paymentsObserved: number;
  /** Share of observed payment events flagged as arrears, percent. */
  arrearsRatePct: number;
  /** Compliance lapses observed in the window. */
  lapses: number;
}

const DAY_MS = 86_400_000;

/**
 * Roll rent-bearing events into per-(district, beds) market stats. Only
 * `let_agreed`, `tenancy_created` and `tenancy_renewed` events carry an
 * achieved rent. Groups below `k` observations are suppressed entirely.
 */
export function aggregateMarketStats(
  events: AnalyticsEvent[],
  k: number = K_ANONYMITY_MIN,
): MarketStat[] {
  const groups = new Map<string, AnalyticsEvent[]>();
  for (const e of events) {
    if (e.type !== 'let_agreed' && e.type !== 'tenancy_created' && e.type !== 'tenancy_renewed') continue;
    if (!e.district || e.beds == null || !e.rentPence || e.rentPence <= 0) continue;
    const key = `${e.district}|${e.beds}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }

  const stats: MarketStat[] = [];
  for (const [key, group] of groups) {
    if (group.length < k) continue; // k-anonymity: suppress small segments
    const [district, beds] = key.split('|');
    const rents = group.map((e) => e.rentPence!);
    const lets = group.filter((e) => e.type === 'let_agreed' && e.timeToLetMs != null);
    stats.push({
      district,
      beds: Number(beds),
      n: group.length,
      medianRentPence: Math.round(median(rents)),
      meanRentPence: Math.round(rents.reduce((s, r) => s + r, 0) / rents.length),
      p25RentPence: Math.round(percentile(rents, 25)),
      p75RentPence: Math.round(percentile(rents, 75)),
      ...(lets.length >= k
        ? { medianTimeToLetDays: Math.round(median(lets.map((e) => e.timeToLetMs! / DAY_MS))) }
        : {}),
    });
  }
  return stats.sort((a, b) => a.district.localeCompare(b.district) || a.beds - b.beds);
}

/** Arrears + compliance-lapse rates per district, suppressed below `k` observations. */
export function aggregateDistrictOps(
  events: AnalyticsEvent[],
  k: number = K_ANONYMITY_MIN,
): DistrictOps[] {
  const byDistrict = new Map<string, { payments: number; arrears: number; lapses: number }>();
  for (const e of events) {
    if (!e.district) continue;
    const d = byDistrict.get(e.district) ?? { payments: 0, arrears: 0, lapses: 0 };
    if (e.type === 'rent_payment_recorded') d.payments += 1;
    else if (e.type === 'arrears_flagged') d.arrears += 1;
    else if (e.type === 'compliance_lapsed') d.lapses += 1;
    byDistrict.set(e.district, d);
  }

  const out: DistrictOps[] = [];
  for (const [district, d] of byDistrict) {
    const observed = d.payments + d.arrears;
    if (observed < k) continue;
    out.push({
      district,
      paymentsObserved: observed,
      arrearsRatePct: Math.round((d.arrears / observed) * 1000) / 10,
      lapses: d.lapses,
    });
  }
  return out.sort((a, b) => a.district.localeCompare(b.district));
}

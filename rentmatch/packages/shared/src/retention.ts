/**
 * Data-retention windows and GDPR helpers — pure so the purge job and the
 * erasure flow share one definition of "stale" and one redaction marker.
 */

export const RETENTION = {
  /** Unpublished drafts with no activity are purged after this many days. */
  draftListingDays: 90,
  /** Enquiries that never progressed past `enquiry` are purged after this. */
  abandonedEnquiryDays: 180,
  /** Completed tenancies are retained this long (HMRC / limitation period). */
  completedTenancyYears: 7,
} as const;

const DAY_MS = 86_400_000;

export type PurgeableKind = 'draft-listing' | 'abandoned-enquiry';

/** Whether a record of the given kind is past its retention window. */
export function isStale(kind: PurgeableKind, lastActivityMs: number, now: number = Date.now()): boolean {
  const ageDays = (now - lastActivityMs) / DAY_MS;
  switch (kind) {
    case 'draft-listing':
      return ageDays >= RETENTION.draftListingDays;
    case 'abandoned-enquiry':
      return ageDays >= RETENTION.abandonedEnquiryDays;
  }
}

/** Marker written in place of erased personal data. */
export const REDACTED = '[erased]';

export interface ErasableParty {
  name: string;
  email: string;
}

export function anonymiseParty(_party: ErasableParty): ErasableParty {
  return { name: REDACTED, email: REDACTED };
}

/**
 * Whether a completed tenancy is still within its legal retention period — i.e.
 * its records (contract, payment) must be kept rather than erased on request.
 */
export function withinLegalRetention(completedAtMs: number, now: number = Date.now()): boolean {
  return (now - completedAtMs) / DAY_MS < RETENTION.completedTenancyYears * 365;
}

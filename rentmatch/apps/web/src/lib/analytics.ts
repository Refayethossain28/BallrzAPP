import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import type { AnalyticsEvent } from '@rentmatch/shared';
import { auth, db } from './firebase';

/**
 * Fire-and-forget pseudonymous analytics. Events carry the uid (for GDPR
 * erasure) and coarse fields only — never names, emails or full addresses (see
 * the shared analytics module for the taxonomy and the privacy constraints).
 * Failures are swallowed: analytics must never block or break a user flow.
 */
export function track(event: Omit<AnalyticsEvent, 'ts' | 'actorId'>): void {
  // Wrapped whole: addDoc validates field values synchronously and THROWS on an
  // undefined value (not just an async rejection), so a `.catch()` alone can't
  // honour the "never break a user flow" contract. Strip undefined fields too.
  try {
    const uid = auth.currentUser?.uid;
    if (!uid) return; // rules require an authenticated, attributed event
    const clean: Record<string, unknown> = { actorId: uid, ts: Date.now(), recordedAt: serverTimestamp() };
    for (const [k, v] of Object.entries(event)) if (v !== undefined) clean[k] = v;
    addDoc(collection(db, 'analyticsEvents'), clean).catch(() => {});
  } catch {
    /* analytics must never throw into a caller */
  }
}

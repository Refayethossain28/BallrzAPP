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
  const uid = auth.currentUser?.uid;
  if (!uid) return; // rules require an authenticated, attributed event
  addDoc(collection(db, 'analyticsEvents'), {
    ...event,
    actorId: uid,
    ts: Date.now(),
    recordedAt: serverTimestamp(),
  }).catch(() => {});
}

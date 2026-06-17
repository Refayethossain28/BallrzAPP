import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import type { ComplianceCheck } from '@rentmatch/shared';
import { app } from './firebase';

export const functions = getFunctions(app);

if (import.meta.env.VITE_USE_EMULATORS === '1') {
  connectFunctionsEmulator(functions, 'localhost', 5001);
}

/** Server-authoritative: only the landlord, only when both parties agreed. */
export const draftContract = httpsCallable<{ dealId: string }, { contractId: string; stage: string }>(
  functions,
  'draftContract',
);

/** Landlord opens the e-signature envelope (stage → signing). */
export const openSigning = httpsCallable<{ dealId: string }, { stage: string; envelopeId: string }>(
  functions,
  'openSigning',
);

/** Record the calling party's signature (stands in for the e-sign webhook). */
export const recordSignature = httpsCallable<{ dealId: string }, { stage: string; bothSigned: boolean }>(
  functions,
  'recordSignature',
);

/** Create a Stripe SetupIntent so the landlord can save a card. */
export const createSetupIntent = httpsCallable<void, { clientSecret: string }>(
  functions,
  'createSetupIntent',
);

/** Charge the landlord's £100 fee on full execution (off-session, idempotent). */
export const chargePlatformFee = httpsCallable<{ dealId: string }, { status: string }>(
  functions,
  'chargePlatformFee',
);

/** Server-authoritative publish: re-checks uploaded docs, flips to live or draft. */
export const publishListing = httpsCallable<{ listingId: string }, { status: 'live' | 'draft'; checks: ComplianceCheck[] }>(
  functions,
  'publishListing',
);

/** Store this device's Web Push (FCM) token for the signed-in user. */
export const registerPushToken = httpsCallable<{ token: string }, { ok: boolean }>(
  functions,
  'registerPushToken',
);

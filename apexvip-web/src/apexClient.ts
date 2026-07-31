/**
 * Typed ApexVIP callable client.
 *
 * A thin, fully-typed wrapper over Firebase callable functions. Every call is
 * checked against the shared contract (`@apexvip/contract` → functions/src):
 * the request `data` must match the function's input, and the resolved value is
 * the function's declared result. Misspell a field or read one the backend never
 * returns and it's a compile error, not a production incident.
 *
 * This is the migration on-ramp: new web code (and the single-file HTML apps as
 * they move into this build) call `apex.processSquarePayment({...})` instead of
 * the stringly-typed `httpsCallable('processSquarePayment')(...)`.
 *
 * The backend deploys to us-central1 (see the `region` on each onCall in
 * functions/src/index.ts), so the client must target the same region.
 */

import { type FirebaseApp } from 'firebase/app';
import { getFunctions, httpsCallable, type Functions } from 'firebase/functions';
import type { ApexCallables, ApexCallableName } from '@apexvip/contract';

export const APEX_REGION = 'us-central1';

/** Resolve the Functions handle for the ApexVIP backend region. */
export function apexFunctions(app: FirebaseApp): Functions {
  return getFunctions(app, APEX_REGION);
}

/**
 * Invoke a callable by name with a request typed to its contract, resolving to
 * the function's typed result. This is the one primitive; `makeApexClient` below
 * wraps it into a convenient per-function object.
 */
export async function callApex<K extends ApexCallableName>(
  fns: Functions,
  name: K,
  data: ApexCallables[K]['data'],
): Promise<ApexCallables[K]['result']> {
  const fn = httpsCallable<ApexCallables[K]['data'], ApexCallables[K]['result']>(fns, name);
  const res = await fn(data);
  return res.data;
}

/** A method per callable, e.g. `apex.getHotelRates({ lat, lng, checkIn })`. */
export type ApexClient = {
  [K in ApexCallableName]: (
    data: ApexCallables[K]['data'],
  ) => Promise<ApexCallables[K]['result']>;
};

const CALLABLE_NAMES: ApexCallableName[] = [
  'getHotelRates',
  'processSquarePayment',
  'captureSquarePayment',
  'refundSquarePayment',
  'parseBookingIntent',
  'generateReferralCode',
  'applyReferralCode',
  'sendChauffeurMessage',
  'submitTripRating',
  'checkFlightStatus',
  'validateApplePayMerchant',
  'createDriverPayoutAccount',
  'getDriverPayoutStatus',
  'payoutDriver',
];

/**
 * Build the typed client from a Firebase app. Each property is a typed callable;
 * the contract drives both the argument and the return type at every call site.
 */
export function makeApexClient(app: FirebaseApp): ApexClient {
  const fns = apexFunctions(app);
  const client = {} as Record<ApexCallableName, (data: unknown) => Promise<unknown>>;
  for (const name of CALLABLE_NAMES) {
    client[name] = (data: unknown) => callApex(fns, name, data as never);
  }
  return client as ApexClient;
}

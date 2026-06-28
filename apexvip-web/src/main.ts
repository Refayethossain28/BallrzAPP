/**
 * Demo entry — proves the typed client compiles and the contract flows through
 * to call sites. Nothing here makes a network request on load; the booking call
 * is wired to a button and only runs once Firebase is configured.
 *
 * Use APEXVIP_FIREBASE_CONFIG (the same global the HTML apps read) so this build
 * can eventually drop into the existing hosting without re-plumbing config.
 */

import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { makeApexClient, type ApexClient } from './apexClient.js';
import type { ApexCallableName } from '@apexvip/contract';

declare global {
  // Provided at runtime by the host page (firebase.js / config), as today.
  // eslint-disable-next-line no-var
  var APEXVIP_FIREBASE_CONFIG: FirebaseOptions | undefined;
}

const NAMES: ApexCallableName[] = [
  'getHotelRates', 'processSquarePayment', 'captureSquarePayment', 'refundSquarePayment',
  'parseBookingIntent', 'generateReferralCode', 'applyReferralCode', 'sendChauffeurMessage',
  'submitTripRating', 'checkFlightStatus', 'validateApplePayMerchant',
  'createDriverPayoutAccount', 'getDriverPayoutStatus', 'payoutDriver',
];

// Render the available typed callables so the page shows the build is live.
const list = document.getElementById('callables');
if (list) {
  for (const name of NAMES) {
    const li = document.createElement('li');
    li.innerHTML = `<code>apex.${name}(…)</code>`;
    list.appendChild(li);
  }
}

// Only build the client when real config is present (placeholder is ignored).
const cfg = globalThis.APEXVIP_FIREBASE_CONFIG;
if (cfg && cfg.apiKey && cfg.apiKey !== 'YOUR_API_KEY') {
  const app = initializeApp(cfg);
  const apex: ApexClient = makeApexClient(app);

  // Example of a fully-typed call. `data` is checked against the contract, and
  // `reply`/`intent` below are known fields on the result — no `any` in sight.
  async function askConcierge(message: string): Promise<string> {
    const out = await apex.parseBookingIntent({ message, now: new Date().toISOString() });
    return out.reply ?? '';
    // e.g. `out.notAField` here would fail to compile, and
    // `apex.parseBookingIntent({ msg: message })` would too (wrong key).
  }

  // Expose for manual poking in the console during development.
  (globalThis as Record<string, unknown>).apex = apex;
  (globalThis as Record<string, unknown>).askConcierge = askConcierge;
}

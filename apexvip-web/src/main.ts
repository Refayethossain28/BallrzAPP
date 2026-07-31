/**
 * Entry for the apexvip-web build. Renders the lifted ApexAI concierge screen.
 *
 * It works fully offline via the on-device parser; if APEXVIP_FIREBASE_CONFIG is
 * present (the same global the HTML apps read), it wires the typed client so
 * replies route through the Cloud Function (Claude), with the parser as fallback.
 */

import { initializeApp, type FirebaseOptions } from 'firebase/app';
import { makeApexClient } from './apexClient.ts';
import { mountConciergeChat } from './concierge/ConciergeChat.ts';

declare global {
  // eslint-disable-next-line no-var
  var APEXVIP_FIREBASE_CONFIG: FirebaseOptions | undefined;
}

const root = document.getElementById('app');
if (root) {
  const cfg = globalThis.APEXVIP_FIREBASE_CONFIG;
  const backend = cfg && cfg.apiKey && cfg.apiKey !== 'YOUR_API_KEY'
    ? makeApexClient(initializeApp(cfg))
    : null;
  mountConciergeChat(root, { backend });
}

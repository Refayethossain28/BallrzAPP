/* Atlas — convoy cloud configuration (optional)
 * =============================================
 * Atlas runs fully offline with zero setup, and convoy mode already works
 * with no cloud at all: tabs on the same device find each other over
 * BroadcastChannel, and the demo convoy simulates companions.
 *
 * This file points Atlas at a Firebase project so convoys work ACROSS
 * DEVICES: members sign in anonymously and share live position beacons in
 * `atlas_convoys/{code}/members/{uid}` over Firestore. It reuses the project
 * that already ships in ../firebase.js (apexvip-1b4a9) — Atlas keeps to its
 * own `atlas_*` collections, and ../firestore.rules restricts every member
 * to writing only their own beacon. (Firebase web API keys are not secrets —
 * they identify the project; access is governed by the security rules.)
 *
 * One-time setup in the Firebase console for cross-device convoys:
 *   1) Authentication → Sign-in method → enable **Anonymous**
 *      (already needed by Ripple, so likely done).
 *   2) Deploy the rules:  firebase deploy --only firestore:rules
 *
 * To use a different project, replace the object below with its web config.
 * Set it to `null` to keep convoys same-device only.
 *
 * This is a *classic* script (not a module) so it also runs in the headless
 * smoke sandbox; it only declares a global and does nothing else.
 */
var ATLAS_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  storageBucket: "apexvip-1b4a9.firebasestorage.app",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
};
if (typeof window !== 'undefined') window.ATLAS_FIREBASE_CONFIG = ATLAS_FIREBASE_CONFIG;

/* Live traffic (optional key)
 * ---------------------------
 * Atlas ships with two keyless traffic layers: TfL's open disruption feed
 * (real live incidents across Greater London) and a deterministic "typical
 * traffic" rush-hour model for ETAs everywhere. For live incidents WORLDWIDE,
 * paste a TomTom Traffic API key here (free tier: developer.tomtom.com,
 * thousands of requests/day). Leave as null to stay keyless. */
var ATLAS_TOMTOM_KEY = null;
if (typeof window !== 'undefined') window.ATLAS_TOMTOM_KEY = ATLAS_TOMTOM_KEY;

/* ⭐ Atlas Pro payment link (optional)
 * -----------------------------------
 * Paste your Stripe Payment Link (or Gumroad/Ko-fi product URL) here and a
 * "Buy Atlas Pro — £14.99" button appears in the ⭐ Atlas Pro sheet. Buyers
 * pay there, the atlasProWebhook Cloud Function emails them an unlock code
 * automatically (setup guide: SELLING.md). Leave as null until your payment
 * link exists — the sheet then shows only the code box. */
var ATLAS_PAY_URL = null;
if (typeof window !== 'undefined') window.ATLAS_PAY_URL = ATLAS_PAY_URL;

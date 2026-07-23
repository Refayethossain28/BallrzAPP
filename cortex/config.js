/* Cortex — cloud backend configuration (optional)
 * ================================================
 * Cortex runs fully offline with zero setup: drills, ratings, streaks and the
 * Pro membership demo all live on-device. This file points it at a Firebase
 * project so it can add real accounts (email/password or guest), keep your
 * Pro membership in the cloud, and take real subscription payments through
 * Stripe Billing (see SETUP.md).
 *
 * It reuses the project that already ships in ../firebase.js (apexvip-1b4a9).
 * Cortex keeps its data in a separate `cortex_members` collection, and
 * ../firestore.rules scopes every document to its owner. (Firebase web API
 * keys are not secrets — they identify the project, not authorise access;
 * access is governed by the security rules.)
 *
 * To use a DIFFERENT project, replace the object below with that project's web
 * config. Set it to `null` to force pure offline demo mode.
 *
 * This is a *classic* script (not a module) so it also runs in the headless
 * smoke sandbox; it only declares globals and does nothing else.
 */
var CORTEX_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  storageBucket: "apexvip-1b4a9.firebasestorage.app",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
};
if (typeof window !== 'undefined') window.CORTEX_FIREBASE_CONFIG = CORTEX_FIREBASE_CONFIG;

/* Region the Cortex Cloud Functions are deployed to (functions/src/cortex.ts). */
var CORTEX_FUNCTIONS_REGION = 'us-central1';
if (typeof window !== 'undefined') window.CORTEX_FUNCTIONS_REGION = CORTEX_FUNCTIONS_REGION;

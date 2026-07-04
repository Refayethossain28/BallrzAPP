/* Velvet — cloud backend configuration (optional)
 * ================================================
 * Velvet runs fully offline with zero setup: membership, billing simulation
 * and the concierge desk all live on-device. This file points it at a Firebase
 * project so it can add real accounts (email/password or guest), sync your
 * membership and requests across devices over Firestore, and take real
 * subscription payments through Stripe Billing (see SETUP.md).
 *
 * It reuses the project that already ships in ../firebase.js (apexvip-1b4a9).
 * Velvet keeps its data in separate `velvet_*` collections, so it never touches
 * the ApexVIP data, and ../firestore.rules scopes every document to its owner.
 * (Firebase web API keys are not secrets — they identify the project, not
 * authorise access; access is governed by the security rules.)
 *
 * To finish enabling the cloud, three one-time steps in the Firebase console /
 * CLI for project apexvip-1b4a9 (full walkthrough in SETUP.md):
 *   1) Authentication → Sign-in method → enable **Email/Password** and
 *      **Anonymous**.
 *   2) Deploy the rules:      firebase deploy --only firestore:rules
 *   3) Deploy the functions:  cd functions && npm run deploy
 *      (+ set STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET for real billing —
 *       without them the functions run in a safe mock mode.)
 *
 * To use a DIFFERENT project, replace the object below with that project's web
 * config. Set it to `null` to force pure offline demo mode.
 *
 * This is a *classic* script (not a module) so it also runs in the headless
 * smoke sandbox; it only declares globals and does nothing else.
 */
var VELVET_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  storageBucket: "apexvip-1b4a9.firebasestorage.app",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
};
if (typeof window !== 'undefined') window.VELVET_FIREBASE_CONFIG = VELVET_FIREBASE_CONFIG;

/* Region the Velvet Cloud Functions are deployed to (functions/src/velvet.ts). */
var VELVET_FUNCTIONS_REGION = 'us-central1';
if (typeof window !== 'undefined') window.VELVET_FUNCTIONS_REGION = VELVET_FUNCTIONS_REGION;

/* App Check (reCAPTCHA v3) site key — protects the backend from abuse.
 * Firebase console → App Check → register the web app with reCAPTCHA v3,
 * paste the site key here and redeploy. Left blank, App Check stays off.
 * (This is a public site key — safe to commit.) */
var VELVET_APPCHECK_KEY = '';
if (typeof window !== 'undefined') window.VELVET_APPCHECK_KEY = VELVET_APPCHECK_KEY;

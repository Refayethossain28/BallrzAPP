/* Glimpse — cloud backend configuration (optional)
 * ================================================
 * Glimpse runs fully offline with zero setup: the demo world lives on-device
 * and the app is complete without a server. This file points it at a Firebase
 * project so it can also go LIVE — registered accounts (email + password,
 * unique handles) sharing real glimpses (place, caption, downscaled photo)
 * with every other user on Earth over Firestore.
 *
 * It reuses the project that already ships in ../firebase.js (apexvip-1b4a9).
 * Glimpse keeps its data in separate `glimpse_*` collections, so it never
 * touches ApexVIP/Ripple/Bloom data, and ../firestore.rules scopes every
 * write to its author. (Firebase web API keys are not secrets — they identify
 * the project, not authorise access; access is governed by the security rules.)
 *
 * One-time console setup for the project:
 *   1) Authentication → Sign-in method → enable **Email/Password**.
 *   2) Deploy the rules:  firebase deploy --only firestore:rules
 *
 * To use a DIFFERENT project, replace the object below with that project's web
 * config. Set it to `null` to keep Glimpse fully on-device.
 *
 * Classic script (not a module) so it also loads in the headless smoke
 * sandbox; it only declares a global and does nothing else.
 */
/* Push notifications (optional)
 * -----------------------------
 * To enable web push (notifications when Glimpse is closed), paste the
 * project's "Web Push certificate" public key here:
 *   Firebase console → Project settings → Cloud Messaging → Web configuration →
 *   "Web Push certificates" → Key pair (the long Base64 string).
 * The glimpsePushOnReaction Cloud Function (functions-side/) deploys
 * automatically with the repo's Firebase workflow. Leave as null to keep push
 * off. (This is a public VAPID key — safe to commit.) */
var GLIMPSE_FCM_VAPID_KEY = null;
if (typeof window !== 'undefined') window.GLIMPSE_FCM_VAPID_KEY = GLIMPSE_FCM_VAPID_KEY;

var GLIMPSE_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  storageBucket: "apexvip-1b4a9.firebasestorage.app",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
};
if (typeof window !== 'undefined') window.GLIMPSE_FIREBASE_CONFIG = GLIMPSE_FIREBASE_CONFIG;

/* Bloom — cloud backend configuration (optional)
 * ==============================================
 * Bloom runs fully offline with zero setup: the Meadow (demo) community lives
 * on-device and the app is complete without a server. This file points it at a
 * Firebase project so it can also go LIVE — registered accounts (email +
 * password, unique handles), real posts, reactions, comments and follows
 * synced across devices over Firestore.
 *
 * It reuses the project that already ships in ../firebase.js (apexvip-1b4a9).
 * Bloom keeps its data in separate `bloom_*` collections, so it never touches
 * ApexVIP/Ripple data, and ../firestore.rules scopes every write to its author.
 * (Firebase web API keys are not secrets — they identify the project, not
 * authorise access; access is governed by the security rules.)
 *
 * One-time console setup for the project:
 *   1) Authentication → Sign-in method → enable **Email/Password**.
 *   2) Deploy the rules:  firebase deploy --only firestore:rules
 *
 * To use a DIFFERENT project, replace the object below with that project's web
 * config. Set it to `null` to keep Bloom fully on-device.
 *
 * Classic script (not a module) so it also loads in the headless smoke
 * sandbox; it only declares a global and does nothing else.
 */
var BLOOM_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  storageBucket: "apexvip-1b4a9.firebasestorage.app",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
};
if (typeof window !== 'undefined') window.BLOOM_FIREBASE_CONFIG = BLOOM_FIREBASE_CONFIG;

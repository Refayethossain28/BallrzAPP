/* Ripple — cloud backend configuration (optional)
 * ===============================================
 * Ripple runs fully offline with zero setup. To message REAL people across REAL
 * devices, point it at a Firebase project: paste your web config below and the
 * app will sign users in anonymously, sync chats over Firestore in real time,
 * and let people join a chat from a shared invite link.
 *
 * 1) Firebase console → Project settings → "Your apps" → Web → copy the config.
 * 2) Paste it as the object below (replace `null`).
 * 3) Enable Anonymous sign-in: Authentication → Sign-in method → Anonymous.
 * 4) Deploy the Firestore rules in ../firestore.rules (they include a
 *    `ripple_*` section that restricts each chat to its members):
 *        firebase deploy --only firestore:rules
 *
 * You can reuse the existing project in ../firebase.js — just paste the same
 * config object here and deploy the updated rules. Leaving this as `null` keeps
 * Ripple in its self-contained offline demo mode.
 *
 * This is a *classic* script (not a module) so it also runs in the headless
 * smoke sandbox; it only declares a global and does nothing else.
 */
var RIPPLE_FIREBASE_CONFIG = null;
/* Example:
var RIPPLE_FIREBASE_CONFIG = {
  apiKey: "…",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "…",
  appId: "…"
};
*/
if (typeof window !== 'undefined') window.RIPPLE_FIREBASE_CONFIG = RIPPLE_FIREBASE_CONFIG;

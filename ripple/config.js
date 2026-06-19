/* Ripple — cloud backend configuration (optional)
 * ===============================================
 * Ripple runs fully offline with zero setup. This file points it at a Firebase
 * project so it can sign users in anonymously, sync chats over Firestore in real
 * time, and let people join a chat from a shared invite link.
 *
 * It currently reuses the project that already ships in ../firebase.js
 * (apexvip-1b4a9). Ripple keeps its data in separate `ripple_*` collections, so
 * it never touches the ApexVIP data, and ../firestore.rules restricts every chat
 * to its members. (Firebase web API keys are not secrets — they identify the
 * project, not authorise access; access is governed by the security rules.)
 *
 * To finish enabling real cross-device messaging, two things must be done once
 * in the Firebase console for project apexvip-1b4a9:
 *   1) Authentication → Sign-in method → enable **Anonymous**.
 *   2) Deploy the rules:  firebase deploy --only firestore:rules
 *
 * To use a DIFFERENT project instead, replace the object below with that
 * project's web config. Set it back to `null` to return to offline demo mode.
 *
 * This is a *classic* script (not a module) so it also runs in the headless
 * smoke sandbox; it only declares a global and does nothing else.
 */
var RIPPLE_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  storageBucket: "apexvip-1b4a9.firebasestorage.app",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
};
if (typeof window !== 'undefined') window.RIPPLE_FIREBASE_CONFIG = RIPPLE_FIREBASE_CONFIG;


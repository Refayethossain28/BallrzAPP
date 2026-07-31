/* Orbit — real-mode cloud configuration (optional)
 * ================================================
 * Orbit's marketplace is real out of the box on ONE device: open two tabs,
 * book a ride in one and go online as a Captain in the other — the request
 * travels over BroadcastChannel and a real human accepts and drives it. No
 * setup, no account, works on the static site.
 *
 * This file additionally points Orbit at a Firebase project so the SAME
 * marketplace works across DIFFERENT devices: riders and captains sign in
 * anonymously and ride requests sync over Firestore in real time. It reuses
 * the project that already ships in ../firebase.js (apexvip-1b4a9); Orbit
 * keeps its data in a separate `orbit_rides` collection and ../firestore.rules
 * enforces the marketplace rules server-side (only the rider creates/cancels,
 * a captain can only claim an OPEN request without touching the fare, only
 * the assigned captain advances the trip). Firebase web API keys are not
 * secrets — they identify the project; access is governed by the rules.
 *
 * One-time setup in the Firebase console (see SETUP.md):
 *   1) Authentication → Sign-in method → enable **Anonymous**.
 *   2) Deploy the rules:  firebase deploy --only firestore:rules
 *
 * Set this to `null` to disable cross-device sync (two-tab realness and the
 * simulated fleet keep working). This is a *classic* script (not a module) so
 * it also runs in the headless smoke sandbox; it only declares a global.
 */
var ORBIT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  storageBucket: "apexvip-1b4a9.firebasestorage.app",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
};
if (typeof window !== 'undefined') window.ORBIT_FIREBASE_CONFIG = ORBIT_FIREBASE_CONFIG;

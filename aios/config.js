/* AIOS — cloud sync configuration (optional)
 * ==========================================
 * AIOS runs fully offline with zero setup: your disk, desktop, apps and
 * automations all live in this browser. This file is what turns AIOS from
 * "a tab" into "your computer that follows you": point it at a Firebase
 * project and AIOS signs you in anonymously and mirrors your whole disk to
 * Firestore, so opening AIOS on another device restores the same files,
 * settings, apps and automations.
 *
 * Leave this null for offline mode (the default). To enable sync, drop in a
 * Firebase web config — see aios/SETUP.md for the 3-step setup. (Firebase web
 * API keys are not secrets: they identify the project, not authorise access;
 * access is governed by security rules — an owner-scoped rule for the
 * `aios_disks` collection is in ../firestore.rules.)
 *
 * This is a *classic* script (not a module) so it also runs in the headless
 * smoke sandbox; it only declares a global and does nothing else.
 */
var AIOS_FIREBASE_CONFIG = null;

/* Example — replace null above with your project's web config:
var AIOS_FIREBASE_CONFIG = {
  apiKey: "…",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "…",
  appId: "…"
};
*/

if (typeof window !== 'undefined') window.AIOS_FIREBASE_CONFIG = AIOS_FIREBASE_CONFIG;

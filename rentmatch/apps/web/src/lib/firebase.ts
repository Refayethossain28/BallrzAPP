import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';

// Defaults point at the shared `apexvip-1b4a9` Firebase project (same one the
// other apps in this repo use). These are public client identifiers, not
// secrets — safe to commit. Override per-environment via VITE_FIREBASE_* (e.g.
// the e2e injects a demo project + the emulators).
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'apexvip-1b4a9.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'apexvip-1b4a9',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'apexvip-1b4a9.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '254410067879',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '1:254410067879:web:754b71a35182c997f37082',
};

export const app = initializeApp(firebaseConfig);

// App Check (reCAPTCHA v3) — abuse protection. Enabled when a site key is set
// and we're not running against the local emulators.
const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY;
if (appCheckSiteKey && import.meta.env.VITE_USE_EMULATORS !== '1') {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Point at the local Firebase Emulator Suite when developing.
// Set VITE_USE_EMULATORS=1 in .env.local and run `npm run emulators`.
if (import.meta.env.VITE_USE_EMULATORS === '1') {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, 'localhost', 8080);
  connectStorageEmulator(storage, 'localhost', 9199);
  // Test-only hook: lets the emulator e2e fetch the signed-in user's ID token to
  // call callable functions directly (e.g. the Stripe-Elements-gated fee step).
  (window as unknown as { __getIdToken?: () => Promise<string | null> }).__getIdToken =
    () => (auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null));
}

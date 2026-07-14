import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { getAuth, type Auth } from 'firebase/auth'
import { getFirestore, type Firestore } from 'firebase/firestore'

// Shared ApexVIP Firebase project (same one the other apps in this repo use).
// These values are public client identifiers — security lives in
// firestore.rules, not in hiding this config.
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI',
  authDomain: 'apexvip-1b4a9.firebaseapp.com',
  projectId: 'apexvip-1b4a9',
  storageBucket: 'apexvip-1b4a9.firebasestorage.app',
  messagingSenderId: '254410067879',
  appId: '1:254410067879:web:754b71a35182c997f37082',
}

export function firebaseApp(): FirebaseApp {
  return getApps()[0] ?? initializeApp(FIREBASE_CONFIG)
}

export function firebaseAuth(): Auth {
  return getAuth(firebaseApp())
}

export function firestore(): Firestore {
  return getFirestore(firebaseApp())
}

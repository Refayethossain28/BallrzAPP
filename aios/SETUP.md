# AIOS — enabling cloud sync (optional)

AIOS runs **fully offline with zero setup**: your disk, desktop, installed
apps, variables, aliases and automations all live in your browser. This guide
is only for the optional upgrade that makes AIOS *follow you across devices* —
open it on your phone and your laptop and see the same files, settings and apps.

It follows the exact pattern the rest of this repo uses (see
[`ripple/SETUP.md`](../ripple/SETUP.md) and [`concierge/SETUP.md`](../concierge/SETUP.md)).

## What sync does

When a Firebase project is configured, AIOS:

1. signs you in **anonymously** (no account, no email);
2. mirrors your serialized disk to a single Firestore document at
   `aios_disks/{your-uid}`, debounced, whenever anything changes;
3. on load, pulls that document back so a second device restores your OS.

Your data is scoped to your anonymous user id and governed by security rules —
nobody else can read or write your disk.

## 3-step setup

1. **Create/choose a Firebase project** and add a **Web app** to it
   (Firebase console → Project settings → *Your apps* → Web). Copy the web
   config object.

2. **Paste it into [`config.js`](./config.js)** — replace `null`:

   ```js
   var AIOS_FIREBASE_CONFIG = {
     apiKey: "…",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     storageBucket: "your-project.firebasestorage.app",
     messagingSenderId: "…",
     appId: "…"
   };
   ```

   (Firebase web API keys are **not secrets** — they identify the project, not
   authorise access. Access is governed by the rules in step 3.)

3. In the Firebase console, **enable Anonymous auth**
   (Authentication → Sign-in method → *Anonymous* → Enable), and **deploy the
   security rules** below so each disk is private to its owner:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{db}/documents {
       match /aios_disks/{uid} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```

That's it. Reopen AIOS: **Settings → Cloud sync** should read *On*, and your
desktop will appear on any other device you open it on.

## Notes

- **Conflict handling is last-write-wins.** On open, the cloud copy is adopted;
  thereafter this device pushes its changes. For a single user across devices
  this is what you want; it is not built for two people editing one disk at once
  (shared folders between people would need per-path documents — a natural next
  step, mirroring Ripple's member-scoped chats).
- To go back to **offline-only**, set `AIOS_FIREBASE_CONFIG` back to `null`.
- Sync uses the Firebase **compat** SDK loaded on demand from gstatic — nothing
  is bundled, and none of it loads at all while `config.js` is `null`, so the
  offline build stays zero-dependency.

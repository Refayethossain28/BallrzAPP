# Glimpse — going live 🌍

Glimpse is complete without a server: the demo world lives on-device, and
everything you share stays local. To make it a REAL cross-device network —
registered accounts sharing live glimpses with everyone on Earth — point it at
a Firebase project. Three steps.

## 1. A Firebase project

[`config.js`](./config.js) already carries the web config for the repo's shared
project (`apexvip-1b4a9`), so out of the box there is nothing to do. To use your
own project instead, create one at <https://console.firebase.google.com>, add a
**Web app**, and paste its config object over `GLIMPSE_FIREBASE_CONFIG`.

> Firebase web API keys are not secrets — they identify the project, they don't
> authorise access. Access is governed entirely by the security rules.

## 2. Enable Email/Password sign-in

Firebase console → **Authentication → Sign-in method → Email/Password → Enable**.

Glimpse's live world is registered users only — no anonymous posting. Accounts
are email + password with one **unique handle** claimed forever (checked live at
signup against `glimpse_handles`).

## 3. Deploy the security rules

The repo's [`../firestore.rules`](../firestore.rules) already contains the
Glimpse section. Deploy it:

```sh
firebase deploy --only firestore:rules
```

What the rules enforce:

- **Registered accounts only** — anonymous users (e.g. Ripple's) can read but
  never write Glimpse data.
- **Author-scoped writes** — a moment's caption, place, photo, author and
  timestamp can only ever be touched by its author.
- **Reactions are the one shared surface** — any registered user may update a
  moment, but only its `reactions` map.
- **Bounded documents** — captions ≤ 400 chars, photos are downscaled data URLs
  capped at 500 KB, and a place must carry numeric coordinates.

## Data layout

| Collection        | Doc                                                              | Who writes           |
| ----------------- | ---------------------------------------------------------------- | -------------------- |
| `glimpse_users`   | `{name, handle, avatar, ts}` keyed by uid                        | the owner            |
| `glimpse_handles` | `{uid}` keyed by handle — the uniqueness lock                    | the claiming owner   |
| `glimpse_moments` | `{authorUid, name, handle, avatar, caption, place, scene, photo?, ts, reactions}` | author (reactions: anyone registered) |

Glimpse keeps all data in `glimpse_*` collections, so it never touches the
ApexVIP / Ripple / Bloom data that shares the project.

## Production hardening

- Turn on [App Check](https://firebase.google.com/docs/app-check) to keep
  non-app clients out.
- Add a Firestore TTL policy on `glimpse_moments.ts` if you want moments to
  expire (a feed of "right now" doesn't need forever).
- Photos ride inside the Firestore document as downscaled JPEG data URLs to
  keep setup zero-config; for heavy traffic move them to Cloud Storage and
  store the URL instead.

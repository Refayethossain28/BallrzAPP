# Bloom — from Meadow to live community

Bloom is complete without a server: the Meadow (demo community) lives on your
device. This file is only about the optional **🌐 Go live** mode, which turns
Bloom into a real cross-device social network.

## What "live" does

- **Registers a real account** — email + password, one **unique handle**
  claimed forever (no phone number). Sign in from any device and you're the
  same person, same handle.
- Publishes your 🌍 Everyone posts to the shared `bloom_posts` collection.
- Streams everyone else's live posts into your feed (tagged `live`), with
  reactions and comments synced in real time.
- Your device-only posts, your Garden, your sliders and your circles stay
  exactly where they were — on the device.

The live community is **registered accounts only** — enforced server-side: the
`bloom_*` rules reject writes from anonymous sessions outright, so there are
no drive-by ghosts, and every post traces to an account.

## One-time setup (same project as Ripple)

[`config.js`](./config.js) already carries the repo's shared Firebase project
(`apexvip-1b4a9`). To make registration work there:

1. **Firebase console → Authentication → Sign-in method → enable
   Email/Password.** (Bloom no longer uses anonymous sign-in; Ripple's
   Anonymous provider can stay on for Ripple.)
2. **Deploy the rules:**
   ```sh
   firebase deploy --only firestore:rules
   ```
   The `bloom_*` sections in [`../firestore.rules`](../firestore.rules)
   require a registered (non-anonymous) account for every write and scope it
   to its author; the only thing another user may change on your post is the
   `reactions` map and the `commentCount` counter. Handles are unique via
   `bloom_handles` — a handle doc can only ever point at the account that
   claimed it.

Password resets are built in ("Forgot password?" on the sign-in sheet — it
emails a reset link via Firebase).

## Use your own project instead

Create a Firebase project → add a web app → paste its config object over
`BLOOM_FIREBASE_CONFIG` in [`config.js`](./config.js), then do steps 1–2 in
that project. Set the config to `null` to keep Bloom fully on-device.

## Production hardening (before real strangers)

- Turn on **App Check** (reCAPTCHA v3) so only your deployed app can call the
  backend.
- Add moderation: a Cloud Function on `bloom_posts` writes (profanity /
  spam / image scanning) and a `reported` flag flow.
- Rate-limit posting per uid in rules (e.g. a `bloom_users.lastPostTs` check)
  if abuse appears.
- Turn on **email verification** (send `user.sendEmailVerification()` after
  signup and gate posting on `email_verified` in rules) if fake-email signups
  become a problem.

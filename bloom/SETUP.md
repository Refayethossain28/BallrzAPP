# Bloom — from Meadow to live community

Bloom is complete without a server: the Meadow (demo community) lives on your
device. This file is only about the optional **🌐 Go live** mode, which turns
Bloom into a real cross-device social network.

## What "live" does

- Signs you in **anonymously** (no phone number, no email).
- Publishes your 🌍 Everyone posts to the shared `bloom_posts` collection.
- Streams everyone else's live posts into your feed (tagged `live`), with
  reactions and comments synced in real time.
- Your device-only posts, your Garden, your sliders and your circles stay
  exactly where they were — on the device.

## One-time setup (same project as Ripple)

[`config.js`](./config.js) already carries the repo's shared Firebase project
(`apexvip-1b4a9`). To make Go live work there:

1. **Firebase console → Authentication → Sign-in method → enable Anonymous.**
   (Already done if Ripple's cloud mode is on.)
2. **Deploy the rules:**
   ```sh
   firebase deploy --only firestore:rules
   ```
   The `bloom_*` sections in [`../firestore.rules`](../firestore.rules) scope
   every write to its author; the only thing another user may change on your
   post is the `reactions` map and the `commentCount` counter.

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
- Consider upgrading anonymous accounts to real auth so people can keep their
  identity across devices.

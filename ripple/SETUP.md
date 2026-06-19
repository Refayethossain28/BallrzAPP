# Ripple — from demo to public messenger

Ripple ships in two layers so it's genuinely useful the moment you open it, and
genuinely deployable when you're ready for real users.

## 1. What works with zero setup (today)

Open [`ripple/index.html`](./index.html) — no build, no account:

- **Real messaging UX** — chat list, conversations, day dividers, delivery/read
  ticks, typing indicators, reactions, replies, **edit**, **unsend**, star, pin,
  mute, archive, search across every chat.
- **Differentiators over WhatsApp** — **schedule** a message for later,
  **disappearing messages** with a per-chat timer, inline **polls**, **slash
  commands** (`/poll`, `/remind`, `/expire`, `/me`, `/shrug`, `/shout`, `/clear`),
  rich text (`*bold*`, `_italic_`, `~strike~`, `` `code` ``), voice notes, photos.
- **Echo**, a built-in auto-responder, replies to you so the app feels alive
  without anyone else online.
- **Multi-tab live sync** — open Ripple in two browser tabs/windows; they stay in
  sync over `BroadcastChannel`. Your data is persisted on-device in `localStorage`.
- **App Lock** — optionally encrypt everything on the device with a passphrase
  (AES-GCM, PBKDF2-derived key, 150k iterations). The key is never stored.
- **Installable PWA** — Add to Home Screen for a full-screen, offline app.

The **product logic** (search ranking, disappearing/scheduled dispatch, reaction
toggling, poll tally, sidebar summaries, sync de-duplication) lives in
[`engine.js`](./engine.js) and is covered by `npm run test:ripple`.

## 2. Going multi-user (real people, real devices)

The transport is intentionally swappable. The demo uses a local transport
(localStorage + `BroadcastChannel`). To message real people you add a cloud
backend that does three things: **auth**, **store/stream messages**, and (for
notifications) **push**. This repo already contains a Firebase project you can
reuse — see [`firebase.js`](../firebase.js), [`firestore.rules`](../firestore.rules)
and [`firebase.json`](../firebase.json).

Suggested data model (Firestore):

```
users/{uid}                      → { name, avatar, handle, lastSeen }
chats/{chatId}                   → { type, name, members:[uid], updatedAt }
chats/{chatId}/messages/{msgId}  → the Message shape from engine.js
                                   (id, senderId, text, ts, type, reactions,
                                    replyTo, editedAt, deleted, expireAt,
                                    scheduledAt, readBy, meta)
```

Wiring steps:

1. **Auth** — enable Anonymous (and optionally Phone) sign-in. Map the Firebase
   `uid` onto `S.me.id`.
2. **Send** — instead of (or alongside) `msgsOf(active).push(m)`, write `m` to
   `chats/{chatId}/messages/{m.id}`. The message shape is already
   serialisable.
3. **Receive** — `onSnapshot` the messages sub-collection and reconcile with the
   local copy using `Ripple.mergeMessages(local, remote)` — it de-dupes by id,
   prefers the newest edit, lets a delete win, and keeps `ts` order. That's the
   exact function the unit tests pin.
4. **Scheduled / disappearing** — keep these client-evaluated with `Ripple.tick`,
   or move dispatch/expiry into a Cloud Function for cross-device correctness.
5. **Push** — reuse the existing [`firebase-messaging-sw.js`](../firebase-messaging-sw.js)
   and a Cloud Function that fans out on new messages.
6. **End-to-end encryption (optional, recommended)** — generate a per-device
   key pair, exchange public keys via the `users` doc, and encrypt `text`/`meta`
   client-side before writing. The server then only ever sees ciphertext. The
   `renderText`/search functions operate on already-decrypted text in memory.

Tighten [`firestore.rules`](../firestore.rules) so a user can only read/write
chats they're a member of before opening sign-ups.

## Tests

```sh
npm run test:ripple   # engine unit tests
npm run test:smoke    # boots the page in a headless sandbox
npm test              # everything
```

# Ripple — from demo to public messenger

Ripple ships in two layers so it's genuinely useful the moment you open it, and
genuinely deployable when you're ready for real users.

## ✨ Pulse — the one thing no other messenger does

Open any chat and look just under the name: a live **rhythm strip** reads the
*tempo* of that specific relationship straight from the message timestamps —
on-device, no servers, no ML — and distils it into a single living **beat**
(⚡ Rapid · warming up · ~30s beat · sync 82). It tracks cadence, momentum
(warming / cooling / resting), who's leading, and an in-sync score.

The beat powers a brand-new messaging primitive: **time measured in
conversational beats instead of clock seconds.** Set a chat to disappear "in 1
beat" and each message lives exactly *one of your volleys* — seconds in a
rapid-fire chat, a day in a slow burn — because the timer breathes with the two
people in the conversation rather than an arbitrary wall-clock. Tap the strip to
see the full read and pick a beat timer.

Pulse also reads two more things from the same timestamps:

- **Best time to reach** — a recency-weighted hour-of-day model of when the other
  person is usually active (`replyOutlook()`), surfaced on the strip
  (🟢 around now / 🕓 9 PM) and as a 24-hour histogram in the Pulse sheet.
- **Tempo-matching Echo** — the built-in demo bot (`echoReplyDelay()`) replies
  fast when you volley fast and lingers when you slow down, so the rhythm read
  feels alive the moment you start typing.

The algorithms live in [`engine.js`](./engine.js) (`conversationPulse`,
`replyOutlook`, `echoReplyDelay`), covered by unit tests in
[`../scripts/test-ripple-logic.mjs`](../scripts/test-ripple-logic.mjs).

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

## 2. Going multi-user — real people, real devices (built in)

The cloud transport is **already wired** — it just needs a backend. Out of the
box Ripple talks to **Firebase** (Anonymous Auth + Firestore). Turn it on:

1. **Add your config** — open [`config.js`](./config.js) and replace `null` with
   your Firebase web config. (You can reuse the project in
   [`../firebase.js`](../firebase.js) — paste the same object.)
2. **Enable Anonymous sign-in** — Firebase console → Authentication → Sign-in
   method → **Anonymous**.
3. **Deploy the rules** — [`../firestore.rules`](../firestore.rules) now contains
   a `ripple_*` section that restricts every chat to its members:
   ```sh
   firebase deploy --only firestore:rules
   ```

That's it. On next load Ripple signs the user in anonymously, and **New chat →
Sync to cloud** creates a real-time chat. Hit **🔗 Share invite link** (in the
chat's ⋮ info, or right after creating it) and send it to anyone — opening the
link (`…/ripple/?join=<chatId>`) joins them to the chat. Messages, edits,
unsends, reactions, poll votes and read receipts all sync live via Firestore
`onSnapshot`. Disappearing and scheduled messages stay client-evaluated.

### Data model (what the app reads/writes)

```
ripple_users/{uid}                      → { name, avatar, updatedAt }
ripple_chats/{chatId}                   → { type, name, avatar, members:[uid],
                                            disappearSec, lastText, updatedAt }
ripple_chats/{chatId}/messages/{msgId}  → the Message shape from engine.js
                                          (id, senderId, text, ts, type,
                                           reactions, replyTo, editedAt, deleted,
                                           expireAt, scheduledAt, readBy, meta)
```

`Ripple.mergeMessages(local, remote)` is available for any place you'd rather
reconcile than replace wholesale (it de-dupes by id, prefers the newest edit,
lets a delete win, keeps `ts` order — the unit tests pin this).

### Media & typing (already wired)

- **Media → Storage** — in a synced chat, photos and voice notes upload to
  **Firebase Storage** under `ripple/<chatId>/<msgId>` and only the download URL
  is stored on the message, so media never hits the 1 MB Firestore doc limit.
  Deploy the Storage rules alongside Firestore:
  ```sh
  firebase deploy --only firestore:rules,storage
  ```
  ([`../storage.rules`](../storage.rules) caps uploads at 12 MB and restricts to
  image/audio; tighten to per-chat membership via a Cloud Function before launch.)
- **Live typing** — typing state is written to
  `ripple_chats/<chatId>/typing/<uid>` (throttled, auto-expiring after ~6s) so
  members see "typing…" in real time. You write only your own doc (enforced in
  the rules).

### Production hardening (recommended before opening sign-ups)

- **Push** — reuse [`firebase-messaging-sw.js`](../firebase-messaging-sw.js) and a
  Cloud Function that fans out a notification on each new message.
- **Server-side expiry/scheduling** — move disappearing/scheduled dispatch into a
  Cloud Function for cross-device correctness when clients are offline.
- **End-to-end encryption** — generate a per-device key pair, publish public keys
  on `ripple_users/{uid}`, and encrypt `text`/`meta` before writing so the server
  only ever sees ciphertext; `renderText`/search operate on decrypted text in
  memory. (App Lock already encrypts the on-device cache.)
- **Invite scope** — the rules let anyone holding a link add *themselves* to a
  chat. For closed groups, gate joins behind a Cloud Function or short-lived
  invite tokens instead.

## Tests

```sh
npm run test:ripple   # engine unit tests
npm run test:smoke    # boots the page in a headless sandbox
npm test              # everything
```

# 🌸 Bloom — the social network that's on your side

Every big social platform optimises the same number: *time you spend inside it*.
Bloom optimises the opposite one: **what you got out of it** — and it proves it,
because every rule that decides what you see is a pure, unit-tested function on
your own device ([`engine.js`](./engine.js), `npm run test:bloom` — 34 tests),
rendered by one installable, offline-first HTML file.

## The research — what each giant does best, what it won't do, and Bloom's answer

| Platform | Signature move | What it won't do | Bloom's version |
|---|---|---|---|
| **TikTok / Instagram** | A ranked feed that knows you scarily well | Show you *why*, or hand you the dials | **You own the algorithm**: four sliders — 🌅 Fresh, 🫶 Close, ✨ Spark, 🍃 Calm — literally *are* the ranking. Every post has a **“why?” receipt** whose points sum to its score, live from your sliders |
| **X / Twitter** | The public square, trending now | Explain a trend, or turn the outrage down | **Trending with receipts** (posts · voices · recency · score, all shown) and a **Calm slider** that transparently sinks heated posts — the receipt says “turned down: reads heated” |
| **Facebook** | Like counts as social glue | Let you opt out of scorekeeping | **Quiet by default**: reaction counts stay hidden until *you've* reacted; your follower count is visible to you alone |
| **BeReal** | One honest daily moment | Resist becoming a streak-anxiety machine | **✨ Spark** — one deterministic daily prompt for everyone, *no streaks, no guilt* |
| **Instagram Close Friends** | Audience control | Make it a first-class posting primitive | **Circles** on every post: 🌍 Everyone / 👥 Followers / 🫂 Inner circle — enforced by the engine (private posts can't even trend) |
| **All of them** | Infinite scroll | End | **“🌼 You're all caught up”** is a real line in the feed, and a **session timekeeper** tells you how long you've been here — then suggests leaving |

And the things none of them will ship, which Bloom treats as the product:

- **A feed with a conscience, not a curfew.** The heat-check
  (`heatCheck()` — pure, on-device) notices name-calling, sweeping accusations
  and all-caps pile-ons *in your own drafts* and asks — never blocks — "would
  future-you send this?". Enthusiasm (`GOAL!!`) passes clean; it's unit-tested.
- **Growth measured in giving.** Your profile is a **Garden** (🌰 Seed → 🌳
  Grove) grown by a score that counts comments ×4, posts ×2, reactions ×1 —
  and scrolling ×0. There is no other score in the app.
- **Serendipity you can trust.** The ✨ Spark slider invites great posts from
  outside your circle — deterministically seeded per post per day, so the feed
  never reshuffles under your thumb.
- **Closeness, not follower clout.** People rise because you *actually talk
  with them* (a saturating curve over real interactions — comments weigh
  double), shown honestly as "closeness 74%" — visible only to you.
- **Notifications that don't nag.** Activity is grouped ("Maya and 2 others
  reacted 💛") — 40 reactions is one line, not 40 pings.
- **Leave whenever you want, with everything.** One tap exports every byte
  Bloom knows about you as JSON.

## Alive out of the box, real when you're ready

Open it and the **Meadow** — eight warm, distinct personas — is already
posting, commenting back, following you back. No account, no server, nothing
leaves the device.

**Create an account** in Settings and Bloom joins a real shared community over
Firebase: **registered users only** — email + password, one unique handle
claimed forever, sign in from any device as the same person, built-in password
reset. The rules enforce it server-side: anonymous sessions can't write a
thing, every post traces to an account, and reactions are the only field
strangers may touch on your post
([`../firestore.rules`](../firestore.rules), `bloom_*` collections). Setup is
one console click + a rules deploy: [`SETUP.md`](./SETUP.md).

## Run it

Serve the repo (or open the GitHub Pages deployment) and visit `bloom/`.
Installable PWA, offline-first. Tests: `npm run test:bloom`.

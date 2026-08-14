# 🔭 Glimpse — share what you're seeing with the world

One job: point your camera (or a few words) at whatever is in front of your
eyes, stamp it with where you are, and let the whole planet look through your
window — while you look through everyone else's.

**[Open Glimpse →](https://refayethossain28.github.io/BallrzAPP/glimpse/)**

## What makes it Glimpse

- **🌍 A world feed that hops the globe.** Most feeds show you more of what you
  just saw; Glimpse's world scroll is built so each flick of the thumb *lands
  somewhere else* — recency × diversity, where a fresh window from a country
  this scroll hasn't visited jumps the queue. Every card has a **"why?"
  receipt**, and the feed draws the journey: *"✈️ 9,560 km NE to Reykjavík 🇮🇸"*.
- **🌅 Real solar skies.** Not timezone tables — actual astronomy: solar
  declination from the day of the year, hour angle from longitude, true sun
  elevation from both. Every glimpse knows whether it's dawn, day, evening or
  night outside that window *right now* — including polar night in a
  Reykjavík December and midnight sun in a Svalbard June — and scene cards
  are painted with the sky they were shot under.
- **🗺️ The Earth, live.** A dot-matrix planet drawn from a hand-tuned 5° land
  mask (unit tests assert every shipped city lands on land and the open oceans
  stay water), each dot lit by the sun's true elevation there this second — so
  the day/night terminator curves with the seasons — with the subsolar point
  glowing and every post pinned where it was seen.
- **🧭 Near you.** The same windows sorted by real distance and compass
  direction — *"344 km SE of you"*.
- **🛂 A passport, not a score.** The only number in Glimpse counts *countries
  you've genuinely looked at* — through the feed, by reacting, or by posting.
  Horizon stages: 🪟 Windowsill → 🌄 First Light → 🚶 Wanderer → 🧭 Pathfinder →
  🌍 Globetrotter → 🛰️ Worldeye.
- **👁 One honest prompt a day** for the whole planet at once ("Show us your
  sky, exactly as it is right now").
- **🔍 Find people** — search by name or @handle (exact handle beats prefix
  beats substring, deterministic order), open their profile and their recent
  posts, or filter the world feed to just their glimpses. Signed in, search
  covers everyone on Glimpse, with an exact-handle lookup that resolves
  `@someone` even beyond the fetched directory page.
- **📷 Camera-first capture** — photos are downscaled on-device (tap any photo
  for full-screen); no photo? Set the scene with an emoji and the app paints
  the sky it was shot under. Posting is **offline-resilient**: signed in with
  no signal, your glimpse queues and reaches the live world the moment the
  network returns.
- **🔔 Quiet notifications** — an Activity sheet groups events into humane
  lines ("Maya and 2 others reacted to your post", "Oliver posted from London —
  close to your window"), with an unread dot in the header and optional device
  alerts when the app is in the background. Reactions arriving on your posts
  sync live onto them; no polling, everything rides the existing listeners.
  With the one-time Web Push key ([SETUP.md](./SETUP.md)), **real push** works
  too: a Cloud Function notifies you the moment someone reacts — even with the
  app fully closed.

## Real people only

There are no demo accounts and no synthetic activity: every post in the live
feed was made by a registered person. Without an account the app still works —
your own posts, map and passport stay on-device, offline-first, as an
installable **PWA**.

## Go live

Create an account (email + password, unique handle) and Glimpse becomes a real
cross-device network over Firestore — registered users only, author-scoped
security rules, reactions as the single shared surface. Setup in
[SETUP.md](./SETUP.md).

## The engine

All product logic — geo distance/bearing, real solar astronomy (declination,
elevation, the subsolar point, the dot-matrix Earth), the globe-hopping feed
ranker with receipts, the near feed, the passport, people search, activity
grouping and daily prompts — is a pure, deterministic, clock-injected engine:
[`engine.js`](./engine.js), tested by `npm run test:glimpse` (49 tests).
`index.html` just renders it.

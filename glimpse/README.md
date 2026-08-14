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
- **🌅 Solar skies.** Longitude is a clock — every glimpse knows whether it's
  dawn, day, evening or night outside that window *right now*, and scene cards
  are painted with the sky they were shot under.
- **🗺️ The world, right now.** A live map view: every window on one wall, night
  side dimmed, with a sun strip showing where on Earth it's 🌅 ☀️ 🌆 🌙 at this
  exact moment.
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
  windows, or filter the world feed to just their glimpses. Signed in, search
  covers everyone live on Glimpse, with an exact-handle lookup that resolves
  `@someone` even beyond the fetched directory page.
- **📷 Camera-first capture** — photos are downscaled on-device; no photo? Set
  the scene with an emoji and the app paints the sky it was shot under.

## Alive out of the box

No account, no server: onboarding seeds a deterministic **demo world** — eleven
personas posting from Tokyo to Reykjavík — so the feed, map and passport work
the moment the page opens. Offline-first, installable **PWA**.

## Go live

Create an account (email + password, unique handle) and Glimpse becomes a real
cross-device network over Firestore — registered users only, author-scoped
security rules, reactions as the single shared surface. Setup in
[SETUP.md](./SETUP.md).

## The engine

All product logic — geo distance/bearing, solar time, the globe-hopping feed
ranker with receipts, the near feed, world-map cells, the passport, people
search, prompts and the seeded demo world — is a pure, deterministic,
clock-injected engine: [`engine.js`](./engine.js), tested by
`npm run test:glimpse` (39 tests). `index.html` just renders it.

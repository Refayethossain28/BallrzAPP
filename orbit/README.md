# 🪐 Orbit — the everything app

**Rides · Eats · Groceries · Parcels · Pay — and the driver's seat too** — one app, built by studying what makes each of
the world's super-apps great and combining their signature moves, then adding a
few of its own. Zero-build, single-file, offline-first, installable PWA. Every
rule that touches money or state lives in a pure, deterministic, clock-injected
engine ([`engine.js`](./engine.js)) with 60 unit tests
(`npm run test:orbit`).

## The research — who Orbit steals from, and what it does better

| App | Signature move | Orbit's version |
|---|---|---|
| **Careem** | The EAT / GET / GO / PAY super-app: rides, food, groceries and a wallet in one place, with Careem Plus perks | The whole app: Go / Eat / Send / Pay tabs over one wallet, one points balance and one **Orbit+** membership whose savings are *computed and shown against its price* |
| **Uber** | Upfront pricing, Reserve (book up to 90 days out), the safety toolkit (share trip, PIN verify), fare-holding ride passes | Upfront quotes with a **fully itemised fare breakdown**, scheduled rides that **lock the booked price**, a per-trip **driver-verify PIN + live share code**, and a 7-day **price lock** on any route |
| **inDrive** | Name-your-price bidding — passengers offer, drivers accept / counter / pass | **Fair Fare**: offer any amount; each simulated driver accepts, counters or passes deterministically — with an *honest floor* (below ~72% of the fare nobody moves, and the app says why) |
| **Bolt** | Lean, price-first ride classes | Seven classes from Moto to Lux including **Green** (EVs, 0 g CO₂ shown on every quote) |
| **Grab** | GrabExpress couriers, GrabRewards, GrabUnlimited | **Send** (insured parcels, three sizes, live tracking), **points per £ by service**, tier ladder Bronze → Platinum with real perks |
| **Gojek** | Many services, one wallet | One ledger-backed wallet: top-ups, free instant P2P, **fair-pennies bill splitting**, and cashback on every ride |

And the parts most of them *won't* do, which Orbit treats as features:

- **Surge with a reason, always.** Surge never appears as a bare multiplier —
  it says *why* ("Evening rush ×1.5") and the exact surge amount is a line item
  in the fare breakdown. Quiet 3 am rides get an honest *discount* (×0.9).
- **Cancel fees you can predict.** The cancel button always shows the fee
  *before* you tap: free before a match or within a 2-minute grace window,
  small fixed fees after, full fare only once you're in the car. The whole
  policy is unit-tested.
- **A wallet that can't lie.** The balance is never stored — it's derived from
  the transaction ledger, so the money history and the balance can't disagree.
- **Bidding with a floor.** Fair Fare won't pretend a £5 offer on a £20 ride
  might work: below the floor every driver passes, because their time has a
  price too.

## What's inside

- **🚕 Go** — a canvas map of Meridian (the app's simulated city), 7 ride
  classes quoted upfront with itemised maths, honest surge, Fair Fare bidding,
  driver matching (seeded pool, best ETA wins), the full trip state machine
  (requested → matched → arriving → arrived → in trip → completed) with a car
  animating along the route, safety PIN + share code, predictable cancel fees,
  scheduled rides (30 min – 7 days, price locked) and 7-day price locks.
  **Multi-stop rides** (up to two extra stops — legs itemised, ONE booking fee
  for the whole journey plus an honest 60p per stop, so it always beats booking
  the legs separately), a **🎟️ Route Pass** (10 rides on any route at 15% off,
  valid both directions for 30 days, savings stated up front), **tips with no
  platform cut** (£1/£2/£3 on the receipt — every penny reaches the captain),
  and a **trusted contact** whose name rides along on every trip's live-share.
  **🚲 Orbit Wheels** — docked bikes & e-scooters at seven stations (live,
  seeded dock availability per station & hour drawn on the map), unlock +
  per-minute pricing with a floor, zero-emission rides. **🕐 The smart
  departure planner** — the same honest surge curve that prices your ride,
  scanned over the next 12 hours: see every window's price and reason, one tap
  books the cheapest (most apps *hide* when it's cheap; Orbit tells you).
  **⭐ Favourite captains** — five-star a driver and add them to favourites;
  they get first refusal on your future rides. **💼 Business rides** — flag a
  ride at booking and it lands on a monthly expense report you can copy out.
- **🍔 Eat** — ten kitchens with menus, itemised checkout (delivery by real
  road distance, small-order fee, capped service fee, `WELCOME20`), live order
  tracking, and DineOut discounts (10%, or 20% with Orbit+). Plus **🛒 Market**
  — Careem-Quik-style groceries from the Old Town dark store across six aisles,
  with an honest **15-minute promise**: inside the promise zone it's guaranteed
  (late = £2 credit, automatically); outside it, the app just tells you the
  real ETA instead of pretending.
- **📦 Send** — insured door-to-door parcels in three sizes with live tracking.
- **💳 Pay** — the ledger wallet: top-ups, free P2P, fair bill splitting,
  2% ride cashback (10% with Orbit+), full activity history. Plus **🗓️
  PayLater** — when the wallet is short, purchases go on this month's tab
  instead (Grab-PayLater-style), with a hard honest £100 limit, no interest,
  no fees, and one-tap settling from the wallet; and **🎁 referrals** — a
  deterministic personal code, give £5 / get £5, once.
- **⭐ Me** — Orbit+ (30-day trial, savings meter vs the £9.99 price),
  rewards points & tiers with redemption (500 pts → £2.50), ride history,
  your zero-emission km, and the safety centre.
- **🧢 Captain mode** — the driver's side of the marketplace, one tap away:
  go online and receive seeded ride offers showing the **full fare, your exact
  80% cut and the pickup distance before you accept** (most apps hide some of
  this); accept or pass with no penalty games, drive the trip, and the payout
  lands in the same in-app wallet instantly, with a live day summary (trips,
  gross, net, acceptance rate). The 80/20 split is unit-tested and mirrors the
  repo's ApexVIP dispatch economics.

## 👤 REAL mode — two humans, one ride

The marketplace is **real**, not just simulated. Tap **"Ask REAL captains"**
when booking and your request goes out to actual humans running this app in
Captain mode:

- **Zero setup, one device**: open a second tab, go online as a Captain, and
  accept — the request travels over `BroadcastChannel`. A real person claims
  it, drives every status (on my way → arrived → start → complete), and earns
  the real 80% into their wallet. The rider watches it live.
- **Cross-device**: [`config.js`](./config.js) + 3 minutes of Firebase setup
  ([`SETUP.md`](./SETUP.md)) and the same marketplace syncs over Firestore —
  a rider on one phone, a captain on another. The marketplace rules are
  enforced **server-side** in [`../firestore.rules`](../firestore.rules): the
  fare and route are frozen at creation, a captain can only claim an OPEN
  request as themselves, only the assigned captain advances the trip, only
  the rider cancels.
- **Honest protocol**: every legal transition is a pure engine function
  (`marketClaim` / `marketAdvance` / `marketCancel` / `marketResolveClaim`) —
  double-claims bounce, impostor captains are rejected, fare tampering is
  ignored, claim races resolve first-wins on the rider's side — all
  unit-tested. No takers in 20 s? The app says so and the simulated fleet
  takes over, clearly labelled 🤖.

## Honesty note

The simulated fleet (drivers, couriers, kitchens) remains a deterministic
simulation shaped like the real market — and rides between real humans are
clearly labelled 👤 REAL. The money is in-app demo credit, not a payment rail
(Concierge in this repo shows the Stripe pattern to wire real billing), and
there's no vetting or insurance behind captains — see the honest limits in
[`SETUP.md`](./SETUP.md). All local state stays on your device in
`localStorage`; cloud mode stores ride requests (no PII beyond a chosen
display name) in Firestore.

## Run it

```sh
open orbit/index.html    # or serve the repo and browse to /orbit/
npm run test:orbit       # 60 engine tests
```

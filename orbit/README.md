# 🪐 Orbit — the everything app

**Rides · Eats · Groceries · Parcels · Pay — and the driver's seat too** — one app, built by studying what makes each of
the world's super-apps great and combining their signature moves, then adding a
few of its own. Zero-build, single-file, offline-first, installable PWA. Every
rule that touches money or state lives in a pure, deterministic, clock-injected
engine ([`engine.js`](./engine.js)) with 49 unit tests
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

## Honesty note

There is no server and no fleet: drivers, couriers and kitchens are a
deterministic simulation shaped like the real market (per-km/per-min tariffs,
rush-hour surge and traffic, bid floors, seeded driver pools). Same question,
same answer — which is what makes every rule testable. All state stays on your
device in `localStorage`.

## Run it

```sh
open orbit/index.html    # or serve the repo and browse to /orbit/
npm run test:orbit       # 49 engine tests
```

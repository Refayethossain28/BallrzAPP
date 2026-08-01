# 🌍 Orbit Real — real rides between real people

The **real version** of Orbit, living beside [the demo](../) — **the same
five-tab super-app** (Go · Eat · Send · Pay · Me, with Captain mode one tap
away), but every counterpart is a real human. No fictional city, no simulated
fleet, no play money:

- **Real map & places** — OpenStreetMap tiles on a from-scratch canvas slippy
  map, your actual GPS position, any real address via Nominatim search, or a
  dropped pin.
- **Real road maths** — distance and duration from OSRM's real routing
  (honest fallback to haversine + winding factor when the router is
  unreachable, and the quote *says* which one it used).
- **Real fares** — the same itemised, surge-honest tariff card as the demo,
  applied to real km and minutes. Paid **in cash to the captain** — Orbit
  holds none of it, exactly how ride-hailing started in cash markets.
- **Real parcels & errands too** — 📦 Send asks a real courier (cash on
  delivery, priced from real road km); 🍔 Eat refuses to fake a restaurant
  list and instead offers **errands**: a real human buys what you describe
  from any shop you name and brings it (cash fee + the receipt). 💳 Pay is
  the honest cash ledger — earned as a captain minus paid as a rider — with
  a straight answer about why there's no stored-value wallet without a
  payment rail.
- **Real humans only** — a request goes to actual people running this app in
  Captain mode: instantly between two tabs (BroadcastChannel), across devices
  once the 3-minute Firebase setup in [`../SETUP.md`](../SETUP.md) is done
  (the `orbit_real_rides` rules in [`../../firestore.rules`](../../firestore.rules)
  freeze the fare and geo points server-side, allow exactly one claim, and let
  only the assigned captain advance the trip). If nobody answers in 5
  minutes, the app says so — **there is no fake fallback here**.
- **Safety** — a per-ride verify-PIN both sides can check, and the same
  tested marketplace protocol as the demo (double-claims bounce, impostors
  rejected, fare tampering ignored).

## Honest limits

This connects consenting people who already trust each other — friends,
family, a campus, an office. There is no vetting, insurance, or payment
protection, and charging strangers for rides is regulated in most places:
check your local law. It is a real marketplace, not a licensed taxi company.

## Run it

```sh
open orbit/real/index.html   # works offline for the shell; map/search/routing need internet
npm run test:orbit           # 67 engine tests (shared engine with the demo)
```

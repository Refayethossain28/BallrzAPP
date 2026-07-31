# TravelDeals ✈️🏨

Search, compare and **book** flights & hotels — one app that steals the best
feature from every big travel product and runs it all on your device:

| Feature | Borrowed from | How it works here |
|---|---|---|
| **Buy / Wait forecast** | Hopper | Advance-purchase curve + 60-day trend → a call with a % and a reason |
| **🧊 Fare freeze** | Hopper | Hold any fare 48 h for a 5 % fee (min $5) |
| **Everywhere search** | Skyscanner | Scans every airport in the database, ranks the 12 best-value round trips |
| **Typical price & deal scores** | Google Flights | Every fare scored 1–99 against the route's 60-day median |
| **Flexible dates strip** | Google Flights | ±3 days priced inline; the cheapest day is highlighted |
| **Trips wallet** | Kayak | E-tickets, boarding passes with barcodes, cancellations, holds |
| **Free-cancellation rates** | Booking.com | Three rate plans per stay; Flexible refunds 100 % |
| **Price match** | Booking.com | Found it cheaper after booking? The difference becomes wallet credit |
| **Stay-count loyalty** | Booking.com Genius | 5 stays → 10 %, 15 → 15 %, 30 → 20 %, applied automatically |
| **Points & tiers** | Every airline | 5 pts / $1 · Silver 5k · Gold 15k · Platinum 40k |

Plus: full **native booking flow** (fare brands → travellers → interactive
seat map → bags & insurance → Luhn-validated demo checkout → PNR + barcode
boarding pass), price watches with on-open alerts, three currencies, dark
mode, and an **installable offline PWA**.

## Run it

Zero-build — open [`index.html`](./index.html), or from the repo root:

```sh
node deals-app/server.mjs          # http://localhost:8799
```

## Live mode (real fares)

```sh
AMADEUS_CLIENT_ID=... AMADEUS_CLIENT_SECRET=... node deals-app/server.mjs
```

Free keys at [developers.amadeus.com](https://developers.amadeus.com/register).
The header flips to **LIVE** and flight searches return real airline offers
from the Amadeus *test* environment.

## What's real and what isn't

- **Real:** the airport database and great-circle distances, the shape of the
  advance-purchase and seasonality curves, the Luhn check, every booking /
  refund / loyalty rule — all deterministic and unit-tested
  (`npm run test:deals`, 31 tests).
- **Simulated:** without API keys, fares come from the seeded price model —
  same search, same answer, honest by construction.
- **Never:** real ticket issuance. Amadeus test mode quotes real fare shapes
  but issues nothing; genuinely selling flights requires an airline
  consolidator or IATA accreditation, which no API key alone provides.

The engine is [`engine.js`](./engine.js) — pure, clock-injected, seeded.
Tests live in [`../scripts/test-deals-logic.mjs`](../scripts/test-deals-logic.mjs).

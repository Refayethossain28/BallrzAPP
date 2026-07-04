# ApexVIP Cloud Functions

Functions in this codebase:
- **`getHotelRates`** — live hotel pricing from **Amadeus** (server-side; see
  [`docs/apexvip-live-hotel-rates.md`](../docs/apexvip-live-hotel-rates.md)).
- **`processSquarePayment`** — authorize (pre-auth) a card payment via **Square**.
- **`captureSquarePayment`** — capture the authorized payment on trip completion.
- **`refundSquarePayment`** — full/partial refund per the cancellation policy.
- **`onBookingWrite`** — Firestore trigger that emails (SendGrid) and texts
  (Twilio) the client as a booking moves through its lifecycle, records the
  driver's earning to the payout ledger, and credits their 2% AXC.
- **ApexCoin ledger** — the server-authoritative loyalty wallet.
  `awardBookingCoins` credits clients 5% of the cash portion of every booking;
  `redeemApexCoins` is the transactional "pay with ApexCoin" at checkout;
  `redeemDriverCoins` cashes a driver's AXC out onto the `driver_payouts` rail.
  Balances (`users/{uid}.apexBalance`, `drivers/{uid}.apexcoin`) and the
  append-only `coin_ledger` are functions-write-only (firestore.rules blocks
  self-writes); deterministic ledger ids make the booking-triggered awards
  idempotent.

All hold their provider secret server-side so the browser never sees it. See
[`docs/apexvip-payments.md`](../docs/apexvip-payments.md) for the payment flow.

## TypeScript

This codebase is **TypeScript** (mirrors `rentmatch/functions`). Source lives in
[`src/`](./src); the Firestore document shapes the apps and backend must agree on
are in [`src/types.ts`](./src/types.ts) — the single place to read/correct the
field names called out in
[`docs/apexvip-backend-consolidation.md`](../docs/apexvip-backend-consolidation.md).

```sh
cd functions
npm install
npm run typecheck   # tsc --noEmit — catches Firestore field/typo bugs before deploy
npm test            # node --test — pure backend logic (src/logic.ts, 16 tests)
npm run build       # esbuild src/index.ts → lib/index.js (the deployed artifact)
```

The deterministic logic (fare bounds, the 80% split, booking-lifecycle messaging,
compliance expiry) lives in [`src/logic.ts`](./src/logic.ts) so it's unit-tested
without Firebase; `src/index.ts` imports it.

### Emulator integration test — booking → driver dispatch

`npm run test:emulator` runs the whole booking→driver loop against the Firebase
emulator: it writes a booking, lets the real `onBookingCreated` trigger fire, and
asserts an `open_jobs/{bookingId}` doc appears (status `open`, correct market,
80% pay) — the exact document the driver app subscribes to — then checks dispatch
is idempotent and **replays the driver app's claim transaction with two drivers
racing**, asserting exactly one wins, the booking flips to `accepted` with that
driver, and a driver-side `jobs` doc is created. Requires the emulator tooling
(not a project dep, so it's opt-in, not run by the session hook):

```sh
npm i -g firebase-tools     # needs Java for the Firestore emulator
npm run test:emulator        # builds, boots firestore+functions, runs test/dispatch.emulator.mjs
npm run test:emulator:coin   # the ApexCoin lifecycle: earn → clamped/idempotent redeem → driver cash-out
```

`npm run test:emulator:coin` walks the whole coin loop against the real
functions: a booking awards the client 5% exactly once (re-fired triggers
can't double-award), `redeemApexCoins` clamps to the balance and is
idempotent per booking, the next booking earns on the cash portion only, trip
completion credits the driver 2% AXC once, and `redeemDriverCoins` zeroes the
wallet with the £ landing in `driver_payouts` as `owed`.

## Apple Pay

`validateApplePayMerchant` performs the real server-side merchant handshake
(mutual-TLS POST to Apple's validation URL). To enable it:

```sh
firebase functions:secrets:set APPLE_PAY_MERCHANT_CERT   # PEM merchant identity cert
firebase functions:secrets:set APPLE_PAY_MERCHANT_KEY    # PEM private key
# Non-secret (functions/.env):
#   APPLE_PAY_MERCHANT_ID=merchant.com.apexvip
#   APPLE_PAY_DOMAIN=your-served-domain   APPLE_PAY_DISPLAY_NAME=ApexVIP
```

Until the cert + merchant id are set it fails closed with a clear message and the
client falls back to the card form (an SSRF guard ensures the cert is only ever
sent to an `apple.com` host).

`lib/` is the build output (git-ignored). `firebase deploy` runs `npm run build`
first via the `predeploy` hook in `firebase.json`, so the compiled `lib/index.js`
is always fresh. `main` points at `lib/index.js`.

## ⚠️ Deploy ONLY these functions

This repo is a **separate functions codebase** (`apexvip-hotels`) from the project's
other functions (`parseBookingIntent`, `checkFlightStatus`, …), which live elsewhere.
**Always scope the deploy** so you don't touch the others:

```sh
firebase deploy --only functions:getHotelRates,functions:processSquarePayment,functions:captureSquarePayment,functions:refundSquarePayment,functions:onBookingWrite,functions:onBookingCreated,functions:awardBookingCoins,functions:redeemApexCoins,functions:redeemDriverCoins
```

A bare `firebase deploy` from here could try to delete functions it doesn't see.

## Square setup
```sh
firebase functions:secrets:set SQUARE_ACCESS_TOKEN
# Non-secret config (functions/.env): SQUARE_ENV=production|sandbox, SQUARE_LOCATION_ID=...
```
Default is the Square **sandbox**; set `SQUARE_ENV=production` for live charges.

## Notifications setup (onBookingWrite)
```sh
firebase functions:secrets:set SENDGRID_API_KEY
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
# Non-secret config (functions/.env): NOTIFY_FROM_EMAIL, NOTIFY_FROM_NAME, TWILIO_FROM_NUMBER
```
Each channel is optional — if a provider's secret/number is unset, that channel is
skipped. Emails need a SendGrid verified sender; SMS needs a Twilio number.

## Setup

1. **Install** deps:
   ```sh
   cd functions && npm install
   ```
2. **Get Amadeus keys** — https://developers.amadeus.com → create a Self-Service app →
   copy the API Key / Secret. Test env is free; production is paid/contracted.
3. **Store the secrets** (project root):
   ```sh
   firebase functions:secrets:set AMADEUS_CLIENT_ID
   firebase functions:secrets:set AMADEUS_CLIENT_SECRET
   ```
4. **(Optional) production host** — copy `.env.example` → `.env` and set
   `AMADEUS_HOST=https://api.amadeus.com`. Default is the free test host.
5. **Deploy**:
   ```sh
   firebase deploy --only functions:getHotelRates
   ```

The `.firebaserc` already points at project `apexvip-1b4a9` (matches `firebase.js`).

## Test locally

```sh
firebase emulators:start --only functions
```
Then call it (the client does this automatically once deployed):
```sh
curl -X POST http://127.0.0.1:5001/apexvip-1b4a9/us-central1/getHotelRates \
  -H "Content-Type: application/json" \
  -d '{"data":{"name":"The Ritz London","lat":51.5067,"lng":-0.1438,"checkIn":"2026-07-03","nights":2,"guests":2,"currency":"GBP"}}'
```
Secrets in the emulator: put `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET` in a local
`functions/.env` (gitignored) or pass via `--set-env-vars` when testing.

## Contract

Request `data`: `{ name, lat, lng, checkIn (YYYY-MM-DD), nights, guests, currency }`.

Response (live):
```json
{ "nightly": 995, "from": 965, "total": 1995, "nights": 2, "guests": 2,
  "currency": "GBP", "checkIn": "2026-07-03", "available": true }
```
On no availability it returns `{ "available": false, ... }`; on provider error it throws.
Either way the client falls back to its local estimate, so the UI never breaks.

## Notes

- The Amadeus **test** environment has thin luxury inventory — expect `available:false`
  for many properties; the client shows its estimate in that case.
- To respect rate limits at scale, add a short-TTL cache (Firestore/Memorystore) keyed
  by `hotelId|checkIn|nights|guests`. The in-file token cache is per warm instance only.

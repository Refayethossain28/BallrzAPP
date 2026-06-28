# ApexVIP Cloud Functions

Functions in this codebase:
- **`getHotelRates`** — live hotel pricing from **Amadeus** (server-side; see
  [`docs/apexvip-live-hotel-rates.md`](../docs/apexvip-live-hotel-rates.md)).
- **`processSquarePayment`** — authorize (pre-auth) a card payment via **Square**.
- **`captureSquarePayment`** — capture the authorized payment on trip completion.
- **`refundSquarePayment`** — full/partial refund per the cancellation policy.
- **`onBookingWrite`** — Firestore trigger that emails (SendGrid) and texts
  (Twilio) the client as a booking moves through its lifecycle.

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
npm run build       # esbuild src/index.ts → lib/index.js (the deployed artifact)
```

`lib/` is the build output (git-ignored). `firebase deploy` runs `npm run build`
first via the `predeploy` hook in `firebase.json`, so the compiled `lib/index.js`
is always fresh. `main` points at `lib/index.js`.

## ⚠️ Deploy ONLY these functions

This repo is a **separate functions codebase** (`apexvip-hotels`) from the project's
other functions (`parseBookingIntent`, `checkFlightStatus`, …), which live elsewhere.
**Always scope the deploy** so you don't touch the others:

```sh
firebase deploy --only functions:getHotelRates,functions:processSquarePayment,functions:captureSquarePayment,functions:refundSquarePayment,functions:onBookingWrite,functions:onBookingCreated
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

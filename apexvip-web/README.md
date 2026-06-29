# ApexVIP Web (TypeScript + Vite)

The typed frontend foundation for the ApexVIP apps, and the on-ramp for migrating
the single-file HTML apps (`apexvip-client.html`, `apexvip-driver.html`,
`apexvip-admin.html`) into a real build — **without touching them** until you're
ready. They keep running exactly as today.

## What's here

- **`src/apexClient.ts`** — a fully-typed client over the Cloud Functions
  callables. Every call is checked against the shared contract, so the request
  and the result are both typed:

  ```ts
  const apex = makeApexClient(app);
  const quote = await apex.getHotelRates({ lat, lng, checkIn });   // typed args
  if (quote.available) console.log(quote.nightly);                 // typed result
  ```

  Misspell a field, or read one the backend never returns, and it's a **compile
  error** — not a production incident. (Verified: passing `{ msg }` instead of
  `{ message }` to `parseBookingIntent` fails `npm run typecheck`.)

- **`@apexvip/contract`** — aliased (see `vite.config.ts` / `tsconfig.json`) to
  the canonical contract in [`../functions/src/contract.ts`](../functions/src/contract.ts).
  The backend and the browser share **one** set of request/response types. It's
  imported type-only, so none of it ships to the browser.

- **`src/concierge/`** — the first screen migrated out of `apexvip-client.html`:
  the **ApexAI concierge brain**, now typed and unit-tested.
  - `intent.ts` — a faithful port of the on-device `_parseIntentLocal` parser
    (rides, airports, flights, times, dates, multi-stop, hotel discovery), made
    pure by injecting its context instead of reaching page globals.
  - `concierge.ts` — `resolveConcierge(...)`: hotel discovery stays local, else
    the typed Cloud Function (Claude), else the local parser as an offline
    fallback so the chat never goes dark.
  - `intent.test.ts` — 15 tests (`npm test`). The page keeps its UI; only the
    deterministic logic graduated to TS.

- **`src/payments/`** — the **Square checkout flow**, the second screen migrated.
  - `pricing.ts` — `quoteFare(base, promo)`: the VAT-inclusive base/discount/
    total/VAT math from `confirmBooking`, now pure.
  - `checkout.ts` — `runCheckout(...)`: tokenize → SCA (non-fatal) → typed
    `processSquarePayment` → store the token in `pending_payments` on backend
    error → demo mode offline. The Square SDK and Firestore are injected, so
    there's no DOM/SDK coupling.
  - `pricing.test.ts` + `checkout.test.ts` — 9 tests covering the rounding and
    every checkout branch (card error, SCA failure, backend failure, offline).

## Commands

```sh
cd apexvip-web
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test — the concierge engine (15 tests)
npm run dev         # Vite dev server
npm run build       # typecheck + production bundle → dist/
```

The repo's SessionStart hook runs the `functions` and `apexvip-web` typechecks
plus these tests, so a broken contract or type error surfaces at session start
rather than at deploy.

## How config is wired

`src/main.ts` reads the same `APEXVIP_FIREBASE_CONFIG` global the HTML apps
already use, and targets the `us-central1` region the functions deploy to — so
this build can adopt the existing hosting/config without re-plumbing.

## Migration path

1. **Now:** new frontend code calls `apex.<fn>(…)` and gets end-to-end types.
   The concierge brain (`src/concierge/`) is the first screen lifted across.
2. **Incremental:** continue lifting one screen at a time out of the giant HTML
   files into `src/`; each becomes type-checked and unit-testable. Done so far:
   the concierge brain (`src/concierge/`) and the Square checkout flow
   (`src/payments/`). The next natural candidate is the driver payout screens —
   already covered by the contract.
3. **Capacitor — when the app is fully migrated:** the iOS wrappers (`mobile/`)
   bundle web output the same way. Point `mobile/build-www.mjs` at this package's
   `dist/` **only once the whole app lives here** — doing it now would ship just
   the migrated screen and drop the rest. Until then, the wrappers keep bundling
   the existing `apexvip-client.html` / `apexvip-driver.html` unchanged.

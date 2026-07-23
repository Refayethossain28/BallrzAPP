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

- **`src/payouts/`** — the **driver payout flow** (Stripe Connect), third screen.
  - `ledger.ts` — `aggregateOwedBalances(...)`: groups the `driver_payouts`
    ledger per driver (sum owed, count trips) for the admin "Pay out" list, plus
    `formatSettlement(...)` for the `payoutDriver` result.
  - `onboarding.ts` — `startPayoutOnboarding(...)`: the driver `setupPayouts`
    decision logic (demo / already-active / create-and-open link / schedule
    status refresh), with the window-open and timer injected.
  - `ledger.test.ts` + `onboarding.test.ts` — 11 tests.

- **`src/referrals/`** + **`src/trips/`** — the remaining client callables, each
  with its backend-mirrored validation/normalization plus a typed wrapper:
  referral codes (`referrals.ts`), trip rating (`trips/rating.ts`), chauffeur
  chat (`trips/chat.ts`), and flight status with the on-device demo fallback
  (`trips/flight.ts`). 28 tests across the four.

## The shared engine (`apexvip-engine.js`)

The **pure** logic — concierge parser, fare math, payout aggregation, and the
referral/rating/chat/flight helpers — is re-exported from `src/engine.ts` and
built into a committed UMD bundle at the repo root, `apexvip-engine.js`, via:

```sh
npm run build:engine    # vite --config vite.engine.config.ts → ../apexvip-engine.js
```

It exposes `window.ApexEngine` (no Firebase, no DOM — verified). The single-file
HTML apps load it and call into it, so there's **one** implementation of this
logic — the one these tests cover. Rebuild it whenever a pure module changes.

### Closing the loop — the HTML apps consume it

- `apexvip-client.html` loads `apexvip-engine.js`; its `_parseIntentLocal` (≈160
  lines) is now a thin delegator to `ApexEngine.parseIntentLocal(msg, ctx)`, and
  its fare math calls `ApexEngine.quoteFare`.
- `apexvip-admin.html` uses `ApexEngine.aggregateOwedBalances` /
  `formatSettlement` for the payout list.
- `mobile/build-www.mjs` copies `apexvip-engine.js` into the Capacitor `www/`, so
  the iOS wrappers ship it too.

## Commands

```sh
cd apexvip-web
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test — all engine modules (63 tests)
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
2. **Done:** every client callable now has a typed, tested module — concierge
   (`src/concierge/`), checkout (`src/payments/`), payouts (`src/payouts/`),
   referrals (`src/referrals/`) and trips (`src/trips/`). Their pure logic is
   wired back into the HTML apps via `apexvip-engine.js`, so the apps consume one
   tested implementation instead of duplicating it.
3. **Lifting the UI (in progress):** the first screen is lifted — the ApexAI
   concierge chat (`src/concierge/ConciergeChat.ts` + `concierge.css`). It owns
   its markup/styling/events and talks to the migrated brain (`resolveConcierge`);
   runs offline via the parser, routes through Claude when a `backend` is passed.
   `src/main.ts` mounts it as the page. Two wins over the inline original:
   render-path type safety, and XSS-safe `textContent` rendering (the source
   interpolated user text into `innerHTML`). Verified in a real browser:

   ```sh
   npm run build && npm run preview &     # serve the build
   PW_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
     BASE_URL=http://localhost:4173 npm run test:e2e
   ```

   `e2e/concierge.e2e.mjs` loads the page in Chromium, sends a request, and
   asserts the typed reply + parsed "understood" summary render.
4. **Capacitor — when the app is fully migrated:** the iOS wrappers (`mobile/`)
   bundle web output the same way. Point `mobile/build-www.mjs` at this package's
   `dist/` **only once the whole app lives here** — doing it now would ship just
   the migrated screens and drop the rest. (It already copies `apexvip-engine.js`
   so today's wrappers keep working.)

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

## Commands

```sh
cd apexvip-web
npm install
npm run typecheck   # tsc --noEmit
npm run dev         # Vite dev server
npm run build       # typecheck + production bundle → dist/
```

## How config is wired

`src/main.ts` reads the same `APEXVIP_FIREBASE_CONFIG` global the HTML apps
already use, and targets the `us-central1` region the functions deploy to — so
this build can adopt the existing hosting/config without re-plumbing.

## Migration path

1. **Now:** new frontend code calls `apex.<fn>(…)` and gets end-to-end types.
2. **Incremental:** lift one screen at a time out of the giant HTML files into
   `src/` components; each becomes type-checked and unit-testable.
3. **Capacitor unchanged:** the iOS wrappers (`mobile/`) bundle web output the
   same way — point them at `dist/` instead of the raw HTML when a screen moves.

# ApexVIP — modularization plan (the exit from single-file HTML)

**Status:** accepted direction, incremental — no big-bang rewrite.

## The problem

The prototyping convention that made this repo fast — one self-contained HTML
file per app, UI built by string-concatenated `innerHTML` — is now carrying a
product. `apexvip-client.html` is ~6,000 lines; admin is similar. Costs that
are already visible:

- Rendering is stringly-typed: every interpolation is a potential escaping bug
  (mitigated by `esc()` discipline and the smoke test, but unchecked by tools).
- No dead-code detection, no imports, no tree of ownership — a change anywhere
  can break anywhere, and only the browser e2e suite notices.
- Screen-level testing means driving Chromium; there is no cheap component test.
- Merge conflicts concentrate in two giant files.

## What already points the way

The repo has all the escape hatches in place; this plan just extends them:

- **Pure engines** (`concierge/engine.js`, `apexvip-lib.js`, `imposter/engine.js`)
  hold the business logic outside the DOM and are unit-tested in Node. This
  boundary is correct — keep it.
- **`apexvip-web/`** is a working Vite + TypeScript workspace that already
  builds `apexvip-engine.js` from typed sources (`npm run build:engine`) and
  hosts the unit + e2e suites. It is the destination.
- **`rentmatch/apps/web`** proves a full Vite app can build to a static
  subpath of the Pages site (`/apex/`).

## The migration, in order

Each step ships alone and leaves the site working; stop at any point and
nothing is half-broken.

1. **Freeze the pattern (done in the hardening pass).** New logic goes in
   engines or shared root scripts (`apexvip-track.js`), never copy-pasted into
   pages. CI runs the browser e2e suite + smoke + `checkJs` typechecking, so
   the legacy files are at least regression-guarded.
2. **Extract, don't rewrite.** Move the remaining pure logic out of
   `apexvip-client.html` (fare math is already in `apexvip-lib.js`; candidates:
   booking state machine, ApexCoin ledger, promo/referral rules) into typed
   modules under `apexvip-web/src/`, compiled into the existing
   `apexvip-engine.js` bundle. Each extraction adds unit tests.
3. **New screens are components.** Any *new* surface is built in `apexvip-web`
   (Vite/TS) and shipped either as its own page under a subpath (the
   `/apex/` pattern) or as a mounted widget inside the legacy page (a script
   tag exporting `mount(el)` — the concierge iframe embed shows the seam).
4. **Migrate the client screen-by-screen, highest churn first.** Booking flow
   → home → trips → profile. The legacy `screens` registry makes this
   mechanical: each screen function moves behind a typed component with the
   same `go()` contract, and the e2e suite is the referee.
5. **Admin last, ops-first UIs never.** The admin console tolerates the legacy
   pattern longest (internal tool, desktop, one user class); the mobile ops
   app is small enough to migrate in one sitting when its turn comes.
6. **Retire the smoke-test constraints.** Once a page is fully built by Vite,
   drop it from `scripts/smoke-prototypes.mjs` and rely on typecheck + unit +
   e2e.

## Rules of thumb during the transition

- Never add a second copy of anything; extract to a shared module instead.
- Anything touching money, entitlements or lifecycle state lives in an engine
  with unit tests — the UI only calls it.
- `innerHTML` interpolations always go through `esc()`; the e2e XSS canary
  stays until the last legacy page dies.
- Deploy stays static-first: everything must keep working on GitHub Pages with
  no server-side rendering.

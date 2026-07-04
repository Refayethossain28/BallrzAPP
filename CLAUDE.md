# BallrzAPP — repo conventions

Product prototypes plus one production-track ecosystem: **ApexVIP** (chauffeur
client/driver/admin at the repo root, concierge + mobile ops in `concierge/`,
backend in `functions/`). Everything ships as a static site to GitHub Pages
under `/BallrzAPP/`, backed by one Firebase project (`apexvip-1b4a9`).

## Architecture rules

- **Engines hold the logic.** Anything touching money, entitlements or
  lifecycle state lives in a pure, deterministic module (`concierge/engine.js`,
  `apexvip-lib.js`, …): all money in integer pence, `now` always a parameter,
  never reads the clock, UMD so Node tests and browsers share it. UI calls
  engines; engines never touch the DOM.
- **Server owns entitlements.** When real billing is on, the Stripe webhook
  (`functions/src/velvet.ts`) writes subscription truth and `firestore.rules`
  block client writes to it. Server tier prices must match the engine —
  enforced by a parity test in `scripts/test-concierge-logic.mjs`.
- **Graceful degradation is a contract.** Every app must work with no Firebase
  config, no network, and no deployed functions (the e2e suite runs with all
  external hosts blocked). Cloud features are additive, never load-bearing.
- **No copies.** Shared behavior goes in a root module (`apexvip-track.js`,
  engine exports like `DESK_ACTIONS`), not pasted between pages. Exception,
  on purpose: `concierge/cloud.js` inlines its own `track()` because its
  service worker only caches its own directory.
- **Migration direction:** new logic → typed modules in `apexvip-web/src`;
  new screens → Vite/TS, not more single-file HTML. See
  `docs/apexvip-modularization-plan.md`.

## Constraints that will bite you

- **The smoke test executes every page's inline scripts** in a stubbed-DOM vm
  sandbox (`scripts/smoke-prototypes.mjs`). Classic scripts only (no modules),
  and only sandbox-provided globals: no `Intl`, no `URL`, no `Notification`.
  Timers are neutered, `localStorage.getItem` returns null. Top-level code
  must never throw with all of that stubbed.
- **The deploy is an allowlist** — `scripts/assemble-site.sh` is the single
  source of what ships (used by both `pages.yml` and CI). If you add a file a
  page references, add it there; `scripts/check-site.mjs` fails CI when the
  two drift. This bug class 404'd four different things before the checker
  existed; don't reintroduce it.
- **`apexvip-engine.js` is generated** — edit `apexvip-web/src` and run
  `npm --prefix apexvip-web run build:engine`; CI diffs the bundle.
- **Service workers cache aggressively.** Any change to `concierge/*` cached
  assets needs a `CACHE` version bump in `concierge/sw.js`.
- **Firestore data contracts are live.** `velvet_*` collection names, the
  `mode: 'velvet'` API flag, Stripe lookup keys and localStorage keys are
  deployed surface — the user-facing brand is ApexVIP, internal codename
  stays `velvet`. Don't rename them.
- **`escape`d `innerHTML` only** — every interpolated string goes through the
  page's `esc()` helper; the e2e suite carries an XSS canary.

## Verification (run before pushing anything nontrivial)

```sh
npm test                                   # smoke (all pages) + every engine suite
npm run typecheck:web                      # checkJs over concierge engine/cloud
npm run site:check                         # assemble + reference-check the site
npm --prefix functions run typecheck && npm --prefix functions test
npm --prefix apexvip-web run test:e2e:velvet    # browser e2e (member/embed/admin/ops)
```
In sandboxes with a preinstalled Chromium, pass
`PW_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell`
to the e2e scripts. Rules tests need the emulator: `npm --prefix functions run test:rules`.

## Deploys

- **Site**: merge to `main` → `pages.yml`. GitHub's deploy step occasionally
  flakes ("try again later"); re-run via a **fresh** `workflow_dispatch` — a
  plain re-run fails on a duplicate artifact.
- **Backend**: `firebase-deploy.yml` on `main` (needs the service-account IAM
  fix documented in that workflow's failures) or manually
  `npm --prefix functions run deploy`. Staging: `docs/apexvip-staging.md`.

## House style

- Commit messages explain *why*, wrapped ~72 cols, no emoji.
- Every feature lands with its tests and a doc touch (`SETUP.md`, `docs/…`).
- PRs: squash-merge; the repo's convention is title `(#PR)`.

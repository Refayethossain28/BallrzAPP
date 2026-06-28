# RentMatch (production app)

UK lettings marketplace — landlords advertise property, renters find a home,
and both parties message, book a viewing, agree terms and sign a UK-compliant
tenancy agreement. RentMatch charges the **landlord a one-off £100 fee on full
execution** of the agreement.

This is the real, structured application. The single-file
[`/rentmatch.html`](../rentmatch.html) prototype remains the clickable design
reference. The full architecture is in
[`docs/rentmatch-foundation.md`](../docs/rentmatch-foundation.md).

> **The marketplace is now the front door of a landlord operations product** —
> compliance autopilot, rent ledger + arrears, UK-tax-year finances, Direct Debit
> collection, an agent tier, tenancy renewals, and recurring subscriptions. See
> [`docs/rentmatch-revenue-plan.md`](../docs/rentmatch-revenue-plan.md) for the
> full feature inventory and the go-live checklist. The milestone log below
> covers the original marketplace core.

## Quickstart (for developers)

Prerequisites: **Node ≥ 22**, Java (for the Firestore emulator), and the
[Firebase CLI](https://firebase.google.com/docs/cli) (`npm i -g firebase-tools`,
or use `npx firebase-tools`).

```sh
npm install                         # installs all workspaces (web, functions, shared)
cp .env.example .env.local          # web config; also copy to functions/.env for server keys

# Unit tests — the shared domain kernel (pure, no emulator needed)
npm test                            # 97 tests

# Run the app locally against the Firebase Emulator Suite
npm run emulators                   # terminal 1: auth, firestore, functions, storage
VITE_USE_EMULATORS=1 npm run dev:web   # terminal 2: Vite dev server → http://localhost:5173

# Build
npm --workspace apps/web run build  # tsc -b && vite build
npm --prefix functions run build    # esbuild bundle

# End-to-end (Playwright)
cd apps/web
npm run e2e                         # headless render/routing smoke (no emulator)
npm run e2e:emulators               # full flows on the emulator suite: onboarding,
                                    # advertise→publish, enquiry, and the complete
                                    # deal lifecycle → £100 → auto-created tenancy
```

Notes:
- `e2e:emulators` builds the functions, boots auth/firestore/functions/storage,
  and runs Playwright with `VITE_USE_EMULATORS=1`. It uses a `STRIPE_FAKE` stub so
  the £100 completion runs without live Stripe keys.
- If the pre-installed Chromium build differs from the pinned `@playwright/test`,
  set `PW_CHROMIUM_PATH=/path/to/chromium`.

### Deploy
Fill the credentials in [`docs/rentmatch-revenue-plan.md`](../docs/rentmatch-revenue-plan.md)
("To go live"), then `npm run deploy` (`firebase deploy` — hosting + functions +
Firestore rules). Point Stripe and GoCardless webhooks at `stripeWebhook` /
`gocardlessWebhook`.

## Status

**M0 — foundation ✅**
- Monorepo scaffold (`apps/web`, `functions`, `packages/shared`)
- Firebase config + emulator suite (`firebase.json`, `*.rules`, indexes)
- **`packages/shared`** — the tested domain kernel: deal state machine, UK
  compliance gates, money / Tenant Fees Act caps, tenancy-agreement generation

**M1 — auth · properties/listings · search ✅**
- Firebase Auth (email/password); every account can act as renter **or**
  landlord, toggled in the header and persisted to the user profile
- Renter: browse + filter/sort live listings (`searchListings`), listing detail
  with Tenant-Fees-Act deposit/holding figures
- Landlord: advertise a property; the shared compliance kernel decides whether
  it goes **live** or is held as a **draft** with the failing statutory checks shown
- React + Vite + TanStack Query, reusing `@rentmatch/shared` (search logic added
  there with tests — 27 kernel tests total)

**M2 — messaging · viewings · agreement ✅**
- Renter enquiry from a listing opens a shared **deal** (one per renter↔listing)
- **Realtime chat** between renter and landlord (Firestore `onSnapshot`)
- **Viewings** — either party proposes a date/time; the other confirms or
  suggests another; a confirmed viewing advances the deal to the `viewing` stage
- **Agree to proceed** — both parties agree to reach `agreed`
- Stage is always re-derived from the deal's facts via the shared
  `recomputeStage` (6 new tests → 33 kernel tests). A live progress pipeline
  shows where the deal stands
- Firestore rules tightened to match: participants may only touch
  messaging/viewing/agreement fields and can't drive a deal past `agreed`

**M3 — tenancy-agreement drafting (Cloud Functions come online) ✅**
- First server-authoritative transition: the `draftContract` **callable Cloud
  Function** lets only the landlord, only once both parties have agreed, generate
  the Assured Shorthold Tenancy. It runs the shared compliance + contract kernel
  under the Admin SDK, writes an immutable `contracts/{dealId}` doc, advances the
  deal to `contract`, and appends an audit `event`
- Renter + landlord can **review the generated agreement** (parties, term, rent,
  capped deposit, numbered clauses) with the statutory compliance checklist
- Functions build bundles `@rentmatch/shared` via esbuild (deployable +
  emulator-runnable); the £100 fee is surfaced but charged on signing in M5

**M4 — e-signature ✅**
- `openSigning` (landlord) opens the e-signature envelope and advances the deal
  to `signing`; `recordSignature` captures each party's signature — both are
  Cloud Functions standing in for the e-sign provider's hosted signing + webhook
- ContractView shows live signature status and a Sign action for the signed-in
  party; the deal **stays at `signing` even once both have signed** — completion
  waits on the £100 fee, exactly as the shared completion guard requires
- New shared helpers `bothSigned` / `awaitingFee` pinpoint the moment M5 charges
  (4 new tests → 37 kernel tests)

**M5 — Stripe £100 landlord fee on full execution ✅ (headline)**
- `createSetupIntent` saves the landlord's card; `chargePlatformFee` charges the
  £100 **off-session** once both parties have signed, with an idempotency key of
  the dealId so retries never double-bill
- `completeDeal` (transactional, idempotent) marks the deal `completed`, flips the
  listing to `let`, records the payment and posts the receipt message. Called by
  the synchronous charge **and** by the `stripeWebhook` (durable source of truth,
  signature-verified)
- Web `PaymentPanel` (Stripe Elements): save card → pay → the live deal
  subscription flips the agreement to "in force"

This closes the original brief end-to-end: advertise → find → message → view →
agree → sign → **the landlord is charged £100 and the tenancy completes**.

**M6 — compliance documents + notifications ✅**
- Listings are now created as **drafts** and only go `live` through the
  server-authoritative `publishListing` Cloud Function, which re-runs the shared
  compliance gate against the documents actually uploaded. Firestore rules stop
  clients setting `status` directly
- Landlords upload EPC / EICR / gas (CP12) PDFs to Storage via `ComplianceManager`;
  doc lifecycle (`missing`/`valid`/`expiring`/`expired`) comes from the shared
  `docStatus` helper with sensible default validity windows
- Notifications: a Firestore trigger (`onDealMessageCreated`) builds copy from the
  shared `buildNotification` and fans out to the recipient's FCM tokens (email is
  the same seam); `registerPushToken` + an Account opt-in store the device token
- 3 new tests (notification copy + doc-expiry) → 40 kernel tests

**M7 — hardening, GDPR/retention, launch readiness ✅**
- **App Check** (reCAPTCHA v3) initialised in the web app (enforce in console
  before launch)
- **UK GDPR right to erasure** (`requestDataErasure`): redacts profile PII and
  names across deals, retaining completed-tenancy records within their legal
  window; Account has an "Erase my personal data" action
- **Retention sweep** (`purgeStaleData`, scheduled daily): purges stale drafts
  (90d) and abandoned enquiries (180d); completed tenancies kept ~7 years
- **Email channel** seam wired (e.g. the £100 receipt) behind `sendEmail`
- Playwright happy-path scaffold; launch & security checklist in
  [`LAUNCH.md`](./LAUNCH.md)
- Retention/erasure helpers added to the shared kernel (4 tests → **44 total**)

**Status: feature-complete through M7.** The full brief runs end-to-end —
advertise → find → message → view → agree → sign → the landlord is charged £100
→ the tenancy completes — with server-authoritative money/contract handling, UK
statutory gates, notifications, and GDPR controls. Remaining work to go live is
credential wiring and the items in [`LAUNCH.md`](./LAUNCH.md) (real e-sign
provider, email provider, App Check enforcement, deposit-scheme API, CI).

### Verification status
The shared domain kernel is unit-tested — **97 tests** (`npm test`): deal state
machine, compliance + portfolio reminders, money, search, contract, billing,
rent ledger + reminders + statements, finances, Direct Debit reconciliation,
agency rollup, and renewals.

The web app + Cloud Functions are exercised **end-to-end against the Firebase
Emulator Suite** (`npm run e2e:emulators`): onboarding, advertise→upload→publish
(Functions + Storage), a two-party enquiry, and the **complete deal lifecycle to
completion** — viewing, agreement, draft, e-sign, the £100 charge (via a Stripe
stub), and the auto-created tenancy. Running these surfaced and fixed three real
bugs (renter enquiry blocked by a cross-user read; a `draftContract` undefined
write; a publish/agree read-modify-write race). The live Stripe/GoCardless/e-sign
integrations still need real credentials to exercise.

> Server-authoritativeness: contract/signature/payment now flow through Cloud
> Functions (M3 starts this). M1's listing compliance gate and M2's enquiry/
> viewing/agreement transitions still run client-side under tightened rules;
> they move behind Functions in M6.

## Layout

```
apps/web/        React + Vite PWA (renter + landlord client)
functions/       Cloud Functions — server-authoritative deal logic, Stripe, e-sign
packages/shared/ framework-agnostic, unit-tested domain logic (the "brain")
firebase.json    hosting + emulator suite      firestore.rules / storage.rules
```

## Develop

Requires Node ≥ 22 (the shared kernel runs TypeScript natively, no build step).

```sh
# run the shared-kernel unit tests (zero dependencies)
npm test            # from rentmatch/

# install app + function deps (needs network), then run locally
npm install
npm run emulators   # Firebase Auth/Firestore/Functions/Storage emulators
npm run dev:web     # Vite dev server
```

Copy `.env.example` → `.env.local` (web) and `functions/.env`, and fill in the
Firebase, Stripe and e-sign keys.

## Why a shared kernel?

`packages/shared` holds the rules that must never disagree between client and
server — the deal lifecycle, the £100-on-execution guard, the Tenant Fees Act
deposit caps, the EPC/gas/EICR letting gates. The web client uses it to preview
which actions are available; the Cloud Functions use the *same* code to enforce
them authoritatively. One source of truth, unit-tested in isolation.

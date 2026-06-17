# RentMatch (production app)

UK lettings marketplace — landlords advertise property, renters find a home,
and both parties message, book a viewing, agree terms and sign a UK-compliant
tenancy agreement. RentMatch charges the **landlord a one-off £100 fee on full
execution** of the agreement.

This is the real, structured application. The single-file
[`/rentmatch.html`](../rentmatch.html) prototype remains the clickable design
reference. The full architecture is in
[`docs/rentmatch-foundation.md`](../docs/rentmatch-foundation.md).

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

Next: M5 — Stripe £100 fee on full execution → deal `completed`, listing `let`.

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

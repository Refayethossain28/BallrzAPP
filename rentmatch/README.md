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

Next: M2 messaging + viewings. See the roadmap in the foundation doc.

> M1 note: listing creation runs the compliance gate client-side for now; M6
> moves document verification (and status changes) behind Cloud Functions so it
> is fully server-authoritative.

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

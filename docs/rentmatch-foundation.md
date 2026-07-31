# RentMatch — Foundation & Architecture

> UK lettings marketplace. Landlords advertise property; renters find a home.
> The two parties message, arrange a viewing, agree terms, then both sign a
> UK-compliant tenancy agreement. RentMatch charges the **landlord a one-off
> £100 fee when the agreement is fully executed**.

This document is the agreed foundation that every later change is checked
against. The clickable design reference is [`/rentmatch.html`](../rentmatch.html)
(a zero-build single-file prototype of the whole flow).

## Decisions locked

| Decision | Choice | Rationale |
|---|---|---|
| Platform | **Web-first PWA**, native later | One codebase, installable, fastest to validate the marketplace; clean path to Capacitor/React Native reusing `packages/shared` |
| Backend | **Firebase** (Auth, Firestore, Cloud Functions, Storage, FCM, App Check) | Realtime chat, managed, matches the original Firebase-based BallrzApp |
| Payments / e-sign | **Real Stripe + e-signature** | Stripe for the £100 fee; a real e-sign provider for a legally-binding tenancy with an audit trail |
| Fee trigger | **On full execution** (both signatures captured) | Same "on signing" intent, but never bills a landlord when the renter ghosts after the landlord signs. Card is collected earlier via a Stripe SetupIntent so the charge is instant |
| MVP jurisdiction | **England only — Assured Shorthold Tenancy** | Largest market; Wales left the AST regime in Dec 2022 (Renting Homes (Wales) Act → *occupation contracts*), and Scotland (Private Residential Tenancy) / NI differ. Tenancy type is a function of property nation, but only the AST path ships first |

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React + TypeScript + Vite, PWA via `vite-plugin-pwa`, React Router, TanStack Query, Zustand |
| Search/map | Firestore + geohash (or Algolia) for filtered search; Mapbox/Leaflet map view |
| Backend | Firebase — Auth, Firestore, Cloud Functions (TS), Storage, FCM, App Check |
| Payments | Stripe — SetupIntent (card on file) → PaymentIntent (£100) + webhooks |
| E-sign | SignWell / Dropbox Sign / DocuSign via Cloud Functions + webhooks |
| Shared logic | `packages/shared` — framework-agnostic TypeScript, unit-tested, consumed by web **and** functions **and** future native |

**Server-authoritative principle.** Money, deal-stage and contract fields are
written **only** by Cloud Functions; Firestore rules forbid clients from
mutating them. This is what makes the £100 charge and the state machine
trustworthy — a client cannot fake a "completed" deal or a paid fee.

## Repository structure (monorepo)

```
rentmatch/
├─ apps/web/                 # React PWA (the renter + landlord client)
│  └─ src/features/          # listings · search · messaging · viewings ·
│                            #   deals · contracts · payments · account
├─ functions/                # Cloud Functions (deal transitions, Stripe, e-sign, compliance)
├─ packages/shared/          # THE BRAIN — pure, tested, framework-agnostic
│  └─ src/
│     ├─ money.ts            # GBP formatting + Tenant Fees Act 2019 caps + £100 fee
│     ├─ dealStateMachine.ts # legal transitions + completion guard (both signed + fee paid)
│     ├─ compliance.ts       # UK statutory gates (EPC, gas, EICR, deposit, How to Rent…)
│     ├─ contractTemplate.ts # tenancy-agreement generation by nation
│     └─ types.ts
├─ firestore.rules · storage.rules · firestore.indexes.json
└─ firebase.json             # hosting + emulator suite
```

`packages/shared` is the key move: the deal state machine, compliance rules and
money math are extracted here so the web client, the Cloud Functions, and a
future native app run **identical, tested logic**.

## Data model (Firestore)

```
users/{uid}            roles {renter,landlord}, profile, KYC/verification status
properties/{id}        landlord's physical asset, nation, complianceDocs[]
listings/{id}          published advert (denormalised for search), status
deals/{id}             listingId, renterId, landlordId, stage, agreed{}, signed{}
  ├─ messages/{id}     realtime chat + system events
  └─ events/{id}       immutable audit log of every state transition
viewings/{id}          dealId, datetime, status (proposed → confirmed)
contracts/{id}         dealId, version, AST data, pdfRef, esignEnvelopeId
payments/{id}          dealId, stripePaymentIntentId, £100, status, receiptUrl
complianceDocs/{id}    type (epc/gas-safety/eicr/...), fileRef, issuedAt, expiresAt
```

## Deal lifecycle (server-enforced)

```
enquiry → viewing → agreed → contract → signing → completed
   │         │         │         │          │          
   └─────────┴─────────┴─────────┴──────────┴──► cancelled (until completed)
```

Each transition is validated by `packages/shared/dealStateMachine.ts` and
executed inside a callable Cloud Function — never by the client. Guards:

| → Stage | Requires |
|---|---|
| viewing | a confirmed viewing |
| agreed | both renter **and** landlord agreed |
| contract | landlord has drafted the agreement |
| signing | e-sign envelope opened |
| **completed** | **both signatures captured AND landlord £100 fee paid** |

## The money + contract critical path

1. **Agree** — both tap agree; the landlord's card is saved via a Stripe
   **SetupIntent** (no charge yet).
2. **Draft** — Function renders the AST from `contractTemplate` + deal data and
   opens an **e-sign envelope** for both parties.
3. **Sign** — renter signs, then landlord signs.
4. **Execute** — the e-sign "envelope complete" webhook (signature verified)
   triggers a Stripe **PaymentIntent for £100** off the saved card, keyed by
   `dealId` for idempotency.
5. **Complete** — `payment_intent.succeeded` webhook marks the deal
   `completed`, the listing `let`, stores the executed PDF, and emails receipts.

## UK compliance layer (a hard gate)

`packages/shared/compliance.ts` encodes statutory requirements as gates that
**block state transitions**:

- **Before a listing goes live:** valid **EPC band ≥ E**, **Gas Safety CP12**
  (annual, if gas), **EICR** (5-yearly), smoke alarm per storey + CO alarms.
- **Before signing:** **How to Rent** guide served, **Right to Rent** checks
  (Immigration Act 2014), deposit within **Tenant Fees Act 2019** caps
  (5 weeks if annual rent < £50k, else 6), holding deposit ≤ 1 week.
- **After signing:** deposit protected in a government scheme (DPS/mydeposits/
  TDS) + prescribed information within 30 days — deadline tracked and nudged.

## Security, notifications, tooling

- **Firestore rules + App Check:** participants read their own deals; payment /
  stage / contract fields are write-locked to Functions; App Check blocks
  scripted abuse.
- **Notifications:** FCM push + transactional email (new message, viewing,
  signature request, payment receipt).
- **Local + CI:** Firebase **Emulator Suite** for offline dev; GitHub Actions
  runs typecheck, unit tests (`packages/shared`), Playwright (deal happy-path)
  and deploys Firebase **preview channels** per PR.

## Roadmap

| Milestone | Scope |
|---|---|
| **M0** ✅ | Monorepo scaffold, Firebase config + emulators, `packages/shared` (state machine, compliance, money, contract) **with unit tests** |
| M1 | Auth, properties, listings, search |
| M2 | Messaging + viewings |
| M3 | Deal agreement + audit log |
| M4 | AST generation + e-sign integration |
| M5 | Stripe £100 fee + webhooks |
| M6 | Compliance gating + notifications |
| M7 | Hardening, GDPR/retention, launch |

## Open follow-ups

- Deposit-scheme API integration (DPS/mydeposits/TDS) and the 30-day clock.
- Landlord KYC / identity verification and Right-to-Rent evidence capture.
- VAT treatment of the £100 fee; refund/chargeback policy.
- GDPR data-retention and right-to-erasure handling for messages/contracts.
- Wales (occupation contract), Scotland (PRT) and NI tenancy types post-MVP.

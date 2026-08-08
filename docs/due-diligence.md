# Due-diligence pack

Everything an acquirer's technical and legal reviewers need to assess this
portfolio, in one place. Companion documents: [portfolio.md](./portfolio.md)
(the product catalog), [`LICENSE`](../LICENSE) (proprietary terms),
[`SECURITY.md`](../SECURITY.md) (security policy and posture).

## 1. What is being offered

A portfolio of ~40 software products in one repository, spanning one
production-track platform (**ApexVIP** — luxury chauffeur + concierge, with a
real Firebase/Stripe backend, ops runbooks and iOS wrappers) and a set of
self-contained consumer apps (browser, search engine, satnav, OS, messenger,
social network, two cryptocurrencies, and more — see the catalog). Products
are separable: each app lives in its own directory with its own engine,
tests and (where applicable) cloud setup docs, so individual apps can be
carved out and sold or licensed independently.

## 2. Ownership & IP provenance

- **Sole owner:** Refayet Hossain (github.com/Refayethossain28). No
  co-founders, no outside contributors, no employer claims, no prior
  assignments or encumbrances.
- **Development model:** written by the owner with AI pair-programming
  assistance (Anthropic's Claude, under the owner's direction in the owner's
  accounts). The full commit history is in this repository.
- **No copied proprietary code.** From-scratch implementations (SHA-256,
  secp256k1, QR encoding, Porter stemmer, BM25, polyline codec, etc.) are
  implemented from public specifications (FIPS 180-4, RFCs, published
  algorithms) and verified against the specs' own published test vectors.
- **Trademarks:** no registered trademarks. Product names (ApexVIP, Voyager,
  Seeker, Atlas, …) are unregistered; an acquirer should run its own
  clearance before commercial launch.

## 3. Licensing

- **This code:** proprietary, all rights reserved — see [`LICENSE`](../LICENSE).
  Nothing in the repository is under an open-source license, so an acquirer
  takes the code unencumbered by copyleft or attribution obligations of its
  own making.
- **Dependencies:** deliberately minimal. Most apps are **zero-dependency**
  vanilla HTML/CSS/JS. Every direct dependency across all workspaces is
  MIT- or Apache-2.0-licensed (audited 2026-08; no GPL/AGPL/SSPL anywhere):
  - root: `@anthropic-ai/sdk` (MIT), `jsqr` (Apache-2.0, dev-only)
  - `functions/`: `firebase-admin` (Apache-2.0), `firebase-functions` (MIT),
    `stripe` (MIT), `ethers` (MIT), `@anthropic-ai/sdk` (MIT)
  - `apexvip-web/`: `firebase` (Apache-2.0); dev: `vite` (MIT),
    `typescript` (Apache-2.0), `playwright` (Apache-2.0)
  - `ios-app/`: Capacitor packages (MIT); `apexchain/`: OpenZeppelin
    contracts (MIT, dev); `trading-app/` (legacy): Next.js/React ecosystem
    (MIT)
- **Media assets:** icons, splash videos and illustrations were produced for
  this project. Photographic assets on the ApexVIP marketing site should have
  their licenses re-confirmed by an acquirer before commercial redistribution
  (standard media-clearance step).

## 4. Architecture (the repeated pattern)

Every serious app follows one architecture, which is the portfolio's main
engineering asset:

1. **A pure, deterministic engine** (`<app>/engine.js`) — all product logic
   (money math, state machines, ranking, consensus) as side-effect-free
   functions with injected clocks/seeds. No DOM, no network, no globals.
2. **A zero-build PWA shell** (`<app>/index.html`) — single-file UI over the
   engine. Offline-first, installable, on-device storage. No framework, no
   bundler, no build step to rot.
3. **Optional cloud** — a `config.js` stub; drop in Firebase credentials and
   the app gains accounts/sync/payments. Server trust lives in
   `firestore.rules` (owner/member-scoped, unit-tested) and Cloud Functions —
   the client can never grant itself entitlements.

Consequences for an acquirer: apps are trivially hostable (any static host),
trivially auditable (logic is in one pure file with a test suite), and
portable (engines can be lifted into any stack — the same engines already run
in Node tests, browsers, and inside AIOS).

## 5. Quality: tests & CI

- **~35 test suites, 700+ assertions**, one per engine (`npm test` runs them
  all; per-app scripts like `npm run test:orbit`). Crypto engines are tested
  against published vectors and attacked directly (double-spends, forged
  signatures, doctored forks).
- **CI on every push/PR** (`.github/workflows/ci.yml`):
  - typecheck + unit tests (root, `functions/`, `apexvip-web/`)
  - built-artifact freshness gate (`apexvip-engine.js` must match source)
  - published-asset link checking
  - **Firebase emulator integration**: the booking → dispatch → driver-claim
    loop, plus Firestore security-rules tests
  - **Playwright e2e**: the client booking flow end-to-end, XSS canary,
    zero-page-error loads; TimeCoin browser e2e against a live relay
- **Deploy workflows**: GitHub Pages publishing (`pages.yml`), Firebase
  deploy (`firebase-deploy.yml`), Firestore backup (`firestore-backup.yml`),
  audited backend consolidation (`backend-consolidate.yml`).

## 6. Third-party services

Nothing is load-bearing by default — every app works offline with zero keys.
Optional integrations, all replaceable:

| Service | Used by | Key needed | Notes |
|---|---|---|---|
| Firebase (Auth/Firestore/FCM/Hosting) | ApexVIP, Concierge, Ripple, Bloom, Orbit REAL, Atlas convoy, AIOS sync | Owner's project | Rules in repo; migratable to any Firebase project |
| Stripe (Checkout/Billing/webhooks) | ApexVIP payments, Concierge subscriptions | Secret key (Secret Manager) | Webhook mirrors truth into Firestore |
| Anthropic API | AIOS, Lingua, Imposter packs, Automaton, LLM compare | User-supplied key | Always optional; keys stay server-side |
| OpenStreetMap / CARTO / Esri tiles | Atlas, Orbit Real | Keyless | Tile-usage policies apply at production scale — budget for a commercial tile plan |
| OSRM / FOSSGIS routing, Nominatim geocoding | Atlas, Orbit Real | Keyless | Community servers; self-host for production |
| TfL open data, TomTom traffic | Atlas traffic | TomTom optional | |
| Amadeus (test) | TravelDeals LIVE mode | Optional free keys | Deterministic simulation without |
| Keyless open APIs (Wikipedia, ECB, CoinGecko, Open-Meteo, GDELT, HN, Stack Overflow, Open Library, Openverse) | Seeker, Omni | None | Graceful degradation when absent |
| Tanzil (Qur'an text), everyayah recitation | Lingua | None | Verified canonical text; scripture never AI-generated |

## 7. Security posture

See [`SECURITY.md`](../SECURITY.md). Highlights: no secrets in the repo
(verified by scan; deployment credentials live in GitHub Actions secrets and
Google Secret Manager); Firestore rules unit-tested in CI; companion servers
SSRF-guarded and localhost-bound; client crypto built on WebCrypto or
vector-verified from-scratch primitives; XSS escaping canaried in e2e.

## 8. Data & privacy

- Default posture: **no accounts, no telemetry, no tracking, on-device
  storage only.** Most apps never transmit user data anywhere.
- Cloud-enabled apps store user data in the owner's Firebase project (EU/UK
  processing configurable at project level), scoped to the owner/members by
  security rules. Bloom ships one-tap full data export; Voyager/AIOS export
  complete on-device backups.
- No third-party ad or analytics SDKs anywhere in the portfolio.
- GDPR position is strong by construction (data minimisation, local-first),
  but no formal DPIA/records exist — an acquirer would run its standard
  privacy onboarding for any app it takes live.

## 9. Honest disclosures & known gaps

- **Prototype vs production:** ApexVIP (backend, payments, ops runbooks, CI
  e2e) is production-track. Most other apps are polished, tested prototypes:
  real logic, real tests, but payment flows outside ApexVIP/Concierge are
  demo-mode, and they have not carried production traffic.
- **Cryptocurrencies:** TimeCoin and Neura are working prototypes with honest
  security-posture write-ups in their READMEs (`coin/README.md`,
  `neura/README.md`). They are not investments and are not deployed as public
  mainnets.
- **Regulated domains:** rides (Orbit Real), lettings (Apex), travel booking
  (TravelDeals), banking (Vault) and first aid (Lifeline) touch regulated
  territory; the apps state their limits in-product, and commercial launch
  would need the acquirer's compliance review. Charter states it is a model,
  not legal advice.
- **Keyless community APIs** (OSM tiles, OSRM, Nominatim) are fine at demo
  scale but need commercial plans or self-hosting at production scale
  (called out in §6).
- **Single-maintainer bus factor** — mitigated by the architecture: pure
  engines, exhaustive tests, zero-build shells and per-app setup docs
  (`*/SETUP.md`, `*/DEPLOY.md`, `docs/apexvip-*.md`).

## 10. What transfers in an acquisition

1. This repository (full history) and the GitHub Pages deployment.
2. The Firebase project(s) for cloud-enabled apps (transfer or re-point:
   every app reads its project from a `config.js` / functions config, so
   re-pointing to an acquirer-owned project is a config change).
3. Stripe account data per Stripe's standard platform-transfer process (or
   re-key against the acquirer's Stripe account).
4. Domains/handles as separately negotiated. Apple Developer artefacts
   (`ios-app/`, `intro/` Wallet passes) re-sign under the acquirer's Apple
   Developer account.
5. No employees, contractors, or third-party contracts encumber the assets.

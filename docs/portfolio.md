# BallrzAPP — product portfolio catalog

A buyer's map of every product in this repository. Each app is summarised in
one line here; the [README](../README.md) has the full feature write-ups, and
[due-diligence.md](./due-diligence.md) has ownership, licensing, quality and
third-party-service detail for acquisition review.

**Portfolio at a glance**

- ~40 products: one production-track transport/concierge platform (ApexVIP)
  plus a portfolio of self-contained consumer apps.
- Common architecture: a **pure, deterministic, unit-tested engine** per app
  (`<app>/engine.js`) + a zero-build offline-first **PWA shell**
  (`<app>/index.html`) + **optional cloud** (Firebase/Stripe) that is off by
  default. Apps run with no account, no build step and no server.
- 700+ unit/integration tests across ~35 suites, all run in CI on every push
  (typecheck, unit, Firebase-emulator integration, Playwright e2e — see
  `.github/workflows/ci.yml`).
- Everything is deployed live from this repo via GitHub Pages:
  [refayethossain28.github.io/BallrzAPP](https://refayethossain28.github.io/BallrzAPP/).

Legend — **Cloud**: what the app needs beyond a browser. *None* = fully
offline/on-device. *Optional Firebase/Stripe* = runs offline; drop in a config
to go live. **Tests**: the npm script that pins its logic.

## ApexVIP — the flagship platform (production-track)

Luxury chauffeur + concierge platform for six cities. Real backend, real
payments, deploy workflows, iOS wrappers.

| Component | What it is | Path | Cloud | Tests |
|---|---|---|---|---|
| Marketing site | Cinematic one-pager: fleet, cities, tiers, film | `apexvip/` | None | smoke |
| Client app | Booking app (hourly/transfer, fare quotes, payments) | `apexvip-client.html` | Firebase + Stripe/Square | e2e in CI |
| Driver app | Driver dispatch, claims, compliance, payouts | `apexvip-driver.html` | Firebase | e2e in CI |
| Admin app | Ops console: bookings, drivers, audit log | `apexvip-admin.html` | Firebase | e2e in CI |
| WhatsApp desk | WhatsApp-channel booking desk | `apexvip-whatsapp.html` | Firebase | smoke |
| Shared engines | Fare/loyalty/tier money-math | `apexvip-core.js`, `apexvip-engine.js`, `apexvip-lib.js` | — | `test:apexvip`, `test:apexvip-lib` |
| Typed frontend | TypeScript/Vite workspace + Playwright e2e | `apexvip-web/` | — | typecheck + e2e |
| Backend | Cloud Functions: dispatch, Stripe webhooks, notifications | `functions/`, `functions-side/` | Firebase, Stripe, Anthropic | typecheck + unit + emulator + rules |
| Concierge | Subscription concierge (£49/£199/£499, Stripe Billing) | `concierge/` | Optional Firebase + Stripe | `test:concierge` |
| iOS apps | Capacitor wrappers of client + driver | `mobile/`, `ios-app/` | as web | — |
| ApexChain | ApexCoin (AXC) as a real ERC-20 (Solidity/OpenZeppelin) | `apexchain/` | Any EVM chain | contract tests |
| Fixr | Concierge-OS founder docs + builds (the B2B angle) | `fixr/` | Optional | in-folder |
| Ops docs | Runbooks: go-live, payments, payouts, compliance, audit | `docs/apexvip-*.md` | — | — |

## Platforms & infrastructure apps

| App | What it is | Path | Cloud | Tests |
|---|---|---|---|---|
| AIOS | A browser-booted operating system (desktop + phone shells, VFS, shell/scripting language, app SDK, AI agent) | `aios/` | Optional Firebase sync, optional Anthropic | `test:aios` (81) |
| Voyager | A real web browser: tabs, omnibox, proxy full-browser mode, Web Memory, reader, from-scratch QR | `voyager/` | Optional companion server | `test:voyager` (76) + proxy (16) + QR |
| Seeker | A from-scratch search engine: Porter stemmer, BM25, crawler with robots.txt | `seeker/` | Optional crawler server | `test:seeker` (29) |
| Magpie | A from-scratch web scraper: HTML parser, CSS selector engine, auto-detected recipes, CSV/JSON export, robots-respecting pagination crawl, watch diffs | `magpie/` | Optional fetch server | `test:magpie` (38) |
| Atlas | A satnav: canvas map engine, turn-by-turn voice guidance, offline maps, dashcam, traffic | `atlas/` | OSM/OSRM/Nominatim (keyless) | `test:atlas` (34) |
| Orbit | Super-app: rides, eats, parcels, pay — plus REAL mode with human captains | `orbit/`, `orbit/real/` | Optional Firebase | `test:orbit` (60) |
| Omni | Do-everything utility app (tasks, notes, converters, QR, timers) | `omni/` | None | `test:logic` |
| Hub | Launcher PWA for the whole portfolio | `hub/` | None | smoke |
| Automaton | A sovereign AI agent that earns to pay for its own compute — or dies | `automaton/` | Anthropic (server) | `test:automaton` |

## Money, crypto & fintech

| App | What it is | Path | Cloud | Tests |
|---|---|---|---|---|
| TimeCoin | Complete Bitcoin-style PoW cryptocurrency from raw bytes (SHA-256, secp256k1, UTXO, halving) | `coin/` | None | `test:coin` (39) + e2e |
| Neura | AI-native chain: Proof-of-Intelligence consensus, bit-deterministic training per block | `neura/` | None | `test:neura` (17) |
| Vault | The digital bank | `vault/` | None | `test:vault` |
| Charter | Mint preferred convertible stock: term sheets, exit waterfalls, anti-dilution lab | `charter/` | None | `test:charter` (20) |
| Drip | Passive-income engine: compounding simulator, freedom date | `drip/` | None | `test:drip` (23) |
| Graft | Active-income engine: side-hustle matcher, planner, invoicing | `graft/` | None | `test:graft` (19) |
| FX Signal Pro | Currency-pair trading signals (single file + earlier Next.js build) | `trading-app/` | None | in-folder |

## Consumer apps

| App | What it is | Path | Cloud | Tests |
|---|---|---|---|---|
| Ballrz | Pocket football career with the 20 real Premier League clubs: live match tickers, tactics, transfers, league + cup, penalties, endless seasons — one deterministic engine | `ballrz/` | None | `test:ballrz` (42) |
| Bloom | Social network where the user owns the ranking algorithm | `bloom/` | Optional Firebase | `test:bloom` (34) |
| Ripple | Private messenger: schedule/edit/unsend, polls, App Lock encryption | `ripple/` | Optional Firebase | `test:ripple` |
| Imposter | Pass-and-play social-deduction party game (3–12 players) | `imposter/` | Optional Anthropic | `test:imposter` (20) |
| Cortex | Daily brain gym: five adaptive cognitive drills, global daily workout | `cortex/` | None | `test:cortex` (29) |
| Cusp | "What to do right now" — salience-scored task decision engine | `cusp/` | None | `test:cusp` |
| Intro | Digital business card: QR/NFC/vCard/Apple-Wallet .pkpass pipeline | `intro/` | None | `test:intro` (34) + pass (17) |
| TravelDeals | Flights & hotels: forecasts, deal scores, seat maps, booking wallet | `deals-app/` | Optional Amadeus keys | `test:deals` (31) |
| Lingua | Learn any language: SRS, CEFR course, pronunciation scoring, Qur'an studio | `lingua/` | Optional Anthropic | smoke |
| Lifeline | Offline-first emergency first aid + medical ID | `lifeline/` | None | in-folder |
| Apex (lettings) | UK lettings marketplace: list → enquire → view → sign AST | `rentmatch.html`, `rentmatch/`, `apex-site/` | None | smoke |

## AI / ML

| App | What it is | Path | Cloud | Tests |
|---|---|---|---|---|
| ApexAI | A GPT built from scratch in NumPy (autograd, transformer, BPE), weights baked into a web page | `llm-from-scratch/` | None | autograd numeric checks |

## Suites & concepts

| Item | What it is | Path |
|---|---|---|
| The App Suite | 13 self-contained dependency-free demo apps, one per category | `apps/` |
| Concepts | Two researched product specs + runnable prototypes (AI Life Concierge, Flow game) | `concepts/` |
| Promo | Marketing film assets and pages | `promo/`, `splashes/` |

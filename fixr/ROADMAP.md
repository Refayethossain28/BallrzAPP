# What would make Fixr incredible — analysis & roadmap

An honest gap analysis of the live product, ranked by (impact on the operator's
"wow" × buildability × how directly it serves the payments-led business model).

## The thesis

Fixr's pitch is "the operating system for luxury ground transport." Two things
separate an *operating system* from a *booking tool*:

1. **It remembers.** Luxury is recognition — the operator's edge over Uber is
   knowing Mr. Alvarez wants the Escalade, still water, no small talk. If the
   software doesn't carry that memory, it's a dispatch board, not an OS.
2. **It's alive.** A driver taps "complete" and the dispatcher's board should
   move *by itself*, instantly — not after a refresh. Live software feels
   trustworthy; stale software feels like the spreadsheet it replaced.

## Tier 1 — shipped in this release

| # | Feature | Why it matters |
|---|---------|----------------|
| 1 | **Client memory (CRM)** — every booking auto-creates/matches a client profile: trip count, total spend, preference notes. The AI intake recognizes repeat clients and shows their preferences at parse time. | The single most "luxury" feature possible. "★ 4th trip · prefers S-Class, still water" at booking time is the demo moment that sells operators. Also the moat: this data accrues and can't be exported to a rival easily. |
| 2 | **Real-time everything (SSE)** — one event stream; the dispatch board, driver app, and passenger tracking all update live on every change. | Turns three static pages into one living system. Demo impact is enormous: complete a trip on the driver phone, watch the board and the passenger screen move on their own. |
| 3 | **AI-drafted client messages** — one tap drafts a polished confirmation text for the client (Claude when keyed, template fallback), ready to copy-send. | Extends "AI copilot" past intake into the whole client conversation. Saves the dispatcher the most repetitive writing they do. |
| 4 | **Today dashboard** — live strip: trips, booked revenue, captured, driver payouts, platform fees. | Operators run on numbers; owners open the app in the morning to see the day. Also quietly showcases the take-rate (the business model) on every screen. |
| 5 | **Demo day** — one tap seeds a realistic day (known clients with preferences, trips across every stage, a settled payment) when the board is empty. | An empty board kills demos. This makes every first impression look like a running business. |
| 6 | **Live driver-location freshness** on passenger tracking ("updated 8s ago"). | Makes the GPS we already collect visible and reassuring. |

## Tier 2 — SHIPPED (same keyed-or-mock pattern as the rest of the app)

- **Client SMS notifications** — confirmed / en-route / complete / concierge-fee
  texts. Real Twilio when `TWILIO_*` is set; otherwise composed + shown in the
  console's notifications feed. Phone numbers captured from the passenger app
  and from the AI intake.
- **Operator auth (env-gated)** — set `OPERATOR_KEY` and the console + operator
  APIs lock behind a sign-in; drivers advance trips through driver-scoped
  endpoints (authorized by assignment). Unset = frictionless open demo.
- **Live driver map** — Leaflet map of driver GPS on the console, updating over
  SSE, with a text fallback when the map CDN is unreachable.
- **Preference-aware AI intake** — a known client's saved vehicle preference is
  auto-applied when the message doesn't specify one ("auto from prefs").
- **Vendor rolodex** — the operator's black book (dining, aviation, tickets)
  with categories/contacts/notes; seeded in the demo day.
- **AI owner digest** — one tap writes the day's business summary (Claude when
  keyed, template fallback), ready to copy into an email.

## Tier 2 — remaining (needs a decision or a secret)

- **Per-driver logins / sessions** — `?d=` links become real accounts the day a
  second real operator onboards (OPERATOR_KEY covers the console today).
- **Real distance-based quoting** (Google/Mapbox distance matrix) instead of the
  fixed-mileage stand-in — needs a maps key; the rate engine already isolates this.
- **Native driver app** (Expo wrapper) for background GPS — path in DRIVER-APP.md.

## Tier 3 — the compounding bets

- **Affiliate farm-out**: pass a trip to a partner operator with one tap (the
  industry's unsolved interop pain — a network-effect feature; needs a second
  operator on Fixr to mean anything).
- **Digest by email on a schedule** — the digest exists; add an email provider
  key + a weekly cron to deliver it.

## What we deliberately did NOT do

- No *forced* auth — `OPERATOR_KEY` locks the console when set, but the default
  stays a frictionless open demo; per-driver accounts wait for the second operator.
- No native app yet (PWA covers the demo; background GPS is the only gap).
- No speculative microservices/queues — one server, one DB, until volume says otherwise.

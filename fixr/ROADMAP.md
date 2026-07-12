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

## Tier 2 — next (needs a decision or a secret)

- **Real SMS** (Twilio): the drafted messages send themselves; passengers get
  "driver en route" texts. Needs a Twilio key — wire-up is trivial once present.
- **Operator/driver auth**: replace `?d=` links with real sign-in the day a
  second real operator onboards. (Deliberately skipped now — friction kills demos.)
- **Live map** of drivers (Leaflet + OSM tiles) on the console.
- **Real distance-based quoting** (Google/Mapbox distance matrix) instead of the
  fixed-mileage stand-in — needs a maps key; the rate engine already isolates this.
- **Native driver app** (Expo wrapper) for background GPS — path in DRIVER-APP.md.

## Tier 3 — the compounding bets

- **Preference-aware AI**: feed the client profile into intake so the AI
  auto-selects the right vehicle for known clients and flags conflicts.
- **Affiliate farm-out**: pass a trip to a partner operator with one tap (the
  industry's unsolved interop pain — a network-effect feature).
- **Vendor rolodex for concierge**: preferred restaurants/venues with contact
  notes, feeding the same memory system as client preferences.
- **Weekly owner email**: AI-written digest of the week's numbers and notable
  clients — retention feature; keeps Fixr in the owner's inbox.

## What we deliberately did NOT do

- No auth yet (kills demo friction; Tier 2 trigger is the second real operator).
- No native app yet (PWA covers the demo; background GPS is the only gap).
- No speculative microservices/queues — one server, one DB, until volume says otherwise.

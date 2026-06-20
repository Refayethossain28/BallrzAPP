# Vantage — Luxury Ground-Transport & Concierge OS

> One request engine. Chauffeur dispatch is the wedge; concierge is the expansion.
> Workflow-owning, payments-monetized, AI-copilot (human owns the outcome).

This folder has both the **founder docs** and two runnable builds of the same
core loop:

```
inbound (call/text/email) → AI parse → instant quote → dispatch → execute → settle → audit log
```

- **`app/`** — the **real full-stack app**: Express + persistent SQLite + REST API +
  real Claude intake (`claude-opus-4-8` structured output) + Stripe capture +
  an operator console wired to it. `cd app && npm install && npm start`. Runs with
  no secrets (heuristic + mock fallbacks); set keys for the real services. See `app/README.md`.
- **`index.html`** — the original **zero-dependency prototype** (open in a browser,
  no build) for quick demos and to fix the data model.
- **Go-to-market / how to land first operators:** `GTM.md`
- **Unit economics / 12-month model:** `MODEL.md`

---

## The one architectural decision that matters

Everything is a polymorphic **`Request`** with a `type`. A ride is
`type:'transfer'`; a dinner reservation is `type:'concierge'`. Same CRM, same
vendor/driver network, same SLA + audit + billing engine. **This is what lets
concierge bolt on in Phase 3 with no rewrite** — build it on day one even though
Phase 1 only ships `transfer | hourly | airport`.

Equally: the fulfiller is a **`Resource`**, not a "Driver." A driver today; a
restaurant/vendor/concierge tomorrow.

## Data model (production)

```
Client
  id, name, tier, preferences(jsonb), vendor_notes,
  stripe_customer_id, created_at

Request                       -- the universal primitive
  id, client_id, type, status, source,
  raw_inbound_text, parsed_payload(jsonb),
  sla_due_at, priority, quote_amount, quoted_at,
  assigned_resource_id, audit_log(jsonb[]), created_at
  -- status: draft→quoted→confirmed→assigned→in_progress→completed→billed

TransferDetails (1:1 transfer/airport/hourly)
  pickup, dropoff, stops[], pickup_at, flight_number,
  flight_status, pax_count, vehicle_class, hours

Resource                      -- driver now; vendor/concierge later
  id, type, name, phone, vehicle, status, current_location

RateRule
  id, type, base, per_mile, per_hour, airport_fee,
  surge_window, vehicle_class_multiplier

Payment
  id, request_id, stripe_payment_intent, amount, status, payout_id
```

## Phase plan

| Phase | Ships | Monetization |
|------|-------|--------------|
| **1** | AI intake → quote → dispatch board → driver app → audit log | flat $/mo, no rake |
| **1.5** | Stripe **Connect** driver settlement; flight tracking; client SMS | **payments take-rate** (the real business) |
| **2** | Affiliate/farm-out, corporate billing, reporting | usage |
| **3** | Concierge request types (`dining`,`jet`,`tickets`,`yacht`), vendor rolodex, AI copilot | premium seat tier |

## What's a copilot, not an autopilot

AI parses `raw_inbound_text → parsed_payload`, flags low-confidence fields, and
drafts the confirmation — but **never auto-dispatches**. The human taps confirm.
In Phase 3 the same discipline (AI drafts itineraries / recalls vendors / auto-logs;
human owns discretion) is what makes concierge trustworthy for HNW clients.

## Production stack (when you build for real)

- **Operator console:** Next.js (the prototype's UI maps 1:1 to React components)
- **Driver app:** React Native / Expo — you need native background GPS + flight-delay
  ETA; the hardest real engineering, budget time here
- **DB/auth/realtime:** Postgres + Supabase (the `jsonb` columns above, realtime dispatch board, RLS)
- **Payments:** Stripe — Payment Intents (P1), **Connect** payouts (P1.5). Processor-agnostic by design
- **AI intake:** one structured-output LLM call per inbound message (replace the
  heuristic parser in `index.html`). Pull current model + pricing at build time
- **Comms:** Twilio (inbound SMS/voice→transcript, outbound notifications) + a flight API (FlightAware/AviationStack)

## Prototype ≠ production

The "AI" in `index.html` is a deterministic heuristic parser standing in for the
LLM call, so the demo works with zero dependencies. State is in-memory (refresh = reset).
No real payments, GPS, or messaging. It exists to **sell the workflow** and to fix
the data model before any real code is written.

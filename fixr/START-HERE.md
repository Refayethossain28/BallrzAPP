# Fixr — start here

**The operating system for luxury ground transport (with concierge built into the
data model).** Chauffeur dispatch is the wedge; concierge is the expansion. Workflow-
owning, payments-monetized, AI-copilot.

This folder is the finished product: founder docs + a working full-stack app.

## Run it in 60 seconds

```bash
cd fixr/app
npm install
npm start            # → http://localhost:3000   (operator console)
```

Three surfaces, one server + API:
- **Dispatch console (operator):** http://localhost:3000
- **Driver app:** http://localhost:3000/driver/?d=d1  (try d1 / d2 / d3)
- **Client app (passenger):** http://localhost:3000/client/  (book a ride OR a concierge request, track it)

It runs fully with **no API keys** (heuristic intake, mock payments, mock flight
status, SQLite). Add keys to go live — see `app/.env.example`.

```bash
npm test             # 20-check end-to-end suite (runs without secrets)
```

## What's in the box

| | |
|---|---|
| **Operator dispatch console** | AI intake → instant quote → dispatch board → lifecycle → audit log |
| **Driver app (PWA)** | assigned trips, live GPS, trip lifecycle, flight status, navigate, payouts |
| **Real AI intake** | `claude-opus-4-8` structured output (heuristic fallback) |
| **Payments** | Stripe capture **+ Connect driver settlement** (mock fallback) |
| **Connect onboarding** | drivers self-onboard for payouts (mock fallback) |
| **Flight tracking** | AviationStack live status (mock fallback) |
| **Database** | SQLite by default; Postgres when `DATABASE_URL` is set |

## The files

```
fixr/
  START-HERE.md     ← you are here
  README.md         product overview + phase plan + data model
  GTM.md            how a solo founder lands the first 10 operators
  MODEL.md          payments-led 12-month economics, stress-tested
  index.html        zero-dependency prototype (open in a browser)
  app/              the real full-stack app  (app/README.md for details)
    DEPLOY.md       one-click deploy (Render / Railway / Docker) + Postgres
    DRIVER-APP.md   driver PWA + native/background-GPS upgrade path
```

## Go live (public URL)

`app/DEPLOY.md` has one-click instructions. Shortest path: push to GitHub → Render
→ New → Blueprint (reads `app/render.yaml`) → you get a `https://…onrender.com` URL.
Add a managed Postgres and set `DATABASE_URL` for multi-instance scale.

## Turn on the real services

Set these (any subset) in the host's env or a local `.env` (`app/.env.example`):

| Env var | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | real Claude intake |
| `STRIPE_SECRET_KEY` (`sk_test_…`) | real fare capture + Connect transfers |
| `FLIGHT_API_KEY` | real AviationStack flight tracking |
| `DATABASE_URL` | Postgres instead of SQLite |

`GET /api/health` reports which mode each is in.

## Status

Phase 1 + 1.5 complete and tested (17 checks, SQLite **and** Postgres). Remaining
roadmap: native driver app for background GPS (path in `DRIVER-APP.md`), affiliate
farm-out, and the concierge request types (Phase 3 — already a `type`, not a rewrite).

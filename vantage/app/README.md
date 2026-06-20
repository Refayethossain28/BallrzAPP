# Vantage — the real app

A working full-stack application (not the prototype). Persistent database, REST
API, real AI intake, real/mocked payment capture, and the operator console wired
to it.

```
vantage/app/
  server.js        Express API + static host
  db.js            node:sqlite persistence (polymorphic `requests` table)
  parse.js         AI intake: Claude structured output + heuristic fallback
  quote.js         rate engine (pure functions)
  payments.js      Stripe capture + Connect driver settlement (+ mock fallback)
  flight.js        flight tracking: AviationStack + mock fallback
  test.js          end-to-end lifecycle smoke test (13 checks)
  public/          operator console (index.html + app.js + styles.css)
  Dockerfile, render.yaml, DEPLOY.md   one-click / container deploy
```

## Run it

```bash
cd vantage/app
npm install
npm start            # → http://localhost:3000
```

Open the URL: paste a client message (or click a sample), parse it into a quoted
booking, then drive it across the dispatch board to completion + payment.

```bash
npm test             # boots the server and runs the full lifecycle (no secrets needed)
```

## Demo mode vs. real services

The app runs fully **with no secrets** — AI intake falls back to a deterministic
heuristic parser and payments are mocked, so the whole lifecycle works in CI/demos.
Flip on the real services by setting env vars (see `.env.example`):

| Env var | Off (default) | On |
|---|---|---|
| `ANTHROPIC_API_KEY` | heuristic parser | **real Claude** intake (`claude-opus-4-8`, structured JSON output) |
| `STRIPE_SECRET_KEY` | mock capture + split | **real Stripe** PaymentIntent + Connect transfer (use `sk_test_...`) |
| `FLIGHT_API_KEY` | mock flight status | **real AviationStack** flight tracking |

`GET /api/health` reports which mode each is in; the console header shows it too.

## Driver settlement (Stripe Connect)

On trip completion the fare is captured **and** the driver's cut is settled. The
split (`payments.js`): 70% driver share, ~0.5% Vantage platform fee, remainder is
operator net. With `STRIPE_SECRET_KEY` set and a driver onboarded to Connect
(`resources.stripe_account_id`), the driver share moves as a real Connect transfer;
otherwise it's computed and recorded so the lifecycle and audit trail are complete.
This take-rate is the business model — see `../MODEL.md`.

## Flight tracking

Airport requests show live flight status. The console fetches `/api/flight/:number`
when you open an airport request; delays auto-adjust the pickup note. Real lookups
via AviationStack when `FLIGHT_API_KEY` is set, deterministic mock otherwise.

## Deploy

See `DEPLOY.md` — one-click on Render (`render.yaml`), Railway, or any container
host (`Dockerfile`). Runs in demo mode with no secrets.

## The AI intake (real Claude)

`parse.js` sends one `messages.create` call on `claude-opus-4-8` with
`output_config.format` + a strict `json_schema`, so the model returns a booking
that exactly matches the schema (type, client, route, flight, vehicle, pax…).
Adaptive thinking is on. If the key is missing or the call fails, it falls back to
the heuristic parser — intake never hard-fails.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | mode (intake/payments) |
| POST | `/api/parse` | free text → structured booking + quote (no write) |
| POST | `/api/requests` | confirm a parsed booking onto the board |
| GET | `/api/requests` | list all requests |
| GET | `/api/resources` | list drivers |
| POST | `/api/requests/:id/confirm` | quoted → confirmed |
| POST | `/api/requests/:id/assign` | assign driver → assigned |
| POST | `/api/requests/:id/enroute` | assigned → in_progress |
| POST | `/api/requests/:id/complete` | complete + capture payment |

## Phase 1.5 — the actual business

`payments.js` captures the fare today. The monetization step is **Stripe Connect
driver settlement**: split each completed fare, route the driver's cut, keep the
platform fee. That take-rate (modeled in `../MODEL.md`) is what turns this from a
flat-fee tool into a payments business.

## Deploy

It's a standard Node server — deploy to Render / Railway / Fly / a VM. Set the env
vars, run `npm start`. The SQLite file persists on disk; for multi-instance scale,
swap `db.js` for Postgres (the schema maps directly).

> The polymorphic `requests` table means concierge (Phase 3) is a new `type`, not a
> rewrite — exactly as in the top-level `../README.md` plan.

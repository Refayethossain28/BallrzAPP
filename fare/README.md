# Fare — chauffeur job logging & invoicing

Log a job from your phone in under 30 seconds, generate a clean monthly PDF
invoice per client in one tap — then let Fare email it and chase the payment.
v2 is a **multi-tenant SaaS**: drivers sign in with a magic link, get a
30-day free trial, and subscribe for £9.99/month via Stripe.

**Stack: zero dependencies.** Node 22+ only — `node:http` for the server,
`node:sqlite` for storage, a pure business-rules engine
(`public/engine.js`) shared by the browser and the server, a hand-written
PDF generator (`pdf.mjs`), and plain-fetch integrations for Resend
(`email.mjs`) and Stripe (`stripe.mjs`). Nothing to `npm install`.

## Run it

```sh
node fare/server.mjs          # → http://localhost:8797
```

With no env vars set it runs in **dev mode**: magic sign-in links print to
the console (and surface in the UI), emails log instead of sending, and
billing is off so every account has full access.

## What's inside

| Piece | Job |
| --- | --- |
| `public/engine.js` | Every rule: pence-integer money, pro-rata per-minute waiting, extras, remembered routes, sequential invoice numbers, VAT, due dates, sent/paid/overdue, **trial/subscription gating and chase planning**. Pure + clock-injected → fully unit-tested. |
| `db.mjs` | Multi-tenant SQLite: every row scoped by `account_id`; invoicing is one transaction; **a v1 single-user database migrates itself in place on first boot** (legacy data becomes account 1, claimed by the owner's first sign-in). |
| `auth.mjs` | Passwordless magic links + sessions. Only SHA-256 hashes are stored; links are single-use, 15-minute; sessions last 90 days; sign-in emails rate-limited. |
| `email.mjs` | Resend over HTTPS: sign-in links, invoices (PDF attached), payment reminders. Reply-to is the driver. |
| `chase.mjs` | Hourly loop: engine's `chasePlan` decides, this sends + logs. Reminders stop at paid, the per-account cap, or a per-client opt-out. |
| `stripe.mjs` | Checkout, customer portal, and a hand-verified webhook (HMAC). Expired trial / failed payment → **read-only**, never locked out: drivers always keep and can export their data. |
| `pdf.mjs` / `server.mjs` / `public/app.js` | As v1: the invoice PDF, the thin scoped API, the chips-first phone UI — now with sign-in, account/billing settings, "Email invoice", and chasing controls. `public/landing.html` is the marketing page. |

## Configuration (all optional; features light up as keys appear)

| Env | Effect |
| --- | --- |
| `FARE_DB_PATH` | SQLite file (default `fare/data/fare.db`) — point at a persistent disk in production. |
| `FARE_APP_URL` | Public URL used in emailed links and Stripe redirects. |
| `FARE_KEY` | Owner API key → account 1 (keeps v1 phones and curl backups working). |
| `RESEND_API_KEY`, `FARE_EMAIL_FROM` | Real email. Verify a sending domain at resend.com (SPF/DKIM DNS records) or invoices land in spam. |
| `STRIPE_SECRET_KEY` | Turns billing on: 30-day trials enforce, subscribe = £9.99/mo. |
| `STRIPE_PRICE_ID` | Optional; if unset a "Fare" £9.99/mo GBP price is created once and reused. |
| `STRIPE_WEBHOOK_SECRET` | For `POST /api/billing/webhook` (add the endpoint in the Stripe dashboard: events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`). |

The repo's `render.yaml` blueprint pre-wires all of these for the `fare`
service (secrets left blank to fill in the dashboard).

## Going live checklist

1. Deploy (blueprint) → the v1 database upgrades itself on first boot.
2. Sign in with your own email — that first sign-in **claims the legacy
   account** with all your existing data.
3. resend.com: create key, verify your domain, set `RESEND_API_KEY` +
   `FARE_EMAIL_FROM` → invoice emailing + chasing go live.
4. stripe.com: set `STRIPE_SECRET_KEY`, add the webhook endpoint
   (`/api/billing/webhook`) and set `STRIPE_WEBHOOK_SECRET` → trials and
   subscriptions enforce.
5. Point prospects at `/landing.html`.

## Data & backups

`Settings → Download backup` exports one account's world as JSON; restore
with `POST /api/restore` (ids are remapped, so it lands cleanly anywhere).
Read-only accounts can still export — drivers are never locked out of
their own data.

## Tests

```sh
npm run test:fare     # engine + store (incl. v1→v2 migration) + auth + stripe + PDF
npm run test:smoke    # repo-wide inline-script sanity
```

# Fare — chauffeur job logging & invoicing

A single-driver web app: log a job from your phone in under 30 seconds, then
generate a clean monthly PDF invoice per client in one tap. v1 is
single-user (no login); the code is structured so v2 can add accounts,
automated email sending and payment chasing without a rewrite.

**Stack: zero dependencies.** Node 22+ only — `node:http` for the server,
`node:sqlite` for storage, a pure business-rules engine
(`public/engine.js`) shared by the browser and the server, and a
hand-written PDF generator (`pdf.mjs`). Nothing to `npm install`.

## Run it

```sh
node fare/server.mjs          # → http://localhost:8797
```

Open it on your phone and “Add to Home Screen” — it installs as an app
(offline shell included; data always live from the server).

First-run order: **Settings** (business details, bank details, invoice
prefix, VAT on/off, default waiting rate) → **Clients** → start logging jobs.

## What's inside

| Piece | Job |
| --- | --- |
| `public/engine.js` | Every rule: pence-integer money, pro-rata per-minute waiting time, extras (parking / airport / ULEZ / tolls / other), remembered routes per client, sequential invoice numbers, VAT, due dates, sent/paid/overdue. Pure + clock-injected → fully unit-tested. |
| `db.mjs` | SQLite schema + queries. Invoicing is one transaction: insert invoice, claim jobs, bump the counter — numbers can never double-issue. Voiding releases jobs but retires the number (gaps are honest). |
| `pdf.mjs` | The invoice PDF: itemised jobs with waiting + extras, optional VAT row, bank-details footer, optional JPEG logo, multi-page. |
| `server.mjs` | Thin JSON API + static host. All validation goes through the engine. |
| `public/app.js` | The phone UI. Job entry is chips-first: tap client → tap a remembered route (fills pickup, drop-off, fare, rate, usual extras) → adjust → save. |

## Data & backups

- DB file: `fare/data/fare.db` by default; set `FARE_DB_PATH` to move it
  (point it at a persistent disk in production).
- **Settings → Download backup** exports everything as one JSON file.
  Restore into a fresh server with:
  `curl -X POST --data-binary @fare-backup-….json localhost:8797/api/restore -H 'content-type: application/json'`

## Putting it on the internet

Any Node 22+ host works. Two things matter:

1. **Persistent disk.** Free tiers (e.g. Render free) wipe the filesystem on
   every deploy/restart — use a paid instance with a mounted disk (~£5/mo) and
   set `FARE_DB_PATH` to it. Until then, download backups regularly.
2. **Set `FARE_KEY`.** Any long random string. With it set, every API call
   must present the key — the app prompts once and remembers it. Without it,
   your client list and bank details are readable by anyone with the URL.

Example (Render): web service, `startCommand: node fare/server.mjs`,
`NODE_VERSION=22.12.0`+, disk mounted at `/data`, `FARE_DB_PATH=/data/fare.db`,
`FARE_KEY=<random>`.

## v2 seams (deliberate)

- Invoices are **frozen snapshots** — emailing them later can't be skewed by
  edits made after the fact.
- Status is stored (`sent`/`paid`) + derived (`overdue` from the clock) —
  exactly what an automated payment-chaser needs to read.
- The HTTP API is the single door: auth/multi-tenant lands in `server.mjs`
  without touching engine, PDF or UI logic.
- Email sending will be a new module that takes an invoice id → PDF buffer
  (already available server-side) + client email (already stored).

## Tests

```sh
npm run test:fare     # engine + store + PDF unit tests
npm run test:smoke    # repo-wide inline-script sanity
```

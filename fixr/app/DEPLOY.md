# Deploying Fixr to a public URL

The app is a standard Node 22 server, so any host works. It runs in **demo mode**
with no env vars (heuristic intake, mock payments, mock flight status); set keys
to turn on the real services. Three good options, easiest first.

## Option A — Render (one-click blueprint) ★ recommended

The blueprint lives at the **repo root** (`render.yaml`) and provisions a web
service **plus a managed Postgres**, wiring `DATABASE_URL` automatically — so it
deploys production-shaped, not on a throwaway SQLite file.

1. Push to GitHub (done — branch `claude/most-needed-app-rxhbcj`).
2. **dashboard.render.com → New → Blueprint**, pick this repo, and **choose the
   branch** `claude/most-needed-app-rxhbcj` (the root `render.yaml` lives there).
3. Render reads `render.yaml`, creates the `fixr-db` Postgres + the `fixr` web
   service, builds `fixr/app`, and gives you a URL like `https://fixr.onrender.com`.
4. (Optional) In the **fixr** service → **Environment** tab, add secrets to go fully
   live: `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY` (`sk_test_…`), `FLIGHT_API_KEY`.

No disk needed — Postgres handles persistence and multi-instance. (Render's free
Postgres is fine for a design-partner demo; upgrade the DB plan for production.)

> Once this branch is merged to your default branch, a **Deploy to Render** button
> also works: `https://render.com/deploy?repo=https://github.com/Refayethossain28/BallrzAPP`

## Option B — Railway

1. **railway.app → New Project → Deploy from GitHub**, pick this repo.
2. Set **Root Directory** to `fixr/app`. Railway auto-detects Node and runs
   `npm install` / `npm start`.
3. Add the same optional env vars under **Variables**. Add a volume mounted at
   `/data` and set `FIXR_DB=/data/fixr.db` for persistence.

## Option C — Any container host (Fly.io, Cloud Run, a VM)

A `Dockerfile` is included.

```bash
cd fixr/app
docker build -t fixr .
docker run -p 3000:3000 -v fixr-data:/data \
  -e ANTHROPIC_API_KEY=… -e STRIPE_SECRET_KEY=… fixr
# → http://localhost:3000
```

For **Fly.io**: `fly launch --dockerfile Dockerfile` (say yes to a volume), then
`fly deploy`. For **Cloud Run**: `gcloud run deploy --source .` (note: Cloud Run's
filesystem is ephemeral — point `FIXR_DB` at a mounted volume or move to Postgres).

## Scaling to Postgres (multi-instance)

SQLite is one file on one disk — perfect for a single instance. To run multiple
instances behind a load balancer, point at managed Postgres instead: provision one
(Render/Railway/Neon/Supabase all have a free tier) and set `DATABASE_URL`. No code
change — `db.js` switches backends automatically, and the schema is created on boot.
On Render, add a PostgreSQL instance and set its Internal Database URL as
`DATABASE_URL` on the web service.

## Notes

- **Node version:** requires Node ≥ 22.5 (built-in `node:sqlite`). The configs pin it.
- **Persistence:** the Render blueprint uses Postgres (no disk). For the Docker /
  Fly path, either mount a volume for SQLite or set `DATABASE_URL` to use Postgres.
- **Health check:** `GET /api/health` returns `{ ok, db, intake, payments, flight }`.
- **Cost:** all three have free tiers sufficient for a design-partner demo.

## What I can't do from here

This environment has no hosting credentials and restricted network egress, so I
can't run the deploy for you — but the configs above make it a few clicks. If you
create the Render/Railway project and paste me the build log, I'll debug any
failure.

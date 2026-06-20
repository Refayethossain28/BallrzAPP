# Deploying Vantage to a public URL

The app is a standard Node 22 server, so any host works. It runs in **demo mode**
with no env vars (heuristic intake, mock payments, mock flight status); set keys
to turn on the real services. Three good options, easiest first.

## Option A — Render (one-click blueprint) ★ recommended

`render.yaml` is already in this folder.

1. Push this branch to GitHub (done).
2. Go to **dashboard.render.com → New → Blueprint**, pick this repo/branch.
3. Render reads `render.yaml`, builds `vantage/app`, and gives you a URL like
   `https://vantage.onrender.com`.
4. (Optional) In the service's **Environment** tab, add secrets to go live:
   `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY` (use `sk_test_…`), `FLIGHT_API_KEY`.

The blueprint attaches a 1 GB disk at `/data` so the SQLite DB survives deploys.

## Option B — Railway

1. **railway.app → New Project → Deploy from GitHub**, pick this repo.
2. Set **Root Directory** to `vantage/app`. Railway auto-detects Node and runs
   `npm install` / `npm start`.
3. Add the same optional env vars under **Variables**. Add a volume mounted at
   `/data` and set `VANTAGE_DB=/data/vantage.db` for persistence.

## Option C — Any container host (Fly.io, Cloud Run, a VM)

A `Dockerfile` is included.

```bash
cd vantage/app
docker build -t vantage .
docker run -p 3000:3000 -v vantage-data:/data \
  -e ANTHROPIC_API_KEY=… -e STRIPE_SECRET_KEY=… vantage
# → http://localhost:3000
```

For **Fly.io**: `fly launch --dockerfile Dockerfile` (say yes to a volume), then
`fly deploy`. For **Cloud Run**: `gcloud run deploy --source .` (note: Cloud Run's
filesystem is ephemeral — point `VANTAGE_DB` at a mounted volume or move to Postgres).

## Notes

- **Node version:** requires Node ≥ 22.5 (built-in `node:sqlite`). The configs pin it.
- **Persistence:** SQLite is a file. On hosts with ephemeral disks, attach a volume
  (the Render/Docker configs here do) or swap `db.js` for Postgres — the schema maps
  directly.
- **Health check:** `GET /api/health` returns `{ ok, intake, payments, flight }`.
- **Cost:** all three have free tiers sufficient for a design-partner demo.

## What I can't do from here

This environment has no hosting credentials and restricted network egress, so I
can't run the deploy for you — but the configs above make it a few clicks. If you
create the Render/Railway project and paste me the build log, I'll debug any
failure.

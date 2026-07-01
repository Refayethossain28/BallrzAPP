# Atlas — LAN Node Registry & Scheduler (MVP)

> **Goal:** a local LAN node registry and scheduler that lets **Hermes** route
> work to the best available machine.

Atlas keeps a live picture of every machine on your network and, when a task
comes in, picks a healthy machine that can actually do the job and dispatches
the work to it. This is the **MVP**, and it follows one rule from the spec:

> **Do not make it smart yet. Make it visible and reliable first.**

So the scheduler is intentionally plain and *explainable* — capability match,
then health, then lowest load — not a clever cost model. Every decision (and
every refusal) comes with a human-readable reason.

## The pieces

```
   ┌────────────┐  heartbeat (POST /register)   ┌──────────────────────┐
   │ Node Agent │ ────────────────────────────► │   Central Registry   │
   │ (each box) │      hostname, IP, CPU,        │   + Scheduler        │
   └────────────┘      RAM, GPU, VRAM,           │   (registry.mjs)     │
                       services, capabilities,    │                      │
                       load, health               │  in-memory state,    │
                                                   │  stale-node sweeper, │
   ┌────────────┐  task (POST /schedule)          │  dashboard at /      │
   │   Hermes   │ ────────────────────────────►  │                      │
   │            │ ◄──────────────────────────── │                      │
   └────────────┘  result (via Ray adapter)       └──────────┬───────────┘
                                                              │ dispatch()
                                                     ┌────────▼────────┐
                                                     │  Ray adapter    │
                                                     │ (ray-adapter.mjs│
                                                     │  — stub in MVP) │
                                                     └─────────────────┘
```

| File | Role |
|------|------|
| [`core.mjs`](./core.mjs) | **Pure, deterministic decisions** — normalise reports, node health/staleness, capability match, node selection. Unit-tested; no clocks or sockets. |
| [`registry.mjs`](./registry.mjs) | Central Registry **+ Scheduler** HTTP server. Stores node state, serves the dashboard, accepts heartbeats, routes `/schedule` requests. |
| [`agent.mjs`](./agent.mjs) | Node Agent that reports a box's specs, load and health on an interval. |
| [`ray-adapter.mjs`](./ray-adapter.mjs) | Where execution is handed to **Ray**. **Stubbed** in the MVP — selection is real, execution is simulated. |
| [`dashboard.html`](./dashboard.html) | The "visible" part — live fleet view served at `/`. |

The end-to-end path matches the spec: **Node Agent reports → Registry stores →
Scheduler receives a task → selects best node by required capabilities →
execution sent through Ray → result returns to Hermes.**

## Run it

Zero dependencies — Node 18+ only.

```sh
# 1. Start the registry + scheduler (also serves the dashboard)
node atlas/registry.mjs                 # http://localhost:8795

# 2. Start an agent on each machine (declare what the box can do)
ATLAS_CAPS="ocr,vision,local_llm" ATLAS_SERVICES="postgres,qdrant" \
ATLAS_GPU="RTX 4090" ATLAS_VRAM_MB=24576 \
ATLAS_REGISTRY=http://<registry-host>:8795 node atlas/agent.mjs

# 3. Open the dashboard
open http://localhost:8795
```

Or via npm scripts: `npm run atlas:registry` and `npm run atlas:agent`.

### Ask the scheduler for a machine (what Hermes does)

```sh
curl -X POST http://localhost:8795/schedule \
  -H 'content-type: application/json' \
  -d '{"capabilities":["ocr","vision"],"task":{"name":"scan-receipt"}}'
```

```jsonc
{
  "ok": true,
  "scheduled": true,
  "node": { "id": "gpu-02", "hostname": "gpu-02", "ip": "10.0.0.11" },
  "reason": "matched [ocr, vision], lowest load (0.1)",
  "candidates": ["gpu-02", "gpu-01"],
  "result": { "ok": true, "engine": "ray-stub", "ranOn": { "...": "..." } }
}
```

If nothing can run it, you get a **503 with the reason** instead of a silent
failure — e.g. `"no healthy node has all required capabilities [whisper]"`.

## HTTP API

| Method & path | Purpose |
|---------------|---------|
| `GET /` | Live dashboard. |
| `GET /healthz` | Registry liveness. |
| `GET /api/nodes` | Full fleet state + a status/capability summary (used by the dashboard and by Hermes to inspect the fleet). |
| `POST /register` | Node Agent heartbeat / registration. Body = a node report. |
| `POST /schedule` | Task request → node selection → Ray dispatch → result. `{ capabilities?: string[], task?: object }`. |

## Node report shape

```jsonc
{
  "hostname": "gpu-01",
  "ip": "10.0.0.10",
  "cpuCores": 16,
  "ramMB": 65536,
  "gpuName": "RTX 4090",
  "vramMB": 24576,
  "services": ["postgres", "qdrant"],
  "capabilities": ["ocr", "embeddings", "local_llm", "vision", "whisper",
                    "postgres", "qdrant", "file_archive", "critique", "alpha_reasoning"],
  "load": 0.7,            // 0..1
  "health": "ok"          // ok | degraded | down
}
```

Hardware facts (CPU/RAM/hostname/IP/load) are measured by the agent from Node's
`os` module. GPU name, VRAM and the capability/service lists are **declared** by
the operator (env vars or an `ATLAS_CONFIG` JSON file), because what a box is
*allowed* to do is a deployment decision, not something to guess.

## Reliability choices (the "reliable first" half)

- **Nodes never vanish silently.** Missed heartbeats flip a node to `stale`
  (and out of scheduling) after `ATLAS_STALE_MS`; a sweeper drops it entirely
  only after it's been gone ~4× that long.
- **Malformed reports still show up.** `normalizeReport` coerces junk to safe
  defaults rather than dropping the node — visible beats invisible.
- **Refusals are explained.** No healthy candidate → a `503` with a reason,
  never a hang or a wrong pick.
- **Conservative routing.** Only `healthy` nodes are scheduled; `degraded`/
  `down` stay visible but idle.
- **Deterministic selection.** Same fleet + same request → same node, so the
  behaviour is reproducible and testable.

## Tests

The decision core is pure and unit-tested (no network needed):

```sh
npm run test:atlas      # or: node scripts/test-atlas-logic.mjs
```

Covered: report normalisation, health/staleness, capability matching, the
selection ordering, and every refusal path. Also runs as part of `npm test`,
and the dashboard is exercised by the repo-wide HTML smoke test.

## Wiring Ray for real

Replace `dispatch()` in [`ray-adapter.mjs`](./ray-adapter.mjs) with a real Ray
submission targeting `node.ip` (e.g. `ray job submit` or the Ray client),
keeping the same return shape. Nothing else has to change — the registry,
scheduler and dashboard are already done.

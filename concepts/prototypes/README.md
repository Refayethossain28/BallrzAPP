# Prototypes

Two **runnable, zero-build** prototypes — one per concept. Each is a single
self-contained HTML file (same pattern as the repo's existing
`trading-app/fx-signal-pro.html`). No install, no server, no API keys.

## How to run

Open either file directly in a browser:

```
concepts/prototypes/flow-game/index.html          # Concept 2
concepts/prototypes/concierge-split/index.html     # Concept 1
```

(Double-click, or `open <file>` on macOS / `xdg-open` on Linux. They also work
served from any static host.)

---

## 1. `flow-game/` — Concept 2, adaptive infinite game

The smallest slice of the [AI Infinite Game](../02-ai-infinite-game.md): a
one-thumb "tap the target" mechanic wired to the real adaptive engine. It makes
the engine's normally-invisible internals visible below the board so you can
watch it work:

- **Offline-generated pool** — `generateLevelPool()` builds 240 parameterized
  levels once, each tagged with a difficulty vector. The hot path only ever
  *selects*; it never generates. (This is the load-bearing cost decision.)
- **On-device skill model** — a single latent skill value updated locally from
  outcomes (logistic / Elo-style), faster learning rate during cold-start.
- **Flow-band selection** — each round picks the pool level whose *predicted*
  win-probability for you is nearest the ~60% flow target, with sampling for
  variety.

The HUD shows your live skill estimate, the served level's difficulty, the
predicted win, and a sparkline of your actual pass-rate converging toward the
flow target.

## 2. `concierge-split/` — Concept 1, split-the-bill agent action

The smallest *viral* slice of the [AI Life Concierge](../01-ai-life-concierge.md):
a group chat where the agent turns a sentence into a settled bill. It enforces
the three architecture rules that matter:

- **Agent proposes, human commits** — the agent posts a *proposal* card; money
  only moves after you tap **Confirm**.
- **Structured result card in-thread** — the split renders natively and is
  visible to the whole group (this visibility is the viral loop).
- **Idempotent execution** — every confirmed split carries an idempotency key;
  re-confirming the same proposal is a guaranteed no-op (no double charge).

> The bill parser is a deterministic stub standing in for the LLM tool-use
> layer. In production `runAgent()` is a Claude tool-use call returning the same
> structured proposal object — everything downstream (confirm → idempotent
> execution → result card) is already real here.

---

## Verification

The pure logic in both files was checked headlessly (`node --check` for syntax,
plus a behavioral simulation):

**Flow game — does a fixed-skill player converge to the ~0.60 flow band?**

| true skill | est. skill | tail win-rate |
|-----------:|-----------:|--------------:|
| 0.20 | 0.16 | **0.57** |
| 0.45 | 0.37 | **0.59** |
| 0.70 | 0.66 | **0.63** |
| 0.90 | 0.84 | 0.79 |

The loop holds the flow band for low/mid/high players. **Known limitation,
caught by the sim:** a near-max-skill player sits at 0.79, not 0.60 — the
offline pool is biased toward easier levels and contains nothing hard enough to
pull a top player back down. This is precisely the doc's "the generator must
span enough difficulty range" failure mode; the production fix is to widen the
pool's hard tail (and let the telemetry feedback loop add difficulty where top
players are under-challenged).

**Split logic:** penny remainder distributes so shares always sum exactly to the
bill (`$138.60 → 4620+4620+4620¢ = 13860¢`); a second confirm of the same split
is skipped via idempotency key; a message with no total leaves the agent silent.

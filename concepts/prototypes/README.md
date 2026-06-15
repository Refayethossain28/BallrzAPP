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

**Retention hooks** (build-order step 4):

- **Daily challenge** — the default mode. Today's date seeds the run, so the
  generated levels are identical for everyone playing today — a reason to come
  back at a set time, and a fair basis for comparing scores.
- **Shareable seed** — *Copy challenge link* puts `?seed=…` on the URL; opening
  that link reproduces the exact same run (same pool, same selection order).
  A lightweight social hook with no server and no social graph.
- **Cosmetic progression** — ring skins unlock at lifetime-best thresholds
  (0 / 25 / 75 / 150), persisted in `localStorage`. They change appearance
  only, never difficulty, so identity investment can't distort the flow-band
  fairness. "Free play" gives an unseeded random run for practice.

**Session controls & modes:**

- **Pause menu** — the ⏸ button (top-right, while playing) freezes the board and
  the round/match timers and opens Resume / Restart / End & main menu.
- **Animated how-to** — the start screen plays a looping demo (tap the glowing
  circle, avoid the red ✕ decoy) so the mechanic reads at a glance.
- **2-Player duel** — local pass-and-play time attack. Both players get a
  30-second turn on the **same seed**; adaptation is off during a match and the
  level sequence is driven purely by the seeded RNG, so each round-end consumes
  an outcome-independent number of RNG draws — both players face a
  pixel-identical sequence of levels. Highest score wins. This reuses the
  engine's seed-determinism rather than adding any netcode.

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

**Two ways to run it:**

- **Open `index.html` directly** → the bill parser runs as an in-page
  deterministic stub. Everything downstream (confirm → idempotent execution →
  result card) is fully real; only the natural-language parse is stubbed.
- **Run the proxy for live Claude tool-use** (build-order: wire `runAgent()` to
  a real model):

  ```
  cd concepts/prototypes/concierge-split
  ANTHROPIC_API_KEY=sk-ant-... node server.mjs     # or: npm start
  # open http://localhost:8787
  ```

  `server.mjs` is a **zero-dependency** Node 18+ proxy (built-in `fetch`/`http`,
  no `npm install`). It calls Claude (`claude-opus-4-8`) with a **forced
  `parse_bill` tool call**, so the model does the natural-language understanding
  (the total + which people are involved) and the **server does the money math
  deterministically** (even split + exact penny distribution + idempotency key).
  That division is the doc's core rule made literal — *the LLM is the router;
  reliable, idempotent tool execution is the product*; the model's arithmetic is
  never trusted with money. The browser auto-detects the proxy and falls back to
  the stub if it's absent, so the file always works. The API key stays
  server-side and never reaches the client.

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

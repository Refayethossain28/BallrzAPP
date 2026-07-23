# App Concepts

Two concrete concepts for an app aiming at global, durable popularity. Each
doc contains a **product spec** (the "what" and "why") and an **architecture
sketch** (the "how"). They are deliberately different bets:

| # | Concept | Bet | Moat | Risk |
|---|---------|-----|------|------|
| 1 | [AI Life Concierge](./01-ai-life-concierge.md) | Messaging is an involuntary daily need; bolt a capable AI agent onto it | The agent layer + privacy stance | Distribution vs. WhatsApp/iMessage incumbents |
| 2 | [AI Infinite Game](./02-ai-infinite-game.md) | Fastest path to scale: zero network, zero trust, infinite content | Personalized generation pipeline | Retention; games churn |

## Why these two

The biggest apps ever (WhatsApp, TikTok, WeChat, Instagram) share three
traits:

1. **A daily, involuntary need** — something you *have* to do, not a hobby you
   remember to open.
2. **Network effects** — it gets better as more of your contacts join, so it
   spreads itself.
3. **Near-zero friction** — works on a cheap phone, on bad internet, with no
   tutorial.

Concept 1 rides an existing involuntary need (messaging) and adds a moat that
only became possible recently (agents that actually *do* things). Concept 2
trades defensibility for raw speed-to-scale — games need no network and no
trust, so they spread fastest, but retain worst.

## Runnable prototypes

Each concept also ships the smallest slice of its build order as a
**zero-build, single-file HTML prototype** you can open in a browser — see
[`prototypes/`](./prototypes/):

- **`prototypes/flow-game/`** — Concept 2's adaptive loop: on-device skill
  model + offline-generated level pool + flow-band difficulty selection, with
  the engine internals surfaced so you can watch it adapt.
- **`prototypes/concierge-split/`** — Concept 1's viral agent action: chat →
  agent proposes split → human confirms → idempotent payment requests as a
  result card.

Both had their core logic verified headlessly (convergence sim + idempotency /
penny-distribution checks); results and one honest limitation are in the
[prototypes README](./prototypes/README.md).

## Native build slice

[`concept-1-concierge/`](./concept-1-concierge/) takes Concept 1 past the web
prototype into a **native iOS slice** (SwiftUI + an SPM kernel): the messaging
thread + split-the-bill action wired through the doc's real boundaries —
`MessageTransport` (the E2EE seam), `AgentService` (LLM behind a protocol), and
an idempotent `SplitLedger`. The kernel is `swift test`-able; the SwiftUI app
opens in Xcode. (Written without a Swift toolchain on hand, so it's a
compile-and-tighten scaffold, not verified code — see its README.)

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

These are **specs, not running code**. See each doc's "Build order" section
for the smallest first slice worth writing.

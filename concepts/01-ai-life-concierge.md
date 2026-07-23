# Concept 1 — AI Life Concierge

> WhatsApp fused with an AI agent that actually *does things*. The core loop is
> messaging (proven, sticky, global); every thread can pull in an agent that
> splits the bill, translates live, books the table, and remembers everything.

---

## Part A — Product Spec

### The need it rides
People message every day whether they want to or not. We do **not** invent a
new behavior — we attach a moat to an existing involuntary one. The agent is
the reason to switch *to us* from the incumbent.

### Core loop
1. You message a person or group (normal chat — fast, encrypted, global).
2. Any thread can `@assistant` or trigger the agent implicitly.
3. The agent takes a real action *inside the chat* and posts the result back so
   everyone in the thread sees it.

### The four killer actions (v1 scope)
These are chosen because each one **pulls in another person**, so usage spreads
on its own:

| Action | Why it spreads |
|--------|----------------|
| **Split the bill** | Sends payment requests to everyone in the group |
| **Live translate** | Two people who don't share a language can text naturally; both must be present |
| **Book it** | Table / appointment / flight from inside the chat; confirmation visible to the group |
| **Remember** | Cross-conversation memory ("what did Sam say the address was?") |

### Why it can win now
- The agent layer is **genuinely useful for the first time** — models are good
  enough to take multi-step real-world actions reliably.
- It collapses ~10 apps into one — the "super-app" pattern that already made
  WeChat dominant in China but that nobody has cracked for the rest of the
  world.

### The honest hard part
Not the tech — **distribution and trust**. WhatsApp won partly by being neutral
and not spying on you. So the winning version is **private by default**:
end-to-end encrypted messaging, and the agent runs on explicit per-action
consent with a visible audit trail. That privacy stance is the wedge against
incumbents who monetize data.

### Success metric
The only number that matters early: **D30 retention of senders** (people who
sent ≥1 message and come back 30 days later). Agent actions per active user is
the leading indicator of the moat working.

### Non-goals (v1)
- No public feed / discovery (that's a different, harder business).
- No payments *processing* — we orchestrate existing rails (the user's bank /
  card / Apple Pay), we don't become a wallet on day one.
- No voice/video calling — table stakes later, distraction now.

---

## Part B — Architecture Sketch

### Shape
```
 ┌────────────┐     E2EE      ┌─────────────────┐
 │  Mobile    │◀────────────▶ │  Messaging core  │  (Signal-protocol style)
 │  client    │   messages    │  fan-out + relay │
 │ (iOS/Andr) │               └────────┬─────────┘
 └─────┬──────┘                        │ encrypted blobs only
       │ agent request (explicit)      │
       │  on-device pre-redaction      ▼
       │                      ┌─────────────────┐
       └────────────────────▶ │  Agent service   │──▶ Tool layer
          consented payload   │  (orchestrator)  │     ├─ Payments (Stripe/Plaid)
                              └────────┬─────────┘     ├─ Translation
                                       │               ├─ Booking (OpenTable/etc APIs)
                                       ▼               └─ Memory store (per-user, encrypted)
                                  LLM (tool-use)
```

### Key design decisions

**1. Messaging core stays dumb and encrypted.** The relay never sees plaintext.
This preserves the privacy wedge and keeps the hardest-to-scale component
simple. Use the Signal protocol (double ratchet) rather than rolling our own.

**2. The agent is opt-in per action, not ambient.** When a user invokes the
agent, the client sends *only the minimum context for that action* — and
redacts on-device first. The relay's E2EE is not broken; the user is
voluntarily handing a slice of the conversation to the agent over a separate
authenticated channel.

**3. Tool layer is the real product.** The LLM is a router; the value is in
reliable, idempotent tool calls. Each tool:
   - is **idempotent** (a retried "book table" must not double-book — use client
     idempotency keys),
   - returns a **structured result card** rendered natively in the chat,
   - requires **explicit confirmation** for anything irreversible (money,
     bookings) — the agent proposes, the human taps to commit.

**4. Memory is per-user and encrypted at rest**, scoped by conversation, with a
user-visible "what the assistant remembers" screen and one-tap forget. Memory
that users can't inspect or delete is the fastest way to lose the trust wedge.

### Tech choices (defaults, not dogma)
- **Clients:** native iOS (SwiftUI) + Android (Kotlin/Compose). The existing
  `BallrzApp` SwiftUI scaffold shows the team already leans Apple-first — start
  iOS, but the messaging protocol must be platform-neutral from day one.
- **Backend:** Elixir/Phoenix for the messaging fan-out (built for millions of
  concurrent persistent connections), or Go if the team prefers. **Not**
  request/response Node for the socket layer.
- **Agent orchestrator:** a stateless service that calls an LLM with tool-use.
  Use the latest, most capable Claude model (e.g. Claude Opus) for the agent —
  reliability of multi-step tool calls is the whole product, so do not
  under-spec the model here. Keep a cheaper model for cheap classification
  (intent detection) to control cost.
- **Datastore:** encrypted per-user memory in Postgres + a vector index for
  recall; transient message relay in a queue, not long-term storage.

### Build order (smallest first slice)
1. **1:1 E2EE messaging** that works on bad networks. No agent yet. If this
   isn't delightful, nothing else matters.
2. **One agent action: split the bill.** It's viral (pulls in the group), the
   value is instantly legible, and it exercises the whole tool/confirm/card
   pipeline.
3. **Live translate.** Second viral action, proves the "agent inside the
   thread" pattern generalizes.
4. Memory + the remaining actions.

### What would kill it
- Agent that's unreliable on real-world actions (double-books, wrong amount) —
  trust evaporates after one bad money event. Idempotency and human-confirm are
  not optional.
- Any perception that we read messages to sell ads. The privacy stance must be
  technically real, not a marketing line.

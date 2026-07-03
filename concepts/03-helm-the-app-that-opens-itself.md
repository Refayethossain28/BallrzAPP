# Concept 3 — Helm: the app that opens itself

> Every app ever made is **reactive**: it sits dead on a grid until you
> remember it, open it, and operate it. The ultimate app inverts that. Helm
> holds your whole context — calendar, messages, tasks, money, travel — and
> continuously decides *what matters right now*, then either does it for you
> or hands you exactly one thing at exactly the right moment. You don't open
> Helm. Helm opens itself.

---

## Part A — Product Spec

### The need it rides
Nobody's real job is "operate 40 apps." The involuntary daily need underneath
all of them is **"don't drop anything"** — don't miss the bill, the reply, the
train, the renewal, the friend's birthday, the thing you said you'd do. Today
a human pays for that with vigilance: checking apps *in case*. Helm sells the
end of vigilance.

This is deliberately the opposite bet from Concept 2 (speed-to-scale, zero
trust). Helm is slow to earn and nearly impossible to leave: its value is
accumulated context, and switching cost grows every day it runs.

### Core loop
1. Helm ingests context you explicitly grant: calendar, email headers,
   messages, tasks, transactions, location patterns.
2. A **salience engine** (Cusp's scoring model, generalized from tasks to
   *life events*) continuously ranks everything competing for your attention.
3. Output is a single feed of **moments** — cards that arrive only when
   acting is timely, each with a one-tap action:
   - *"Your car insurance renews Friday at £112/mo more. Two comparable
     quotes found — switch?"* → tap → done.
   - *"You have 25 free minutes before your 3pm and the reply to Sam is
     4 days old — here's a draft."* → edit → send.
   - *"Train's cancelled; the 8:42 gets you there 6 minutes early. Rebook?"*
4. Anything irreversible (money, bookings, sent messages) is
   **propose-then-confirm**; routine drudgery you've pre-authorized runs
   silently and shows up in a daily digest instead.

### Why it can win now
- Models are finally reliable at multi-step tool use — the execution layer
  (Concept 1's lesson) actually works.
- Phones can run meaningful inference **on-device**, so the layer that reads
  everything never has to leave the phone.
- The prototypes in this repo already prove each organ separately: **Cusp**
  (salience scoring that shows its working), **ApexVIP Concierge** (a real
  request lifecycle with SLAs and money rules), **Ripple** (the delivery
  channel), **Omni** (the tool belt). Helm is the organism.

### The honest hard part
Not intelligence — **the interruption budget.** A proactive app that is wrong
twice gets muted forever, and muted equals dead. So the core product artifact
is attention economics, engineered explicitly:

- A **hard daily interrupt budget** (start at 3). Moments compete for slots;
  losers go to the digest.
- A **calibrated precision bar**: a moment fires only when
  `P(user acts on it) × value` clears a threshold that *rises* every time the
  user dismisses one.
- Every moment answers **"why am I seeing this?"** in one tap — auditable,
  like Cusp's shown working. Black-box nagging is how every assistant before
  this died.

### Success metric
**Acted-on rate per interrupt** (target >60%) is the health metric — it
measures whether Helm respects attention. The growth metric is **weeks of
context retained**: a user with 8+ weeks of accumulated context almost cannot
churn without feeling it.

### Non-goals (v1)
- Not a chatbot. No open-ended prompt box on the home screen; if the user has
  to think of what to ask, Helm has already failed at proactivity.
- No social graph, no feed of other people. One user, their life.
- No ambient always-on microphone/screen recording. Granted sources only —
  trust is the moat, and creepiness is the fastest way to torch it.

---

## Part B — Architecture Sketch

### Shape
```
 ┌─────────────────────────── on device ───────────────────────────┐
 │  Source adapters          Context graph          Salience engine │
 │  (calendar, mail hdrs,──▶ (encrypted, local, ──▶ (deterministic  │
 │   msgs, bank via Plaid,    user-inspectable)      scoring — Cusp  │
 │   location patterns)                              generalized)    │
 └───────────────────────────────┬──────────────────────────────────┘
                                 │ only the winning moment's
                                 │ minimal context, per-action consent
                                 ▼
                        ┌─────────────────┐
                        │  Agent service   │──▶ Tool layer (idempotent):
                        │  (cloud, LLM     │     ├─ rebook / renew / switch
                        │   tool-use)      │     ├─ draft & send messages
                        └────────┬─────────┘     ├─ payments orchestration
                                 ▼               └─ research (quotes, options)
                        result card → Moments feed → confirm / digest
```

### Key design decisions

**1. The context graph never leaves the phone.** Ingestion, storage, and
salience scoring are all on-device. The cloud agent sees only the minimal
slice for one approved action — same consent seam as Concept 1, but here it's
existential: Helm reads *everything*, so "we technically can't see it" is the
only acceptable answer.

**2. Salience is deterministic, not an LLM.** The ranking layer is a pure,
unit-testable scoring engine (importance × urgency-tightness × timing-fit ×
staleness, per Cusp), so behavior is reproducible and the interrupt budget is
enforceable. The LLM is used where LLMs are good — understanding a source
item, drafting an action, executing tools — never as the arbiter of when to
interrupt.

**3. Execution reuses the concierge state machine.** Every moment that acts
runs the ApexVIP lifecycle (`received → sourcing → options → confirmed →
completed`) with idempotency keys and human-confirm on irreversible steps.
One bad money event ends the relationship.

**4. Trust surfaces are product features, not settings.** "What Helm knows"
(inspect/delete any fact), "why this moment fired" (the scoring breakdown),
and "what ran silently" (the digest) ship in v1, not later.

### Tech choices (defaults, not dogma)
- **Client:** native iOS first (EventKit, on-device inference via Core ML,
  notification/Live Activity surfaces are the product). The moments feed is
  the whole UI — one screen.
- **Salience engine:** pure TypeScript/Swift module, ported from
  [`cusp/engine.js`](../cusp/engine.js), deterministic and unit-tested.
- **Agent:** latest most capable Claude model for execution (tool reliability
  *is* the product); a small on-device model for source-item classification
  so raw content stays local.
- **Sources v1:** calendar + email headers (read-only) for cold start — they
  alone power renewals, replies-owed, and schedule moments before any deeper
  grant is asked for.

### Build order (smallest first slice)
1. **Calendar + email-header ingestion → moments feed, zero execution.**
   Prove the interrupt budget and precision bar: does the acted-on rate clear
   60% on read-only nudges alone? If not, nothing downstream matters.
2. **One execution action: reply-owed drafts.** Reversible until sent,
   exercises the full propose→confirm→card pipeline.
3. **One money action: renewal switch** (insurance/subscription) — the first
   "it paid for itself" moment, and the retention story writes itself.
4. Transactions, travel, and the silent-run tier with the daily digest.

### What would kill it
- **Getting muted.** One week of low-precision interrupts and the OS
  notification permission — the only channel Helm has — is gone. The rising
  precision bar and hard budget are not tuning knobs; they are survival.
- **A single creepy moment** ("how did it know that?") without a one-tap
  "here's exactly why, and here's how to delete it" answer.
- **Cold start starvation:** if Helm needs six data grants before it's
  useful, nobody reaches week two. The calendar+email slice must deliver a
  genuinely good moment on day one.

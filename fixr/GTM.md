# Fixr — Go-To-Market (de-risking the distribution problem)

Distribution is what kills solo SaaS, not engineering. Your unfair advantage is
that you already know luxury-transport and concierge operators. This plan turns
that into your first 10 paying operators **before** you over-build.

## The buyer (be specific or you'll sell to no one)

Target the **overlap operator**: a boutique luxury black-car / chauffeur firm,
~3–15 vehicles, whose VIP clients already ask the dispatcher to "also book the
restaurant / the jet / the tickets." They have:

- real ride volume (drives your payments revenue),
- an owner who answers their own phone (short sales cycle),
- **zero tooling for the concierge half** (your expansion wedge),
- active pain with Limo Anywhere (dated UX, forced merchant processing) or
  Moovs (5% per-ride rake).

Avoid for now: 1–2 car owner-operators (too small to pay), and 50+ vehicle fleets
(long sales cycle, want enterprise features you won't have).

## Sequencing: 3 design partners → 10 paying → repeatable

### Stage 0 — before you write production code (weeks 0–2)
- Screen-share **`index.html`** to 5 operators you already know. You're not
  selling; you're asking *"is this the loop, and what's wrong with it?"*
- Win when 3 say **"when can I use this?"** — those are design partners.
- Charge design partners a real (discounted) price from day one. Free pilots
  don't convert; a $49/mo design-partner rate filters tire-kickers and validates WTP.

### Stage 1 — first 3 design partners (months 1–3)
- Build only what they need to run **one real workflow end-to-end**: AI intake →
  quote → dispatch → driver app → mark complete. Payments can stay manual at first.
- Onboard them **personally** (you do data entry, you sit in their dispatch office a day).
- Goal: one operator runs a full week of real trips through it.

### Stage 2 — turn on payments, get to 10 (months 4–6)
- Ship Stripe Connect settlement. **This is when it becomes a business** — the
  take-rate roughly doubles revenue/operator and creates the anti-churn moat
  (their money now flows through you).
- Source the next 7 from design-partner referrals + the channels below.

### Stage 3 — repeatable (months 7–12)
- Standardize a 30-minute self-serve onboarding. Begin teasing the concierge tier
  to the operators with the most "can you also…" requests.

## Channels (ranked for a solo founder)

1. **Your existing network / warm intros** — highest conversion, lowest cost. This
   alone should get you to ~10.
2. **Operator referrals** — build a referral incentive in from operator #3.
3. **Industry watering holes** — LCT/Chauffeur Driven events & forums, NLA, regional
   limo associations. Show up with a live demo, not a pitch deck.
4. **Affiliate-network seams** — operators farm trips to each other constantly; a
   happy operator drags in the affiliates they trade with.
5. **Targeted content** — "switching off Limo Anywhere," "stop paying a 5% rake."
   These are exact search-intent phrases from the research.

## Positioning (one identity, not 50/50)

> *"The operating system for luxury ground transport — that also runs your VIP
> requests."*

Lead with **transport** (frequent, clear ROI, proven WTP). Concierge is the
expansion you mention, not the headline. A 50/50 "transport + concierge" pitch
confuses the buyer about what they're buying.

## Counter-positioning vs. named incumbents

| Incumbent | Their weakness | Your line |
|----------|----------------|-----------|
| Limo Anywhere | dated UX, **forced merchant processing + payment holds**, slow support | "Modern, your own Stripe, no holds, a human answers." |
| Moovs | **$299 setup + 5% of every ride**, farm-out blind spots | "Flat monthly, no rake, keep 100% of the fare." |
| WhatsApp/spreadsheets (concierge side) | **no audit trail, record walks out with staff** | "Every request owned, searchable, yours forever." |

## The first hard metric to watch

**Ride volume per operator** (drives payments revenue) and **churn** (payments is
your moat). Instrument both from operator #1. If a design partner isn't pushing
real volume through you by week 3, that's the thing to fix — before adding any feature.

## What to NOT do

- Don't build a client-facing booking marketplace (you'll be fighting Uber Black /
  Blacklane and disintermediating your own buyer).
- Don't build a channel-manager-style affiliate network first (network cold-start;
  it's a Phase 2 feature, not a wedge).
- Don't co-launch concierge. Focus dilution is the #1 solo-founder killer; concierge
  is Phase 3.

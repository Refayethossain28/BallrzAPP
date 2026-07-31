# Fixr — Unit Economics & 12-Month Model (pressure-tested)

The headline thesis: **payments, not seats, is the business.** Below is the model,
the assumptions it rests on, and an honest stress-test of each one.

## Pricing

- **Software:** $149 / mo flat per operator. No per-ride rake. (Counter-positions
  Limo Anywhere's forced processing and Moovs' 5% rake.)
- **Payments:** ~0.5% Fixr take-rate on settled ride volume, **on top of**
  Stripe's ~2.9%+30¢, collected via Connect. The operator still nets more than
  Moovs' 5% rake, and you make money on the money flow.

## Per-operator revenue

A small luxury operator runs **~$40k–$80k/mo** in ride volume. Use **$50k/mo**:

| Line | Monthly |
|------|---------|
| Software | $149 |
| Payments take (0.5% × $50k) | $250 |
| **Blended / operator** | **~$400** |

This is the whole thesis in one row: **payments ≈ doubles to triples the software
line.** Software-only, the same operator is ~$149; with payments, ~$400.

## 12-month path (conservative, network-led)

| Month | Operators | MRR (blended) | ARR run-rate |
|------:|----------:|--------------:|-------------:|
| 1–3 | 0 → 3 | ~$450 | ~$5k |
| 4–6 | 3 → 10 | ~$4,000 | ~$48k |
| 7–9 | 10 → 25 | ~$10,000 | ~$120k |
| 10–12 | 25 → 45 | ~$19,000 | **~$225k** |

**Read:** ~$200k ARR run-rate by month 12 is a *good* solo outcome — and it's the
payments line that gets you there. Software-only, those 45 operators are ~$80k ARR.
The research benchmark holds: solo SaaS without payments plateaus in low six figures;
embedded payments is the lever toward seven.

## Stress-test of every load-bearing assumption

### 1. Ride volume per operator ($50k/mo) — **biggest sensitivity**
The model lives or dies here.
- If real volume is **$25k/mo** → payments ≈ $125 → blended ≈ $275/op → year-end
  run-rate ≈ **$150k**.
- If **$80k/mo** → blended ≈ $550/op → year-end ≈ **$300k+**.
- **Action:** qualify operators on volume in the first sales call. Volume per
  operator matters more than operator count.

### 2. The 0.5% take-rate — **legal/economic check**
You can't just skim payments; you're a **payment facilitator / use Connect**, with
real obligations (KYC, flow-of-funds, disclosures). Two honest caveats:
- Stripe Connect makes this *operationally* feasible for a solo founder, but read
  the platform terms — surcharging/markup rules vary by state and card-network rules.
- Frame the 0.5% as a **platform fee**, transparently, not a hidden markup. Operators
  tolerate it because they're escaping Moovs' 5%.
- **Risk if wrong:** if you can't legally take a margin on payments, the model
  collapses to ~$149/op (software-only) and year-end ≈ **$80k**. Validate this
  *before* building Connect.

### 3. Growth pace (0→45 operators) — **distribution risk**
45 operators in 12 months is aggressive for a true solo founder doing high-touch
onboarding. It only works because of your warm network (see `GTM.md`).
- If you hit **20** instead of 45 → year-end run-rate ≈ **$100k**. Still a real
  business; just slower.
- **Action:** the first 10 should be almost entirely warm intros. Cold acquisition
  is a year-2 problem.

### 4. Churn — **the moat assumption**
The model assumes low churn because payments integration is sticky. True *once
money flows through you* — but in months 1–3 (pre-payments) churn risk is high.
- **Action:** get design partners onto Connect settlement ASAP; that's the moment
  they stop being able to casually leave.

### 5. COGS / your take-home
Mostly Stripe fees (pass-through), LLM intake calls (cents per request), Twilio,
hosting, flight API. At 45 operators these are low hundreds/mo — a solo founder
keeps the large majority of the ~$19k MRR. The constraint is *your time*, not COGS.

## Where the upside actually compounds (beyond year 1)

- **Concierge premium tier (Phase 3):** $300+/seat to firms that bill clients
  $2,500–$4,500/mo retainers — it's noise to them. This is the line that breaks you
  out of the solo-SaaS plateau.
- **Value-added services** (the AppFolio playbook): insurance, financing, screening
  on top of payments. ~30% of AppFolio's revenue is value-added; same pattern is open here.

## The two numbers to watch from operator #1

1. **Ride volume per operator** — drives payments revenue (assumption #1).
2. **Churn** — validates the moat (assumption #4).

Everything else is secondary. If those two hold, the model is conservative. If
either breaks, fix it before adding features.

## Honest bottom line

The base case (~$200k ARR run-rate, year 1) is **realistic but not guaranteed** —
it assumes warm-network distribution and a legally-sound payments margin. The
downside case (software-only, slower growth) is still ~$80–100k, i.e. a viable solo
income, not a failure. The asymmetry is good: limited downside, and the concierge
+ value-added upside is what makes it a seven-figure business rather than a lifestyle one.

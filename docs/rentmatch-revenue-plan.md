# Apex / RentMatch — from marketplace to recurring revenue

> **Status (build):** Phase 1 (compliance autopilot + subscriptions) and the core
> of Phase 2 (rent ledger + landlord finances) are **built and tested** — see the
> "Shipped product" section at the foot of this doc. What remains is go-live
> config (Stripe Prices, Postmark creds, deploy) plus the optional extras flagged
> inline.

> Reframe: stop selling "a lettings marketplace" (one-off £100 per tenancy,
> chicken-and-egg supply problem, you only get paid when a *new* let completes).
> Start selling **the tool a small UK landlord or letting agent runs every
> tenancy on** — recurring subscription + the existing per-completion fee on top.
>
> This is not a rewrite. ~70% of the defensible work already exists in
> `rentmatch/packages/shared` (deal state machine, compliance gates, Tenant Fees
> Act money math, contract generation). The pivot adds **recurrence, a portfolio
> dashboard, and rent collection** on those foundations.

## Why this and not another consumer app

| | Consumer apps (Imposter/Ripple/Cusp/…) | Apex-as-landlord-tool |
|---|---|---|
| Who pays | Consumer, ~£0 willingness | Landlord/agent — has a budget, treats it as a cost of doing business |
| Frequency | One-time / never | **Monthly recurring** |
| Moat | None — cloned in a weekend | UK statutory compliance, audit log, legally-binding e-sign |
| CAC | Brutal (vs free incumbents) | Targeted (landlord forums, NRLA, local agent outreach) |
| Already built | n/a | State machine, compliance, money caps, contract templates, Stripe scaffold |

## The customer (pick the wedge — start with #1)

1. **Portfolio landlords (2–20 units), self-managing.** Too big for a
   spreadsheet, too small to pay a letting agent 10% of rent. They live in fear
   of a missed gas-safety cert (£unlimited fine, can't serve a Section 21) or a
   mis-protected deposit (1–3× penalty). **This is the beachhead.** Highest pain,
   no procurement, reachable directly.
2. **Small letting agents (1–5 staff).** Higher willingness to pay, but they
   already have software (Goodlord, Reapit). Sell to them *after* the product is
   proven on landlords. Multi-client seat model.

## What you charge (recurring, not one-off)

| Tier | Price | For |
|---|---|---|
| **Free** | £0 | 1 property — compliance tracker + reminders only. The hook. |
| **Landlord** | **£12 / property / mo** (or £99/mo flat up to ~10 units) | Compliance + rent tracking + tenancy e-sign + document vault |
| **Agent** | **£49 / mo + £6 / unit** | Multi-landlord, team seats, branded tenant comms |
| **Per-completion** | **£100 on full execution** (existing) | Kept — now an *add-on* to recurring, not the whole business |

Reasoning: a landlord with 6 units pays ~£99/mo = ~£1,200/yr to avoid a single
compliance fine that dwarfs it. That's an easy yes. 200 such landlords = ~£240k
ARR — and that's a tiny slice of ~2.6M UK landlords.

## What's already built (reuse, don't rebuild)

- `packages/shared/src/compliance.ts` — EPC/gas/EICR/deposit/How-to-Rent gates,
  `docStatus()` already returns `missing | valid | expiring | expired` with a
  30-day "expiring soon" window. **This is the spine of the whole subscription.**
- `dealStateMachine.ts` — server-enforced legal transitions, completion guard.
- `money.ts` — Tenant Fees Act deposit/holding-deposit caps, GBP math in pence.
- `contractTemplate.ts` — AST generation by nation.
- `functions/` + `firestore.rules` — server-authoritative writes (money & stage
  only mutated by Cloud Functions). The trust model is already correct.

## What to build, in order

### Phase 1 — "Compliance autopilot" (the wedge that gets the first £)
Ship a standalone value prop that needs *no second party*, so a landlord gets
value on day one without a tenant or a deal.
1. ✅ **Portfolio dashboard** — every property with a RAG status per compliance
   doc, driven by `docStatus()` / `summarisePortfolio()`. Answers "am I legal?"
   in one screen. *(`ComplianceDashboard.tsx`, shipped.)*
2. ✅ **Document vault** — per-property screen (`DocumentVault.tsx`) to upload,
   view and renew each certificate, capturing the **issue date** so expiry (and
   the reminder cron) is accurate even for backdated/renewed docs.
3. ✅ **Expiry reminders** — daily Cloud Function cron (`sendComplianceReminders`)
   → push + email at 60/30/7 days and on lapse. Pure, idempotent
   `dueComplianceReminders()` decides what's due; keys stored on the listing so a
   milestone never re-sends and a renewal restarts the cycle. **This is the
   feature that makes them keep paying.**
4. ✅ **Stripe subscription billing** — Free / Landlord (£99) / Agent (£49+£6/unit)
   plans (`billing.ts`), Checkout + billing-portal Cloud Functions, webhook
   mirrors subscription state onto the user, Account screen subscribes/manages.
   *(The one-off £100 fee is kept as an add-on, not replaced.)*

5. ✅ **Track-only onboarding** — `TrackProperty.tsx` adds a property purely to
   monitor (address + EPC + declarations, no rent/advert), flagged `trackingOnly`
   so it flows through the dashboard and reminder cron but never appears in renter
   search or the advert view. The dashboard's "Add a property to track" CTA and
   per-property cards now route through this + the vault.

> Phase 1 alone is a sellable product — and it now stands on its own: a landlord
> can onboard, add properties, upload certificates and get reminders **without
> ever touching the marketplace**. To take payment, create the Stripe Prices and
> set their IDs in env.

### Phase 2 — Tenancy lifecycle (the recurring transactional layer)
5. ✅ **Tenancy records + rent ledger** — `rent.ts` is a pure, unit-tested engine
   (`buildRentLedger`: monthly schedule, owed-to-date, arrears/credit, next due).
   A **Rent** tab lists tenancies with auto-flagged arrears (`Rent.tsx`), a form
   adds a tenancy against any property (`NewTenancy.tsx`), and the detail screen
   shows the ledger + records payments (`TenancyDetail.tsx`). A denormalised
   `totalPaidPence` keeps the list cheap. Landlord-scoped Firestore rules.
6. ✅ **Rent reminders** — daily `sendRentReminders` cron nudges the landlord on
   rent due-soon (3 days out) and arrears, via the same ledger engine and the
   idempotent-key pattern (`dueRentReminders`).
7. ✅ **Statement export** — one-click CSV rent statement per tenancy
   (`buildRentStatementCsv`, downloaded from `TenancyDetail.tsx`).
8. ✅ **Landlord finances (Self Assessment / MTD)** — `finance.ts` rolls rent
   income + logged expenses into a **UK-tax-year** (6 Apr–5 Apr) income/expense/
   net summary with a category breakdown, mortgage-interest surfaced separately.
   **Finances** tab logs expenses and switches tax year (`Finances.tsx`).
9. **E-sign renewals** — reuse `contractTemplate.ts` + the e-sign envelope flow
   for *renewals*, not just new lets → recurring use of the £100 event. *(open)*

**Email is wired** — `sendEmail` posts to Postmark (no-op fallback when
unconfigured), so reminders and receipts land in inboxes, not just push.

### Phase 3 — Agent tier & rent collection (expansion revenue)
8. **Open Banking rent collection** (GoCardless/TrueLayer) — take rent via Direct
   Debit, auto-reconcile against the ledger. Optional small % or flat fee.
9. **Multi-landlord/agent seats**, branded tenant-facing comms.

## What would kill this (be honest)
- **"Landlords won't pay for software."** Some won't — that's why Phase 1 leads
  with fine-avoidance (loss aversion), not convenience, and why there's a free
  single-property tier to land them.
- **Incumbents** (Landlord Vision, Hammock, Goodlord). Differentiator: *compliance
  correctness + legally-binding e-sign in one place*, priced for the 2–20 unit
  self-manager that agent-grade tools over-serve and over-charge.
- **Regulation drift.** UK rules change (Renters' Rights Bill, MEES tightening to
  EPC C). That's a *moat*, not a risk, if you keep the rules current — it's
  exactly what a spreadsheet can't do.

## Shipped product

What a landlord can do today, all on top of the tested shared kernel:

- **Home** (`Home.tsx`) — one-glance overview: property count, certificates to
  action, active tenancies, arrears, this-tax-year income/expenses/net, and deep
  links into every area.
- **Compliance** — track-only onboarding (`TrackProperty.tsx`), per-property
  document vault with issue-date-accurate expiry (`DocumentVault.tsx`), a
  portfolio RAG dashboard (`ComplianceDashboard.tsx`), and a **daily reminder
  cron** (push + email) at 60/30/7 days and on lapse.
- **Rent** — tenancies with auto-flagged arrears (`Rent.tsx`), a rent ledger with
  schedule + payment recording (`TenancyDetail.tsx`), **CSV statement export**,
  and a **daily rent-reminder cron** (due-soon + overdue).
- **Finances** — UK-tax-year income/expense/net with category breakdown and
  expense logging (`Finances.tsx`) — built for Self Assessment / MTD.
- **Billing** — Free / Landlord (£99) / Agent (£49 + £6/unit) Stripe subscriptions
  with Checkout + billing portal (`billing.ts`, Account screen); the £100
  per-completion fee remains as an add-on.

**Engine coverage:** `compliance.ts`, `billing.ts`, `rent.ts`, `finance.ts`,
`money.ts`, `dealStateMachine.ts`, `notifications.ts`, `search.ts`, `retention.ts`
— **82 unit tests**, all passing. Web (`tsc -b` + vite) and functions (esbuild)
build clean.

### To go live
1. Create the three Stripe **Prices** and set `STRIPE_PRICE_LANDLORD` /
   `STRIPE_PRICE_AGENT` / `STRIPE_PRICE_AGENT_UNIT` + `APP_URL`.
2. Set Postmark `EMAIL_API_KEY` + `EMAIL_FROM` for real email.
3. `firebase deploy` (hosting + functions + Firestore rules), then point a Stripe
   webhook at `stripeWebhook` for `payment_intent.*` and `customer.subscription.*`.

### Still open (next)
- E-sign **renewals** (recurring £100 events); **Open-Banking rent collection**
  (GoCardless/TrueLayer) and the **agent multi-landlord** seats (Phase 3);
  an emulator **e2e** test for the new compliance/rent/finance flows.

## First concrete step
Turn `ComplianceManager.tsx` from a per-deal gate into a **standalone portfolio
compliance dashboard** with reminders, and wire Stripe Subscriptions. That alone
is a chargeable product and validates whether landlords will pay — before
building rent collection or the agent tier.

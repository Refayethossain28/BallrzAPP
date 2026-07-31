# Vault → real money: the honest roadmap

Vault (`/vault/`) is now a real *banking system* — server-authoritative ledger,
real users, real transfers between them — carrying **simulated money**. This
document is the serious answer to "make it a real bank": what it would take,
legally and technically, for Vault to hold and move actual pounds. It is a
map, not legal advice; the first real step on it is a conversation with a
fintech-regulatory lawyer.

**The one-line truth: the code is the easy part.** The engine already does
integer-pence double-entry, IBAN check digits, Luhn cards, daily-compounded
AER and month-end-clamped standing orders. What separates Vault from Monzo is
not software — it is permission, capital, and compliance operations.

---

## 1 · The three legal routes (UK)

### Route A — ride on a Banking-as-a-Service partner (the realistic start)

You do not get a licence; you integrate with someone who has one. The
partner holds the money and the regulatory burden; Vault becomes the brand
and the experience layer. This is how most consumer fintechs launch.

| Provider | What they give you | Notes |
|---|---|---|
| **Griffin** (griffin.com) | Full UK bank-as-a-platform: accounts, payments, safeguarding | A real authorised UK bank built API-first; closest fit to "Vault but real" |
| **ClearBank** | Clearing bank: real sort codes, FPS/Bacs/CHAPS access | Powers Tide, Chip, others; expects serious volume commitments |
| **Modulr** | E-money accounts + payment rails via API | Popular with payroll/SME products; fast to integrate |
| **Stripe Treasury / Issuing** | Stored-value accounts + real card issuing | Treasury is US-first — check UK availability; Issuing works in the UK today |
| **Enfuce / Marqeta** | Card issuing + processing | Pair with an account provider for the card side |

- **Cost/time to first real account:** roughly £10–50k setup + per-account
  fees, **3–6 months** including the partner's due diligence on *you*.
- **What Vault's code maps to:** the engine keeps running as the product
  ledger ("what the user sees"); the partner's API becomes the settlement
  truth. `vaultSend` stops writing both sides itself and instead instructs
  the partner, then reconciles the webhook. The callable layer
  (`functions/src/vault.ts`) is exactly where those API calls slot in —
  `topup` is already commented as that seam.

### Route B — your own e-money licence (EMI)

FCA authorisation as an **Electronic Money Institution**: you can hold
customer funds (safeguarded, not lent) and run payment accounts — what
Revolut was for years. Requires: €350k initial capital, safeguarding
accounts at a credit institution, a UK-resident director, compliance +
audit function, wind-down plan. **9–18 months** and £250k–£1m+ before
launch. Only sensible once a partner-based Vault has real traction.

### Route C — a full banking licence

Deposit-taking, FSCS-protected, lending allowed. New-bank authorisation via
the PRA/FCA "mobilisation" route: £1m+ minimum capital in mobilisation and
tens of millions to exit it, a full board, ICAAP/ILAAP, **2–4 years**. This
is "found a bank", not "ship a feature". Monzo raised ~£100m before its
restrictions were lifted. Park it.

---

## 2 · What must be built regardless of route

These are needed even for Route A, and none exist yet:

1. **KYC/AML onboarding** — identity verification (SumSub, Onfido, or
   Veriff), PEP/sanctions screening, and risk-scoring at sign-up. No real
   account opens without it; partners will not onboard you without it.
2. **Transaction monitoring** — automated flags (structuring, rapid
   in-out, mule patterns), a case queue, and a **Suspicious Activity
   Report** path to the NCA. A named MLRO (money-laundering reporting
   officer) is a legal requirement.
3. **Strong Customer Authentication** — the email+password login must grow
   a second factor (passkeys are the modern answer; Firebase Auth supports
   TOTP/passkeys). PSD2 requires SCA for payments.
4. **Immutable audit** — the append-only ledger is the right shape already;
   add tamper-evident storage (hash-chained entries or a WORM bucket) and
   7-year retention.
5. **Idempotency keys on every money mutation** — at real-money stakes, a
   retried `vaultSend` must be provably at-most-once. (Worth adding to the
   simulated bank too; it's a small change to the callable contract.)
6. **Reconciliation** — a daily job proving the product ledger equals the
   partner's settlement ledger, with alerting on a penny of drift.
7. **Complaints & FOS** — a complaints procedure, 8-week response clock,
   Financial Ombudsman Service enrolment; plus vulnerable-customer policy.
8. **Data protection** — DPIA, UK GDPR records, breach process; financial
   data is high-risk processing.
9. **Operational resilience** — status page, incident runbooks, disaster
   recovery with tested restores, and (for FCA routes) outsourcing
   registers covering Firebase/GCP.

---

## 3 · A staged plan that doesn't lie to anyone

**Stage 0 — now.** Vault Online with play money. Say "simulated" everywhere
(the app does). No licence needed. *Done.*

**Stage 1 — real-feel, still unregulated (1–2 months).** Add passkey/2FA,
idempotency keys, hash-chained audit log, and KYC in "sandbox mode"
(SumSub test keys) so the full onboarding flow exists end-to-end. Still
play money — but now the codebase is partner-due-diligence ready.

**Stage 2 — first real pounds via a partner (3–6 months, ~£25–75k).**
Pick Route A (Griffin is the natural first conversation; Modulr the
pragmatic second). Real named accounts, real FPS transfers, the engine
demoted to product-ledger + reconciliation. Card issuing via the partner
or Stripe Issuing. Launch to a small closed cohort.

**Stage 3 — earn the licence question (12+ months in).** If unit economics
work at Stage 2 scale, *then* weigh Route B against staying partnered.
Most products never need to leave Route A — that is not failure, it is the
industry's actual shape.

**Cross-cutting rule:** at no point does an unlicensed build hold or move a
real pound outside a partner's regulated perimeter. If a shortcut appears
to allow it, the shortcut is the bug.

---

## 4 · First five concrete actions

1. Talk to a fintech regulatory solicitor (fixed-fee scoping call) about
   Route A obligations as an *agent/distributor* of a partner.
2. Open developer-sandbox accounts: Griffin, Modulr, Stripe Issuing,
   SumSub — all have free sandboxes; integrate against them like Stage 1.
3. Add idempotency keys + hash-chained audit entries to `vault.ts` (small,
   pure-code, valuable today).
4. Ship passkey 2FA on Vault Online sign-in.
5. Write the reconciliation job against the partner sandbox webhooks —
   it will find bugs in assumptions long before money does.

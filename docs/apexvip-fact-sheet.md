# ApexVIP — Fact Sheet

**ApexVIP** — *Beyond the journey.*
A luxury chauffeur & lifestyle-concierge platform for London: three connected apps
with an AI concierge at the centre. **Status: launch-ready software** (pre-fleet;
licensing & production payments are the remaining gates).

---

**What it is** — Passenger, driver, and operator apps on one backend. Book chauffeur
journeys (airport, hourly, daily, point-to-point), discover hotels & experiences,
and book by talking to **ApexAI**. Operators dispatch, vet drivers, set pricing, and
settle payouts; drivers onboard, drive, and get paid.

**Who it's for** — Discerning London travellers; professional PHV chauffeurs; and a
TfL-licensed operator who needs dispatch, compliance and payments in one place.

---

## Capabilities at a glance

| Area | What's built |
|---|---|
| **Booking** | Airport · hourly · daily · point-to-point (live rate engine); promo + VAT-inclusive pricing |
| **AI concierge** | ApexAI — Claude-powered free-text booking (passenger) + Quick Intake (operator), with offline fallback |
| **Lifestyle** | London hotels with **live nightly rates** (Amadeus); curated experiences |
| **Payments** | Square cards + SCA; server-side fare validation & ownership checks |
| **Driver payouts** | Stripe Connect Express; 80% per-trip earnings ledger; admin settlement |
| **Compliance** | Document vetting + **automatic expiry enforcement**; vehicle MOT/road-tax; off-duty within 24h on lapse |
| **Governance** | Immutable audit log; rules block self-approval & role self-promotion |
| **Live ops** | Real-time bookings, live map, broadcast/assign dispatch, flight status (AviationStack) |
| **Platform** | Firebase (Auth/Firestore/Functions, split codebases); installable PWAs + Capacitor iOS |

---

## Differentiators

1. **Rides *and* lifestyle on one request engine** — concierge is the product, not a bolt-on.
2. **Talk, don't fill forms** — natural-language booking for guests *and* operators.
3. **Compliance & audit as features** — exactly what a licensed operator must evidence.
4. **Transparent, VAT-correct pricing** — a visible rate engine, no surge.
5. **Driver-first economics** — 80% to the driver via a real payout rail.

## Competitive context

| | ApexVIP | Wheely | Blacklane | Uber Lux |
|---|:--:|:--:|:--:|:--:|
| AI concierge · Hotels · Audit | ✅ | — | — | — |
| Built-in compliance tooling | ✅ | internal | internal | internal |
| In-app driver payouts | ✅ | internal | internal | ✅ |

Incumbents lead on **scale, global coverage, and live operating history**; ApexVIP
leads on **software, AI, and built-in compliance/governance**.

---

## The remaining mile (to real trading)

- **Legal:** TfL PHV operator licence · insured, DBS-checked drivers · ICO/DPO · solicitor-signed terms.
- **Technical:** deploy the hardened backend, enforce App Check, flip Square to production, fund driver payouts.
- *All sequenced in* `apexvip-launch-runbook.md`.

## In one line

> The incumbents have the cars on the road. ApexVIP has the better software — and a
> documented path from prototype to a licensed, paying operation.

---

*Reference docs: `apexvip-presentation.md` (full story) · `apexvip-go-live-checklist.md`
· `apexvip-launch-runbook.md` · `apexvip-driver-compliance.md` ·
`apexvip-driver-payouts.md` · `apexvip-audit-log.md`.*

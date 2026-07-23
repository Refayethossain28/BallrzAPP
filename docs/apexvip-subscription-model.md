# ApexVIP — Business Model Switch (Commission ↔ Subscription)

The platform can run in either of two revenue models, switched live from the
admin app (**Settings → Business Model**). The choice is stored in
`settings/business` and every app reacts to it in real time.

## The two models

| | **Commission** (default) | **Subscription** |
|---|---|---|
| Client cost | Free to join | **£/month** (admin-set, default £49) |
| Driver cost | Free to join | **£/month** (admin-set, default £99) |
| Per-trip commission | Fixed **20%** (driver keeps 80%) | **Admin-set 0–50%** (0 = pure subscription) |
| New members | — | **Free trial** (admin-set days, default 30) |

## `settings/business`
```jsonc
{ "model": "commission" | "subscription",
  "commissionPct": 20,        // used only in subscription mode; clamped 0–50
  "clientMonthlyFee": 49, "driverMonthlyFee": 99,
  "trialDays": 30, "updatedAt": <ts> }
```
Public-read (settings collection), admin-write. Every switch/save is recorded in
the **audit log** (`business_model_update`).

## What changes where

- **Backend** (`functions/src`): `driverEarning()` / `dispatchPay()` take a
  commission percentage (default 20 → identical behaviour in commission mode).
  `platformCommissionPct()` reads `settings/business` (cached ~60s per instance);
  the payout ledger and broadcast job pay use it, so the driver's split follows
  the admin's setting end-to-end. Unit-tested including the 0–50 clamp.
- **Admin**: the Business Model card (Settings) switches modes and, in
  subscription mode, edits fees / trial days / commission. The Payouts screen
  copy shows the live split.
- **Client**: in subscription mode a `subscriptions/{uid}` doc is created on
  first sign-in (**trial**, `trialEndsAt = now + trialDays`). Home shows a
  trial/expired banner; after expiry, **booking is gated** behind a membership
  sheet (price from settings).
- **Driver**: same trial bootstrap (`role: 'driver'`). Home shows the banner
  with their fee and keep-percentage; after expiry, **going online is gated**
  until they activate.
- Existing users without a subscription doc get their trial started on next
  sign-in — nobody is locked out on the day of the switch.

## Rules
`subscriptions/{uid}` — a user reads/writes only their own doc; admins see all.

## ⚠️ Launch note (mock billing)
"Start membership" / "Activate" set `status: 'active'` **client-side** — there is
no real recurring charge yet. Before running subscription mode with real money:
1. Wire a recurring billing rail (e.g. **Square Subscriptions**, or Stripe
   Billing alongside the Connect payouts).
2. Move activation server-side (webhook → Admin SDK write) and tighten the
   `subscriptions` rules so `status: 'active'` can't be self-written.

Switching back to **commission** ignores subscription state entirely — no
banners, no gates, fixed 80/20.

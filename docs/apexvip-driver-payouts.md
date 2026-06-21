# ApexVIP — Driver Payouts (Stripe Connect)

The rail that pays drivers their share. Ported from `fixr/app/connect.js` and
adapted to ApexVIP's Firebase backend. ApexVIP **collects** fares via Square; this
is the separate **payout** flow to drivers via **Stripe Connect Express**.

## Flow

```
driver onboards (Connect Express, KYC + bank)         ← createDriverPayoutAccount
        │
trip completes → booking.status = 'completed'
        │   (onBookingWrite)
driver_payouts/{bookingId} = { driverId, amount: 80%, status: 'owed' }
        │
admin clicks "Pay out" on the Earnings screen          ← payoutDriver
        │   Stripe transfer → connected account; entries → status: 'paid'
driver receives funds to their bank
```

## Pieces

| Piece | Where |
|---|---|
| `createDriverPayoutAccount` (callable, driver) | creates/reuses a Stripe Express account, returns a hosted onboarding link; stores `drivers/{uid}.payout` |
| `getDriverPayoutStatus` (callable, driver) | retrieves the account; mirrors `payoutsEnabled` onto `drivers/{uid}.payout` |
| `payoutDriver` (callable, **admin**) | sums a driver's `owed` ledger, one Stripe transfer, marks entries `paid` |
| Ledger write | inside `onBookingWrite` on `status → completed` (idempotent, id = bookingId) |
| Driver app | Profile → **Set up payouts** (`setupPayouts()`); label shows "active" once enabled |
| Admin app | **Payouts → Driver Earnings**: owed balance per driver + **Pay out** button |
| `driver_payouts/{id}` | `{ driverId, bookingRef, amount, currency, status: owed\|paid, transferId, paidAt }` |

## Security
- `drivers/{uid}.payout` is **admin/Functions-only** (added to the same protected-keys
  guard as `compliance`) — a driver can't fake `payoutsEnabled`.
- `driver_payouts` — a driver may read their own entries; only admins/Functions write.
- `payoutDriver` requires `users/{uid}.role == 'admin'`.

## Setup
```sh
firebase functions:secrets:set STRIPE_SECRET_KEY        # sk_live_… / sk_test_…
# functions/.env (optional): PAYOUT_RETURN_URL=https://<your-driver-app-url>
firebase deploy --only functions:apexvip:createDriverPayoutAccount,functions:apexvip:getDriverPayoutStatus,functions:apexvip:payoutDriver
firebase deploy --only firestore:rules
```
In the **Stripe Dashboard**: enable **Connect**, set the platform branding, and
(for live) complete the platform profile. Use a **test** key first — the whole flow
(onboarding link, status, transfer) works end-to-end in Stripe test mode.

**No key set?** All three callables run in a **mock mode** (fake account id,
stub link, `payoutDriver` just marks entries paid) so the UX is testable without
Stripe — clearly flagged `mock: true` in responses.

## ⚠️ Cross-processor funding (read before going live)
A Stripe **transfer** draws the **platform's Stripe balance**. ApexVIP takes fares
in **Square**, so that balance isn't automatically funded. Pick one before relying
on real transfers:
1. **Top-up / scheduled funding** — move money from your bank/Square into the
   Stripe balance to cover payouts (operationally simplest to start).
2. **Move customer charges to Stripe** — then use Connect *destination charges* /
   *separate charges and transfers* so each fare funds the driver's share directly
   (cleanest long-term; means replacing the Square payment functions).

Until one is in place, `payoutDriver` will succeed in mock mode but a live transfer
can fail with *insufficient funds* — that error is surfaced to the admin.

## Not yet modelled
- Automatic payout on completion (today an admin clicks Pay out) — easy to switch
  to a scheduled batch once funding (above) is settled.
- Per-trip payout receipts to drivers; payout history view in the driver app.

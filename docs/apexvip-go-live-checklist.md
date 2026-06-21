# ApexVIP — Go-Live Checklist

Everything between the current build and a real, paid, UK-operating launch.
Items marked **[code done]** ship in the repo; the rest are operator/legal work.

> For the **ordered sequence + exact commands** to execute a launch, see
> `apexvip-launch-runbook.md`. This file is the *what*; the runbook is the *when*.

> ## ⚠️ Read first — the deployed backend is NOT this repo
> The live Firebase project (`apexvip-1b4a9`) already runs a **separate, gen-1
> Cloud Functions codebase** (`assignDriverToBooking`, `parseBookingIntent`,
> `processSquarePayment`, `sendBookingConfirmation`, …). The functions in this
> repo's `functions/` are a **parallel gen-2 set** — they are *not* what's live.
>
> - **Do NOT run a blanket `firebase deploy --only functions`** — it would delete
>   the live gen-1 functions this repo can't see. Always scope with `--only
>   functions:<name>` (and a gen-1↔gen-2 name clash blocks the deploy anyway).
> - The security/payment hardening below (server-side amount check, auth, payment
>   ownership, 80% driver pay in `onBookingCreated`) lives in **this repo's**
>   functions, so it only takes effect once you **consolidate onto one codebase**.
>   Until then, port the same checks into the deployed gen-1 functions by hand.
> - **Pre-launch task:** decide on one backend, migrate, and retire the other. Track it in §2.

## 0. Legal & regulatory (blockers — cannot launch without)
- [ ] **TfL Private Hire Vehicle (PHV) Operator licence** + licensed drivers & vehicles.
- [ ] **DBS-checked, vetted drivers**; hire & reward / operator **insurance**.
- [ ] **Solicitor sign-off** on Terms & Privacy; fill placeholders (company no.,
      ICO reg `ZA…`, TfL licence no., VAT no.). **[draft copy done]**
- [ ] ICO registration; named **DPO**.

## 1. Auth & security  **[code done — PR #49, #100, #104]**
- [ ] Enable sign-in providers (Email/Password, Google, Apple) in Firebase Console.
- [ ] **App Check** — register reCAPTCHA v3, set `APEXVIP_RECAPTCHA_KEY` in
      `firebase.js`, enforce on Firestore/Functions.
- [ ] Add production domain(s) to Authentication → Authorized domains.
- [ ] Deploy rules: `firebase deploy --only firestore:rules`. Latest rules add
      role-field admin/driver detection (#100) and constrain `open_jobs` updates
      to the **claim transition only** (#104 — a driver can't reopen a taken job,
      claim for someone else, or inflate pay).
- [ ] Roles are read from the `users/{uid}.role` field (how the apps work); set
      `admin` / `driver` **custom claims** too if you want them as a backup path.
- [x] **Self-elevation closed** — rules block a user changing their own `role`, and
      a driver writing their own `compliance` verdict (only admins approve docs).
- [ ] **Driver compliance** (`docs/apexvip-driver-compliance.md`): every driver's
      licence/PCO/insurance/DBS/V5C/badge **approved + in-date**, plus an active
      **vehicle** with MOT + road tax in date, in the admin Drivers screen before
      they go live. Enforced in-app (Go Online + manual assign blocked for
      non-compliant drivers) once rules are deployed.
- [ ] Deploy the daily reminder: `firebase deploy --only functions:apexvip:remindExpiringDocs`
      (emails driver + `OPS_EMAIL` before expiry; auto-flips lapsed drivers off-duty).

## 2. Payments  **[client SCA + server-side hardening done — PR #50, #104]**
- [ ] `firebase functions:secrets:set SQUARE_ACCESS_TOKEN`; set `SQUARE_ENV`,
      `SQUARE_LOCATION_ID` in `functions/.env`.
- [ ] Deploy: `firebase deploy --only functions:processSquarePayment,functions:captureSquarePayment,functions:refundSquarePayment`.
      ⚠️ **First resolve the backend split (see top):** the deployed
      `processSquarePayment` is a *different* gen-1 function — port the #104 checks
      into it, or migrate to this codebase, before relying on them in production.
- [ ] Swap `SQUARE_APP_ID` / `SQUARE_LOCATION_ID` in `apexvip-client.html` to production.
- [x] **Server-side amount validation** against `settings/pricing` (#104) — rejects
      tampered/runaway amounts. *Tighten further:* recompute the exact fare from the
      booking (create the booking first, pass its id, charge its stored price).
- [x] **Auth required** on all three Square callables; **ownership check** on
      capture/refund (caller owns the booking or is staff) (#104).
- [x] **VAT-inclusive pricing** — totals no longer double-charge VAT (#104).
- [ ] Wire **capture** on trip completion and **refunds** to the cancellation policy.
- [ ] **Driver payouts** (`docs/apexvip-driver-payouts.md`): `firebase functions:secrets:set
      STRIPE_SECRET_KEY`, enable Stripe **Connect**, deploy the payout callables.
      ⚠️ Decide funding (top-up the Stripe balance, or move charges to Stripe) — fares
      are taken in Square, so a live transfer needs a funded Stripe balance.
- [ ] Migrate Apple/Google Pay to the Square wallet SDK; register Apple merchant ID.
- [ ] VAT receipts (net/VAT/gross + VAT number).

## 3. Live hotel rates  **[function scaffold done]**
- [ ] `firebase functions:secrets:set AMADEUS_CLIENT_ID AMADEUS_CLIENT_SECRET`.
- [ ] Deploy `getHotelRates`; confirm licensing to display partner rates.

## 3a. ApexAI concierge  **[Claude-backed `parseBookingIntent` done — PR pending]**
- [ ] `firebase functions:secrets:set ANTHROPIC_API_KEY` (shared with `linguaAI`).
- [ ] Deploy `parseBookingIntent` — ⚠️ **resolve the backend split first** (a gen-1
      `parseBookingIntent` is already live; decide replace vs. port). Forces a
      structured `booking_intent` tool call (model `claude-opus-4-8`); the client
      falls back to its on-device parser if absent, so a partial deploy is safe.

## 4. Notifications  **[booking email/SMS function done]**
- [ ] Generate Web Push VAPID key → `APEXVIP_VAPID_KEY` in `firebase.js`.
- [ ] `firebase functions:secrets:set SENDGRID_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN`;
      set `NOTIFY_FROM_EMAIL` / `TWILIO_FROM_NUMBER` in `functions/.env`.
- [ ] Deploy: `firebase deploy --only functions:onBookingWrite,functions:onBookingCreated`. SendGrid verified
      sender + Twilio number required; each channel is optional.

## 5. Reliability & quality  **[code done — PR #51, #103, #104]**
- [ ] Point `reportError()` at Sentry/Crashlytics (DSN).
- [ ] Uptime monitoring + alerting on the Functions.
- [ ] **Tests**: `npm test` runs smoke + Omni + ApexVIP core unit tests.
      Extend coverage to booking/payment flows (ideally with Playwright e2e).
- [x] **Driver pay = 80%** of fare across admin dispatch + `onBookingCreated` (#104).
- [x] **render() debounced** to one repaint per animation frame in all three apps (#104).
- [ ] Accessibility: finish the manual WCAG 2.2 AA pass
      (`docs/apexvip-reliability-a11y.md`).

## 6. App presence
- [ ] PWA is live on Pages; for the stores, wrap as a native shell / TWA.
- [ ] Real photography, final copy, verified partner/hotel data.

## Deploy reference
```sh
# from repo root
firebase deploy --only firestore:rules
firebase deploy --only functions:getHotelRates,functions:processSquarePayment,functions:captureSquarePayment,functions:refundSquarePayment,functions:onBookingWrite,functions:onBookingCreated,functions:parseBookingIntent
```
> ⚠️ A **gen-1** `parseBookingIntent` is already live in a separate codebase (see §0).
> Always scope deploys with `--only` so you never delete what this repo can't see,
> and resolve the gen-1↔gen-2 split before deploying the repo's `parseBookingIntent`.

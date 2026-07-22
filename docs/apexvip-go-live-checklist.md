# ApexVIP — Go-Live Checklist

Everything between the current build and a real, paid, UK-operating launch.
Items marked **[code done]** ship in the repo; the rest are operator/legal work.

> **Status — July 2026:** the client PWA is live at **https://apexvip.uk** (GitHub
> Pages + custom domain, installable, relative manifests). **Google sign-in is
> enabled and verified working** on the live site. Recent product work now in the
> repo: 4-tab client, two-door home, vehicle capacity rules (S-Class ≤3 pax,
> V-Class ≤7, parties >7 book a **convoy** that splits into one booking per van at
> creation — each van dispatches and pays out like a normal booking, payment
> anchored on van 1), admin CRM (`crm_clients`/`crm_leads`, admin-only rules),
> driver GPS/wake-lock optimisations, and the promo/social asset pack under
> `promo/social/`.

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
- [x] Enable **Email/Password + Google** sign-in in Firebase Console — done and
      verified working on apexvip.uk (July 2026). The client uses popup with a
      `signInWithRedirect` fallback for the installed PWA.
- [ ] Enable **Apple** sign-in. Needs a paid **Apple Developer account**, then:
      1. developer.apple.com → Identifiers → new **Services ID** (e.g.
         `uk.apexvip.signin`), enable *Sign in with Apple*, set the return URL to
         `https://apexvip-1b4a9.firebaseapp.com/__/auth/handler`.
      2. Keys → new key with *Sign in with Apple* → download the `.p8` once.
      3. Firebase Console → Authentication → Sign-in method → Apple → paste
         Services ID, Team ID, Key ID + key contents.
      The client's Apple button already handles it once the provider is on.
- [ ] **App Check** — register reCAPTCHA v3, set `APEXVIP_RECAPTCHA_KEY` in
      `firebase.js`, enforce on Firestore/Functions.
- [x] Add production domain(s) to Authentication → Authorized domains —
      `apexvip.uk` is authorized (Google sign-in works there).
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
- [x] **Convoy payments** — a party >7 books one payment for the whole convoy,
      anchored on van 1 (`squarePaymentId` + `convoyTotal`); sibling vans carry
      per-van fares (so 80% payouts stay per-booking) but no payment id, so
      completion-capture fires exactly once.
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

## 5a. Data protection & backups
- [ ] Schedule daily Firestore exports: enable billing on a GCS bucket, then
      `gcloud firestore export gs://apexvip-1b4a9-backups` on a Cloud Scheduler
      cron (or Console → Firestore → Disaster recovery).
- [ ] CRM privacy: `crm_clients`/`crm_leads` are **admin-only by rule** — keep it
      that way; internal notes must never move into `users/{uid}` (clients read
      their own profile doc).

## 5b. Team onboarding
- [ ] **Admins**: create the account in Firebase Console → Authentication, then
      set `users/{uid}.role = 'admin'` (Console/Admin SDK only — rules block
      self-elevation). Verify the ops console loads at
      `apexvip.uk/apexvip-admin.html`.
- [ ] **Drivers**: sign up in the driver app → admin approves compliance docs
      (licence/PCO/insurance/DBS/V5C/badge + vehicle MOT/tax) in the Drivers
      screen → driver can go online. Walk each driver through Go Online, job
      claim, status buttons, and earnings.
- [ ] Dry-run a **convoy booking** (party of 8+) end-to-end: k bookings appear,
      k drivers claim independently, receipts show "Van X of k · party total".

## 6. App presence
- [x] PWA is live at **apexvip.uk** with the custom domain, installable from
      Safari/Chrome (relative manifests + `?v=2` cache-bust; verified on-device).
- [ ] For the app stores, wrap as a native shell / TWA.
- [ ] Real photography, final copy, verified partner/hotel data.
- [ ] Launch content: TikTok/Instagram cuts + teasers + feed posts live in
      `promo/social/` (save-to-Photos page at `promo/social/index.html`). Turn ON
      the platform's **AI label** when posting — the film contains
      photorealistic AI-generated people.

## Deploy reference
```sh
# from repo root
firebase deploy --only firestore:rules
firebase deploy --only functions:getHotelRates,functions:processSquarePayment,functions:captureSquarePayment,functions:refundSquarePayment,functions:onBookingWrite,functions:onBookingCreated,functions:parseBookingIntent
```
> ⚠️ A **gen-1** `parseBookingIntent` is already live in a separate codebase (see §0).
> Always scope deploys with `--only` so you never delete what this repo can't see,
> and resolve the gen-1↔gen-2 split before deploying the repo's `parseBookingIntent`.

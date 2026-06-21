# ApexVIP — Launch Runbook

The exact, ordered steps to take ApexVIP from "launch-ready prototype" to **live,
taking real bookings and payments**. Pair this with `apexvip-go-live-checklist.md`
(what) and `apexvip-backend-consolidation.md` (backend cut-over detail). This file
is the **sequence** (when + the commands).

> Two tracks run in parallel: **Track A (legal/ops)** is external and gates real
> trading — you cannot take a paid public booking until it clears. **Track B
> (technical)** you can complete now so the moment A clears you flip one switch.
> Do **not** point real customers at the app until **both** are green.

---

## Track A — Legal / regulatory (external; gates everything)

Nothing in Track B matters for *real* customers until these exist. Start them first
— they have the longest lead times.

- [ ] **TfL PHV operator licence** granted; licensed vehicles on the fleet.
- [ ] **Drivers**: DBS-checked, PHV-licensed; **hire-&-reward / operator insurance** in force.
- [ ] **Solicitor sign-off** on Terms & Privacy; replace every placeholder in the
      app copy — company no., **VAT no.**, **ICO reg `ZA…`**, **TfL licence no.**
      (search the client app for "to be confirmed" / "00000").
- [ ] **ICO registration** done; **DPO** named and contactable.
- [ ] Cancellation/refund policy finalised (the refund function enforces it).

➡️ When all five are ticked, real trading is *legally* possible. Proceed to the
Track B cut-over (most of which can be pre-staged before this point).

---

## Track B — Technical go-live

Ordered so each step is verifiable before the next. Steps B1–B6 are **safe to do
now** (they don't expose anything to real customers). B7 (production payments) and
B8 (point customers at it) are the actual "go live" flips — do them last, ideally
right as Track A clears.

### B0. Prerequisites (one-time, local)
```sh
# Firebase CLI logged into the apexvip-1b4a9 project
firebase --version            # ≥ 13
firebase use apexvip-1b4a9
gcloud auth login && gcloud config set project apexvip-1b4a9   # for source recovery
```

### B1. Recover the deployed (gen-1) function source — **do this first**
The live backend is a *separate* gen-1 codebase. Pull its source so the repo can
become the single, hardened source of truth (see consolidation §3).
```sh
gcloud functions list --project apexvip-1b4a9        # note region + gen of each
# For each app-facing function with no/older repo source, pull its source:
for fn in parseBookingIntent checkFlightStatus sendChauffeurMessage \
          submitTripRating generateReferralCode applyReferralCode \
          validateApplePayMerchant processSquarePayment assignDriverToBooking; do
  url=$(gcloud functions describe "$fn" --project apexvip-1b4a9 --region <REGION> \
        --format='value(sourceArchiveUrl)' 2>/dev/null)
  [ -n "$url" ] && gsutil cp "$url" "functions/recovered/$fn.zip"
done
```
- [ ] Diff each recovered function against the repo version (`functions/index.js`).
      Reconcile per `functions/recovered/README.md` (field names, referral maths,
      flight-provider mapping, chat side-effects). The repo's hardened logic wins;
      keep any live behaviour the repo stub is missing.

### B2. Provision secrets (no customer impact)
```sh
firebase functions:secrets:set ANTHROPIC_API_KEY      # ApexAI + Lingua
firebase functions:secrets:set FLIGHT_API_KEY         # AviationStack
firebase functions:secrets:set SQUARE_ACCESS_TOKEN    # keep SANDBOX token for now
firebase functions:secrets:set SENDGRID_API_KEY
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
# Apple Pay (when the merchant cert is issued):
firebase functions:secrets:set APPLE_PAY_MERCHANT_CERT
firebase functions:secrets:set APPLE_PAY_MERCHANT_KEY
```
Set non-secret env in `functions/.env` (copy from `.env.example`): `SQUARE_ENV=sandbox`
(for now), `SQUARE_LOCATION_ID`, `NOTIFY_FROM_EMAIL`, `TWILIO_FROM_NUMBER`,
`AMADEUS_HOST`.

### B3. Deploy security rules + indexes (do before any function cut-over)
```sh
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```
- [ ] In the **driver** app: go Online in `london` → make a test booking in the
      **client** app → confirm the job broadcasts and can be claimed. (Validates
      the role-field rules + `open_jobs` claim constraint.)

### B4. Cut over functions — one at a time, low-traffic window
⚠️ **Never** `firebase deploy --only functions` blanket — it deletes live gen-1
functions the repo can't see. The repo is now two codebases: `apexvip` (ApexVIP)
and `side-apps` (Lingua/Ripple).

Order: net-new first (no clash) → same-name/same-gen updates (safe) → gen-changing
last (delete the gen-1, then deploy). For a gen-1→gen-2 name, delete first:
```sh
# Example for one function whose generation changes:
gcloud functions delete checkFlightStatus --project apexvip-1b4a9 --region <REGION>
firebase deploy --only functions:apexvip:checkFlightStatus
```
Repeat per function. After each, exercise the exact app screen that calls it.
Recommended sequence (verify in-app between each):
- [ ] `getHotelRates` (same name) — Hotels tab shows live rates
- [ ] `parseBookingIntent` — ApexAI chat parses a booking
- [ ] `checkFlightStatus` — flight lookup returns status
- [ ] `generateReferralCode` / `applyReferralCode` — profile → referral
- [ ] `sendChauffeurMessage` / `submitTripRating` — chat + post-trip rating
- [ ] `onBookingWrite` / `onBookingCreated` — email/SMS + dispatch fire
- [ ] **Retire `assignDriverToBooking`** (the old gen-1 dispatcher) so dispatch has
      a single owner (`onBookingCreated`). Confirm no double-dispatch.
- [ ] `processSquarePayment` / `captureSquarePayment` / `refundSquarePayment`
      (deploy the **hardened** repo versions — still pointed at sandbox)

Deploy the side-apps codebase independently (whenever; doesn't affect ApexVIP):
```sh
firebase deploy --only functions:side-apps
```

### B5. App Check + auth providers
- [ ] Firebase Console → App Check: register **reCAPTCHA v3**, set
      `APEXVIP_RECAPTCHA_KEY` in each app, **enforce** on Firestore + Functions.
- [ ] Authentication → enable Email/Password (+ Google/Apple); add the production
      domain(s) to **Authorized domains**.
- [ ] Set `role: 'admin'` / `role: 'driver'` on staff/driver user docs (custom
      claims optional as a backup path).

### B6. Reliability
- [ ] Point `reportError()` at Sentry/Crashlytics (DSN).
- [ ] Uptime/alerting on the Functions; verify SendGrid sender + Twilio number.
- [ ] Generate Web Push VAPID key → `APEXVIP_VAPID_KEY`.
- [ ] Full a11y pass (`apexvip-reliability-a11y.md`).

### B7. Flip payments to production — **the money switch**
Only after B1–B6 verify clean **and** Track A is green:
```sh
# functions/.env → SQUARE_ENV=production
firebase functions:secrets:set SQUARE_ACCESS_TOKEN     # PRODUCTION token
firebase deploy --only functions:apexvip:processSquarePayment,functions:apexvip:captureSquarePayment,functions:apexvip:refundSquarePayment
```
- [ ] Swap `SQUARE_APP_ID` / `SQUARE_LOCATION_ID` in `apexvip-client.html` to production.
- [ ] One real low-value end-to-end charge → capture on completion → refund. Confirm
      VAT-inclusive total, the 80% driver pay, and a VAT receipt.

### B8. Go live
- [ ] Real photography / final copy / verified partner data in place.
- [ ] iOS builds (if shipping native): `mobile/` → Xcode → TestFlight → App Store.
- [ ] Point production domain at the apps; announce.

---

## Rollback
- **Functions:** keep the recovered `*.zip`; redeploy the original gen-1 from its
  unpacked dir if a ported function misbehaves.
- **Payments:** set `SQUARE_ENV=sandbox` + redeploy the three payment functions to
  stop real charges immediately.
- **Rules:** `git revert` the rules change + `firebase deploy --only firestore:rules`.

## Definition of "live"
Track A all ✅ · B3 rules verified · B4 all functions are the hardened repo versions
with a single dispatcher · B5 App Check enforced · B7 one real charge+capture+refund
verified. Only then point the public at it.

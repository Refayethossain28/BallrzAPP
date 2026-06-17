# ApexVIP — Go-Live Checklist

Everything between the current build and a real, paid, UK-operating launch.
Items marked **[code done]** ship in the repo; the rest are operator/legal work.

## 0. Legal & regulatory (blockers — cannot launch without)
- [ ] **TfL Private Hire Vehicle (PHV) Operator licence** + licensed drivers & vehicles.
- [ ] **DBS-checked, vetted drivers**; hire & reward / operator **insurance**.
- [ ] **Solicitor sign-off** on Terms & Privacy; fill placeholders (company no.,
      ICO reg `ZA…`, TfL licence no., VAT no.). **[draft copy done]**
- [ ] ICO registration; named **DPO**.

## 1. Auth & security  **[code done — PR #49]**
- [ ] Enable sign-in providers (Email/Password, Google, Apple) in Firebase Console.
- [ ] **App Check** — register reCAPTCHA v3, set `APEXVIP_RECAPTCHA_KEY` in
      `firebase.js`, enforce on Firestore/Functions.
- [ ] Add production domain(s) to Authentication → Authorized domains.
- [ ] Deploy rules: `firebase deploy --only firestore:rules`.
- [ ] Set `admin` / `driver` custom claims for staff/driver accounts.

## 2. Payments  **[client SCA + functions scaffold done — PR #50, this PR]**
- [ ] `firebase functions:secrets:set SQUARE_ACCESS_TOKEN`; set `SQUARE_ENV`,
      `SQUARE_LOCATION_ID` in `functions/.env`.
- [ ] Deploy: `firebase deploy --only functions:processSquarePayment,functions:captureSquarePayment,functions:refundSquarePayment`.
- [ ] Swap `SQUARE_APP_ID` / `SQUARE_LOCATION_ID` in `apexvip-client.html` to production.
- [ ] **Recompute the fare server-side** before charging (don't trust the client amount).
- [ ] Wire **capture** on trip completion and **refunds** to the cancellation policy.
- [ ] Migrate Apple/Google Pay to the Square wallet SDK; register Apple merchant ID.
- [ ] VAT receipts (net/VAT/gross + VAT number).

## 3. Live hotel rates  **[function scaffold done]**
- [ ] `firebase functions:secrets:set AMADEUS_CLIENT_ID AMADEUS_CLIENT_SECRET`.
- [ ] Deploy `getHotelRates`; confirm licensing to display partner rates.

## 4. Notifications  **[booking email/SMS function done]**
- [ ] Generate Web Push VAPID key → `APEXVIP_VAPID_KEY` in `firebase.js`.
- [ ] `firebase functions:secrets:set SENDGRID_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN`;
      set `NOTIFY_FROM_EMAIL` / `TWILIO_FROM_NUMBER` in `functions/.env`.
- [ ] Deploy: `firebase deploy --only functions:onBookingWrite`. SendGrid verified
      sender + Twilio number required; each channel is optional.

## 5. Reliability & quality  **[code done — PR #51 + this PR]**
- [ ] Point `reportError()` at Sentry/Crashlytics (DSN).
- [ ] Uptime monitoring + alerting on the Functions.
- [ ] **Tests**: `npm test` runs smoke + Omni + ApexVIP core unit tests.
      Extend coverage to booking/payment flows (ideally with Playwright e2e).
- [ ] Accessibility: finish the manual WCAG 2.2 AA pass
      (`docs/apexvip-reliability-a11y.md`).

## 6. App presence
- [ ] PWA is live on Pages; for the stores, wrap as a native shell / TWA.
- [ ] Real photography, final copy, verified partner/hotel data.

## Deploy reference
```sh
# from repo root
firebase deploy --only firestore:rules
firebase deploy --only functions:getHotelRates,functions:processSquarePayment,functions:captureSquarePayment,functions:refundSquarePayment,functions:onBookingWrite
```
> The other functions (`parseBookingIntent`, …) live in a separate codebase — always
> scope deploys with `--only` so you never delete what this repo can't see.

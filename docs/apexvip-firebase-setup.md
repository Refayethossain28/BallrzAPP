# ApexVIP — Firebase Setup (make it production-real)

The app already connects to a real Firebase project (`apexvip-1b4a9` in `firebase.js`),
but it runs in **fallback mode** until the server side is configured and deployed. This
is the exact, ordered sequence to make it production-real. All of it needs the Firebase
**Console** and an authenticated `firebase` **CLI** — it can't be done from the repo alone.

> **Selling or handing over?** Create a **fresh** Firebase project and put its config in
> `firebase.js`, rather than transferring the current dev project. Rotate any keys.

## 0. Prerequisites
```sh
npm i -g firebase-tools
firebase login
firebase use apexvip-1b4a9     # or your new project id
```
`.firebaserc` already points at `apexvip-1b4a9` — edit it for a new project.

## 1. Enable Authentication providers
Console → Authentication → Sign-in method: enable **Email/Password**, **Google**, and
**Apple** (Apple needs an Apple Developer Services ID + key). Add your production domain
(e.g. `refayethossain28.github.io`) under **Authorized domains**.

## 2. Deploy security rules + indexes  **[in repo]**
```sh
firebase deploy --only firestore:rules,firestore:indexes
```
- `firestore.rules` — secure-by-default access (per-user, booking-scoped, admin/driver claims).
- `firestore.indexes.json` — the composite indexes the app's queries need (bookings by
  client/ref, client/status/createdAt, ref/driver; jobs by driver/status; open_jobs by
  status/market). Without these, those queries fail in production.

## 3. Deploy the Cloud Functions  **[in repo: `functions/`]**
```sh
# secrets (only the ones you use)
firebase functions:secrets:set AMADEUS_CLIENT_ID AMADEUS_CLIENT_SECRET   # live hotel rates
firebase functions:secrets:set SQUARE_ACCESS_TOKEN                        # card charges
firebase functions:secrets:set SENDGRID_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN  # notifications
# non-secret config in functions/.env (see functions/.env.example)

firebase deploy --only functions:getHotelRates,functions:processSquarePayment,functions:captureSquarePayment,functions:refundSquarePayment,functions:onBookingWrite,functions:onBookingCreated
```
> Scope with `--only` — the project's other functions (`parseBookingIntent`, …) live in a
> separate codebase; a bare deploy could delete what this repo can't see.

## 4. Seed pricing + demo accounts  **[in repo: `firebase-setup/`]**
Download a service-account key (Console → Project settings → Service accounts → Generate),
then:
```sh
cd firebase-setup
npm install
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json npm run seed
```
This writes `settings/pricing` (so you can tune fares without a deploy) and creates the
demo `client@ / driver@ / admin@apexvip.com` accounts with the right custom claims.
**Change `DEMO_PASSWORD` and these accounts before real use.**

## 5. App Check (anti-abuse)
Console → App Check → register the web app with **reCAPTCHA v3**; paste the site key into
`APEXVIP_RECAPTCHA_KEY` in `firebase.js`; then **enforce** App Check on Firestore & Functions.

## 6. Push notifications
Console → Project settings → Cloud Messaging → Web Push certificates → generate a key pair;
paste into `APEXVIP_VAPID_KEY` in `firebase.js`.

## 7. Payments to production
Swap the Square **sandbox** ids in `apexvip-client.html` (`SQUARE_APP_ID`,
`SQUARE_LOCATION_ID`) for production, and set `SQUARE_ENV=production` in `functions/.env`.

---

### After this, what changes
| Feature | Before (fallback) | After |
|---|---|---|
| Sign-in | demo account / email-password only | Email + Google + Apple, verified, App-Check-protected |
| Data access | whatever the console default rules are | locked-down rules + indexes deployed |
| Hotel prices | local estimate | live Amadeus rates |
| Card payment | token stored, not charged | real pre-auth → capture → refund |
| Booking updates | none | email + SMS across the lifecycle |
| Pricing | built-in defaults | `settings/pricing` (tunable live) |

Full launch context (incl. legal/licensing blockers) is in
[`apexvip-go-live-checklist.md`](./apexvip-go-live-checklist.md).

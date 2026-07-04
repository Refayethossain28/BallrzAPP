# ApexVIP — staging environment

Today every deploy — rules, functions, secrets — lands on the one production
Firebase project (`apexvip-1b4a9`), the same database real members use. A
staging project is the single biggest safety upgrade available: changes get
rehearsed against a disposable copy of the backend before they can touch a
member's money or data.

The repo is already wired for it: `.firebaserc` defines a `staging` alias
(`apexvip-staging`) and `functions` has a `deploy:staging` script. What remains
is one-time project creation, which needs the Google account that owns the org.

## One-time setup (~15 minutes)

1. **Create the project** — [console.firebase.google.com](https://console.firebase.google.com)
   → Add project → name it `apexvip-staging` (if the id is taken, pick another
   and update `.firebaserc`).
2. **Enable the same primitives** as production:
   - Firestore (production mode — the rules deploy will lock it down)
   - Authentication → Email/Password, Google, Anonymous
   - App Check can stay off on staging
3. **Register a web app** in the staging project and note its config snippet.
4. **Secrets** — set test-grade keys only (never production Stripe keys):
   ```sh
   firebase functions:secrets:set ANTHROPIC_API_KEY --project staging
   firebase functions:secrets:set STRIPE_SECRET_KEY --project staging   # sk_test_… only
   ```
5. **First deploy:**
   ```sh
   firebase deploy --only firestore:rules --project staging
   npm --prefix functions run deploy:staging
   ```

## Pointing an app at staging

Each front-end reads its Firebase config from one file. To run any app against
staging, swap the config object for the staging web-app snippet from step 3:

| App | Config file |
|---|---|
| ApexVIP client / driver / admin | `firebase.js` |
| Concierge + Ops | `concierge/config.js` |
| Ripple | `ripple/config.js` |

Do this on a branch (or locally, uncommitted) — `main` must keep production
config, because GitHub Pages serves `main` to real users.

## Suggested workflow once it exists

- **Backend PRs** (functions/, firestore.rules): deploy to staging from the
  branch, exercise the change (the e2e suite can run against a locally-served
  front-end pointed at staging), then merge → deploy to production.
- **CI idea (later):** a `FIREBASE_SERVICE_ACCOUNT_STAGING` repo secret and a
  workflow that deploys every PR's backend to staging automatically. Keep
  production deploys manual or `main`-only.
- **Data hygiene:** staging data is disposable. Never copy production member
  data into it.

## Monitoring production (related, do once)

In [Cloud Monitoring](https://console.cloud.google.com/monitoring?project=apexvip-1b4a9)
create an alert on Cloud Functions error rate (e.g. `velvetStripeWebhook`,
`parseBookingIntent` > 5 errors / 5 min → email). The client apps report
crashes to the `errors` collection (visible in the admin console), but only an
alert catches a silently failing webhook.

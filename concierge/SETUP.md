# ApexVIP Concierge — cloud setup (accounts, sync, real Stripe billing)

The app (branded **ApexVIP**; internal codename `velvet`) works fully offline with zero setup — membership, billing simulation and
the concierge desk all run on-device. This guide turns on the optional cloud:
**real accounts**, **cross-device sync over Firestore**, and **real subscription
payments through Stripe Billing**.

The app degrades gracefully at every step: no config → pure offline demo; config
but nothing deployed → offline demo with a "cloud unreachable" note; functions
deployed without Stripe keys → server-granted mock trials; keys set → real money.

## 1. Firebase (accounts + sync)

The app reuses the `apexvip-1b4a9` project already configured in
[`config.js`](./config.js) and keeps its data in separate `velvet_*` collections
(it never touches the ApexVIP data). To use a different project, paste that
project's web config into `config.js`.

One-time console/CLI steps:

1. **Authentication → Sign-in method** → enable **Email/Password** and
   **Anonymous** (guest mode).
2. Deploy the security rules (the `velvet_*` sections live in
   [`../firestore.rules`](../firestore.rules)):

   ```sh
   firebase deploy --only firestore:rules
   ```

That's it — the app's **Club → Account & sync** card (and "Already a member?
Sign in" on the paywall) now signs members in, mirrors their membership to
`velvet_members/{uid}` and each request to `velvet_requests/{id}`, and live-syncs
across devices. Conflicts are resolved by the pure, unit-tested merge helpers in
[`engine.js`](./engine.js) (`mergeStates` / `mergeRequests`).

**A real concierge desk:** requests are plain Firestore docs, so an operator
(any user whose `users/{uid}` profile has `role: 'admin'`) can progress a
request's `status` and append to its `messages` array from the Firebase console
or an ops tool — the member sees it in their thread in real time.

## 2. Cloud Functions (billing backend)

The concierge backend lives in [`../functions/src/velvet.ts`](../functions/src/velvet.ts)
and deploys with the rest of the ApexVIP functions:

```sh
cd functions && npm run deploy
```

Three functions ship:

| Function | Purpose |
|---|---|
| `createVelvetCheckout` | Stripe Checkout session (subscription mode, 7-day trial) |
| `createVelvetPortal` | Stripe Billing Portal (upgrade / downgrade / cancel / cards) |
| `velvetStripeWebhook` | Mirrors Stripe truth into `velvet_members/{uid}` |

With **no Stripe key set**, `createVelvetCheckout` runs in **mock mode**: the
server itself writes a trial into the member doc (`billing: 'stripe-mock'`), so
the whole loop is exercisable before Stripe is connected.

**ApexAI on the desk**: the concierge request chat is answered live by **ApexAI** —
the same `parseBookingIntent` function that powers the ApexVIP client's
assistant, in a dedicated concierge persona (`mode: 'velvet'`). It needs
the `ANTHROPIC_API_KEY` secret (already used by ApexVIP):

```sh
firebase functions:secrets:set ANTHROPIC_API_KEY
```

If the function is unreachable or the key is unset, the chat falls back to the
scripted desk acknowledgement — nothing breaks. ApexAI never issues options,
prices or confirmations; those still come only from the desk lifecycle.

## 3. Stripe (real money)

1. Set the secrets:

   ```sh
   firebase functions:secrets:set STRIPE_SECRET_KEY      # sk_test_… first!
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET  # whsec_… (from step 3)
   ```

2. Redeploy the functions.
3. In the Stripe dashboard → **Developers → Webhooks**, add an endpoint pointing
   at the deployed `velvetStripeWebhook` URL
   (`https://us-central1-<project>.cloudfunctions.net/velvetStripeWebhook`)
   with these events: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy.

No product setup is needed: prices are created on first checkout by lookup key
(`velvet_silver_monthly` £49 / `velvet_gold_monthly` £199 /
`velvet_black_monthly` £499 — defined server-side in `velvet.ts`, matching
`engine.js`; the client can never choose an amount).

A signed-in member then taps **Club → Activate real billing** → hosted Stripe
Checkout (card `4242 4242 4242 4242` in test mode). From that moment:

- the webhook writes the subscription (`billing: 'stripe'`) and paid invoices
  (with points) into Firestore;
- the app stops simulating renewals and renders whatever the server says;
- plan changes and cancellation happen in the **Stripe Billing Portal**
  ("Manage billing" button) — enable the portal once at
  dashboard → Settings → Billing → Customer portal;
- the security rules block any client write that would change `billing`,
  `sub` or the Stripe linkage fields, so a member cannot self-grant a tier.

## Production hardening checklist

- Swap `sk_test_…` for the live key and re-point the webhook at live mode.
- Enable **App Check** on the Firebase project (the ApexVIP setup doc covers it).
- Restrict the Billing Portal configuration to the three concierge prices so a
  member can't switch onto an unrelated product.
- The demo's on-device billing remains available to signed-out users by design;
  gate the paywall behind sign-in if you want cloud-only membership.

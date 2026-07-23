# Cortex Pro — cloud setup (accounts + real Stripe billing)

Cortex works fully offline with zero setup — the drills, ratings, streak and
the **Cortex Pro** membership demo all run on-device. This guide turns on the
optional cloud: **real accounts** and **real subscription payments through
Stripe Billing**. It follows the exact same pattern as the concierge app
([`../concierge/SETUP.md`](../concierge/SETUP.md)).

The app degrades gracefully at every step: no config → pure offline demo;
config but nothing deployed → offline demo with cloud sign-in unavailable;
functions deployed without Stripe keys → server-granted mock trials; keys
set → real money.

## The product

| | Free | Cortex Pro |
|---|---|---|
| Daily 3-drill workout | ✓ always | ✓ always |
| Streak, Brain Index, ratings | ✓ | ✓ |
| Free-play sessions | 1 / day | **Unlimited** |
| Price | — | **£3.99/mo**, 7-day free trial |

The daily workout is deliberately never paywalled — it's the habit loop that
makes the product work. Pro sells *more training*, not access to the basics.

## 1. Firebase (accounts)

The app reuses the `apexvip-1b4a9` project already configured in
[`config.js`](./config.js) and keeps its data in a separate `cortex_members`
collection. To use a different project, paste that project's web config into
`config.js`.

One-time console/CLI steps:

1. **Authentication → Sign-in method** → enable **Email/Password** and
   **Anonymous** (guest mode).
2. Deploy the security rules (the `cortex_members` section lives in
   [`../firestore.rules`](../firestore.rules)):

   ```sh
   firebase deploy --only firestore:rules
   ```

The Pro sheet (✦ Pro chip in the header) now signs members in and mirrors the
membership to `cortex_members/{uid}`, so it follows the member across devices.

## 2. Cloud Functions (billing backend)

The Cortex backend lives in [`../functions/src/cortex.ts`](../functions/src/cortex.ts)
and deploys with the rest of the ApexVIP functions:

```sh
cd functions && npm run deploy
```

Three functions ship:

| Function | Purpose |
|---|---|
| `createCortexCheckout` | Stripe Checkout session (subscription mode, 7-day trial) |
| `createCortexPortal` | Stripe Billing Portal (cancel / cards / invoices) |
| `cortexStripeWebhook` | Mirrors Stripe truth into `cortex_members/{uid}` |

With **no Stripe key set**, `createCortexCheckout` runs in **mock mode**: the
server itself writes a trial into the member doc (`billing: 'stripe-mock'`),
so the whole loop is exercisable before Stripe is connected.

## 3. Stripe (real money)

1. Set the secrets (shared with the other apps' billing):

   ```sh
   firebase functions:secrets:set STRIPE_SECRET_KEY      # sk_test_… first!
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET  # whsec_… (from step 3)
   ```

2. Redeploy the functions.
3. In the Stripe dashboard → **Developers → Webhooks**, add an endpoint
   pointing at the deployed `cortexStripeWebhook` URL
   (`https://us-central1-<project>.cloudfunctions.net/cortexStripeWebhook`)
   with these events: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`.
   Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy.

No product setup is needed: the price is created on first checkout by lookup
key (`cortex_pro_monthly`, £3.99/mo — defined server-side in `cortex.ts`,
matching `engine.js` `PRO`; the client can never choose an amount).

A signed-in member then taps **✦ Pro → Start free trial — real billing** →
hosted Stripe Checkout (card `4242 4242 4242 4242` in test mode). From that
moment:

- the webhook writes the subscription (`billing: 'stripe'`) and paid invoices
  into Firestore;
- the app stops simulating renewals and renders whatever the server says;
- cancellation and card changes happen in the **Stripe Billing Portal**
  ("Manage billing" button) — enable the portal once at
  dashboard → Settings → Billing → Customer portal;
- the security rules block any client write that would change `billing`,
  `sub` or the Stripe linkage fields, so a member cannot self-grant Pro.

## Production hardening checklist

- Swap `sk_test_…` for the live key and re-point the webhook at live mode.
- Enable **App Check** on the Firebase project.
- Restrict the Billing Portal configuration to the Cortex price so a member
  can't switch onto an unrelated product.
- The demo's on-device billing remains available to signed-out users by
  design; gate the paywall behind sign-in if you want cloud-only membership.
- Before charging the public: a terms-of-service + privacy policy page, a
  support contact, and UK VAT registration for digital services.

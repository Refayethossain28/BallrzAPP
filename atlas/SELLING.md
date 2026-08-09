# Selling ⭐ Atlas Pro — fully automated

Money flow, end to end, with nobody in the loop:

```
buyer clicks your Stripe Payment Link (£14.99)
  → Stripe takes payment, fires a webhook
  → atlasProWebhook (Cloud Function) verifies it came from Stripe,
    mints a unique ATLS-XXXX-XXXX-CC code, records the sale in
    Firestore (atlas_pro_sales), and emails the code to the buyer
  → buyer types the code into Atlas → it verifies on their phone,
    offline, forever
```

Stripe retries webhooks; the Firestore ledger doubles as idempotency, so a
retry can never mint a second code or send a second email.

## One-time setup (~20 minutes)

### 1. Stripe
1. Create a [stripe.com](https://stripe.com) account (or use an existing one).
2. **Products → Add product**: "Atlas Pro", one-off, **£14.99**.
3. **Payment Links → New**: pick the product. Under **Metadata** add
   `product` = `atlas-pro` — this is how the webhook knows the sale is Atlas
   Pro and not something else. Turn on "Collect customers' email addresses"
   (it's the default).
4. Put the link behind the app: share it anywhere, or link it from the Pro
   sheet later.

### 2. Deploy the function
```sh
cd functions
firebase functions:secrets:set STRIPE_SECRET_KEY     # sk_live_… from Stripe → Developers → API keys
npm run deploy
```
The deploy prints the function URL, e.g.
`https://us-central1-apexvip-1b4a9.cloudfunctions.net/atlasProWebhook`.

### 3. Point Stripe at it
Stripe → **Developers → Webhooks → Add endpoint**: paste the function URL,
select the single event `checkout.session.completed`, create it, then copy
its **signing secret** (`whsec_…`) and store it:
```sh
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
npm run deploy
```

### 4. Email
```sh
firebase functions:secrets:set SENDGRID_API_KEY      # sendgrid.com free tier is fine
```
The from-address defaults to `atlas@apexvip.uk` (override with the
`ATLAS_FROM_EMAIL` env var; verify the sender/domain in SendGrid so mail
lands in inboxes, not spam).

### 5. Test it
Stripe's webhook page has **Send test event** — or make a real £14.99
purchase yourself with the link and refund it. Check:
- Firestore → `atlas_pro_sales` has a doc with the code and `emailed: true`
- the email arrived; the code activates in Atlas → ⚙️ → ⭐ Atlas Pro

## If email ever fails
The sale is still recorded — the code sits in `atlas_pro_sales` with
`emailed: false`, so you can send it by hand. Nothing is ever lost between
payment and code.

## Manual codes (no Stripe needed)
`node scripts/gen-atlas-pro-codes.mjs 10` still prints valid codes any time —
for direct sales, refund-replacements, gifts, or reviewers.

## Why this is safe
- The webhook only acts on requests **signed by Stripe** (checked against
  `STRIPE_WEBHOOK_SECRET`) with `payment_status: paid`.
- Codes are checksum-verified at mint and on the phone; guessing one is a
  1-in-~850k shot per attempt with no server to brute-force.
- The server and the app mint/verify with the same maths — a parity test in
  `functions/src/logic.test.ts` runs both against each other on every CI run.

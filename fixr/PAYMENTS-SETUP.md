# Turn on real (test-mode) payments

Fixr already captures fares and settles drivers — in **mock** mode until you add a
Stripe key. Adding a Stripe **test** key makes the money flow real (test money, no
real charges), so you can demo capture + driver payout end to end.

> Same pattern as the Anthropic key: you create it in your own Stripe account and
> paste it into Render. Never send a secret key in a screenshot or chat — paste it
> straight into Render's Environment tab.

## 1. Get a Stripe test key (2 min)
1. Go to **dashboard.stripe.com** → sign up / log in.
2. Make sure the **"Test mode"** toggle (top-right) is **ON**.
3. **Developers → API keys** → copy the **Secret key** (it starts with `sk_test_…`).

That's all you need for charging fares. (Driver payouts use Stripe **Connect** — optional, see below.)

## 2. Add it to Render
1. Render → your **fixr** web service → **Environment** tab.
2. **Add Environment Variable**: key `STRIPE_SECRET_KEY`, value = your `sk_test_…` key.
3. **Save** → Render redeploys (~1–2 min).

## 3. Verify
Open `https://fixr-se8d.onrender.com/api/health` → it should now read:
```
"payments":"stripe"
```
Complete a trip in the console (or as a passenger) and the fare is captured as a
real Stripe **test** PaymentIntent — visible in your Stripe Dashboard → Payments
(in Test mode). Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.

## What works with just the secret key
- **Fare capture** — real test PaymentIntents.
- **The split math** — platform fee + driver share + operator net are computed and recorded.

## Optional: real driver payouts (Stripe Connect)
Moving the driver's cut as an actual transfer needs **Connect** enabled:
1. Stripe Dashboard → **Connect** → enable it (test mode).
2. In Fixr, a driver taps **"set up payouts"** (operator console) or the banner in the
   driver app → completes Stripe's hosted onboarding → gets a `acct_…` id.
3. On trip completion, the driver's share moves as a real Connect **transfer** to that
   account. Until a driver onboards, the share is computed and marked "pending onboarding."

## Going truly live (later, when charging real money)
Swap the `sk_test_…` key for your **live** key (`sk_live_…`) only when you're ready to
take real payments — and make sure your Stripe account has completed business
verification. Keep test mode for all demos.

## Safety
- `STRIPE_SECRET_KEY` is a password to move money. Only ever paste it into Render's
  Environment tab (stored encrypted). Don't commit it, screenshot it, or share it.
- Test keys can't touch real money, so they're safe for demos — but treat the live
  key with maximum care.

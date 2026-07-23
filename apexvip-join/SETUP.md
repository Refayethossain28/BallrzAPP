# ApexVIP founding-members landing page — go live in ~5 minutes

This page (`apexvip-join/index.html`) exists to **validate demand** before you
commit to running a concierge service: a cinematic landing page that collects
email signups from people who want in. Get real signups first — *then* staff the
desk.

Live at: **https://refayethossain28.github.io/BallrzAPP/apexvip-join/**

## Step 1 — wire up the signups (required before sharing)

Out of the box the form confirms to visitors but only stores signups in *their*
browser — so you must connect it to something that reaches you. Two options:

### Option A — Formspree (recommended, ~2 min, gives you a dashboard)
1. Go to **[formspree.io](https://formspree.io)** → sign up (free tier: 50
   submissions/month) → **New form**.
2. Copy the endpoint it gives you, e.g. `https://formspree.io/f/abcdwxyz`.
3. In `apexvip-join/index.html`, find the `CONFIG` block near the bottom and set:
   ```js
   var CONFIG = {
     formEndpoint: 'https://formspree.io/f/abcdwxyz',
     contactEmail: ''
   };
   ```
4. Commit and push. Every signup now lands in your Formspree inbox with the
   email **and** which tier they wanted — that tier split is your best demand
   signal.

### Option B — just your email (instant, no account)
Set `contactEmail` to an address you own (a dedicated one is wise — it becomes
public in the page source):
```js
var CONFIG = { formEndpoint: '', contactEmail: 'founders@yourdomain.com' };
```
Submissions open the visitor's mail app addressed to you. Simpler, but higher
drop-off than Option A and no dashboard.

> Any form service works (Basin, Getform, Google Forms' `formResponse` URL) —
> anything that accepts a POST. Formspree is just the shortest path.

## Step 2 — share it and watch

Post the link where your would-be members are. A good honest hook:

> Launching a members-only concierge — one membership, everything handled
> (travel, dining, events, chauffeur, and more). Founding cohort of 50, launch
> pricing locked for life, first month free. Reserve a spot: <link>

## Step 3 — read the result honestly

- **Lots of signups, skewed to a tier?** You have real demand and a starting
  price point. *Now* it's worth staffing the desk — start with those founders,
  serve them by hand, and turn on the real Stripe billing (see
  [`../concierge/SETUP.md`](../concierge/SETUP.md), which is already built).
- **Crickets?** You just saved yourself months of building fulfilment for
  something nobody wanted. Change the pitch, the price, or the idea — cheaply.

That's the whole point of this page: **learn whether people want it before you
promise to provide it.**

## Notes

- No card is taken and nothing is charged here — this is a waitlist, which keeps
  you well clear of any payments/regulatory obligations until you deliberately
  switch on billing.
- The page is a single static file: no build, no dependencies, published to
  GitHub Pages automatically like the rest of the site.

# RentMatch — launch & hardening checklist (M7)

What's in place after M7, and what must be wired with live credentials before a
public launch. The shared domain kernel is unit-tested (`npm test`, 44 tests);
the app/functions need `npm install`, the Firebase Emulator Suite and live keys
to run end-to-end.

## Security
- [x] **Server-authoritative writes** — stage, signatures, payment, contract and
      listing `status` are written only by Cloud Functions; Firestore rules deny
      these from clients.
- [x] **App Check** (reCAPTCHA v3) initialised in the web app when a site key is
      set. — [ ] Turn on **enforcement** for Firestore, Functions and Storage in
      the Firebase console before launch.
- [x] Stripe webhook **signature verification**; payment idempotency keyed by
      deal id.
- [ ] Rotate all keys; store Stripe/e-sign secrets in Secret Manager, not `.env`.

## Payments & contracts (real integrations)
- [x] Stripe SetupIntent (save card) + off-session PaymentIntent for the £100 fee.
- [ ] Replace the **demo e-sign** stand-in (`openSigning`/`recordSignature`) with
      the provider's hosted signing + verified webhook (SignWell/Dropbox Sign/
      DocuSign). The deal model and completion guard are already provider-shaped.
- [ ] Generate and store the executed PDF in Storage; attach to the receipt.
- [ ] Connect a deposit-protection scheme (DPS/mydeposits/TDS) + the 30-day clock.

## GDPR / data protection
- [x] **Right to erasure** (`requestDataErasure`) — redacts profile PII and names
      across deals, retaining completed-tenancy records within their legal window.
- [x] **Retention sweep** (`purgeStaleData`, daily) — purges stale drafts (90d)
      and abandoned enquiries (180d); completed tenancies kept ~7 years.
- [ ] Publish a privacy policy + ROPA; confirm lawful basis per data category.
- [ ] DPA with Stripe, the e-sign provider and the email provider.

## Notifications
- [x] FCM push on new messages (`onDealMessageCreated`) + opt-in token registration.
- [ ] Wire the **email** seam (`sendEmail`) to a provider (Postmark/SendGrid) for
      receipts, signature requests and viewing reminders.

## Ops & quality
- [ ] CI: run `npm test` (kernel), `tsc --noEmit` (web + functions), Playwright e2e
      against the emulator suite, then deploy to a Firebase preview channel.
- [x] Playwright happy-path scaffold (`apps/web/e2e`).
- [ ] Error monitoring (Sentry) + structured function logs + alerting.
- [ ] Load/seed script for demo data.

## Jurisdiction
- [x] MVP is **England** (AST). Tenancy type is already a function of nation.
- [ ] Add Wales (occupation contract), Scotland (PRT) and NI templates + gates.

# ApexVIP — Payments

Card payments use the **Square Web Payments SDK** (client tokenization) plus a
server-side **`processSquarePayment`** Cloud Function that holds the Square access
token and performs the charge. The browser never sees the card number (PCI SAQ-A).

## What the client now sends

`runSquarePayment()` (card form):
1. `card.tokenize()` → single-use `sourceId`.
2. **SCA / 3-D Secure** — `payments.verifyBuyer(sourceId, { amount, currencyCode:'GBP', intent:'CHARGE', billingContact })` → `verificationToken`. Required for UK/EU Strong Customer Authentication.
3. Generates an **idempotency key** (one per attempt) so a retry can never double-charge.
4. Calls `processSquarePayment({ sourceId, verificationToken, idempotencyKey, amount, currency:'GBP', bookingRef })`.

If the function is unavailable it stores the token + idempotency key in
`pending_payments` for server-side processing, so no charge is silently lost.

## Server contract (`processSquarePayment` — to implement in your Functions repo)

```js
// Pseudocode — Square Node SDK
const { result } = await squareClient.paymentsApi.createPayment({
  sourceId,                      // from client
  verificationToken,             // SCA result from client (pass through)
  idempotencyKey,                // from client — pass straight to Square
  amountMoney: { amount: BigInt(Math.round(amount * 100)), currency: 'GBP' },
  autocomplete: false,           // PRE-AUTH: authorize now, capture on trip completion
  referenceId: bookingRef,
  customerId,                    // optional, for saved cards
});
return { paymentId: result.payment.id, status: result.payment.status };
```

Then **capture** when the trip completes (`paymentsApi.completePayment(paymentId)`),
and support **refunds** (`refundsApi.refundPayment`) for the cancellation policy.

### Setup
- Store secrets: `firebase functions:secrets:set SQUARE_ACCESS_TOKEN` (and location id).
- Use **sandbox** credentials first; the client app id / location id live in
  `apexvip-client.html` (`SQUARE_APP_ID`, `SQUARE_LOCATION_ID`) — swap to production
  values for launch.
- Verify the buyer/amount server-side; never trust the client amount — recompute the
  fare from your pricing settings before charging.

## VAT receipts
Prices include 20% UK VAT. The booking confirmation/receipt should show the VAT
breakdown (net + VAT + gross) and your VAT registration number once issued.

## Apple Pay / Google Pay (follow-up)
The current Apple Pay path uses a raw `ApplePaySession` and is a placeholder. For
production, migrate to the Square Web Payments SDK wallet methods
(`payments.applePay()` / `payments.googlePay()`), which return a `sourceId` you pass
to the **same** `processSquarePayment` function — wallets satisfy SCA, so no separate
`verifyBuyer` step is needed. Apple Pay also needs a registered merchant ID and the
`validateApplePayMerchant` function.

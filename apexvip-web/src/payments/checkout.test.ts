import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheckout, type CheckoutDeps, type CardTokenizeResult } from './checkout.ts';

const buyer = { name: 'Jane Doe', email: 'jane@example.com' };

/** Build deps with sensible happy-path stubs, overridable per test. */
function deps(over: Partial<CheckoutDeps> = {}): CheckoutDeps {
  return {
    tokenize: async (): Promise<CardTokenizeResult> => ({ status: 'OK', token: 'src_tok' }),
    verifyBuyer: async () => ({ token: 'sca_tok' }),
    backend: { processSquarePayment: async () => ({ paymentId: 'pay_123', status: 'APPROVED', receiptUrl: null }) },
    storePending: async () => {},
    newIdempotencyKey: () => 'idem-1',
    newBookingRef: () => 'APX-1234',
    ...over,
  };
}

test('card tokenization failure surfaces a card error and does not charge', async () => {
  let charged = false;
  const r = await runCheckout(185, buyer, deps({
    tokenize: async () => ({ status: 'INVALID', errors: [{ message: 'Card declined' }] }),
    backend: { processSquarePayment: async () => { charged = true; return { paymentId: 'x', status: 'OK', receiptUrl: null }; } },
  }));
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'card_error');
  assert.equal(r.error, 'Card declined');
  assert.equal(charged, false);
});

test('happy path charges via the backend and returns the payment id', async () => {
  let sentToken: string | undefined;
  let sentIdem: string | undefined;
  const r = await runCheckout(185, buyer, deps({
    backend: {
      processSquarePayment: async (d) => {
        sentToken = d.verificationToken;
        sentIdem = d.idempotencyKey;
        return { paymentId: 'pay_123', status: 'APPROVED', receiptUrl: null };
      },
    },
  }));
  assert.deepEqual(r, { ok: true, ref: 'APX-1234', paymentId: 'pay_123', outcome: 'charged' });
  assert.equal(sentToken, 'sca_tok'); // SCA token threaded through to the charge
  assert.equal(sentIdem, 'idem-1');   // idempotency key threaded through
});

test('SCA failure is non-fatal — charge proceeds without a verification token', async () => {
  let sentToken: string | undefined = 'unset';
  const r = await runCheckout(185, buyer, deps({
    verifyBuyer: async () => { throw new Error('3DS unavailable'); },
    backend: {
      processSquarePayment: async (d) => { sentToken = d.verificationToken; return { paymentId: 'pay_9', status: 'OK', receiptUrl: null }; },
    },
  }));
  assert.equal(r.outcome, 'charged');
  assert.equal(sentToken, undefined);
});

test('backend error stores the token in pending_payments for manual capture', async () => {
  let stored: unknown = null;
  const r = await runCheckout(185, buyer, deps({
    backend: { processSquarePayment: async () => { throw new Error('functions down'); } },
    storePending: async (req) => { stored = req; },
  }));
  assert.equal(r.outcome, 'stored_pending');
  assert.equal(r.paymentId, null);
  assert.deepEqual(stored, {
    sourceId: 'src_tok', verificationToken: 'sca_tok', idempotencyKey: 'idem-1',
    amount: 185, currency: 'GBP', bookingRef: 'APX-1234', status: 'pending',
  });
});

test('no backend (offline) resolves to demo mode', async () => {
  const r = await runCheckout(185, buyer, deps({ backend: null }));
  assert.equal(r.outcome, 'demo');
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'APX-1234');
});

import { useState, type FormEvent } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { formatGBP, PLATFORM_FEE_PENCE } from '@rentmatch/shared';
import { createSetupIntent, chargePlatformFee } from '../lib/functions';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '');

/**
 * The £100 landlord fee. Two steps: save a card (Stripe SetupIntent +
 * CardElement), then charge it off-session via the Cloud Function. The deal
 * completes server-side; the live deal subscription flips the UI to "in force".
 */
export default function PaymentPanel({ dealId }: { dealId: string }) {
  return (
    <Elements stripe={stripePromise}>
      <Inner dealId={dealId} />
    </Elements>
  );
}

function Inner({ dealId }: { dealId: string }) {
  const stripe = useStripe();
  const elements = useElements();
  const [cardSaved, setCardSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function saveCard(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    const card = elements.getElement(CardElement);
    if (!card) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await createSetupIntent();
      const result = await stripe.confirmCardSetup(data.clientSecret, { payment_method: { card } });
      if (result.error) throw new Error(result.error.message ?? 'Card could not be saved.');
      setCardSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Card could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setBusy(true);
    setError('');
    try {
      await chargePlatformFee({ dealId });
      // success flips the deal to completed server-side; the subscription updates the view.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card"><div className="body">
      <div className="row center" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <b>Platform fee</b><span className="price">{formatGBP(PLATFORM_FEE_PENCE)}</span>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: '0 0 12px' }}>
        Charged once, on full execution of the tenancy. Renters are never charged.
      </p>

      {!cardSaved ? (
        <form onSubmit={saveCard}>
          <div style={{ background: 'var(--bg1)', border: '1px solid var(--line)', borderRadius: 11, padding: 12, marginBottom: 10 }}>
            <CardElement options={{ style: { base: { color: '#eaf0ff', fontSize: '15px', '::placeholder': { color: '#65739b' } } } }} />
          </div>
          {error && <p className="error" style={{ marginBottom: 10 }}>{error}</p>}
          <button className="cta" type="submit" disabled={busy || !stripe}>
            {busy ? 'Saving…' : 'Save card'}
          </button>
        </form>
      ) : (
        <>
          {error && <p className="error" style={{ marginBottom: 10 }}>{error}</p>}
          <button className="cta" disabled={busy} onClick={pay}>
            {busy ? 'Charging…' : `Pay ${formatGBP(PLATFORM_FEE_PENCE)} & complete tenancy`}
          </button>
        </>
      )}
      <p className="faint" style={{ fontSize: 11, textAlign: 'center', marginTop: 10 }}>🔒 Stripe — card details never touch our servers.</p>
    </div></div>
  );
}

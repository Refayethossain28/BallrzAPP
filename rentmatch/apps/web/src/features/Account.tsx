import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  PLANS, PAID_PLAN_IDS, effectivePlan, isSubscriptionActive, formatGBP,
  type PlanId,
} from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { registerForPush } from '../lib/push';
import {
  requestDataErasure, createBillingCheckoutSession, createBillingPortalSession,
  createAgency, connectToAgency, disconnectFromAgency,
} from '../lib/functions';
import { fetchSubscription, fetchOwnedAgency, fetchConnectedAgencyId } from '../lib/db';

export default function Account() {
  const { profile, signOutUser } = useAuth();
  const [pushState, setPushState] = useState<'idle' | 'working' | 'on' | 'off'>('idle');
  const [erasing, setErasing] = useState(false);
  if (!profile) return null;

  async function enablePush() {
    setPushState('working');
    setPushState((await registerForPush()) ? 'on' : 'off');
  }

  async function eraseData() {
    if (!window.confirm('Erase your personal data? This redacts your name and email across Apex. Completed tenancy records are retained where the law requires. You will be signed out.')) return;
    setErasing(true);
    try {
      await requestDataErasure();
      await signOutUser();
    } finally {
      setErasing(false);
    }
  }

  return (
    <>
      <h2 className="title">Account</h2>
      <p className="sub">Signed in as {profile.displayName}</p>
      <div className="card"><div className="body">
        <Row k="Name" v={profile.displayName} />
        <Row k="Email" v={profile.email} />
        <Row k="Active role" v={profile.activeRole === 'renter' ? 'Renter' : 'Landlord'} />
      </div></div>

      <div className="section-t">Notifications</div>
      <button className="cta ghost" onClick={enablePush} disabled={pushState === 'working' || pushState === 'on'}>
        {pushState === 'on' ? '✓ Notifications enabled'
          : pushState === 'working' ? 'Enabling…'
          : pushState === 'off' ? 'Not available — try again'
          : '🔔 Enable push notifications'}
      </button>
      <p className="faint" style={{ fontSize: 11, margin: '8px 0 0' }}>
        Get notified about new messages, viewings and signatures.
      </p>

      {profile.activeRole === 'landlord' && <Billing uid={profile.uid} />}
      {profile.activeRole === 'landlord' && <AgencySection uid={profile.uid} />}

      <div className="notice" style={{ marginTop: 16 }}>
        On top of your plan, Apex charges landlords a one-off <b>£100</b> fee when a tenancy agreement is
        fully signed. Renters are never charged a fee (Tenant Fees Act 2019).
      </div>

      <div className="section-t">Privacy</div>
      <button className="cta ghost" disabled={erasing} onClick={eraseData}>
        {erasing ? 'Erasing…' : 'Erase my personal data'}
      </button>
      <p className="faint" style={{ fontSize: 11, margin: '8px 0 16px' }}>
        UK GDPR right to erasure. Completed tenancy records are kept where the law requires.
      </p>

      <button className="cta ghost" onClick={signOutUser}>Sign out</button>
    </>
  );
}

/** Subscription state + upgrade/manage actions, mirrored from Stripe. */
function Billing({ uid }: { uid: string }) {
  const [busy, setBusy] = useState<PlanId | 'portal' | null>(null);
  const [error, setError] = useState('');
  const { data: sub, isLoading } = useQuery({
    queryKey: ['subscription', uid],
    queryFn: () => fetchSubscription(uid),
  });

  const active = isSubscriptionActive(sub);
  const current = effectivePlan(sub);

  async function subscribe(plan: PlanId) {
    setBusy(plan);
    setError('');
    try {
      const { data } = await createBillingCheckoutSession({ plan });
      if (data.url) window.location.assign(data.url);
      else setError('Could not start checkout — please try again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout.');
    } finally {
      setBusy(null);
    }
  }

  async function manage() {
    setBusy('portal');
    setError('');
    try {
      const { data } = await createBillingPortalSession();
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open billing.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="section-t">Plan &amp; billing</div>
      <div className="card"><div className="body">
        <div className="row center" style={{ justifyContent: 'space-between' }}>
          <div>
            <b style={{ fontSize: 15 }}>{PLANS[current].name}</b>
            <div className="faint" style={{ fontSize: 12 }}>{PLANS[current].blurb}</div>
          </div>
          <span className={`pill ${active ? 'good' : 'warn'}`}>
            {isLoading ? '…' : active ? 'Active' : 'Free'}
          </span>
        </div>
      </div></div>

      {active ? (
        <button className="cta ghost" disabled={busy === 'portal'} onClick={manage}>
          {busy === 'portal' ? 'Opening…' : 'Manage billing'}
        </button>
      ) : (
        PAID_PLAN_IDS.map((plan) => (
          <button key={plan} className="cta ghost" style={{ marginBottom: 8 }}
            disabled={busy === plan} onClick={() => subscribe(plan)}>
            {busy === plan
              ? 'Starting…'
              : `Subscribe — ${PLANS[plan].name} · ${plan === 'agent' ? 'from ' : ''}${formatGBP(PLANS[plan].basePence)}/mo`}
          </button>
        ))
      )}
      {error && <p className="error">{error}</p>}
      <p className="faint" style={{ fontSize: 11, margin: '8px 0 0' }}>
        Compliance tracking is free for one property. Paid plans add more properties, tenancy e-signing and the document vault.
      </p>
    </>
  );
}

/** Agent: create/open an agency. Landlord: connect to one by code. */
function AgencySection({ uid }: { uid: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');

  const { data: owned } = useQuery({ queryKey: ['agency', uid], queryFn: () => fetchOwnedAgency(uid) });
  const { data: connectedTo } = useQuery({ queryKey: ['connected-agency', uid], queryFn: () => fetchConnectedAgencyId(uid) });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['agency', uid] });
    queryClient.invalidateQueries({ queryKey: ['connected-agency', uid] });
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await fn(); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="section-t">Agency</div>
      {owned ? (
        <>
          <button className="cta ghost" onClick={() => navigate('/landlord/agency')}>🏢 Open “{owned.name}” ({owned.clientLandlordIds.length} clients)</button>
          <p className="faint" style={{ fontSize: 11, margin: '8px 0 0' }}>Share your agency code from the agency screen so landlords can connect.</p>
        </>
      ) : connectedTo ? (
        <>
          <div className="card"><div className="body"><span style={{ fontSize: 13.5 }}>Your portfolio is connected to an agency.</span></div></div>
          <button className="cta ghost" disabled={busy} onClick={() => run(() => disconnectFromAgency())}>
            {busy ? 'Working…' : 'Disconnect from agency'}
          </button>
        </>
      ) : (
        <>
          <button className="cta ghost" style={{ marginBottom: 10 }} disabled={busy}
            onClick={() => run(() => createAgency({ name: 'My agency' }))}>
            {busy ? 'Working…' : 'Create an agency (for letting agents)'}
          </button>
          <div className="field"><label>Or connect to an agency by code</label>
            <input value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="Agency code" /></div>
          <button className="cta ghost" disabled={busy || !code}
            onClick={() => run(() => connectToAgency({ agencyId: code }))}>
            {busy ? 'Connecting…' : 'Connect my portfolio'}
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row center" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="muted">{k}</span><b>{v}</b>
    </div>
  );
}

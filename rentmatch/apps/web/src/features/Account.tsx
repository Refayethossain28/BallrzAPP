import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { registerForPush } from '../lib/push';
import { requestDataErasure } from '../lib/functions';

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

      <div className="notice" style={{ marginTop: 16 }}>
        Apex charges landlords a one-off <b>£100</b> fee when a tenancy agreement is fully signed.
        Renters are never charged a fee (Tenant Fees Act 2019).
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

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row center" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="muted">{k}</span><b>{v}</b>
    </div>
  );
}

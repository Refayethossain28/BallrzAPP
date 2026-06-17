import { useAuth } from '../auth/AuthProvider';

export default function Account() {
  const { profile, signOutUser } = useAuth();
  if (!profile) return null;
  return (
    <>
      <h2 className="title">Account</h2>
      <p className="sub">Signed in as {profile.displayName}</p>
      <div className="card"><div className="body">
        <Row k="Name" v={profile.displayName} />
        <Row k="Email" v={profile.email} />
        <Row k="Active role" v={profile.activeRole === 'renter' ? 'Renter' : 'Landlord'} />
      </div></div>

      <div className="notice">
        RentMatch charges landlords a one-off <b>£100</b> fee when a tenancy agreement is fully signed.
        Renters are never charged a fee (Tenant Fees Act 2019).
      </div>

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

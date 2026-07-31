import { Link } from 'react-router-dom';
import { STAGE_LABELS, formatGBP } from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { useUserDeals } from '../lib/hooks';
import { photoGradient } from '../components/ui';

export default function Chats() {
  const { user, profile } = useAuth();
  const role = profile?.activeRole ?? 'renter';
  const { deals, loading } = useUserDeals(user?.uid);

  if (loading) return <><h2 className="title">{role === 'renter' ? 'Your chats' : 'Enquiries'}</h2><p className="sub">Loading…</p></>;
  if (deals.length === 0) {
    return (
      <>
        <h2 className="title">{role === 'renter' ? 'Your chats' : 'Enquiries'}</h2>
        <div className="empty">
          <div className="big">💬</div>
          {role === 'renter' ? 'Enquire on a property to start a conversation.' : 'When a renter enquires, the conversation appears here.'}
        </div>
      </>
    );
  }

  return (
    <>
      <h2 className="title">{role === 'renter' ? 'Your chats' : 'Enquiries'}</h2>
      <p className="sub">Message, arrange a viewing, agree terms.</p>
      {deals.map((d) => {
        const who = role === 'renter' ? d.landlordName : d.renterName;
        const complete = d.stage === 'completed';
        return (
          <Link key={d.id} to={`/deal/${d.id}`} className="card" style={{ display: 'block', color: 'inherit' }}>
            <div className="body row center" style={{ justifyContent: 'space-between' }}>
              <div className="row center" style={{ gap: 11, minWidth: 0 }}>
                <div style={{ width: 44, height: 44, borderRadius: 11, flex: '0 0 auto', background: photoGradient(d.listingId) }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {who} · {d.listingArea || d.listingCity}
                  </div>
                  <div className="muted" style={{ fontSize: 12.5 }}>{formatGBP(d.rentPence)}/mo</div>
                </div>
              </div>
              <span className={`pill ${complete ? 'good' : ''}`}>{STAGE_LABELS[d.stage]}</span>
            </div>
          </Link>
        );
      })}
    </>
  );
}

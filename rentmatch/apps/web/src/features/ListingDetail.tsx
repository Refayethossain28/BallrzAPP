import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  formatGBP, tenancyDepositCapPence, holdingDepositCapPence, weeklyRentPence,
} from '@rentmatch/shared';
import { fetchListing } from '../lib/db';
import { photoGradient, formatDate } from '../components/ui';

export default function ListingDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: l, isLoading } = useQuery({ queryKey: ['listing', id], queryFn: () => fetchListing(id) });

  if (isLoading) return <p className="sub">Loading…</p>;
  if (!l) return <div className="empty"><div className="big">🤔</div>Listing not found.</div>;

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <div className="back" onClick={() => navigate(-1)}>‹</div>
        <b>{l.type} in {l.area}</b>
      </div>

      <div style={{ height: 200, borderRadius: 16, background: photoGradient(l.id), margin: '0 0 14px' }} />

      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
        <span className="pill">{l.type}</span>
        <span className="pill">{l.furnished}</span>
        <span className="pill">EPC {l.epcRating}</span>
        {l.status === 'let' && <span className="pill bad">Let agreed</span>}
      </div>

      <div className="price" style={{ fontSize: 26 }}>{formatGBP(l.rentPence)}<small> per month</small></div>
      <div className="addr" style={{ fontSize: 15, marginTop: 3 }}>{l.street}, {l.area}, {l.city} {l.postcode}</div>

      <div className="specs" style={{ fontSize: 14.5, marginTop: 13 }}>
        <span>🛏 <b>{l.beds === 0 ? 'Studio' : `${l.beds} bed${l.beds > 1 ? 's' : ''}`}</b></span>
        <span>🛁 <b>{l.baths} bath</b></span>
        <span>📅 <b>{formatDate(l.availableFrom)}</b></span>
      </div>

      <div className="section-t">About this property</div>
      <p style={{ fontSize: 14.5, lineHeight: 1.6, color: '#cdd7f0', margin: 0 }}>{l.desc || 'No description provided.'}</p>

      {l.features.length > 0 && (
        <>
          <div className="section-t">Features</div>
          <div className="row wrap" style={{ gap: 7 }}>
            {l.features.map((f, i) => <span key={i} className="pill">{f}</span>)}
          </div>
        </>
      )}

      <div className="section-t">The numbers</div>
      <div className="card"><div className="body">
        <Row k="Monthly rent" v={formatGBP(l.rentPence)} />
        <Row k="Holding deposit (max 1 week)" v={formatGBP(holdingDepositCapPence(l.rentPence))} />
        <Row k="Tenancy deposit (capped)" v={formatGBP(tenancyDepositCapPence(l.rentPence))} />
        <Row k="≈ Weekly rent" v={formatGBP(weeklyRentPence(l.rentPence))} />
      </div></div>

      <div className="notice">
        💡 Under the Tenant Fees Act 2019, renters are only charged rent, a capped tenancy deposit and a capped
        holding deposit. RentMatch never charges renters a fee.
      </div>

      <button className="cta" disabled={l.status !== 'live'}>
        {l.status === 'live' ? 'Enquire & message landlord' : 'This property has been let'}
      </button>
      <p className="faint" style={{ textAlign: 'center', fontSize: 11, marginTop: 10 }}>
        Messaging, viewings and signing arrive in M2–M5.
      </p>
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

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { formatGBP } from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { fetchLandlordListings, type Listing } from '../lib/db';
import { photoGradient } from '../components/ui';

export default function MyListings() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: all = [], isLoading } = useQuery({
    queryKey: ['listings', 'landlord', user?.uid],
    queryFn: () => fetchLandlordListings(user!.uid),
    enabled: !!user,
  });
  // Track-only properties live on the Compliance tab, not the advert view.
  const listings = all.filter((l) => !l.trackingOnly);

  return (
    <>
      <h2 className="title">Your listings</h2>
      <p className="sub">Advertise a property and manage your adverts.</p>
      <button className="cta" style={{ marginBottom: 16 }} onClick={() => navigate('/landlord/new')}>
        ＋ Advertise a property
      </button>

      {isLoading && <p className="sub">Loading…</p>}
      {!isLoading && listings.length === 0 && (
        <div className="empty"><div className="big">🏠</div>No listings yet — advertise your first property.</div>
      )}
      {listings.map((l) => <LandlordCard key={l.id} listing={l} />)}
    </>
  );
}

function LandlordCard({ listing: l }: { listing: Listing }) {
  const badge =
    l.status === 'live' ? <span className="pill good">Live</span>
    : l.status === 'let' ? <span className="pill bad">Let agreed</span>
    : <span className="pill warn">Draft — action needed</span>;
  return (
    <Link to={`/listing/${l.id}`} className="card" style={{ display: 'block', color: 'inherit' }}>
      <div className="photo" style={{ background: photoGradient(l.id) }}>
        <div className="tags"><span className="tag">{l.type}</span></div>
      </div>
      <div className="body">
        <div className="row center" style={{ justifyContent: 'space-between' }}>
          <div>
            <div className="price">{formatGBP(l.rentPence)}<small> /month</small></div>
            <div className="addr">{l.street}, {l.city}</div>
          </div>
          {badge}
        </div>
        <div className="specs">
          <span>🛏 <b>{l.beds === 0 ? 'Studio' : l.beds}</b></span>
          <span>🛁 <b>{l.baths}</b></span>
          <span>EPC <b>{l.epcRating}</b></span>
        </div>
      </div>
    </Link>
  );
}

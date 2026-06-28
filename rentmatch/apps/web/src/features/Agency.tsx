import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  rollupAgency, summarisePortfolio, buildRentLedger, formatGBP,
  type AgencyClientSnapshot, type PortfolioProperty,
} from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { fetchOwnedAgency, fetchClientPortfolio, type Listing, type TenancyRecord } from '../lib/db';

const toPortfolio = (l: Listing): PortfolioProperty => ({
  id: l.id,
  label: [l.street, l.city].filter(Boolean).join(', ') || l.title || 'Property',
  hasGasSupply: l.hasGasSupply,
  docs: l.complianceDocs,
});

const arrearsOf = (t: TenancyRecord) =>
  buildRentLedger(t, [{ date: 0, amountPence: t.totalPaidPence }]).arrearsPence;

/** Agent book-of-business: each connected landlord's portfolio health, rolled up. */
export default function Agency() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: agency, isLoading } = useQuery({
    queryKey: ['agency', user?.uid],
    queryFn: () => fetchOwnedAgency(user!.uid),
    enabled: !!user,
  });

  const { data: snapshots = [], isLoading: loadingClients } = useQuery({
    queryKey: ['agency-clients', agency?.id, agency?.clientLandlordIds.join(',')],
    enabled: !!agency,
    queryFn: async (): Promise<AgencyClientSnapshot[]> => {
      const portfolios = await Promise.all(agency!.clientLandlordIds.map(fetchClientPortfolio));
      return portfolios.map((p) => {
        const portfolio = summarisePortfolio(p.listings.map(toPortfolio));
        return {
          landlordId: p.landlordId,
          landlordName: p.landlordName,
          properties: p.listings.length,
          certsToAction: portfolio.counts.attention + portfolio.counts.breach,
          arrearsPence: p.tenancies.reduce((s, t) => s + arrearsOf(t), 0),
        };
      });
    },
  });

  if (isLoading) return <p className="sub">Loading…</p>;

  if (!agency) {
    return (
      <>
        <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
          <div className="back" onClick={() => navigate('/account')}>‹</div>
          <b style={{ fontSize: 18 }}>Agency</b>
        </div>
        <div className="empty"><div className="big">🏢</div>Create an agency from your Account to manage client landlords.</div>
      </>
    );
  }

  const rollup = rollupAgency(snapshots);

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <div className="back" onClick={() => navigate('/account')}>‹</div>
        <b style={{ fontSize: 18 }}>{agency.name}</b>
      </div>

      <div className="notice">
        Share your agency code so landlords can connect their portfolio:
        <br /><b style={{ fontVariantLigatures: 'none', wordBreak: 'break-all' }}>{agency.id}</b>
      </div>

      <div className="stat-row">
        <Stat n={rollup.clientCount} label="Clients" />
        <Stat n={rollup.totalProperties} label="Properties" />
        <Stat n={rollup.totalCertsToAction} label="Certs to action" tone={rollup.totalCertsToAction > 0 ? 'bad' : 'good'} />
      </div>

      {rollup.totalArrearsPence > 0 && (
        <div className="notice" style={{ borderColor: 'rgba(255,93,108,.4)', background: 'rgba(255,93,108,.07)' }}>
          <b>{formatGBP(rollup.totalArrearsPence)}</b> in arrears across the book.
        </div>
      )}

      <div className="section-t">Clients</div>
      {loadingClients && <p className="sub">Loading client portfolios…</p>}
      {!loadingClients && rollup.clients.length === 0 && (
        <div className="empty"><div className="big">👥</div>No landlords connected yet — share your agency code above.</div>
      )}
      {rollup.clients.map((c) => (
        <div key={c.landlordId} className="card"><div className="body">
          <div className="row center" style={{ justifyContent: 'space-between' }}>
            <b style={{ fontSize: 15 }}>{c.landlordName}</b>
            <span className="faint" style={{ fontSize: 12 }}>{c.properties} propert{c.properties === 1 ? 'y' : 'ies'}</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            {c.certsToAction > 0
              ? <span className="pill bad">{c.certsToAction} cert{c.certsToAction === 1 ? '' : 's'} to action</span>
              : <span className="pill good">Compliant</span>}
            {c.arrearsPence > 0 && <span className="pill bad">{formatGBP(c.arrearsPence)} arrears</span>}
          </div>
        </div></div>
      ))}
    </>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="stat">
      <div className={`stat-n ${tone ?? ''}`}>{n}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}

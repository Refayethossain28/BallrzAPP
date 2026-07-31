import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  summarisePortfolio, buildRentLedger, summariseFinances, taxYearStartYear, taxYearLabel, formatGBP,
  depositProtectionStatus,
  type PortfolioProperty,
} from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import {
  fetchLandlordListings, fetchLandlordTenancies, fetchLandlordExpenses, fetchLandlordRentPayments,
  type Listing, type TenancyRecord,
} from '../lib/db';

const toPortfolio = (l: Listing): PortfolioProperty => ({
  id: l.id,
  label: [l.street, l.city].filter(Boolean).join(', ') || l.title || 'Property',
  hasGasSupply: l.hasGasSupply,
  docs: l.complianceDocs,
});

const arrearsOf = (t: TenancyRecord) =>
  buildRentLedger(t, [{ date: 0, amountPence: t.totalPaidPence }]).arrearsPence;

/**
 * The landlord's home: one glance at whether anything needs attention across
 * compliance, rent and money, with deep links into each area. This is what makes
 * the separate tools read as a single product.
 */
export default function Home() {
  const { user } = useAuth();
  const uid = user?.uid;

  const { data: listings = [] } = useQuery({
    queryKey: ['listings', 'landlord', uid], queryFn: () => fetchLandlordListings(uid!), enabled: !!uid,
  });
  const { data: tenancies = [] } = useQuery({
    queryKey: ['tenancies', uid], queryFn: () => fetchLandlordTenancies(uid!), enabled: !!uid,
  });
  const { data: expenses = [] } = useQuery({
    queryKey: ['expenses', uid], queryFn: () => fetchLandlordExpenses(uid!), enabled: !!uid,
  });
  const { data: income = [] } = useQuery({
    queryKey: ['rent-payments', uid], queryFn: () => fetchLandlordRentPayments(uid!), enabled: !!uid,
  });

  const portfolio = summarisePortfolio(listings.map(toPortfolio));
  const needsAttention = portfolio.counts.attention + portfolio.counts.breach;
  const totalArrears = tenancies.reduce((sum, t) => sum + arrearsOf(t), 0);
  // Deposits past their 30-day protection deadline (or protected but prescribed
  // info not served) — a Section 21-blocking, penalty-carrying legal exposure.
  const depositsAtRisk = tenancies.filter((t) => {
    if (t.status !== 'active') return false;
    const s = depositProtectionStatus(t.deposit, Date.now()).state;
    return s === 'overdue' || s === 'info-outstanding';
  }).length;
  const thisYear = taxYearStartYear(Date.now());
  const finance = summariseFinances(income, expenses, thisYear);

  return (
    <>
      <h2 className="title">Home</h2>
      <p className="sub">Your portfolio at a glance.</p>

      <div className="stat-row">
        <Stat n={listings.length} label="Properties" />
        <Stat n={needsAttention} label="Certs to action" tone={needsAttention > 0 ? 'bad' : 'good'} />
        <Stat n={tenancies.filter((t) => t.status === 'active').length} label="Tenancies" />
      </div>

      {(needsAttention > 0 || totalArrears > 0 || depositsAtRisk > 0) && (
        <>
          <div className="section-t">Needs attention</div>
          {depositsAtRisk > 0 && (
            <Alert to="/landlord/rent" tone="bad"
              text={`${depositsAtRisk} deposit${depositsAtRisk === 1 ? '' : 's'} not properly protected — Section 21 at risk`} />
          )}
          {portfolio.counts.breach > 0 && (
            <Alert to="/landlord/compliance" tone="bad"
              text={`${portfolio.counts.breach} propert${portfolio.counts.breach === 1 ? 'y has' : 'ies have'} a missing or expired certificate`} />
          )}
          {portfolio.counts.attention > 0 && (
            <Alert to="/landlord/compliance" tone="warn"
              text={`${portfolio.counts.attention} certificate${portfolio.counts.attention === 1 ? '' : 's'} expiring soon`} />
          )}
          {totalArrears > 0 && (
            <Alert to="/landlord/rent" tone="bad" text={`${formatGBP(totalArrears)} of rent in arrears`} />
          )}
        </>
      )}

      <div className="section-t">This tax year · {taxYearLabel(thisYear)}</div>
      <Link to="/landlord/finances" className="card" style={{ display: 'block', color: 'inherit' }}>
        <div className="body">
          <div className="row center" style={{ justifyContent: 'space-between' }}>
            <div><div className="faint" style={{ fontSize: 12 }}>Income</div><b>{formatGBP(finance.incomePence)}</b></div>
            <div><div className="faint" style={{ fontSize: 12 }}>Expenses</div><b>{formatGBP(finance.expensePence)}</b></div>
            <div><div className="faint" style={{ fontSize: 12 }}>Net</div><b>{formatGBP(finance.netPence)}</b></div>
          </div>
        </div>
      </Link>

      <div className="section-t">Manage</div>
      <div className="tile-grid">
        <Tile to="/landlord/listings" ic="🏠" label="Listings" />
        <Tile to="/landlord/compliance" ic="🛡️" label="Compliance" />
        <Tile to="/landlord/rent" ic="💷" label="Rent" />
        <Tile to="/landlord/finances" ic="📊" label="Finances" />
        <Tile to="/chats" ic="💬" label="Enquiries" />
        <Tile to="/landlord/track" ic="＋" label="Add property" />
      </div>
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

function Alert({ to, tone, text }: { to: string; tone: 'bad' | 'warn'; text: string }) {
  const colors = tone === 'bad'
    ? { border: 'rgba(255,93,108,.4)', bg: 'rgba(255,93,108,.07)' }
    : { border: 'rgba(255,209,102,.4)', bg: 'rgba(255,209,102,.07)' };
  return (
    <Link to={to} className="notice" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'inherit', borderColor: colors.border, background: colors.bg }}>
      <span>{text}</span><span className="faint">›</span>
    </Link>
  );
}

function Tile({ to, ic, label }: { to: string; ic: string; label: string }) {
  return (
    <Link to={to} className="tile">
      <span className="tile-ic">{ic}</span>
      <span>{label}</span>
    </Link>
  );
}

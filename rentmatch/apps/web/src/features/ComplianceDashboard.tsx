import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  summarisePortfolio,
  type ComplianceRisk,
  type DocStatus,
  type PortfolioProperty,
  type UpcomingExpiry,
} from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { fetchLandlordListings, type Listing } from '../lib/db';
import { formatDate } from '../components/ui';

/**
 * Standalone portfolio compliance dashboard — the wedge that delivers value with
 * no tenant and no live deal: "is my whole portfolio legal, and what lapses next?"
 * All the legal reasoning lives in the shared kernel (`summarisePortfolio`); this
 * screen only presents it.
 */
export default function ComplianceDashboard() {
  const { user } = useAuth();
  const { data: listings = [], isLoading } = useQuery({
    queryKey: ['listings', 'landlord', user?.uid],
    queryFn: () => fetchLandlordListings(user!.uid),
    enabled: !!user,
  });

  const summary = useMemo(() => summarisePortfolio(listings.map(toPortfolioProperty)), [listings]);

  return (
    <>
      <h2 className="title">Compliance</h2>
      <p className="sub">Every property's certificates in one place — so a lapse never costs you a fine or a Section 21.</p>

      {isLoading && <p className="sub">Loading…</p>}

      {!isLoading && listings.length === 0 && (
        <div className="empty"><div className="big">🛡️</div>Add a property to start tracking its compliance.</div>
      )}

      {!isLoading && listings.length > 0 && (
        <>
          <div className="stat-row">
            <Stat n={summary.counts.compliant} label="Compliant" tone="good" />
            <Stat n={summary.counts.attention} label="Expiring" tone="warn" />
            <Stat n={summary.counts.breach} label="Action needed" tone="bad" />
          </div>

          {summary.upcoming.length > 0 && (
            <>
              <div className="section-t">Needs attention</div>
              <div className="card"><div className="body">
                {summary.upcoming.map((u) => <ExpiryRow key={`${u.propertyId}:${u.type}`} item={u} />)}
              </div></div>
            </>
          )}

          <div className="section-t">Your properties</div>
          {summary.properties.map((p) => (
            <Link key={p.id} to={`/listing/${p.id}`} className="card" style={{ display: 'block', color: 'inherit' }}>
              <div className="body">
                <div className="row center" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                  <b style={{ fontSize: 15 }}>{p.label}</b>
                  <RiskPill risk={p.risk} />
                </div>
                <div className="doc-chips">
                  {p.docs.map((d) => (
                    <span key={d.type} className={`pill ${STATUS_TONE[d.status]}`}>
                      {shortLabel(d.label)} · {STATUS_TEXT[d.status]}
                    </span>
                  ))}
                </div>
              </div>
            </Link>
          ))}
        </>
      )}
    </>
  );
}

/** A landlord listing carries everything the portfolio view needs. */
function toPortfolioProperty(l: Listing): PortfolioProperty {
  return {
    id: l.id,
    label: [l.street, l.city].filter(Boolean).join(', ') || l.title || 'Property',
    hasGasSupply: l.hasGasSupply,
    docs: l.complianceDocs,
  };
}

const STATUS_TONE: Record<DocStatus, string> = {
  valid: 'good',
  expiring: 'warn',
  expired: 'bad',
  missing: 'bad',
};

const STATUS_TEXT: Record<DocStatus, string> = {
  valid: 'Valid',
  expiring: 'Expiring',
  expired: 'Expired',
  missing: 'Missing',
};

const RISK_PILL: Record<ComplianceRisk, { cls: string; text: string }> = {
  compliant: { cls: 'good', text: '✓ Compliant' },
  attention: { cls: 'warn', text: 'Expiring soon' },
  breach: { cls: 'bad', text: 'Action needed' },
};

/** "Gas Safety Record (CP12)" → "Gas Safety" for the compact chips. */
function shortLabel(label: string): string {
  return label.replace(/\s*\(.*\)\s*/, '').replace('Energy Performance Certificate', 'EPC').replace('Electrical safety report', 'EICR');
}

function RiskPill({ risk }: { risk: ComplianceRisk }) {
  const p = RISK_PILL[risk];
  return <span className={`pill ${p.cls}`}>{p.text}</span>;
}

function Stat({ n, label, tone }: { n: number; label: string; tone: string }) {
  return (
    <div className="stat">
      <div className={`stat-n ${tone}`}>{n}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}

function ExpiryRow({ item }: { item: UpcomingExpiry }) {
  const expired = item.status === 'expired';
  return (
    <div className="row center" style={{ justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14 }}>{shortLabel(item.label)}</div>
        <div className="faint" style={{ fontSize: 12 }}>{item.propertyLabel}</div>
      </div>
      <span className={`pill ${expired ? 'bad' : 'warn'}`}>
        {expired
          ? item.expiresAt ? `Expired ${formatDate(item.expiresAt)}` : 'Missing'
          : item.expiresAt ? `Expires ${formatDate(item.expiresAt)}` : 'Expiring'}
      </span>
    </div>
  );
}

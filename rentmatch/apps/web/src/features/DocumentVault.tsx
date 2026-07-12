import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  summarisePropertyCompliance, requiredDocTypes, docStatus, DOC_LABELS,
  type ComplianceDoc, type ComplianceDocType, type ComplianceRisk, type DocStatus,
} from '@rentmatch/shared';
import { fetchListing, uploadComplianceDoc, type Listing } from '../lib/db';
import { formatDate } from '../components/ui';

/**
 * Per-property document vault: upload, view and renew every compliance
 * certificate, with the issue date captured so expiry (and the reminder cron)
 * is accurate even for backdated or renewed documents.
 */
export default function DocumentVault() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: listing, isLoading } = useQuery({ queryKey: ['listing', id], queryFn: () => fetchListing(id) });

  if (isLoading) return <p className="sub">Loading…</p>;
  if (!listing) return <div className="empty"><div className="big">🤔</div>Property not found.</div>;

  const label = [listing.street, listing.city].filter(Boolean).join(', ') || listing.title || 'Property';
  const summary = summarisePropertyCompliance({
    id: listing.id,
    label,
    hasGasSupply: listing.hasGasSupply,
    docs: listing.complianceDocs,
  });

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <button type="button" className="back" aria-label="Back" onClick={() => navigate('/landlord/compliance')}>‹</button>
        <b style={{ fontSize: 17, minWidth: 0 }}>{label}</b>
      </div>

      <RiskBanner risk={summary.risk} />

      <div className="section-t">Certificates</div>
      {requiredDocTypes(listing).map((type) => (
        <DocCard key={type} listing={listing} type={type} doc={listing.complianceDocs.find((d) => d.type === type)} />
      ))}

      {listing.trackingOnly ? (
        <p className="faint" style={{ fontSize: 11.5, marginTop: 14 }}>
          This property is tracked for compliance only. To advertise it to renters,{' '}
          <Link to={`/listing/${listing.id}`} style={{ color: 'var(--c2)' }}>add the letting details and publish</Link>.
        </p>
      ) : (
        <p className="faint" style={{ fontSize: 11.5, marginTop: 14 }}>
          Manage the advert and publishing on the{' '}
          <Link to={`/listing/${listing.id}`} style={{ color: 'var(--c2)' }}>listing page</Link>.
        </p>
      )}
    </>
  );
}

const RISK_BANNER: Record<ComplianceRisk, { cls: string; text: string }> = {
  compliant: { cls: 'good', text: '✓ Fully compliant — every certificate is in date.' },
  attention: { cls: 'warn', text: 'A certificate is expiring soon — renew it to stay covered.' },
  breach: { cls: 'bad', text: 'Action needed — a required certificate is missing or expired.' },
};

function RiskBanner({ risk }: { risk: ComplianceRisk }) {
  const b = RISK_BANNER[risk];
  const colors: Record<string, string> = {
    good: 'rgba(54,240,166,.4);background:rgba(54,240,166,.07)',
    warn: 'rgba(255,209,102,.4);background:rgba(255,209,102,.07)',
    bad: 'rgba(255,93,108,.4);background:rgba(255,93,108,.07)',
  };
  const [border, bg] = colors[b.cls].split(';background:');
  return <div className="notice" style={{ borderColor: border, background: bg }}>{b.text}</div>;
}

const STATUS_PILL: Record<DocStatus, { cls: string; text: string }> = {
  missing: { cls: 'bad', text: 'Missing' },
  valid: { cls: 'good', text: 'Valid' },
  expiring: { cls: 'warn', text: 'Expiring soon' },
  expired: { cls: 'bad', text: 'Expired' },
};

/** Today as a YYYY-MM-DD string for the date input default/limit. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function DocCard({ listing, type, doc }: { listing: Listing; type: ComplianceDocType; doc?: ComplianceDoc }) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [issued, setIssued] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const status = docStatus(doc);
  const pill = STATUS_PILL[status];

  async function upload(file: File) {
    const issuedAt = new Date(issued).getTime();
    if (!Number.isFinite(issuedAt)) {
      setError('Enter the certificate’s issue date first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await uploadComplianceDoc(listing, type, file, issuedAt);
      await queryClient.invalidateQueries({ queryKey: ['listing', listing.id] });
      await queryClient.invalidateQueries({ queryKey: ['listings'] });
    } catch {
      setError('Upload failed — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card"><div className="body">
      <div className="row center" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <b style={{ fontSize: 14, minWidth: 0 }}>{DOC_LABELS[type]}</b>
        <span className={`pill ${pill.cls}`}>{pill.text}</span>
      </div>

      {doc && (
        <div className="faint" style={{ fontSize: 12, marginBottom: 8 }}>
          {doc.issuedAt != null && <>Issued {formatDate(doc.issuedAt)}</>}
          {doc.expiresAt != null && <> · Expires {formatDate(doc.expiresAt)}</>}
          {doc.reference && <> · <a href={doc.reference} target="_blank" rel="noreferrer" style={{ color: 'var(--c2)' }}>View</a></>}
        </div>
      )}

      <div className="row center" style={{ gap: 8 }}>
        <div className="field" style={{ margin: 0, flex: 1 }}>
          <label style={{ fontSize: 11 }} htmlFor={`dv-issued-${type}`}>Issue date</label>
          <input id={`dv-issued-${type}`} type="date" value={issued} max={todayISO()} onChange={(e) => setIssued(e.target.value)} />
        </div>
        <button className="cta ghost sm" style={{ width: 'auto', padding: '9px 14px', alignSelf: 'flex-end' }}
          disabled={busy} onClick={() => fileInput.current?.click()}>
          {busy ? 'Uploading…' : doc ? 'Replace' : 'Upload PDF'}
        </button>
      </div>
      <input ref={fileInput} type="file" accept="application/pdf" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
      {error && <p className="error">{error}</p>}
    </div></div>
  );
}

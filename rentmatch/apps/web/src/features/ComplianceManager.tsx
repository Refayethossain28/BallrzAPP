import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { docStatus, type ComplianceCheck, type ComplianceDocType, type DocStatus } from '@rentmatch/shared';
import { uploadComplianceDoc, type Listing } from '../lib/db';
import { publishListing } from '../lib/functions';

interface Required {
  type: ComplianceDocType;
  label: string;
}

const STATUS_PILL: Record<DocStatus, { cls: string; text: string }> = {
  missing: { cls: 'warn', text: 'Required' },
  valid: { cls: 'good', text: 'Valid' },
  expiring: { cls: 'warn', text: 'Expiring soon' },
  expired: { cls: 'bad', text: 'Expired' },
};

/** Landlord uploads compliance docs, then publishes via the Cloud Function. */
export default function ComplianceManager({ listing }: { listing: Listing }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<ComplianceDocType | 'publish' | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ status: 'live' | 'draft'; checks: ComplianceCheck[] } | null>(null);

  const required: Required[] = [
    { type: 'epc', label: 'Energy Performance Certificate (EPC)' },
    { type: 'eicr', label: 'Electrical safety report (EICR)' },
    ...(listing.hasGasSupply ? [{ type: 'gas-safety' as const, label: 'Gas Safety Record (CP12)' }] : []),
  ];

  async function upload(type: ComplianceDocType, file: File) {
    setBusy(type);
    setError('');
    try {
      await uploadComplianceDoc(listing, type, file);
      await queryClient.invalidateQueries({ queryKey: ['listing', listing.id] });
    } catch {
      setError('Upload failed — please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    setBusy('publish');
    setError('');
    try {
      const { data } = await publishListing({ listingId: listing.id });
      setResult(data);
      await queryClient.invalidateQueries({ queryKey: ['listing', listing.id] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not publish.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="section-t">Compliance &amp; publishing</div>
      {listing.status === 'live'
        ? <div className="notice" style={{ borderColor: 'rgba(54,240,166,.4)', background: 'rgba(54,240,166,.07)' }}>✅ This listing is live and searchable by renters.</div>
        : <div className="notice">Upload the required certificates, then publish. We re-check them server-side before the listing goes live.</div>}

      <div className="card"><div className="body">
        {required.map((r) => {
          const doc = listing.complianceDocs.find((d) => d.type === r.type);
          const st = STATUS_PILL[docStatus(doc)];
          return <DocRow key={r.type} label={r.label} pill={st} busy={busy === r.type}
            onFile={(f) => upload(r.type, f)} />;
        })}
        <DeclRow label="Smoke alarm on every storey" ok={listing.smokeAlarmsPerStorey} />
        <DeclRow label="CO alarms where required" ok={listing.coAlarmsWhereRequired} />
      </div></div>

      {result && (
        <ul className="checklist">
          {result.checks.map((c) => (
            <li key={c.id}>
              <span className={`ck ${c.ok ? 'ok' : 'no'}`}>{c.ok ? '✓' : '✕'}</span>
              <div>{c.label}{c.detail && <><br /><span className="faint" style={{ fontSize: 12 }}>{c.detail}</span></>}</div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      {listing.status !== 'live' && (
        <button className="cta" disabled={busy === 'publish'} onClick={publish}>
          {busy === 'publish' ? 'Checking…' : 'Publish listing'}
        </button>
      )}
    </>
  );
}

function DocRow({ label, pill, busy, onFile }: {
  label: string; pill: { cls: string; text: string }; busy: boolean; onFile: (f: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="row center" style={{ justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14 }}>{label}</div>
        <span className={`pill ${pill.cls}`} style={{ marginTop: 4 }}>{pill.text}</span>
      </div>
      <button className="cta ghost sm" style={{ width: 'auto', padding: '9px 14px' }} disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Uploading…' : 'Upload PDF'}
      </button>
      <input ref={input} type="file" accept="application/pdf" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </div>
  );
}

function DeclRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="row center" style={{ justifyContent: 'space-between', padding: '9px 0' }}>
      <span style={{ fontSize: 14 }}>{label}</span>
      <span className={`pill ${ok ? 'good' : 'bad'}`}>{ok ? 'Declared' : 'Missing'}</span>
    </div>
  );
}

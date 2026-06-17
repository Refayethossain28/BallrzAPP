import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { formatGBP, type DealParty } from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { useDeal } from '../lib/hooks';
import { fetchContract } from '../lib/db';
import { openSigning, recordSignature } from '../lib/functions';
import PaymentPanel from '../components/PaymentPanel';

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function ContractView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { deal } = useDeal(id);
  const { data: contract, isLoading } = useQuery({ queryKey: ['contract', id], queryFn: () => fetchContract(id) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (isLoading) return <p className="sub">Loading…</p>;
  if (!contract || !deal) return <div className="empty"><div className="big">📄</div>No agreement drafted yet.</div>;

  const a = contract.agreement;
  const party: DealParty = deal.renterId === user?.uid ? 'renter' : 'landlord';
  const fullyExecuted = deal.signed.renter != null && deal.signed.landlord != null;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <div className="back" onClick={() => navigate(`/deal/${id}`)}>‹</div>
        <div>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Tenancy Agreement</div>
          <div className="muted" style={{ fontSize: 12.5 }}>Assured Shorthold Tenancy (England) · {a.governingAct}</div>
        </div>
      </div>

      <div className="notice">
        This Assured Shorthold Tenancy is governed by the {a.governingAct}. Both parties must sign for it to take
        effect. On full execution, Apex charges the landlord a one-off <b>{formatGBP(contract.feePence)}</b> fee.
      </div>

      <div style={{ background: '#0d1322', border: '1px solid var(--line)', borderRadius: 14, padding: 16, fontSize: 12.5, lineHeight: 1.6, color: '#cdd7f0' }}>
        <P><b>The Landlord:</b> {a.parties.landlord.name} ({a.parties.landlord.email})</P>
        <P><b>The Tenant:</b> {a.parties.tenant.name} ({a.parties.tenant.email})</P>
        <P><b>The Property:</b> {a.propertyAddress}</P>
        <P><b>Term:</b> {a.termMonths} months — {fmtDate(a.startDate)} to {fmtDate(a.endDate)}</P>
        <P><b>Rent:</b> {formatGBP(a.monthlyRentPence)} per calendar month</P>
        <P><b>Deposit:</b> {formatGBP(a.depositPence)} ({a.depositWeeks} weeks' rent — within the Tenant Fees Act 2019 cap)</P>
        {a.clauses.map((c) => (
          <div key={c.number} style={{ marginTop: 14 }}>
            <div style={{ color: 'var(--ink)', fontWeight: 700, fontSize: 13.5, marginBottom: 4 }}>
              <span style={{ color: 'var(--c2)' }}>{c.number}. </span>{c.heading}
            </div>
            <div>{c.text}</div>
          </div>
        ))}
      </div>

      <div className="section-t">Statutory compliance</div>
      <ul className="checklist">
        {contract.compliance.map((c) => (
          <li key={c.id}>
            <span className={`ck ${c.ok ? 'ok' : 'no'}`}>{c.ok ? '✓' : '✕'}</span>
            <div>{c.label}{c.detail && <><br /><span className="faint" style={{ fontSize: 12 }}>{c.detail}</span></>}</div>
          </li>
        ))}
      </ul>

      <div className="section-t">Signatures</div>
      <div className="card"><div className="body">
        <SigRow label={`Landlord — ${a.parties.landlord.name}`} at={deal.signed.landlord} />
        <SigRow label={`Tenant — ${a.parties.tenant.name}`} at={deal.signed.renter} />
      </div></div>

      {error && <p className="error">{error}</p>}

      {/* actions by stage */}
      {deal.stage === 'contract' && party === 'landlord' && (
        <button className="cta" disabled={busy} onClick={() => run(() => openSigning({ dealId: id }))}>
          {busy ? 'Sending…' : '✍️ Send for e-signature'}
        </button>
      )}
      {deal.stage === 'contract' && party === 'renter' && (
        <div className="notice">The landlord is about to send this agreement for e-signature.</div>
      )}

      {deal.stage === 'signing' && !fullyExecuted && deal.signed[party] == null && (
        <button className="cta" disabled={busy} onClick={() => run(() => recordSignature({ dealId: id }))}>
          {busy ? 'Signing…' : `✍️ Sign as ${party === 'renter' ? a.parties.tenant.name : a.parties.landlord.name}`}
        </button>
      )}
      {deal.stage === 'signing' && !fullyExecuted && deal.signed[party] != null && (
        <div className="notice">You've signed — waiting for the other party.</div>
      )}
      {deal.stage === 'signing' && fullyExecuted && !deal.feePaid && party === 'landlord' && (
        <>
          <div className="notice">✅ Both parties have signed. Pay the one-off platform fee to complete the tenancy.</div>
          <PaymentPanel dealId={id} />
        </>
      )}
      {deal.stage === 'signing' && fullyExecuted && !deal.feePaid && party === 'renter' && (
        <div className="notice">✅ Both parties have signed. The landlord is completing the {formatGBP(contract.feePence)} platform fee.</div>
      )}
      {deal.stage === 'completed' && (
        <div className="notice" style={{ borderColor: 'rgba(54,240,166,.4)', background: 'rgba(54,240,166,.07)' }}>
          🎉 Fully executed — the {formatGBP(contract.feePence)} fee is paid and the tenancy is in force.
        </div>
      )}
    </>
  );
}

function SigRow({ label, at }: { label: string; at: number | null }) {
  return (
    <div className="row center" style={{ justifyContent: 'space-between', padding: '8px 0' }}>
      <span className="muted">{label}</span>
      {at != null
        ? <span className="pill good">Signed {fmtDateTime(at)}</span>
        : <span className="pill warn">Awaiting</span>}
    </div>
  );
}

function P({ children }: { children: ReactNode }) {
  return <div style={{ marginBottom: 7 }}>{children}</div>;
}

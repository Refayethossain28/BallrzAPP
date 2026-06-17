import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { formatGBP } from '@rentmatch/shared';
import { fetchContract } from '../lib/db';

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export default function ContractView() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: contract, isLoading } = useQuery({ queryKey: ['contract', id], queryFn: () => fetchContract(id) });

  if (isLoading) return <p className="sub">Loading…</p>;
  if (!contract) return <div className="empty"><div className="big">📄</div>No agreement drafted yet.</div>;

  const a = contract.agreement;

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
        effect. On signing, RentMatch charges the landlord a one-off <b>{formatGBP(contract.feePence)}</b> fee.
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
        <div className="row center" style={{ justifyContent: 'space-between' }}>
          <span className="muted">Landlord — {a.parties.landlord.name}</span><span className="pill warn">Awaiting</span>
        </div>
        <div className="row center" style={{ justifyContent: 'space-between', marginTop: 10 }}>
          <span className="muted">Tenant — {a.parties.tenant.name}</span><span className="pill warn">Awaiting</span>
        </div>
      </div></div>
      <p className="faint" style={{ textAlign: 'center', fontSize: 11, marginTop: 12 }}>
        E-signature and the £100 fee arrive in M4–M5.
      </p>
    </>
  );
}

function P({ children }: { children: ReactNode }) {
  return <div style={{ marginBottom: 7 }}>{children}</div>;
}

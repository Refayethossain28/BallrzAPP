import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  buildRentLedger, buildRentStatementCsv, formatGBP, isMandateActive, mandateLabel,
  type RentStatus, type CollectionStatus,
} from '@rentmatch/shared';
import { fetchTenancy, fetchPayments, addRentPayment, type TenancyRecord } from '../lib/db';
import { createDirectDebitSetup } from '../lib/functions';
import { formatDate } from '../components/ui';

const STATUS_BANNER: Record<RentStatus, { cls: string; border: string; bg: string; text: string }> = {
  upcoming: { cls: 'warn', border: 'rgba(255,209,102,.4)', bg: 'rgba(255,209,102,.07)', text: 'Tenancy hasn’t started yet — no rent due.' },
  paid: { cls: 'good', border: 'rgba(54,240,166,.4)', bg: 'rgba(54,240,166,.07)', text: 'Up to date — rent is fully paid to date.' },
  arrears: { cls: 'bad', border: 'rgba(255,93,108,.4)', bg: 'rgba(255,93,108,.07)', text: 'In arrears — rent is owed.' },
  credit: { cls: 'good', border: 'rgba(54,240,166,.4)', bg: 'rgba(54,240,166,.07)', text: 'In credit — the tenant has paid ahead.' },
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function TenancyDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { data: tenancy, isLoading } = useQuery({ queryKey: ['tenancy', id], queryFn: () => fetchTenancy(id) });
  const { data: payments = [] } = useQuery({ queryKey: ['payments', id], queryFn: () => fetchPayments(id) });

  if (isLoading) return <p className="sub">Loading…</p>;
  if (!tenancy) return <div className="empty"><div className="big">🤔</div>Tenancy not found.</div>;

  const ledger = buildRentLedger(tenancy, payments);
  const banner = STATUS_BANNER[ledger.status];

  function downloadStatement() {
    if (!tenancy) return;
    const csv = buildRentStatementCsv({ ...tenancy }, payments);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rent-statement-${tenancy.tenantName.replace(/\s+/g, '-').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function logPayment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const amountPence = Math.round(Number(f.get('amount') ?? 0) * 100);
    const dateStr = String(f.get('date') ?? '');
    if (amountPence <= 0 || !dateStr) {
      setError('Enter an amount and a date.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await addRentPayment(id, {
        amountPence,
        date: new Date(dateStr).getTime(),
        method: String(f.get('method') ?? '') || undefined,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['payments', id] }),
        queryClient.invalidateQueries({ queryKey: ['tenancy', id] }),
        queryClient.invalidateQueries({ queryKey: ['tenancies'] }),
      ]);
      form.reset();
    } catch {
      setError('Could not record the payment — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <div className="back" onClick={() => navigate('/landlord/rent')}>‹</div>
        <b style={{ fontSize: 17, minWidth: 0 }}>{tenancy.tenantName}</b>
      </div>
      <div className="faint" style={{ fontSize: 12.5, marginBottom: 10 }}>{tenancy.propertyLabel}</div>

      <div className="notice" style={{ borderColor: banner.border, background: banner.bg }}>{banner.text}</div>

      <div className="stat-row">
        <Stat label="Owed to date" value={formatGBP(ledger.totalDuePence)} />
        <Stat label="Received" value={formatGBP(ledger.totalPaidPence)} tone="good" />
        <Stat
          label={ledger.creditPence > 0 ? 'In credit' : 'Arrears'}
          value={formatGBP(ledger.creditPence > 0 ? ledger.creditPence : ledger.arrearsPence)}
          tone={ledger.arrearsPence > 0 ? 'bad' : 'good'}
        />
      </div>

      <div className="card"><div className="body">
        <Row k="Monthly rent" v={formatGBP(tenancy.monthlyRentPence)} />
        <Row k="Term" v={`${tenancy.termMonths} months from ${formatDate(tenancy.startDate)}`} />
        {ledger.nextDueDate && <Row k="Next rent due" v={formatDate(ledger.nextDueDate)} />}
      </div></div>

      <RentCollection tenancy={tenancy} />

      <div className="section-t">Record a payment</div>
      <form onSubmit={logPayment}>
        <div className="two">
          <div className="field"><label>Amount (£)</label>
            <input name="amount" type="number" min={0} step="0.01" defaultValue={(tenancy.monthlyRentPence / 100).toString()} /></div>
          <div className="field"><label>Date received</label>
            <input name="date" type="date" defaultValue={todayISO()} max={todayISO()} /></div>
        </div>
        <div className="field"><label>Method (optional)</label>
          <select name="method" defaultValue=""><option value="">—</option><option>Bank transfer</option><option>Standing order</option><option>Cash</option><option>Card</option></select></div>
        {error && <p className="error">{error}</p>}
        <button className="cta" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add payment'}</button>
      </form>

      {payments.length > 0 && (
        <>
          <div className="section-t">Payments received</div>
          <div className="card"><div className="body">
            {payments.map((p) => (
              <div key={p.id} className="row center" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <div>
                  <div style={{ fontSize: 14 }}>{formatGBP(p.amountPence)}</div>
                  <div className="faint" style={{ fontSize: 11.5 }}>{formatDate(p.date)}{p.method ? ` · ${p.method}` : ''}</div>
                </div>
                <span className="pill good">Received</span>
              </div>
            ))}
          </div></div>
        </>
      )}

      <div className="section-t">Rent schedule</div>
      <div className="card"><div className="body">
        {ledger.schedule.map((c) => {
          const due = c.dueDate <= Date.now();
          return (
            <div key={c.period} className="row center" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ fontSize: 13.5 }}>{formatDate(c.dueDate)}</span>
              <span className="row center" style={{ gap: 8 }}>
                <span style={{ fontSize: 13.5 }}>{formatGBP(c.amountPence)}</span>
                <span className={`pill ${due ? 'warn' : ''}`} style={{ minWidth: 56, justifyContent: 'center' }}>{due ? 'Due' : 'Upcoming'}</span>
              </span>
            </div>
          );
        })}
      </div></div>

      <button className="cta ghost" style={{ marginTop: 14 }} onClick={downloadStatement}>
        ⬇ Download rent statement (CSV)
      </button>
    </>
  );
}

const COLLECTION_PILL: Record<CollectionStatus, { cls: string; text: string }> = {
  scheduled: { cls: 'warn', text: 'Scheduled' },
  submitted: { cls: 'warn', text: 'Submitted' },
  confirmed: { cls: 'good', text: 'Collected' },
  failed: { cls: 'bad', text: 'Failed' },
};

/** Direct Debit setup + auto-collection status for a tenancy. */
function RentCollection({ tenancy }: { tenancy: TenancyRecord }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = isMandateActive(tenancy.mandate);

  async function setup() {
    setBusy(true);
    setError('');
    try {
      const { data } = await createDirectDebitSetup({ tenancyId: tenancy.id });
      if (data.url) window.location.assign(data.url);
      else setError('Could not start Direct Debit setup.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Direct Debit setup.');
    } finally {
      setBusy(false);
    }
  }

  const collections = [...tenancy.collections].sort((a, b) => b.chargeDate - a.chargeDate);

  return (
    <>
      <div className="section-t">Rent collection</div>
      <div className="card"><div className="body">
        <div className="row center" style={{ justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14 }}>{mandateLabel(tenancy.mandate)}</span>
          <span className={`pill ${active ? 'good' : tenancy.mandate?.status === 'pending' ? 'warn' : ''}`}>
            {active ? 'Active' : tenancy.mandate?.status === 'pending' ? 'Pending' : 'Off'}
          </span>
        </div>
        {active
          ? <p className="faint" style={{ fontSize: 11.5, margin: '8px 0 0' }}>Rent is collected automatically by Direct Debit a few days before each due date.</p>
          : <p className="faint" style={{ fontSize: 11.5, margin: '8px 0 0' }}>Set up a Direct Debit to collect rent automatically and end the chasing.</p>}
      </div></div>

      {!active && (
        <button className="cta ghost" disabled={busy} onClick={setup}>
          {busy ? 'Starting…' : tenancy.mandate?.status === 'pending' ? 'Continue Direct Debit setup' : 'Set up Direct Debit'}
        </button>
      )}
      {error && <p className="error">{error}</p>}

      {collections.length > 0 && (
        <div className="card" style={{ marginTop: 10 }}><div className="body">
          {collections.map((c) => {
            const pill = COLLECTION_PILL[c.status];
            return (
              <div key={`${c.period}:${c.paymentId ?? ''}`} className="row center" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                <div>
                  <div style={{ fontSize: 13.5 }}>{formatGBP(c.amountPence)}</div>
                  <div className="faint" style={{ fontSize: 11.5 }}>{c.period} · {formatDate(c.chargeDate)}</div>
                </div>
                <span className={`pill ${pill.cls}`}>{pill.text}</span>
              </div>
            );
          })}
        </div></div>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="stat">
      <div className={`stat-n ${tone ?? ''}`} style={{ fontSize: 18 }}>{value}</div>
      <div className="stat-l">{label}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="row center" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="muted">{k}</span><b style={{ textAlign: 'right' }}>{v}</b>
    </div>
  );
}

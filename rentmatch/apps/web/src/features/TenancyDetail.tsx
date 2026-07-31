import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  buildRentLedger, buildRentStatementCsv, formatGBP, isMandateActive, mandateLabel,
  renewalDefaults, rentChangePct,
  assessSection21Readiness, depositProtectionStatus, DEPOSIT_SCHEME_NAMES,
  type RentStatus, type CollectionStatus, type DepositScheme, type DepositProtection,
} from '@rentmatch/shared';
import { fetchTenancy, fetchPayments, addRentPayment, saveTenancyCompliance, type TenancyRecord } from '../lib/db';
import {
  createDirectDebitSetup, createRenewal, recordRenewalSignature, confirmRenewal,
} from '../lib/functions';
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
        district: tenancy?.district,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['payments', id] }),
        queryClient.invalidateQueries({ queryKey: ['tenancy', id] }),
        queryClient.invalidateQueries({ queryKey: ['tenancies'] }),
        // Finances and Home's tax-year income read ['rent-payments']; without
        // this they'd omit the payment just recorded until the cache expires.
        queryClient.invalidateQueries({ queryKey: ['rent-payments'] }),
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
        <button type="button" className="back" aria-label="Back" onClick={() => navigate('/landlord/rent')}>‹</button>
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

      {tenancy.status === 'active' && <NoticeReadiness tenancy={tenancy} />}

      <RentCollection tenancy={tenancy} />

      {tenancy.status === 'active' && <Renewal tenancy={tenancy} />}

      <div className="section-t">Record a payment</div>
      <form onSubmit={logPayment}>
        <div className="two">
          <div className="field"><label htmlFor="pay-amount">Amount (£)</label>
            <input id="pay-amount" name="amount" type="number" min={0} step="0.01" defaultValue={(tenancy.monthlyRentPence / 100).toString()} /></div>
          <div className="field"><label htmlFor="pay-date">Date received</label>
            <input id="pay-date" name="date" type="date" defaultValue={todayISO()} max={todayISO()} /></div>
        </div>
        <div className="field"><label htmlFor="pay-method">Method (optional)</label>
          <select id="pay-method" name="method" defaultValue=""><option value="">—</option><option>Bank transfer</option><option>Standing order</option><option>Cash</option><option>Card</option></select></div>
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

function isoDate(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Renew a tenancy: propose terms → both sign → £100 fee → fresh term. */
function Renewal({ tenancy }: { tenancy: TenancyRecord }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const renewal = tenancy.pendingRenewal;
  const defaults = renewalDefaults(tenancy);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['tenancy', tenancy.id] });

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.'); }
    finally { setBusy(false); }
  }

  async function propose(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const monthlyRentPence = Math.round(Number(f.get('rent') ?? 0) * 100);
    const termMonths = Number(f.get('term') ?? 12);
    const startDate = new Date(String(f.get('start') ?? '')).getTime();
    if (!monthlyRentPence || !termMonths || !startDate) { setError('Fill in all renewal terms.'); return; }
    await run(async () => { await createRenewal({ tenancyId: tenancy.id, startDate, termMonths, monthlyRentPence }); setOpen(false); });
  }

  async function complete() {
    setBusy(true); setError('');
    try {
      const { data } = await confirmRenewal({ tenancyId: tenancy.id });
      queryClient.invalidateQueries({ queryKey: ['tenancies'] });
      navigate(`/landlord/rent/${data.newTenancyId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete the renewal.');
    } finally { setBusy(false); }
  }

  // In-flight renewal — show signature + completion controls.
  if (renewal) {
    const change = rentChangePct(tenancy.monthlyRentPence, renewal.terms.monthlyRentPence);
    return (
      <>
        <div className="section-t">Renewal</div>
        <div className="card"><div className="body">
          <Row k="New rent" v={`${formatGBP(renewal.terms.monthlyRentPence)}${change ? ` (${change > 0 ? '+' : ''}${change.toFixed(1)}%)` : ''}`} />
          <Row k="New term" v={`${renewal.terms.termMonths} months from ${formatDate(renewal.terms.startDate)}`} />
          <Row k="Landlord signature" v={renewal.signed.landlord ? '✓ Signed' : 'Pending'} />
          <Row k="Tenant signature" v={renewal.signed.tenant ? '✓ Signed' : 'Pending'} />
        </div></div>
        {renewal.status !== 'signed' ? (
          <div className="row" style={{ gap: 8 }}>
            {!renewal.signed.landlord && (
              <button className="cta ghost" disabled={busy} onClick={() => run(() => recordRenewalSignature({ tenancyId: tenancy.id, party: 'landlord' }))}>Sign as landlord</button>
            )}
            {!renewal.signed.tenant && (
              <button className="cta ghost" disabled={busy} onClick={() => run(() => recordRenewalSignature({ tenancyId: tenancy.id, party: 'tenant' }))}>Mark tenant signed</button>
            )}
          </div>
        ) : (
          <button className="cta" disabled={busy} onClick={complete}>
            {busy ? 'Completing…' : `Charge ${formatGBP(renewal.feePence)} & start new term`}
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </>
    );
  }

  return (
    <>
      <div className="section-t">Renewal</div>
      {!open ? (
        <button className="cta ghost" onClick={() => setOpen(true)}>↻ Renew this tenancy</button>
      ) : (
        <form onSubmit={propose}>
          <div className="two">
            <div className="field"><label htmlFor="rn-rent">New rent (£)</label>
              <input id="rn-rent" name="rent" type="number" min={0} step="0.01" defaultValue={(defaults.monthlyRentPence / 100).toString()} /></div>
            <div className="field"><label htmlFor="rn-term">Term (months)</label>
              <input id="rn-term" name="term" type="number" min={1} defaultValue={defaults.termMonths} /></div>
          </div>
          <div className="field"><label htmlFor="rn-start">New term starts</label>
            <input id="rn-start" name="start" type="date" defaultValue={isoDate(defaults.startDate)} /></div>
          {error && <p className="error">{error}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button className="cta" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Propose renewal'}</button>
            <button className="cta ghost" type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
      {error && !open && <p className="error">{error}</p>}
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

/**
 * Section 21 readiness — the deposit-protection tracker + the one-glance verdict
 * on whether a valid no-fault notice could be served. Combines the deposit's
 * legal status with the landlord-attested compliance facts through the shared
 * readiness engine, worst-first.
 */
function NoticeReadiness({ tenancy }: { tenancy: TenancyRecord }) {
  const queryClient = useQueryClient();
  const now = Date.now();
  const dep = depositProtectionStatus(tenancy.deposit, now);
  const readiness = assessSection21Readiness({
    tenancyStartDate: tenancy.startDate,
    monthlyRentPence: tenancy.monthlyRentPence,
    deposit: tenancy.deposit ?? null,
    gasSafetyProvided: !!tenancy.gasSafetyProvided,
    eicrValid: !!tenancy.eicrValid,
    epcProvided: !!tenancy.epcProvided,
    howToRentProvided: !!tenancy.howToRentProvided,
  }, now);

  const [editing, setEditing] = useState(false);

  const depPill = dep.state === 'protected' ? { cls: 'good', text: 'Protected' }
    : dep.state === 'overdue' ? { cls: 'bad', text: 'Overdue' }
    : dep.state === 'info-outstanding' ? { cls: 'bad', text: 'Info outstanding' }
    : dep.state === 'due' ? { cls: 'warn', text: `${dep.daysRemaining}d left` }
    : { cls: '', text: 'No deposit' };

  const verdict = readiness.ready
    ? { border: 'rgba(54,240,166,.4)', bg: 'rgba(54,240,166,.07)', title: '✅ Ready to serve a Section 21' }
    : { border: 'rgba(255,93,108,.4)', bg: 'rgba(255,93,108,.07)', title: `⚠️ ${readiness.blockers.length} issue${readiness.blockers.length === 1 ? '' : 's'} would invalidate a Section 21` };

  async function toggle(field: 'gasSafetyProvided' | 'epcProvided' | 'eicrValid' | 'howToRentProvided', value: boolean) {
    await saveTenancyCompliance(tenancy.id, { [field]: value });
    queryClient.invalidateQueries({ queryKey: ['tenancy', tenancy.id] });
    queryClient.invalidateQueries({ queryKey: ['tenancies'] });
  }

  return (
    <>
      <div className="section-t">Eviction readiness (Section 21)</div>
      <div className="notice" style={{ borderColor: verdict.border, background: verdict.bg }}>
        <b>{verdict.title}</b>
      </div>

      {readiness.items.length > 0 && (
        <div className="card"><div className="body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {readiness.items.map((it) => (
            <div key={it.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <span style={{ flex: 'none', fontSize: 14 }}>{it.severity === 'blocker' ? '⛔' : '⚠️'}</span>
              <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>{it.message}</span>
            </div>
          ))}
        </div></div>
      )}

      <div className="card" style={{ marginTop: 10 }}><div className="body">
        <div className="row center" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <b style={{ fontSize: 14 }}>Deposit protection</b>
          <span className={`pill ${depPill.cls}`}>{depPill.text}</span>
        </div>
        {tenancy.deposit
          ? <Row k="Deposit" v={`${formatGBP(tenancy.deposit.depositPence)}${dep.scheme ? ` · ${DEPOSIT_SCHEME_NAMES[dep.scheme]}` : ''}`} />
          : <p className="faint" style={{ fontSize: 12, margin: '4px 0 0' }}>No deposit recorded. If you took one, protect it within 30 days and record it here.</p>}
        <button className="cta ghost" style={{ marginTop: 10 }} onClick={() => setEditing((e) => !e)}>
          {editing ? 'Close' : tenancy.deposit ? 'Update deposit protection' : 'Record deposit protection'}
        </button>
        {editing && <DepositForm tenancy={tenancy} onDone={() => setEditing(false)} />}
      </div></div>

      <div className="card" style={{ marginTop: 10 }}><div className="body">
        <b style={{ fontSize: 14 }}>Documents served to the tenant</b>
        <p className="faint" style={{ fontSize: 11.5, margin: '4px 0 10px' }}>Tick what you gave the tenant at the start of the tenancy — each is required for a valid Section 21.</p>
        {([
          ['gasSafetyProvided', 'Gas safety certificate'],
          ['epcProvided', 'Energy Performance Certificate (EPC)'],
          ['eicrValid', 'Electrical safety report (EICR), in date'],
          ['howToRentProvided', 'Current “How to Rent” guide'],
        ] as const).map(([field, label]) => (
          <label key={field} className="row center" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
            <span style={{ fontSize: 13 }}>{label}</span>
            <input type="checkbox" checked={!!tenancy[field]} onChange={(e) => toggle(field, e.target.checked)} />
          </label>
        ))}
      </div></div>
    </>
  );
}

function DepositForm({ tenancy, onDone }: { tenancy: TenancyRecord; onDone: () => void }) {
  const queryClient = useQueryClient();
  const d = tenancy.deposit;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const pounds = Number(f.get('amount'));
    if (!Number.isFinite(pounds) || pounds <= 0) { setError('Enter the deposit amount.'); return; }
    const received = new Date(String(f.get('received'))).getTime();
    if (!Number.isFinite(received)) { setError('Enter the date the deposit was received.'); return; }
    const protectedStr = String(f.get('protected') ?? '');
    const infoStr = String(f.get('info') ?? '');
    const deposit: DepositProtection = {
      depositPence: Math.round(pounds * 100),
      receivedAt: received,
      scheme: (String(f.get('scheme')) || undefined) as DepositScheme | undefined,
      protectedAt: protectedStr ? new Date(protectedStr).getTime() : undefined,
      prescribedInfoServedAt: infoStr ? new Date(infoStr).getTime() : undefined,
    };
    setBusy(true);
    setError('');
    try {
      await saveTenancyCompliance(tenancy.id, { deposit });
      await queryClient.invalidateQueries({ queryKey: ['tenancy', tenancy.id] });
      await queryClient.invalidateQueries({ queryKey: ['tenancies'] });
      onDone();
    } catch {
      setError('Could not save — please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="field"><label htmlFor="dep-amount">Deposit (£)</label>
        <input id="dep-amount" name="amount" type="number" min={1} step="0.01" required defaultValue={d ? d.depositPence / 100 : ''} /></div>
      <div className="field"><label htmlFor="dep-received">Date received</label>
        <input id="dep-received" name="received" type="date" required defaultValue={d ? isoDate(d.receivedAt) : todayISO()} /></div>
      <div className="field"><label htmlFor="dep-scheme">Scheme</label>
        <select id="dep-scheme" name="scheme" defaultValue={d?.scheme ?? ''}>
          <option value="">Not yet protected</option>
          <option value="dps">Deposit Protection Service</option>
          <option value="mydeposits">mydeposits</option>
          <option value="tds">Tenancy Deposit Scheme</option>
        </select></div>
      <div className="field"><label htmlFor="dep-protected">Date protected (optional)</label>
        <input id="dep-protected" name="protected" type="date" defaultValue={d?.protectedAt ? isoDate(d.protectedAt) : ''} /></div>
      <div className="field"><label htmlFor="dep-info">Prescribed info served (optional)</label>
        <input id="dep-info" name="info" type="date" defaultValue={d?.prescribedInfoServedAt ? isoDate(d.prescribedInfoServedAt) : ''} /></div>
      {error && <p className="error">{error}</p>}
      <button className="cta" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save deposit protection'}</button>
    </form>
  );
}

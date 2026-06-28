import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  rollupAgency, summarisePortfolio, buildRentLedger, formatGBP, AGENT_INCLUDED_SEATS,
  type AgencyClientSnapshot, type PortfolioProperty,
} from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import {
  fetchAgencyForUser, fetchClientPortfolio, type Agency as AgencyType, type Listing, type TenancyRecord,
} from '../lib/db';
import { addAgencyMember, removeAgencyMember } from '../lib/functions';

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
    queryKey: ['agency-view', user?.uid],
    queryFn: () => fetchAgencyForUser(user!.uid),
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
  const isOwner = agency.ownerId === user?.uid;

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

      <Team agency={agency} isOwner={isOwner} />
    </>
  );
}

/** Agency teammates; the owner can add (by email, seat-limited) and remove. */
function Team({ agency, isOwner }: { agency: AgencyType; isOwner: boolean }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['agency-view'] });

  async function add() {
    setBusy(true); setError('');
    try { await addAgencyMember({ email: email.trim().toLowerCase() }); setEmail(''); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not add teammate.'); }
    finally { setBusy(false); }
  }
  async function remove(uid: string) {
    setBusy(true); setError('');
    try { await removeAgencyMember({ memberUid: uid }); refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not remove teammate.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="section-t">Team · {agency.memberIds.length}/{AGENT_INCLUDED_SEATS} seats</div>
      <div className="card"><div className="body">
        {agency.memberIds.map((uid) => (
          <div key={uid} className="row center" style={{ justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
            <span style={{ fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {agency.memberEmails[uid] ?? uid}{uid === agency.ownerId ? ' · owner' : ''}
            </span>
            {isOwner && uid !== agency.ownerId && (
              <button className="back" style={{ width: 28, height: 28, fontSize: 14 }} disabled={busy} onClick={() => remove(uid)}>×</button>
            )}
          </div>
        ))}
      </div></div>
      {isOwner && (
        <>
          <div className="field"><label htmlFor="team-email">Add a teammate by email</label>
            <input id="team-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="agent@youragency.co.uk" /></div>
          <button className="cta ghost" disabled={busy || !email} onClick={add}>
            {busy ? 'Working…' : 'Add teammate'}
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
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

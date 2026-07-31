import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DEAL_STAGES, STAGE_LABELS, formatGBP, type DealParty } from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { useDeal, useMessages } from '../lib/hooks';
import {
  sendMessage, proposeViewing, confirmViewing, agreeToProceed, type Deal,
} from '../lib/db';
import { draftContract } from '../lib/functions';
import { photoGradient } from '../components/ui';

const fmtDateTime = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function defaultSlot(): string {
  const d = new Date(Date.now() + 2 * 86_400_000);
  d.setHours(18, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function DealRoom() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { deal, loading } = useDeal(id);
  const messages = useMessages(id);

  const threadEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);

  if (loading) return <p className="sub">Loading…</p>;
  if (!deal) return <div className="empty"><div className="big">🤔</div>Conversation not found.</div>;

  // The party MUST come from the deal itself, never the header role toggle: an
  // account holds both roles, so a renter viewing with activeRole='landlord'
  // (or after the auth fallback resets it) would otherwise post as — and forge
  // the agreement of — the wrong side.
  const me: DealParty = deal.landlordId === profile?.uid ? 'landlord' : 'renter';

  const otherName = me === 'renter' ? deal.landlordName : deal.renterName;

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <button type="button" className="back" aria-label="Back" onClick={() => navigate('/chats')}>‹</button>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: photoGradient(deal.listingId) }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{otherName}</div>
          <div className="muted" style={{ fontSize: 12 }}>{deal.listingArea}, {deal.listingCity} · {formatGBP(deal.rentPence)}/mo</div>
        </div>
      </div>

      <Pipeline deal={deal} />
      <Actions deal={deal} me={me} />

      <div className="section-t">Conversation</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '6px 0 14px' }}>
        {messages.map((m) => {
          if (m.senderRole === 'system') {
            return <div key={m.id} style={{ alignSelf: 'center', color: 'var(--faint)', fontSize: 12, textAlign: 'center', maxWidth: '90%' }}>{m.text}</div>;
          }
          const mine = m.senderRole === me;
          return (
            <div key={m.id} style={{
              alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '80%', padding: '9px 13px',
              borderRadius: 15, fontSize: 14, lineHeight: 1.4,
              background: mine ? 'var(--grad)' : 'var(--panel2)', color: mine ? '#04121c' : 'var(--ink)',
              border: mine ? '0' : '1px solid var(--line)',
            }}>
              {m.text}
            </div>
          );
        })}
        <div ref={threadEnd} />
      </div>

      <Composer deal={deal} me={me} />
    </>
  );
}

function Pipeline({ deal }: { deal: Deal }) {
  const idx = DEAL_STAGES.indexOf(deal.stage);
  return (
    <div className="card"><div className="body">
      <div className="row center" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <b>Deal progress</b>
        <span className={`pill ${deal.stage === 'completed' ? 'good' : ''}`}>{STAGE_LABELS[deal.stage]}</span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {DEAL_STAGES.map((s, i) => (
          <div key={s} style={{ flex: 1, textAlign: 'center', fontSize: 9, fontWeight: 700, color: i <= idx ? 'var(--ink)' : 'var(--faint)' }}>
            <div style={{
              width: 18, height: 18, borderRadius: '50%', margin: '0 auto 5px', display: 'grid', placeItems: 'center', fontSize: 10,
              background: i < idx ? 'var(--grad)' : 'var(--bg1)', color: i < idx ? '#04121c' : i === idx ? 'var(--c2)' : 'var(--faint)',
              border: i === idx ? '1.5px solid var(--c2)' : '1.5px solid var(--line)',
            }}>{i < idx ? '✓' : i + 1}</div>
            {STAGE_LABELS[s]}
          </div>
        ))}
      </div>
    </div></div>
  );
}

function Actions({ deal, me }: { deal: Deal; me: DealParty }) {
  const navigate = useNavigate();
  const [showSlot, setShowSlot] = useState(false);
  const [slot, setSlot] = useState(defaultSlot());
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [actionError, setActionError] = useState('');

  /** Run a deal action, surfacing any failure instead of dropping it. */
  async function act(fn: () => Promise<unknown>) {
    setActionError('');
    try { await fn(); }
    catch (err) { setActionError(err instanceof Error ? err.message : 'Something went wrong — please try again.'); }
  }

  async function draft() {
    setDrafting(true);
    setDraftError('');
    try {
      await draftContract({ dealId: deal.id });
      navigate(`/deal/${deal.id}/contract`);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'Could not draft the agreement.');
    } finally {
      setDrafting(false);
    }
  }

  async function propose(e: FormEvent) {
    e.preventDefault();
    const ts = new Date(slot).getTime();
    if (!Number.isFinite(ts)) return;
    setShowSlot(false);
    await act(() => proposeViewing(deal, me, ts));
  }

  const v = deal.viewing;
  const bothAgreed = deal.agreed.renter && deal.agreed.landlord;

  return (
    <div style={{ margin: '0 0 6px' }}>
      {/* viewing */}
      {!v && !showSlot && (
        <button className="cta ghost" style={{ marginBottom: 10 }} onClick={() => setShowSlot(true)}>
          📅 {me === 'renter' ? 'Request a viewing' : 'Propose a viewing time'}
        </button>
      )}
      {showSlot && (
        <form onSubmit={propose} style={{ marginBottom: 10 }}>
          <div className="field"><label htmlFor="viewing-slot">Date &amp; time</label>
            <input id="viewing-slot" type="datetime-local" value={slot} onChange={(e) => setSlot(e.target.value)} required /></div>
          <div className="row">
            <button className="cta" type="submit" style={{ flex: 1 }}>Send proposal</button>
            <button className="cta ghost" type="button" style={{ flex: 1 }} onClick={() => setShowSlot(false)}>Cancel</button>
          </div>
        </form>
      )}
      {v && v.status === 'proposed' && v.proposedBy !== me && !showSlot && (
        <>
          <div className="notice">Viewing proposed for <b>{fmtDateTime(v.ts)}</b>.</div>
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="cta" style={{ flex: 1 }} onClick={() => act(() => confirmViewing(deal))}>Confirm viewing</button>
            <button className="cta ghost" style={{ flex: 1 }} onClick={() => setShowSlot(true)}>Suggest another</button>
          </div>
        </>
      )}
      {v && v.status === 'proposed' && v.proposedBy === me && (
        <div className="notice">You proposed a viewing for <b>{fmtDateTime(v.ts)}</b> — awaiting confirmation.</div>
      )}
      {v && v.status === 'confirmed' && (
        <div className="notice">✅ Viewing confirmed for <b>{fmtDateTime(v.ts)}</b>.</div>
      )}

      {/* agree to proceed */}
      {v && v.status === 'confirmed' && !bothAgreed && (
        <button className="cta" style={{ marginBottom: 10 }} disabled={deal.agreed[me]} onClick={() => act(() => agreeToProceed(deal, me))}>
          {deal.agreed[me] ? "✓ You've agreed — awaiting the other party" : '🤝 Agree to proceed to a tenancy'}
        </button>
      )}
      {actionError && <p className="error" style={{ marginBottom: 10 }}>{actionError}</p>}

      {/* contract drafting (M3) */}
      {bothAgreed && !deal.contractDrafted && me === 'landlord' && (
        <>
          <button className="cta" style={{ marginBottom: draftError ? 4 : 10 }} disabled={drafting} onClick={draft}>
            {drafting ? 'Drafting…' : '📄 Draft the tenancy agreement'}
          </button>
          {draftError && <p className="error" style={{ marginBottom: 10 }}>{draftError}</p>}
        </>
      )}
      {bothAgreed && !deal.contractDrafted && me === 'renter' && (
        <div className="notice">🤝 Both parties agreed. The landlord is preparing the tenancy agreement.</div>
      )}
      {deal.contractDrafted && (
        <button className="cta" style={{ marginBottom: 10 }} onClick={() => navigate(`/deal/${deal.id}/contract`)}>
          📄 {deal.stage === 'signing' ? 'Review & sign the tenancy agreement' : deal.stage === 'completed' ? 'View the tenancy agreement' : 'Review the tenancy agreement'}
        </button>
      )}
    </div>
  );
}

function Composer({ deal, me }: { deal: Deal; me: DealParty }) {
  const { user } = useAuth();
  const [text, setText] = useState('');
  async function send(e: FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || !user) return;
    setText('');
    await sendMessage(deal.id, user.uid, me, t);
  }
  return (
    <form onSubmit={send} className="row" style={{ gap: 8, position: 'sticky', bottom: 0, paddingBottom: 4 }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a message…"
        style={{ flex: 1, background: 'var(--bg1)', border: '1px solid var(--line)', color: 'var(--ink)', borderRadius: 999, padding: '12px 16px', fontSize: 15, outline: 'none' }} />
      <button type="submit" style={{ width: 46, height: 46, flex: '0 0 auto', borderRadius: '50%', border: 0, background: 'var(--grad)', color: '#04121c', fontSize: 18, cursor: 'pointer' }}>➤</button>
    </form>
  );
}

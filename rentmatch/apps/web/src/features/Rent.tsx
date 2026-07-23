import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { buildRentLedger, formatGBP, type RentStatus } from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { fetchLandlordTenancies, type TenancyRecord } from '../lib/db';
import { formatDate } from '../components/ui';

/** A tenancy's status comes from the shared engine, using the denormalised
 *  total paid so the list needs no per-tenancy payment fetch. */
function ledgerFor(t: TenancyRecord) {
  return buildRentLedger(t, [{ date: 0, amountPence: t.totalPaidPence }]);
}

const STATUS_PILL: Record<RentStatus, { cls: string; text: string }> = {
  upcoming: { cls: 'warn', text: 'Not started' },
  paid: { cls: 'good', text: 'Up to date' },
  arrears: { cls: 'bad', text: 'In arrears' },
  credit: { cls: 'good', text: 'In credit' },
};

export default function Rent() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: tenancies = [], isLoading } = useQuery({
    queryKey: ['tenancies', user?.uid],
    queryFn: () => fetchLandlordTenancies(user!.uid),
    enabled: !!user,
  });

  const totalArrears = tenancies.reduce((sum, t) => sum + ledgerFor(t).arrearsPence, 0);

  return (
    <>
      <h2 className="title">Rent</h2>
      <p className="sub">Track rent due and received across your tenancies, with arrears flagged automatically.</p>

      <button className="cta" style={{ marginBottom: 16 }} onClick={() => navigate('/landlord/rent/new')}>
        ＋ Add a tenancy
      </button>

      {isLoading && <p className="sub">Loading…</p>}

      {!isLoading && tenancies.length === 0 && (
        <div className="empty"><div className="big">💷</div>No tenancies yet — add one to start tracking rent.</div>
      )}

      {tenancies.length > 0 && totalArrears > 0 && (
        <div className="notice" style={{ borderColor: 'rgba(255,93,108,.4)', background: 'rgba(255,93,108,.07)' }}>
          <b>{formatGBP(totalArrears)}</b> in arrears across your portfolio.
        </div>
      )}

      {tenancies.map((t) => {
        const led = ledgerFor(t);
        const pill = STATUS_PILL[led.status];
        return (
          <Link key={t.id} to={`/landlord/rent/${t.id}`} className="card" style={{ display: 'block', color: 'inherit' }}>
            <div className="body">
              <div className="row center" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <b style={{ fontSize: 15 }}>{t.tenantName}</b>
                <span className={`pill ${pill.cls}`}>{pill.text}</span>
              </div>
              <div className="faint" style={{ fontSize: 12.5 }}>{t.propertyLabel}</div>
              <div className="row center" style={{ justifyContent: 'space-between', marginTop: 8 }}>
                <span style={{ fontSize: 13.5 }}>{formatGBP(t.monthlyRentPence)}<small className="faint"> /mo</small></span>
                {led.arrearsPence > 0
                  ? <span className="pill bad">{formatGBP(led.arrearsPence)} owed</span>
                  : led.creditPence > 0
                    ? <span className="pill good">{formatGBP(led.creditPence)} ahead</span>
                    : led.nextDueDate
                      ? <span className="faint" style={{ fontSize: 12 }}>Next due {formatDate(led.nextDueDate)}</span>
                      : <span className="faint" style={{ fontSize: 12 }}>Term complete</span>}
              </div>
            </div>
          </Link>
        );
      })}
    </>
  );
}

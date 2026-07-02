import { PLANS, formatGBP, type PlanId } from '@rentmatch/shared';
import SignIn from '../auth/SignIn';

/**
 * Signed-out landing: the pitch, the features, and pricing — pulled straight
 * from the shared billing kernel so the page can never drift from what the app
 * actually charges — with the auth form inline at #get-started.
 */
export default function Landing() {
  return (
    <div className="landing">
      <header className="row center" style={{ justifyContent: 'space-between', padding: '18px 0 6px' }}>
        <div className="logo" style={{ fontSize: 22 }}><span className="mk">⌂</span> <b>Apex</b></div>
        <a className="cta ghost sm" style={{ width: 'auto', padding: '9px 16px' }} href="#get-started">Sign in</a>
      </header>

      <section style={{ padding: '34px 0 10px' }}>
        <h1 style={{ fontSize: 30, lineHeight: 1.15, margin: '0 0 10px' }}>
          Run your rentals on autopilot.
        </h1>
        <p className="sub" style={{ fontSize: 15, lineHeight: 1.55 }}>
          The UK landlord OS: never miss a gas or electrical certificate, see rent and arrears at a
          glance, and hand your accountant tax-ready figures — from one app.
        </p>
        <a className="cta" style={{ display: 'block', textAlign: 'center', marginTop: 8 }} href="#get-started">
          Get started — free for one property
        </a>
      </section>

      <section>
        <div className="section-t">Why landlords switch</div>
        <div className="tile-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
          <Feature ic="🛡️" title="Compliance autopilot"
            text="EPC, gas and EICR tracked per property. Nudged at 60/30/7 days — before a lapse costs a fine or blocks a Section 21." />
          <Feature ic="💷" title="Rent without chasing"
            text="Every tenancy's ledger, arrears flagged automatically, optional Direct Debit collection." />
          <Feature ic="📊" title="Tax-ready finances"
            text="Income and expenses by UK tax year, mortgage interest surfaced separately. Built for Self Assessment." />
          <Feature ic="✍️" title="Let and renew in-app"
            text="Advertise, message, sign a compliant AST, and renew the tenancy when the term ends." />
        </div>
      </section>

      <section>
        <div className="section-t">Pricing</div>
        {(['free', 'landlord', 'agent'] as PlanId[]).map((id) => <PlanCard key={id} id={id} />)}
        <p className="faint" style={{ fontSize: 11, margin: '8px 0 0' }}>
          Plus a one-off £100 fee when a tenancy agreement is fully signed. Renters are never charged
          (Tenant Fees Act 2019).
        </p>
      </section>

      <section id="get-started" style={{ padding: '26px 0 10px' }}>
        <div className="section-t">Get started</div>
        <SignIn embedded />
      </section>

      <footer style={{ padding: '18px 0 34px' }}>
        <p className="faint" style={{ fontSize: 11, lineHeight: 1.5 }}>
          Apex supports Assured Shorthold Tenancies in England. Compliance rules are kept current with
          UK legislation. Nothing here is legal or tax advice.
        </p>
      </footer>
    </div>
  );
}

function Feature({ ic, title, text }: { ic: string; title: string; text: string }) {
  return (
    <div className="card" style={{ margin: 0 }}>
      <div className="body">
        <div style={{ fontSize: 22, marginBottom: 6 }}>{ic}</div>
        <b style={{ fontSize: 14 }}>{title}</b>
        <p className="faint" style={{ fontSize: 12, lineHeight: 1.5, margin: '5px 0 0' }}>{text}</p>
      </div>
    </div>
  );
}

function PlanCard({ id }: { id: PlanId }) {
  const plan = PLANS[id];
  const price = plan.basePence === 0
    ? '£0/mo'
    : `${id === 'agent' ? 'from ' : ''}${formatGBP(plan.basePence)}/mo`;
  return (
    <div className="card">
      <div className="body">
        <div className="row center" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
          <b style={{ fontSize: 15 }}>{plan.name}</b>
          <span className="price" style={{ fontSize: 18 }}>{price}</span>
        </div>
        <p className="faint" style={{ fontSize: 12, margin: '0 0 8px' }}>{plan.blurb}</p>
        <div className="row wrap" style={{ gap: 6 }}>
          {plan.features.map((f) => <span key={f} className="pill">{f}</span>)}
        </div>
      </div>
    </div>
  );
}

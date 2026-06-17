import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { EpcRating } from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { createListing, type CreateListingResult, type NewListingInput } from '../lib/db';

export default function NewProperty() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [result, setResult] = useState<CreateListingResult | null>(null);

  const mutation = useMutation({
    mutationFn: (input: NewListingInput) => createListing(input),
    onSuccess: (res) => {
      setResult(res);
      queryClient.invalidateQueries({ queryKey: ['listings'] });
    },
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user) return;
    const f = new FormData(e.currentTarget);
    const input: NewListingInput = {
      landlordId: user.uid,
      title: String(f.get('title') ?? '').trim(),
      street: String(f.get('street') ?? '').trim(),
      area: String(f.get('area') ?? '').trim(),
      city: String(f.get('city') ?? '').trim(),
      postcode: String(f.get('postcode') ?? '').trim().toUpperCase(),
      type: String(f.get('type') ?? 'Flat'),
      beds: Number(f.get('beds') ?? 0),
      baths: Number(f.get('baths') ?? 1),
      rentPence: Math.round(Number(f.get('rent') ?? 0) * 100),
      furnished: String(f.get('furnished') ?? 'Unfurnished'),
      epcRating: String(f.get('epc') ?? 'C') as EpcRating,
      desc: String(f.get('desc') ?? '').trim(),
      hasGasSupply: f.get('gas') === 'on',
      smokeAlarmsPerStorey: f.get('smoke') === 'on',
      coAlarmsWhereRequired: f.get('co') === 'on',
    };
    mutation.mutate(input);
  }

  if (result) return <Result result={result} onDone={() => navigate('/landlord')} />;

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <div className="back" onClick={() => navigate('/landlord')}>‹</div>
        <b style={{ fontSize: 18 }}>Advertise a property</b>
      </div>

      <form onSubmit={submit}>
        <div className="field"><label>Headline</label>
          <input name="title" required placeholder="Bright 2-bed flat near the park" /></div>
        <div className="field"><label>Street address</label>
          <input name="street" required placeholder="14 Mapledene Road" /></div>
        <div className="two">
          <div className="field"><label>Area</label><input name="area" required placeholder="Hackney" /></div>
          <div className="field"><label>City</label><input name="city" required placeholder="London" /></div>
        </div>
        <div className="two">
          <div className="field"><label>Postcode</label><input name="postcode" required placeholder="E8 3JN" /></div>
          <div className="field"><label>Type</label>
            <select name="type"><option>Flat</option><option>House</option><option>Studio</option><option>Maisonette</option><option>Room</option></select></div>
        </div>
        <div className="two">
          <div className="field"><label>Bedrooms</label><input name="beds" type="number" defaultValue={2} min={0} /></div>
          <div className="field"><label>Bathrooms</label><input name="baths" type="number" defaultValue={1} min={1} /></div>
        </div>
        <div className="two">
          <div className="field"><label>Rent (£ / month)</label><input name="rent" type="number" required defaultValue={1500} /></div>
          <div className="field"><label>EPC rating</label>
            <select name="epc" defaultValue="C"><option>A</option><option>B</option><option>C</option><option>D</option><option>E</option><option>F</option><option>G</option></select></div>
        </div>
        <div className="field"><label>Furnishing</label>
          <select name="furnished"><option>Furnished</option><option>Unfurnished</option><option>Part-furnished</option></select></div>
        <div className="field"><label>Description</label>
          <textarea name="desc" placeholder="What makes this home special…" /></div>

        <div className="section-t">Compliance declarations</div>
        <div className="card"><div className="body">
          <Check name="gas" label="Has a mains gas supply (needs an annual CP12)" defaultChecked />
          <Check name="smoke" label="Smoke alarm on every storey" defaultChecked />
          <Check name="co" label="Carbon-monoxide alarms where required" defaultChecked />
        </div></div>
        <p className="faint" style={{ fontSize: 11, margin: '0 0 14px' }}>
          We check these against UK letting rules. If anything’s missing, your listing is saved as a draft until it’s resolved.
        </p>

        {mutation.isError && <p className="error">Could not save — please try again.</p>}
        <button className="cta" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Publishing…' : 'Publish listing'}
        </button>
      </form>
    </>
  );
}

function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="row center" style={{ gap: 10, padding: '8px 0', cursor: 'pointer' }}>
      <input type="checkbox" name={name} defaultChecked={defaultChecked} style={{ width: 18, height: 18 }} />
      <span style={{ fontSize: 14 }}>{label}</span>
    </label>
  );
}

function Result({ result, onDone }: { result: CreateListingResult; onDone: () => void }) {
  const live = result.status === 'live';
  return (
    <div style={{ paddingTop: 20 }}>
      <div className="empty">
        <div className="big">{live ? '✅' : '📝'}</div>
        <h2 className="title">{live ? 'Listing is live' : 'Saved as a draft'}</h2>
        <p className="sub">
          {live
            ? 'Your property passed all statutory checks and is now searchable by renters.'
            : 'Some statutory checks aren’t met yet — fix these to publish.'}
        </p>
      </div>
      <ul className="checklist">
        {result.checks.map((c) => (
          <li key={c.id}>
            <span className={`ck ${c.ok ? 'ok' : 'no'}`}>{c.ok ? '✓' : '✕'}</span>
            <div>
              {c.label}
              {c.detail && <><br /><span className="faint" style={{ fontSize: 12 }}>{c.detail}</span></>}
            </div>
          </li>
        ))}
      </ul>
      <button className="cta" style={{ marginTop: 18 }} onClick={onDone}>Back to your listings</button>
    </div>
  );
}

import { type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { EpcRating } from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { createListing, type NewListingInput } from '../lib/db';

export default function NewProperty() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (input: NewListingInput) => createListing(input),
    onSuccess: ({ id }) => {
      queryClient.invalidateQueries({ queryKey: ['listings'] });
      // Drafts go live only after compliance docs are uploaded + published,
      // which happens on the listing's own page.
      navigate(`/listing/${id}`);
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

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <div className="back" onClick={() => navigate('/landlord/listings')}>‹</div>
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
          Next you’ll upload the certificates (EPC, EICR, gas). We re-check everything before the listing goes live.
        </p>

        {mutation.isError && <p className="error">Could not save — please try again.</p>}
        <button className="cta" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Creating…' : 'Create listing & add documents'}
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


import { type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { EpcRating } from '@rentmatch/shared';
import { useAuth } from '../auth/AuthProvider';
import { createTrackedProperty, type TrackedPropertyInput } from '../lib/db';

/**
 * Add a property purely to monitor its compliance — no rent, no advert. This is
 * the on-ramp for the standalone wedge: a landlord can onboard for certificate
 * tracking without ever touching the marketplace. They can advertise it later.
 */
export default function TrackProperty() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (input: TrackedPropertyInput) => createTrackedProperty(input),
    onSuccess: ({ id }) => {
      queryClient.invalidateQueries({ queryKey: ['listings'] });
      navigate(`/landlord/property/${id}`); // straight into the document vault
    },
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user) return;
    const f = new FormData(e.currentTarget);
    mutation.mutate({
      landlordId: user.uid,
      landlordName: user.displayName ?? 'Landlord',
      street: String(f.get('street') ?? '').trim(),
      area: String(f.get('area') ?? '').trim(),
      city: String(f.get('city') ?? '').trim(),
      postcode: String(f.get('postcode') ?? '').trim().toUpperCase(),
      type: String(f.get('type') ?? 'Flat'),
      epcRating: String(f.get('epc') ?? 'C') as EpcRating,
      hasGasSupply: f.get('gas') === 'on',
      smokeAlarmsPerStorey: f.get('smoke') === 'on',
      coAlarmsWhereRequired: f.get('co') === 'on',
    });
  }

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <div className="back" onClick={() => navigate('/landlord/compliance')}>‹</div>
        <b style={{ fontSize: 18 }}>Add a property to track</b>
      </div>
      <p className="sub">Just the address and a few details — we'll track its certificates and remind you before any lapse. No advert, no rent details needed.</p>

      <form onSubmit={submit}>
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
        <div className="field"><label>EPC rating</label>
          <select name="epc" defaultValue="C"><option>A</option><option>B</option><option>C</option><option>D</option><option>E</option><option>F</option><option>G</option></select></div>

        <div className="section-t">Compliance declarations</div>
        <div className="card"><div className="body">
          <Check name="gas" label="Has a mains gas supply (needs an annual CP12)" defaultChecked />
          <Check name="smoke" label="Smoke alarm on every storey" defaultChecked />
          <Check name="co" label="Carbon-monoxide alarms where required" defaultChecked />
        </div></div>

        {mutation.isError && <p className="error">Could not save — please try again.</p>}
        <button className="cta" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Adding…' : 'Add property & upload certificates'}
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

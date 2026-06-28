import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { createTenancy, fetchLandlordListings, type NewTenancyInput, type Listing } from '../lib/db';

const propertyLabel = (l: Listing) => [l.street, l.city].filter(Boolean).join(', ') || l.title || 'Property';

export default function NewTenancy() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');

  const { data: properties = [] } = useQuery({
    queryKey: ['listings', 'landlord', user?.uid],
    queryFn: () => fetchLandlordListings(user!.uid),
    enabled: !!user,
  });

  const mutation = useMutation({
    mutationFn: (input: NewTenancyInput) => createTenancy(input),
    onSuccess: ({ id }) => {
      queryClient.invalidateQueries({ queryKey: ['tenancies'] });
      navigate(`/landlord/rent/${id}`);
    },
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!user) return;
    const f = new FormData(e.currentTarget);
    const listingId = String(f.get('property') ?? '');
    const property = properties.find((p) => p.id === listingId);
    const startStr = String(f.get('start') ?? '');
    if (!property || !startStr) {
      setError('Pick a property and a start date.');
      return;
    }
    mutation.mutate({
      landlordId: user.uid,
      listingId,
      propertyLabel: propertyLabel(property),
      tenantName: String(f.get('tenant') ?? '').trim(),
      monthlyRentPence: Math.round(Number(f.get('rent') ?? 0) * 100),
      startDate: new Date(startStr).getTime(),
      termMonths: Number(f.get('term') ?? 12),
    });
  }

  return (
    <>
      <div className="row center" style={{ gap: 10, margin: '2px 0 12px' }}>
        <div className="back" onClick={() => navigate('/landlord/rent')}>‹</div>
        <b style={{ fontSize: 18 }}>Add a tenancy</b>
      </div>

      {properties.length === 0 ? (
        <div className="empty"><div className="big">🏠</div>Add a property first, then create a tenancy against it.</div>
      ) : (
        <form onSubmit={submit}>
          <div className="field"><label>Property</label>
            <select name="property" required defaultValue="">
              <option value="" disabled>Select a property…</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{propertyLabel(p)}</option>)}
            </select></div>
          <div className="field"><label>Tenant name</label>
            <input name="tenant" required placeholder="Tom Baxter" /></div>
          <div className="two">
            <div className="field"><label>Monthly rent (£)</label>
              <input name="rent" type="number" min={0} step="0.01" required defaultValue={1500} /></div>
            <div className="field"><label>Term (months)</label>
              <input name="term" type="number" min={1} defaultValue={12} required /></div>
          </div>
          <div className="field"><label>First rent due date</label>
            <input name="start" type="date" required /></div>

          {(error || mutation.isError) && <p className="error">{error || 'Could not save — please try again.'}</p>}
          <button className="cta" type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating…' : 'Create tenancy'}
          </button>
        </form>
      )}
    </>
  );
}

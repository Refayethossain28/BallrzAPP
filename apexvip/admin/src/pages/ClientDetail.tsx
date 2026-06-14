import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, Phone, Mail, MapPin, CreditCard, Edit, Star, FileText } from 'lucide-react';
import Layout from '../components/Layout';
import StatusBadge from '../components/StatusBadge';
import Avatar from '../components/Avatar';
import { mockClients, mockBookings } from '../data/mockData';

export default function ClientDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [note, setNote] = useState('');
  const [clients, setClients] = useState(mockClients);

  const client = clients.find(c => c.id === id);
  if (!client) {
    return (
      <Layout>
        <div style={{ textAlign: 'center', padding: '80px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>404</div>
          <div style={{ color: '#888', marginBottom: '24px' }}>Client not found</div>
          <button onClick={() => navigate('/clients')} style={{ background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '10px 20px', cursor: 'pointer', color: '#0f0f0f', fontWeight: 600 }}>Back to Clients</button>
        </div>
      </Layout>
    );
  }

  const clientBookings = mockBookings.filter(b => b.clientId === client.id);
  const completedBookings = clientBookings.filter(b => b.status === 'completed');

  const addNote = () => {
    if (!note.trim()) return;
    setClients(prev => prev.map(c => c.id === client.id ? { ...c, notes: c.notes ? `${c.notes}\n${note}` : note } : c));
    setNote('');
  };

  const upgradeTier = () => {
    const tiers = ['Standard', 'VIP', 'VVIP'] as const;
    const current = tiers.indexOf(client.tier);
    if (current < tiers.length - 1) {
      setClients(prev => prev.map(c => c.id === client.id ? { ...c, tier: tiers[current + 1] } : c));
    }
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', overflow: 'hidden', marginBottom: '16px' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: '12px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</div>
      <div style={{ padding: '20px' }}>{children}</div>
    </div>
  );

  return (
    <Layout>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <button onClick={() => navigate('/clients')} style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', color: '#888', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
          <ArrowLeft size={14} /> Back
        </button>
      </div>

      {/* Profile Header */}
      <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '28px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
          <Avatar name={client.name} size={80} fontSize={28} />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: '#fff' }}>{client.name}</h1>
              <StatusBadge status={client.tier} size="md" />
            </div>
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
              {[
                { label: 'Total Bookings', value: client.totalBookings },
                { label: 'Total Spend', value: `£${client.totalSpent.toLocaleString()}` },
                { label: 'Completed', value: completedBookings.length },
                { label: 'Member Since', value: format(new Date(client.joinedDate), 'MMM yyyy') },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div style={{ fontSize: '11px', color: '#555', marginBottom: '2px' }}>{label}</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button style={{ background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', color: '#C9A84C', fontSize: '13px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Edit size={13} /> Edit
            </button>
            {client.tier !== 'VVIP' && (
              <button onClick={upgradeTier} style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', color: '#22c55e', fontSize: '13px', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Star size={13} /> Upgrade Tier
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '16px' }}>
        {/* Main */}
        <div>
          {/* Booking History */}
          <Section title="Booking History">
            {clientBookings.length === 0 ? (
              <div style={{ color: '#555', textAlign: 'center', padding: '20px' }}>No bookings yet</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['ID', 'Route', 'Date', 'Vehicle', 'Status', 'Fare'].map(h => <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: '10px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {clientBookings.map(b => (
                    <tr key={b.id} onClick={() => navigate(`/bookings/${b.id}`)} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }} onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <td style={{ padding: '9px 10px', fontSize: '11px', color: '#C9A84C', fontWeight: 600 }}>{b.id}</td>
                      <td style={{ padding: '9px 10px', fontSize: '12px', color: '#888', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.pickup.split(',')[0]} → {b.dropoff.split(',')[0]}</td>
                      <td style={{ padding: '9px 10px', fontSize: '12px', color: '#666', whiteSpace: 'nowrap' }}>{format(new Date(b.dateTime), 'd MMM yyyy')}</td>
                      <td style={{ padding: '9px 10px', fontSize: '12px', color: '#666' }}>{b.vehicleClass ?? '—'}</td>
                      <td style={{ padding: '9px 10px' }}><StatusBadge status={b.status} /></td>
                      <td style={{ padding: '9px 10px', fontSize: '13px', color: '#fff', fontWeight: 600 }}>£{b.price}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {/* Notes */}
          <Section title="Notes & Preferences">
            {client.notes && (
              <div style={{ background: '#222', borderRadius: '8px', padding: '12px', marginBottom: '14px', fontSize: '13px', color: '#ccc', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                {client.notes}
              </div>
            )}
            {client.preferences && (
              <div style={{ background: 'rgba(201,168,76,0.05)', border: '1px solid rgba(201,168,76,0.15)', borderRadius: '8px', padding: '12px', marginBottom: '14px' }}>
                <div style={{ fontSize: '11px', color: '#C9A84C', fontWeight: 600, marginBottom: '4px' }}>PREFERENCES</div>
                <div style={{ fontSize: '13px', color: '#ccc' }}>{client.preferences}</div>
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px' }}>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note..." onKeyDown={e => e.key === 'Enter' && addNote()} style={{ flex: 1, background: '#222', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '9px 14px', fontSize: '13px', color: '#fff', outline: 'none' }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
              <button onClick={addNote} style={{ background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '9px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#0f0f0f', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <FileText size={13} /> Add
              </button>
            </div>
          </Section>
        </div>

        {/* Side */}
        <div>
          {/* Contact Info */}
          <Section title="Contact">
            {[
              { icon: <Phone size={13} />, label: 'Phone', value: client.phone },
              { icon: <Mail size={13} />, label: 'Email', value: client.email },
              { icon: <MapPin size={13} />, label: 'Address', value: client.address ?? '—' },
            ].map(({ icon, label, value }) => (
              <div key={label} style={{ display: 'flex', gap: '12px', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div style={{ color: '#555', flexShrink: 0, marginTop: 1 }}>{icon}</div>
                <div>
                  <div style={{ fontSize: '11px', color: '#555', marginBottom: '2px' }}>{label}</div>
                  <div style={{ fontSize: '13px', color: '#ccc' }}>{value}</div>
                </div>
              </div>
            ))}
          </Section>

          {/* Payment Methods */}
          <Section title="Payment Methods">
            {client.paymentMethods.map(pm => (
              <div key={pm.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div style={{ width: 36, height: 36, borderRadius: '8px', background: 'rgba(59,130,246,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <CreditCard size={16} style={{ color: '#3b82f6' }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '13px', color: '#fff', fontWeight: 500 }}>
                    {pm.type === 'account' ? pm.brand : `${pm.brand} ···· ${pm.last4}`}
                  </div>
                  {pm.isDefault && <div style={{ fontSize: '10px', color: '#22c55e' }}>Default</div>}
                </div>
              </div>
            ))}
          </Section>

          {/* Spend Stats */}
          <Section title="Spend Summary">
            {[
              { label: 'Total Spend', value: `£${client.totalSpent.toLocaleString()}`, highlight: true },
              { label: 'Total Bookings', value: client.totalBookings },
              { label: 'Avg per Booking', value: `£${Math.round(client.totalSpent / client.totalBookings)}` },
              { label: 'Last Booking', value: client.lastBooking ? format(new Date(client.lastBooking), 'd MMM yyyy') : '—' },
              { label: 'Tier', value: client.tier },
            ].map(({ label, value, highlight }) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span style={{ fontSize: '12px', color: '#666' }}>{label}</span>
                <span style={{ fontSize: '13px', color: highlight ? '#C9A84C' : '#ccc', fontWeight: highlight ? 700 : 400 }}>{value}</span>
              </div>
            ))}
          </Section>
        </div>
      </div>
    </Layout>
  );
}

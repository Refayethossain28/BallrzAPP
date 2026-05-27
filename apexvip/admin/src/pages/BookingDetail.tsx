import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import {
  ArrowLeft, MapPin, Car, Phone, Mail,
  Clock, FileText, CheckCircle, XCircle, AlertCircle,
  Plane, Users, Banknote, Edit,
} from 'lucide-react';
import Layout from '../components/Layout';
import StatusBadge from '../components/StatusBadge';
import Avatar from '../components/Avatar';
import { mockBookings, mockDrivers } from '../data/mockData';
import type { BookingStatus } from '../types';

const STATUS_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export default function BookingDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [bookings, setBookings] = useState(mockBookings);
  const [newNote, setNewNote] = useState('');

  const booking = bookings.find(b => b.id === id);

  if (!booking) {
    return (
      <Layout>
        <div style={{ textAlign: 'center', padding: '80px 40px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>404</div>
          <div style={{ color: '#888', marginBottom: '24px' }}>Booking not found</div>
          <button onClick={() => navigate('/bookings')} style={{ background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '10px 20px', cursor: 'pointer', color: '#0f0f0f', fontWeight: 600 }}>
            Back to Bookings
          </button>
        </div>
      </Layout>
    );
  }

  const driver = mockDrivers.find(d => d.id === booking.driverId);
  const transitions = STATUS_TRANSITIONS[booking.status];

  const updateStatus = (status: BookingStatus) => {
    setBookings(prev => prev.map(b => b.id === booking.id
      ? {
          ...b, status,
          timeline: [...b.timeline, {
            id: `EV-${Date.now()}`,
            timestamp: new Date().toISOString(),
            event: `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`,
            description: `Status updated to ${status} via admin portal`,
          }],
        }
      : b
    ));
  };

  const assignDriver = (driverId: string) => {
    const d = mockDrivers.find(dr => dr.id === driverId);
    setBookings(prev => prev.map(b => b.id === booking.id
      ? { ...b, driverId: d?.id, driverName: d?.name, vehicleId: d?.vehicleId, vehicleReg: d?.vehicleReg, vehicleClass: d?.vehicleClass }
      : b
    ));
  };

  const addNote = () => {
    if (!newNote.trim()) return;
    setBookings(prev => prev.map(b => b.id === booking.id
      ? {
          ...b,
          notes: b.notes ? `${b.notes}\n${newNote}` : newNote,
          timeline: [...b.timeline, {
            id: `EV-${Date.now()}`,
            timestamp: new Date().toISOString(),
            event: 'Note Added',
            description: newNote,
          }],
        }
      : b
    ));
    setNewNote('');
  };

  const statusButtonColor = (s: BookingStatus) => {
    if (s === 'confirmed') return { bg: '#3b82f6', color: '#fff' };
    if (s === 'active') return { bg: '#22c55e', color: '#fff' };
    if (s === 'completed') return { bg: '#888', color: '#fff' };
    if (s === 'cancelled') return { bg: 'rgba(239,68,68,0.15)', color: '#ef4444' };
    return { bg: '#1c1c1c', color: '#ccc' };
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{
      background: '#1c1c1c',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '12px',
      overflow: 'hidden',
      marginBottom: '16px',
    }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: '13px', fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</div>
      <div style={{ padding: '20px' }}>{children}</div>
    </div>
  );

  const InfoRow = ({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: '12px', color: '#666' }}>{label}</span>
      <span style={{ fontSize: '13px', color: highlight ? '#C9A84C' : '#ccc', fontWeight: highlight ? 600 : 400 }}>{value}</span>
    </div>
  );

  return (
    <Layout>
      {/* Back + Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        <button onClick={() => navigate('/bookings')} style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', color: '#888', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
          <ArrowLeft size={14} /> Back
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: '#fff' }}>Booking {booking.id}</h1>
            <StatusBadge status={booking.status} size="md" />
          </div>
          <div style={{ fontSize: '13px', color: '#666', marginTop: '2px' }}>
            {format(new Date(booking.dateTime), "EEEE, d MMMM yyyy 'at' HH:mm")}
          </div>
        </div>
        {transitions.length > 0 && (
          <div style={{ display: 'flex', gap: '8px' }}>
            {transitions.map(s => {
              const { bg, color } = statusButtonColor(s);
              return (
                <button
                  key={s}
                  onClick={() => updateStatus(s)}
                  style={{ background: bg, border: 'none', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color, display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  {s === 'confirmed' && <CheckCircle size={13} />}
                  {s === 'active' && <AlertCircle size={13} />}
                  {s === 'completed' && <CheckCircle size={13} />}
                  {s === 'cancelled' && <XCircle size={13} />}
                  Mark {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '16px' }}>
        {/* Main Column */}
        <div>
          {/* Route */}
          <Section title="Journey Details">
            <div style={{ display: 'flex', gap: '20px', marginBottom: '20px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '11px', color: '#666', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Pickup</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <MapPin size={14} style={{ color: '#22c55e', flexShrink: 0, marginTop: 2 }} />
                  <div style={{ fontSize: '14px', color: '#fff' }}>{booking.pickup}</div>
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '11px', color: '#666', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Drop-off</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <MapPin size={14} style={{ color: '#ef4444', flexShrink: 0, marginTop: 2 }} />
                  <div style={{ fontSize: '14px', color: '#fff' }}>{booking.dropoff}</div>
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
              {[
                { icon: <Clock size={14} />, label: 'Date & Time', value: format(new Date(booking.dateTime), 'd MMM yyyy HH:mm') },
                { icon: <Users size={14} />, label: 'Passengers', value: `${booking.passengers} pax` },
                { icon: <Car size={14} />, label: 'Service Type', value: booking.serviceType.charAt(0).toUpperCase() + booking.serviceType.slice(1) },
                ...(booking.flightNumber ? [{ icon: <Plane size={14} />, label: 'Flight', value: booking.flightNumber }] : []),
              ].map(item => (
                <div key={item.label} style={{ background: '#222', borderRadius: '8px', padding: '12px' }}>
                  <div style={{ color: '#555', marginBottom: '6px' }}>{item.icon}</div>
                  <div style={{ fontSize: '11px', color: '#555', marginBottom: '2px' }}>{item.label}</div>
                  <div style={{ fontSize: '13px', color: '#ccc', fontWeight: 500 }}>{item.value}</div>
                </div>
              ))}
            </div>
          </Section>

          {/* Assign Driver */}
          <Section title="Driver Assignment">
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <select
                defaultValue={booking.driverId ?? ''}
                onChange={e => assignDriver(e.target.value)}
                style={{ flex: 1, background: '#222', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#fff', outline: 'none' }}
              >
                <option value="">Unassigned</option>
                {mockDrivers.map(d => <option key={d.id} value={d.id}>{d.name} — {d.vehicleReg ?? 'No vehicle'} ({d.status})</option>)}
              </select>
              <button style={{ background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '10px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#0f0f0f', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
                <Edit size={13} /> Update
              </button>
            </div>
          </Section>

          {/* Timeline */}
          <Section title="Booking Timeline">
            <div style={{ position: 'relative' }}>
              {booking.timeline.map((event, i) => (
                <div key={event.id} style={{ display: 'flex', gap: '14px', marginBottom: i < booking.timeline.length - 1 ? '16px' : 0 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#C9A84C', flexShrink: 0, marginTop: 4 }} />
                    {i < booking.timeline.length - 1 && <div style={{ width: 1, flex: 1, background: 'rgba(255,255,255,0.06)', marginTop: 4, marginBottom: -10 }} />}
                  </div>
                  <div style={{ flex: 1, paddingBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>{event.event}</div>
                      <div style={{ fontSize: '11px', color: '#555', flexShrink: 0, marginLeft: 12 }}>{format(new Date(event.timestamp), 'd MMM HH:mm')}</div>
                    </div>
                    <div style={{ fontSize: '12px', color: '#888', marginTop: '2px' }}>{event.description}</div>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Notes */}
          <Section title="Notes">
            {booking.notes && (
              <div style={{ background: '#222', borderRadius: '8px', padding: '12px', marginBottom: '14px', fontSize: '13px', color: '#ccc', lineHeight: 1.6 }}>
                {booking.notes}
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px' }}>
              <input
                value={newNote}
                onChange={e => setNewNote(e.target.value)}
                placeholder="Add a note..."
                onKeyDown={e => e.key === 'Enter' && addNote()}
                style={{ flex: 1, background: '#222', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '9px 14px', fontSize: '13px', color: '#fff', outline: 'none' }}
                onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')}
                onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')}
              />
              <button onClick={addNote} style={{ background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '9px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#0f0f0f' }}>
                Add
              </button>
            </div>
          </Section>
        </div>

        {/* Side Column */}
        <div>
          {/* Client Info */}
          <Section title="Client">
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
              <Avatar name={booking.clientName} size={44} />
              <div>
                <div style={{ fontSize: '15px', fontWeight: 600, color: '#fff' }}>{booking.clientName}</div>
                <div style={{ fontSize: '12px', color: '#C9A84C', cursor: 'pointer' }} onClick={() => navigate(`/clients/${booking.clientId}`)}>
                  View profile →
                </div>
              </div>
            </div>
            <div>
              <InfoRow label="Phone" value={<span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><Phone size={11} />{booking.clientPhone}</span>} />
              <InfoRow label="Email" value={<span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><Mail size={11} />{booking.clientEmail}</span>} />
            </div>
          </Section>

          {/* Driver Info */}
          {driver && (
            <Section title="Driver">
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
                <div style={{ position: 'relative' }}>
                  <Avatar name={driver.name} size={44} />
                  <div style={{ position: 'absolute', bottom: 0, right: 0, width: 10, height: 10, borderRadius: '50%', background: driver.status === 'on-trip' ? '#3b82f6' : '#22c55e', border: '2px solid #1c1c1c' }} />
                </div>
                <div>
                  <div style={{ fontSize: '15px', fontWeight: 600, color: '#fff' }}>{driver.name}</div>
                  <div style={{ fontSize: '12px', color: '#888' }}>{'★'.repeat(Math.round(driver.rating))} {driver.rating}</div>
                  <div style={{ fontSize: '12px', color: '#C9A84C', cursor: 'pointer', marginTop: '2px' }} onClick={() => navigate(`/drivers/${driver.id}`)}>View profile →</div>
                </div>
              </div>
              <InfoRow label="Phone" value={<span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><Phone size={11} />{driver.phone}</span>} />
              <InfoRow label="Vehicle" value={driver.vehicleReg ?? '—'} />
              <InfoRow label="Class" value={driver.vehicleClass ?? '—'} />
            </Section>
          )}

          {/* Price / Invoice */}
          <Section title="Price & Invoice">
            <InfoRow label="Service Type" value={booking.serviceType.charAt(0).toUpperCase() + booking.serviceType.slice(1)} />
            <InfoRow label="Vehicle Class" value={booking.vehicleClass ?? '—'} />
            <InfoRow label="Passengers" value={`${booking.passengers} pax`} />
            <div style={{ marginTop: '14px', padding: '14px', background: '#222', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#888', fontSize: '13px' }}>
                <Banknote size={16} />
                Total Amount
              </div>
              <div style={{ fontSize: '22px', fontWeight: 700, color: '#fff' }}>£{booking.price.toFixed(2)}</div>
            </div>
            <button style={{ width: '100%', marginTop: '12px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '9px', cursor: 'pointer', color: '#888', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
              <FileText size={13} /> Download Invoice
            </button>
          </Section>
        </div>
      </div>
    </Layout>
  );
}

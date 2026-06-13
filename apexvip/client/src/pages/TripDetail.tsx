import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Phone, Star, MapPin, Calendar, Clock, Users, Plane, Download, AlertCircle, Car } from 'lucide-react';
import { MOCK_TRIPS } from '../data/mockData';
import StatusBadge from '../components/StatusBadge';
import { format, parseISO } from 'date-fns';

const SERVICE_LABELS: Record<string, string> = {
  airport: 'Airport Transfer',
  hourly: 'Hourly Charter',
  day: 'Day Charter',
};

const VEHICLE_LABELS: Record<string, string> = {
  's-class': 'Mercedes-Benz S-Class',
  'v-class': 'Mercedes-Benz V-Class',
};

export default function TripDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [cancelConfirm, setCancelConfirm] = useState(false);

  const trip = MOCK_TRIPS.find(t => t.id === id);

  if (!trip) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0a0a0a', maxWidth: 480, margin: '0 auto',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 16, padding: 24,
      }}>
        <AlertCircle size={40} color="#555555" />
        <div style={{ fontSize: 18, fontWeight: 600, color: '#ffffff' }}>Trip not found</div>
        <button
          onClick={() => navigate('/trips')}
          style={{
            padding: '12px 24px', background: '#C9A84C', color: '#0a0a0a',
            border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: 'pointer',
          }}
        >
          Back to Trips
        </button>
      </div>
    );
  }

  const formattedDate = (() => {
    try { return format(parseISO(trip.date), 'EEEE, d MMMM yyyy'); }
    catch { return trip.date; }
  })();

  const Row = ({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <Icon size={16} color="#555555" style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 11, color: '#555555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 14, color: '#cccccc' }}>{value}</div>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', maxWidth: 480, margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        padding: '52px 20px 18px',
        background: '#111111',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <button
            onClick={() => navigate('/trips')}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
              color: '#888888', padding: 0,
            }}
          >
            <ArrowLeft size={18} />
            <span style={{ fontSize: 13 }}>Trips</span>
          </button>
          <StatusBadge status={trip.status} />
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#ffffff', marginBottom: 4 }}>
          {SERVICE_LABELS[trip.serviceType]}
        </div>
        <div style={{ fontSize: 12, color: '#888888', letterSpacing: '0.04em' }}>
          Ref: <span style={{ color: '#C9A84C', fontWeight: 600 }}>{trip.bookingRef}</span>
        </div>
      </div>

      <div style={{ padding: '20px', paddingBottom: 100, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Map placeholder */}
        <div style={{
          width: '100%',
          height: 160,
          background: 'linear-gradient(135deg, #111111 0%, #1a1a1a 50%, #111111 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 24px, rgba(255,255,255,0.03) 24px, rgba(255,255,255,0.03) 25px), repeating-linear-gradient(90deg, transparent, transparent 24px, rgba(255,255,255,0.03) 24px, rgba(255,255,255,0.03) 25px)',
          }} />
          <MapPin size={28} color="rgba(201,168,76,0.4)" />
          <div style={{ fontSize: 12, color: '#555555' }}>Route Map</div>

          {/* Route line */}
          <div style={{
            position: 'absolute', top: 20, left: '20%', right: '20%',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#C9A84C', flexShrink: 0 }} />
            <div style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, #C9A84C, #555555)', opacity: 0.4 }} />
            <div style={{ width: 8, height: 8, borderRadius: 2, background: '#555555', flexShrink: 0 }} />
          </div>
        </div>

        {/* Route details */}
        <div style={{
          background: '#111111',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#555555' }}>
            Journey Details
          </div>
          <Row icon={MapPin} label="Pickup" value={trip.pickup} />
          <Row icon={MapPin} label="Dropoff" value={trip.dropoff} />
          <Row icon={Calendar} label="Date" value={formattedDate} />
          <Row icon={Clock} label="Time" value={trip.time} />
          <Row icon={Users} label="Passengers" value={`${trip.passengers}`} />
          <Row icon={Car} label="Vehicle" value={VEHICLE_LABELS[trip.vehicleType]} />
          {trip.flightNumber && <Row icon={Plane} label="Flight" value={trip.flightNumber} />}
          {trip.duration && <Row icon={Clock} label="Duration" value={`${trip.duration} hours`} />}
        </div>

        {/* Driver card */}
        {trip.driver && (
          <div style={{
            background: '#111111',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 16,
            padding: '18px',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#555555', marginBottom: 14 }}>
              Chauffeur
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{
                width: 52, height: 52, borderRadius: '50%',
                background: 'rgba(201,168,76,0.1)',
                border: '2px solid rgba(201,168,76,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, fontWeight: 700, color: '#C9A84C', flexShrink: 0,
              }}>
                {trip.driver.name.split(' ').map(n => n[0]).join('')}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#ffffff', marginBottom: 4 }}>
                  {trip.driver.name}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Star size={12} color="#C9A84C" fill="#C9A84C" />
                  <span style={{ fontSize: 12, color: '#C9A84C', fontWeight: 600 }}>{trip.driver.rating}</span>
                  <span style={{ color: '#555555', fontSize: 12 }}> · {trip.driver.plate}</span>
                </div>
              </div>
              <a
                href={`tel:${trip.driver.phone}`}
                style={{
                  width: 40, height: 40, borderRadius: 12,
                  background: 'rgba(201,168,76,0.1)',
                  border: '1px solid rgba(201,168,76,0.2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  textDecoration: 'none',
                }}
              >
                <Phone size={18} color="#C9A84C" />
              </a>
            </div>
          </div>
        )}

        {/* Price */}
        <div style={{
          background: '#111111',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '18px',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#555555', marginBottom: 12 }}>
            Fare
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14, color: '#888888' }}>Total charged</span>
            <span style={{ fontSize: 24, fontWeight: 800, color: '#C9A84C' }}>£{trip.price.toFixed(2)}</span>
          </div>
          {(trip.status === 'completed') && (
            <button
              style={{
                marginTop: 12,
                width: '100%',
                padding: '12px',
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                color: '#888888',
                fontSize: 13,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <Download size={15} />
              Download Receipt
            </button>
          )}
        </div>

        {/* Notes */}
        {trip.notes && (
          <div style={{
            background: '#111111',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 16,
            padding: '18px',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#555555', marginBottom: 8 }}>
              Notes
            </div>
            <div style={{ fontSize: 14, color: '#888888', lineHeight: 1.6 }}>{trip.notes}</div>
          </div>
        )}

        {/* Cancel */}
        {trip.status === 'upcoming' && !cancelConfirm && (
          <button
            onClick={() => setCancelConfirm(true)}
            style={{
              width: '100%',
              padding: '14px',
              background: 'rgba(239,68,68,0.06)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 14,
              color: '#ef4444',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Cancel Booking
          </button>
        )}

        {cancelConfirm && (
          <div style={{
            background: 'rgba(239,68,68,0.07)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 14,
            padding: 18,
          }}>
            <div style={{ fontSize: 14, color: '#ffffff', fontWeight: 600, marginBottom: 6 }}>
              Cancel this booking?
            </div>
            <div style={{ fontSize: 13, color: '#888888', marginBottom: 16, lineHeight: 1.5 }}>
              Cancellations within 2 hours of pickup may incur a fee. This action cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => { navigate('/trips'); }}
                style={{
                  flex: 1, padding: '12px',
                  background: '#ef4444', border: 'none', borderRadius: 10,
                  color: '#ffffff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Yes, Cancel
              </button>
              <button
                onClick={() => setCancelConfirm(false)}
                style={{
                  flex: 1, padding: '12px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 10,
                  color: '#888888', fontSize: 14, cursor: 'pointer',
                }}
              >
                Keep Booking
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

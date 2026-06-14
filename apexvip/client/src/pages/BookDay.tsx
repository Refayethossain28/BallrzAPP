import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, MapPin, Calendar, Users, FileText, Info } from 'lucide-react';
import { useBooking } from '../context/BookingContext';

const iStyle = (focused: boolean): React.CSSProperties => ({
  width: '100%',
  background: '#111111',
  border: `1px solid ${focused ? 'rgba(201,168,76,0.6)' : 'rgba(255,255,255,0.1)'}`,
  borderRadius: 12,
  padding: '14px 16px 14px 44px',
  color: '#ffffff',
  fontSize: 14,
  outline: 'none',
  fontFamily: 'inherit',
  boxSizing: 'border-box' as const,
  transition: 'border-color 0.2s',
});

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: '#888888',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  marginBottom: 8,
  display: 'block',
};

export default function BookDay() {
  const navigate = useNavigate();
  const { booking, setBookingField } = useBooking();
  const [focus, setFocus] = useState<string | null>(null);
  const today = new Date().toISOString().split('T')[0];

  const isValid = booking.pickup && booking.date;

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', maxWidth: 480, margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        padding: '52px 20px 20px',
        background: '#111111',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}>
        <button
          onClick={() => navigate('/home')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            color: '#888888', marginBottom: 14, padding: 0,
          }}
        >
          <ArrowLeft size={18} />
          <span style={{ fontSize: 13 }}>Back</span>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 10,
            background: 'rgba(201,168,76,0.1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Calendar size={20} color="#C9A84C" strokeWidth={1.8} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff' }}>Day Charter</div>
            <div style={{ fontSize: 12, color: '#888888' }}>Full day with dedicated chauffeur</div>
          </div>
        </div>
      </div>

      <div style={{ padding: '24px 20px', paddingBottom: 100, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Info banner */}
        <div style={{
          display: 'flex', gap: 12, alignItems: 'flex-start',
          background: 'rgba(201,168,76,0.05)',
          border: '1px solid rgba(201,168,76,0.15)',
          borderRadius: 12,
          padding: '14px 16px',
        }}>
          <Info size={16} color="#C9A84C" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 13, color: '#888888', lineHeight: 1.6 }}>
            Day hire includes up to 10 hours with your dedicated driver. Ideal for corporate events, shopping, or sightseeing.
          </div>
        </div>

        {/* Pickup */}
        <div>
          <label style={labelStyle}>Starting Location</label>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <MapPin size={17} color={focus === 'pickup' ? '#C9A84C' : '#555555'} />
            </div>
            <input
              type="text"
              placeholder="Where should your chauffeur collect you?"
              value={booking.pickup}
              onChange={e => setBookingField('pickup', e.target.value)}
              onFocus={() => setFocus('pickup')}
              onBlur={() => setFocus(null)}
              style={iStyle(focus === 'pickup')}
            />
          </div>
        </div>

        {/* Date */}
        <div>
          <label style={labelStyle}>Date</label>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <Calendar size={17} color={focus === 'date' ? '#C9A84C' : '#555555'} />
            </div>
            <input
              type="date"
              min={today}
              value={booking.date}
              onChange={e => setBookingField('date', e.target.value)}
              onFocus={() => setFocus('date')}
              onBlur={() => setFocus(null)}
              style={{ ...iStyle(focus === 'date'), colorScheme: 'dark' }}
            />
          </div>
        </div>

        {/* Passengers */}
        <div>
          <label style={labelStyle}>Passengers</label>
          <div style={{
            display: 'flex', alignItems: 'center',
            background: '#111111',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            padding: '12px 16px',
          }}>
            <Users size={17} color="#555555" style={{ marginRight: 12 }} />
            <span style={{ flex: 1, color: '#ffffff', fontSize: 14 }}>
              {booking.passengers} {booking.passengers === 1 ? 'passenger' : 'passengers'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
              {[1,2,3,4,5,6,7].map(n => (
                <button
                  key={n}
                  onClick={() => setBookingField('passengers', n)}
                  style={{
                    width: 30, height: 30, borderRadius: 8,
                    border: 'none',
                    background: booking.passengers === n ? '#C9A84C' : 'rgba(255,255,255,0.06)',
                    color: booking.passengers === n ? '#0a0a0a' : '#888888',
                    fontSize: 12, fontWeight: 600,
                    cursor: 'pointer', margin: '0 2px',
                    transition: 'all 0.15s',
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Itinerary / Notes */}
        <div>
          <label style={labelStyle}>Itinerary / Notes <span style={{ color: '#555555', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 13, top: 14, pointerEvents: 'none' }}>
              <FileText size={17} color={focus === 'notes' ? '#C9A84C' : '#555555'} />
            </div>
            <textarea
              placeholder="Describe your day's itinerary, destinations, or any special requirements..."
              value={booking.notes}
              onChange={e => setBookingField('notes', e.target.value)}
              onFocus={() => setFocus('notes')}
              onBlur={() => setFocus(null)}
              rows={5}
              style={{
                width: '100%',
                background: '#111111',
                border: `1px solid ${focus === 'notes' ? 'rgba(201,168,76,0.6)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 12,
                padding: '13px 16px 13px 44px',
                color: '#ffffff',
                fontSize: 14,
                outline: 'none',
                resize: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                transition: 'border-color 0.2s',
                lineHeight: 1.6,
              }}
            />
          </div>
        </div>

        {/* Pricing */}
        <div style={{
          background: 'rgba(201,168,76,0.05)',
          border: '1px solid rgba(201,168,76,0.15)',
          borderRadius: 12,
          padding: '14px 16px',
        }}>
          <div style={{ fontSize: 12, color: '#C9A84C', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            Day Rate Pricing
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: '#888888' }}>S-Class sedan (up to 10hrs)</span>
            <span style={{ fontSize: 13, color: '#cccccc', fontWeight: 600 }}>£480</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: '#888888' }}>V-Class van (up to 10hrs)</span>
            <span style={{ fontSize: 13, color: '#cccccc', fontWeight: 600 }}>£580</span>
          </div>
          <div style={{ fontSize: 11, color: '#555555', marginTop: 8 }}>
            Additional hours billed at hourly rate. VAT included.
          </div>
        </div>
      </div>

      {/* Footer CTA */}
      <div style={{
        position: 'fixed',
        bottom: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        width: '100%',
        maxWidth: 480,
        padding: '16px 20px',
        background: 'rgba(10,10,10,0.97)',
        borderTop: '1px solid rgba(255,255,255,0.07)',
        backdropFilter: 'blur(20px)',
      }}>
        <button
          onClick={() => isValid && navigate('/book/vehicle')}
          disabled={!isValid}
          style={{
            width: '100%',
            padding: '16px',
            background: isValid ? '#C9A84C' : 'rgba(201,168,76,0.3)',
            color: isValid ? '#0a0a0a' : 'rgba(10,10,10,0.5)',
            border: 'none',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: isValid ? 'pointer' : 'not-allowed',
          }}
        >
          Select Vehicle
        </button>
      </div>
    </div>
  );
}

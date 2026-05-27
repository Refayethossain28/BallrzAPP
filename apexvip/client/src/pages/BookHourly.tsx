import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, MapPin, Calendar, Clock, Users } from 'lucide-react';
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

const DURATIONS = [2, 3, 4, 5, 6, 8, 10, 12];

export default function BookHourly() {
  const navigate = useNavigate();
  const { booking, setBookingField } = useBooking();
  const [focus, setFocus] = useState<string | null>(null);
  const today = new Date().toISOString().split('T')[0];

  const isValid = booking.pickup && booking.date && booking.time && booking.duration >= 2;

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
            <Clock size={20} color="#C9A84C" strokeWidth={1.8} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff' }}>Hourly Charter</div>
            <div style={{ fontSize: 12, color: '#888888' }}>Your driver stays for the full duration</div>
          </div>
        </div>
      </div>

      <div style={{ padding: '24px 20px', paddingBottom: 100, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Pickup */}
        <div>
          <label style={labelStyle}>Starting Location</label>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <MapPin size={17} color={focus === 'pickup' ? '#C9A84C' : '#555555'} />
            </div>
            <input
              type="text"
              placeholder="Where should your driver meet you?"
              value={booking.pickup}
              onChange={e => setBookingField('pickup', e.target.value)}
              onFocus={() => setFocus('pickup')}
              onBlur={() => setFocus(null)}
              style={iStyle(focus === 'pickup')}
            />
          </div>
        </div>

        {/* Date & Time */}
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
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
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Start Time</label>
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                <Clock size={17} color={focus === 'time' ? '#C9A84C' : '#555555'} />
              </div>
              <input
                type="time"
                value={booking.time}
                onChange={e => setBookingField('time', e.target.value)}
                onFocus={() => setFocus('time')}
                onBlur={() => setFocus(null)}
                style={{ ...iStyle(focus === 'time'), colorScheme: 'dark' }}
              />
            </div>
          </div>
        </div>

        {/* Duration */}
        <div>
          <label style={labelStyle}>Duration</label>
          <div style={{
            background: '#111111',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            padding: '16px',
          }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {DURATIONS.map(h => (
                <button
                  key={h}
                  onClick={() => setBookingField('duration', h)}
                  style={{
                    padding: '10px 18px',
                    borderRadius: 10,
                    border: booking.duration === h ? '1.5px solid #C9A84C' : '1px solid rgba(255,255,255,0.1)',
                    background: booking.duration === h ? 'rgba(201,168,76,0.1)' : 'transparent',
                    color: booking.duration === h ? '#C9A84C' : '#888888',
                    fontSize: 13,
                    fontWeight: booking.duration === h ? 600 : 400,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {h} hr{h > 1 ? 's' : ''}
                </button>
              ))}
            </div>
            {booking.duration >= 2 && (
              <div style={{ marginTop: 12, fontSize: 12, color: '#888888' }}>
                Estimated end time:{' '}
                <span style={{ color: '#C9A84C' }}>
                  {booking.time
                    ? (() => {
                        const [h, m] = booking.time.split(':').map(Number);
                        const end = new Date(2000, 0, 1, h + booking.duration, m);
                        return end.toTimeString().slice(0, 5);
                      })()
                    : '—'
                  }
                </span>
              </div>
            )}
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

        {/* Pricing info */}
        <div style={{
          background: 'rgba(201,168,76,0.05)',
          border: '1px solid rgba(201,168,76,0.15)',
          borderRadius: 12,
          padding: '14px 16px',
        }}>
          <div style={{ fontSize: 12, color: '#C9A84C', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            Pricing Guide
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: '#888888' }}>S-Class sedan</span>
            <span style={{ fontSize: 13, color: '#cccccc' }}>£65/hr</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: '#888888' }}>V-Class van</span>
            <span style={{ fontSize: 13, color: '#cccccc' }}>£75/hr</span>
          </div>
          {booking.duration >= 2 && (
            <div style={{
              marginTop: 10, paddingTop: 10,
              borderTop: '1px solid rgba(201,168,76,0.15)',
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span style={{ fontSize: 13, color: '#888888' }}>Estimated ({booking.duration}hr, S-Class)</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#C9A84C' }}>£{booking.duration * 65}</span>
            </div>
          )}
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

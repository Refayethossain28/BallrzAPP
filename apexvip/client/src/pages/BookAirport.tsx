import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, MapPin, Plane, Calendar, Clock, Users, Baby, Briefcase, FileText, ChevronDown } from 'lucide-react';
import { useBooking } from '../context/BookingContext';
import { AIRPORTS } from '../data/mockData';

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

export default function BookAirport() {
  const navigate = useNavigate();
  const { booking, setBookingField } = useBooking();
  const [focus, setFocus] = useState<string | null>(null);

  const today = new Date().toISOString().split('T')[0];

  const handleContinue = () => {
    if (!booking.pickup || !booking.airport || !booking.date || !booking.time) return;
    navigate('/book/vehicle');
  };

  const isValid = booking.pickup && booking.airport && booking.date && booking.time;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      maxWidth: 480,
      margin: '0 auto',
    }}>
      {/* Header */}
      <div style={{
        padding: '52px 20px 20px',
        background: '#111111',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
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
            <Plane size={20} color="#C9A84C" strokeWidth={1.8} />
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff' }}>Airport Transfer</div>
            <div style={{ fontSize: 12, color: '#888888' }}>Fixed price, meet &amp; greet included</div>
          </div>
        </div>
      </div>

      <div style={{ padding: '24px 20px', paddingBottom: 100, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Pickup */}
        <div>
          <label style={labelStyle}>Pickup Address</label>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <MapPin size={17} color={focus === 'pickup' ? '#C9A84C' : '#555555'} />
            </div>
            <input
              type="text"
              placeholder="Enter pickup address"
              value={booking.pickup}
              onChange={e => setBookingField('pickup', e.target.value)}
              onFocus={() => setFocus('pickup')}
              onBlur={() => setFocus(null)}
              style={iStyle(focus === 'pickup')}
            />
          </div>
        </div>

        {/* Airport */}
        <div>
          <label style={labelStyle}>Airport</label>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <Plane size={17} color={focus === 'airport' ? '#C9A84C' : '#555555'} />
            </div>
            <select
              value={booking.airport}
              onChange={e => setBookingField('airport', e.target.value)}
              onFocus={() => setFocus('airport')}
              onBlur={() => setFocus(null)}
              style={{
                ...iStyle(focus === 'airport'),
                appearance: 'none',
                paddingRight: 44,
                cursor: 'pointer',
              }}
            >
              <option value="" style={{ background: '#111111' }}>Select airport</option>
              {AIRPORTS.flatMap(a =>
                a.terminals.map(t => (
                  <option key={`${a.code}-${t}`} value={`${a.name} ${t}`} style={{ background: '#111111' }}>
                    {a.name} — {t}
                  </option>
                ))
              )}
            </select>
            <div style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <ChevronDown size={16} color="#555555" />
            </div>
          </div>
        </div>

        {/* Flight number */}
        <div>
          <label style={labelStyle}>Flight Number <span style={{ color: '#555555', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <Plane size={17} color={focus === 'flight' ? '#C9A84C' : '#555555'} />
            </div>
            <input
              type="text"
              placeholder="e.g. BA0117"
              value={booking.flightNumber}
              onChange={e => setBookingField('flightNumber', e.target.value.toUpperCase())}
              onFocus={() => setFocus('flight')}
              onBlur={() => setFocus(null)}
              style={{ ...iStyle(focus === 'flight'), textTransform: 'uppercase' }}
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
                style={{
                  ...iStyle(focus === 'date'),
                  colorScheme: 'dark',
                }}
              />
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Time</label>
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
                style={{
                  ...iStyle(focus === 'time'),
                  colorScheme: 'dark',
                }}
              />
            </div>
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
              {[1,2,3,4,5,6,7,8].map(n => (
                <button
                  key={n}
                  onClick={() => setBookingField('passengers', n)}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    border: 'none',
                    background: booking.passengers === n ? '#C9A84C' : 'rgba(255,255,255,0.06)',
                    color: booking.passengers === n ? '#0a0a0a' : '#888888',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    margin: '0 2px',
                    transition: 'all 0.15s',
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Child Seats */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: '#111111',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          padding: '14px 16px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Baby size={17} color="#555555" />
            <div>
              <div style={{ fontSize: 14, color: '#ffffff' }}>Child Seat</div>
              <div style={{ fontSize: 11, color: '#888888' }}>Complimentary on request</div>
            </div>
          </div>
          <button
            onClick={() => setBookingField('childSeats', !booking.childSeats)}
            style={{
              width: 48,
              height: 28,
              borderRadius: 14,
              background: booking.childSeats ? '#C9A84C' : 'rgba(255,255,255,0.1)',
              border: 'none',
              cursor: 'pointer',
              position: 'relative',
              transition: 'background 0.2s',
            }}
          >
            <div style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: '#ffffff',
              position: 'absolute',
              top: 3,
              left: booking.childSeats ? 23 : 3,
              transition: 'left 0.2s',
              boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
            }} />
          </button>
        </div>

        {/* Luggage */}
        <div>
          <label style={labelStyle}>Luggage Pieces</label>
          <div style={{
            display: 'flex', alignItems: 'center',
            background: '#111111',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            padding: '12px 16px',
          }}>
            <Briefcase size={17} color="#555555" style={{ marginRight: 12 }} />
            <span style={{ flex: 1, color: '#ffffff', fontSize: 14 }}>
              {booking.luggage} {booking.luggage === 1 ? 'piece' : 'pieces'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                onClick={() => booking.luggage > 0 && setBookingField('luggage', booking.luggage - 1)}
                style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: 'rgba(255,255,255,0.06)',
                  border: 'none', color: '#888888',
                  fontSize: 18, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >−</button>
              <span style={{ fontSize: 16, fontWeight: 600, color: '#ffffff', minWidth: 20, textAlign: 'center' }}>
                {booking.luggage}
              </span>
              <button
                onClick={() => booking.luggage < 10 && setBookingField('luggage', booking.luggage + 1)}
                style={{
                  width: 32, height: 32, borderRadius: 8,
                  background: 'rgba(255,255,255,0.06)',
                  border: 'none', color: '#C9A84C',
                  fontSize: 18, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >+</button>
            </div>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label style={labelStyle}>Special Instructions <span style={{ color: '#555555', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: 13, top: 14, pointerEvents: 'none' }}>
              <FileText size={17} color={focus === 'notes' ? '#C9A84C' : '#555555'} />
            </div>
            <textarea
              placeholder="Any special requests or instructions..."
              value={booking.notes}
              onChange={e => setBookingField('notes', e.target.value)}
              onFocus={() => setFocus('notes')}
              onBlur={() => setFocus(null)}
              rows={3}
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
                lineHeight: 1.5,
              }}
            />
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
          onClick={handleContinue}
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
            transition: 'all 0.2s',
          }}
        >
          Select Vehicle
        </button>
      </div>
    </div>
  );
}

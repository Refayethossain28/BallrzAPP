import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Phone, Star } from 'lucide-react';
import { useBooking } from '../context/BookingContext';
import { MOCK_TRIPS } from '../data/mockData';

function generateRef() {
  const num = Math.floor(Math.random() * 90) + 10;
  return `AVP-2026-0${num}`;
}

export default function BookingConfirmed() {
  const navigate = useNavigate();
  const { booking, resetBooking } = useBooking();
  const [visible, setVisible] = useState(false);
  const [ref] = useState(generateRef);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  const upcomingTrip = MOCK_TRIPS[0]; // use first mock trip for driver details

  const handleReturnHome = () => {
    resetBooking();
    navigate('/home');
  };

  const handleViewTrip = () => {
    resetBooking();
    navigate('/trips');
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      maxWidth: 480,
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '60px 24px 40px',
    }}>
      {/* Check animation */}
      <div style={{
        width: 100,
        height: 100,
        borderRadius: '50%',
        background: 'rgba(201,168,76,0.08)',
        border: `2px solid ${visible ? '#C9A84C' : 'transparent'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'border-color 0.6s ease, box-shadow 0.6s ease',
        boxShadow: visible ? '0 0 40px rgba(201,168,76,0.15)' : 'none',
        marginBottom: 28,
      }}>
        <div style={{
          opacity: visible ? 1 : 0,
          transform: visible ? 'scale(1)' : 'scale(0.5)',
          transition: 'all 0.5s ease 0.3s',
        }}>
          <Check size={46} color="#C9A84C" strokeWidth={2.5} />
        </div>
      </div>

      {/* Title */}
      <div style={{
        textAlign: 'center',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(12px)',
        transition: 'all 0.5s ease 0.4s',
        marginBottom: 32,
      }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: '#ffffff', marginBottom: 8 }}>
          Booking Confirmed
        </div>
        <div style={{ fontSize: 14, color: '#888888', lineHeight: 1.6, marginBottom: 16 }}>
          Your ride has been booked successfully.
          <br />You'll receive a confirmation shortly.
        </div>
        <div style={{
          display: 'inline-block',
          background: 'rgba(201,168,76,0.08)',
          border: '1px solid rgba(201,168,76,0.25)',
          borderRadius: 10,
          padding: '8px 20px',
        }}>
          <div style={{ fontSize: 11, color: '#888888', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 2 }}>
            Booking Reference
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#C9A84C', letterSpacing: '0.08em' }}>
            {ref}
          </div>
        </div>
      </div>

      {/* Driver card */}
      <div style={{
        width: '100%',
        background: '#111111',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 18,
        padding: '18px',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(16px)',
        transition: 'all 0.5s ease 0.55s',
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#555555', marginBottom: 14 }}>
          Assigned Driver
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Avatar */}
          <div style={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            background: 'rgba(201,168,76,0.12)',
            border: '2px solid rgba(201,168,76,0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            fontWeight: 700,
            color: '#C9A84C',
            flexShrink: 0,
          }}>
            {upcomingTrip.driver?.name.split(' ').map(n => n[0]).join('')}
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#ffffff', marginBottom: 3 }}>
              {upcomingTrip.driver?.name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Star size={12} color="#C9A84C" fill="#C9A84C" />
              <span style={{ fontSize: 12, color: '#C9A84C', fontWeight: 600 }}>{upcomingTrip.driver?.rating}</span>
              <span style={{ fontSize: 12, color: '#555555' }}>· {upcomingTrip.driver?.vehicle}</span>
            </div>
          </div>

          <a
            href={`tel:${upcomingTrip.driver?.phone}`}
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: 'rgba(201,168,76,0.1)',
              border: '1px solid rgba(201,168,76,0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textDecoration: 'none',
            }}
          >
            <Phone size={18} color="#C9A84C" />
          </a>
        </div>

        <div style={{
          marginTop: 14,
          paddingTop: 14,
          borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          gap: 16,
        }}>
          <div>
            <div style={{ fontSize: 10, color: '#555555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Vehicle</div>
            <div style={{ fontSize: 12, color: '#cccccc' }}>{upcomingTrip.driver?.vehicle}</div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#555555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Plate</div>
            <div style={{ fontSize: 12, color: '#cccccc', fontWeight: 600 }}>{upcomingTrip.driver?.plate}</div>
          </div>
        </div>
      </div>

      {/* Buttons */}
      <div style={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.5s ease 0.7s',
      }}>
        <button
          onClick={handleViewTrip}
          style={{
            width: '100%',
            padding: '16px',
            background: '#C9A84C',
            color: '#0a0a0a',
            border: 'none',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          View Trip Details
        </button>
        <button
          onClick={handleReturnHome}
          style={{
            width: '100%',
            padding: '15px',
            background: 'transparent',
            color: '#888888',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Return Home
        </button>
      </div>
    </div>
  );
}

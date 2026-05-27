import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, MapPin, ArrowUpDown, Plane, Clock, Calendar } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useBooking } from '../context/BookingContext';
import { MOCK_TRIPS } from '../data/mockData';
import Layout from '../components/Layout';
import TripCard from '../components/TripCard';
import ServiceCard from '../components/ServiceCard';

export default function Home() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { setBookingFields, setServiceType } = useBooking();
  const [pickup, setPickup] = useState('');
  const [dropoff, setDropoff] = useState('');
  const [focusPickup, setFocusPickup] = useState(false);
  const [focusDropoff, setFocusDropoff] = useState(false);

  const upcomingTrips = MOCK_TRIPS.filter(t => t.status === 'upcoming');
  const recentTrips = MOCK_TRIPS.filter(t => t.status !== 'upcoming').slice(0, 2);

  const firstName = user?.name?.split(' ')[0] || 'there';

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const handleServiceSelect = (type: 'airport' | 'hourly' | 'day') => {
    setServiceType(type);
    setBookingFields({ pickup, dropoff, serviceType: type });
    if (type === 'airport') navigate('/book/airport');
    else if (type === 'hourly') navigate('/book/hourly');
    else navigate('/book/day');
  };

  const swap = () => {
    const tmp = pickup;
    setPickup(dropoff);
    setDropoff(tmp);
  };

  return (
    <Layout>
      <div style={{ padding: '0 0 16px' }}>
        {/* Top bar */}
        <div style={{
          padding: '52px 20px 20px',
          background: 'linear-gradient(180deg, #111111 0%, #0a0a0a 100%)',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
            <div>
              <div style={{ fontSize: 13, color: '#888888', marginBottom: 4, letterSpacing: '0.03em' }}>
                {greeting},
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#ffffff' }}>
                {firstName}
              </div>
            </div>

            <button
              onClick={() => navigate('/notifications')}
              style={{
                background: '#1a1a1a',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 12,
                width: 44,
                height: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                position: 'relative',
              }}
            >
              <Bell size={20} color="#cccccc" strokeWidth={1.8} />
              <div style={{
                position: 'absolute',
                top: 10,
                right: 10,
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#C9A84C',
                border: '1.5px solid #111111',
              }} />
            </button>
          </div>

          {/* Location inputs */}
          <div style={{
            background: '#1a1a1a',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 16,
            overflow: 'hidden',
          }}>
            {/* Pickup */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <div style={{ position: 'absolute', left: 14, zIndex: 1 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#C9A84C', border: '2px solid #C9A84C' }} />
              </div>
              <input
                type="text"
                placeholder="Pickup location"
                value={pickup}
                onChange={e => setPickup(e.target.value)}
                onFocus={() => setFocusPickup(true)}
                onBlur={() => setFocusPickup(false)}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: '#ffffff',
                  fontSize: 14,
                  padding: '14px 50px 14px 34px',
                  fontFamily: 'inherit',
                }}
              />
              <div style={{
                position: 'absolute', right: 0, top: 0, bottom: 0,
                display: 'flex', alignItems: 'center',
              }}>
                <MapPin size={16} color={focusPickup ? '#C9A84C' : '#555555'} style={{ marginRight: 14 }} />
              </div>
            </div>

            {/* Divider with swap */}
            <div style={{
              display: 'flex', alignItems: 'center',
              borderTop: '1px solid rgba(255,255,255,0.07)',
              borderBottom: '1px solid rgba(255,255,255,0.07)',
            }}>
              <div style={{
                flex: 1,
                height: 1,
                marginLeft: 34,
                background: 'rgba(255,255,255,0.05)',
              }} />
              <button
                onClick={swap}
                style={{
                  background: '#111111',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  width: 32,
                  height: 32,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  margin: '0 12px',
                  flexShrink: 0,
                }}
              >
                <ArrowUpDown size={14} color="#888888" />
              </button>
              <div style={{ flex: 1, height: 1, marginRight: 14 }} />
            </div>

            {/* Dropoff */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <div style={{ position: 'absolute', left: 14, zIndex: 1 }}>
                <div style={{ width: 10, height: 10, background: '#555555', borderRadius: 2 }} />
              </div>
              <input
                type="text"
                placeholder="Dropoff location"
                value={dropoff}
                onChange={e => setDropoff(e.target.value)}
                onFocus={() => setFocusDropoff(true)}
                onBlur={() => setFocusDropoff(false)}
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: '#ffffff',
                  fontSize: 14,
                  padding: '14px 50px 14px 34px',
                  fontFamily: 'inherit',
                }}
              />
              <div style={{
                position: 'absolute', right: 0, top: 0, bottom: 0,
                display: 'flex', alignItems: 'center',
              }}>
                <MapPin size={16} color={focusDropoff ? '#C9A84C' : '#555555'} style={{ marginRight: 14 }} />
              </div>
            </div>
          </div>
        </div>

        {/* Services */}
        <div style={{ padding: '24px 20px 0' }}>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#888888', marginBottom: 14 }}>
            Select Service
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <ServiceCard
              icon={Plane}
              title="Airport Transfer"
              subtitle="Fixed price"
              from="£85"
              onClick={() => handleServiceSelect('airport')}
            />
            <ServiceCard
              icon={Clock}
              title="By the Hour"
              subtitle="Flexible charter"
              from="£65/hr"
              onClick={() => handleServiceSelect('hourly')}
            />
            <ServiceCard
              icon={Calendar}
              title="By the Day"
              subtitle="Full day hire"
              from="£480"
              onClick={() => handleServiceSelect('day')}
            />
          </div>
        </div>

        {/* Upcoming */}
        {upcomingTrips.length > 0 && (
          <div style={{ padding: '28px 20px 0' }}>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#888888', marginBottom: 14 }}>
              Upcoming Trip
            </div>
            {upcomingTrips.map(trip => (
              <TripCard key={trip.id} trip={trip} />
            ))}
          </div>
        )}

        {/* Recent Bookings */}
        <div style={{ padding: '28px 20px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#888888' }}>
              Recent Bookings
            </div>
            <button
              onClick={() => navigate('/trips')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#C9A84C', fontSize: 13, fontWeight: 500, padding: 0 }}
            >
              View all
            </button>
          </div>
          {recentTrips.map(trip => (
            <TripCard key={trip.id} trip={trip} />
          ))}
          {recentTrips.length === 0 && (
            <div style={{
              textAlign: 'center',
              padding: '32px 0',
              color: '#555555',
              fontSize: 14,
            }}>
              No past bookings yet
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

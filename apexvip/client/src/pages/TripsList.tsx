import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { MOCK_TRIPS } from '../data/mockData';
import Layout from '../components/Layout';
import TripCard from '../components/TripCard';

const TABS = ['upcoming', 'past'] as const;
type Tab = typeof TABS[number];

export default function TripsList() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('upcoming');

  const upcoming = MOCK_TRIPS.filter(t => t.status === 'upcoming' || t.status === 'active');
  const past = MOCK_TRIPS.filter(t => t.status === 'completed' || t.status === 'cancelled');
  const shown = tab === 'upcoming' ? upcoming : past;

  return (
    <Layout>
      {/* Header */}
      <div style={{
        padding: '52px 20px 0',
        background: '#111111',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#ffffff' }}>My Trips</div>
          <button
            onClick={() => navigate('/home')}
            style={{
              width: 38, height: 38,
              borderRadius: 10,
              background: '#C9A84C',
              border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <Plus size={20} color="#0a0a0a" strokeWidth={2.5} />
          </button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, position: 'relative' }}>
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: '12px 0',
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${tab === t ? '#C9A84C' : 'transparent'}`,
                color: tab === t ? '#C9A84C' : '#888888',
                fontSize: 14,
                fontWeight: tab === t ? 600 : 400,
                cursor: 'pointer',
                textTransform: 'capitalize',
                transition: 'all 0.2s',
                letterSpacing: '0.02em',
              }}
            >
              {t === 'upcoming' ? `Upcoming (${upcoming.length})` : `Past (${past.length})`}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div style={{ padding: '20px' }}>
        {shown.length === 0 ? (
          <div style={{
            textAlign: 'center',
            padding: '60px 0',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}>
            <div style={{ fontSize: 40 }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-4H7l5-8v4h4l-5 8z"/>
              </svg>
            </div>
            <div style={{ fontSize: 15, color: '#555555' }}>
              {tab === 'upcoming' ? 'No upcoming trips' : 'No past trips'}
            </div>
            {tab === 'upcoming' && (
              <button
                onClick={() => navigate('/home')}
                style={{
                  marginTop: 8,
                  padding: '12px 24px',
                  background: '#C9A84C',
                  color: '#0a0a0a',
                  border: 'none',
                  borderRadius: 12,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Book a Ride
              </button>
            )}
          </div>
        ) : (
          shown.map(trip => <TripCard key={trip.id} trip={trip} />)
        )}
      </div>
    </Layout>
  );
}

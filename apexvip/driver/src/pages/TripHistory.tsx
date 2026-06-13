import { useState } from 'react';
import { Clock, Star, TrendingUp } from 'lucide-react';
import Layout from '../components/Layout';
import TripCard from '../components/TripCard';
import { mockTripHistory } from '../data/mockData';

type Period = 'week' | 'month' | 'all';

export default function TripHistory() {
  const [period, setPeriod] = useState<Period>('week');

  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const oneMonth = 30 * 24 * 60 * 60 * 1000;

  const filtered = mockTripHistory.filter((t) => {
    const age = now - new Date(t.date).getTime();
    if (period === 'week') return age <= oneWeek;
    if (period === 'month') return age <= oneMonth;
    return true;
  });

  const totalEarnings = filtered.reduce((s, t) => s + t.earnings + t.tip, 0);
  const avgRating =
    filtered.filter((t) => t.rating).reduce((s, t) => s + (t.rating ?? 0), 0) /
    (filtered.filter((t) => t.rating).length || 1);

  return (
    <Layout>
      {/* Header */}
      <div
        style={{
          padding: '16px 16px 0',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Clock size={18} color="#C9A84C" />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#ffffff', margin: 0 }}>Trip History</h1>
        </div>

        {/* Period tabs */}
        <div style={{ display: 'flex', gap: 0 }}>
          {(['week', 'month', 'all'] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              style={{
                flex: 1,
                padding: '10px 8px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 700,
                color: period === p ? '#C9A84C' : '#555555',
                borderBottom: `2px solid ${period === p ? '#C9A84C' : 'transparent'}`,
                transition: 'all 0.2s',
              }}
            >
              {p === 'week' ? 'This Week' : p === 'month' ? 'This Month' : 'All Time'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: '14px 16px' }}>
        {/* Summary stats */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
            marginBottom: 16,
          }}
        >
          <StatBox label="Trips" value={filtered.length.toString()} />
          <StatBox label="Earned" value={`£${totalEarnings.toLocaleString()}`} gold />
          <StatBox
            label="Avg Rating"
            value={avgRating.toFixed(1)}
            icon={<Star size={11} fill="#C9A84C" color="#C9A84C" />}
          />
        </div>

        {/* Trip list */}
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#444444' }}>
            <Clock size={40} color="#333333" style={{ margin: '0 auto 12px' }} />
            <div style={{ fontSize: 15, fontWeight: 600 }}>No trips in this period</div>
          </div>
        ) : (
          filtered.map((trip) => (
            <TripCard key={trip.id} trip={trip} />
          ))
        )}

        {/* All time summary */}
        {period === 'all' && (
          <div
            style={{
              background: '#111111',
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.07)',
              padding: '14px 16px',
              marginTop: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <TrendingUp size={14} color="#C9A84C" />
              <span style={{ fontSize: 11, fontWeight: 700, color: '#555555', letterSpacing: '0.1em' }}>
                ALL TIME STATS
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <AllTimeStat label="Total Trips" value="247" />
              <AllTimeStat label="Total Earnings" value="£18,450" />
              <AllTimeStat label="Average Rating" value="4.9 ★" />
              <AllTimeStat label="Member Since" value="Jan 2023" />
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

function StatBox({
  label,
  value,
  gold,
  icon,
}: {
  label: string;
  value: string;
  gold?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: '#111111',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.07)',
        padding: '12px 10px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 10, color: '#555555', fontWeight: 600, marginBottom: 6, letterSpacing: '0.06em' }}>
        {label.toUpperCase()}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
        {icon}
        <div style={{ fontSize: 16, fontWeight: 800, color: gold ? '#C9A84C' : '#ffffff' }}>{value}</div>
      </div>
    </div>
  );
}

function AllTimeStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#555555', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 3 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#C9A84C' }}>{value}</div>
    </div>
  );
}

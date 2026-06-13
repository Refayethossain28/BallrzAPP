import { useState } from 'react';
import { DollarSign, TrendingUp, Gift, CreditCard, Calendar } from 'lucide-react';
import Layout from '../components/Layout';
import EarningsBar from '../components/EarningsBar';
import { mockWeeklyEarnings, mockTripHistory } from '../data/mockData';
import type { EarningsData } from '../types';

type Period = 'today' | 'week' | 'month';

const todayData: EarningsData[] = [
  { day: '8am', amount: 0, trips: 0 },
  { day: '9am', amount: 85, trips: 1 },
  { day: '11am', amount: 0, trips: 0 },
  { day: '1pm', amount: 95, trips: 1 },
  { day: '3pm', amount: 72, trips: 1 },
  { day: '5pm', amount: 0, trips: 0 },
  { day: '7pm', amount: 0, trips: 0 },
];

const monthData: EarningsData[] = [
  { day: 'Wk 1', amount: 2225, trips: 21 },
  { day: 'Wk 2', amount: 1980, trips: 18 },
  { day: 'Wk 3', amount: 2650, trips: 25 },
  { day: 'Wk 4', amount: 1740, trips: 16 },
];

export default function Earnings() {
  const [period, setPeriod] = useState<Period>('week');

  const chartData = period === 'today' ? todayData : period === 'week' ? mockWeeklyEarnings : monthData;

  const totalTrips =
    period === 'today'
      ? 3
      : period === 'week'
      ? mockWeeklyEarnings.reduce((s, d) => s + d.trips, 0)
      : monthData.reduce((s, d) => s + d.trips, 0);

  const weekEarnings = mockWeeklyEarnings.reduce((s, d) => s + d.amount, 0);
  const monthEarnings = monthData.reduce((s, d) => s + d.amount, 0);

  const totalEarnings =
    period === 'today' ? 252 : period === 'week' ? weekEarnings : monthEarnings;

  const tips =
    period === 'today'
      ? 22
      : period === 'week'
      ? mockTripHistory.slice(0, 7).reduce((s, t) => s + t.tip, 0)
      : mockTripHistory.reduce((s, t) => s + t.tip, 0);

  const bonus = period === 'today' ? 0 : period === 'week' ? 50 : 125;

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
          <DollarSign size={18} color="#C9A84C" />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#ffffff', margin: 0 }}>Earnings</h1>
        </div>

        {/* Period tabs */}
        <div style={{ display: 'flex', gap: 0 }}>
          {(['today', 'week', 'month'] as Period[]).map((p) => (
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
                textTransform: 'capitalize',
                transition: 'all 0.2s',
              }}
            >
              {p === 'today' ? 'Today' : p === 'week' ? 'This Week' : 'This Month'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: '16px' }}>
        {/* Total earnings hero */}
        <div
          style={{
            background: 'linear-gradient(135deg, rgba(201,168,76,0.15), rgba(160,122,46,0.06))',
            border: '1px solid rgba(201,168,76,0.25)',
            borderRadius: 20,
            padding: '20px 20px 24px',
            marginBottom: 14,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#C9A84C', letterSpacing: '0.15em', marginBottom: 8 }}>
            {period === 'today' ? 'TODAY\'S EARNINGS' : period === 'week' ? 'THIS WEEK\'S EARNINGS' : 'THIS MONTH\'S EARNINGS'}
          </div>
          <div
            style={{
              fontSize: 52,
              fontWeight: 900,
              color: '#C9A84C',
              lineHeight: 1,
              marginBottom: 4,
              letterSpacing: '-1px',
            }}
          >
            £{totalEarnings.toLocaleString()}
          </div>
          <div style={{ fontSize: 13, color: '#888888' }}>
            {totalTrips} trips completed
          </div>
        </div>

        {/* Breakdown */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '16px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#555555', letterSpacing: '0.1em', marginBottom: 14 }}>
            BREAKDOWN
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <EarningsLine
              icon={<TrendingUp size={15} color="#C9A84C" />}
              label="Trip Earnings"
              value={`£${totalEarnings - tips - bonus}`}
              color="#C9A84C"
            />
            <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '10px 0' }} />
            <EarningsLine
              icon={<Gift size={15} color="#8b5cf6" />}
              label="Tips Received"
              value={`£${tips}`}
              color="#8b5cf6"
            />
            <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '10px 0' }} />
            <EarningsLine
              icon={<DollarSign size={15} color="#22c55e" />}
              label="Bonuses"
              value={bonus > 0 ? `£${bonus}` : '—'}
              color="#22c55e"
              dim={bonus === 0}
            />
          </div>
        </div>

        {/* Bar chart */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '16px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#555555', letterSpacing: '0.1em', marginBottom: 14 }}>
            EARNINGS CHART
          </div>
          <EarningsBar data={chartData} />
        </div>

        {/* Payout info */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '16px',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#555555', letterSpacing: '0.1em', marginBottom: 14 }}>
            PAYOUT INFORMATION
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 14,
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: 'rgba(201,168,76,0.1)',
                border: '1px solid rgba(201,168,76,0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <CreditCard size={18} color="#C9A84C" />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#ffffff' }}>Barclays Business Account</div>
              <div style={{ fontSize: 11, color: '#666666', marginTop: 2 }}>Account ending ****4521</div>
            </div>
          </div>
          <div
            style={{
              background: 'rgba(34,197,94,0.06)',
              border: '1px solid rgba(34,197,94,0.15)',
              borderRadius: 10,
              padding: '10px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Calendar size={14} color="#22c55e" />
            <div>
              <span style={{ fontSize: 12, color: '#888888' }}>Next payout: </span>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#22c55e' }}>Monday 2 June 2026</span>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: '#444444', textAlign: 'center' }}>
            Payouts processed every Monday for the previous week
          </div>
        </div>
      </div>
    </Layout>
  );
}

function EarningsLine({
  icon,
  label,
  value,
  color,
  dim,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  dim?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {icon}
        <span style={{ fontSize: 14, color: dim ? '#444444' : '#cccccc', fontWeight: 500 }}>{label}</span>
      </div>
      <span style={{ fontSize: 15, fontWeight: 700, color: dim ? '#444444' : color }}>{value}</span>
    </div>
  );
}

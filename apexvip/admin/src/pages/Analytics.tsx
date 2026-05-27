import { useState } from 'react';
import { format, subDays } from 'date-fns';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { Calendar, TrendingUp, TrendingDown } from 'lucide-react';
import Layout from '../components/Layout';
import Header from '../components/Header';
import Avatar from '../components/Avatar';
import { mockChartData, mockClients, mockDrivers, mockBookings } from '../data/mockData';

const GOLD = '#C9A84C';
const BLUE = '#3b82f6';
const GREEN = '#22c55e';
const PURPLE = '#a855f7';

const TOOLTIP_STYLE = { background: '#222', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' };
const TICK_STYLE = { fill: '#555', fontSize: 11 };

// Generate more chart data for analytics
const revenueByService = [
  { name: 'Airport Transfers', value: 22840, color: GOLD },
  { name: 'Hourly Hire', value: 9640, color: BLUE },
  { name: 'Day Rate', value: 7520, color: PURPLE },
];

const vehicleUtil = [
  { vehicle: 'LX73 ABD', trips: 8, hours: 48, revenue: 9240 },
  { vehicle: 'LX73 SLC', trips: 7, hours: 42, revenue: 8120 },
  { vehicle: 'LX72 VCL', trips: 5, hours: 28, revenue: 5840 },
  { vehicle: 'LX74 VCP', trips: 4, hours: 22, revenue: 4200 },
];

const RANGES = ['7 Days', '30 Days', '90 Days', 'This Year'];

export default function Analytics() {
  const [range, setRange] = useState('7 Days');

  const topClients = [...mockClients]
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, 5);

  const driverPerf = mockDrivers.map(d => ({
    ...d,
    tripsThisMonth: d.earnings.at(-1)?.trips ?? 0,
  })).sort((a, b) => b.earningsThisMonth - a.earningsThisMonth);

  const completedBookings = mockBookings.filter(b => b.status === 'completed');
  const totalRevenue = mockChartData.reduce((s, d) => s + d.revenue, 0);
  const totalBookings = mockChartData.reduce((s, d) => s + d.bookings, 0);
  const avgBookingValue = Math.round(totalRevenue / totalBookings);

  const ChartCard = ({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) => (
    <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '20px 24px' }}>
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>{title}</div>
        {subtitle && <div style={{ fontSize: '12px', color: '#666', marginTop: '2px' }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );

  return (
    <Layout>
      <Header title="Analytics" subtitle="Performance insights and revenue data" />

      {/* Date Range */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div style={{ display: 'flex', gap: '6px' }}>
          {RANGES.map(r => (
            <button key={r} onClick={() => setRange(r)} style={{ background: range === r ? 'rgba(201,168,76,0.15)' : '#1c1c1c', border: `1px solid ${range === r ? 'rgba(201,168,76,0.3)' : 'rgba(255,255,255,0.08)'}`, borderRadius: '8px', padding: '7px 14px', cursor: 'pointer', fontSize: '12px', fontWeight: range === r ? 600 : 400, color: range === r ? GOLD : '#888' }}>
              {r}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '7px 14px' }}>
          <Calendar size={13} style={{ color: '#555' }} />
          <span style={{ fontSize: '12px', color: '#888' }}>
            {format(subDays(new Date(), 7), 'd MMM')} — {format(new Date(), 'd MMM yyyy')}
          </span>
        </div>
      </div>

      {/* KPI Row */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        {[
          { label: 'Total Revenue', value: `£${totalRevenue.toLocaleString()}`, change: 8.4, icon: <TrendingUp size={16} /> },
          { label: 'Total Bookings', value: totalBookings, change: 12.1, icon: <TrendingUp size={16} /> },
          { label: 'Avg Booking Value', value: `£${avgBookingValue}`, change: -2.3, icon: <TrendingDown size={16} /> },
          { label: 'Completed Trips', value: completedBookings.length, change: 5.7, icon: <TrendingUp size={16} /> },
        ].map(({ label, value, change, icon }) => (
          <div key={label} style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '18px 20px', flex: 1, minWidth: '140px' }}>
            <div style={{ fontSize: '11px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '8px' }}>{label}</div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: '#fff', marginBottom: '8px' }}>{value}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ color: change >= 0 ? GREEN : '#ef4444' }}>{icon}</span>
              <span style={{ fontSize: '12px', fontWeight: 600, color: change >= 0 ? GREEN : '#ef4444' }}>
                {change >= 0 ? '+' : ''}{change}%
              </span>
              <span style={{ fontSize: '11px', color: '#555' }}>vs prior period</span>
            </div>
          </div>
        ))}
      </div>

      {/* Revenue + Bookings Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
        <ChartCard title="Revenue Trend" subtitle="Daily revenue — last 7 days">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={mockChartData}>
              <defs>
                <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={GOLD} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={GOLD} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="date" tick={TICK_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} tickFormatter={v => `£${v / 1000}k`} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#888', fontSize: 12 }} formatter={(v) => [`£${Number(v).toLocaleString()}`, 'Revenue']} />
              <Area type="monotone" dataKey="revenue" stroke={GOLD} strokeWidth={2} fill="url(#revGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Booking Volume" subtitle="Daily bookings — last 7 days">
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={mockChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="date" tick={TICK_STYLE} axisLine={false} tickLine={false} />
              <YAxis tick={TICK_STYLE} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#888', fontSize: 12 }} formatter={(v) => [Number(v), 'Bookings']} />
              <Line type="monotone" dataKey="bookings" stroke={BLUE} strokeWidth={2} dot={{ fill: BLUE, r: 4 }} activeDot={{ r: 6 }} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Service Breakdown + Top Clients */}
      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '20px', marginBottom: '20px' }}>
        <ChartCard title="Service Breakdown" subtitle="Revenue by service type">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={revenueByService} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={3} dataKey="value">
                {revenueByService.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`£${Number(v).toLocaleString()}`, 'Revenue']} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
            {revenueByService.map(item => {
              const total = revenueByService.reduce((s, d) => s + d.value, 0);
              const pct = Math.round((item.value / total) * 100);
              return (
                <div key={item.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: item.color }} />
                    <span style={{ fontSize: '12px', color: '#888' }}>{item.name}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <span style={{ fontSize: '12px', color: '#555' }}>{pct}%</span>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: '#fff' }}>£{item.value.toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </ChartCard>

        <ChartCard title="Top Clients by Spend" subtitle="All time">
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={topClients} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
              <XAxis type="number" tick={TICK_STYLE} axisLine={false} tickLine={false} tickFormatter={v => `£${v / 1000}k`} />
              <YAxis type="category" dataKey="name" tick={{ fill: '#888', fontSize: 12 }} axisLine={false} tickLine={false} width={140} />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => [`£${Number(v).toLocaleString()}`, 'Total Spend']} />
              <Bar dataKey="totalSpent" fill={GOLD} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Vehicle Utilization + Driver Performance */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <ChartCard title="Vehicle Utilization" subtitle="Trips and revenue by vehicle">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Vehicle', 'Trips', 'Hours', 'Revenue'].map(h => <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: '10px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>{h}</th>)}</tr></thead>
            <tbody>
              {vehicleUtil.map(v => (
                <tr key={v.vehicle} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#fff', fontWeight: 500 }}>{v.vehicle}</td>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#ccc' }}>{v.trips}</td>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#ccc' }}>{v.hours}h</td>
                  <td style={{ padding: '10px', fontSize: '13px', color: '#22c55e', fontWeight: 600 }}>£{v.revenue.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ChartCard>

        <ChartCard title="Driver Performance" subtitle="This month">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Driver', 'Trips', 'Rating', 'Earnings'].map(h => <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: '10px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>{h}</th>)}</tr></thead>
            <tbody>
              {driverPerf.map(d => (
                <tr key={d.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '9px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Avatar name={d.name} size={26} />
                      <span style={{ fontSize: '13px', color: '#fff' }}>{d.name.split(' ')[0]}</span>
                    </div>
                  </td>
                  <td style={{ padding: '9px 10px', fontSize: '13px', color: '#ccc' }}>{d.tripsThisMonth}</td>
                  <td style={{ padding: '9px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ color: '#f59e0b', fontSize: '12px' }}>★</span>
                      <span style={{ fontSize: '12px', color: '#ccc' }}>{d.rating}</span>
                    </div>
                  </td>
                  <td style={{ padding: '9px 10px', fontSize: '13px', color: GOLD, fontWeight: 600 }}>£{d.earningsThisMonth.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ChartCard>
      </div>
    </Layout>
  );
}

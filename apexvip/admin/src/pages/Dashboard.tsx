import { useNavigate } from 'react-router-dom';
import {
  Calendar, Car, DollarSign, Users, Plus, UserCheck, BarChart2,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { format } from 'date-fns';
import Layout from '../components/Layout';
import Header from '../components/Header';
import StatCard from '../components/StatCard';
import StatusBadge from '../components/StatusBadge';
import Avatar from '../components/Avatar';
import { mockBookings, mockDrivers, mockChartData } from '../data/mockData';

const todaysBookings = mockBookings.filter(b =>
  b.dateTime.startsWith('2026-05-27')
);
const activeRides = mockBookings.filter(b => b.status === 'active');
const todaysRevenue = todaysBookings
  .filter(b => b.status !== 'cancelled')
  .reduce((sum, b) => sum + b.price, 0);
const driversOnline = mockDrivers.filter(d => d.status === 'online' || d.status === 'on-trip');
const recentBookings = [...mockBookings]
  .sort((a, b) => new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime())
  .slice(0, 5);

const CustomTooltipArea = ({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#222', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '10px 14px' }}>
      <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '14px', fontWeight: 600, color: '#C9A84C' }}>{payload[0].value} bookings</div>
    </div>
  );
};

const CustomTooltipBar = ({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#222', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '10px 14px' }}>
      <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '14px', fontWeight: 600, color: '#3b82f6' }}>£{payload[0].value.toLocaleString()}</div>
    </div>
  );
};

export default function Dashboard() {
  const navigate = useNavigate();

  return (
    <Layout>
      <Header />

      {/* Stats */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <StatCard
          title="Today's Bookings"
          value={todaysBookings.length}
          subtitle={`${activeRides.length} currently active`}
          icon={<Calendar size={20} />}
          iconBg="#C9A84C"
          trend={{ value: 12, label: 'vs yesterday' }}
        />
        <StatCard
          title="Active Rides"
          value={activeRides.length}
          subtitle="In progress now"
          icon={<Car size={20} />}
          iconBg="#3b82f6"
        />
        <StatCard
          title="Revenue Today"
          value={`£${todaysRevenue.toLocaleString()}`}
          subtitle="All confirmed bookings"
          icon={<DollarSign size={20} />}
          iconBg="#22c55e"
          trend={{ value: 8, label: 'vs yesterday' }}
        />
        <StatCard
          title="Drivers Online"
          value={driversOnline.length}
          subtitle={`${mockDrivers.length} total drivers`}
          icon={<Users size={20} />}
          iconBg="#a855f7"
        />
      </div>

      {/* Quick Actions */}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '28px', flexWrap: 'wrap' }}>
        <button
          onClick={() => navigate('/bookings')}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            background: '#C9A84C', border: 'none', borderRadius: '10px',
            padding: '10px 18px', cursor: 'pointer',
            fontSize: '13px', fontWeight: 600, color: '#0f0f0f',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = '#d4b05c')}
          onMouseLeave={e => (e.currentTarget.style.background = '#C9A84C')}
        >
          <Plus size={15} /> New Booking
        </button>
        <button
          onClick={() => navigate('/drivers')}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '10px', padding: '10px 18px', cursor: 'pointer',
            fontSize: '13px', fontWeight: 600, color: '#ccc',
            transition: 'border-color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(201,168,76,0.4)')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
        >
          <UserCheck size={15} /> Add Driver
        </button>
        <button
          onClick={() => navigate('/analytics')}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '10px', padding: '10px 18px', cursor: 'pointer',
            fontSize: '13px', fontWeight: 600, color: '#ccc',
            transition: 'border-color 0.15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(201,168,76,0.4)')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)')}
        >
          <BarChart2 size={15} /> View Reports
        </button>
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
        {/* Bookings trend */}
        <div style={{
          background: '#1c1c1c',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '12px',
          padding: '20px 24px',
        }}>
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>Bookings Trend</div>
            <div style={{ fontSize: '12px', color: '#666' }}>Last 7 days</div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={mockChartData}>
              <defs>
                <linearGradient id="bookingGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#C9A84C" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#C9A84C" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="date" tick={{ fill: '#555', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#555', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltipArea />} />
              <Area type="monotone" dataKey="bookings" stroke="#C9A84C" strokeWidth={2} fill="url(#bookingGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Revenue chart */}
        <div style={{
          background: '#1c1c1c',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '12px',
          padding: '20px 24px',
        }}>
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>Weekly Revenue</div>
            <div style={{ fontSize: '12px', color: '#666' }}>Last 7 days</div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={mockChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="date" tick={{ fill: '#555', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#555', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `£${v / 1000}k`} />
              <Tooltip content={<CustomTooltipBar />} />
              <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Recent Bookings + Live Drivers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: '20px' }}>
        {/* Recent Bookings */}
        <div style={{
          background: '#1c1c1c',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '12px',
          overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '18px 20px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>Recent Bookings</div>
            <button
              onClick={() => navigate('/bookings')}
              style={{ background: 'none', border: 'none', color: '#C9A84C', fontSize: '12px', cursor: 'pointer', fontWeight: 500 }}
            >View all →</button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Client', 'Route', 'Vehicle', 'Driver', 'Status', 'Time'].map(h => (
                  <th key={h} style={{ padding: '8px 16px', textAlign: 'left', fontSize: '10px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentBookings.map(b => (
                <tr
                  key={b.id}
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer' }}
                  onClick={() => navigate(`/bookings/${b.id}`)}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '10px 16px' }}>
                    <div style={{ fontSize: '13px', color: '#fff', fontWeight: 500, whiteSpace: 'nowrap' }}>{b.clientName}</div>
                  </td>
                  <td style={{ padding: '10px 16px', maxWidth: '160px' }}>
                    <div style={{ fontSize: '12px', color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {b.pickup.split(',')[0]}
                    </div>
                  </td>
                  <td style={{ padding: '10px 16px', fontSize: '12px', color: '#888', whiteSpace: 'nowrap' }}>{b.vehicleClass ?? '—'}</td>
                  <td style={{ padding: '10px 16px', fontSize: '12px', color: '#888', whiteSpace: 'nowrap' }}>
                    {b.driverName ?? <span style={{ color: '#555' }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 16px' }}><StatusBadge status={b.status} /></td>
                  <td style={{ padding: '10px 16px', fontSize: '12px', color: '#666', whiteSpace: 'nowrap' }}>
                    {format(new Date(b.dateTime), 'HH:mm')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Live Drivers */}
        <div style={{
          background: '#1c1c1c',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '12px',
          overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '18px 20px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>Live Drivers</div>
            <button
              onClick={() => navigate('/drivers')}
              style={{ background: 'none', border: 'none', color: '#C9A84C', fontSize: '12px', cursor: 'pointer', fontWeight: 500 }}
            >View all →</button>
          </div>
          <div style={{ padding: '8px 0' }}>
            {mockDrivers
              .sort((a, b) => {
                const order = { 'on-trip': 0, online: 1, offline: 2 };
                return order[a.status] - order[b.status];
              })
              .map(d => (
                <div
                  key={d.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '10px 20px',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                  onClick={() => navigate(`/drivers/${d.id}`)}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ position: 'relative' }}>
                    <Avatar name={d.name} size={34} />
                    <div style={{
                      position: 'absolute', bottom: 0, right: 0,
                      width: 9, height: 9, borderRadius: '50%',
                      background: d.status === 'on-trip' ? '#3b82f6' : d.status === 'online' ? '#22c55e' : '#555',
                      border: '2px solid #1c1c1c',
                    }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 500, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
                    <div style={{ fontSize: '11px', color: '#666' }}>{d.vehicleClass ?? 'No vehicle'}</div>
                  </div>
                  <StatusBadge status={d.status} showDot />
                </div>
              ))}
          </div>
        </div>
      </div>
    </Layout>
  );
}

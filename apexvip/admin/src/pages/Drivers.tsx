import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Star, Car, TrendingUp } from 'lucide-react';
import Layout from '../components/Layout';
import Header from '../components/Header';
import Avatar from '../components/Avatar';
import StatusBadge from '../components/StatusBadge';
import DrawerForm from '../components/DrawerForm';
import { mockDrivers } from '../data/mockData';
import type { Driver, DriverStatus } from '../types';

const FILTERS: { key: DriverStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All Drivers' },
  { key: 'online', label: 'Online' },
  { key: 'offline', label: 'Offline' },
  { key: 'on-trip', label: 'On Trip' },
];

const INPUT_STYLE: React.CSSProperties = {
  background: '#222',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '8px',
  padding: '9px 14px',
  fontSize: '13px', color: '#fff',
  outline: 'none', width: '100%', boxSizing: 'border-box',
};

export default function Drivers() {
  const navigate = useNavigate();
  const [drivers] = useState<Driver[]>(mockDrivers);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<DriverStatus | 'all'>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState({
    name: '', email: '', phone: '', licenseNumber: '', licenseExpiry: '', address: '', emergencyContact: '',
  });

  const filtered = drivers.filter(d => {
    if (statusFilter !== 'all' && d.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return d.name.toLowerCase().includes(q) || d.email.toLowerCase().includes(q) || (d.vehicleReg ?? '').toLowerCase().includes(q);
    }
    return true;
  });

  const FILTER_COLORS: Record<string, string> = {
    all: '#C9A84C',
    online: '#22c55e',
    offline: '#888',
    'on-trip': '#3b82f6',
  };

  return (
    <Layout>
      <Header title="Drivers" subtitle="Manage your chauffeur fleet" />

      {/* Filter tabs + actions */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', gap: '16px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              style={{
                background: statusFilter === f.key ? FILTER_COLORS[f.key] + '22' : '#1c1c1c',
                border: `1px solid ${statusFilter === f.key ? FILTER_COLORS[f.key] + '44' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '8px',
                padding: '7px 14px',
                cursor: 'pointer',
                fontSize: '13px', fontWeight: statusFilter === f.key ? 600 : 400,
                color: statusFilter === f.key ? FILTER_COLORS[f.key] : '#888',
              }}
            >
              {f.label}
              <span style={{ marginLeft: '6px', fontSize: '11px', opacity: 0.7 }}>
                ({f.key === 'all' ? drivers.length : drivers.filter(d => d.status === f.key).length})
              </span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search drivers..."
              style={{ ...INPUT_STYLE, paddingLeft: '36px', width: '220px' }}
              onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')}
            />
          </div>
          <button
            onClick={() => setDrawerOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '9px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#0f0f0f', whiteSpace: 'nowrap' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#d4b05c')}
            onMouseLeave={e => (e.currentTarget.style.background = '#C9A84C')}
          >
            <Plus size={14} /> Add Driver
          </button>
        </div>
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px', color: '#555' }}>No drivers found.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
          {filtered.map(d => (
            <div
              key={d.id}
              onClick={() => navigate(`/drivers/${d.id}`)}
              style={{
                background: '#1c1c1c',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '12px',
                padding: '20px',
                cursor: 'pointer',
                transition: 'border-color 0.15s, transform 0.1s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(201,168,76,0.3)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
            >
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <div style={{ position: 'relative' }}>
                    <Avatar name={d.name} size={44} />
                    <div style={{
                      position: 'absolute', bottom: 0, right: 0,
                      width: 11, height: 11, borderRadius: '50%',
                      background: d.status === 'on-trip' ? '#3b82f6' : d.status === 'online' ? '#22c55e' : '#555',
                      border: '2px solid #1c1c1c',
                    }} />
                  </div>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>{d.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                      <Star size={11} style={{ color: '#f59e0b', fill: '#f59e0b' }} />
                      <span style={{ fontSize: '12px', color: '#888' }}>{d.rating}</span>
                    </div>
                  </div>
                </div>
                <StatusBadge status={d.status} />
              </div>

              {/* Details */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Car size={13} style={{ color: '#555', flexShrink: 0 }} />
                  <span style={{ fontSize: '12px', color: '#888' }}>
                    {d.vehicleClass ? `${d.vehicleClass} — ${d.vehicleReg}` : 'No vehicle assigned'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <TrendingUp size={13} style={{ color: '#555', flexShrink: 0 }} />
                  <span style={{ fontSize: '12px', color: '#888' }}>{d.totalTrips} total trips</span>
                </div>
              </div>

              {/* Footer */}
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                marginTop: '16px', paddingTop: '14px',
                borderTop: '1px solid rgba(255,255,255,0.06)',
              }}>
                <div>
                  <div style={{ fontSize: '11px', color: '#555' }}>This month</div>
                  <div style={{ fontSize: '15px', fontWeight: 700, color: '#fff' }}>£{d.earningsThisMonth.toLocaleString()}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '11px', color: '#555' }}>DBS / Insurance</div>
                  <div style={{ fontSize: '12px', marginTop: '2px' }}>
                    <span style={{ color: d.dbsVerified ? '#22c55e' : '#ef4444' }}>{d.dbsVerified ? '✓' : '✗'} DBS</span>
                    {' '}
                    <span style={{ color: d.insuranceVerified ? '#22c55e' : '#ef4444' }}>{d.insuranceVerified ? '✓' : '✗'} Ins</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Driver Drawer */}
      <DrawerForm
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Add New Driver"
        footer={
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setDrawerOpen(false)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '10px', color: '#888', cursor: 'pointer', fontSize: '13px' }}>Cancel</button>
            <button onClick={() => setDrawerOpen(false)} style={{ flex: 2, background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '10px', color: '#0f0f0f', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>Add Driver</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {[
            { key: 'name', label: 'Full Name', placeholder: 'Enter full name' },
            { key: 'email', label: 'Email Address', placeholder: 'driver@apexvip.com' },
            { key: 'phone', label: 'Phone Number', placeholder: '+44 7700 000000' },
            { key: 'licenseNumber', label: 'Driving Licence Number', placeholder: 'XXXXX000000XX0XX' },
            { key: 'licenseExpiry', label: 'Licence Expiry', type: 'date', placeholder: '' },
            { key: 'address', label: 'Home Address', placeholder: 'Enter full address' },
            { key: 'emergencyContact', label: 'Emergency Contact', placeholder: 'Name + phone number' },
          ].map(({ key, label, placeholder, type }) => (
            <div key={key}>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>{label}</label>
              <input
                type={type ?? 'text'}
                value={form[key as keyof typeof form] as string}
                onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                style={{ ...INPUT_STYLE, colorScheme: type === 'date' ? 'dark' : undefined }}
                onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')}
                onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')}
              />
            </div>
          ))}
        </div>
      </DrawerForm>
    </Layout>
  );
}

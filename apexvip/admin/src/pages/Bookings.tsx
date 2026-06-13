import { useState } from 'react';
import { Search, Plus, Filter, Calendar } from 'lucide-react';
import Layout from '../components/Layout';
import Header from '../components/Header';
import BookingsTable from '../components/BookingsTable';
import DrawerForm from '../components/DrawerForm';
import { mockBookings, mockDrivers, mockVehicles, mockClients } from '../data/mockData';
import type { Booking, BookingStatus } from '../types';

const TABS: { key: BookingStatus | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

const TAB_COLORS: Record<string, string> = {
  all: '#C9A84C',
  pending: '#f59e0b',
  confirmed: '#3b82f6',
  active: '#22c55e',
  completed: '#888',
  cancelled: '#ef4444',
};

const INPUT_STYLE: React.CSSProperties = {
  background: '#222',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '8px',
  padding: '9px 14px',
  fontSize: '13px', color: '#fff',
  outline: 'none', width: '100%', boxSizing: 'border-box',
};

export default function Bookings() {
  const [bookings, setBookings] = useState<Booking[]>(mockBookings);
  const [activeTab, setActiveTab] = useState<BookingStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [vehicleFilter, setVehicleFilter] = useState('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState({
    clientId: '',
    pickup: '',
    dropoff: '',
    dateTime: '',
    vehicleClass: 'S-Class',
    driverId: '',
    price: '',
    serviceType: 'airport',
    passengers: 1,
    notes: '',
    flightNumber: '',
  });

  const filtered = bookings.filter(b => {
    if (activeTab !== 'all' && b.status !== activeTab) return false;
    if (dateFilter && !b.dateTime.startsWith(dateFilter)) return false;
    if (vehicleFilter !== 'all' && b.vehicleClass !== vehicleFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        b.clientName.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        b.pickup.toLowerCase().includes(q) ||
        b.dropoff.toLowerCase().includes(q) ||
        (b.driverName ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const counts = TABS.reduce((acc, tab) => {
    acc[tab.key] = tab.key === 'all' ? bookings.length : bookings.filter(b => b.status === tab.key).length;
    return acc;
  }, {} as Record<string, number>);

  const handleCancel = (b: Booking) => {
    setBookings(prev => prev.map(bk => bk.id === b.id ? { ...bk, status: 'cancelled' as BookingStatus } : bk));
  };

  const handleSubmit = () => {
    const client = mockClients.find(c => c.id === form.clientId);
    const driver = mockDrivers.find(d => d.id === form.driverId);
    const vehicle = mockVehicles.find(v => v.id === driver?.vehicleId);
    const newBooking: Booking = {
      id: `BK-${String(bookings.length + 1).padStart(3, '0')}`,
      clientId: form.clientId || 'CL-001',
      clientName: client?.name ?? 'Unknown Client',
      clientPhone: client?.phone ?? '',
      clientEmail: client?.email ?? '',
      driverId: form.driverId || undefined,
      driverName: driver?.name,
      vehicleId: vehicle?.id,
      vehicleReg: vehicle?.registration,
      vehicleClass: form.vehicleClass as 'S-Class' | 'V-Class',
      pickup: form.pickup,
      dropoff: form.dropoff,
      dateTime: form.dateTime,
      status: 'pending',
      price: parseFloat(form.price) || 0,
      serviceType: form.serviceType as 'airport' | 'hourly' | 'day',
      passengers: form.passengers,
      notes: form.notes,
      flightNumber: form.flightNumber || undefined,
      timeline: [
        { id: `EV-NEW-1`, timestamp: new Date().toISOString(), event: 'Booking Created', description: 'Created via admin portal' },
      ],
    };
    setBookings(prev => [newBooking, ...prev]);
    setDrawerOpen(false);
    setForm({ clientId: '', pickup: '', dropoff: '', dateTime: '', vehicleClass: 'S-Class', driverId: '', price: '', serviceType: 'airport', passengers: 1, notes: '', flightNumber: '' });
  };

  return (
    <Layout>
      <Header title="Bookings" subtitle="Manage all chauffeur bookings" />

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0' }}>
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              background: 'none', border: 'none',
              padding: '8px 14px 12px',
              cursor: 'pointer',
              fontSize: '13px', fontWeight: activeTab === tab.key ? 600 : 500,
              color: activeTab === tab.key ? TAB_COLORS[tab.key] : '#666',
              borderBottom: `2px solid ${activeTab === tab.key ? TAB_COLORS[tab.key] : 'transparent'}`,
              transition: 'all 0.15s',
              display: 'flex', alignItems: 'center', gap: '6px',
              marginBottom: '-1px',
            }}
          >
            {tab.label}
            <span style={{
              background: activeTab === tab.key ? TAB_COLORS[tab.key] + '22' : 'rgba(255,255,255,0.06)',
              color: activeTab === tab.key ? TAB_COLORS[tab.key] : '#555',
              fontSize: '10px', fontWeight: 600,
              borderRadius: '8px', padding: '1px 6px',
            }}>
              {counts[tab.key]}
            </span>
          </button>
        ))}
      </div>

      {/* Filters + New Booking */}
      <div style={{
        background: '#1c1c1c',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: '12px',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '16px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexWrap: 'wrap',
        }}>
          <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
            <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search bookings, clients, routes..."
              style={{ ...INPUT_STYLE, paddingLeft: '36px' }}
              onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')}
            />
          </div>
          <div style={{ position: 'relative' }}>
            <Calendar size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555' }} />
            <input
              type="date"
              value={dateFilter}
              onChange={e => setDateFilter(e.target.value)}
              style={{ ...INPUT_STYLE, paddingLeft: '36px', width: '160px', colorScheme: 'dark' }}
              onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')}
              onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')}
            />
          </div>
          <div style={{ position: 'relative' }}>
            <Filter size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555' }} />
            <select
              value={vehicleFilter}
              onChange={e => setVehicleFilter(e.target.value)}
              style={{ ...INPUT_STYLE, paddingLeft: '36px', width: '140px', cursor: 'pointer' }}
            >
              <option value="all">All Vehicles</option>
              <option value="S-Class">S-Class</option>
              <option value="V-Class">V-Class</option>
            </select>
          </div>
          <button
            onClick={() => setDrawerOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              background: '#C9A84C', border: 'none', borderRadius: '8px',
              padding: '9px 16px', cursor: 'pointer',
              fontSize: '13px', fontWeight: 600, color: '#0f0f0f',
              whiteSpace: 'nowrap',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#d4b05c')}
            onMouseLeave={e => (e.currentTarget.style.background = '#C9A84C')}
          >
            <Plus size={14} /> New Booking
          </button>
        </div>
        <BookingsTable bookings={filtered} onCancel={handleCancel} />
        <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: '12px', color: '#555' }}>
          Showing {filtered.length} of {bookings.length} bookings
        </div>
      </div>

      {/* Create Booking Drawer */}
      <DrawerForm
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="New Booking"
        width={500}
        footer={
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setDrawerOpen(false)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '10px', color: '#888', cursor: 'pointer', fontSize: '13px' }}>Cancel</button>
            <button onClick={handleSubmit} style={{ flex: 2, background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '10px', color: '#0f0f0f', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>Create Booking</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Client</label>
            <select value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} style={{ ...INPUT_STYLE }}>
              <option value="">Select client...</option>
              {mockClients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.tier})</option>)}
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Pickup Location</label>
            <input value={form.pickup} onChange={e => setForm(f => ({ ...f, pickup: e.target.value }))} placeholder="Enter pickup address" style={{ ...INPUT_STYLE }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Drop-off Location</label>
            <input value={form.dropoff} onChange={e => setForm(f => ({ ...f, dropoff: e.target.value }))} placeholder="Enter destination" style={{ ...INPUT_STYLE }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Date & Time</label>
              <input type="datetime-local" value={form.dateTime} onChange={e => setForm(f => ({ ...f, dateTime: e.target.value }))} style={{ ...INPUT_STYLE, colorScheme: 'dark' }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Passengers</label>
              <input type="number" min={1} max={7} value={form.passengers} onChange={e => setForm(f => ({ ...f, passengers: parseInt(e.target.value) }))} style={{ ...INPUT_STYLE }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Service Type</label>
              <select value={form.serviceType} onChange={e => setForm(f => ({ ...f, serviceType: e.target.value }))} style={{ ...INPUT_STYLE }}>
                <option value="airport">Airport Transfer</option>
                <option value="hourly">Hourly</option>
                <option value="day">Day Rate</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Vehicle Class</label>
              <select value={form.vehicleClass} onChange={e => setForm(f => ({ ...f, vehicleClass: e.target.value }))} style={{ ...INPUT_STYLE }}>
                <option value="S-Class">Mercedes S-Class</option>
                <option value="V-Class">Mercedes V-Class</option>
              </select>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Assign Driver</label>
              <select value={form.driverId} onChange={e => setForm(f => ({ ...f, driverId: e.target.value }))} style={{ ...INPUT_STYLE }}>
                <option value="">Unassigned</option>
                {mockDrivers.map(d => <option key={d.id} value={d.id}>{d.name} ({d.status})</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Price (£)</label>
              <input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} placeholder="0.00" style={{ ...INPUT_STYLE }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Flight Number (optional)</label>
            <input value={form.flightNumber} onChange={e => setForm(f => ({ ...f, flightNumber: e.target.value }))} placeholder="e.g. BA0117" style={{ ...INPUT_STYLE }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Notes</label>
            <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Special requirements, preferences..." rows={3} style={{ ...INPUT_STYLE, resize: 'vertical' }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
          </div>
        </div>
      </DrawerForm>
    </Layout>
  );
}

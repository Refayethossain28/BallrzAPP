import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { Plus, Car, Wrench, AlertTriangle, CheckCircle, User } from 'lucide-react';
import Layout from '../components/Layout';
import Header from '../components/Header';
import StatusBadge from '../components/StatusBadge';
import DrawerForm from '../components/DrawerForm';
import { mockVehicles } from '../data/mockData';
import type { Vehicle, VehicleClass, VehicleStatus } from '../types';

const INPUT_STYLE: React.CSSProperties = {
  background: '#222', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '8px', padding: '9px 14px',
  fontSize: '13px', color: '#fff', outline: 'none',
  width: '100%', boxSizing: 'border-box',
};

const STATUS_COLORS: Record<VehicleStatus, { bg: string; icon: React.ReactNode }> = {
  available: { bg: 'rgba(34,197,94,0.08)', icon: <CheckCircle size={14} style={{ color: '#22c55e' }} /> },
  'on-trip': { bg: 'rgba(59,130,246,0.08)', icon: <Car size={14} style={{ color: '#3b82f6' }} /> },
  maintenance: { bg: 'rgba(239,68,68,0.08)', icon: <Wrench size={14} style={{ color: '#ef4444' }} /> },
};

export default function Fleet() {
  const navigate = useNavigate();
  const [classFilter, setClassFilter] = useState<VehicleClass | 'all'>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const filtered = mockVehicles.filter(v =>
    classFilter === 'all' || v.class === classFilter
  );

  const openDetail = (v: Vehicle) => {
    setSelectedVehicle(v);
    setDetailOpen(true);
  };

  const sClass = mockVehicles.filter(v => v.class === 'S-Class');
  const vClass = mockVehicles.filter(v => v.class === 'V-Class');
  const available = mockVehicles.filter(v => v.status === 'available');

  return (
    <Layout>
      <Header title="Fleet" subtitle="Manage your vehicle fleet" />

      {/* Stats */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        {[
          { label: 'Total Vehicles', value: mockVehicles.length, color: '#C9A84C' },
          { label: 'S-Class', value: sClass.length, color: '#888' },
          { label: 'V-Class', value: vClass.length, color: '#888' },
          { label: 'Available Now', value: available.length, color: '#22c55e' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '16px 20px', flex: 1, minWidth: '140px' }}>
            <div style={{ fontSize: '11px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>{label}</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Filter + Add */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', gap: '16px' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {(['all', 'S-Class', 'V-Class'] as const).map(f => (
            <button
              key={f}
              onClick={() => setClassFilter(f)}
              style={{
                background: classFilter === f ? 'rgba(201,168,76,0.15)' : '#1c1c1c',
                border: `1px solid ${classFilter === f ? 'rgba(201,168,76,0.3)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '8px', padding: '7px 14px', cursor: 'pointer',
                fontSize: '13px', fontWeight: classFilter === f ? 600 : 400,
                color: classFilter === f ? '#C9A84C' : '#888',
              }}
            >
              {f === 'all' ? 'All Vehicles' : f}
              <span style={{ marginLeft: '6px', fontSize: '11px', opacity: 0.7 }}>
                ({f === 'all' ? mockVehicles.length : mockVehicles.filter(v => v.class === f).length})
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={() => setDrawerOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '9px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#0f0f0f', whiteSpace: 'nowrap' }}
          onMouseEnter={e => (e.currentTarget.style.background = '#d4b05c')}
          onMouseLeave={e => (e.currentTarget.style.background = '#C9A84C')}
        >
          <Plus size={14} /> Add Vehicle
        </button>
      </div>

      {/* Vehicle Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
        {filtered.map(v => (
          <div
            key={v.id}
            onClick={() => openDetail(v)}
            style={{
              background: '#1c1c1c',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '12px',
              overflow: 'hidden',
              cursor: 'pointer',
              transition: 'border-color 0.15s, transform 0.1s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(201,168,76,0.3)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
          >
            {/* Vehicle visual */}
            <div style={{ background: STATUS_COLORS[v.status].bg, padding: '28px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: '18px', fontWeight: 700, color: '#fff', letterSpacing: '-0.01em' }}>{v.registration}</div>
                <div style={{ fontSize: '12px', color: '#888', marginTop: '2px' }}>{v.year} · {v.color}</div>
              </div>
              <div style={{ width: 52, height: 52, borderRadius: '12px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Car size={26} style={{ color: '#C9A84C' }} />
              </div>
            </div>

            {/* Details */}
            <div style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff', marginBottom: '4px' }}>{v.make} {v.model}</div>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '14px' }}>{v.class} · {v.specs.seats} seats · {v.specs.fuel}</div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <StatusBadge status={v.status} />
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: '#666' }}>
                  <Wrench size={11} />
                  {v.mileage.toLocaleString()} mi
                </div>
              </div>

              {v.assignedDriverName && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', background: '#222', borderRadius: '8px', marginBottom: '12px' }}>
                  <User size={12} style={{ color: '#555' }} />
                  <span style={{ fontSize: '12px', color: '#888' }}>{v.assignedDriverName}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px' }}>Last Service</div>
                  <div style={{ fontSize: '12px', color: '#ccc' }}>{format(new Date(v.lastService), 'd MMM yyyy')}</div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px' }}>Next Service</div>
                  <div style={{ fontSize: '12px', color: '#ccc' }}>{format(new Date(v.nextService), 'd MMM yyyy')}</div>
                </div>
              </div>

              {/* Expiry warnings */}
              {(new Date(v.motExpiry) < new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', padding: '6px 10px', background: 'rgba(245,158,11,0.08)', borderRadius: '6px' }}>
                  <AlertTriangle size={12} style={{ color: '#f59e0b' }} />
                  <span style={{ fontSize: '11px', color: '#f59e0b' }}>MOT due {format(new Date(v.motExpiry), 'd MMM yyyy')}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Vehicle Detail Drawer */}
      {selectedVehicle && (
        <DrawerForm
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          title={`${selectedVehicle.registration} — Details`}
          width={520}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ background: '#222', borderRadius: '10px', padding: '16px' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>{selectedVehicle.make} {selectedVehicle.model}</div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <StatusBadge status={selectedVehicle.status} size="md" />
                <span style={{ fontSize: '13px', color: '#888' }}>{selectedVehicle.class} · {selectedVehicle.year}</span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              {[
                { label: 'Registration', value: selectedVehicle.registration },
                { label: 'Year', value: selectedVehicle.year },
                { label: 'Color', value: selectedVehicle.color },
                { label: 'Mileage', value: `${selectedVehicle.mileage.toLocaleString()} mi` },
                { label: 'Seats', value: selectedVehicle.specs.seats },
                { label: 'Fuel', value: selectedVehicle.specs.fuel },
                { label: 'Transmission', value: selectedVehicle.specs.transmission },
                { label: 'Luggage', value: `${selectedVehicle.specs.luggage} bags` },
              ].map(({ label, value }) => (
                <div key={label} style={{ background: '#222', borderRadius: '8px', padding: '10px 12px' }}>
                  <div style={{ fontSize: '10px', color: '#555', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                  <div style={{ fontSize: '13px', color: '#ccc', fontWeight: 500 }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Documents */}
            <div>
              <div style={{ fontSize: '12px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>Documents</div>
              {[
                { label: 'Insurance', expiry: selectedVehicle.insuranceExpiry },
                { label: 'MOT', expiry: selectedVehicle.motExpiry },
              ].map(({ label, expiry }) => {
                const expired = new Date(expiry) < new Date();
                const expiringSoon = !expired && new Date(expiry) < new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
                return (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <span style={{ fontSize: '13px', color: '#ccc' }}>{label}</span>
                    <span style={{ fontSize: '12px', color: expired ? '#ef4444' : expiringSoon ? '#f59e0b' : '#22c55e' }}>
                      {expired ? '✗ Expired' : ''}{expiringSoon ? '⚠ ' : ''}{format(new Date(expiry), 'd MMM yyyy')}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Maintenance Log */}
            <div>
              <div style={{ fontSize: '12px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '10px' }}>Maintenance Log</div>
              {selectedVehicle.maintenanceLog.map(entry => (
                <div key={entry.id} style={{ background: '#222', borderRadius: '8px', padding: '12px', marginBottom: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>{entry.type}</div>
                    <div style={{ fontSize: '11px', color: '#555' }}>{format(new Date(entry.date), 'd MMM yyyy')}</div>
                  </div>
                  <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{entry.description}</div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <span style={{ fontSize: '11px', color: '#C9A84C' }}>£{entry.cost}</span>
                    <span style={{ fontSize: '11px', color: '#555' }}>{entry.mileage.toLocaleString()} mi</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => navigate(`/drivers/${selectedVehicle.assignedDriverId}`)} style={{ flex: 1, background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: '8px', padding: '10px', cursor: 'pointer', color: '#C9A84C', fontSize: '13px', fontWeight: 500 }}>
                View Driver
              </button>
              <button style={{ flex: 1, background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '8px', padding: '10px', cursor: 'pointer', color: '#3b82f6', fontSize: '13px', fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                <Wrench size={13} /> Log Service
              </button>
            </div>
          </div>
        </DrawerForm>
      )}

      {/* Add Vehicle Drawer */}
      <DrawerForm
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Add New Vehicle"
        footer={
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setDrawerOpen(false)} style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', padding: '10px', color: '#888', cursor: 'pointer', fontSize: '13px' }}>Cancel</button>
            <button onClick={() => setDrawerOpen(false)} style={{ flex: 2, background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '10px', color: '#0f0f0f', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>Add Vehicle</button>
          </div>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {[
            { label: 'Registration Plate', placeholder: 'LX73 XXX' },
            { label: 'Make', placeholder: 'Mercedes-Benz' },
            { label: 'Model', placeholder: 'S 500 L AMG Line' },
            { label: 'Year', placeholder: '2024', type: 'number' },
            { label: 'Color', placeholder: 'Obsidian Black' },
          ].map(({ label, placeholder, type }) => (
            <div key={label}>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>{label}</label>
              <input type={type ?? 'text'} placeholder={placeholder} style={{ ...INPUT_STYLE }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
            </div>
          ))}
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 500 }}>Vehicle Class</label>
            <select style={{ ...INPUT_STYLE }}>
              <option>S-Class</option>
              <option>V-Class</option>
            </select>
          </div>
        </div>
      </DrawerForm>
    </Layout>
  );
}

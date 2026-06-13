import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, Phone, Mail, MapPin, Star, Car, Calendar, Shield, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import Layout from '../components/Layout';
import StatusBadge from '../components/StatusBadge';
import Avatar from '../components/Avatar';
import { mockDrivers, mockBookings } from '../data/mockData';

const TABS = ['Overview', 'Trips', 'Documents', 'Earnings'];

export default function DriverDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('Overview');

  const driver = mockDrivers.find(d => d.id === id);

  if (!driver) {
    return (
      <Layout>
        <div style={{ textAlign: 'center', padding: '80px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>404</div>
          <div style={{ color: '#888', marginBottom: '24px' }}>Driver not found</div>
          <button onClick={() => navigate('/drivers')} style={{ background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '10px 20px', cursor: 'pointer', color: '#0f0f0f', fontWeight: 600 }}>Back to Drivers</button>
        </div>
      </Layout>
    );
  }

  const driverTrips = mockBookings.filter(b => b.driverId === driver.id);

  const DocRow = ({ label, verified, expires }: { label: string; verified: boolean; expires?: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ width: 34, height: 34, borderRadius: '8px', background: verified ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {verified ? <CheckCircle size={16} style={{ color: '#22c55e' }} /> : <XCircle size={16} style={{ color: '#ef4444' }} />}
        </div>
        <div>
          <div style={{ fontSize: '13px', fontWeight: 500, color: '#fff' }}>{label}</div>
          {expires && <div style={{ fontSize: '11px', color: '#666' }}>Expires: {expires}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <span style={{ background: verified ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: verified ? '#22c55e' : '#ef4444', fontSize: '11px', fontWeight: 600, borderRadius: '6px', padding: '3px 8px' }}>
          {verified ? 'Verified' : 'Required'}
        </span>
        {!verified && (
          <button style={{ background: '#C9A84C', border: 'none', borderRadius: '6px', padding: '3px 10px', cursor: 'pointer', fontSize: '11px', fontWeight: 600, color: '#0f0f0f' }}>
            Upload
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Layout>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
        <button onClick={() => navigate('/drivers')} style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', padding: '8px 12px', cursor: 'pointer', color: '#888', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
          <ArrowLeft size={14} /> Back
        </button>
      </div>

      {/* Profile Header */}
      <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '28px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <Avatar name={driver.name} size={80} fontSize={28} />
            <div style={{ position: 'absolute', bottom: 2, right: 2, width: 14, height: 14, borderRadius: '50%', background: driver.status === 'on-trip' ? '#3b82f6' : driver.status === 'online' ? '#22c55e' : '#555', border: '3px solid #1c1c1c' }} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px', flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: '#fff' }}>{driver.name}</h1>
              <StatusBadge status={driver.status} size="md" showDot />
            </div>
            <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
              {[1, 2, 3, 4, 5].map(s => (
                <Star key={s} size={14} style={{ color: '#f59e0b', fill: s <= Math.round(driver.rating) ? '#f59e0b' : 'none' }} />
              ))}
              <span style={{ fontSize: '13px', color: '#888', marginLeft: '4px' }}>{driver.rating} / 5.0</span>
            </div>
            <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
              {[
                { label: 'Total Trips', value: driver.totalTrips },
                { label: 'This Month', value: `£${driver.earningsThisMonth.toLocaleString()}` },
                { label: 'Joined', value: format(new Date(driver.joinedDate), 'MMM yyyy') },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div style={{ fontSize: '11px', color: '#555' }}>{label}</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{value}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button style={{ background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', color: '#C9A84C', fontSize: '13px', fontWeight: 500 }}>Edit Profile</button>
            <button style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', color: '#ef4444', fontSize: '13px', fontWeight: 500 }}>Suspend</button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0' }}>
        {TABS.map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)} style={{ background: 'none', border: 'none', padding: '8px 16px 12px', cursor: 'pointer', fontSize: '13px', fontWeight: activeTab === tab ? 600 : 500, color: activeTab === tab ? '#C9A84C' : '#666', borderBottom: `2px solid ${activeTab === tab ? '#C9A84C' : 'transparent'}`, marginBottom: '-1px', transition: 'all 0.15s' }}>
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'Overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
          {/* Contact */}
          <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '20px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '16px' }}>Contact Information</div>
            {[
              { icon: <Phone size={13} />, label: 'Mobile', value: driver.phone },
              { icon: <Mail size={13} />, label: 'Email', value: driver.email },
              { icon: <MapPin size={13} />, label: 'Address', value: driver.address },
              { icon: <Shield size={13} />, label: 'Emergency', value: driver.emergencyContact },
            ].map(({ icon, label, value }) => (
              <div key={label} style={{ display: 'flex', gap: '12px', padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <div style={{ color: '#555', flexShrink: 0, marginTop: 1 }}>{icon}</div>
                <div>
                  <div style={{ fontSize: '11px', color: '#555', marginBottom: '2px' }}>{label}</div>
                  <div style={{ fontSize: '13px', color: '#ccc' }}>{value}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Vehicle + Licence */}
          <div>
            <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '20px', marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '16px' }}>Vehicle Assigned</div>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                <div style={{ width: 44, height: 44, borderRadius: '10px', background: 'rgba(201,168,76,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Car size={20} style={{ color: '#C9A84C' }} />
                </div>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>{driver.vehicleClass ?? 'No Vehicle'}</div>
                  <div style={{ fontSize: '12px', color: '#888' }}>{driver.vehicleReg ?? '—'}</div>
                </div>
              </div>
            </div>
            <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '20px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '16px' }}>Licence Details</div>
              {[
                { icon: <Calendar size={13} />, label: 'Licence Number', value: driver.licenseNumber },
                { icon: <Calendar size={13} />, label: 'Licence Expiry', value: format(new Date(driver.licenseExpiry), 'd MMM yyyy') },
                { icon: <Calendar size={13} />, label: 'Joined', value: format(new Date(driver.joinedDate), 'd MMMM yyyy') },
              ].map(({ icon, label, value }) => (
                <div key={label} style={{ display: 'flex', gap: '12px', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <div style={{ color: '#555', flexShrink: 0, marginTop: 1 }}>{icon}</div>
                  <div>
                    <div style={{ fontSize: '11px', color: '#555', marginBottom: '2px' }}>{label}</div>
                    <div style={{ fontSize: '13px', color: '#ccc' }}>{value}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'Trips' && (
        <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: '14px', fontWeight: 600, color: '#fff' }}>
            {driverTrips.length} trips assigned
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Booking ID', 'Client', 'Route', 'Date', 'Status', 'Fare'].map(h => <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{h}</th>)}</tr></thead>
            <tbody>
              {driverTrips.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: '#555' }}>No trips found</td></tr>
              ) : driverTrips.map(b => (
                <tr key={b.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }} onClick={() => navigate(`/bookings/${b.id}`)} onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ padding: '11px 16px', fontSize: '12px', color: '#C9A84C', fontWeight: 600 }}>{b.id}</td>
                  <td style={{ padding: '11px 16px', fontSize: '13px', color: '#ccc' }}>{b.clientName}</td>
                  <td style={{ padding: '11px 16px', fontSize: '12px', color: '#888', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.pickup.split(',')[0]} → {b.dropoff.split(',')[0]}</td>
                  <td style={{ padding: '11px 16px', fontSize: '12px', color: '#888', whiteSpace: 'nowrap' }}>{format(new Date(b.dateTime), 'd MMM yyyy')}</td>
                  <td style={{ padding: '11px 16px' }}><StatusBadge status={b.status} /></td>
                  <td style={{ padding: '11px 16px', fontSize: '13px', color: '#fff', fontWeight: 600 }}>£{b.price}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'Documents' && (
        <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '20px' }}>
            <AlertTriangle size={15} style={{ color: (!driver.dbsVerified || !driver.insuranceVerified) ? '#f59e0b' : '#22c55e' }} />
            <span style={{ fontSize: '13px', color: '#888' }}>
              {(!driver.dbsVerified || !driver.insuranceVerified) ? 'Action required on one or more documents' : 'All documents verified'}
            </span>
          </div>
          <DocRow label="Driving Licence" verified={true} expires={format(new Date(driver.licenseExpiry), 'd MMM yyyy')} />
          <DocRow label="DBS Check" verified={driver.dbsVerified} />
          <DocRow label="Public Liability Insurance" verified={driver.insuranceVerified} />
          <DocRow label="Vehicle Insurance Certificate" verified={driver.insuranceVerified} />
          <DocRow label="PHV Licence" verified={true} />
          <DocRow label="Medical Certificate" verified={driver.dbsVerified} />
        </div>
      )}

      {activeTab === 'Earnings' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginBottom: '24px' }}>
            {[
              { label: 'This Month', value: `£${driver.earningsThisMonth.toLocaleString()}` },
              { label: 'Total Trips', value: driver.totalTrips },
              { label: 'Avg per Trip', value: `£${Math.round(driver.earningsThisMonth / (driver.earnings.at(-1)?.trips ?? 1))}` },
            ].map(({ label, value }) => (
              <div key={label} style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '20px' }}>
                <div style={{ fontSize: '12px', color: '#555', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
                <div style={{ fontSize: '24px', fontWeight: 700, color: '#fff' }}>{value}</div>
              </div>
            ))}
          </div>
          <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '20px' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff', marginBottom: '16px' }}>Monthly Earnings</div>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={driver.earnings}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="month" tick={{ fill: '#555', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#555', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `£${v / 1000}k`} />
                <Tooltip
                  contentStyle={{ background: '#222', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                  labelStyle={{ color: '#888', fontSize: 12 }}
                  itemStyle={{ color: '#C9A84C', fontSize: 13 }}
                  formatter={(v) => [`£${Number(v).toLocaleString()}`, 'Earnings']}
                />
                <Bar dataKey="amount" fill="#C9A84C" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Layout>
  );
}

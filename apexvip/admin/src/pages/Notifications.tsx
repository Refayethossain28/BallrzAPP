import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, formatDistanceToNow } from 'date-fns';
import { Bell, Calendar, UserCheck, CreditCard, Settings2, CheckCheck, Trash2 } from 'lucide-react';
import Layout from '../components/Layout';
import Header from '../components/Header';
import { mockNotifications } from '../data/mockData';
import type { Notification } from '../types';

type FilterType = 'all' | 'unread' | 'booking' | 'driver' | 'payment' | 'system';

const TYPE_CONFIG: Record<string, { icon: React.ReactNode; color: string; bg: string }> = {
  booking: { icon: <Calendar size={15} />, color: '#3b82f6', bg: 'rgba(59,130,246,0.1)' },
  driver:  { icon: <UserCheck size={15} />, color: '#C9A84C', bg: 'rgba(201,168,76,0.1)' },
  payment: { icon: <CreditCard size={15} />, color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  system:  { icon: <Settings2 size={15} />, color: '#888', bg: 'rgba(136,136,136,0.1)' },
};

export default function Notifications() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>(mockNotifications);
  const [filter, setFilter] = useState<FilterType>('all');

  const filtered = notifications.filter(n => {
    if (filter === 'unread') return !n.read;
    if (filter !== 'all') return n.type === filter;
    return true;
  });

  const unreadCount = notifications.filter(n => !n.read).length;

  const markAllRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  const markRead = (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  };

  const deleteNotif = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const handleClick = (n: Notification) => {
    markRead(n.id);
    if (n.bookingId) navigate(`/bookings/${n.bookingId}`);
    else if (n.driverId) navigate(`/drivers/${n.driverId}`);
  };

  const FILTERS: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'booking', label: 'Bookings' },
    { key: 'driver', label: 'Drivers' },
    { key: 'payment', label: 'Payments' },
    { key: 'system', label: 'System' },
  ];

  return (
    <Layout>
      <Header title="Notifications" subtitle="Stay updated on your operations" />

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        {[
          { label: 'Total', value: notifications.length, color: '#888' },
          { label: 'Unread', value: unreadCount, color: unreadCount > 0 ? '#ef4444' : '#888' },
          { label: 'Bookings', value: notifications.filter(n => n.type === 'booking').length, color: '#3b82f6' },
          { label: 'Drivers', value: notifications.filter(n => n.type === 'driver').length, color: '#C9A84C' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '14px 18px', flex: '0 1 auto' }}>
            <div style={{ fontSize: '11px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' }}>{label}</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', overflow: 'hidden' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {FILTERS.map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)} style={{ background: filter === f.key ? 'rgba(201,168,76,0.1)' : 'transparent', border: `1px solid ${filter === f.key ? 'rgba(201,168,76,0.25)' : 'rgba(255,255,255,0.06)'}`, borderRadius: '6px', padding: '5px 12px', cursor: 'pointer', fontSize: '12px', fontWeight: filter === f.key ? 600 : 400, color: filter === f.key ? '#C9A84C' : '#666' }}>
                {f.label}
                {f.key === 'unread' && unreadCount > 0 && (
                  <span style={{ marginLeft: '5px', background: '#ef4444', color: '#fff', fontSize: '9px', borderRadius: '8px', padding: '1px 5px' }}>{unreadCount}</span>
                )}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={markAllRead} style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.15)', borderRadius: '6px', padding: '5px 12px', cursor: 'pointer', fontSize: '12px', color: '#22c55e' }}>
              <CheckCheck size={12} /> Mark all read
            </button>
            <button onClick={clearAll} style={{ display: 'flex', alignItems: 'center', gap: '5px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: '6px', padding: '5px 12px', cursor: 'pointer', fontSize: '12px', color: '#ef4444' }}>
              <Trash2 size={12} /> Clear all
            </button>
          </div>
        </div>

        {/* Notifications list */}
        {filtered.length === 0 ? (
          <div style={{ padding: '60px', textAlign: 'center' }}>
            <Bell size={32} style={{ color: '#333', margin: '0 auto 12px', display: 'block' }} />
            <div style={{ fontSize: '15px', fontWeight: 500, color: '#555' }}>No notifications</div>
            <div style={{ fontSize: '13px', color: '#444', marginTop: '4px' }}>You're all caught up.</div>
          </div>
        ) : (
          <div>
            {filtered.map(n => {
              const cfg = TYPE_CONFIG[n.type];
              return (
                <div
                  key={n.id}
                  onClick={() => handleClick(n)}
                  style={{
                    display: 'flex',
                    gap: '14px',
                    padding: '16px 20px',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    cursor: 'pointer',
                    background: !n.read ? 'rgba(255,255,255,0.02)' : 'transparent',
                    position: 'relative',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background = !n.read ? 'rgba(255,255,255,0.02)' : 'transparent')}
                >
                  {/* Unread dot */}
                  {!n.read && (
                    <div style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', width: 6, height: 6, borderRadius: '50%', background: '#ef4444' }} />
                  )}

                  {/* Icon */}
                  <div style={{ width: 38, height: 38, borderRadius: '10px', background: cfg.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: cfg.color, flexShrink: 0 }}>
                    {cfg.icon}
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
                      <div style={{ fontSize: '13px', fontWeight: n.read ? 500 : 700, color: n.read ? '#ccc' : '#fff' }}>{n.title}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        <div style={{ fontSize: '11px', color: '#555', whiteSpace: 'nowrap' }}>
                          {formatDistanceToNow(new Date(n.timestamp), { addSuffix: true })}
                        </div>
                        <button
                          onClick={e => deleteNotif(n.id, e)}
                          style={{ background: 'none', border: 'none', color: '#444', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center', opacity: 0.6 }}
                          onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                          onMouseLeave={e => (e.currentTarget.style.color = '#444')}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: '12px', color: '#666', marginTop: '3px', lineHeight: 1.5 }}>{n.message}</div>
                    <div style={{ fontSize: '10px', color: '#444', marginTop: '4px' }}>
                      {format(new Date(n.timestamp), "d MMM yyyy 'at' HH:mm")}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}

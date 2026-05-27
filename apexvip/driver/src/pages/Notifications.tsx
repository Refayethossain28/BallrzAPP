import { useState } from 'react';
import { ChevronLeft, Bell, Briefcase, RefreshCw, DollarSign, Settings, Star } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow, parseISO } from 'date-fns';
import Layout from '../components/Layout';
import { mockNotifications } from '../data/mockData';
import type { Notification } from '../types';

const typeIcon = (type: Notification['type']) => {
  switch (type) {
    case 'job_assigned': return <Briefcase size={16} color="#C9A84C" />;
    case 'booking_update': return <RefreshCw size={16} color="#3b82f6" />;
    case 'payout': return <DollarSign size={16} color="#22c55e" />;
    case 'rating': return <Star size={16} color="#8b5cf6" />;
    case 'system': return <Settings size={16} color="#888888" />;
  }
};

const typeBg = (type: Notification['type']) => {
  switch (type) {
    case 'job_assigned': return 'rgba(201,168,76,0.1)';
    case 'booking_update': return 'rgba(59,130,246,0.1)';
    case 'payout': return 'rgba(34,197,94,0.1)';
    case 'rating': return 'rgba(139,92,246,0.1)';
    case 'system': return 'rgba(136,136,136,0.08)';
  }
};

export default function Notifications() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState(mockNotifications);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const markRead = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  };

  return (
    <Layout hideNav>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 16px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/home')}
            style={{
              background: '#1a1a1a',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 10,
              width: 38,
              height: 38,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <ChevronLeft size={18} color="#ffffff" />
          </button>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff' }}>Notifications</div>
            {unreadCount > 0 && (
              <div style={{ fontSize: 11, color: '#C9A84C', fontWeight: 600, marginTop: 1 }}>
                {unreadCount} unread
              </div>
            )}
          </div>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              color: '#C9A84C',
              fontWeight: 600,
            }}
          >
            Mark all read
          </button>
        )}
      </div>

      <div style={{ padding: '14px 16px' }}>
        {notifications.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <Bell size={40} color="#333333" style={{ margin: '0 auto 12px' }} />
            <div style={{ fontSize: 15, fontWeight: 600, color: '#444444' }}>No notifications</div>
          </div>
        ) : (
          notifications.map((notif) => (
            <div
              key={notif.id}
              onClick={() => markRead(notif.id)}
              style={{
                background: notif.read ? '#111111' : '#161616',
                borderRadius: 14,
                border: `1px solid ${notif.read ? 'rgba(255,255,255,0.06)' : 'rgba(201,168,76,0.15)'}`,
                padding: '14px 16px',
                marginBottom: 8,
                cursor: 'pointer',
                display: 'flex',
                gap: 12,
                position: 'relative',
                transition: 'background 0.2s',
              }}
            >
              {/* Unread dot */}
              {!notif.read && (
                <div
                  style={{
                    position: 'absolute',
                    top: 14,
                    right: 14,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#C9A84C',
                  }}
                />
              )}

              {/* Icon */}
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: typeBg(notif.type),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  marginTop: 1,
                }}
              >
                {typeIcon(notif.type)}
              </div>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0, paddingRight: 16 }}>
                <div style={{ fontSize: 13, fontWeight: notif.read ? 500 : 700, color: notif.read ? '#cccccc' : '#ffffff', marginBottom: 3 }}>
                  {notif.title}
                </div>
                <div style={{ fontSize: 12, color: '#666666', lineHeight: 1.4 }}>
                  {notif.message}
                </div>
                <div style={{ fontSize: 10, color: '#444444', marginTop: 6 }}>
                  {formatDistanceToNow(parseISO(notif.timestamp), { addSuffix: true })}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </Layout>
  );
}

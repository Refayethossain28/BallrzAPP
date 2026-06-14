import { useState } from 'react';
import { Bell, Car, Tag, Info, CheckCircle } from 'lucide-react';
import { MOCK_NOTIFICATIONS } from '../data/mockData';
import type { Notification } from '../types';
import { formatDistanceToNow, parseISO } from 'date-fns';
import Layout from '../components/Layout';

const TYPE_ICONS: Record<Notification['type'], React.ElementType> = {
  booking: CheckCircle,
  driver: Car,
  promo: Tag,
  system: Info,
};

const TYPE_COLORS: Record<Notification['type'], string> = {
  booking: '#22c55e',
  driver: '#C9A84C',
  promo: '#a855f7',
  system: '#3b82f6',
};

export default function Notifications() {
  const [notifications, setNotifications] = useState(MOCK_NOTIFICATIONS);

  const markAllRead = () => {
    setNotifications(n => n.map(item => ({ ...item, read: true })));
  };

  const markRead = (id: string) => {
    setNotifications(n => n.map(item => item.id === id ? { ...item, read: true } : item));
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <Layout>
      {/* Header */}
      <div style={{
        padding: '52px 20px 18px',
        background: '#111111',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#ffffff' }}>Notifications</div>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#C9A84C', fontSize: 13, fontWeight: 500,
                padding: 0,
              }}
            >
              Mark all read
            </button>
          )}
        </div>
        {unreadCount > 0 && (
          <div style={{ fontSize: 12, color: '#888888', marginTop: 4 }}>
            {unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}
          </div>
        )}
      </div>

      <div style={{ padding: '12px 0' }}>
        {notifications.length === 0 ? (
          <div style={{
            textAlign: 'center',
            padding: '60px 24px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
          }}>
            <Bell size={40} color="#333333" />
            <div style={{ fontSize: 15, color: '#555555' }}>No notifications yet</div>
          </div>
        ) : (
          notifications.map(notif => {
            const Icon = TYPE_ICONS[notif.type];
            const iconColor = TYPE_COLORS[notif.type];
            const timeAgo = (() => {
              try {
                return formatDistanceToNow(parseISO(notif.timestamp), { addSuffix: true });
              } catch {
                return '';
              }
            })();

            return (
              <button
                key={notif.id}
                onClick={() => markRead(notif.id)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 14,
                  padding: '14px 20px',
                  background: notif.read ? 'transparent' : 'rgba(201,168,76,0.03)',
                  border: 'none',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background 0.15s',
                  position: 'relative',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                onMouseLeave={e => (e.currentTarget.style.background = notif.read ? 'transparent' : 'rgba(201,168,76,0.03)')}
              >
                {/* Unread dot */}
                {!notif.read && (
                  <div style={{
                    position: 'absolute',
                    left: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: '#C9A84C',
                  }} />
                )}

                {/* Icon */}
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  background: `${iconColor}14`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <Icon size={18} color={iconColor} strokeWidth={1.8} />
                </div>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 4,
                  }}>
                    <div style={{
                      fontSize: 13, fontWeight: notif.read ? 500 : 700,
                      color: notif.read ? '#cccccc' : '#ffffff',
                      lineHeight: 1.3,
                    }}>
                      {notif.title}
                    </div>
                    <div style={{
                      fontSize: 10, color: '#555555',
                      whiteSpace: 'nowrap', flexShrink: 0,
                      marginTop: 2,
                    }}>
                      {timeAgo}
                    </div>
                  </div>
                  <div style={{
                    fontSize: 12, color: '#666666',
                    lineHeight: 1.6,
                  }}>
                    {notif.body}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </Layout>
  );
}

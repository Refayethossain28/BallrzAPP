import { NavLink } from 'react-router-dom';
import { Home, MapPin, Bell, User } from 'lucide-react';
import { MOCK_NOTIFICATIONS } from '../data/mockData';

const NAV_ITEMS = [
  { to: '/home', icon: Home, label: 'Home' },
  { to: '/trips', icon: MapPin, label: 'Trips' },
  { to: '/notifications', icon: Bell, label: 'Alerts', badge: true },
  { to: '/profile', icon: User, label: 'Profile' },
];

export default function BottomNav() {
  const unreadCount = MOCK_NOTIFICATIONS.filter(n => !n.read).length;

  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'rgba(17,17,17,0.97)',
        borderTop: '1px solid rgba(255,255,255,0.07)',
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'center',
        height: 64,
        paddingBottom: 'env(safe-area-inset-bottom)',
        backdropFilter: 'blur(20px)',
        zIndex: 50,
        maxWidth: 480,
        margin: '0 auto',
      }}
    >
      {NAV_ITEMS.map(({ to, icon: Icon, label, badge }) => (
        <NavLink
          key={to}
          to={to}
          style={({ isActive }) => ({
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 3,
            padding: '6px 16px',
            color: isActive ? '#C9A84C' : '#555555',
            textDecoration: 'none',
            transition: 'color 0.2s',
            position: 'relative',
          })}
        >
          {({ isActive }) => (
            <>
              <div style={{ position: 'relative' }}>
                <Icon size={22} strokeWidth={isActive ? 2.2 : 1.6} />
                {badge && unreadCount > 0 && (
                  <span
                    style={{
                      position: 'absolute',
                      top: -4,
                      right: -6,
                      background: '#C9A84C',
                      color: '#0a0a0a',
                      borderRadius: '50%',
                      width: 16,
                      height: 16,
                      fontSize: 9,
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {unreadCount}
                  </span>
                )}
              </div>
              <span style={{ fontSize: 10, fontWeight: isActive ? 600 : 400, letterSpacing: '0.03em' }}>
                {label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

import { NavLink } from 'react-router-dom';
import { Home, Briefcase, DollarSign, Clock, User } from 'lucide-react';

const navItems = [
  { to: '/home', icon: Home, label: 'Home' },
  { to: '/jobs', icon: Briefcase, label: 'Jobs' },
  { to: '/earnings', icon: DollarSign, label: 'Earnings' },
  { to: '/history', icon: Clock, label: 'History' },
  { to: '/profile', icon: User, label: 'Profile' },
];

export default function BottomNav() {
  return (
    <nav
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: '#111111',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        zIndex: 50,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {navItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          style={({ isActive }) => ({
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '10px 4px 8px',
            gap: 4,
            textDecoration: 'none',
            color: isActive ? '#C9A84C' : '#666666',
            transition: 'color 0.2s',
          })}
        >
          <Icon size={22} />
          <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.03em' }}>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

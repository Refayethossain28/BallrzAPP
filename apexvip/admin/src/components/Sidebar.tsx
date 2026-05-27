import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Calendar, Users, UserCheck, Car,
  DollarSign, BarChart2, Bell, Settings, LogOut,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Avatar from './Avatar';
import { mockNotifications } from '../data/mockData';

const NAV = [
  { to: '/',              icon: LayoutDashboard, label: 'Dashboard'     },
  { to: '/bookings',      icon: Calendar,        label: 'Bookings'      },
  { to: '/drivers',       icon: UserCheck,       label: 'Drivers'       },
  { to: '/clients',       icon: Users,           label: 'Clients'       },
  { to: '/fleet',         icon: Car,             label: 'Fleet'         },
  { to: '/pricing',       icon: DollarSign,      label: 'Pricing'       },
  { to: '/analytics',     icon: BarChart2,       label: 'Analytics'     },
  { to: '/notifications', icon: Bell,            label: 'Notifications' },
  { to: '/settings',      icon: Settings,        label: 'Settings'      },
];

const unread = mockNotifications.filter((n) => !n.read).length;

export default function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <aside style={{
      width: 240,
      minWidth: 240,
      height: '100vh',
      background: '#161616',
      borderRight: '1px solid rgba(255,255,255,0.06)',
      display: 'flex',
      flexDirection: 'column',
      position: 'fixed',
      left: 0,
      top: 0,
      bottom: 0,
      zIndex: 100,
    }}>
      {/* Logo */}
      <div style={{
        padding: '24px 20px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: 36, height: 36, borderRadius: '8px',
            background: 'rgba(201,168,76,0.15)',
            border: '1px solid rgba(201,168,76,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="#C9A84C"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: '#fff', letterSpacing: '-0.01em' }}>ApexVIP</div>
            <div style={{ fontSize: '10px', color: '#C9A84C', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Admin</div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: '12px 12px', scrollbarWidth: 'none' }}>
        {NAV.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '9px 12px',
              borderRadius: '8px',
              marginBottom: '2px',
              textDecoration: 'none',
              fontSize: '13.5px',
              fontWeight: isActive ? 600 : 500,
              color: isActive ? '#C9A84C' : '#aaa',
              background: isActive ? 'rgba(201,168,76,0.1)' : 'transparent',
              transition: 'all 0.15s',
              position: 'relative',
            })}
          >
            <Icon size={16} strokeWidth={isActive => isActive ? 2.5 : 2} />
            <span style={{ flex: 1 }}>{label}</span>
            {label === 'Notifications' && unread > 0 && (
              <span style={{
                background: '#ef4444',
                color: '#fff',
                fontSize: '10px',
                fontWeight: 700,
                borderRadius: '10px',
                padding: '1px 6px',
                minWidth: '18px',
                textAlign: 'center',
              }}>
                {unread}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* User section */}
      <div style={{
        padding: '16px 16px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
          <Avatar name={user?.name ?? 'Admin'} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
            <div style={{ fontSize: '11px', color: '#C9A84C', fontWeight: 500, textTransform: 'capitalize' }}>{user?.role}</div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          style={{
            width: '100%',
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '8px 12px',
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.15)',
            borderRadius: '8px',
            color: '#ef4444',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.15)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.08)')}
        >
          <LogOut size={14} />
          Sign Out
        </button>
      </div>
    </aside>
  );
}

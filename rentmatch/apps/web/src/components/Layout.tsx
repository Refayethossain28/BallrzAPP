import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

export default function Layout() {
  const { profile, switchRole } = useAuth();
  const navigate = useNavigate();
  const role = profile?.activeRole ?? 'renter';

  async function toggle(next: 'renter' | 'landlord') {
    if (next === role) return;
    await switchRole(next);
    navigate(next === 'renter' ? '/' : '/landlord');
  }

  const tabs =
    role === 'renter'
      ? [
          { to: '/', ic: '🔎', label: 'Search', end: true },
          { to: '/chats', ic: '💬', label: 'Chats', end: false },
          { to: '/account', ic: '👤', label: 'Account', end: false },
        ]
      : [
          { to: '/landlord', ic: '🏠', label: 'Listings', end: true },
          { to: '/chats', ic: '💬', label: 'Enquiries', end: false },
          { to: '/account', ic: '👤', label: 'Account', end: false },
        ];

  return (
    <div className="app">
      <header className="bar">
        <div className="logo"><span className="mk">⌂</span> Rent<b>Match</b></div>
        <div className="spacer" />
        <div className="roleswitch">
          <button className={role === 'renter' ? 'on' : ''} onClick={() => toggle('renter')}>Renter</button>
          <button className={role === 'landlord' ? 'on' : ''} onClick={() => toggle('landlord')}>Landlord</button>
        </div>
      </header>

      <main><Outlet /></main>

      <nav className="tabbar">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'on' : '')}>
            <span className="ic">{t.ic}</span>
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

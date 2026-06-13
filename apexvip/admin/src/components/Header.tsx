import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { format } from 'date-fns';
import { mockNotifications } from '../data/mockData';

interface Props {
  title?: string;
  subtitle?: string;
}

const unread = mockNotifications.filter((n) => !n.read).length;

export default function Header({ title, subtitle }: Props) {
  const navigate = useNavigate();
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: '28px',
    }}>
      <div>
        <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: '#fff', lineHeight: 1.2 }}>
          {title ?? `${greeting}, Admin`}
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#666' }}>
          {subtitle ?? format(now, "EEEE, d MMMM yyyy")}
        </p>
      </div>
      <button
        onClick={() => navigate('/notifications')}
        style={{
          position: 'relative',
          background: '#1c1c1c',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '10px',
          padding: '10px',
          cursor: 'pointer',
          color: '#888',
          display: 'flex',
          alignItems: 'center',
          transition: 'border-color 0.15s',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgba(201,168,76,0.4)')}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)')}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span style={{
            position: 'absolute',
            top: -4, right: -4,
            background: '#ef4444',
            color: '#fff',
            fontSize: '9px',
            fontWeight: 700,
            borderRadius: '10px',
            padding: '1px 4px',
            minWidth: '16px',
            textAlign: 'center',
          }}>
            {unread}
          </span>
        )}
      </button>
    </div>
  );
}

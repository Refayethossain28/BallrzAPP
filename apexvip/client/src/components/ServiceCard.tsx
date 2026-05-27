import React from 'react';
import { LucideIcon } from 'lucide-react';

interface ServiceCardProps {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  from: string;
  onClick: () => void;
}

export default function ServiceCard({ icon: Icon, title, subtitle, from, onClick }: ServiceCardProps) {
  return (
    <button
      onClick={onClick}
      style={{
        background: '#111111',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        padding: '20px 16px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 12,
        cursor: 'pointer',
        transition: 'all 0.2s',
        flex: 1,
        minWidth: 0,
        textAlign: 'left',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(201,168,76,0.4)';
        (e.currentTarget as HTMLButtonElement).style.background = '#161616';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.08)';
        (e.currentTarget as HTMLButtonElement).style.background = '#111111';
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: 'rgba(201,168,76,0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Icon size={22} color="#C9A84C" strokeWidth={1.8} />
      </div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#ffffff', marginBottom: 3 }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: '#888888', marginBottom: 6 }}>{subtitle}</div>
        <div style={{ fontSize: 12, color: '#C9A84C', fontWeight: 500 }}>From {from}</div>
      </div>
    </button>
  );
}

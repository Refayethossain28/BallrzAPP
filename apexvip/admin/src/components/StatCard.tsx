import type { ReactNode } from 'react';

interface Props {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: ReactNode;
  iconBg?: string;
  trend?: { value: number; label: string };
}

export default function StatCard({ title, value, subtitle, icon, iconBg = '#C9A84C', trend }: Props) {
  return (
    <div style={{
      background: '#1c1c1c',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '12px',
      padding: '20px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      flex: 1,
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: '12px', color: '#888', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>{title}</div>
          <div style={{ fontSize: '28px', fontWeight: 700, color: '#fff', lineHeight: 1.1 }}>{value}</div>
          {subtitle && <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>{subtitle}</div>}
        </div>
        <div style={{
          width: 44,
          height: 44,
          borderRadius: '10px',
          background: iconBg + '22',
          border: `1px solid ${iconBg}33`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: iconBg,
          flexShrink: 0,
        }}>
          {icon}
        </div>
      </div>
      {trend && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{
            fontSize: '11px',
            fontWeight: 600,
            color: trend.value >= 0 ? '#22c55e' : '#ef4444',
            background: trend.value >= 0 ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            borderRadius: '4px',
            padding: '2px 6px',
          }}>
            {trend.value >= 0 ? '+' : ''}{trend.value}%
          </span>
          <span style={{ fontSize: '11px', color: '#666' }}>{trend.label}</span>
        </div>
      )}
    </div>
  );
}

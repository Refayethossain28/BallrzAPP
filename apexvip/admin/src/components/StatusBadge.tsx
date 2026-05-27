import type { BookingStatus, DriverStatus, VehicleStatus, ClientTier } from '../types';

type StatusType = BookingStatus | DriverStatus | VehicleStatus | ClientTier;

const CONFIG: Record<string, { label: string; bg: string; text: string; dot?: string }> = {
  // Booking statuses
  pending:   { label: 'Pending',   bg: 'rgba(245,158,11,0.15)',  text: '#f59e0b' },
  confirmed: { label: 'Confirmed', bg: 'rgba(59,130,246,0.15)',  text: '#3b82f6' },
  active:    { label: 'Active',    bg: 'rgba(34,197,94,0.15)',   text: '#22c55e' },
  completed: { label: 'Completed', bg: 'rgba(136,136,136,0.15)', text: '#888888' },
  cancelled: { label: 'Cancelled', bg: 'rgba(239,68,68,0.15)',   text: '#ef4444' },
  // Driver statuses
  online:    { label: 'Online',    bg: 'rgba(34,197,94,0.15)',   text: '#22c55e',  dot: '#22c55e' },
  offline:   { label: 'Offline',   bg: 'rgba(136,136,136,0.15)', text: '#888888',  dot: '#888888' },
  'on-trip': { label: 'On Trip',   bg: 'rgba(59,130,246,0.15)',  text: '#3b82f6',  dot: '#3b82f6' },
  // Vehicle statuses
  available:    { label: 'Available',    bg: 'rgba(34,197,94,0.15)',   text: '#22c55e' },
  'on-trip':    { label: 'On Trip',       bg: 'rgba(59,130,246,0.15)',  text: '#3b82f6' },
  maintenance:  { label: 'Maintenance',  bg: 'rgba(239,68,68,0.15)',   text: '#ef4444' },
  // Client tiers
  Standard: { label: 'Standard', bg: 'rgba(136,136,136,0.15)', text: '#888888' },
  VIP:      { label: 'VIP',      bg: 'rgba(201,168,76,0.15)',  text: '#C9A84C' },
  VVIP:     { label: 'VVIP',     bg: 'rgba(201,168,76,0.2)',   text: '#C9A84C' },
};

interface Props {
  status: StatusType;
  showDot?: boolean;
  size?: 'sm' | 'md';
}

export default function StatusBadge({ status, showDot = false, size = 'sm' }: Props) {
  const cfg = CONFIG[status] ?? { label: status, bg: 'rgba(136,136,136,0.15)', text: '#888888' };
  const padding = size === 'md' ? '4px 10px' : '2px 8px';
  const fontSize = size === 'md' ? '13px' : '11px';

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      background: cfg.bg,
      color: cfg.text,
      borderRadius: '20px',
      padding,
      fontSize,
      fontWeight: 600,
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
    }}>
      {(showDot && cfg.dot) && (
        <span style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: cfg.dot,
          flexShrink: 0,
        }} />
      )}
      {cfg.label}
    </span>
  );
}

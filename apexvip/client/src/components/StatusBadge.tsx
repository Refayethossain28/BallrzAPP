import type { TripStatus } from '../types';

interface StatusBadgeProps {
  status: TripStatus;
}

const STATUS_CONFIG: Record<TripStatus, { label: string; bg: string; color: string; dot: string }> = {
  upcoming: {
    label: 'Upcoming',
    bg: 'rgba(201,168,76,0.12)',
    color: '#C9A84C',
    dot: '#C9A84C',
  },
  active: {
    label: 'Active',
    bg: 'rgba(34,197,94,0.12)',
    color: '#22c55e',
    dot: '#22c55e',
  },
  completed: {
    label: 'Completed',
    bg: 'rgba(136,136,136,0.12)',
    color: '#888888',
    dot: '#888888',
  },
  cancelled: {
    label: 'Cancelled',
    bg: 'rgba(239,68,68,0.12)',
    color: '#ef4444',
    dot: '#ef4444',
  },
};

export default function StatusBadge({ status }: StatusBadgeProps) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 20,
        background: cfg.bg,
        color: cfg.color,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: cfg.dot,
          flexShrink: 0,
        }}
      />
      {cfg.label}
    </span>
  );
}

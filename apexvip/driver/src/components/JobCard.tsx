import { useNavigate } from 'react-router-dom';
import { MapPin, Clock, Users, Navigation } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import type { Job } from '../types';

interface JobCardProps {
  job: Job;
  showAcceptButton?: boolean;
  onAccept?: (job: Job) => void;
}

const serviceColors: Record<string, string> = {
  'Airport Transfer': '#C9A84C',
  Hourly: '#8b5cf6',
  'Day Hire': '#3b82f6',
  'Point to Point': '#22c55e',
  'Hotel Transfer': '#ec4899',
};

export default function JobCard({ job, showAcceptButton, onAccept }: JobCardProps) {
  const navigate = useNavigate();
  const badgeColor = serviceColors[job.serviceType] ?? '#888888';

  const handleClick = () => {
    navigate(`/jobs/${job.id}`);
  };

  return (
    <div
      onClick={handleClick}
      style={{
        background: '#111111',
        borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.08)',
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'border-color 0.2s, background 0.2s',
        marginBottom: 10,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(201,168,76,0.3)';
        (e.currentTarget as HTMLDivElement).style.background = '#161616';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.08)';
        (e.currentTarget as HTMLDivElement).style.background = '#111111';
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              padding: '3px 10px',
              borderRadius: 10,
              background: `${badgeColor}18`,
              border: `1px solid ${badgeColor}33`,
              fontSize: 10,
              fontWeight: 700,
              color: badgeColor,
              letterSpacing: '0.06em',
            }}
          >
            {job.serviceType.toUpperCase()}
          </span>
        </div>
        <span style={{ fontSize: 18, fontWeight: 800, color: '#C9A84C' }}>£{job.price}</span>
      </div>

      {/* Date/time row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <Clock size={13} color="#888888" />
        <span style={{ fontSize: 12, color: '#aaaaaa', fontWeight: 500 }}>
          {format(parseISO(job.pickupDate), 'EEE d MMM')} at {job.pickupTime}
        </span>
      </div>

      {/* Route */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
          <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.12)', margin: '3px 0' }} />
          <MapPin size={10} color="#ef4444" style={{ flexShrink: 0 }} />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#dddddd', lineHeight: 1.3 }}>{job.pickupAddress}</span>
          <span style={{ fontSize: 12, color: '#dddddd', lineHeight: 1.3 }}>{job.dropoffAddress}</span>
        </div>
      </div>

      {/* Footer row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Users size={12} color="#888888" />
            <span style={{ fontSize: 11, color: '#888888' }}>{job.passengers} pax</span>
          </div>
          {job.distanceToPickup && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Navigation size={12} color="#888888" />
              <span style={{ fontSize: 11, color: '#888888' }}>{job.distanceToPickup} away</span>
            </div>
          )}
        </div>
        {showAcceptButton && onAccept && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAccept(job);
            }}
            style={{
              padding: '7px 16px',
              borderRadius: 10,
              border: 'none',
              background: 'linear-gradient(135deg, #22c55e, #16a34a)',
              color: '#ffffff',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
          >
            ACCEPT
          </button>
        )}
      </div>
    </div>
  );
}

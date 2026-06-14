import { useEffect, useState } from 'react';
import { MapPin, ArrowRight, Clock, Users, Plane, Star } from 'lucide-react';
import type { Job } from '../types';

interface JobRequestOverlayProps {
  job: Job;
  onAccept: (job: Job) => void;
  onDecline: () => void;
}

export default function JobRequestOverlay({ job, onAccept, onDecline }: JobRequestOverlayProps) {
  const [countdown, setCountdown] = useState(30);
  const [entering, setEntering] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setEntering(false), 50);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (countdown <= 0) {
      onDecline();
      return;
    }
    const timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [countdown, onDecline]);

  const progress = (countdown / 30) * 100;
  const circumference = 2 * Math.PI * 26;
  const strokeDash = (progress / 100) * circumference;

  const serviceBadgeColor =
    job.serviceType === 'Airport Transfer'
      ? '#C9A84C'
      : job.serviceType === 'Hourly'
      ? '#8b5cf6'
      : job.serviceType === 'Day Hire'
      ? '#3b82f6'
      : '#22c55e';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(0,0,0,0.92)',
        transition: 'opacity 0.3s ease',
        opacity: entering ? 0 : 1,
      }}
    >
      {/* Top urgent bar */}
      <div
        style={{
          background: '#C9A84C',
          padding: '10px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        <Star size={14} fill="#0a0a0a" color="#0a0a0a" />
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.15em', color: '#0a0a0a' }}>
          NEW JOB REQUEST
        </span>
        <Star size={14} fill="#0a0a0a" color="#0a0a0a" />
      </div>

      {/* Main card */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          padding: '20px 16px 24px',
          overflowY: 'auto',
          maxWidth: 480,
          margin: '0 auto',
          width: '100%',
        }}
      >
        {/* Timer + client */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          {/* Client avatar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: 'linear-gradient(135deg, #C9A84C, #a07a2e)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 18,
                fontWeight: 700,
                color: '#0a0a0a',
                flexShrink: 0,
              }}
            >
              {job.clientInitials}
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#ffffff' }}>{job.clientName}</div>
              <div
                style={{
                  display: 'inline-block',
                  padding: '3px 10px',
                  borderRadius: 12,
                  background: `${serviceBadgeColor}22`,
                  border: `1px solid ${serviceBadgeColor}44`,
                  fontSize: 11,
                  fontWeight: 600,
                  color: serviceBadgeColor,
                  marginTop: 4,
                }}
              >
                {job.serviceType}
              </div>
            </div>
          </div>

          {/* Countdown ring */}
          <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
            <svg width={64} height={64} style={{ transform: 'rotate(-90deg)' }}>
              <circle cx={32} cy={32} r={26} fill="none" stroke="#222222" strokeWidth={4} />
              <circle
                cx={32}
                cy={32}
                r={26}
                fill="none"
                stroke={countdown <= 10 ? '#ef4444' : '#C9A84C'}
                strokeWidth={4}
                strokeDasharray={`${strokeDash} ${circumference}`}
                strokeLinecap="round"
                style={{ transition: 'stroke-dasharray 1s linear, stroke 0.3s' }}
              />
            </svg>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
              }}
            >
              <span
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  color: countdown <= 10 ? '#ef4444' : '#ffffff',
                  lineHeight: 1,
                }}
              >
                {countdown}
              </span>
              <span style={{ fontSize: 9, color: '#666666', fontWeight: 500 }}>SEC</span>
            </div>
          </div>
        </div>

        {/* Route card */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.08)',
            padding: 16,
            marginBottom: 14,
          }}
        >
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
              <div style={{ width: 1, flex: 1, background: 'rgba(255,255,255,0.15)', margin: '4px 0' }} />
              <MapPin size={12} color="#ef4444" style={{ flexShrink: 0 }} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div style={{ fontSize: 10, color: '#888888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
                  PICKUP
                </div>
                <div style={{ fontSize: 13, color: '#ffffff', fontWeight: 500, lineHeight: 1.4 }}>{job.pickupAddress}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#888888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 2 }}>
                  DROPOFF
                </div>
                <div style={{ fontSize: 13, color: '#ffffff', fontWeight: 500, lineHeight: 1.4 }}>{job.dropoffAddress}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Details grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            marginBottom: 14,
          }}
        >
          <DetailChip icon={<Clock size={14} color="#C9A84C" />} label="Pickup in" value="45 min" />
          <DetailChip icon={<ArrowRight size={14} color="#C9A84C" />} label="Distance" value={job.estimatedDistance} />
          <DetailChip icon={<Users size={14} color="#C9A84C" />} label="Passengers" value={`${job.passengers} pax`} />
          {job.flightNumber && (
            <DetailChip icon={<Plane size={14} color="#C9A84C" />} label="Flight" value={job.flightNumber} />
          )}
        </div>

        {/* Vehicle */}
        <div
          style={{
            background: '#111111',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.08)',
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <span style={{ fontSize: 12, color: '#888888' }}>Vehicle</span>
          <span style={{ fontSize: 13, color: '#ffffff', fontWeight: 600 }}>{job.vehicle}</span>
        </div>

        {/* Special notes */}
        {job.specialNotes && (
          <div
            style={{
              background: 'rgba(201,168,76,0.08)',
              borderRadius: 12,
              border: '1px solid rgba(201,168,76,0.2)',
              padding: '10px 14px',
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 10, color: '#C9A84C', fontWeight: 700, letterSpacing: '0.08em', marginBottom: 4 }}>
              SPECIAL NOTES
            </div>
            <div style={{ fontSize: 12, color: '#cccccc', lineHeight: 1.5 }}>{job.specialNotes}</div>
          </div>
        )}

        {/* Price */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '12px 0',
            marginBottom: 6,
          }}
        >
          <span style={{ fontSize: 13, color: '#888888' }}>Job Rate</span>
          <span style={{ fontSize: 38, fontWeight: 800, color: '#C9A84C', lineHeight: 1 }}>
            £{job.price}
          </span>
        </div>
      </div>

      {/* Action buttons */}
      <div
        style={{
          padding: '12px 16px 32px',
          display: 'grid',
          gridTemplateColumns: '1fr 2fr',
          gap: 10,
          background: '#0d0d0d',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          maxWidth: 480,
          margin: '0 auto',
          width: '100%',
        }}
      >
        <button
          onClick={onDecline}
          style={{
            padding: '16px',
            borderRadius: 14,
            border: '1px solid rgba(239,68,68,0.3)',
            background: 'rgba(239,68,68,0.1)',
            color: '#ef4444',
            fontSize: 15,
            fontWeight: 700,
            cursor: 'pointer',
            letterSpacing: '0.05em',
          }}
        >
          DECLINE
        </button>
        <button
          onClick={() => onAccept(job)}
          style={{
            padding: '16px',
            borderRadius: 14,
            border: 'none',
            background: 'linear-gradient(135deg, #22c55e, #16a34a)',
            color: '#ffffff',
            fontSize: 15,
            fontWeight: 700,
            cursor: 'pointer',
            letterSpacing: '0.05em',
            boxShadow: '0 4px 20px rgba(34,197,94,0.3)',
          }}
        >
          ACCEPT JOB
        </button>
      </div>
    </div>
  );
}

function DetailChip({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        background: '#111111',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.08)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon}
        <span style={{ fontSize: 10, color: '#666666', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          {label}
        </span>
      </div>
      <span style={{ fontSize: 14, fontWeight: 700, color: '#ffffff' }}>{value}</span>
    </div>
  );
}

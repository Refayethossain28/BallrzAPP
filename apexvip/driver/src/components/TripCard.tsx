import { useNavigate } from 'react-router-dom';
import { MapPin, Clock, Star } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import type { TripRecord } from '../types';

interface TripCardProps {
  trip: TripRecord;
}

const serviceColors: Record<string, string> = {
  'Airport Transfer': '#C9A84C',
  Hourly: '#8b5cf6',
  'Day Hire': '#3b82f6',
  'Point to Point': '#22c55e',
  'Hotel Transfer': '#ec4899',
};

export default function TripCard({ trip }: TripCardProps) {
  const navigate = useNavigate();
  const badgeColor = serviceColors[trip.serviceType] ?? '#888888';

  return (
    <div
      onClick={() => navigate(`/history`)}
      style={{
        background: '#111111',
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,0.07)',
        padding: '14px 16px',
        cursor: 'pointer',
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 8,
              background: `${badgeColor}18`,
              border: `1px solid ${badgeColor}33`,
              fontSize: 10,
              fontWeight: 700,
              color: badgeColor,
              letterSpacing: '0.05em',
            }}
          >
            {trip.serviceType.toUpperCase()}
          </span>
          <div style={{ marginTop: 6, fontSize: 11, color: '#666666', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={11} color="#666666" />
            {format(parseISO(trip.date), 'EEE d MMM, HH:mm')}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: '#C9A84C' }}>£{trip.earnings + trip.tip}</div>
          <div style={{ fontSize: 10, color: '#555555', marginTop: 2 }}>+£{trip.tip} tip</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 3 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
          <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.1)', margin: '3px 0' }} />
          <MapPin size={9} color="#ef4444" style={{ flexShrink: 0 }} />
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#cccccc' }}>{trip.pickupAddress}</span>
          <span style={{ fontSize: 12, color: '#cccccc' }}>{trip.dropoffAddress}</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: '#666666' }}>{trip.duration}</span>
        {trip.rating && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {Array.from({ length: trip.rating }).map((_, i) => (
              <Star key={i} size={11} fill="#C9A84C" color="#C9A84C" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

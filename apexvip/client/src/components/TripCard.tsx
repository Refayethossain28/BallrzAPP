import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Plane, Clock, Calendar, ChevronRight } from 'lucide-react';
import { Trip } from '../types';
import StatusBadge from './StatusBadge';
import { format, parseISO } from 'date-fns';

interface TripCardProps {
  trip: Trip;
}

const SERVICE_ICONS = {
  airport: Plane,
  hourly: Clock,
  day: Calendar,
};

const SERVICE_LABELS = {
  airport: 'Airport Transfer',
  hourly: 'Hourly Charter',
  day: 'Day Charter',
};

const VEHICLE_LABELS = {
  's-class': 'Mercedes S-Class',
  'v-class': 'Mercedes V-Class',
};

export default function TripCard({ trip }: TripCardProps) {
  const navigate = useNavigate();
  const Icon = SERVICE_ICONS[trip.serviceType];

  const formattedDate = (() => {
    try {
      return format(parseISO(trip.date), 'EEE d MMM yyyy');
    } catch {
      return trip.date;
    }
  })();

  return (
    <button
      onClick={() => navigate(`/trips/${trip.id}`)}
      style={{
        width: '100%',
        background: '#111111',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        padding: '16px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all 0.2s',
        marginBottom: 10,
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(201,168,76,0.3)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.08)';
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          background: 'rgba(201,168,76,0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        <Icon size={20} color="#C9A84C" strokeWidth={1.8} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ffffff', marginBottom: 2 }}>
              {SERVICE_LABELS[trip.serviceType]}
            </div>
            <div style={{ fontSize: 11, color: '#888888' }}>
              {formattedDate} · {trip.time}
            </div>
          </div>
          <StatusBadge status={trip.status} />
        </div>

        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#C9A84C', flexShrink: 0, marginTop: 5,
            }} />
            <div style={{
              fontSize: 12, color: '#cccccc',
              overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}>
              {trip.pickup}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <div style={{
              width: 6, height: 6, borderRadius: 2,
              background: '#888888', flexShrink: 0, marginTop: 5,
            }} />
            <div style={{
              fontSize: 12, color: '#888888',
              overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}>
              {trip.dropoff}
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 10, paddingTop: 10,
          borderTop: '1px solid rgba(255,255,255,0.05)',
        }}>
          <div style={{ fontSize: 11, color: '#888888' }}>
            {VEHICLE_LABELS[trip.vehicleType]}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#C9A84C' }}>
              £{trip.price.toFixed(2)}
            </span>
            <ChevronRight size={14} color="#555555" />
          </div>
        </div>
      </div>
    </button>
  );
}

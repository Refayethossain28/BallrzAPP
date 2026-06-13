import { Check, Users, Briefcase, Wifi } from 'lucide-react';

interface Vehicle {
  id: 's-class' | 'v-class';
  name: string;
  category: string;
  passengers: number;
  luggage: number;
  features: string[];
  description: string;
  price: number;
}

interface VehicleCardProps {
  vehicle: Vehicle;
  selected: boolean;
  onSelect: () => void;
}

export default function VehicleCard({ vehicle, selected, onSelect }: VehicleCardProps) {
  return (
    <button
      onClick={onSelect}
      style={{
        width: '100%',
        background: selected ? 'rgba(201,168,76,0.05)' : '#111111',
        border: `1.5px solid ${selected ? '#C9A84C' : 'rgba(255,255,255,0.08)'}`,
        borderRadius: 20,
        padding: 0,
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all 0.2s',
        overflow: 'hidden',
        marginBottom: 14,
      }}
    >
      {/* Vehicle image placeholder */}
      <div
        style={{
          width: '100%',
          height: 160,
          background: 'linear-gradient(135deg, #1a1a1a 0%, #111111 50%, #0f0f0f 100%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        {/* Decorative lines */}
        <div style={{
          position: 'absolute', inset: 0, overflow: 'hidden', opacity: 0.12,
        }}>
          <div style={{
            position: 'absolute', bottom: -20, left: -20, right: -20, height: 1,
            background: 'linear-gradient(90deg, transparent, #C9A84C, transparent)',
          }} />
        </div>

        {/* Car silhouette */}
        <div style={{
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.15em',
          color: '#888888',
          textTransform: 'uppercase',
          marginBottom: 8,
          fontStyle: 'italic',
        }}>
          {vehicle.name}
        </div>
        <div style={{
          width: 200,
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(201,168,76,0.3), transparent)',
        }} />

        {selected && (
          <div style={{
            position: 'absolute',
            top: 14,
            right: 14,
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: '#C9A84C',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Check size={16} color="#0a0a0a" strokeWidth={2.5} />
          </div>
        )}
      </div>

      {/* Vehicle details */}
      <div style={{ padding: '18px 20px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#ffffff', marginBottom: 3 }}>
              {vehicle.name}
            </div>
            <div style={{ fontSize: 12, color: '#888888', letterSpacing: '0.04em' }}>
              {vehicle.category}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#888888', marginBottom: 2 }}>From</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#C9A84C' }}>
              £{vehicle.price}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Users size={14} color="#888888" />
            <span style={{ fontSize: 12, color: '#888888' }}>Up to {vehicle.passengers}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Briefcase size={14} color="#888888" />
            <span style={{ fontSize: 12, color: '#888888' }}>{vehicle.luggage} bags</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Wifi size={14} color="#888888" />
            <span style={{ fontSize: 12, color: '#888888' }}>WiFi</span>
          </div>
        </div>

        <p style={{ fontSize: 12, color: '#666666', lineHeight: 1.6, margin: 0, marginBottom: 12 }}>
          {vehicle.description}
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {vehicle.features.map(f => (
            <span
              key={f}
              style={{
                padding: '3px 10px',
                borderRadius: 20,
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.06)',
                fontSize: 11,
                color: '#888888',
              }}
            >
              {f}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

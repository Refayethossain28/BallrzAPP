import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useBooking } from '../context/BookingContext';
import { VEHICLES } from '../data/mockData';
import VehicleCard from '../components/VehicleCard';

function calcPrice(
  vehicleId: 's-class' | 'v-class',
  serviceType: string | null,
  duration: number
): number {
  const v = VEHICLES.find(x => x.id === vehicleId)!;
  if (serviceType === 'airport') return v.baseAirport;
  if (serviceType === 'hourly') return v.hourlyRate * duration;
  if (serviceType === 'day') return v.dayRate;
  return v.baseAirport;
}

export default function VehicleSelect() {
  const navigate = useNavigate();
  const { booking, setVehicleType } = useBooking();

  const handleSelect = (id: 's-class' | 'v-class') => {
    setVehicleType(id);
  };

  const handleContinue = () => {
    if (booking.vehicleType) navigate('/book/summary');
  };

  const backPath =
    booking.serviceType === 'airport' ? '/book/airport' :
    booking.serviceType === 'hourly' ? '/book/hourly' :
    '/book/day';

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', maxWidth: 480, margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        padding: '52px 20px 20px',
        background: '#111111',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}>
        <button
          onClick={() => navigate(backPath)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            color: '#888888', marginBottom: 14, padding: 0,
          }}
        >
          <ArrowLeft size={18} />
          <span style={{ fontSize: 13 }}>Back</span>
        </button>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#ffffff', marginBottom: 4 }}>
          Choose Your Vehicle
        </div>
        <div style={{ fontSize: 13, color: '#888888' }}>
          All vehicles are late-model with professional chauffeurs
        </div>
      </div>

      {/* Progress */}
      <div style={{
        padding: '16px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        {['Details', 'Vehicle', 'Summary'].map((s, i) => (
          <React.Fragment key={s}>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: i === 1 ? '#C9A84C' : i === 0 ? '#888888' : '#444444',
              letterSpacing: '0.04em',
            }}>
              {s}
            </div>
            {i < 2 && (
              <div style={{
                flex: 1,
                height: 1,
                background: i === 0 ? '#C9A84C' : 'rgba(255,255,255,0.08)',
              }} />
            )}
          </React.Fragment>
        ))}
      </div>

      <div style={{ padding: '8px 20px', paddingBottom: 100 }}>
        {VEHICLES.map(v => (
          <VehicleCard
            key={v.id}
            vehicle={{
              ...v,
              price: calcPrice(v.id, booking.serviceType, booking.duration),
            }}
            selected={booking.vehicleType === v.id}
            onSelect={() => handleSelect(v.id)}
          />
        ))}
      </div>

      {/* Footer */}
      <div style={{
        position: 'fixed',
        bottom: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        width: '100%',
        maxWidth: 480,
        padding: '16px 20px',
        background: 'rgba(10,10,10,0.97)',
        borderTop: '1px solid rgba(255,255,255,0.07)',
        backdropFilter: 'blur(20px)',
      }}>
        <button
          onClick={handleContinue}
          disabled={!booking.vehicleType}
          style={{
            width: '100%',
            padding: '16px',
            background: booking.vehicleType ? '#C9A84C' : 'rgba(201,168,76,0.3)',
            color: booking.vehicleType ? '#0a0a0a' : 'rgba(10,10,10,0.5)',
            border: 'none',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: booking.vehicleType ? 'pointer' : 'not-allowed',
          }}
        >
          Continue to Summary
        </button>
      </div>
    </div>
  );
}

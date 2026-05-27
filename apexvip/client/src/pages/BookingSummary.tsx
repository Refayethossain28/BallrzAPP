import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Car, CreditCard, Tag, Plane, ChevronDown } from 'lucide-react';
import { useBooking } from '../context/BookingContext';
import { VEHICLES, MOCK_PAYMENT_CARDS } from '../data/mockData';
import LoadingSpinner from '../components/LoadingSpinner';
import { format, parseISO } from 'date-fns';

const SERVICE_LABELS: Record<string, string> = {
  airport: 'Airport Transfer',
  hourly: 'Hourly Charter',
  day: 'Day Charter',
};

function calcPriceBreakdown(
  vehicleId: string | null,
  serviceType: string | null,
  duration: number,
  childSeats: boolean,
  luggage: number,
) {
  const v = VEHICLES.find(x => x.id === vehicleId);
  if (!v) return { baseFare: 0, extras: 0, vat: 0, total: 0 };

  let baseFare = 0;
  if (serviceType === 'airport') baseFare = v.baseAirport;
  else if (serviceType === 'hourly') baseFare = v.hourlyRate * duration;
  else if (serviceType === 'day') baseFare = v.dayRate;

  const extras = (childSeats ? 0 : 0) + (luggage > 3 ? (luggage - 3) * 5 : 0);
  const subtotal = baseFare + extras;
  const vat = Math.round(subtotal * 0.2 * 100) / 100;
  const total = Math.round((subtotal + vat) * 100) / 100;

  return { baseFare, extras, vat, total };
}

export default function BookingSummary() {
  const navigate = useNavigate();
  const { booking, setBookingField } = useBooking();
  const [confirming, setConfirming] = useState(false);
  const [promoInput, setPromoInput] = useState('');
  const [promoApplied, setPromoApplied] = useState(false);
  const [promoError, setPromoError] = useState('');
  const [showCardPicker, setShowCardPicker] = useState(false);

  const vehicle = VEHICLES.find(v => v.id === booking.vehicleType);
  const { baseFare, extras, vat, total } = calcPriceBreakdown(
    booking.vehicleType,
    booking.serviceType,
    booking.duration,
    booking.childSeats,
    booking.luggage,
  );

  const selectedCard = MOCK_PAYMENT_CARDS.find(c => c.id === booking.paymentCardId)
    || MOCK_PAYMENT_CARDS.find(c => c.isDefault)
    || MOCK_PAYMENT_CARDS[0];

  const formattedDate = (() => {
    try { return format(parseISO(booking.date), 'EEEE, d MMMM yyyy'); } catch { return booking.date; }
  })();

  const applyPromo = () => {
    if (promoInput.toUpperCase() === 'APEX20') {
      setPromoApplied(true);
      setPromoError('');
      setBookingField('promoCode', 'APEX20');
    } else {
      setPromoError('Invalid promo code');
      setPromoApplied(false);
    }
  };

  const handleConfirm = async () => {
    setConfirming(true);
    await new Promise(r => setTimeout(r, 1500));
    navigate('/book/confirmed');
  };

  const discount = promoApplied ? Math.round(total * 0.2 * 100) / 100 : 0;
  const finalTotal = promoApplied ? Math.round((total - discount) * 100) / 100 : total;

  const SectionHeader = ({ label }: { label: string }) => (
    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#555555', marginBottom: 12 }}>
      {label}
    </div>
  );

  const Row = ({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
      <span style={{ fontSize: 13, color: '#888888' }}>{label}</span>
      <span style={{ fontSize: 13, color: highlight ? '#C9A84C' : '#cccccc', fontWeight: highlight ? 600 : 400 }}>{value}</span>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', maxWidth: 480, margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        padding: '52px 20px 20px',
        background: '#111111',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}>
        <button
          onClick={() => navigate('/book/vehicle')}
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
          Booking Summary
        </div>
        <div style={{ fontSize: 13, color: '#888888' }}>
          Review your details before confirming
        </div>
      </div>

      <div style={{ padding: '20px', paddingBottom: 120, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Service details */}
        <div style={{
          background: '#111111',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '18px',
        }}>
          <SectionHeader label="Journey Details" />

          <div style={{ display: 'flex', gap: 10, marginBottom: 14, padding: '10px 12px', background: 'rgba(201,168,76,0.05)', borderRadius: 10 }}>
            <Car size={16} color="#C9A84C" style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#ffffff' }}>{vehicle?.name}</div>
              <div style={{ fontSize: 12, color: '#888888' }}>{vehicle?.category} · {SERVICE_LABELS[booking.serviceType || '']}</div>
            </div>
          </div>

          <Row label="Service" value={SERVICE_LABELS[booking.serviceType || ''] || '—'} />
          {booking.serviceType === 'hourly' && (
            <Row label="Duration" value={`${booking.duration} hours`} />
          )}
          <Row label="Date" value={formattedDate || '—'} />
          {booking.time && <Row label="Time" value={booking.time} />}
          <Row label="Passengers" value={`${booking.passengers}`} />
          {booking.childSeats && <Row label="Child Seat" value="Included" />}
          {booking.luggage > 0 && <Row label="Luggage" value={`${booking.luggage} pieces`} />}
        </div>

        {/* Route */}
        <div style={{
          background: '#111111',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '18px',
        }}>
          <SectionHeader label="Route" />
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, paddingTop: 3 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#C9A84C', flexShrink: 0 }} />
              <div style={{ width: 1, flex: 1, background: 'rgba(255,255,255,0.1)', minHeight: 24 }} />
              <div style={{ width: 10, height: 10, borderRadius: 2, background: '#555555', flexShrink: 0 }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: '#cccccc', marginBottom: 16, lineHeight: 1.4 }}>
                {booking.pickup || 'Pickup not set'}
              </div>
              <div style={{ fontSize: 13, color: '#888888', lineHeight: 1.4 }}>
                {booking.serviceType === 'airport' ? (booking.airport || 'Airport not selected') : booking.dropoff || booking.pickup || 'Return to pickup'}
              </div>
            </div>
          </div>
          {booking.flightNumber && (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Plane size={14} color="#888888" />
              <span style={{ fontSize: 12, color: '#888888' }}>Flight {booking.flightNumber}</span>
            </div>
          )}
        </div>

        {/* Price breakdown */}
        <div style={{
          background: '#111111',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '18px',
        }}>
          <SectionHeader label="Price Breakdown" />
          <Row label="Base fare" value={`£${baseFare.toFixed(2)}`} />
          {extras > 0 && <Row label="Extras (excess luggage)" value={`£${extras.toFixed(2)}`} />}
          <Row label="VAT (20%)" value={`£${vat.toFixed(2)}`} />
          {promoApplied && (
            <Row label="Promo: APEX20 (−20%)" value={`−£${discount.toFixed(2)}`} highlight />
          )}
          <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '12px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: '#ffffff' }}>Total</span>
            <span style={{ fontSize: 22, fontWeight: 800, color: '#C9A84C' }}>£{finalTotal.toFixed(2)}</span>
          </div>
        </div>

        {/* Promo code */}
        <div style={{
          background: '#111111',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '18px',
        }}>
          <SectionHeader label="Promo Code" />
          {promoApplied ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                flex: 1,
                background: 'rgba(201,168,76,0.08)',
                border: '1px solid rgba(201,168,76,0.3)',
                borderRadius: 10,
                padding: '10px 14px',
                fontSize: 13,
                color: '#C9A84C',
                fontWeight: 600,
              }}>
                APEX20 applied — 20% off
              </div>
              <button
                onClick={() => { setPromoApplied(false); setPromoInput(''); setBookingField('promoCode', ''); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888888', fontSize: 13 }}
              >
                Remove
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <div style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                  <Tag size={15} color="#555555" />
                </div>
                <input
                  type="text"
                  placeholder="Enter promo code"
                  value={promoInput}
                  onChange={e => { setPromoInput(e.target.value.toUpperCase()); setPromoError(''); }}
                  style={{
                    width: '100%',
                    background: '#1a1a1a',
                    border: `1px solid ${promoError ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'}`,
                    borderRadius: 10,
                    padding: '12px 14px 12px 38px',
                    color: '#ffffff',
                    fontSize: 13,
                    outline: 'none',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                    textTransform: 'uppercase',
                  }}
                />
              </div>
              <button
                onClick={applyPromo}
                style={{
                  padding: '12px 18px',
                  background: 'rgba(201,168,76,0.15)',
                  border: '1px solid rgba(201,168,76,0.3)',
                  borderRadius: 10,
                  color: '#C9A84C',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Apply
              </button>
            </div>
          )}
          {promoError && (
            <div style={{ fontSize: 11, color: '#ef4444', marginTop: 6 }}>{promoError}</div>
          )}
          {!promoApplied && (
            <div style={{ fontSize: 11, color: '#555555', marginTop: 6 }}>Try APEX20 for 20% off</div>
          )}
        </div>

        {/* Payment */}
        <div style={{
          background: '#111111',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '18px',
        }}>
          <SectionHeader label="Payment Method" />
          <button
            onClick={() => setShowCardPicker(v => !v)}
            style={{
              width: '100%',
              display: 'flex', alignItems: 'center', gap: 12,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12,
              padding: '14px 16px',
              cursor: 'pointer',
            }}
          >
            <CreditCard size={20} color="#C9A84C" />
            <div style={{ flex: 1, textAlign: 'left' }}>
              <div style={{ fontSize: 13, color: '#ffffff', fontWeight: 600 }}>
                {selectedCard?.type === 'visa' ? 'Visa' : 'Mastercard'} •••• {selectedCard?.last4}
              </div>
              <div style={{ fontSize: 11, color: '#888888' }}>Expires {selectedCard?.expiry}</div>
            </div>
            <ChevronDown size={16} color="#555555" style={{ transform: showCardPicker ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
          </button>

          {showCardPicker && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {MOCK_PAYMENT_CARDS.map(card => (
                <button
                  key={card.id}
                  onClick={() => { setBookingField('paymentCardId', card.id); setShowCardPicker(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    background: booking.paymentCardId === card.id ? 'rgba(201,168,76,0.08)' : 'transparent',
                    border: `1px solid ${booking.paymentCardId === card.id ? 'rgba(201,168,76,0.3)' : 'rgba(255,255,255,0.06)'}`,
                    borderRadius: 10,
                    padding: '12px 14px',
                    cursor: 'pointer',
                  }}
                >
                  <CreditCard size={16} color="#888888" />
                  <div style={{ flex: 1, textAlign: 'left' }}>
                    <span style={{ fontSize: 13, color: '#cccccc' }}>
                      {card.type === 'visa' ? 'Visa' : 'Mastercard'} •••• {card.last4}
                    </span>
                  </div>
                  {card.isDefault && (
                    <span style={{ fontSize: 10, color: '#C9A84C', fontWeight: 600 }}>DEFAULT</span>
                  )}
                </button>
              ))}
              <button
                onClick={() => { navigate('/payment'); }}
                style={{
                  padding: '11px 14px',
                  background: 'transparent',
                  border: '1px dashed rgba(255,255,255,0.15)',
                  borderRadius: 10,
                  color: '#888888',
                  fontSize: 13,
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
              >
                + Add new card
              </button>
            </div>
          )}
        </div>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: '#888888' }}>Total due now</span>
          <span style={{ fontSize: 20, fontWeight: 800, color: '#C9A84C' }}>£{finalTotal.toFixed(2)}</span>
        </div>
        <button
          onClick={handleConfirm}
          disabled={confirming}
          style={{
            width: '100%',
            padding: '16px',
            background: confirming ? 'rgba(201,168,76,0.5)' : '#C9A84C',
            color: '#0a0a0a',
            border: 'none',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: confirming ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          {confirming && <LoadingSpinner size="sm" color="#0a0a0a" />}
          {confirming ? 'Confirming Booking...' : 'Confirm Booking'}
        </button>
      </div>
    </div>
  );
}

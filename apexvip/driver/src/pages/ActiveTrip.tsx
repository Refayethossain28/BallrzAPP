import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Copy, Phone, MessageSquare, Navigation, Users, FileText, ChevronLeft } from 'lucide-react';
import { useTrip } from '../context/TripContext';
import Layout from '../components/Layout';

const STEPS = [
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'en_route', label: 'En Route' },
  { key: 'arrived', label: 'At Pickup' },
  { key: 'onboard', label: 'Onboard' },
  { key: 'completed', label: 'Completed' },
];

const ACTION_LABELS: Record<string, string> = {
  confirmed: "I'm on my way",
  en_route: 'Arrived at Pickup',
  arrived: 'Start Trip',
  onboard: 'Complete Trip',
};

const NEXT_STATUS: Record<string, string> = {
  confirmed: 'en_route',
  en_route: 'arrived',
  arrived: 'onboard',
  onboard: 'completed',
};

export default function ActiveTrip() {
  const { activeTrip, updateTripStatus, completeTrip } = useTrip();
  const navigate = useNavigate();
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!activeTrip) {
      navigate('/home', { replace: true });
    }
  }, [activeTrip, navigate]);

  useEffect(() => {
    if (activeTrip?.tripStatus === 'onboard' && activeTrip.startTime) {
      const start = new Date(activeTrip.startTime).getTime();
      const interval = setInterval(() => {
        setElapsed(Math.floor((Date.now() - start) / 1000));
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [activeTrip?.tripStatus, activeTrip?.startTime]);

  if (!activeTrip) return null;

  const currentStepIndex = STEPS.findIndex((s) => s.key === activeTrip.tripStatus);
  const isCompleted = activeTrip.tripStatus === 'completed';

  const handleAction = () => {
    const next = NEXT_STATUS[activeTrip.tripStatus];
    if (!next) return;
    if (next === 'completed') {
      completeTrip();
      setTimeout(() => navigate('/home'), 2000);
    } else {
      updateTripStatus(next as any);
    }
  };

  const formatElapsed = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const copyAddress = () => {
    navigator.clipboard.writeText(activeTrip.pickupAddress).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Layout hideNav>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 16px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <button
          onClick={() => navigate('/home')}
          style={{
            background: '#1a1a1a',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 10,
            width: 38,
            height: 38,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <ChevronLeft size={18} color="#ffffff" />
        </button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#ffffff' }}>Active Trip</div>
          <div style={{ fontSize: 11, color: '#C9A84C', fontWeight: 600 }}>
            £{activeTrip.price}
          </div>
        </div>
        <div style={{ width: 38 }} />
      </div>

      <div style={{ padding: '16px', overflowY: 'auto', paddingBottom: 120 }}>
        {/* Client info */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '14px 16px',
            marginBottom: 14,
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #C9A84C, #a07a2e)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 17,
              fontWeight: 700,
              color: '#0a0a0a',
              flexShrink: 0,
            }}
          >
            {activeTrip.clientInitials}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#ffffff' }}>{activeTrip.clientName}</div>
            <div style={{ fontSize: 12, color: '#888888', marginTop: 2 }}>{activeTrip.serviceType}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: 'rgba(34,197,94,0.1)',
                border: '1px solid rgba(34,197,94,0.2)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Phone size={16} color="#22c55e" />
            </button>
            <button
              style={{
                width: 38,
                height: 38,
                borderRadius: 10,
                background: 'rgba(59,130,246,0.1)',
                border: '1px solid rgba(59,130,246,0.2)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MessageSquare size={16} color="#3b82f6" />
            </button>
          </div>
        </div>

        {/* Status stepper */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '16px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#555555', letterSpacing: '0.1em', marginBottom: 14 }}>
            TRIP STATUS
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            {STEPS.map((step, i) => {
              const done = i < currentStepIndex;
              const current = i === currentStepIndex;
              return (
                <div key={step.key} style={{ display: 'flex', alignItems: 'center', flex: i < STEPS.length - 1 ? 1 : 0 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: done
                          ? '#C9A84C'
                          : current
                          ? 'rgba(201,168,76,0.2)'
                          : '#1a1a1a',
                        border: current ? '2px solid #C9A84C' : done ? 'none' : '1px solid #333333',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.3s',
                      }}
                    >
                      {done ? (
                        <span style={{ fontSize: 12, color: '#0a0a0a', fontWeight: 800 }}>✓</span>
                      ) : current ? (
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#C9A84C' }} />
                      ) : null}
                    </div>
                    <span
                      style={{
                        fontSize: 9,
                        color: current || done ? '#C9A84C' : '#444444',
                        fontWeight: current ? 700 : 500,
                        textAlign: 'center',
                        maxWidth: 48,
                        lineHeight: 1.3,
                      }}
                    >
                      {step.label}
                    </span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div
                      style={{
                        flex: 1,
                        height: 1,
                        background: i < currentStepIndex ? '#C9A84C' : '#222222',
                        margin: '0 4px',
                        marginBottom: 18,
                        transition: 'background 0.3s',
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Map placeholder */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            height: 140,
            marginBottom: 14,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(135deg, #0f1a0f 0%, #111111 50%, #0f0f1a 100%)',
              opacity: 0.6,
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage:
                'radial-gradient(circle at 2px 2px, rgba(255,255,255,0.04) 1px, transparent 0)',
              backgroundSize: '32px 32px',
            }}
          />
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Navigation size={20} color="#C9A84C" />
            <span style={{ fontSize: 14, fontWeight: 600, color: '#C9A84C' }}>Navigation</span>
          </div>
          <span style={{ position: 'relative', fontSize: 11, color: '#555555' }}>
            Tap to open maps
          </span>
        </div>

        {/* Route details */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '16px',
            marginBottom: 14,
          }}
        >
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e' }} />
              <div style={{ width: 1, flex: 1, background: 'rgba(255,255,255,0.12)', margin: '4px 0' }} />
              <MapPin size={12} color="#ef4444" />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 10, color: '#666666', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 4 }}>
                  PICKUP ADDRESS
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, color: '#ffffff', fontWeight: 500, lineHeight: 1.4, flex: 1 }}>
                    {activeTrip.pickupAddress}
                  </span>
                  <button
                    onClick={copyAddress}
                    style={{
                      flexShrink: 0,
                      background: copied ? 'rgba(34,197,94,0.1)' : '#1a1a1a',
                      border: `1px solid ${copied ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`,
                      borderRadius: 8,
                      padding: '5px 8px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <Copy size={12} color={copied ? '#22c55e' : '#888888'} />
                    <span style={{ fontSize: 10, color: copied ? '#22c55e' : '#888888' }}>
                      {copied ? 'Copied' : 'Copy'}
                    </span>
                  </button>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#666666', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 4 }}>
                  DROPOFF ADDRESS
                </div>
                <span style={{ fontSize: 13, color: '#ffffff', fontWeight: 500, lineHeight: 1.4 }}>
                  {activeTrip.dropoffAddress}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Trip details grid */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '16px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#555555', letterSpacing: '0.1em', marginBottom: 12 }}>
            TRIP DETAILS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <DetailRow label="Passengers">
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Users size={13} color="#888888" />
                <span style={{ fontSize: 14, color: '#ffffff', fontWeight: 600 }}>{activeTrip.passengers}</span>
              </div>
            </DetailRow>
            <DetailRow label="Luggage">
              <span style={{ fontSize: 14, color: '#ffffff', fontWeight: 600 }}>{activeTrip.luggage ?? 0} bags</span>
            </DetailRow>
            {activeTrip.flightNumber && (
              <DetailRow label="Flight No.">
                <span style={{ fontSize: 14, color: '#C9A84C', fontWeight: 700 }}>{activeTrip.flightNumber}</span>
              </DetailRow>
            )}
            <DetailRow label="Est. Duration">
              <span style={{ fontSize: 14, color: '#ffffff', fontWeight: 600 }}>{activeTrip.estimatedDuration}</span>
            </DetailRow>
            {activeTrip.tripStatus === 'onboard' && (
              <DetailRow label="Trip Timer">
                <span style={{ fontSize: 14, color: '#22c55e', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {formatElapsed(elapsed)}
                </span>
              </DetailRow>
            )}
          </div>

          {activeTrip.specialNotes && (
            <div
              style={{
                marginTop: 12,
                background: 'rgba(201,168,76,0.06)',
                border: '1px solid rgba(201,168,76,0.15)',
                borderRadius: 10,
                padding: '10px 12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <FileText size={12} color="#C9A84C" />
                <span style={{ fontSize: 10, fontWeight: 700, color: '#C9A84C', letterSpacing: '0.08em' }}>
                  SPECIAL NOTES
                </span>
              </div>
              <p style={{ fontSize: 12, color: '#cccccc', lineHeight: 1.5, margin: 0 }}>
                {activeTrip.specialNotes}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Action button */}
      {!isCompleted && ACTION_LABELS[activeTrip.tripStatus] && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: '100%',
            maxWidth: 480,
            padding: '12px 16px 28px',
            background: 'linear-gradient(to top, #0a0a0a 60%, transparent)',
          }}
        >
          <button
            onClick={handleAction}
            style={{
              width: '100%',
              padding: '17px',
              borderRadius: 16,
              border: 'none',
              background:
                activeTrip.tripStatus === 'arrived'
                  ? 'linear-gradient(135deg, #22c55e, #16a34a)'
                  : activeTrip.tripStatus === 'onboard'
                  ? 'linear-gradient(135deg, #C9A84C, #a07a2e)'
                  : 'linear-gradient(135deg, #3b82f6, #2563eb)',
              color: activeTrip.tripStatus === 'onboard' ? '#0a0a0a' : '#ffffff',
              fontSize: 15,
              fontWeight: 800,
              cursor: 'pointer',
              letterSpacing: '0.06em',
              boxShadow:
                activeTrip.tripStatus === 'onboard'
                  ? '0 4px 20px rgba(201,168,76,0.3)'
                  : '0 4px 20px rgba(59,130,246,0.25)',
            }}
          >
            {ACTION_LABELS[activeTrip.tripStatus].toUpperCase()}
          </button>
        </div>
      )}

      {isCompleted && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: '100%',
            maxWidth: 480,
            padding: '12px 16px 28px',
          }}
        >
          <div
            style={{
              background: 'rgba(34,197,94,0.1)',
              border: '1px solid rgba(34,197,94,0.3)',
              borderRadius: 16,
              padding: '16px',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 24, marginBottom: 4 }}>✓</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#22c55e' }}>Trip Completed!</div>
            <div style={{ fontSize: 13, color: '#888888', marginTop: 4 }}>Returning to home...</div>
          </div>
        </div>
      )}
    </Layout>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#555555', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 4 }}>
        {label.toUpperCase()}
      </div>
      {children}
    </div>
  );
}

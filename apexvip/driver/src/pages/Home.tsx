import { useNavigate } from 'react-router-dom';
import { Bell, ChevronRight, TrendingUp, Car } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTrip } from '../context/TripContext';
import Layout from '../components/Layout';
import StatusToggle from '../components/StatusToggle';
import JobRequestOverlay from '../components/JobRequestOverlay';
import { mockNotifications } from '../data/mockData';

export default function Home() {
  const { driver } = useAuth();
  const { isAvailable, setAvailable, pendingJob, activeTrip, acceptJob, declineJob, todayTrips, todayEarnings } =
    useTrip();
  const navigate = useNavigate();

  const unreadCount = mockNotifications.filter((n) => !n.read).length;

  const handleAccept = (job: typeof pendingJob) => {
    if (!job) return;
    acceptJob(job);
    navigate('/active');
  };

  return (
    <>
      {pendingJob && (
        <JobRequestOverlay
          job={pendingJob}
          onAccept={handleAccept}
          onDecline={declineJob}
        />
      )}

      <Layout>
        {/* Top bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 16px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, #C9A84C, #a07a2e)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 15,
                  fontWeight: 700,
                  color: '#0a0a0a',
                }}
              >
                {driver?.firstName?.[0]}{driver?.lastName?.[0]}
              </div>
              <div
                style={{
                  position: 'absolute',
                  bottom: 1,
                  right: 1,
                  width: 11,
                  height: 11,
                  borderRadius: '50%',
                  background: isAvailable ? '#22c55e' : '#555555',
                  border: '2px solid #0a0a0a',
                  transition: 'background 0.3s',
                }}
              />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#ffffff' }}>
                {driver?.name}
              </div>
              <div style={{ fontSize: 11, color: isAvailable ? '#22c55e' : '#666666', fontWeight: 500 }}>
                {isAvailable ? 'Online — Available' : 'Offline'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={() => navigate('/notifications')}
              style={{
                position: 'relative',
                width: 40,
                height: 40,
                borderRadius: '50%',
                background: '#1a1a1a',
                border: '1px solid rgba(255,255,255,0.08)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Bell size={18} color="#888888" />
              {unreadCount > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#C9A84C',
                    border: '1.5px solid #0a0a0a',
                  }}
                />
              )}
            </button>
          </div>
        </div>

        {/* Status toggle */}
        <div style={{ padding: '0 16px' }}>
          <StatusToggle isAvailable={isAvailable} onToggle={setAvailable} />
        </div>

        {/* Looking for jobs banner */}
        {isAvailable && !activeTrip && (
          <div
            style={{
              margin: '0 16px 16px',
              background: 'rgba(34,197,94,0.08)',
              border: '1px solid rgba(34,197,94,0.2)',
              borderRadius: 14,
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: '#22c55e',
                flexShrink: 0,
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
            <span style={{ fontSize: 13, color: '#22c55e', fontWeight: 600 }}>
              Looking for jobs nearby...
            </span>
            <style>{`
              @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.3; }
              }
            `}</style>
          </div>
        )}

        {/* Active trip card */}
        {activeTrip && (
          <div
            onClick={() => navigate('/active')}
            style={{
              margin: '0 16px 16px',
              background: 'linear-gradient(135deg, rgba(201,168,76,0.12), rgba(160,122,46,0.06))',
              border: '1px solid rgba(201,168,76,0.3)',
              borderRadius: 16,
              padding: '16px',
              cursor: 'pointer',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Car size={16} color="#C9A84C" />
                <span style={{ fontSize: 13, fontWeight: 700, color: '#C9A84C', letterSpacing: '0.05em' }}>
                  ACTIVE TRIP
                </span>
              </div>
              <ChevronRight size={18} color="#C9A84C" />
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#ffffff', marginBottom: 4 }}>
              {activeTrip.clientName}
            </div>
            <div style={{ fontSize: 12, color: '#aaaaaa', marginBottom: 6 }}>
              {activeTrip.pickupAddress}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div
                style={{
                  padding: '3px 10px',
                  borderRadius: 8,
                  background: 'rgba(34,197,94,0.15)',
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#22c55e',
                }}
              >
                {activeTrip.tripStatus === 'confirmed' && 'Confirmed'}
                {activeTrip.tripStatus === 'en_route' && 'En Route to Pickup'}
                {activeTrip.tripStatus === 'arrived' && 'Arrived at Pickup'}
                {activeTrip.tripStatus === 'onboard' && 'Passenger Onboard'}
                {activeTrip.tripStatus === 'completed' && 'Completed'}
              </div>
              <span style={{ fontSize: 16, fontWeight: 800, color: '#C9A84C', marginLeft: 'auto' }}>
                £{activeTrip.price}
              </span>
            </div>
          </div>
        )}

        {/* Today's stats */}
        <div
          style={{
            margin: '0 16px 16px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
          }}
        >
          <StatCard label="Trips Today" value={todayTrips.toString()} icon={<Car size={16} color="#C9A84C" />} />
          <StatCard
            label="Earnings Today"
            value={`£${todayEarnings}`}
            icon={<TrendingUp size={16} color="#C9A84C" />}
          />
        </div>

        {/* Quick actions */}
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#555555', letterSpacing: '0.1em', marginBottom: 10 }}>
            QUICK ACTIONS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <QuickAction label="View Jobs" onClick={() => navigate('/jobs')} />
            <QuickAction label="Earnings" onClick={() => navigate('/earnings')} />
            <QuickAction label="Trip History" onClick={() => navigate('/history')} />
            <QuickAction label="My Profile" onClick={() => navigate('/profile')} />
          </div>
        </div>
      </Layout>
    </>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div
      style={{
        background: '#111111',
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,0.07)',
        padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        {icon}
        <span style={{ fontSize: 10, fontWeight: 600, color: '#666666', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color: '#ffffff' }}>{value}</div>
    </div>
  );
}

function QuickAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: '#111111',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.07)',
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        cursor: 'pointer',
        color: '#cccccc',
        fontSize: 13,
        fontWeight: 600,
        textAlign: 'left',
      }}
    >
      {label}
      <ChevronRight size={14} color="#555555" />
    </button>
  );
}

import { useParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, MapPin, Users, Plane, FileText, Clock, Navigation } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { useTrip } from '../context/TripContext';
import Layout from '../components/Layout';
import { mockAvailableJobs, mockUpcomingJobs, jobRequestMock } from '../data/mockData';
import type { Job } from '../types';

const serviceColors: Record<string, string> = {
  'Airport Transfer': '#C9A84C',
  Hourly: '#8b5cf6',
  'Day Hire': '#3b82f6',
  'Point to Point': '#22c55e',
  'Hotel Transfer': '#ec4899',
};

export default function JobDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { acceptJob } = useTrip();

  const allJobs: Job[] = [jobRequestMock, ...mockAvailableJobs, ...mockUpcomingJobs];
  const job = allJobs.find((j) => j.id === id);

  if (!job) {
    return (
      <Layout>
        <div style={{ padding: 24, textAlign: 'center', color: '#888888' }}>
          <div style={{ fontSize: 16, marginBottom: 12 }}>Job not found</div>
          <button
            onClick={() => navigate('/jobs')}
            style={{
              padding: '10px 20px',
              background: '#111111',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10,
              color: '#ffffff',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Back to Jobs
          </button>
        </div>
      </Layout>
    );
  }

  const badgeColor = serviceColors[job.serviceType] ?? '#888888';
  const isAvailable = job.status === 'available';
  const isUpcoming = job.status === 'upcoming';

  const handleAccept = () => {
    acceptJob(job);
    navigate('/active');
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
          onClick={() => navigate('/jobs')}
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
          <div style={{ fontSize: 15, fontWeight: 700, color: '#ffffff' }}>Job Details</div>
        </div>
        <div style={{ width: 38 }} />
      </div>

      <div style={{ padding: '16px', overflowY: 'auto', paddingBottom: 120 }}>
        {/* Client + service header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '16px',
            marginBottom: 12,
          }}
        >
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
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#ffffff', marginBottom: 4 }}>
              {job.clientName}
            </div>
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
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#C9A84C' }}>£{job.price}</div>
          </div>
        </div>

        {/* Date/time */}
        <div
          style={{
            background: '#111111',
            borderRadius: 14,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <Clock size={16} color="#C9A84C" />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#ffffff' }}>
              {format(parseISO(job.pickupDate), 'EEEE, d MMMM yyyy')}
            </div>
            <div style={{ fontSize: 12, color: '#888888', marginTop: 2 }}>
              Pickup at {job.pickupTime}
            </div>
          </div>
        </div>

        {/* Route */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '16px',
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#555555', letterSpacing: '0.1em', marginBottom: 14 }}>
            ROUTE
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#22c55e' }} />
              <div style={{ width: 1, flex: 1, background: 'rgba(255,255,255,0.12)', margin: '6px 0', minHeight: 24 }} />
              <MapPin size={12} color="#ef4444" />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div>
                <div style={{ fontSize: 10, color: '#555555', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 3 }}>
                  PICKUP
                </div>
                <div style={{ fontSize: 14, color: '#ffffff', fontWeight: 500, lineHeight: 1.4 }}>
                  {job.pickupAddress}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#555555', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 3 }}>
                  DROPOFF
                </div>
                <div style={{ fontSize: 14, color: '#ffffff', fontWeight: 500, lineHeight: 1.4 }}>
                  {job.dropoffAddress}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Details */}
        <div
          style={{
            background: '#111111',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.07)',
            padding: '16px',
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: '#555555', letterSpacing: '0.1em', marginBottom: 14 }}>
            JOB DETAILS
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 14,
            }}
          >
            <FieldItem label="Passengers" value={`${job.passengers} pax`} />
            <FieldItem label="Luggage" value={`${job.luggage ?? 0} bags`} />
            <FieldItem label="Vehicle" value={job.vehicle} />
            <FieldItem label="Est. Duration" value={job.estimatedDuration} />
            <FieldItem label="Distance" value={job.estimatedDistance} />
            {job.distanceToPickup && (
              <FieldItem label="To Pickup" value={job.distanceToPickup} />
            )}
            {job.flightNumber && (
              <FieldItem label="Flight No." value={job.flightNumber} accent />
            )}
          </div>

          {job.specialNotes && (
            <div
              style={{
                marginTop: 14,
                background: 'rgba(201,168,76,0.06)',
                border: '1px solid rgba(201,168,76,0.15)',
                borderRadius: 10,
                padding: '12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <FileText size={13} color="#C9A84C" />
                <span style={{ fontSize: 10, fontWeight: 700, color: '#C9A84C', letterSpacing: '0.08em' }}>
                  SPECIAL NOTES
                </span>
              </div>
              <p style={{ fontSize: 13, color: '#cccccc', lineHeight: 1.5, margin: 0 }}>
                {job.specialNotes}
              </p>
            </div>
          )}
        </div>

        {/* Icons row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <InfoChip icon={<Users size={14} color="#888888" />} label={`${job.passengers} Pax`} />
          <InfoChip icon={<Navigation size={14} color="#888888" />} label={job.estimatedDistance} />
          {job.flightNumber ? (
            <InfoChip icon={<Plane size={14} color="#888888" />} label={job.flightNumber} />
          ) : (
            <InfoChip icon={<Clock size={14} color="#888888" />} label={job.estimatedDuration} />
          )}
        </div>
      </div>

      {/* Action footer */}
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: '100%',
          maxWidth: 480,
          padding: '12px 16px 28px',
          background: 'linear-gradient(to top, #0a0a0a 70%, transparent)',
        }}
      >
        {isAvailable && (
          <button
            onClick={handleAccept}
            style={{
              width: '100%',
              padding: '17px',
              borderRadius: 16,
              border: 'none',
              background: 'linear-gradient(135deg, #22c55e, #16a34a)',
              color: '#ffffff',
              fontSize: 15,
              fontWeight: 800,
              cursor: 'pointer',
              letterSpacing: '0.06em',
              boxShadow: '0 4px 20px rgba(34,197,94,0.3)',
            }}
          >
            ACCEPT JOB — £{job.price}
          </button>
        )}
        {isUpcoming && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <button
              onClick={() => navigate('/jobs')}
              style={{
                padding: '17px',
                borderRadius: 16,
                border: '1px solid rgba(239,68,68,0.3)',
                background: 'rgba(239,68,68,0.1)',
                color: '#ef4444',
                fontSize: 14,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              CANCEL
            </button>
            <button
              style={{
                padding: '17px',
                borderRadius: 16,
                border: '1px solid rgba(201,168,76,0.3)',
                background: 'rgba(201,168,76,0.1)',
                color: '#C9A84C',
                fontSize: 14,
                fontWeight: 700,
                cursor: 'pointer',
                letterSpacing: '0.04em',
              }}
            >
              CONFIRMED
            </button>
          </div>
        )}
      </div>
    </Layout>
  );
}

function FieldItem({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#555555', fontWeight: 600, letterSpacing: '0.08em', marginBottom: 3 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontSize: 13, color: accent ? '#C9A84C' : '#ffffff', fontWeight: accent ? 700 : 500 }}>
        {value}
      </div>
    </div>
  );
}

function InfoChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div
      style={{
        background: '#111111',
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.07)',
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      {icon}
      <span style={{ fontSize: 12, color: '#aaaaaa', fontWeight: 500 }}>{label}</span>
    </div>
  );
}

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase } from 'lucide-react';
import { useTrip } from '../context/TripContext';
import Layout from '../components/Layout';
import JobCard from '../components/JobCard';
import { mockAvailableJobs, mockUpcomingJobs } from '../data/mockData';
import type { Job } from '../types';

type Tab = 'available' | 'upcoming';

export default function JobsList() {
  const [tab, setTab] = useState<Tab>('available');
  const { acceptJob, activeTrip } = useTrip();
  const navigate = useNavigate();

  const handleAccept = (job: Job) => {
    acceptJob(job);
    navigate('/active');
  };

  const jobs = tab === 'available' ? mockAvailableJobs : mockUpcomingJobs;

  return (
    <Layout>
      {/* Header */}
      <div
        style={{
          padding: '16px 16px 0',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Briefcase size={18} color="#C9A84C" />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#ffffff', margin: 0 }}>Jobs</h1>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0 }}>
          {(['available', 'upcoming'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                flex: 1,
                padding: '10px 16px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 700,
                color: tab === t ? '#C9A84C' : '#555555',
                borderBottom: `2px solid ${tab === t ? '#C9A84C' : 'transparent'}`,
                letterSpacing: '0.04em',
                transition: 'all 0.2s',
                textTransform: 'capitalize',
              }}
            >
              {t === 'available' ? `Available (${mockAvailableJobs.length})` : `Upcoming (${mockUpcomingJobs.length})`}
            </button>
          ))}
        </div>
      </div>

      {/* Active trip banner */}
      {activeTrip && (
        <div
          onClick={() => navigate('/active')}
          style={{
            margin: '12px 16px 0',
            background: 'rgba(201,168,76,0.08)',
            border: '1px solid rgba(201,168,76,0.2)',
            borderRadius: 12,
            padding: '10px 14px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 12, color: '#C9A84C', fontWeight: 600 }}>
            Active trip in progress — tap to view
          </span>
          <span style={{ fontSize: 12, color: '#C9A84C' }}>→</span>
        </div>
      )}

      {/* Job list */}
      <div style={{ padding: '14px 16px' }}>
        {jobs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: '#444444' }}>
            <Briefcase size={40} color="#333333" style={{ margin: '0 auto 12px' }} />
            <div style={{ fontSize: 15, fontWeight: 600, color: '#444444' }}>
              No {tab} jobs at the moment
            </div>
            <div style={{ fontSize: 13, marginTop: 6 }}>Check back soon</div>
          </div>
        ) : (
          jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              showAcceptButton={tab === 'available'}
              onAccept={handleAccept}
            />
          ))
        )}
      </div>
    </Layout>
  );
}

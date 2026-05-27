import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  Car,
  FileText,
  CreditCard,
  Calendar,
  Star,
  HelpCircle,
  LogOut,
  Shield,
  BarChart2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Layout from '../components/Layout';
import { mockReviews } from '../data/mockData';

export default function Profile() {
  const { driver, logout } = useAuth();
  const navigate = useNavigate();

  if (!driver) return null;

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const avgRating =
    mockReviews.reduce((s, r) => s + r.rating, 0) / mockReviews.length;

  return (
    <Layout>
      {/* Header */}
      <div
        style={{
          padding: '16px 16px 0',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#ffffff', margin: '0 0 16px' }}>Profile</h1>
      </div>

      <div style={{ padding: '20px 16px' }}>
        {/* Driver card */}
        <div
          style={{
            background: 'linear-gradient(135deg, rgba(201,168,76,0.1), rgba(160,122,46,0.04))',
            border: '1px solid rgba(201,168,76,0.2)',
            borderRadius: 20,
            padding: '20px 16px',
            marginBottom: 16,
            textAlign: 'center',
          }}
        >
          {/* Avatar */}
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #C9A84C, #a07a2e)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
              fontWeight: 700,
              color: '#0a0a0a',
              margin: '0 auto 14px',
              boxShadow: '0 4px 20px rgba(201,168,76,0.3)',
            }}
          >
            {driver.firstName[0]}{driver.lastName[0]}
          </div>

          <div style={{ fontSize: 22, fontWeight: 800, color: '#ffffff', marginBottom: 2 }}>
            {driver.name}
          </div>
          <div style={{ fontSize: 12, color: '#888888', marginBottom: 12 }}>
            {driver.vehicle.registration} — {driver.vehicle.type}
          </div>

          {/* Rating + stats row */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 28 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <Star size={14} fill="#C9A84C" color="#C9A84C" />
                <span style={{ fontSize: 20, fontWeight: 800, color: '#C9A84C' }}>{avgRating.toFixed(1)}</span>
              </div>
              <div style={{ fontSize: 10, color: '#666666', marginTop: 2, fontWeight: 500 }}>RATING</div>
            </div>
            <div style={{ width: 1, background: 'rgba(255,255,255,0.08)' }} />
            <div style={{ textAlign: 'center' }}>
              <span style={{ fontSize: 20, fontWeight: 800, color: '#ffffff' }}>{driver.totalTrips}</span>
              <div style={{ fontSize: 10, color: '#666666', marginTop: 2, fontWeight: 500 }}>TRIPS</div>
            </div>
            <div style={{ width: 1, background: 'rgba(255,255,255,0.08)' }} />
            <div style={{ textAlign: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#ffffff' }}>{driver.memberSince}</span>
              <div style={{ fontSize: 10, color: '#666666', marginTop: 2, fontWeight: 500 }}>MEMBER SINCE</div>
            </div>
          </div>
        </div>

        {/* Navigation sections */}
        <SectionLabel label="MY ACCOUNT" />
        <MenuGroup>
          <MenuItem
            icon={<Car size={18} color="#C9A84C" />}
            label="My Vehicle"
            subtitle={`${driver.vehicle.make} ${driver.vehicle.model} — ${driver.vehicle.registration}`}
            onClick={() => {}}
          />
          <MenuDivider />
          <MenuItem
            icon={<FileText size={18} color="#C9A84C" />}
            label="Documents"
            subtitle="All documents verified"
            badge="✓"
            badgeColor="#22c55e"
            onClick={() => navigate('/documents')}
          />
          <MenuDivider />
          <MenuItem
            icon={<CreditCard size={18} color="#C9A84C" />}
            label="Bank Details"
            subtitle="Account ending ****4521"
            onClick={() => {}}
          />
          <MenuDivider />
          <MenuItem
            icon={<Calendar size={18} color="#C9A84C" />}
            label="Availability Schedule"
            subtitle="Set your working hours"
            onClick={() => {}}
          />
        </MenuGroup>

        <SectionLabel label="PERFORMANCE" />
        <MenuGroup>
          <MenuItem
            icon={<Star size={18} color="#C9A84C" />}
            label="Ratings & Reviews"
            subtitle={`${mockReviews.length} reviews — ${avgRating.toFixed(1)} avg`}
            onClick={() => {}}
          />
          <MenuDivider />
          <MenuItem
            icon={<BarChart2 size={18} color="#C9A84C" />}
            label="Performance Stats"
            subtitle="View your driver metrics"
            onClick={() => {}}
          />
        </MenuGroup>

        <SectionLabel label="SUPPORT" />
        <MenuGroup>
          <MenuItem
            icon={<Shield size={18} color="#C9A84C" />}
            label="Safety & Security"
            subtitle="Emergency contacts & safety"
            onClick={() => {}}
          />
          <MenuDivider />
          <MenuItem
            icon={<HelpCircle size={18} color="#C9A84C" />}
            label="Help & Support"
            subtitle="FAQs, contact ApexVIP"
            onClick={() => {}}
          />
        </MenuGroup>

        {/* Sign out */}
        <button
          onClick={handleLogout}
          style={{
            width: '100%',
            padding: '16px',
            borderRadius: 14,
            border: '1px solid rgba(239,68,68,0.2)',
            background: 'rgba(239,68,68,0.06)',
            color: '#ef4444',
            fontSize: 14,
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            marginTop: 8,
            letterSpacing: '0.04em',
          }}
        >
          <LogOut size={16} />
          SIGN OUT
        </button>

        <div style={{ marginTop: 16, textAlign: 'center', fontSize: 11, color: '#333333' }}>
          ApexVIP Driver v2.4.1 — Licensed Operator
        </div>
      </div>
    </Layout>
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: '#444444',
        letterSpacing: '0.12em',
        padding: '14px 4px 8px',
      }}
    >
      {label}
    </div>
  );
}

function MenuGroup({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: '#111111',
        borderRadius: 16,
        border: '1px solid rgba(255,255,255,0.07)',
        overflow: 'hidden',
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

function MenuDivider() {
  return (
    <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '0 16px' }} />
  );
}

function MenuItem({
  icon,
  label,
  subtitle,
  badge,
  badgeColor,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        padding: '14px 16px',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        textAlign: 'left',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: 'rgba(201,168,76,0.08)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#ffffff' }}>{label}</div>
        {subtitle && <div style={{ fontSize: 11, color: '#555555', marginTop: 1 }}>{subtitle}</div>}
      </div>
      {badge && (
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: badgeColor ?? '#888888',
            marginRight: 4,
          }}
        >
          {badge}
        </span>
      )}
      <ChevronRight size={16} color="#333333" />
    </button>
  );
}

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Mail, Phone, Edit2, CreditCard, MapPin, Globe, Bell,
  Gift, HelpCircle, LogOut, ChevronRight, Check,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { MOCK_PAYMENT_CARDS, MOCK_SAVED_ADDRESSES } from '../data/mockData';
import Layout from '../components/Layout';

export default function Profile() {
  const navigate = useNavigate();
  const { user, logout, updateUser } = useAuth();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(user?.name || '');
  const [editPhone, setEditPhone] = useState(user?.phone || '');
  const [savedEdit, setSavedEdit] = useState(false);

  const initials = user?.name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'AV';

  const handleSave = () => {
    updateUser({ name: editName, phone: editPhone });
    setSavedEdit(true);
    setEditing(false);
    setTimeout(() => setSavedEdit(false), 2000);
  };

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const SectionTitle = ({ children }: { children: React.ReactNode }) => (
    <div style={{
      fontSize: 11, fontWeight: 600, letterSpacing: '0.12em',
      textTransform: 'uppercase', color: '#555555',
      padding: '20px 20px 8px',
    }}>
      {children}
    </div>
  );

  const MenuItem = ({
    icon: Icon,
    label,
    sub,
    onClick,
    danger,
    right,
  }: {
    icon: React.ElementType;
    label: string;
    sub?: string;
    onClick?: () => void;
    danger?: boolean;
    right?: React.ReactNode;
  }) => (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '14px 20px',
        background: 'none',
        border: 'none',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => onClick && ((e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.02)')}
      onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'none')}
    >
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: danger ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.05)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={17} color={danger ? '#ef4444' : '#888888'} strokeWidth={1.8} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, color: danger ? '#ef4444' : '#ffffff', fontWeight: 400 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: '#555555', marginTop: 1 }}>{sub}</div>}
      </div>
      {right || (onClick && <ChevronRight size={16} color="#444444" />)}
    </button>
  );

  return (
    <Layout>
      {/* Header */}
      <div style={{
        padding: '52px 20px 24px',
        background: 'linear-gradient(180deg, #111111 0%, #0a0a0a 100%)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#ffffff', marginBottom: 20 }}>Profile</div>

        {/* Avatar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(201,168,76,0.2), rgba(201,168,76,0.05))',
            border: '2px solid rgba(201,168,76,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22, fontWeight: 700, color: '#C9A84C',
            flexShrink: 0,
          }}>
            {initials}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', marginBottom: 2 }}>{user?.name}</div>
            <div style={{ fontSize: 13, color: '#888888' }}>{user?.email}</div>
            {savedEdit && (
              <div style={{ fontSize: 11, color: '#22c55e', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Check size={12} color="#22c55e" />
                Profile updated
              </div>
            )}
          </div>
          <button
            onClick={() => { setEditing(v => !v); setEditName(user?.name || ''); setEditPhone(user?.phone || ''); }}
            style={{
              width: 38, height: 38, borderRadius: 10,
              background: editing ? 'rgba(201,168,76,0.15)' : 'rgba(255,255,255,0.06)',
              border: `1px solid ${editing ? 'rgba(201,168,76,0.3)' : 'rgba(255,255,255,0.1)'}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <Edit2 size={16} color={editing ? '#C9A84C' : '#888888'} />
          </button>
        </div>

        {/* Edit form */}
        {editing && (
          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              placeholder="Full name"
              style={{
                background: '#1a1a1a',
                border: '1px solid rgba(201,168,76,0.4)',
                borderRadius: 10,
                padding: '12px 14px',
                color: '#ffffff',
                fontSize: 14,
                outline: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                width: '100%',
              }}
            />
            <input
              value={editPhone}
              onChange={e => setEditPhone(e.target.value)}
              placeholder="Phone number"
              style={{
                background: '#1a1a1a',
                border: '1px solid rgba(201,168,76,0.4)',
                borderRadius: 10,
                padding: '12px 14px',
                color: '#ffffff',
                fontSize: 14,
                outline: 'none',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
                width: '100%',
              }}
            />
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={handleSave}
                style={{
                  flex: 1, padding: '11px',
                  background: '#C9A84C', border: 'none', borderRadius: 10,
                  color: '#0a0a0a', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                }}
              >
                Save Changes
              </button>
              <button
                onClick={() => setEditing(false)}
                style={{
                  flex: 1, padding: '11px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 10, color: '#888888', fontSize: 13, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Account info */}
      <SectionTitle>Account</SectionTitle>
      <div style={{ background: '#111111', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 0, margin: '0' }}>
        <MenuItem icon={Mail} label={user?.email || ''} sub="Email address" />
        <MenuItem icon={Phone} label={user?.phone || ''} sub="Phone number" onClick={() => setEditing(true)} />
      </div>

      {/* Payments */}
      <SectionTitle>Payments &amp; Addresses</SectionTitle>
      <div style={{ background: '#111111', border: '1px solid rgba(255,255,255,0.07)', margin: 0 }}>
        <MenuItem
          icon={CreditCard}
          label="Payment Methods"
          sub={`${MOCK_PAYMENT_CARDS.length} card${MOCK_PAYMENT_CARDS.length !== 1 ? 's' : ''} saved`}
          onClick={() => navigate('/payment')}
        />
        <MenuItem
          icon={MapPin}
          label="Saved Addresses"
          sub={`${MOCK_SAVED_ADDRESSES.length} addresses`}
          onClick={() => {}}
        />
      </div>

      {/* Preferences */}
      <SectionTitle>Preferences</SectionTitle>
      <div style={{ background: '#111111', border: '1px solid rgba(255,255,255,0.07)', margin: 0 }}>
        <MenuItem
          icon={Globe}
          label="Language &amp; Currency"
          sub="English · GBP (£)"
          onClick={() => {}}
        />
        <MenuItem
          icon={Bell}
          label="Notification Settings"
          sub="Push, email &amp; SMS"
          onClick={() => navigate('/notifications')}
        />
      </div>

      {/* More */}
      <SectionTitle>More</SectionTitle>
      <div style={{ background: '#111111', border: '1px solid rgba(255,255,255,0.07)', margin: 0 }}>
        <MenuItem
          icon={Gift}
          label="Referral Code"
          sub="Share APEX-JH99 for rewards"
          onClick={() => {}}
          right={
            <span style={{ fontSize: 12, color: '#C9A84C', fontWeight: 700, letterSpacing: '0.04em' }}>
              APEX-JH99
            </span>
          }
        />
        <MenuItem
          icon={HelpCircle}
          label="Help &amp; Support"
          sub="FAQs, live chat"
          onClick={() => {}}
        />
        <MenuItem
          icon={LogOut}
          label="Sign Out"
          onClick={handleLogout}
          danger
        />
      </div>

      <div style={{ height: 24 }} />
    </Layout>
  );
}

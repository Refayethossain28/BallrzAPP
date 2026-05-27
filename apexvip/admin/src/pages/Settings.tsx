import { useState } from 'react';
import { Save, Plus, Trash2, Check, Shield, Bell, Users, CreditCard, Code2 } from 'lucide-react';
import Layout from '../components/Layout';
import Header from '../components/Header';
import Avatar from '../components/Avatar';
import StatusBadge from '../components/StatusBadge';
import { mockAdminUsers } from '../data/mockData';
import type { AdminUser } from '../types';

const TABS = [
  { key: 'General', icon: <Shield size={14} /> },
  { key: 'Notifications', icon: <Bell size={14} /> },
  { key: 'Users', icon: <Users size={14} /> },
  { key: 'Billing', icon: <CreditCard size={14} /> },
  { key: 'API', icon: <Code2 size={14} /> },
];

const INPUT: React.CSSProperties = {
  background: '#222', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '8px', padding: '9px 14px',
  fontSize: '13px', color: '#fff', outline: 'none',
  width: '100%', boxSizing: 'border-box',
};

const TOGGLE_BASE: React.CSSProperties = {
  width: 42, height: 24, borderRadius: '12px', cursor: 'pointer',
  border: 'none', position: 'relative', transition: 'background 0.2s',
};

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{ ...TOGGLE_BASE, background: checked ? '#C9A84C' : '#333' }}
    >
      <div style={{
        position: 'absolute', top: 3, left: checked ? 21 : 3,
        width: 18, height: 18, borderRadius: '50%',
        background: '#fff', transition: 'left 0.2s',
      }} />
    </button>
  );
}

export default function Settings() {
  const [activeTab, setActiveTab] = useState('General');
  const [saved, setSaved] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>(mockAdminUsers);

  const [general, setGeneral] = useState({
    companyName: 'ApexVIP Chauffeurs Ltd',
    contactEmail: 'operations@apexvip.com',
    contactPhone: '+44 20 7946 0000',
    timezone: 'Europe/London',
    currency: 'GBP',
    vatNumber: 'GB123456789',
    addressLine1: '1 Mayfair Court, Brook Street',
    addressLine2: 'London W1K 4HR',
  });

  const [notifSettings, setNotifSettings] = useState({
    emailNewBooking: true,
    emailCancellation: true,
    emailPayment: true,
    smsDriverAssigned: true,
    smsBookingReminder: true,
    smsPayment: false,
    pushNewBooking: true,
    pushDriverAlert: true,
  });

  const [billing, setBilling] = useState({
    commissionRate: '12',
    vatRate: '20',
    paymentProvider: 'stripe',
    stripeKey: 'pk_live_****************************',
    invoicePrefix: 'AVP',
    paymentTerms: '30',
  });

  const [apiKeys] = useState([
    { id: 'API-001', name: 'Production Key', key: 'ax_live_hK7p9mNqR2sT4uV6wX8yZ0aB1cD3eF5g', created: '2026-01-01', lastUsed: '2026-05-27' },
    { id: 'API-002', name: 'Webhook Secret', key: 'whsec_jL2mP4nQ6rS8tU0vW2xY4zA5bC7dE9f', created: '2026-01-01', lastUsed: '2026-05-26' },
  ]);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggleUserActive = (id: string) => {
    setUsers(prev => prev.map(u => u.id === id ? { ...u, active: !u.active } : u));
  };

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', overflow: 'hidden', marginBottom: '20px' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: '13px', fontWeight: 600, color: '#fff' }}>{title}</div>
      <div style={{ padding: '20px' }}>{children}</div>
    </div>
  );

  const Field = ({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) => (
    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: '16px', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div>
        <div style={{ fontSize: '13px', color: '#ccc', fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: '11px', color: '#555', marginTop: '2px' }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );

  const NotifRow = ({ label, hint, stateKey }: { label: string; hint?: string; stateKey: keyof typeof notifSettings }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div>
        <div style={{ fontSize: '13px', color: '#ccc' }}>{label}</div>
        {hint && <div style={{ fontSize: '11px', color: '#555', marginTop: '2px' }}>{hint}</div>}
      </div>
      <Toggle checked={notifSettings[stateKey]} onChange={v => setNotifSettings(s => ({ ...s, [stateKey]: v }))} />
    </div>
  );

  return (
    <Layout>
      <Header title="Settings" subtitle="Configure your ApexVIP Admin system" />

      <div style={{ display: 'flex', gap: '0', marginBottom: '24px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', gap: '4px' }}>
          {TABS.map(({ key, icon }) => (
            <button key={key} onClick={() => setActiveTab(key)} style={{ background: 'none', border: 'none', padding: '8px 14px 12px', cursor: 'pointer', fontSize: '13px', fontWeight: activeTab === key ? 600 : 500, color: activeTab === key ? '#C9A84C' : '#666', borderBottom: `2px solid ${activeTab === key ? '#C9A84C' : 'transparent'}`, marginBottom: '-1px', transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {icon}{key}
            </button>
          ))}
        </div>
        {activeTab !== 'Users' && activeTab !== 'API' && (
          <button onClick={handleSave} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: saved ? 'rgba(34,197,94,0.15)' : '#C9A84C', border: saved ? '1px solid rgba(34,197,94,0.3)' : 'none', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: saved ? '#22c55e' : '#0f0f0f', marginBottom: '12px', transition: 'all 0.2s' }}>
            {saved ? <><Check size={14} /> Saved</> : <><Save size={14} /> Save</>}
          </button>
        )}
      </div>

      {activeTab === 'General' && (
        <>
          <Section title="Company Information">
            {[
              { label: 'Company Name', key: 'companyName' },
              { label: 'Contact Email', key: 'contactEmail' },
              { label: 'Contact Phone', key: 'contactPhone' },
              { label: 'VAT Number', key: 'vatNumber' },
              { label: 'Address Line 1', key: 'addressLine1' },
              { label: 'Address Line 2', key: 'addressLine2' },
            ].map(({ label, key }) => (
              <Field key={key} label={label}>
                <input value={general[key as keyof typeof general]} onChange={e => setGeneral(g => ({ ...g, [key]: e.target.value }))} style={{ ...INPUT }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
              </Field>
            ))}
          </Section>
          <Section title="Regional Settings">
            <Field label="Default Timezone">
              <select value={general.timezone} onChange={e => setGeneral(g => ({ ...g, timezone: e.target.value }))} style={{ ...INPUT, cursor: 'pointer' }}>
                <option value="Europe/London">Europe/London (GMT/BST)</option>
                <option value="Europe/Paris">Europe/Paris (CET)</option>
                <option value="America/New_York">America/New_York (EST)</option>
                <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
              </select>
            </Field>
            <Field label="Currency">
              <select value={general.currency} onChange={e => setGeneral(g => ({ ...g, currency: e.target.value }))} style={{ ...INPUT, cursor: 'pointer' }}>
                <option value="GBP">GBP (£) — British Pound</option>
                <option value="EUR">EUR (€) — Euro</option>
                <option value="USD">USD ($) — US Dollar</option>
              </select>
            </Field>
          </Section>
        </>
      )}

      {activeTab === 'Notifications' && (
        <>
          <Section title="Email Notifications">
            <NotifRow label="New Booking Received" hint="Sent when a new booking is created" stateKey="emailNewBooking" />
            <NotifRow label="Booking Cancellation" hint="Sent when a booking is cancelled" stateKey="emailCancellation" />
            <NotifRow label="Payment Received" hint="Sent when payment is confirmed" stateKey="emailPayment" />
          </Section>
          <Section title="SMS Notifications">
            <NotifRow label="Driver Assigned" hint="SMS sent to client when driver is assigned" stateKey="smsDriverAssigned" />
            <NotifRow label="Booking Reminder" hint="Reminder sent 2 hours before pickup" stateKey="smsBookingReminder" />
            <NotifRow label="Payment Confirmation" hint="SMS receipt after payment" stateKey="smsPayment" />
          </Section>
          <Section title="Push Notifications">
            <NotifRow label="New Booking Alert" hint="Push notification to admin on new booking" stateKey="pushNewBooking" />
            <NotifRow label="Driver Status Alerts" hint="Alerts for driver going offline/online" stateKey="pushDriverAlert" />
          </Section>
        </>
      )}

      {activeTab === 'Users' && (
        <Section title="Admin Users">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '16px' }}>
            <button style={{ display: 'flex', alignItems: 'center', gap: '6px', background: '#C9A84C', border: 'none', borderRadius: '8px', padding: '8px 14px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: '#0f0f0f' }}>
              <Plus size={13} /> Invite User
            </button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['User', 'Role', 'Last Login', 'Status', 'Actions'].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: '10px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{h}</th>)}</tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }} onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ padding: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Avatar name={u.name} size={32} />
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 500, color: '#fff' }}>{u.name}</div>
                        <div style={{ fontSize: '11px', color: '#555' }}>{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '12px' }}>
                    <span style={{ background: u.role === 'superadmin' ? 'rgba(201,168,76,0.1)' : 'rgba(136,136,136,0.1)', color: u.role === 'superadmin' ? '#C9A84C' : '#888', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 600, textTransform: 'capitalize' }}>
                      {u.role}
                    </span>
                  </td>
                  <td style={{ padding: '12px', fontSize: '12px', color: '#666' }}>
                    {new Date(u.lastLogin).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  <td style={{ padding: '12px' }}>
                    <StatusBadge status={u.active ? 'active' : 'cancelled'} />
                  </td>
                  <td style={{ padding: '12px' }}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button onClick={() => toggleUserActive(u.id)} style={{ background: u.active ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '11px', color: u.active ? '#ef4444' : '#22c55e' }}>
                        {u.active ? 'Disable' : 'Enable'}
                      </button>
                      {u.role !== 'superadmin' && (
                        <button style={{ background: 'rgba(239,68,68,0.08)', border: 'none', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', color: '#ef4444' }}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {activeTab === 'Billing' && (
        <>
          <Section title="Commission & Rates">
            <Field label="Commission Rate" hint="Percentage taken from each booking">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="number" value={billing.commissionRate} onChange={e => setBilling(b => ({ ...b, commissionRate: e.target.value }))} style={{ ...INPUT, width: '100px' }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
                <span style={{ fontSize: '13px', color: '#888' }}>%</span>
              </div>
            </Field>
            <Field label="VAT Rate">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input type="number" value={billing.vatRate} onChange={e => setBilling(b => ({ ...b, vatRate: e.target.value }))} style={{ ...INPUT, width: '100px' }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
                <span style={{ fontSize: '13px', color: '#888' }}>%</span>
              </div>
            </Field>
            <Field label="Invoice Prefix">
              <input value={billing.invoicePrefix} onChange={e => setBilling(b => ({ ...b, invoicePrefix: e.target.value }))} style={{ ...INPUT, width: '100px' }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
            </Field>
            <Field label="Payment Terms (days)">
              <input type="number" value={billing.paymentTerms} onChange={e => setBilling(b => ({ ...b, paymentTerms: e.target.value }))} style={{ ...INPUT, width: '100px' }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
            </Field>
          </Section>
          <Section title="Payment Provider">
            <Field label="Provider">
              <select value={billing.paymentProvider} onChange={e => setBilling(b => ({ ...b, paymentProvider: e.target.value }))} style={{ ...INPUT, width: '200px', cursor: 'pointer' }}>
                <option value="stripe">Stripe</option>
                <option value="braintree">Braintree</option>
                <option value="manual">Manual / Invoicing</option>
              </select>
            </Field>
            <Field label="Stripe Public Key" hint="Your Stripe publishable key">
              <input value={billing.stripeKey} onChange={e => setBilling(b => ({ ...b, stripeKey: e.target.value }))} style={{ ...INPUT }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
            </Field>
          </Section>
        </>
      )}

      {activeTab === 'API' && (
        <Section title="API Keys">
          <div style={{ marginBottom: '16px' }}>
            <div style={{ padding: '14px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '8px', fontSize: '13px', color: '#f59e0b' }}>
              Keep your API keys secure. Never share them publicly or commit them to version control.
            </div>
          </div>
          {apiKeys.map(key => (
            <div key={key.id} style={{ background: '#222', borderRadius: '10px', padding: '16px', marginBottom: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>{key.name}</div>
                  <div style={{ fontSize: '11px', color: '#555', marginTop: '2px' }}>Created {new Date(key.created).toLocaleDateString('en-GB')} · Last used {new Date(key.lastUsed).toLocaleDateString('en-GB')}</div>
                </div>
                <button style={{ background: 'rgba(239,68,68,0.1)', border: 'none', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', color: '#ef4444' }}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <code style={{ flex: 1, background: '#1a1a1a', borderRadius: '6px', padding: '8px 12px', fontSize: '12px', color: '#C9A84C', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {key.key}
                </code>
                <button style={{ background: 'rgba(201,168,76,0.1)', border: 'none', borderRadius: '6px', padding: '7px 12px', cursor: 'pointer', fontSize: '12px', color: '#C9A84C', whiteSpace: 'nowrap' }}>
                  Copy
                </button>
              </div>
            </div>
          ))}
          <button style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: '8px', padding: '9px 16px', cursor: 'pointer', fontSize: '13px', color: '#C9A84C', marginTop: '8px' }}>
            <Plus size={13} /> Generate New API Key
          </button>
        </Section>
      )}
    </Layout>
  );
}

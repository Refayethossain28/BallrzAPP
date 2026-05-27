import { useState } from 'react';
import { Save, Edit, Check } from 'lucide-react';
import Layout from '../components/Layout';
import Header from '../components/Header';
import { mockPricingRates, mockPeakSurcharges } from '../data/mockData';
import type { PricingRate, PeakSurcharge } from '../types';

const TABS = ['Standard Rates', 'Peak Surcharges', 'Zones'];

const INPUT: React.CSSProperties = {
  background: '#222', border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '6px', padding: '6px 10px',
  fontSize: '13px', color: '#fff', outline: 'none', width: '80px', textAlign: 'right',
};

export default function Pricing() {
  const [activeTab, setActiveTab] = useState('Standard Rates');
  const [rates, setRates] = useState<PricingRate[]>(mockPricingRates);
  const [surcharges, setSurcharges] = useState<PeakSurcharge[]>(mockPeakSurcharges);
  const [editingRate, setEditingRate] = useState<string | null>(null);
  const [editingSurcharge, setEditingSurcharge] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const updateRate = (id: string, field: 'sClass' | 'vClass', value: number) => {
    setRates(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const updateSurcharge = (id: string, field: keyof PeakSurcharge, value: string | number) => {
    setSurcharges(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
  };

  return (
    <Layout>
      <Header title="Pricing" subtitle="Manage rates, surcharges and zones" />

      {/* Tabs + Save */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '0' }}>
        <div style={{ display: 'flex', gap: '4px' }}>
          {TABS.map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{ background: 'none', border: 'none', padding: '8px 16px 12px', cursor: 'pointer', fontSize: '13px', fontWeight: activeTab === tab ? 600 : 500, color: activeTab === tab ? '#C9A84C' : '#666', borderBottom: `2px solid ${activeTab === tab ? '#C9A84C' : 'transparent'}`, marginBottom: '-1px', transition: 'all 0.15s' }}>
              {tab}
            </button>
          ))}
        </div>
        <button
          onClick={handleSave}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', background: saved ? 'rgba(34,197,94,0.15)' : '#C9A84C', border: saved ? '1px solid rgba(34,197,94,0.3)' : 'none', borderRadius: '8px', padding: '8px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: saved ? '#22c55e' : '#0f0f0f', marginBottom: '12px', transition: 'all 0.2s' }}
        >
          {saved ? <><Check size={14} /> Saved!</> : <><Save size={14} /> Save Changes</>}
        </button>
      </div>

      {activeTab === 'Standard Rates' && (
        <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>Base Rates</div>
            <div style={{ fontSize: '12px', color: '#666', marginTop: '2px' }}>All prices in GBP (£). Click rate to edit.</div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Service', 'Description', 'Mercedes S-Class', 'Mercedes V-Class', ''].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rates.map(r => (
                <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }} onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ padding: '14px 16px', fontSize: '13px', fontWeight: 500, color: '#fff' }}>{r.name}</td>
                  <td style={{ padding: '14px 16px', fontSize: '12px', color: '#666' }}>{r.description || '—'}</td>
                  <td style={{ padding: '14px 16px' }}>
                    {editingRate === r.id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ fontSize: '13px', color: '#888' }}>£</span>
                        <input
                          type="number"
                          value={r.sClass}
                          onChange={e => updateRate(r.id, 'sClass', parseFloat(e.target.value))}
                          style={{ ...INPUT }}
                          onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.5)')}
                          onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')}
                          autoFocus
                        />
                      </div>
                    ) : (
                      <span style={{ fontSize: '14px', fontWeight: 700, color: '#fff' }}>£{r.sClass}</span>
                    )}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    {editingRate === r.id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ fontSize: '13px', color: '#888' }}>£</span>
                        <input
                          type="number"
                          value={r.vClass}
                          onChange={e => updateRate(r.id, 'vClass', parseFloat(e.target.value))}
                          style={{ ...INPUT }}
                          onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.5)')}
                          onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')}
                        />
                      </div>
                    ) : (
                      <span style={{ fontSize: '14px', fontWeight: 700, color: '#fff' }}>£{r.vClass}</span>
                    )}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <button
                      onClick={() => setEditingRate(editingRate === r.id ? null : r.id)}
                      style={{ background: editingRate === r.id ? 'rgba(34,197,94,0.1)' : 'rgba(201,168,76,0.1)', border: `1px solid ${editingRate === r.id ? 'rgba(34,197,94,0.2)' : 'rgba(201,168,76,0.2)'}`, borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px', color: editingRate === r.id ? '#22c55e' : '#C9A84C', display: 'flex', alignItems: 'center', gap: '4px' }}
                    >
                      {editingRate === r.id ? <><Check size={12} /> Done</> : <><Edit size={12} /> Edit</>}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ padding: '16px 20px', borderTop: '1px solid rgba(255,255,255,0.04)', background: 'rgba(201,168,76,0.03)' }}>
            <div style={{ fontSize: '12px', color: '#666' }}>
              * All rates exclude peak surcharges. VAT applicable at 20%.
            </div>
          </div>
        </div>
      )}

      {activeTab === 'Peak Surcharges' && (
        <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>Peak Time Surcharges</div>
            <div style={{ fontSize: '12px', color: '#666', marginTop: '2px' }}>Applied on top of base rates during busy periods.</div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Period', 'Days', 'Start Time', 'End Time', 'Surcharge %', ''].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {surcharges.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }} onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <td style={{ padding: '14px 16px', fontSize: '13px', fontWeight: 500, color: '#fff' }}>{s.name}</td>
                  <td style={{ padding: '14px 16px', fontSize: '12px', color: '#888' }}>{s.days}</td>
                  <td style={{ padding: '14px 16px', fontSize: '13px', color: '#ccc' }}>{s.startTime}</td>
                  <td style={{ padding: '14px 16px', fontSize: '13px', color: '#ccc' }}>{s.endTime}</td>
                  <td style={{ padding: '14px 16px' }}>
                    {editingSurcharge === s.id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <input
                          type="number"
                          value={s.percentage}
                          onChange={e => updateSurcharge(s.id, 'percentage', parseFloat(e.target.value))}
                          style={{ ...INPUT, width: '60px' }}
                          onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.5)')}
                          onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')}
                          autoFocus
                        />
                        <span style={{ fontSize: '13px', color: '#888' }}>%</span>
                      </div>
                    ) : (
                      <span style={{
                        background: s.percentage >= 40 ? 'rgba(239,68,68,0.1)' : s.percentage >= 25 ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)',
                        color: s.percentage >= 40 ? '#ef4444' : s.percentage >= 25 ? '#f59e0b' : '#22c55e',
                        borderRadius: '6px', padding: '3px 8px', fontSize: '13px', fontWeight: 700,
                      }}>+{s.percentage}%</span>
                    )}
                  </td>
                  <td style={{ padding: '14px 16px' }}>
                    <button
                      onClick={() => setEditingSurcharge(editingSurcharge === s.id ? null : s.id)}
                      style={{ background: editingSurcharge === s.id ? 'rgba(34,197,94,0.1)' : 'rgba(201,168,76,0.1)', border: `1px solid ${editingSurcharge === s.id ? 'rgba(34,197,94,0.2)' : 'rgba(201,168,76,0.2)'}`, borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px', color: editingSurcharge === s.id ? '#22c55e' : '#C9A84C', display: 'flex', alignItems: 'center', gap: '4px' }}
                    >
                      {editingSurcharge === s.id ? <><Check size={12} /> Done</> : <><Edit size={12} /> Edit</>}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'Zones' && (
        <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '40px', textAlign: 'center' }}>
          <div style={{ fontSize: '40px', marginBottom: '16px' }}>🗺</div>
          <div style={{ fontSize: '16px', fontWeight: 600, color: '#fff', marginBottom: '8px' }}>Zone Mapping</div>
          <div style={{ fontSize: '13px', color: '#666' }}>Interactive zone pricing map coming soon. Contact your account manager to configure custom zones.</div>
        </div>
      )}
    </Layout>
  );
}

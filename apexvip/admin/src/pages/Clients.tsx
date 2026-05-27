import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Filter, ChevronUp, ChevronDown } from 'lucide-react';
import { format } from 'date-fns';
import Layout from '../components/Layout';
import Header from '../components/Header';
import StatusBadge from '../components/StatusBadge';
import Avatar from '../components/Avatar';
import { mockClients } from '../data/mockData';
import type { Client, ClientTier } from '../types';

const INPUT_STYLE: React.CSSProperties = {
  background: '#222',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: '8px',
  padding: '9px 14px',
  fontSize: '13px', color: '#fff',
  outline: 'none', width: '100%', boxSizing: 'border-box',
};

type SortKey = keyof Client;

export default function Clients() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<ClientTier | 'all'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('totalSpent');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const SortIcon = ({ col }: { col: SortKey }) => (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '1px', verticalAlign: 'middle', marginLeft: '4px' }}>
      <ChevronUp size={8} style={{ opacity: sortKey === col && sortDir === 'asc' ? 1 : 0.3 }} />
      <ChevronDown size={8} style={{ opacity: sortKey === col && sortDir === 'desc' ? 1 : 0.3 }} />
    </span>
  );

  const filtered = mockClients
    .filter(c => {
      if (tierFilter !== 'all' && c.tier !== tierFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q) || c.phone.includes(q);
      }
      return true;
    })
    .sort((a, b) => {
      const av = a[sortKey]; const bv = b[sortKey];
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''));
      return sortDir === 'asc' ? cmp : -cmp;
    });

  const stats = {
    total: mockClients.length,
    vvip: mockClients.filter(c => c.tier === 'VVIP').length,
    vip: mockClients.filter(c => c.tier === 'VIP').length,
    totalSpend: mockClients.reduce((sum, c) => sum + c.totalSpent, 0),
  };

  return (
    <Layout>
      <Header title="Clients" subtitle="Manage your client portfolio" />

      {/* Stats */}
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        {[
          { label: 'Total Clients', value: stats.total, color: '#C9A84C' },
          { label: 'VVIP Clients', value: stats.vvip, color: '#C9A84C' },
          { label: 'VIP Clients', value: stats.vip, color: '#3b82f6' },
          { label: 'Total Revenue', value: `£${stats.totalSpend.toLocaleString()}`, color: '#22c55e' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '16px 20px', flex: 1, minWidth: '140px' }}>
            <div style={{ fontSize: '11px', color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>{label}</div>
            <div style={{ fontSize: '22px', fontWeight: 700, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Table container */}
      <div style={{ background: '#1c1c1c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', overflow: 'hidden' }}>
        {/* Filters */}
        <div style={{ display: 'flex', gap: '12px', padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
            <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients..." style={{ ...INPUT_STYLE, paddingLeft: '36px' }} onFocus={e => (e.target.style.borderColor = 'rgba(201,168,76,0.4)')} onBlur={e => (e.target.style.borderColor = 'rgba(255,255,255,0.08)')} />
          </div>
          <div style={{ position: 'relative' }}>
            <Filter size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#555' }} />
            <select value={tierFilter} onChange={e => setTierFilter(e.target.value as ClientTier | 'all')} style={{ ...INPUT_STYLE, paddingLeft: '36px', width: '150px', cursor: 'pointer' }}>
              <option value="all">All Tiers</option>
              <option value="VVIP">VVIP</option>
              <option value="VIP">VIP</option>
              <option value="Standard">Standard</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[
                  { key: 'name', label: 'Client' },
                  { key: 'email', label: 'Contact' },
                  { key: 'totalBookings', label: 'Bookings', sortable: true },
                  { key: 'totalSpent', label: 'Total Spent', sortable: true },
                  { key: 'joinedDate', label: 'Joined', sortable: true },
                  { key: 'tier', label: 'Tier', sortable: true },
                  { key: 'actions', label: '' },
                ].map(({ key, label, sortable }) => (
                  <th
                    key={key}
                    onClick={() => sortable && handleSort(key as SortKey)}
                    style={{ padding: '10px 16px', textAlign: 'left', fontSize: '11px', fontWeight: 600, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid rgba(255,255,255,0.06)', cursor: sortable ? 'pointer' : 'default', userSelect: 'none', whiteSpace: 'nowrap' }}
                  >
                    {label}{sortable && <SortIcon col={key as SortKey} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: '48px', textAlign: 'center', color: '#555' }}>No clients found</td></tr>
              ) : filtered.map(c => (
                <tr
                  key={c.id}
                  onClick={() => navigate(`/clients/${c.id}`)}
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', transition: 'background 0.1s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <Avatar name={c.name} size={34} />
                      <div>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>{c.name}</div>
                        <div style={{ fontSize: '11px', color: '#555' }}>{c.id}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ fontSize: '12px', color: '#ccc' }}>{c.email}</div>
                    <div style={{ fontSize: '11px', color: '#555' }}>{c.phone}</div>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: '13px', color: '#ccc', fontWeight: 500 }}>{c.totalBookings}</td>
                  <td style={{ padding: '12px 16px', fontSize: '13px', color: '#fff', fontWeight: 700 }}>£{c.totalSpent.toLocaleString()}</td>
                  <td style={{ padding: '12px 16px', fontSize: '12px', color: '#888', whiteSpace: 'nowrap' }}>{format(new Date(c.joinedDate), 'd MMM yyyy')}</td>
                  <td style={{ padding: '12px 16px' }}><StatusBadge status={c.tier} /></td>
                  <td style={{ padding: '12px 16px' }}>
                    <button onClick={e => { e.stopPropagation(); navigate(`/clients/${c.id}`); }} style={{ background: 'rgba(201,168,76,0.1)', border: 'none', borderRadius: '6px', padding: '5px 12px', cursor: 'pointer', color: '#C9A84C', fontSize: '12px', fontWeight: 500 }}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: '12px', color: '#555' }}>
          Showing {filtered.length} of {mockClients.length} clients
        </div>
      </div>
    </Layout>
  );
}

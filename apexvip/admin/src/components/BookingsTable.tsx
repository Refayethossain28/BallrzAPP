import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { Eye, Edit, XCircle, MapPin } from 'lucide-react';
import type { Booking } from '../types';
import StatusBadge from './StatusBadge';

interface Props {
  bookings: Booking[];
  onEdit?: (b: Booking) => void;
  onCancel?: (b: Booking) => void;
}

export default function BookingsTable({ bookings, onEdit, onCancel }: Props) {
  const navigate = useNavigate();

  if (bookings.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: '#555', fontSize: '14px' }}>
        No bookings found.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['ID', 'Client', 'Route', 'Date & Time', 'Vehicle', 'Driver', 'Status', 'Price', 'Actions'].map(h => (
              <th key={h} style={{
                padding: '10px 16px',
                textAlign: 'left',
                fontSize: '11px',
                fontWeight: 600,
                color: '#666',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bookings.map((b) => (
            <tr
              key={b.id}
              style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer', transition: 'background 0.1s' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => navigate(`/bookings/${b.id}`)}
            >
              <td style={{ padding: '12px 16px', fontSize: '12px', color: '#C9A84C', fontWeight: 600, whiteSpace: 'nowrap' }}>{b.id}</td>
              <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: '13px', color: '#fff', fontWeight: 500 }}>{b.clientName}</div>
                <div style={{ fontSize: '11px', color: '#666' }}>{b.clientPhone}</div>
              </td>
              <td style={{ padding: '12px 16px', maxWidth: '200px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                  <MapPin size={12} style={{ color: '#C9A84C', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontSize: '12px', color: '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>{b.pickup}</div>
                    <div style={{ fontSize: '11px', color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>→ {b.dropoff}</div>
                  </div>
                </div>
              </td>
              <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: '13px', color: '#ccc' }}>{format(new Date(b.dateTime), 'd MMM yyyy')}</div>
                <div style={{ fontSize: '11px', color: '#666' }}>{format(new Date(b.dateTime), 'HH:mm')}</div>
              </td>
              <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                <div style={{ fontSize: '12px', color: '#ccc' }}>{b.vehicleClass ?? '—'}</div>
                <div style={{ fontSize: '11px', color: '#666' }}>{b.vehicleReg ?? '—'}</div>
              </td>
              <td style={{ padding: '12px 16px', fontSize: '13px', color: '#ccc', whiteSpace: 'nowrap' }}>
                {b.driverName ?? <span style={{ color: '#555' }}>Unassigned</span>}
              </td>
              <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>
                <StatusBadge status={b.status} />
              </td>
              <td style={{ padding: '12px 16px', fontSize: '13px', color: '#fff', fontWeight: 600, whiteSpace: 'nowrap' }}>
                £{b.price.toFixed(2)}
              </td>
              <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    title="View"
                    onClick={() => navigate(`/bookings/${b.id}`)}
                    style={{ background: 'rgba(59,130,246,0.1)', border: 'none', borderRadius: '6px', padding: '5px 7px', cursor: 'pointer', color: '#3b82f6', display: 'flex', alignItems: 'center' }}
                  ><Eye size={13} /></button>
                  {onEdit && (
                    <button
                      title="Edit"
                      onClick={() => onEdit(b)}
                      style={{ background: 'rgba(201,168,76,0.1)', border: 'none', borderRadius: '6px', padding: '5px 7px', cursor: 'pointer', color: '#C9A84C', display: 'flex', alignItems: 'center' }}
                    ><Edit size={13} /></button>
                  )}
                  {onCancel && b.status !== 'cancelled' && b.status !== 'completed' && (
                    <button
                      title="Cancel"
                      onClick={() => onCancel(b)}
                      style={{ background: 'rgba(239,68,68,0.1)', border: 'none', borderRadius: '6px', padding: '5px 7px', cursor: 'pointer', color: '#ef4444', display: 'flex', alignItems: 'center' }}
                    ><XCircle size={13} /></button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

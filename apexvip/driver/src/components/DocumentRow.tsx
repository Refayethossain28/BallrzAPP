import { CheckCircle, Clock, AlertTriangle, XCircle, Upload } from 'lucide-react';
import { format, parseISO, differenceInDays } from 'date-fns';
import type { DriverDocument } from '../types';

interface DocumentRowProps {
  doc: DriverDocument;
}

export default function DocumentRow({ doc }: DocumentRowProps) {
  const daysUntilExpiry = doc.expiryDate
    ? differenceInDays(parseISO(doc.expiryDate), new Date())
    : null;

  const expiryColor =
    daysUntilExpiry === null
      ? '#888888'
      : daysUntilExpiry < 30
      ? '#ef4444'
      : daysUntilExpiry < 60
      ? '#f59e0b'
      : '#22c55e';

  const StatusIcon =
    doc.status === 'verified'
      ? CheckCircle
      : doc.status === 'pending'
      ? Clock
      : doc.status === 'expired'
      ? XCircle
      : AlertTriangle;

  const statusColor =
    doc.status === 'verified'
      ? '#22c55e'
      : doc.status === 'pending'
      ? '#f59e0b'
      : '#ef4444';

  const statusLabel =
    doc.status === 'verified'
      ? 'Verified'
      : doc.status === 'pending'
      ? 'Pending Review'
      : doc.status === 'expired'
      ? 'Expired'
      : 'Missing';

  return (
    <div
      style={{
        background: '#111111',
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,0.07)',
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 8,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <StatusIcon size={15} color={statusColor} />
          <span style={{ fontSize: 14, fontWeight: 600, color: '#ffffff' }}>{doc.name}</span>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <span style={{ fontSize: 11, color: statusColor, fontWeight: 500 }}>{statusLabel}</span>
          {doc.expiryDate && (
            <span style={{ fontSize: 11, color: expiryColor }}>
              Expires {format(parseISO(doc.expiryDate), 'd MMM yyyy')}
              {daysUntilExpiry !== null && daysUntilExpiry < 60 && (
                <span style={{ fontWeight: 700 }}> ({daysUntilExpiry}d)</span>
              )}
            </span>
          )}
        </div>
      </div>
      <button
        style={{
          padding: '8px',
          borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.1)',
          background: 'transparent',
          color: '#888888',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        title="Upload document"
      >
        <Upload size={14} />
      </button>
    </div>
  );
}

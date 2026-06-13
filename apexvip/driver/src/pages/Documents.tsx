import { ChevronLeft, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import DocumentRow from '../components/DocumentRow';
import { mockDocuments } from '../data/mockData';

export default function Documents() {
  const navigate = useNavigate();

  const verified = mockDocuments.filter((d) => d.status === 'verified').length;
  const total = mockDocuments.length;

  return (
    <Layout hideNav>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '16px 16px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <button
          onClick={() => navigate('/profile')}
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
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', margin: 0 }}>Documents</h1>
          <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 600, marginTop: 1 }}>
            {verified}/{total} Verified
          </div>
        </div>
      </div>

      <div style={{ padding: '16px' }}>
        {/* Status banner */}
        <div
          style={{
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.2)',
            borderRadius: 14,
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'rgba(34,197,94,0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <FileText size={16} color="#22c55e" />
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#22c55e' }}>All Documents Clear</div>
            <div style={{ fontSize: 11, color: '#888888', marginTop: 1 }}>
              Your profile is fully compliant
            </div>
          </div>
        </div>

        {/* Document list */}
        <div style={{ fontSize: 11, fontWeight: 700, color: '#444444', letterSpacing: '0.1em', marginBottom: 10 }}>
          REQUIRED DOCUMENTS
        </div>

        {mockDocuments.map((doc) => (
          <DocumentRow key={doc.id} doc={doc} />
        ))}

        {/* Info */}
        <div
          style={{
            background: '#111111',
            borderRadius: 12,
            border: '1px solid rgba(255,255,255,0.06)',
            padding: '12px 14px',
            marginTop: 8,
          }}
        >
          <div style={{ fontSize: 11, color: '#555555', lineHeight: 1.6 }}>
            Documents are reviewed by the ApexVIP compliance team. Upload updates using the button next to each document.
            You will be notified when documents are approved or approaching expiry.
          </div>
        </div>
      </div>
    </Layout>
  );
}

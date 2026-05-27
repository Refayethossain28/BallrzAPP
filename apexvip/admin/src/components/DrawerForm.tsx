import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}

export default function DrawerForm({ open, onClose, title, children, width = 480, footer }: Props) {
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  return (
    <>
      {open && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 900,
            background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
          }}
          onClick={onClose}
        />
      )}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 901,
        width, maxWidth: '95vw',
        background: '#161616',
        borderLeft: '1px solid rgba(255,255,255,0.08)',
        display: 'flex', flexDirection: 'column',
        transform: open ? 'translateX(0)' : `translateX(${width}px)`,
        transition: 'transform 0.3s cubic-bezier(0.4,0,0.2,1)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '20px 24px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
        }}>
          <h2 style={{ margin: 0, fontSize: '17px', fontWeight: 600, color: '#fff' }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '8px', color: '#888', cursor: 'pointer',
              padding: '6px', display: 'flex', alignItems: 'center',
            }}
          >
            <X size={16} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '24px', flex: 1 }}>
          {children}
        </div>
        {footer && (
          <div style={{
            padding: '16px 24px',
            borderTop: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}>
            {footer}
          </div>
        )}
      </div>
    </>
  );
}

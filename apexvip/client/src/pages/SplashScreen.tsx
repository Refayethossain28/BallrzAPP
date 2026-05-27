import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function SplashScreen() {
  const navigate = useNavigate();

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0a0a0a',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '60px 32px 48px',
        maxWidth: 480,
        margin: '0 auto',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background accent */}
      <div style={{
        position: 'absolute',
        top: -120,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 400,
        height: 400,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(201,168,76,0.06) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      {/* Top spacer */}
      <div />

      {/* Center logo block */}
      <div style={{ textAlign: 'center', flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        {/* Crown / monogram icon */}
        <div style={{
          width: 88,
          height: 88,
          borderRadius: 24,
          border: '1.5px solid rgba(201,168,76,0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 28,
          background: 'rgba(201,168,76,0.05)',
          position: 'relative',
        }}>
          {/* Inner diamond */}
          <div style={{
            width: 36,
            height: 36,
            border: '1.5px solid #C9A84C',
            transform: 'rotate(45deg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <div style={{
              width: 10,
              height: 10,
              background: '#C9A84C',
              transform: 'rotate(0deg)',
            }} />
          </div>
        </div>

        <div style={{
          fontSize: 38,
          fontWeight: 800,
          letterSpacing: '0.22em',
          color: '#C9A84C',
          marginBottom: 10,
          textTransform: 'uppercase',
          fontStyle: 'normal',
          lineHeight: 1,
        }}>
          APEX VIP
        </div>

        <div style={{
          width: 60,
          height: 1,
          background: 'linear-gradient(90deg, transparent, #C9A84C, transparent)',
          margin: '14px auto',
        }} />

        <div style={{
          fontSize: 13,
          color: '#888888',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          fontWeight: 400,
        }}>
          Premium Chauffeur &amp; Concierge
        </div>
      </div>

      {/* Bottom CTA */}
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <button
          onClick={() => navigate('/register')}
          style={{
            width: '100%',
            padding: '17px',
            background: '#C9A84C',
            color: '#0a0a0a',
            border: 'none',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
        >
          Get Started
        </button>

        <button
          onClick={() => navigate('/login')}
          style={{
            width: '100%',
            padding: '16px',
            background: 'transparent',
            color: '#C9A84C',
            border: '1px solid rgba(201,168,76,0.3)',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s',
            letterSpacing: '0.04em',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = '#C9A84C';
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(201,168,76,0.05)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(201,168,76,0.3)';
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          Sign In
        </button>

        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <span style={{ fontSize: 11, color: '#444444', letterSpacing: '0.03em' }}>
            Available 24/7 across Greater London
          </span>
        </div>
      </div>
    </div>
  );
}

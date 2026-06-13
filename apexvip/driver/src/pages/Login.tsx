import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const [email, setEmail] = useState('driver@apexvip.com');
  const [password, setPassword] = useState('driver123');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const ok = await login(email.trim(), password);
    setLoading(false);
    if (ok) {
      navigate('/home', { replace: true });
    } else {
      setError('Invalid email or password. Please try again.');
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0a0a0a',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 24px 48px',
        maxWidth: 480,
        margin: '0 auto',
      }}
    >
      {/* Logo / Header */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: 20,
            background: 'linear-gradient(135deg, #C9A84C, #a07a2e)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 20px',
            boxShadow: '0 8px 32px rgba(201,168,76,0.3)',
          }}
        >
          <span style={{ fontSize: 32, fontWeight: 900, color: '#0a0a0a', letterSpacing: '-1px' }}>A</span>
        </div>
        <div style={{ fontSize: 26, fontWeight: 800, color: '#ffffff', letterSpacing: '-0.5px' }}>
          ApexVIP
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.3em',
            color: '#C9A84C',
            textTransform: 'uppercase',
            marginTop: 2,
          }}
        >
          Driver Portal
        </div>
      </div>

      {/* Form card */}
      <div
        style={{
          width: '100%',
          background: '#111111',
          borderRadius: 20,
          border: '1px solid rgba(255,255,255,0.08)',
          padding: '28px 24px 24px',
        }}
      >
        <h2
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: '#ffffff',
            marginBottom: 4,
            marginTop: 0,
          }}
        >
          Driver Sign In
        </h2>
        <p style={{ fontSize: 13, color: '#666666', marginBottom: 24, marginTop: 0 }}>
          Sign in to your driver account
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Email */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#888888', display: 'block', marginBottom: 8 }}>
              EMAIL ADDRESS
            </label>
            <div style={{ position: 'relative' }}>
              <Mail
                size={16}
                color="#555555"
                style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="driver@apexvip.com"
                required
                style={{
                  width: '100%',
                  background: '#1a1a1a',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 12,
                  padding: '13px 14px 13px 42px',
                  fontSize: 14,
                  color: '#ffffff',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#888888', display: 'block', marginBottom: 8 }}>
              PASSWORD
            </label>
            <div style={{ position: 'relative' }}>
              <Lock
                size={16}
                color="#555555"
                style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)' }}
              />
              <input
                type={showPass ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                style={{
                  width: '100%',
                  background: '#1a1a1a',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 12,
                  padding: '13px 44px 13px 42px',
                  fontSize: 14,
                  color: '#ffffff',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <button
                type="button"
                onClick={() => setShowPass(!showPass)}
                style={{
                  position: 'absolute',
                  right: 14,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                }}
              >
                {showPass ? <EyeOff size={16} color="#555555" /> : <Eye size={16} color="#555555" />}
              </button>
            </div>
          </div>

          {error && (
            <div
              style={{
                background: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 10,
                padding: '10px 14px',
                fontSize: 13,
                color: '#ef4444',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '15px',
              borderRadius: 14,
              border: 'none',
              background: loading
                ? 'rgba(201,168,76,0.4)'
                : 'linear-gradient(135deg, #C9A84C, #a07a2e)',
              color: '#0a0a0a',
              fontSize: 15,
              fontWeight: 800,
              cursor: loading ? 'not-allowed' : 'pointer',
              letterSpacing: '0.08em',
              marginTop: 6,
              boxShadow: loading ? 'none' : '0 4px 20px rgba(201,168,76,0.25)',
              transition: 'all 0.2s',
            }}
          >
            {loading ? 'SIGNING IN...' : 'DRIVER SIGN IN'}
          </button>
        </form>
      </div>

      {/* Support link */}
      <div style={{ marginTop: 24, textAlign: 'center' }}>
        <span style={{ fontSize: 13, color: '#555555' }}>Having trouble signing in? </span>
        <a
          href="mailto:support@apexvip.com"
          style={{ fontSize: 13, color: '#C9A84C', textDecoration: 'none', fontWeight: 600 }}
        >
          Contact Support
        </a>
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: '#333333' }}>
        ApexVIP Driver v2.4.1
      </div>
    </div>
  );
}

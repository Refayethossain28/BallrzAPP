import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, ArrowLeft } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import LoadingSpinner from '../components/LoadingSpinner';

const inputBase: React.CSSProperties = {
  width: '100%',
  background: '#111111',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12,
  padding: '14px 16px 14px 46px',
  color: '#ffffff',
  fontSize: 15,
  outline: 'none',
  transition: 'border-color 0.2s',
  boxSizing: 'border-box',
};

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [focusField, setFocusField] = useState<'email' | 'password' | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { setError('Please enter your email and password.'); return; }
    setError('');
    setLoading(true);
    const result = await login(email, password);
    setLoading(false);
    if (result.success) {
      navigate('/home');
    } else {
      setError(result.error || 'Login failed. Please try again.');
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a0a',
      maxWidth: 480,
      margin: '0 auto',
      padding: '0 24px',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ paddingTop: 56, paddingBottom: 40 }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            color: '#888888', marginBottom: 36, padding: 0,
          }}
        >
          <ArrowLeft size={18} />
          <span style={{ fontSize: 13 }}>Back</span>
        </button>

        <div style={{ fontSize: 28, fontWeight: 700, color: '#ffffff', marginBottom: 6 }}>
          Welcome back
        </div>
        <div style={{ fontSize: 14, color: '#888888' }}>
          Sign in to your ApexVIP account
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Email */}
        <div style={{ position: 'relative' }}>
          <div style={{
            position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
            pointerEvents: 'none', zIndex: 1,
          }}>
            <Mail size={18} color={focusField === 'email' ? '#C9A84C' : '#555555'} />
          </div>
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onFocus={() => setFocusField('email')}
            onBlur={() => setFocusField(null)}
            style={{
              ...inputBase,
              borderColor: focusField === 'email' ? 'rgba(201,168,76,0.6)' : 'rgba(255,255,255,0.1)',
            }}
          />
        </div>

        {/* Password */}
        <div style={{ position: 'relative' }}>
          <div style={{
            position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
            pointerEvents: 'none', zIndex: 1,
          }}>
            <Lock size={18} color={focusField === 'password' ? '#C9A84C' : '#555555'} />
          </div>
          <input
            type={showPw ? 'text' : 'password'}
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onFocus={() => setFocusField('password')}
            onBlur={() => setFocusField(null)}
            style={{
              ...inputBase,
              paddingRight: 48,
              borderColor: focusField === 'password' ? 'rgba(201,168,76,0.6)' : 'rgba(255,255,255,0.1)',
            }}
          />
          <button
            type="button"
            onClick={() => setShowPw(v => !v)}
            style={{
              position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}
          >
            {showPw
              ? <EyeOff size={18} color="#555555" />
              : <Eye size={18} color="#555555" />
            }
          </button>
        </div>

        {/* Forgot */}
        <div style={{ textAlign: 'right', marginTop: -4 }}>
          <span style={{ fontSize: 13, color: '#C9A84C', cursor: 'pointer' }}>
            Forgot password?
          </span>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            borderRadius: 10,
            padding: '12px 14px',
            fontSize: 13,
            color: '#ef4444',
            lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '17px',
            background: loading ? 'rgba(201,168,76,0.5)' : '#C9A84C',
            color: '#0a0a0a',
            border: 'none',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: loading ? 'not-allowed' : 'pointer',
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          {loading && <LoadingSpinner size="sm" color="#0a0a0a" />}
          {loading ? 'Signing In...' : 'Sign In'}
        </button>
      </form>

      {/* Register link */}
      <div style={{ textAlign: 'center', marginTop: 28, fontSize: 14 }}>
        <span style={{ color: '#888888' }}>Don't have an account? </span>
        <Link to="/register" style={{ color: '#C9A84C', textDecoration: 'none', fontWeight: 600 }}>
          Create account
        </Link>
      </div>

      {/* Demo hint */}
      <div style={{
        marginTop: 'auto',
        paddingBottom: 40,
        paddingTop: 32,
        textAlign: 'center',
      }}>
        <div style={{
          display: 'inline-block',
          background: 'rgba(201,168,76,0.07)',
          border: '1px solid rgba(201,168,76,0.15)',
          borderRadius: 10,
          padding: '10px 16px',
        }}>
          <div style={{ fontSize: 11, color: '#888888', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            Demo credentials
          </div>
          <div style={{ fontSize: 12, color: '#C9A84C' }}>client@apexvip.com / password</div>
        </div>
      </div>
    </div>
  );
}

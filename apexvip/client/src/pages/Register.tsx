import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { User, Mail, Phone, Lock, Eye, EyeOff, ArrowLeft, Check } from 'lucide-react';
import LoadingSpinner from '../components/LoadingSpinner';

const inputStyle = (focused: boolean): React.CSSProperties => ({
  width: '100%',
  background: '#111111',
  border: `1px solid ${focused ? 'rgba(201,168,76,0.6)' : 'rgba(255,255,255,0.1)'}`,
  borderRadius: 12,
  padding: '14px 16px 14px 46px',
  color: '#ffffff',
  fontSize: 15,
  outline: 'none',
  transition: 'border-color 0.2s',
  boxSizing: 'border-box' as const,
});

export default function Register() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const [fields, setFields] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    password: '',
    confirm: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (k: string, v: string) => setFields(f => ({ ...f, [k]: v }));

  const validateStep1 = () => {
    const e: Record<string, string> = {};
    if (!fields.firstName.trim()) e.firstName = 'First name is required';
    if (!fields.lastName.trim()) e.lastName = 'Last name is required';
    if (!fields.email.trim() || !/\S+@\S+\.\S+/.test(fields.email)) e.email = 'Valid email required';
    if (!fields.phone.trim()) e.phone = 'Phone number is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const validateStep2 = () => {
    const e: Record<string, string> = {};
    if (fields.password.length < 8) e.password = 'Password must be at least 8 characters';
    if (fields.password !== fields.confirm) e.confirm = 'Passwords do not match';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleStep1 = (e: React.FormEvent) => {
    e.preventDefault();
    if (validateStep1()) setStep(2);
  };

  const handleStep2 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateStep2()) return;
    setLoading(true);
    await new Promise(r => setTimeout(r, 1200));
    setLoading(false);
    setStep(3);
  };

  const iconStyle = (field: string): React.CSSProperties => ({
    position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
    pointerEvents: 'none', zIndex: 1,
  });

  if (step === 3) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#0a0a0a',
        maxWidth: 480,
        margin: '0 auto',
        padding: '0 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
      }}>
        <div style={{
          width: 88,
          height: 88,
          borderRadius: '50%',
          background: 'rgba(201,168,76,0.1)',
          border: '2px solid #C9A84C',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
        }}>
          <Check size={40} color="#C9A84C" strokeWidth={2.5} />
        </div>

        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: '#ffffff', marginBottom: 8 }}>
            Account Created
          </div>
          <div style={{ fontSize: 14, color: '#888888', lineHeight: 1.6 }}>
            Welcome to ApexVIP,{' '}
            <span style={{ color: '#C9A84C' }}>{fields.firstName}</span>.
            <br />Your account is ready to use.
          </div>
        </div>

        <button
          onClick={() => navigate('/login')}
          style={{
            width: '100%',
            padding: '17px',
            background: '#C9A84C',
            color: '#0a0a0a',
            border: 'none',
            borderRadius: 14,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Sign In Now
        </button>
      </div>
    );
  }

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
      <div style={{ paddingTop: 56, paddingBottom: 32 }}>
        <button
          onClick={() => step === 1 ? navigate('/') : setStep(1)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            color: '#888888', marginBottom: 32, padding: 0,
          }}
        >
          <ArrowLeft size={18} />
          <span style={{ fontSize: 13 }}>Back</span>
        </button>

        {/* Step indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 28 }}>
          {[1, 2].map(n => (
            <React.Fragment key={n}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: step >= n ? '#C9A84C' : 'rgba(255,255,255,0.08)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 700,
                color: step >= n ? '#0a0a0a' : '#555555',
                transition: 'all 0.3s',
              }}>
                {step > n ? <Check size={14} color="#0a0a0a" /> : n}
              </div>
              {n < 2 && (
                <div style={{
                  height: 1, width: 40,
                  background: step > n ? '#C9A84C' : 'rgba(255,255,255,0.08)',
                  transition: 'background 0.3s',
                }} />
              )}
            </React.Fragment>
          ))}
        </div>

        <div style={{ fontSize: 26, fontWeight: 700, color: '#ffffff', marginBottom: 6 }}>
          {step === 1 ? 'Create account' : 'Set password'}
        </div>
        <div style={{ fontSize: 14, color: '#888888' }}>
          {step === 1 ? 'Tell us a bit about yourself' : 'Choose a secure password'}
        </div>
      </div>

      {/* Step 1 */}
      {step === 1 && (
        <form onSubmit={handleStep1} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            {/* First name */}
            <div style={{ position: 'relative', flex: 1 }}>
              <div style={iconStyle('firstName')}>
                <User size={17} color={focus === 'firstName' ? '#C9A84C' : '#555555'} />
              </div>
              <input
                placeholder="First name"
                value={fields.firstName}
                onChange={e => set('firstName', e.target.value)}
                onFocus={() => setFocus('firstName')}
                onBlur={() => setFocus(null)}
                style={inputStyle(focus === 'firstName')}
              />
              {errors.firstName && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>{errors.firstName}</div>}
            </div>
            {/* Last name */}
            <div style={{ position: 'relative', flex: 1 }}>
              <div style={iconStyle('lastName')}>
                <User size={17} color={focus === 'lastName' ? '#C9A84C' : '#555555'} />
              </div>
              <input
                placeholder="Last name"
                value={fields.lastName}
                onChange={e => set('lastName', e.target.value)}
                onFocus={() => setFocus('lastName')}
                onBlur={() => setFocus(null)}
                style={inputStyle(focus === 'lastName')}
              />
              {errors.lastName && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>{errors.lastName}</div>}
            </div>
          </div>

          {/* Email */}
          <div style={{ position: 'relative' }}>
            <div style={iconStyle('email')}>
              <Mail size={18} color={focus === 'email' ? '#C9A84C' : '#555555'} />
            </div>
            <input
              type="email"
              placeholder="Email address"
              value={fields.email}
              onChange={e => set('email', e.target.value)}
              onFocus={() => setFocus('email')}
              onBlur={() => setFocus(null)}
              style={inputStyle(focus === 'email')}
            />
            {errors.email && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>{errors.email}</div>}
          </div>

          {/* Phone */}
          <div style={{ position: 'relative' }}>
            <div style={iconStyle('phone')}>
              <Phone size={18} color={focus === 'phone' ? '#C9A84C' : '#555555'} />
            </div>
            <input
              type="tel"
              placeholder="Phone number"
              value={fields.phone}
              onChange={e => set('phone', e.target.value)}
              onFocus={() => setFocus('phone')}
              onBlur={() => setFocus(null)}
              style={inputStyle(focus === 'phone')}
            />
            {errors.phone && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>{errors.phone}</div>}
          </div>

          <button
            type="submit"
            style={{
              width: '100%',
              padding: '17px',
              background: '#C9A84C',
              color: '#0a0a0a',
              border: 'none',
              borderRadius: 14,
              fontSize: 15,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              marginTop: 8,
            }}
          >
            Continue
          </button>

          <div style={{ textAlign: 'center', marginTop: 6, fontSize: 14 }}>
            <span style={{ color: '#888888' }}>Already have an account? </span>
            <Link to="/login" style={{ color: '#C9A84C', textDecoration: 'none', fontWeight: 600 }}>
              Sign in
            </Link>
          </div>
        </form>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <form onSubmit={handleStep2} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Password */}
          <div style={{ position: 'relative' }}>
            <div style={iconStyle('password')}>
              <Lock size={18} color={focus === 'password' ? '#C9A84C' : '#555555'} />
            </div>
            <input
              type={showPw ? 'text' : 'password'}
              placeholder="Password (min. 8 characters)"
              value={fields.password}
              onChange={e => set('password', e.target.value)}
              onFocus={() => setFocus('password')}
              onBlur={() => setFocus(null)}
              style={{ ...inputStyle(focus === 'password'), paddingRight: 48 }}
            />
            <button
              type="button"
              onClick={() => setShowPw(v => !v)}
              style={{
                position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              {showPw ? <EyeOff size={18} color="#555555" /> : <Eye size={18} color="#555555" />}
            </button>
            {errors.password && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>{errors.password}</div>}
          </div>

          {/* Confirm */}
          <div style={{ position: 'relative' }}>
            <div style={iconStyle('confirm')}>
              <Lock size={18} color={focus === 'confirm' ? '#C9A84C' : '#555555'} />
            </div>
            <input
              type={showConfirm ? 'text' : 'password'}
              placeholder="Confirm password"
              value={fields.confirm}
              onChange={e => set('confirm', e.target.value)}
              onFocus={() => setFocus('confirm')}
              onBlur={() => setFocus(null)}
              style={{ ...inputStyle(focus === 'confirm'), paddingRight: 48 }}
            />
            <button
              type="button"
              onClick={() => setShowConfirm(v => !v)}
              style={{
                position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              {showConfirm ? <EyeOff size={18} color="#555555" /> : <Eye size={18} color="#555555" />}
            </button>
            {errors.confirm && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>{errors.confirm}</div>}
          </div>

          {/* Password strength hints */}
          <div style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 10,
            padding: '12px 14px',
          }}>
            {[
              { label: 'At least 8 characters', met: fields.password.length >= 8 },
              { label: 'Contains a number', met: /\d/.test(fields.password) },
              { label: 'Passwords match', met: fields.password.length > 0 && fields.password === fields.confirm },
            ].map(({ label, met }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{
                  width: 16, height: 16, borderRadius: '50%',
                  background: met ? 'rgba(201,168,76,0.15)' : 'rgba(255,255,255,0.05)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {met && <Check size={10} color="#C9A84C" strokeWidth={3} />}
                </div>
                <span style={{ fontSize: 12, color: met ? '#C9A84C' : '#555555' }}>{label}</span>
              </div>
            ))}
          </div>

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
            {loading ? 'Creating Account...' : 'Create Account'}
          </button>
        </form>
      )}
    </div>
  );
}

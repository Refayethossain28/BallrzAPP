import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthProvider';

/** Auth form. `embedded` drops the page chrome (logo/tagline/full-height
 *  wrapper) so the landing page can inline it as a section. */
export default function SignIn({ embedded = false }: { embedded?: boolean }) {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'up') await signUp(name.trim(), email.trim(), password);
      else await signIn(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={embedded ? undefined : 'centerpage'}>
      {!embedded && (
        <>
          <div className="logo" style={{ fontSize: 24, marginBottom: 6 }}>
            <span className="mk">⌂</span> <b>Apex</b>
          </div>
          <p className="sub">UK lettings — advertise, find, message, sign.</p>
        </>
      )}

      <form onSubmit={submit}>
        {mode === 'up' && (
          <div className="field">
            <label htmlFor="auth-name">Full name</label>
            <input id="auth-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Tom Baxter" />
          </div>
        )}
        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.co.uk" />
        </div>
        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} placeholder="••••••••" />
        </div>
        {error && <p className="error">{error}</p>}
        <button className="cta" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'up' ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <p className="muted" style={{ textAlign: 'center', marginTop: 16, fontSize: 13 }}>
        {mode === 'in' ? 'New to Apex?' : 'Already have an account?'}{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'in' ? 'up' : 'in'); setError(''); }}>
          {mode === 'in' ? 'Create one' : 'Sign in'}
        </a>
      </p>
      <p className="faint" style={{ textAlign: 'center', fontSize: 11, marginTop: 18 }}>
        Every account can act as both renter and landlord — switch roles in the app.
      </p>
    </div>
  );
}

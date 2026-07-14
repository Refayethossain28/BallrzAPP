'use client'
import { useState } from 'react'
import Link from 'next/link'
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, signOut, sendPasswordResetEmail,
} from 'firebase/auth'
import { firebaseAuth } from '@/lib/firebase'
import { useAuth } from '@/lib/useAuth'
import { UserRound, LogOut, Loader2, CloudUpload } from 'lucide-react'

// Sign in / sign up. Accounts sync the trade journal to the cloud so it
// follows the trader across devices.

const FRIENDLY_ERRORS: Record<string, string> = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/user-not-found': 'No account with that email — switch to "Create account".',
  'auth/email-already-in-use': 'That email already has an account — switch to "Sign in".',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/invalid-email': 'That email address doesn’t look right.',
  'auth/too-many-requests': 'Too many attempts — wait a minute and try again.',
  'auth/operation-not-allowed':
    'Email sign-in isn’t enabled yet. In the Firebase Console: Authentication → Sign-in method → enable Email/Password.',
  'auth/popup-closed-by-user': '',
}

function friendly(err: unknown): string {
  const code = (err as { code?: string })?.code ?? ''
  if (code in FRIENDLY_ERRORS) return FRIENDLY_ERRORS[code]
  return 'Something went wrong. Please try again.'
}

export default function AccountPage() {
  const { user, ready } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (err) {
      const msg = friendly(err)
      if (msg) setError(msg)
    } finally {
      setBusy(false)
    }
  }

  const submit = () =>
    run(() =>
      mode === 'signin'
        ? signInWithEmailAndPassword(firebaseAuth(), email.trim(), password)
        : createUserWithEmailAndPassword(firebaseAuth(), email.trim(), password),
    )

  const google = () => run(() => signInWithPopup(firebaseAuth(), new GoogleAuthProvider()))

  const resetPassword = () =>
    run(async () => {
      if (!email.trim()) { setError('Enter your email first, then tap "Forgot password".'); return }
      await sendPasswordResetEmail(firebaseAuth(), email.trim())
      setNotice('Password reset email sent — check your inbox.')
    })

  return (
    <div className="min-h-screen bg-surface-DEFAULT">
      <header className="border-b border-surface-border bg-surface-card/50 backdrop-blur sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-sm font-bold">FX</div>
            <div>
              <h1 className="text-white font-bold text-base leading-none">ApexFX</h1>
              <p className="text-gray-400 text-xs">Account</p>
            </div>
          </Link>
          <Link href="/journal" className="text-xs text-gray-400 hover:text-white transition-colors">
            Journal
          </Link>
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-10">
        {!ready ? (
          <div className="text-center py-16"><Loader2 className="w-6 h-6 text-blue-400 animate-spin mx-auto" /></div>
        ) : user ? (
          <div className="card p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-full bg-blue-600/20 border border-blue-500/40 flex items-center justify-center mx-auto text-blue-300 text-xl font-bold">
              {(user.email ?? 'U')[0].toUpperCase()}
            </div>
            <div>
              <p className="text-white font-semibold">{user.email ?? 'Signed in'}</p>
              <p className="text-gray-500 text-xs mt-1 flex items-center justify-center gap-1.5">
                <CloudUpload className="w-3.5 h-3.5" /> Your journal syncs to the cloud on this account
              </p>
            </div>
            <Link
              href="/journal"
              className="block w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
            >
              Open my journal
            </Link>
            <button
              onClick={() => run(() => signOut(firebaseAuth()))}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-surface-border text-sm text-gray-400 hover:text-white hover:border-gray-500 transition-colors"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </div>
        ) : (
          <div className="card p-6 space-y-4">
            <div className="text-center mb-2">
              <div className="w-14 h-14 rounded-full bg-blue-600/20 border border-blue-500/40 flex items-center justify-center mx-auto mb-3">
                <UserRound className="w-7 h-7 text-blue-300" />
              </div>
              <h2 className="text-white font-bold text-lg">
                {mode === 'signin' ? 'Sign in to ApexFX' : 'Create your ApexFX account'}
              </h2>
              <p className="text-gray-500 text-xs mt-1">
                Your trade journal and scoreboard will sync across all your devices.
              </p>
            </div>

            <input
              type="email"
              placeholder="Email"
              value={email}
              autoComplete="email"
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-surface-muted border border-surface-border rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void submit() }}
              className="w-full bg-surface-muted border border-surface-border rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-blue-500"
            />

            {error && <p className="text-sell text-xs">{error}</p>}
            {notice && <p className="text-buy text-xs">{notice}</p>}

            <button
              onClick={() => void submit()}
              disabled={busy || !email || !password}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold transition-colors disabled:opacity-50"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </button>

            <button
              onClick={() => void google()}
              disabled={busy}
              className="w-full py-3 rounded-xl border border-surface-border text-sm font-semibold text-gray-300 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-50"
            >
              Continue with Google
            </button>

            <div className="flex items-center justify-between text-xs">
              <button
                onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null) }}
                className="text-blue-400 hover:text-blue-300"
              >
                {mode === 'signin' ? 'New here? Create account' : 'Have an account? Sign in'}
              </button>
              {mode === 'signin' && (
                <button onClick={() => void resetPassword()} className="text-gray-500 hover:text-gray-300">
                  Forgot password?
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

import {
  createContext, useContext, useEffect, useState, type ReactNode,
} from 'react';
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile, type User,
} from 'firebase/auth';
import { auth } from '../lib/firebase';
import {
  ensureUserProfile, setActiveRole as persistRole, type Role, type UserProfile,
} from '../lib/db';

interface AuthState {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOutUser: () => Promise<void>;
  switchRole: (role: Role) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          // Race against a timeout: when the backend is unreachable (offline,
          // or a demo build whose database doesn't exist yet) the Firestore
          // client retries forever rather than rejecting — without the race the
          // app would sit on "Loading Apex…" indefinitely.
          const profile = await Promise.race([
            ensureUserProfile(u.uid, u.email ?? '', u.displayName ?? 'Member'),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('profile load timed out')), 6_000)),
          ]);
          setProfile(profile);
        } catch (err) {
          // Fall back to a local profile so the app renders instead of hanging.
          console.error('[apex] profile load failed', err);
          setProfile({
            uid: u.uid,
            email: u.email ?? '',
            displayName: u.displayName ?? 'Member',
            roles: { renter: true, landlord: true },
            activeRole: 'renter',
          });
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
  }, []);

  async function signUp(name: string, email: string, password: string) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: name });
    setProfile(await ensureUserProfile(cred.user.uid, email, name));
  }

  async function signIn(email: string, password: string) {
    await signInWithEmailAndPassword(auth, email, password);
  }

  async function signOutUser() {
    await signOut(auth);
  }

  async function switchRole(role: Role) {
    if (!user) return;
    // Optimistic: flip locally first so the UI responds even if the persist
    // fails (offline / demo build); the write is best-effort.
    setProfile((p) => (p ? { ...p, activeRole: role } : p));
    try {
      await persistRole(user.uid, role);
    } catch (err) {
      console.error('[apex] role persist failed', err);
    }
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, signUp, signIn, signOutUser, switchRole }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

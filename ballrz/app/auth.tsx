import { useRouter } from 'expo-router';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { ensureProfile } from '@/lib/api';
import { auth } from '@/lib/firebase';
import { colors } from '@/lib/theme';

export default function AuthScreen() {
  const router = useRouter();
  const { refreshProfile } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    const cleanHandle = handle.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (mode === 'register' && cleanHandle.length < 3) {
      setError('Pick a handle (at least 3 letters/numbers).');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await ensureProfile(cred.user.uid, cleanHandle);
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
      await refreshProfile();
      router.back();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <Text style={styles.logo}>BALLRZ</Text>
      <Text style={styles.tagline}>Post your highlight. Get seen.</Text>

      {mode === 'register' && (
        <TextInput
          style={styles.input}
          placeholder="Handle (e.g. hooper23)"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          value={handle}
          onChangeText={setHandle}
        />
      )}
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={colors.textMuted}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity style={styles.primary} onPress={submit} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryText}>{mode === 'login' ? 'Log in' : 'Create account'}</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity onPress={() => setMode(mode === 'login' ? 'register' : 'login')}>
        <Text style={styles.switch}>
          {mode === 'login' ? "New here? Create an account" : 'Already have an account? Log in'}
        </Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 24,
    justifyContent: 'center',
    gap: 12,
  },
  logo: {
    color: colors.accent,
    fontSize: 36,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 4,
  },
  tagline: { color: colors.textMuted, textAlign: 'center', marginBottom: 16 },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: colors.text,
  },
  error: { color: colors.like, textAlign: 'center' },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: 24,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  switch: { color: colors.textMuted, textAlign: 'center', marginTop: 12 },
});

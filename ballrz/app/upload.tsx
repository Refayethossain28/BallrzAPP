import * as ImagePicker from 'expo-image-picker';
import { Redirect, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { getActiveChallenge, uploadVideo } from '@/lib/api';
import { colors } from '@/lib/theme';
import type { Challenge } from '@/lib/types';

export default function UploadScreen() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [joinChallenge, setJoinChallenge] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getActiveChallenge().then(setChallenge).catch(() => {});
  }, []);

  if (!loading && !user) return <Redirect href="/auth" />;

  const pickVideo = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsEditing: true,
      videoMaxDuration: 60,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setVideoUri(result.assets[0].uri);
    }
  };

  const recordVideo = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setError('Camera permission is needed to record.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['videos'],
      videoMaxDuration: 60,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setVideoUri(result.assets[0].uri);
    }
  };

  const submit = async () => {
    if (!videoUri || !user || uploading) return;
    setError(null);
    setUploading(true);
    try {
      await uploadVideo({
        uid: user.uid,
        handle: profile?.handle ?? 'baller',
        localUri: videoUri,
        caption: caption.trim(),
        challengeId: joinChallenge && challenge ? challenge.id : null,
      });
      router.back();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Upload failed. Try again.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.pickerRow}>
        <TouchableOpacity style={styles.picker} onPress={recordVideo}>
          <Text style={styles.pickerIcon}>📹</Text>
          <Text style={styles.pickerText}>Record now</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.picker} onPress={pickVideo}>
          <Text style={styles.pickerIcon}>📁</Text>
          <Text style={styles.pickerText}>From gallery</Text>
        </TouchableOpacity>
      </View>
      {videoUri && <Text style={styles.selected}>✅ Video ready — max 60s</Text>}

      <TextInput
        style={styles.input}
        placeholder="Caption — what's the play?"
        placeholderTextColor={colors.textMuted}
        value={caption}
        onChangeText={setCaption}
        maxLength={150}
        multiline
      />

      {challenge && (
        <View style={styles.challengeRow}>
          <View style={styles.challengeInfo}>
            <Text style={styles.challengeTitle}>🏆 {challenge.title}</Text>
            <Text style={styles.challengeDesc}>{challenge.description}</Text>
          </View>
          <Switch
            value={joinChallenge}
            onValueChange={setJoinChallenge}
            trackColor={{ true: colors.accent }}
          />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity
        style={[styles.submit, (!videoUri || uploading) && styles.submitDisabled]}
        onPress={submit}
        disabled={!videoUri || uploading}
      >
        {uploading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>Post highlight</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: 20, gap: 16 },
  pickerRow: { flexDirection: 'row', gap: 12 },
  picker: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    paddingVertical: 32,
    gap: 8,
  },
  pickerIcon: { fontSize: 32 },
  pickerText: { color: colors.textMuted },
  selected: { color: colors.accent, textAlign: 'center', fontWeight: '600' },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    color: colors.text,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  challengeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  challengeInfo: { flex: 1, gap: 2 },
  challengeTitle: { color: colors.text, fontWeight: '700' },
  challengeDesc: { color: colors.textMuted, fontSize: 12 },
  error: { color: colors.like, textAlign: 'center' },
  submit: {
    backgroundColor: colors.accent,
    borderRadius: 24,
    paddingVertical: 14,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.4 },
  submitText: { color: '#fff', fontWeight: '800', fontSize: 16 },
});

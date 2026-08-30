import { useLocalSearchParams, useRouter } from 'expo-router';
import { signOut } from 'firebase/auth';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { getProfile, getUserVideos, isFollowing, toggleFollow } from '@/lib/api';
import { auth } from '@/lib/firebase';
import { colors } from '@/lib/theme';
import type { UserProfile, Video } from '@/lib/types';

export default function ProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [following, setFollowing] = useState(false);
  const [loading, setLoading] = useState(true);

  const isOwn = user?.uid === id;

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [p, v] = await Promise.all([getProfile(id), getUserVideos(id)]);
      setProfile(p);
      setVideos(v);
      if (user && user.uid !== id) {
        setFollowing(await isFollowing(user.uid, id));
      }
    } finally {
      setLoading(false);
    }
  }, [id, user]);

  useEffect(() => {
    load();
  }, [load]);

  const onFollow = async () => {
    if (!user) {
      router.push('/auth');
      return;
    }
    if (!id) return;
    const next = !following;
    setFollowing(next);
    setProfile((p) => (p ? { ...p, followers: p.followers + (next ? 1 : -1) } : p));
    try {
      const serverFollowing = await toggleFollow(user.uid, id);
      setFollowing(serverFollowing);
    } catch {
      setFollowing(!next);
      setProfile((p) => (p ? { ...p, followers: p.followers + (next ? -1 : 1) } : p));
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Profile not found.</Text>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={videos}
      keyExtractor={(v) => v.id}
      ListHeaderComponent={
        <View style={styles.header}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{profile.handle.charAt(0).toUpperCase()}</Text>
          </View>
          <Text style={styles.handle}>@{profile.handle}</Text>
          {profile.bio ? <Text style={styles.bio}>{profile.bio}</Text> : null}
          <View style={styles.statsRow}>
            <Stat label="Followers" value={profile.followers} />
            <Stat label="Following" value={profile.following} />
            <Stat label="Posts" value={videos.length} />
          </View>
          {isOwn ? (
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={async () => {
                await signOut(auth);
                router.back();
              }}
            >
              <Text style={styles.secondaryBtnText}>Log out</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.followBtn, following && styles.followingBtn]}
              onPress={onFollow}
            >
              <Text style={styles.followBtnText}>{following ? 'Following ✓' : 'Follow'}</Text>
            </TouchableOpacity>
          )}
        </View>
      }
      ListEmptyComponent={<Text style={[styles.muted, styles.empty]}>No highlights posted yet.</Text>}
      renderItem={({ item }) => (
        <View style={styles.videoRow}>
          <Text style={styles.videoCaption} numberOfLines={2}>
            {item.caption || 'Untitled highlight'}
          </Text>
          <Text style={styles.videoMeta}>
            ♥ {item.likes} · 💬 {item.comments}
            {item.challengeId ? ' · 🏆' : ''}
          </Text>
        </View>
      )}
    />
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  muted: { color: colors.textMuted },
  empty: { textAlign: 'center', paddingVertical: 32 },
  header: { alignItems: 'center', padding: 24, gap: 8 },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 32, fontWeight: '800' },
  handle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  bio: { color: colors.textMuted, textAlign: 'center' },
  statsRow: { flexDirection: 'row', gap: 32, marginVertical: 12 },
  stat: { alignItems: 'center' },
  statValue: { color: colors.text, fontSize: 18, fontWeight: '800' },
  statLabel: { color: colors.textMuted, fontSize: 12 },
  followBtn: {
    backgroundColor: colors.accent,
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: 40,
  },
  followingBtn: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  followBtnText: { color: '#fff', fontWeight: '700' },
  secondaryBtn: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    paddingHorizontal: 40,
  },
  secondaryBtnText: { color: colors.textMuted, fontWeight: '700' },
  videoRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 4,
  },
  videoCaption: { color: colors.text, fontWeight: '600' },
  videoMeta: { color: colors.textMuted, fontSize: 12 },
});

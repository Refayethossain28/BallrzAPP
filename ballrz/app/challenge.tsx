import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { getActiveChallenge, getChallengeLeaderboard } from '@/lib/api';
import { colors } from '@/lib/theme';
import type { Challenge, Video } from '@/lib/types';

export default function ChallengeScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [entries, setEntries] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const c = await getActiveChallenge();
        setChallenge(c);
        if (c) setEntries(await getChallengeLeaderboard(c.id));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!challenge) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>No active challenge right now — check back soon.</Text>
      </View>
    );
  }

  const daysLeft = Math.max(0, Math.ceil((challenge.endsAt - Date.now()) / 86400000));

  return (
    <FlatList
      style={styles.container}
      data={entries}
      keyExtractor={(v) => v.id}
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.trophy}>🏆</Text>
          <Text style={styles.title}>{challenge.title}</Text>
          <Text style={styles.desc}>{challenge.description}</Text>
          <Text style={styles.deadline}>
            {daysLeft === 0 ? 'Ends today!' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}
          </Text>
          <TouchableOpacity
            style={styles.enterBtn}
            onPress={() => router.push(user ? '/upload' : '/auth')}
          >
            <Text style={styles.enterBtnText}>Enter the challenge</Text>
          </TouchableOpacity>
          <Text style={styles.leaderboardTitle}>Leaderboard</Text>
        </View>
      }
      ListEmptyComponent={
        <Text style={[styles.muted, styles.empty]}>No entries yet — be the first on the board.</Text>
      }
      renderItem={({ item, index }) => (
        <TouchableOpacity
          style={styles.row}
          onPress={() => router.push(`/profile/${item.ownerId}`)}
        >
          <Text style={[styles.rank, index < 3 && styles.rankTop]}>{index + 1}</Text>
          <View style={styles.rowInfo}>
            <Text style={styles.rowHandle}>@{item.ownerHandle}</Text>
            {item.caption ? (
              <Text style={styles.rowCaption} numberOfLines={1}>
                {item.caption}
              </Text>
            ) : null}
          </View>
          <Text style={styles.rowLikes}>♥ {item.likes}</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  muted: { color: colors.textMuted, textAlign: 'center' },
  empty: { paddingVertical: 32 },
  header: { alignItems: 'center', padding: 24, gap: 8 },
  trophy: { fontSize: 48 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  desc: { color: colors.textMuted, textAlign: 'center' },
  deadline: { color: colors.accent, fontWeight: '700' },
  enterBtn: {
    backgroundColor: colors.accent,
    borderRadius: 24,
    paddingVertical: 12,
    paddingHorizontal: 32,
    marginTop: 8,
  },
  enterBtnText: { color: '#fff', fontWeight: '800' },
  leaderboardTitle: {
    color: colors.text,
    fontWeight: '800',
    fontSize: 16,
    alignSelf: 'flex-start',
    marginTop: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 12,
    gap: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rank: { color: colors.textMuted, fontWeight: '800', fontSize: 16, width: 28 },
  rankTop: { color: colors.accent },
  rowInfo: { flex: 1, gap: 2 },
  rowHandle: { color: colors.text, fontWeight: '700' },
  rowCaption: { color: colors.textMuted, fontSize: 12 },
  rowLikes: { color: colors.like, fontWeight: '700' },
});

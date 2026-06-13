import { Link } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getActiveChallenge } from '@/lib/api';
import { colors } from '@/lib/theme';
import type { Challenge } from '@/lib/types';

export default function ChallengeBanner() {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    getActiveChallenge().then(setChallenge).catch(() => {});
  }, []);

  if (!challenge) return null;

  return (
    <Link href="/challenge" asChild>
      <TouchableOpacity style={[styles.banner, { top: insets.top + 8 }]}>
        <Text style={styles.text} numberOfLines={1}>
          🏆 {challenge.title} — tap for leaderboard
        </Text>
      </TouchableOpacity>
    </Link>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 14,
    right: 14,
    backgroundColor: 'rgba(22,22,26,0.85)',
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  text: { color: colors.text, fontWeight: '600', textAlign: 'center', fontSize: 13 },
});

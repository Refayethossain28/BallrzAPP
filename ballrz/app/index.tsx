import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ChallengeBanner from '@/components/ChallengeBanner';
import VideoCard from '@/components/VideoCard';
import { useAuth } from '@/hooks/useAuth';
import { subscribeFeed } from '@/lib/api';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';

export default function FeedScreen() {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const router = useRouter();
  const [videos, setVideos] = useState<Video[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => subscribeFeed(setVideos), []);

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first?.index != null) setActiveIndex(first.index);
    },
  ).current;

  return (
    <View style={styles.container}>
      <FlatList
        data={videos}
        keyExtractor={(v) => v.id}
        renderItem={({ item, index }) => (
          <VideoCard video={item} height={height} isActive={index === activeIndex} />
        )}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        getItemLayout={(_, index) => ({ length: height, offset: height * index, index })}
        windowSize={5}
        ListEmptyComponent={
          <View style={[styles.empty, { height }]}>
            <Text style={styles.emptyTitle}>No highlights yet 🏀</Text>
            <Text style={styles.emptyText}>Be the first to post one.</Text>
          </View>
        }
      />

      <ChallengeBanner />

      {/* Post button — the only gate is at the moment of action */}
      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
        onPress={() => router.push(user ? '/upload' : '/auth')}
      >
        <Text style={styles.fabText}>＋</Text>
      </TouchableOpacity>

      {!user && (
        <TouchableOpacity
          style={[styles.loginPill, { bottom: insets.bottom + 32 }]}
          onPress={() => router.push('/auth')}
        >
          <Text style={styles.loginPillText}>Log in</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  empty: { alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  emptyText: { color: colors.textMuted },
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  fabText: { color: '#fff', fontSize: 28, fontWeight: '700', lineHeight: 32 },
  loginPill: {
    position: 'absolute',
    left: 20,
    backgroundColor: 'rgba(22,22,26,0.85)',
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 20,
    paddingVertical: 9,
    paddingHorizontal: 18,
  },
  loginPillText: { color: colors.text, fontWeight: '700' },
});

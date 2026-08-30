import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import { getFollowingIds, rankForYou, subscribeFeed } from '@/lib/api';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';

type Tab = 'forYou' | 'following';

export default function FeedScreen() {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const router = useRouter();
  const listRef = useRef<FlatList<Video>>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [tab, setTab] = useState<Tab>('forYou');
  const [followingIds, setFollowingIds] = useState<string[]>([]);

  useEffect(() => subscribeFeed(setVideos), []);

  useEffect(() => {
    if (user) {
      getFollowingIds(user.uid).then(setFollowingIds).catch(() => setFollowingIds([]));
    } else {
      setFollowingIds([]);
    }
  }, [user]);

  const feed = useMemo(() => {
    if (tab === 'following') {
      return videos
        .filter((v) => followingIds.includes(v.ownerId))
        .sort((a, b) => b.createdAt - a.createdAt);
    }
    return rankForYou(videos);
  }, [tab, videos, followingIds]);

  const switchTab = (next: Tab) => {
    if (next === 'following' && !user) {
      router.push('/auth');
      return;
    }
    if (next === tab) return;
    setTab(next);
    setActiveIndex(0);
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  };

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0];
      if (first?.index != null) setActiveIndex(first.index);
    },
  ).current;

  return (
    <View style={styles.container}>
      <FlatList
        ref={listRef}
        data={feed}
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
            {tab === 'following' ? (
              <>
                <Text style={styles.emptyTitle}>Nothing here yet 👀</Text>
                <Text style={styles.emptyText}>Follow some ballers and their posts show up here.</Text>
              </>
            ) : (
              <>
                <Text style={styles.emptyTitle}>No highlights yet 🏀</Text>
                <Text style={styles.emptyText}>Be the first to post one.</Text>
              </>
            )}
          </View>
        }
      />

      {/* Feed tabs */}
      <View style={[styles.tabs, { top: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => switchTab('forYou')}>
          <Text style={[styles.tab, tab === 'forYou' && styles.tabActive]}>For You</Text>
        </TouchableOpacity>
        <Text style={styles.tabDivider}>|</Text>
        <TouchableOpacity onPress={() => switchTab('following')}>
          <Text style={[styles.tab, tab === 'following' && styles.tabActive]}>Following</Text>
        </TouchableOpacity>
      </View>

      <ChallengeBanner topOffset={insets.top + 48} />

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
  empty: { alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 32 },
  emptyTitle: { color: colors.text, fontSize: 20, fontWeight: '800' },
  emptyText: { color: colors.textMuted, textAlign: 'center' },
  tabs: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  tab: {
    color: 'rgba(255,255,255,0.6)',
    fontWeight: '700',
    fontSize: 16,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
  tabActive: { color: '#fff', fontSize: 17 },
  tabDivider: { color: 'rgba(255,255,255,0.4)' },
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

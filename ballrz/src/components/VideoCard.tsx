import { Link, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { hasLiked, toggleLike } from '@/lib/api';
import { colors } from '@/lib/theme';
import type { Video } from '@/lib/types';
import CommentsSheet from './CommentsSheet';

interface Props {
  video: Video;
  height: number;
  isActive: boolean;
}

export default function VideoCard({ video, height, isActive }: Props) {
  const { user } = useAuth();
  const router = useRouter();
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(video.likes);
  const [commentsOpen, setCommentsOpen] = useState(false);

  const player = useVideoPlayer(video.url, (p) => {
    p.loop = true;
    p.muted = false;
  });

  useEffect(() => {
    if (isActive) {
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, player]);

  useEffect(() => {
    if (user) {
      hasLiked(video.id, user.uid).then(setLiked).catch(() => {});
    } else {
      setLiked(false);
    }
  }, [user, video.id]);

  const onLike = async () => {
    if (!user) {
      router.push('/auth');
      return;
    }
    // Optimistic update; reconcile with the server result.
    const next = !liked;
    setLiked(next);
    setLikeCount((c) => c + (next ? 1 : -1));
    try {
      const serverLiked = await toggleLike(video.id, user.uid);
      setLiked(serverLiked);
    } catch {
      setLiked(!next);
      setLikeCount((c) => c + (next ? -1 : 1));
    }
  };

  return (
    <View style={[styles.container, { height }]}>
      <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} />

      {/* Right action rail */}
      <View style={styles.rail}>
        <Link href={`/profile/${video.ownerId}`} asChild>
          <TouchableOpacity style={styles.avatar}>
            <Text style={styles.avatarText}>{video.ownerHandle.charAt(0).toUpperCase()}</Text>
          </TouchableOpacity>
        </Link>
        <TouchableOpacity style={styles.action} onPress={onLike}>
          <Text style={[styles.actionIcon, liked && { color: colors.like }]}>
            {liked ? '♥' : '♡'}
          </Text>
          <Text style={styles.actionLabel}>{likeCount}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.action} onPress={() => setCommentsOpen(true)}>
          <Text style={styles.actionIcon}>💬</Text>
          <Text style={styles.actionLabel}>{video.comments}</Text>
        </TouchableOpacity>
      </View>

      {/* Caption */}
      <View style={styles.captionBox}>
        <Link href={`/profile/${video.ownerId}`}>
          <Text style={styles.handle}>@{video.ownerHandle}</Text>
        </Link>
        {video.caption ? <Text style={styles.caption}>{video.caption}</Text> : null}
        {video.challengeId ? <Text style={styles.challengeTag}>🏆 Weekly Challenge entry</Text> : null}
      </View>

      <CommentsSheet
        videoId={video.id}
        visible={commentsOpen}
        onClose={() => setCommentsOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', backgroundColor: colors.background },
  rail: {
    position: 'absolute',
    right: 12,
    bottom: 120,
    alignItems: 'center',
    gap: 20,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  avatarText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  action: { alignItems: 'center' },
  actionIcon: { fontSize: 30, color: '#fff' },
  actionLabel: { color: '#fff', fontSize: 12, marginTop: 2, fontWeight: '600' },
  captionBox: {
    position: 'absolute',
    left: 14,
    right: 80,
    bottom: 48,
    gap: 4,
  },
  handle: { color: '#fff', fontWeight: '800', fontSize: 16 },
  caption: { color: '#fff', fontSize: 14 },
  challengeTag: { color: colors.accent, fontWeight: '700', fontSize: 12 },
});

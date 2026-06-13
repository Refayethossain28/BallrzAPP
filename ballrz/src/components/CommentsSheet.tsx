import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { addComment, subscribeComments } from '@/lib/api';
import { colors } from '@/lib/theme';
import type { Comment } from '@/lib/types';

interface Props {
  videoId: string;
  visible: boolean;
  onClose: () => void;
}

export default function CommentsSheet({ videoId, visible, onClose }: Props) {
  const { user, profile } = useAuth();
  const router = useRouter();
  const [comments, setComments] = useState<Comment[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    return subscribeComments(videoId, setComments);
  }, [videoId, visible]);

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed || !user || sending) return;
    setSending(true);
    try {
      await addComment(videoId, user.uid, profile?.handle ?? 'baller', trimmed);
      setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.sheet}
      >
        <View style={styles.handleBar} />
        <Text style={styles.title}>Comments</Text>
        <FlatList
          data={comments}
          keyExtractor={(c) => c.id}
          style={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>No comments yet — start it off.</Text>}
          renderItem={({ item }) => (
            <View style={styles.comment}>
              <Text style={styles.handle}>@{item.handle}</Text>
              <Text style={styles.commentText}>{item.text}</Text>
            </View>
          )}
        />
        {user ? (
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              placeholder="Add a comment…"
              placeholderTextColor={colors.textMuted}
              value={text}
              onChangeText={setText}
              onSubmitEditing={send}
              returnKeyType="send"
            />
            <TouchableOpacity onPress={send} disabled={sending}>
              <Text style={styles.send}>Send</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.loginCta}
            onPress={() => {
              onClose();
              router.push('/auth');
            }}
          >
            <Text style={styles.loginCtaText}>Log in to comment</Text>
          </TouchableOpacity>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '70%',
    minHeight: '50%',
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  handleBar: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginVertical: 10,
  },
  title: { color: colors.text, fontWeight: '700', fontSize: 16, marginBottom: 8 },
  list: { flexGrow: 1 },
  empty: { color: colors.textMuted, paddingVertical: 24, textAlign: 'center' },
  comment: { paddingVertical: 8 },
  handle: { color: colors.accent, fontWeight: '600', marginBottom: 2 },
  commentText: { color: colors.text },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 10,
  },
  input: {
    flex: 1,
    color: colors.text,
    backgroundColor: colors.background,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  send: { color: colors.accent, fontWeight: '700' },
  loginCta: {
    backgroundColor: colors.accent,
    borderRadius: 24,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  loginCtaText: { color: '#fff', fontWeight: '700' },
});

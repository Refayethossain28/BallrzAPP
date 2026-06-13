import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit as qLimit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { db, storage } from './firebase';
import type { Challenge, Comment, UserProfile, Video } from './types';

// ---------- Feed ----------

export function subscribeFeed(cb: (videos: Video[]) => void): () => void {
  const q = query(collection(db, 'videos'), orderBy('createdAt', 'desc'), qLimit(50));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Video));
  });
}

/**
 * Engagement-over-recency "hot" ranking for the For You feed.
 * Comments weigh more than likes; the time decay keeps the feed fresh.
 */
export function rankForYou(videos: Video[]): Video[] {
  const now = Date.now();
  const score = (v: Video) => {
    const ageHours = Math.max(0, (now - v.createdAt) / 3600000);
    return (v.likes * 2 + v.comments * 3 + 1) / Math.pow(ageHours + 2, 1.5);
  };
  return [...videos].sort((a, b) => score(b) - score(a));
}

// ---------- Likes ----------

export async function hasLiked(videoId: string, uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'videos', videoId, 'likes', uid));
  return snap.exists();
}

/** Toggles the like and returns the new liked state. */
export async function toggleLike(videoId: string, uid: string): Promise<boolean> {
  const likeRef = doc(db, 'videos', videoId, 'likes', uid);
  const videoRef = doc(db, 'videos', videoId);
  const liked = (await getDoc(likeRef)).exists();
  if (liked) {
    await deleteDoc(likeRef);
    await updateDoc(videoRef, { likes: increment(-1) });
    return false;
  }
  await setDoc(likeRef, { createdAt: Date.now() });
  await updateDoc(videoRef, { likes: increment(1) });
  return true;
}

// ---------- Comments ----------

export function subscribeComments(videoId: string, cb: (comments: Comment[]) => void): () => void {
  const q = query(
    collection(db, 'videos', videoId, 'comments'),
    orderBy('createdAt', 'desc'),
    qLimit(100),
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Comment));
  });
}

export async function addComment(videoId: string, userId: string, handle: string, text: string) {
  await addDoc(collection(db, 'videos', videoId, 'comments'), {
    userId,
    handle,
    text,
    createdAt: Date.now(),
  });
  await updateDoc(doc(db, 'videos', videoId), { comments: increment(1) });
}

// ---------- Profiles & follows ----------

export async function ensureProfile(uid: string, handle: string) {
  const userRef = doc(db, 'users', uid);
  if (!(await getDoc(userRef)).exists()) {
    await setDoc(userRef, {
      handle,
      bio: '',
      followers: 0,
      following: 0,
      createdAt: Date.now(),
    });
  }
}

export async function getProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as UserProfile) : null;
}

export async function getUserVideos(uid: string): Promise<Video[]> {
  // No orderBy here to avoid needing a composite index in v1 — sort client-side.
  const snap = await getDocs(query(collection(db, 'videos'), where('ownerId', '==', uid)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Video)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getFollowingIds(uid: string): Promise<string[]> {
  const snap = await getDocs(collection(db, 'users', uid, 'following'));
  return snap.docs.map((d) => d.id);
}

export async function isFollowing(uid: string, targetId: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid, 'following', targetId));
  return snap.exists();
}

/** Toggles the follow and returns the new following state. */
export async function toggleFollow(uid: string, targetId: string): Promise<boolean> {
  const followRef = doc(db, 'users', uid, 'following', targetId);
  const following = (await getDoc(followRef)).exists();
  if (following) {
    await deleteDoc(followRef);
    await updateDoc(doc(db, 'users', targetId), { followers: increment(-1) });
    await updateDoc(doc(db, 'users', uid), { following: increment(-1) });
    return false;
  }
  await setDoc(followRef, { createdAt: Date.now() });
  await updateDoc(doc(db, 'users', targetId), { followers: increment(1) });
  await updateDoc(doc(db, 'users', uid), { following: increment(1) });
  return true;
}

// ---------- Upload ----------

export async function uploadVideo(opts: {
  uid: string;
  handle: string;
  localUri: string;
  caption: string;
  challengeId: string | null;
}) {
  const res = await fetch(opts.localUri);
  const blob = await res.blob();
  const storageRef = ref(storage, `videos/${opts.uid}/${Date.now()}.mp4`);
  await uploadBytes(storageRef, blob);
  const url = await getDownloadURL(storageRef);
  await addDoc(collection(db, 'videos'), {
    ownerId: opts.uid,
    ownerHandle: opts.handle,
    url,
    caption: opts.caption,
    likes: 0,
    comments: 0,
    challengeId: opts.challengeId,
    createdAt: Date.now(),
  });
}

// ---------- Moderation ----------

export async function reportVideo(videoId: string, reporterId: string, reason: string) {
  await addDoc(collection(db, 'reports'), {
    videoId,
    reporterId,
    reason,
    status: 'open',
    createdAt: Date.now(),
  });
}

// ---------- Weekly challenge ----------

export async function getActiveChallenge(): Promise<Challenge | null> {
  const snap = await getDocs(
    query(collection(db, 'challenges'), where('endsAt', '>', Date.now()), qLimit(1)),
  );
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as Challenge;
}

export async function getChallengeLeaderboard(challengeId: string): Promise<Video[]> {
  const snap = await getDocs(
    query(collection(db, 'videos'), where('challengeId', '==', challengeId)),
  );
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }) as Video)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 20);
}

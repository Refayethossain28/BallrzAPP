export interface UserProfile {
  id: string;
  handle: string;
  bio: string;
  followers: number;
  following: number;
  createdAt: number;
}

export interface Video {
  id: string;
  ownerId: string;
  ownerHandle: string;
  url: string;
  caption: string;
  likes: number;
  comments: number;
  challengeId: string | null;
  createdAt: number;
}

export interface Comment {
  id: string;
  userId: string;
  handle: string;
  text: string;
  createdAt: number;
}

export interface Challenge {
  id: string;
  title: string;
  description: string;
  endsAt: number;
}

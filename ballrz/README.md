# Ballrz 🏀

Post your highlight. Get seen.

A cross-platform (iOS + Android) short-video app for ballers, built with
**Expo / React Native + TypeScript + Firebase**. This is the v1 rebuild of the
original SwiftUI sketch, designed around the growth loops that made the big
social apps big:

| Pillar | How Ballrz v1 does it |
|---|---|
| Zero friction | Feed is watchable **without an account** — auth is only asked at the moment of action (like / comment / post) |
| Network effects | Profiles, follows, likes, comments, native share |
| Content loop | Vertical full-screen swipe feed (TikTok-style), autoplay per page, engagement-ranked **For You** tab |
| Retention loop | **Weekly Challenge** with a live leaderboard — a scheduled reason to post and to come back |

## Features

- 📱 Full-screen vertical video feed with swipe paging and autoplay
- 🔀 **For You** tab (engagement-over-recency "hot" ranking) and **Following** tab
- 👀 Browse without logging in; login wall only appears on interaction
- ❤️ Likes (optimistic UI) and 💬 comments (real-time)
- ↗️ Native share sheet on every video (viral loop)
- 👤 Profiles with follower/following counts and post history
- ➕ Post a highlight: **record in-app** or pick from gallery (max 60s), with captions
- 🏆 Weekly challenge: banner on the feed, entry toggle on upload, live leaderboard
- ⚑ Report button on every video (writes to a `reports` queue for review)

## Getting started

### 1. Install

```bash
cd ballrz
npm install
```

### 2. Configure Firebase

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Authentication → Email/Password**, **Firestore**, and **Storage**
3. Add a **Web app** to the project and copy its config
4. `cp .env.example .env` and fill in the values

### 3. Run

```bash
npx expo start
```

Scan the QR code with the **Expo Go** app (iOS/Android), or press `i` / `a`
for a simulator/emulator.

## Data model (Firestore)

```
users/{uid}                 { handle, bio, followers, following, createdAt }
users/{uid}/following/{id}  { createdAt }
videos/{id}                 { ownerId, ownerHandle, url, caption, likes, comments, challengeId, createdAt }
videos/{id}/likes/{uid}     { createdAt }
videos/{id}/comments/{id}   { userId, handle, text, createdAt }
challenges/{id}             { title, description, endsAt }
reports/{id}                { videoId, reporterId, reason, status, createdAt }
```

Video files live in Storage under `videos/{uid}/{timestamp}.mp4`.

### Creating the first weekly challenge

Add a doc to `challenges` in the Firebase console, e.g.:

```json
{
  "title": "Deep Three Week",
  "description": "Post your best shot from way downtown.",
  "endsAt": 1750000000000
}
```

(`endsAt` is a JS millisecond timestamp; the app shows whichever challenge
hasn't ended yet.)

## Suggested security rules (starter)

**Firestore:**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if true;
      allow write: if request.auth != null;
      match /following/{target} {
        allow read: if true;
        allow write: if request.auth != null && request.auth.uid == uid;
      }
    }
    match /videos/{videoId} {
      allow read: if true;
      allow create: if request.auth != null
        && request.resource.data.ownerId == request.auth.uid;
      allow update: if request.auth != null;   // like/comment counters
      allow delete: if request.auth != null
        && resource.data.ownerId == request.auth.uid;
      match /likes/{uid} {
        allow read: if true;
        allow write: if request.auth != null && request.auth.uid == uid;
      }
      match /comments/{commentId} {
        allow read: if true;
        allow create: if request.auth != null
          && request.resource.data.userId == request.auth.uid;
      }
    }
    match /challenges/{id} {
      allow read: if true;
      allow write: if false;   // managed from the console for now
    }
    match /reports/{id} {
      allow create: if request.auth != null
        && request.resource.data.reporterId == request.auth.uid;
      allow read, update, delete: if false;   // review from the console
    }
  }
}
```

**Storage:**

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /videos/{uid}/{file} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid
        && request.resource.size < 100 * 1024 * 1024;
    }
  }
}
```

> ⚠️ These are starter rules — tighten them (counter validation, rate
> limiting via Cloud Functions) before any public launch.

## Roadmap (chapter 2)

- Push notifications (likes, comments, new followers, challenge reminders) —
  needs an EAS project + Cloud Functions
- Server-side feed ranking (move the "hot" score into a Cloud Function /
  scheduled job once volume grows)
- Video trimming and filters
- Duets ("recreate this move")
- Local pickup-game discovery
- Admin moderation dashboard for the `reports` queue (the in-app report
  button already exists)

## Project structure

```
ballrz/
├── app/                 # expo-router screens
│   ├── _layout.tsx      # root stack + auth provider
│   ├── index.tsx        # the feed (home)
│   ├── auth.tsx         # login / register modal
│   ├── upload.tsx       # post a highlight
│   ├── challenge.tsx    # weekly challenge + leaderboard
│   └── profile/[id].tsx # user profiles
└── src/
    ├── components/      # VideoCard, CommentsSheet, ChallengeBanner
    ├── hooks/           # useAuth (Firebase auth context)
    └── lib/             # firebase init, firestore api, types, theme
```

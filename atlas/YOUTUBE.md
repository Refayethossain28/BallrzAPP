# The Atlas community channel — dashcam clips on YouTube

After every saved dashcam clip, Atlas asks the driver: **"📺 Share this clip
on the Atlas channel?"** (there's also a 📺 button on every clip in the
vault). One tap uploads it to *your* YouTube channel — **unlisted** — where
you review it and publish the good ones. Nothing goes public unseen.

```
driver taps Share
  → clip uploads to Firebase Storage (owner-only staging, video-only, ≤200MB)
  → atlasClipPublish Cloud Function verifies the user, checks the caps,
    pushes the video to YouTube as UNLISTED with the channel's own
    credentials, logs it in Firestore (atlas_clip_subs), deletes the staging
    copy, and tells the driver "it appears once approved"
  → you open YouTube Studio, watch the new unlisted arrivals,
    set the good ones to Public
```

## One-time setup

### 1. The channel
Create (or use) a YouTube channel with the Google account you want to own
the videos — e.g. an "Atlas Dashcam" brand channel.

### 2. Google Cloud OAuth
1. [console.cloud.google.com](https://console.cloud.google.com) → the
   `apexvip-1b4a9` project (or any project) → **APIs & Services**.
2. **Library** → enable **YouTube Data API v3**.
3. **OAuth consent screen** → External → fill the basics → add the channel's
   Google account as a **test user** (testing mode is fine — only the
   channel account ever authorises).
4. **Credentials → Create credentials → OAuth client ID** → application type
   **"TVs and Limited Input devices"** → note the client id + secret.

### 3. Mint the channel's refresh token
```sh
node scripts/mint-youtube-token.mjs <client_id> <client_secret>
```
It prints a URL and code — approve on your phone **as the channel account**
— then prints the refresh token.

### 4. Secrets + deploy
```sh
cd functions
firebase functions:secrets:set ATLAS_YT_CLIENT_ID
firebase functions:secrets:set ATLAS_YT_CLIENT_SECRET
firebase functions:secrets:set ATLAS_YT_REFRESH_TOKEN
firebase deploy --only functions:apexvip,storage
```
The deploy prints the `atlasClipPublish` URL.

### 5. Switch it on in the app
Paste that URL into `atlas/config.js` as `ATLAS_CLIPS_PUBLISH`. Until then
the prompt and the 📺 button stay hidden — no dead ends.

## Review workflow (you, ~1 minute/day)
[studio.youtube.com](https://studio.youtube.com) → Content → filter
**Unlisted** → watch → set to **Public** (or delete). The Firestore
collection `atlas_clip_subs` is your ledger of who sent what and when.

## Honest limits
- **YouTube API quota:** an upload costs 1,600 units of the default 10,000/day
  — about **6 community clips per day** until you request a quota increase
  (free, takes a form and a few days). The app shows "quota reached — try
  tomorrow" beyond that.
- **Moderation is the point:** clips arrive unlisted precisely so road-rage,
  plates-and-faces, or junk never auto-publishes under your name. You are
  the editor of your channel.
- **Privacy:** the driver chooses per-clip; nothing uploads automatically.
  Storage staging is owner-only and deleted after the YouTube push.

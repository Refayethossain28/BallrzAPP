# ApexVIP iOS app — Capacitor shell

The iOS app lives in `ios-app/`. It is a native Xcode project (Capacitor 6)
that loads the **live client app from `https://apexvip.uk/apexvip-client.html?native=1`**
inside a WKWebView, with native plugins bridged in.

## Why a remote shell (and what that buys you)

- **Features ship instantly.** Push to `main` → GitHub Pages deploys → every
  installed app is updated on next launch. No App Store review for app changes.
- **A new App Store binary is only needed** when the *native* side changes:
  new plugins, icon/splash, iOS version bumps. In practice a few times a year.
- If the phone is offline the shell shows the branded `offline.html` page
  (configured via `server.errorPath`).

## What's already wired

| Piece | Status |
|---|---|
| App ID / name | `uk.apexvip.app` / ApexVIP |
| Icon + splash | Brand icon (alpha flattened — App Store requirement) + dark "Apex VIP" splash |
| Haptics | `haptic()` in the client detects the Capacitor bridge and plays real Taptic Engine sequences (iOS Safari has no `navigator.vibrate`, so this is native-only) |
| Status bar / splash screen / app lifecycle plugins | Installed and registered in the Podfile |
| Push notifications plugin | Installed — needs the Xcode capability + APNs key (below) |
| Push token registration | **Wired end-to-end.** The client requests permission after sign-in, the AppDelegate exchanges the APNs token for an FCM token (FirebaseMessaging pod), and the token is stored in `fcm_tokens/{uid}` alongside web tokens. The backend's `onBookingWrite` now sends a push (with email/SMS) on every lifecycle event — confirmed, chauffeur assigned, en route, completed — and prunes dead tokens automatically. Tapping a notification deep-links to the trips screen. |

## Building on a Mac (first time)

Prereqs: Xcode 15+, CocoaPods (`brew install cocoapods`), Node 20+.

```bash
cd ios-app
npm install
npx cap sync ios        # runs pod install
npx cap open ios        # opens Xcode
```

In Xcode:

1. **Signing & Capabilities** → select your Apple Developer team. Bundle ID
   `uk.apexvip.app` must be registered in your developer account (Xcode can
   auto-register it).
2. **Add capability: Push Notifications**, and **Background Modes → Remote
   notifications** (needed for silent/badge updates).
3. Run on a real device (haptics and push don't work in the simulator).

## Push notifications (APNs ↔ Firebase)

1. Apple Developer portal → Keys → create an **APNs Auth Key** (.p8), note the
   Key ID and Team ID.
2. Firebase console → Project settings → Cloud Messaging → iOS app →
   **upload the .p8 key**.
3. Register the iOS app (`uk.apexvip.app`) in Firebase console → Project
   settings → Add app → iOS, and drop the generated `GoogleService-Info.plist`
   into `ios-app/ios/App/App/` (add it to the App target in Xcode).
4. The code side is already done: the AppDelegate configures Firebase and
   exchanges the APNs token for an FCM token; the client stores it in
   `fcm_tokens/{uid}` after sign-in; `onBookingWrite` sends the pushes.
   The AppDelegate is guarded — the app runs fine before the plist exists,
   push just stays off.

## App Store review notes (guideline 4.2 — "minimum functionality")

Apple rejects thin website wrappers. This shell clears the bar because it
ships real native behaviour — Taptic haptics, push, native status-bar/splash
integration — and the product is a functional service tool (booking, live trip
tracking, payments), not a brochure. In the review notes, describe it as a
**private chauffeur & concierge membership app**; provide a demo account.

Payments: rides, flights and hotels are physical-world services, so Square
card payments are allowed (App Store Review Guideline 3.1.3(e)) — no IAP
required. Word the listing around the service, not digital features.

## Day-to-day

- Web change (almost everything): just merge to `main`. Done.
- Native change (plugin/config/icon): bump `ios-app`, then on the Mac
  `npx cap sync ios`, archive in Xcode → Distribute → App Store Connect.

## Later, when it earns its keep

- **Live Activity / Dynamic Island** ("Your chauffeur is 4 minutes away"):
  add a WidgetKit extension target to this same Xcode project — Swift inside
  the Capacitor app, no rewrite.
- **Sign in with Apple**: `@capacitor-community/apple-sign-in` plugin +
  the Firebase console steps already listed in the go-live checklist.
- Home-screen widget with the membership card / next trip.

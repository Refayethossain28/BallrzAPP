# ApexVIP — Native iOS App (SwiftUI)

A native Swift/SwiftUI implementation of the ApexVIP luxury chauffeur client,
mirroring the web app's flows and brand design. This is the **true native**
path (as opposed to the Capacitor wrapper in `../ios-app`).

## What's here

```
ios-native/
├── project.yml                 # XcodeGen spec → generates ApexVIP.xcodeproj
└── ApexVIP/
    ├── App.swift               # @main entry, splash → login → root routing
    ├── Theme.swift             # Brand colors, fonts, reusable button/card styles
    ├── Models.swift            # Trip, ChatMessage, ServiceTier, + DemoData
    ├── Store.swift             # AppStore (state), LocationManager, ChatService stub
    ├── Info.plist              # Location usage strings, status bar, orientation
    ├── Assets.xcassets/        # AppIcon (1024), AccentColor (gold), LaunchBackground
    └── Views/
        ├── SplashView.swift    # Animated wordmark reveal
        ├── LoginView.swift     # Email/password + guest
        ├── RootView.swift      # TabView: Home / Trips / Profile
        ├── HomeView.swift      # MapKit map + booking sheet + service classes
        ├── BookingView.swift   # Route + class picker → confirmation
        ├── TrackingView.swift  # Live driver map (MapKit) + ETA + message row
        ├── ChatView.swift      # Full chat with quick replies
        ├── TripsView.swift     # Upcoming / past trips
        └── ProfileView.swift   # Account + sign out
```

## Build it (on a Mac)

You need: macOS, **Xcode 15+**, and an Apple Developer account for device/App Store.

```bash
# 1. Install XcodeGen (one time)
brew install xcodegen

# 2. Generate the Xcode project
cd ios-native
xcodegen generate

# 3. Open and run
open ApexVIP.xcodeproj
#    → pick a simulator (e.g. iPhone 15) → Cmd-R
```

The app builds and runs **with no external dependencies** — it uses demo data
so you can see every screen immediately.

## Wiring up the backend (Firebase)

The data layer is intentionally stubbed so the project compiles out of the box.
To connect the real backend used by the web app (project `apexvip`):

1. In Xcode: **File → Add Packages** → `https://github.com/firebase/firebase-ios-sdk`
   — add `FirebaseAuth`, `FirebaseFirestore`, `FirebaseFunctions`, `FirebaseMessaging`.
2. Add your `GoogleService-Info.plist` (download from the Firebase console) to the
   `ApexVIP` target.
3. Replace the marked stubs:
   - `Store.boot()` → observe `Auth.auth().addStateDidChangeListener`
   - `ChatService.subscribe/send` → Firestore `bookings/{id}/messages` listener +
     the `sendChauffeurMessage` callable function
   - `LocationManager` already returns real GPS; write it to `drivers/{uid}` for
     the driver build.

Each stub is commented with the exact Firestore path to use, matching
`firestore.rules` in the repo root.

## Notes

- iPhone-only, portrait, iOS 16+ — matches the web app's target.
- Brand colors and the serif wordmark mirror `Theme.swift` ↔ the web CSS variables.
- This is a **foundation** covering the core booking → track → chat journey, not
  yet 100% feature parity with the web app (no payments, rewards, flight tracking
  screens yet). Those screens can be added the same way.

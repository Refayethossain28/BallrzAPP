# ApexVIP — iOS apps (Capacitor)

Wraps the existing **client** and **driver** web apps as native iOS apps you can run
on a device and submit to the App Store. It reuses 100% of the current code — the
app HTML is bundled into a native shell (WKWebView); Firebase/maps/payments still
work over the network exactly as on the web. (The **admin** app is a desktop
dashboard — keep it on the web.)

## What you need (one-time)
- A **Mac** with **Xcode** (App Store) — open it once to accept the licence.
- **CocoaPods**: `sudo gem install cocoapods` (or `brew install cocoapods`).
- **Node** (you already have it).
- An **Apple Developer Program** membership (£79/yr) to install on a real iPhone
  and to publish.

## Build an app (do this for `client`, then `driver`)
From the repo root:
```sh
cd mobile/client          # or mobile/driver
npm install
npm run build             # assembles www/ from the repo's HTML + assets
npx cap add ios           # one-time: generates the native Xcode project
npx cap open ios          # opens the project in Xcode
```

In **Xcode**:
1. Select the project → **Signing & Capabilities** → choose your **Team** (your
   Apple Developer account). Adjust the **Bundle Identifier** if needed
   (defaults: `com.apexvip.client` / `com.apexvip.driver`).
2. Plug in your iPhone, pick it as the run target, press **▶ Run** to install it.
3. To publish: **Product → Archive** → **Distribute App** → App Store Connect.

## After you change the web app
Re-bundle and re-sync — no need to regenerate the project:
```sh
cd mobile/client
npm run sync              # rebuilds www/ and copies it into the iOS project
npx cap open ios          # then Run or Archive again
```
(`npm run ios` does build + sync + open in one go.)

## App icon & splash
Set them in Xcode (Assets.xcassets → AppIcon), or use
`@capacitor/assets` to generate every size from a single 1024×1024 image:
```sh
npm i -D @capacitor/assets
npx @capacitor/assets generate --ios   # reads ./assets/icon.png + splash.png
```

## Important notes
- **Push notifications:** the web FCM/service-worker path doesn't run in the iOS
  WKWebView. For native push add `@capacitor/push-notifications` and wire APNs in
  Apple Developer + Firebase Cloud Messaging. (Not required just to run the app.)
- **Location:** if you use device GPS, add `@capacitor/geolocation` and the
  `NSLocationWhenInUseUsageDescription` key in Xcode (Info).
- **App Review (guideline 4.2):** Apple can reject apps that are "just a wrapped
  website." A real chauffeur app with live bookings, maps and push generally passes
  — lean on the native features and a polished icon/splash to be safe.
- **Payments:** real-world ride services are **exempt** from Apple's in-app-purchase
  rule, so keeping Square is fine.
- These wrappers point at the **bundled** copy of the app. To always load the live
  site instead (auto-updates, but higher 4.2 risk), set
  `"server": { "url": "https://refayethossain28.github.io/BallrzAPP/apexvip-client.html" }`
  in `capacitor.config.json` instead of bundling.

## Layout
```
mobile/
  build-www.mjs        # assembles each app's www/ from the repo
  client/  capacitor.config.json, package.json   (→ www/, ios/ generated)
  driver/  capacitor.config.json, package.json   (→ www/, ios/ generated)
```
`www/`, `ios/`, and `node_modules/` are generated and git-ignored.

# ApexVIP — iOS App

A native iOS app that wraps the ApexVIP client web app using [Capacitor](https://capacitorjs.com).
The web app lives in `www/` (a copy of `../apexvip-client.html` renamed to `index.html`),
and the generated Xcode project lives in `ios/`.

- **Bundle ID:** `com.apexvip.client`
- **Display name:** ApexVIP
- **Orientation:** portrait only
- **Permissions declared:** Location (when in use) — for the pickup map

## What you need (one-time)

1. A **Mac** with [Xcode](https://apps.apple.com/app/xcode/id497799835) installed (free).
2. An **Apple Developer account** — [developer.apple.com](https://developer.apple.com/programs/enroll/), $99/year.
   You can build and run on your own iPhone with just a free Apple ID; the paid
   account is only needed to publish to the App Store.
3. **Node.js** on the Mac ([nodejs.org](https://nodejs.org)).

## Build & run on your iPhone

```bash
git clone https://github.com/refayethossain28/BallrzAPP.git
cd BallrzAPP/ios-app
npm install
npx cap open ios        # opens the project in Xcode
```

In Xcode:

1. Select the **App** target → **Signing & Capabilities** tab.
2. Set **Team** to your Apple ID / developer team (Xcode handles certificates automatically).
3. Plug in your iPhone, select it as the run destination, and press **▶ Run**.
4. First run only: on the phone, go to *Settings → General → VPN & Device Management*
   and trust your developer certificate.

## Submit to the App Store

1. In Xcode: **Product → Archive**, then **Distribute App → App Store Connect**.
2. In [App Store Connect](https://appstoreconnect.apple.com): create the app record
   (name, screenshots, description, privacy details), attach the uploaded build,
   and **Submit for Review**. Review typically takes 1–3 days.

Apple checklist before submitting:

- [ ] Screenshots for 6.7" and 6.1" iPhones (just run in the Simulator and ⌘S)
- [ ] A privacy policy URL (required because the app uses accounts + location)
- [ ] App Privacy questionnaire in App Store Connect (declares Firebase auth,
      location use, etc.)
- [ ] Demo account credentials for the App Review team (they must be able to log in)

## Updating the app after changing the web app

Whenever `apexvip-client.html` changes:

```bash
cd ios-app
npm run sync     # copies the latest web app into www/ and into the Xcode project
```

Then rebuild in Xcode (and bump the version under App target → General before
re-submitting to the App Store).

## Notes

- The web app talks to Firebase and loads Leaflet/fonts from CDNs, so the app
  needs an internet connection — same as the website.
- Push notifications via the web service worker do **not** work inside the
  native shell. If you want native push later, add `@capacitor/push-notifications`
  and wire it to FCM.
- The app icon (1024×1024) was generated from `icon-512.png`. If you have a
  higher-resolution original, replace
  `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`.

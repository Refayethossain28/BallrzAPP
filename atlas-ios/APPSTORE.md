# Putting Atlas on the App Store

This folder is a complete native iOS wrapper for Atlas, built with Capacitor.
The web app in `../atlas` ships **inside the binary** (not a URL shell), so
App Review sees a real, working, offline-capable app.

```
atlas-ios/
  capacitor.config.json   app id (uk.apexvip.atlas), name, colours
  bundle-www.mjs          copies ../atlas → www/ with native adjustments
  ios/                    the actual Xcode project (generated, committed)
```

## What you need (only you can provide these)
1. **Apple Developer Programme** membership — £79/year, [developer.apple.com](https://developer.apple.com/programs/enroll/)
2. **A Mac with Xcode 15+** — or a cloud build service (Codemagic, Xcode
   Cloud) if you don't own a Mac

## Build steps (on the Mac)
```sh
git clone https://github.com/Refayethossain28/BallrzAPP && cd BallrzAPP/atlas-ios
npm install
npm run sync          # bundles ../atlas → www/ and syncs the iOS project
npm run open          # opens ios/App in Xcode
```
In Xcode:
1. Select the **App** target → *Signing & Capabilities* → tick "Automatically
   manage signing" and pick your Apple Developer team.
2. Set the app icon: drag `../atlas/icon-512.png` derivatives into
   `Assets.xcassets/AppIcon` (Xcode 15 accepts a single 1024×1024 — export
   one with `sips -z 1024 1024 ../atlas/icon-512.png --out icon-1024.png`).
3. Product → Run on your own iPhone first. Drive with it.
4. Product → Archive → *Distribute App* → App Store Connect → Upload.

Then in [App Store Connect](https://appstoreconnect.apple.com): create the
app (bundle id `uk.apexvip.atlas`), fill the listing (screenshots are in
`../atlas/screenshots/`), complete the privacy questionnaire, submit.

## Privacy questionnaire answers (truthful for this app)
- Data collected: **none**. No analytics, no accounts, no identifiers.
  Location and camera are used on-device only and never transmitted to the
  developer. (Map tiles/routing requests go to OpenStreetMap-ecosystem
  servers as with any map app.)
- Permission strings are already in `ios/App/App/Info.plist`.

## App Review — the three rules that matter here

**3.1.1 (in-app purchase).** Digital upgrades sold *inside* an iOS app must
use Apple's IAP. The native build therefore hides the Stripe Buy button and
all external pricing automatically (`window.ATLAS_NATIVE` is injected by
`bundle-www.mjs`; the web app checks it). The code box stays — codes bought
elsewhere may activate the app under the multiplatform rule 3.1.3(b), as
long as the app doesn't *direct* users to buy outside.

To actually sell Pro inside the iOS app later, add StoreKit: create a
non-consumable product in App Store Connect, add a Capacitor IAP plugin
(e.g. `@capgo/native-purchases` or RevenueCat), and on successful purchase
call the same activation path the code box uses (`save('atlas.pro', true)`).
Apple takes 15% (Small Business Programme) — price the IAP at £14.99 and
keep ~£12.74/sale.

**4.2 (minimum functionality).** Wrapper apps get rejected when they're a
website in a frame. Atlas ships its whole engine in the binary, works with
no network (demo drive, offline packs, trail-back), and uses device GPS,
camera and speech — that is a real app. If a reviewer still pushes back,
the reply is: from-scratch canvas map engine, 71-unit-test navigation core,
offline routing demo, on-device dashcam — none of which exists on a website
outside the bundle.

**5.2.5 / maps.** Atlas uses OpenStreetMap data with attribution shown
in-app (bottom-left). Keep that attribution visible.

## Ongoing
- Each release: bump `MARKETING_VERSION` in Xcode, `npm run sync`, Archive,
  upload. The web app at apexvip.uk and the App Store app share the same
  `../atlas` source — fix once, ship both.
- The £79/year and Apple's cut apply only to the App Store channel. The
  web app at apexvip.uk stays 100% yours with Stripe.

# Fixr Driver app

A working **mobile-web driver app (PWA)** lives at `/driver/?d=<driverId>` — served
by the same Express server, talking to the same REST API as dispatch. It's usable
on any phone today: open the link, "Add to Home Screen," and it runs full-screen.

## What it does (real, today)

- **Assigned trips** — the driver sees only their trips (`GET /api/driver/:id/trips`),
  polled every 15s for new assignments.
- **Live location** — "Start sharing location" uses the browser's real
  `navigator.geolocation.watchPosition` and pings `POST /api/driver/:id/location`;
  dispatch stores `last_lat/last_lng` on the driver.
- **Trip lifecycle** — "Start trip (en route)" and "Complete trip" hit the same
  `/api/requests/:id/enroute` and `/complete` endpoints dispatch uses (completion
  captures the fare and settles the driver).
- **Flight status** — airport trips show live flight status inline.
- **Navigate** — opens Google Maps to the dropoff.
- **Payouts** — if the driver hasn't onboarded to Stripe Connect, a banner offers
  "Set up payouts" → `POST /api/drivers/:id/connect/onboard` → hosted onboarding.

Identity is passed via the link the dispatcher shares (`?d=d3`). A production build
would replace that with a real driver login.

## Why a PWA, not React Native (yet)

The honest tradeoff: a true native app gives you **true background GPS** (location
while the app is closed/backgrounded) and push notifications — but it requires
Xcode / Android Studio / an EAS cloud build and an app-store release, none of which
can be produced or verified from a server environment. The PWA:

- works on every phone **now**, no install friction, no app-store review,
- shares 100% of its API surface with the future native app,
- does **foreground** GPS (while the trip screen is open) — fine for "I'm on the
  trip" tracking.

## Upgrading to native (background GPS) later

The fastest path that **reuses everything here**: wrap this PWA in an Expo app and
add a background-location task.

1. `npx create-expo-app fixr-driver`
2. Render the hosted PWA in a `react-native-webview`, **or** rebuild the (small) UI
   natively against the same endpoints.
3. Add background GPS with `expo-location`:
   ```js
   import * as Location from "expo-location";
   import * as TaskManager from "expo-task-manager";
   TaskManager.defineTask("fixr-bg-loc", ({ data }) => {
     const { latitude, longitude } = data.locations[0].coords;
     fetch(`${API}/api/driver/${driverId}/location`, {
       method: "POST", headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ lat: latitude, lng: longitude }),
     });
   });
   await Location.startLocationUpdatesAsync("fixr-bg-loc", { accuracy: Location.Accuracy.High });
   ```
4. `eas build` for TestFlight / Play internal testing.

The server, endpoints, and data model don't change — only the GPS surface upgrades
from foreground (PWA) to background (native).

# ◮ Atlas — acquisition brief

**One line:** a complete, modern turn-by-turn satnav — voice guidance, live
traffic, lane guidance, 3D map, dashcam, offline packs — built as a single
installable web app with **zero per-user cost**, a **unit-tested navigation
engine**, and a set of features **no shipping satnav has**.

Live: https://apexvip.uk/atlas/ · © all rights reserved (see /LICENSE)

## Why it's interesting to an acquirer

**1. Feature surface of a flagship, footprint of a web page.**
Everything below ships today, in ~1 file + a pure engine, installable on any
phone with no app-store gatekeeper:

| Table stakes (all present) | Differentiators (nobody ships these) |
|---|---|
| Voice turn-by-turn, rerouting | 🌅 Sun-glare forecast (solar ephemeris per route segment) |
| Live traffic + incident re-ranking | 🏁 Rally co-driver pace notes from route curvature |
| Lane guidance (real OSM lane data) | 🍞 Trail-back: navigate home along your own breadcrumbs, zero network |
| Junction views (auto-generated schematics) | 📹 Dashcam with telemetry burn-in + on-device clip vault |
| Speed limits, fixed cameras | ⌀ Average-speed zones with **your live zone average** |
| ⭐ 3D buildings, satellite, day/night cartography | 🚙 Convoys: live multi-driver map, invite links |
| Offline route packs | ⏱ ETA that learns the driver's personal pace |
| Music player with voice ducking | 🛰 Tunnel-proof dead-reckoning ghost mode |

**2. Engineering quality is verifiable, not claimed.**
The navigation core — geodesy, polyline codec, snap-to-route, the guidance
state machine, phrasing, traffic/ETA arithmetic, camera/zone logic — is one
pure, deterministic, dependency-free engine (`engine.js`) with **71 unit
tests**, including "does it say *turn left* at the right moment" as an
assertion. Zero frameworks, zero build step, no map SDK: the slippy-map
renderer (tiles, 3D tilt, extruded buildings) is from scratch on canvas.

**3. Cost structure a CFO can love.**
No servers. Data comes from swappable community tiers (OSM/CARTO/Esri tiles,
OSRM/FOSSGIS routing, Overpass, TfL open data) — each has a drop-in
commercial equivalent (TomTom/HERE/Mapbox keys) already scaffolded in
`config.js`. Per-user marginal cost today: ~£0.

**4. Revenue lever already installed.**
⭐ Atlas Pro: entitlement engine + offline-verifiable unlock codes
(`scripts/gen-atlas-pro-codes.mjs`) — sellable via any payment link with no
account system. Swap for Stripe/IAP post-acquisition without rearchitecting.

**5. Privacy-native.**
No account, no telemetry, all data (drives, clips, music, packs) on-device.
GDPR posture: nothing to breach. The privacy story is the marketing story.

## What the buyer would do with it
- Ship it under their brand (white-label: it's one file + one engine)
- Swap community data tiers for their commercial feeds (integration points
  are isolated: `TILE_URL`, `ROUTERS`, `OVERPASS`, `fetchTraffic`)
- Wrap for the app stores (PWA → TWA/Capacitor is mechanical)
- Turn convoys/drives into consented fleet data

## Clean-out plan
Atlas is fully self-contained (`atlas/` + its test/icon scripts). Carve-out
to a standalone repo is a copy; no shared runtime with sibling apps. IP:
single copyright holder, all rights reserved, no copyleft dependencies
(there are **no** dependencies).

## Honest gaps a buyer should know
- Traffic depth: TfL (London) keyless; worldwide needs a TomTom/HERE key
- Search is Nominatim (rate-limited community tier)
- No accounts/cloud sync by design (Firebase scaffold exists for convoys)
- Traction metrics: early — the product is ahead of its distribution

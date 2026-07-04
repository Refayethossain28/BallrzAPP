#!/usr/bin/env bash
# Assemble the GitHub Pages site — the single source of truth for what ships.
#
# Used by BOTH .github/workflows/pages.yml (the real deploy) and the CI `site`
# job (which then runs scripts/check-site.mjs over the result), so "the deploy
# allowlist forgot a file" fails CI instead of 404ing in production. The two
# heavyweight, separately-built additions — /apex (Vite build) and /llm
# (trained model) — are appended by the Pages workflow after this script.
#
# Usage: bash scripts/assemble-site.sh [outdir]   (default: _site)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-_site}"
mkdir -p "$OUT"

# ApexVIP apps + every PWA asset, at the site root.
cp apexvip-client.html apexvip-driver.html apexvip-admin.html "$OUT"/ 2>/dev/null || true
cp apexvip-core.js apexvip-lib.js apexvip-engine.js apexvip-track.js firebase.js firebase-messaging-sw.js "$OUT"/ 2>/dev/null || true
cp manifest*.json "$OUT"/ 2>/dev/null || true
cp icon-*.png "$OUT"/ 2>/dev/null || true
cp -r splashes "$OUT"/ 2>/dev/null || true
# Splash / tour background videos (client, driver and admin apps reference
# these at the site root — without them the splash renders plain black).
cp splash-advert.mp4 splash-bg.mp4 tour-bg.mp4 "$OUT"/ 2>/dev/null || true

# Landing page + Jekyll opt-out so files starting with _ are served.
cp index.html "$OUT"/index.html 2>/dev/null || true
cp .nojekyll "$OUT"/.nojekyll 2>/dev/null || touch "$OUT"/.nojekyll

# RentMatch prototype + its PWA assets (manifest*.json above does not match
# rentmatch-manifest.json, so copy them explicitly).
cp rentmatch.html "$OUT"/ 2>/dev/null || true
cp rentmatch-manifest.json rentmatch-sw.js "$OUT"/ 2>/dev/null || true
cp rentmatch-icon-*.png rentmatch-icon.svg "$OUT"/ 2>/dev/null || true

# Runnable prototypes keep their original paths.
mkdir -p "$OUT"/concepts
cp -r concepts/prototypes "$OUT"/concepts/ 2>/dev/null || true

# FX trading app.
mkdir -p "$OUT"/trading-app
cp trading-app/fx-signal-pro.html "$OUT"/trading-app/ 2>/dev/null || true

# Ripple messenger — full PWA (app, engine, QR encoder, config, SW, icons).
mkdir -p "$OUT"/ripple
cp -r ripple/. "$OUT"/ripple/ 2>/dev/null || true

# ApexVIP Concierge (concierge/, incl. the ops app) + the other standalone
# PWAs the landing page links to.
for app in concierge cusp omni imposter lingua; do
  mkdir -p "$OUT/$app"
  cp -r "$app/." "$OUT/$app/" 2>/dev/null || true
done

# Fixr — static demo only (the full app is a Node server; see fixr/app/DEPLOY.md).
mkdir -p "$OUT"/fixr
cp fixr/index.html "$OUT"/fixr/index.html 2>/dev/null || true

echo "Assembled $OUT:"; ls -1 "$OUT" | head -40

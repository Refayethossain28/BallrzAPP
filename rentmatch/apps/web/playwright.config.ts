import { defineConfig } from '@playwright/test';

/**
 * E2E config. Run against the dev server with the Firebase Emulator Suite up:
 *   VITE_USE_EMULATORS=1 npm run dev   # terminal 1 (with emulators started)
 *   npm run e2e                        # terminal 2
 */
// Use a pre-installed Chromium when one is provided via PW_CHROMIUM_PATH (its
// build may differ from the pinned @playwright/test version); otherwise let
// Playwright resolve its own managed browser.
const chromiumPath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
    // Dummy Firebase config so the client initialises and auth resolves to
    // "signed out" (no network needed for an empty session), letting the
    // sign-in screen render without the emulator suite.
    env: {
      VITE_FIREBASE_API_KEY: 'demo-api-key',
      VITE_FIREBASE_AUTH_DOMAIN: 'demo.firebaseapp.com',
      VITE_FIREBASE_PROJECT_ID: 'demo-rentmatch',
      VITE_FIREBASE_STORAGE_BUCKET: 'demo-rentmatch.appspot.com',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '0',
      VITE_FIREBASE_APP_ID: 'demo-app-id',
    },
  },
});

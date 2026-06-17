import { defineConfig } from '@playwright/test';

/**
 * E2E config. Run against the dev server with the Firebase Emulator Suite up:
 *   VITE_USE_EMULATORS=1 npm run dev   # terminal 1 (with emulators started)
 *   npm run e2e                        # terminal 2
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:5173', headless: true },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

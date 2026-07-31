import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Alias the shared callable contract to the canonical copy in functions/src.
// It's imported type-only, so it's erased at build time — no backend code ships
// to the browser; the web bundle and the Cloud Functions just share one set of
// request/response types.
export default defineConfig({
  resolve: {
    alias: {
      '@apexvip/contract': fileURLToPath(new URL('../functions/src/contract.ts', import.meta.url)),
    },
  },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Builds the pure shared logic into a committed IIFE at the repo root,
// `apexvip-engine.js`, exposing `window.ApexEngine`. The single-file HTML apps
// load it so they stop carrying their own copies of the concierge parser, fare
// math, etc. Pure code only — the contract alias is type-only and erased.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@apexvip/contract': fileURLToPath(new URL('../functions/src/contract.ts', import.meta.url)),
    },
  },
  build: {
    outDir: REPO_ROOT,
    emptyOutDir: false, // CRITICAL: never wipe the repo root
    minify: true,
    lib: {
      entry: fileURLToPath(new URL('./src/engine.ts', import.meta.url)),
      name: 'ApexEngine',
      formats: ['umd'], // browser global `ApexEngine` AND require()-able for tests
      fileName: () => 'apexvip-engine.js',
    },
  },
});

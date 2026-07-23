import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Apex — the UK landlord OS',
        short_name: 'Apex',
        description: 'Compliance autopilot, rent tracking and tax-ready finances for UK landlords.',
        // Relative URLs so the installed app opens wherever the site is served
        // (Firebase Hosting at /, the Pages demo at /BallrzAPP/apex/). An
        // absolute start_url of '/' 404s when installed from a subpath.
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#0b0f1a',
        theme_color: '#0b0f1a',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});

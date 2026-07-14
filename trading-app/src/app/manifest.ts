import type { MetadataRoute } from 'next'

// Served by Next.js at /manifest.webmanifest
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ApexFX — Currency Trading Analysis',
    short_name: 'ApexFX',
    description:
      'Real-time forex analysis with buy/sell signals, take profit, stop loss, and AI insights',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#0f1117',
    theme_color: '#0f1117',
    categories: ['finance', 'business', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

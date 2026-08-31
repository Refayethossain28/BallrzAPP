/**
 * fare/public/sw.js — small offline cushion for the Fare shell.
 * Network-first (so deploys land immediately), cache fallback (so the app
 * shell still opens in a dead spot). API calls are never cached — job and
 * invoice data must always be live.
 */
const CACHE = 'fare-shell-v1';
const SHELL = ['./', 'index.html', 'app.js', 'engine.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET' || url.pathname.includes('/api/')) return; // live only
  ev.respondWith(
    fetch(ev.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(ev.request, copy));
        return res;
      })
      .catch(() => caches.match(ev.request, { ignoreSearch: true }))
  );
});

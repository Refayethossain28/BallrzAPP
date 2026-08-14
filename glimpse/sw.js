/* Offline service worker for Glimpse. One HTML file plus the engine, so
 * navigations are network-first (freshest build online, cached shell offline)
 * and static assets are cache-first for speed. Bump CACHE to force a clean
 * reinstall. */
const CACHE = 'glimpse-v7';
const ASSETS = ['./', './index.html', './engine.js', './config.js',
                './manifest.json', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // let the SDK/CDN requests pass through
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }))
  );
});

/* tap-to-update: activate the new version when the page asks */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* Web push (FCM): the page registers its token against THIS worker, so
 * incoming pushes land here — display the payload and focus the app on tap. */
self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (err) {}
  const n = p.notification || {};
  e.waitUntil(self.registration.showNotification(n.title || 'Glimpse', {
    body: n.body || '',
    icon: './icon.svg',
    badge: './icon.svg',
    data: { url: (p.data && p.data.url) || './' },
    tag: (p.data && p.data.tag) || 'glimpse',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (w.url.indexOf('/glimpse') !== -1) return w.focus();
    }
    return clients.openWindow(url);
  }));
});

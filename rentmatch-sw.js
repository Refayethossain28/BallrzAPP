/* RentMatch service worker — offline app-shell cache.
 *
 * This SW lives at the repo root, which it shares with other prototypes on the
 * same origin. To avoid hijacking their requests, the fetch handler ONLY takes
 * over RentMatch's own URLs (anything containing "rentmatch"); everything else
 * falls through to the network untouched. The HTML document is network-first
 * (so deployed fixes show up on the next load, with a cached offline fallback);
 * static assets are cache-first. Bump CACHE to evict a stale shell. */
const CACHE = 'rentmatch-v2';
const ASSETS = [
  './rentmatch.html',
  './rentmatch-manifest.json',
  './rentmatch-icon.svg',
  './rentmatch-icon-180.png',
  './rentmatch-icon-192.png',
  './rentmatch-icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isOurs = url.origin === self.location.origin && url.pathname.includes('rentmatch');
  if (!isOurs) return; // leave other apps on this origin alone

  // Network-first for the app page so deployed fixes are picked up immediately;
  // fall back to the cached shell when offline.
  const isDoc = req.mode === 'navigate' || url.pathname.endsWith('rentmatch.html');
  if (isDoc) {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./rentmatch.html'))),
    );
    return;
  }

  // Cache-first for static assets (icons, manifest), with a network fill.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return resp;
      }),
    ),
  );
});

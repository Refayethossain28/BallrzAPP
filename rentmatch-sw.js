/* RentMatch service worker — offline app-shell cache.
 *
 * This SW lives at the repo root, which it shares with other prototypes on the
 * same origin. To avoid hijacking their requests, the fetch handler ONLY takes
 * over RentMatch's own URLs (anything containing "rentmatch"); everything else
 * falls through to the network untouched. Cache-first for the shell, with a
 * network fill and an offline fallback to the app page. Bump CACHE to update. */
const CACHE = 'rentmatch-v1';
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

  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match('./rentmatch.html')),
    ),
  );
});

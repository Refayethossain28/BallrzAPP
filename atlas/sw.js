/* Offline service worker for Atlas. The app shell (one HTML file + the
 * engine) is network-first for navigations — latest build online, cached
 * shell offline — and cache-first for static assets. Map tiles are cached
 * opportunistically in their own bounded cache so areas you've seen keep
 * working offline; routing/search requests are never cached (live answers
 * or an honest failure). Bump CACHE to force a clean reinstall. */
const CACHE = 'atlas-v32';
const TILE_CACHE = 'atlas-tiles-v1';
const OFFLINE_CACHE = 'atlas-offline-v1'; // downloaded route packs — never trimmed
const TILE_LIMIT = 600;
const ASSETS = ['./', './index.html', './engine.js', './config.js', './manifest.json',
                './icon.svg', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE && k !== OFFLINE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  if (keys.length <= TILE_LIMIT) return;
  for (const k of keys.slice(0, keys.length - TILE_LIMIT)) await c.delete(k);
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const req = e.request;
  const url = new URL(req.url);

  // map + satellite tiles: cache-first with background top-up, bounded cache
  if (/tile\.openstreetmap\.org$/.test(url.hostname) ||
      /basemaps\.cartocdn\.com$/.test(url.hostname) ||
      (/server\.arcgisonline\.com$/.test(url.hostname) && /World_Imagery/.test(url.pathname))) {
    // check every cache — offline route packs answer here too, so a saved
    // route's map renders with no signal at all
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(TILE_CACHE)
              .then((c) => c.put(req, copy).then(trimTiles))
              .catch(() => {});
          }
          return resp;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // routing / geocoding: live only — a stale route is worse than no route
  if (/routing\.openstreetmap\.de|router\.project-osrm\.org|nominatim\.openstreetmap\.org/.test(url.hostname)) return;

  const isPage = req.mode === 'navigate' ||
                 (req.destination === '' && /\/(index\.html)?(\?.*)?$/.test(url.pathname));
  if (isPage) {
    e.respondWith(
      fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => undefined)
    )
  );
});

/* tap-to-update: activate the new version when the page asks */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

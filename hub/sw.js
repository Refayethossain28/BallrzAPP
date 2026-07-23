/* Ballrz Hub service worker — precache the shell, runtime-cache the app icons
   the tiles pull from sibling app folders (../imposter/icon-192.png etc.). */
'use strict';
const SHELL = 'hub-shell-v2';
const RUNTIME = 'hub-runtime-v1';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Shell: network-first, cache fallback — new app tiles reach returning
  // visitors on their next online visit, no cache-version bump required.
  const scope = new URL('./', location.href).pathname;
  if (url.pathname.startsWith(scope)) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Sibling-app tile icons: stale-while-revalidate so the grid renders offline.
  if (/\.(png|svg)$/.test(url.pathname)) {
    e.respondWith(
      caches.open(RUNTIME).then((c) =>
        c.match(req).then((hit) => {
          const refresh = fetch(req).then((res) => {
            if (res.ok) c.put(req, res.clone());
            return res;
          }).catch(() => hit);
          return hit || refresh;
        })
      )
    );
  }
  // Everything else (navigating into an app) goes straight to the network.
});

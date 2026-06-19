/* Offline service worker for Ripple. The app is one HTML file plus the engine,
 * so navigations are network-first (you always get the freshest build online,
 * the cached shell when offline) and static assets are cache-first for speed.
 * Bump CACHE to force a clean reinstall.
 *
 * This SW doubles as the Firebase Cloud Messaging worker so push notifications
 * arrive when the app is closed. The import is wrapped in try/catch: if the SDK
 * can't load (e.g. offline at install), messaging is simply unavailable and the
 * offline shell below keeps working. With a `notification` payload the SDK shows
 * and routes the notification itself, so we don't add our own push handler. */
try {
  importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: 'AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI',
    authDomain: 'apexvip-1b4a9.firebaseapp.com',
    projectId: 'apexvip-1b4a9',
    storageBucket: 'apexvip-1b4a9.firebasestorage.app',
    messagingSenderId: '254410067879',
    appId: '1:254410067879:web:754b71a35182c997f37082'
  });
  firebase.messaging();
} catch (e) { /* messaging unavailable — offline shell still works */ }

const CACHE = 'ripple-v7';
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const req = e.request;
  const isPage = req.mode === 'navigate' ||
                 (req.destination === '' && /\/(index\.html)?(\?.*)?$/.test(new URL(req.url).pathname));

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
    caches.match(req).then((hit) => hit || fetch(req).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return resp;
    }).catch(() => hit))
  );
});

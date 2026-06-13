// ApexVIP Service Worker — Push Notifications + Offline PWA shell
// Version 3.0

const CACHE_NAME = 'apexvip-v5';
const OFFLINE_URLS = [
  '/apexvip-client.html',
  '/apexvip-driver.html',
  '/apexvip-dubai.html',
  '/apexvip-admin.html',
  '/apexvip-core.js',
  '/firebase.js',
  '/manifest.json',
  '/manifest-driver.json',
  '/manifest-admin.json',
  '/manifest-dubai.json',
  '/icon-60.png',
  '/icon-120.png',
  '/icon-152.png',
  '/icon-167.png',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
];

// ── Install: pre-cache the app shell ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(OFFLINE_URLS).catch(() => {})
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for HTML/JS, cache fallback for offline ─────────────
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then(resp => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Offline Booking Queue ─────────────────────────────────────────────────────
const QUEUE_KEY = 'apexvip_offline_bookings';

self.addEventListener('sync', event => {
  if (event.tag === 'booking-sync') {
    event.waitUntil(flushBookingQueue());
  }
});

async function flushBookingQueue() {
  const db = await openQueueDB();
  const tx = db.transaction('queue', 'readwrite');
  const store = tx.objectStore('queue');
  const all = await storeGetAll(store);

  for (const entry of all) {
    try {
      const resp = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.data),
      });
      if (resp.ok) {
        await store.delete(entry.id);
        const wins = await clients.matchAll({ type: 'window' });
        wins.forEach(w => w.postMessage({ type: 'BOOKING_QUEUED_SYNCED', ref: entry.data.ref }));
      }
    } catch(e) {
      console.warn('Queue flush failed for', entry.id, e.message);
    }
  }
}

function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('apexvip-queue', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function storeGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

self.addEventListener('message', event => {
  if (event.data?.type === 'QUEUE_BOOKING') {
    openQueueDB().then(db => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').add({ data: event.data.booking, queuedAt: Date.now() });
      self.registration.sync?.register('booking-sync').catch(() => {});
    });
  }
});

// ── Firebase Cloud Messaging ──────────────────────────────────────────────────
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  const screen = payload.data?.screen || 'home';

  self.registration.showNotification(title || 'ApexVIP', {
    body: body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { screen },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' }
    ],
    vibrate: [200, 100, 200],
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const screen = event.notification.data?.screen || 'home';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      if (wins.length > 0) {
        wins[0].focus();
        wins[0].postMessage({ type: 'NAVIGATE', screen });
      } else {
        clients.openWindow('/apexvip-client.html');
      }
    })
  );
});

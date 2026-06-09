// Firebase Cloud Messaging service worker
// Handles background push notifications for ApexVIP

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// NOTE: This config is intentionally public (it's the Firebase SDK config, not a secret)
firebase.initializeApp({
  apiKey: "AIzaSyAr3OsrEG3yVx-bD3jxc_kSBY7bkCQUPxI",
  authDomain: "apexvip-1b4a9.firebaseapp.com",
  projectId: "apexvip-1b4a9",
  messagingSenderId: "254410067879",
  appId: "1:254410067879:web:754b71a35182c997f37082"
});

const messaging = firebase.messaging();

// Handle background messages
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification || {};
  const screen = payload.data?.screen || 'home';

  self.registration.showNotification(title || 'ApexVIP', {
    body: body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: { screen },
    actions: [{ action: 'open', title: 'Open' }],
  });
});

// Click handler — focus or open the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const screen = event.notification.data?.screen || 'home';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      if (wins.length > 0) {
        wins[0].focus();
        wins[0].postMessage({ type: 'NAVIGATE', screen });
      } else {
        clients.openWindow('/');
      }
    })
  );
});

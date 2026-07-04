/**
 * ApexVIP — the shared analytics pipeline (one copy, every app).
 *
 * Every ApexVIP surface reports through the same contract: an event is
 * appended to the local `apexvip_events` log (capped, offline-safe) and, when
 * Firebase is up, mirrored to the shared Firestore `analytics` collection
 * that the admin console aggregates across the client, driver, admin,
 * concierge and ops apps.
 *
 * Usage (classic script, load before app code):
 *   const track = createApexTrack('client', { getDb: () => (FIREBASE_ENABLED ? db : null) });
 *   track('booking_confirmed', { price: 185 });
 *
 * opts.getDb   → returns a Firestore instance or null (null = local-only)
 * opts.canSend → optional extra gate (e.g. analytics consent, signed-in)
 * opts.onError → optional handler for a failed Firestore mirror write
 *
 * The concierge PWA (concierge/) keeps a byte-identical inline copy in
 * cloud.js on purpose: its service worker only caches its own directory, so
 * a root-level script would break its offline install. The engine test suite
 * pins the two implementations' behaviour together.
 */
function createApexTrack(src, opts) {
  opts = opts || {};
  return function track(event, props) {
    try {
      var ev = Object.assign({ e: event, event: event, t: Date.now(), ts: Date.now(), src: src }, props || {});
      var key = 'apexvip_events';
      var arr = JSON.parse(localStorage.getItem(key) || '[]');
      arr.push(ev);
      if (arr.length > 2000) arr.splice(0, arr.length - 2000);
      localStorage.setItem(key, JSON.stringify(arr));
      var db = opts.getDb ? opts.getDb() : null;
      if (db && (!opts.canSend || opts.canSend())) {
        db.collection('analytics').add(ev).catch(opts.onError || function () {});
      }
    } catch (e) {}
  };
}
if (typeof window !== 'undefined') window.createApexTrack = createApexTrack;
if (typeof module !== 'undefined' && module.exports) module.exports = createApexTrack;

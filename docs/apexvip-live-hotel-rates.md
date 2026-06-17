# ApexVIP — Live Hotel Rates (Amadeus)

The client app (`apexvip-client.html`) shows **dynamic hotel pricing** that responds
to check-in date, length of stay, weekend/season, demand (lead time) and occupancy.
Today those numbers come from a **local estimate** (`_estimateHotelRate`). This doc
explains how to swap in **real live rates from Amadeus** without touching the UI.

## Why a backend is required

Hotel pricing APIs (Amadeus included) authenticate with a **secret** and block
browser CORS. The key must never ship in the static HTML. So the client calls a
Firebase **callable Cloud Function** (`getHotelRates`) that holds the secret and
proxies Amadeus server-side — exactly like the existing `parseBookingIntent` and
`checkFlightStatus` functions.

## The seam (already in the client)

`fetchHotelRate(hotel, checkIn, nights, guests)` in `apexvip-client.html`:

```js
async function fetchHotelRate(hotel, checkIn, nights, guests){
  if (FIREBASE_ENABLED && fns) {
    try {
      const fn = fns.httpsCallable('getHotelRates');
      const res = await fn({ name:hotel.name, lat:hotel.lat, lng:hotel.lng, checkIn, nights, guests, currency:'GBP' });
      if (res?.data?.nightly) return { ...res.data, live:true, fetchedAt:Date.now() };
    } catch(e) { /* fall back to local estimate */ }
  }
  return _estimateHotelRate(hotel, checkIn, nights, guests);
}
```

When the function exists and returns a quote, cards show **● Live rates**; otherwise
they show **Live estimate**. The function must return this shape (GBP):

```json
{ "nightly": 995, "from": 965, "total": 1995, "nights": 2, "guests": 2,
  "currency": "GBP", "checkIn": "2026-07-03", "available": true }
```

Each hotel in the `HOTELS` array carries `lat`/`lng` so the function can resolve the
Amadeus property by geocode.

## Cloud Function (Amadeus Self-Service)

1. **Get keys:** https://developers.amadeus.com → Self-Service → create an app →
   `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET`. Test environment is free; switch the
   host to `api.amadeus.com` for production (paid).
2. **Store secrets:**
   ```sh
   firebase functions:secrets:set AMADEUS_CLIENT_ID
   firebase functions:secrets:set AMADEUS_CLIENT_SECRET
   ```
3. **Flow inside the function:**
   - OAuth2 token: `POST https://test.api.amadeus.com/v1/security/oauth2/token`
     (`grant_type=client_credentials`). Cache it ~25 min.
   - Hotels by geocode: `GET /v1/reference-data/locations/hotels/by-geocode?latitude=..&longitude=..&radius=1&radiusUnit=KM`
     → take the nearest `hotelId`.
   - Live offers: `GET /v3/shopping/hotel-offers?hotelIds=ID&checkInDate=..&checkOutDate=..&adults=..&currency=GBP&bestRateOnly=true`.
   - Map `data[0].offers[0].price.total` → `total`; `total / nights` → `nightly`; the
     lowest nightly across offers → `from`. Return the shape above.
4. **Deploy:** `firebase deploy --only functions:getHotelRates`.

### Notes
- The **test** environment has limited/cached inventory and may not cover every
  luxury property — expect gaps and fall back to the estimate. Production inventory
  is broader but contracted/paid.
- Cache quotes (e.g. Firestore, 15–30 min TTL) keyed by `hotelId|checkIn|nights|guests`
  to stay within rate limits.
- For real bookings, Amadeus Self-Service is **shop-only** for hotels in many markets;
  the "Book hotel" button intentionally deep-links to each hotel's official site, so
  no booking-API contract is needed for the current UX.

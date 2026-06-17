/**
 * ApexVIP Cloud Functions — getHotelRates
 *
 * Live hotel pricing for the client app (`apexvip-client.html`). The browser must
 * never hold the Amadeus secret, so the client calls this callable function, which
 * proxies Amadeus server-side and returns a quote in the exact shape the client's
 * `fetchHotelRate()` expects. If this function is absent or errors, the client
 * silently falls back to its local estimate — so a partial deploy never breaks the UI.
 *
 * Firebase Functions v2 (2nd gen). Node 20 provides a global `fetch`.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

// Secrets — set once with: firebase functions:secrets:set AMADEUS_CLIENT_ID
const AMADEUS_CLIENT_ID = defineSecret('AMADEUS_CLIENT_ID');
const AMADEUS_CLIENT_SECRET = defineSecret('AMADEUS_CLIENT_SECRET');

// Test by default (free, limited inventory). For production set AMADEUS_HOST to
// https://api.amadeus.com via a functions/.env file or --set-env-vars.
const AMADEUS_HOST = process.env.AMADEUS_HOST || 'https://test.api.amadeus.com';

// In-memory OAuth2 token cache (per warm instance)
let _token = null; // { value, expiresAt }

async function getToken(clientId, clientSecret) {
  if (_token && _token.expiresAt > Date.now() + 60_000) return _token.value;
  const res = await fetch(`${AMADEUS_HOST}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Amadeus auth failed: ${res.status}`);
  const data = await res.json();
  _token = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 1799) * 1000,
  };
  return _token.value;
}

function isoPlusDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const round5 = (x) => Math.round(x / 5) * 5;

exports.getHotelRates = onCall(
  { secrets: [AMADEUS_CLIENT_ID, AMADEUS_CLIENT_SECRET], region: 'us-central1' },
  async (request) => {
    const { name, lat, lng, checkIn, nights = 1, guests = 2, currency = 'GBP' } =
      request.data || {};

    if (lat == null || lng == null || !checkIn) {
      throw new HttpsError('invalid-argument', 'lat, lng and checkIn are required');
    }

    const nightCount = Math.max(1, Math.min(14, Number(nights) || 1));
    const adults = Math.max(1, Math.min(9, Number(guests) || 2));
    const checkOut = isoPlusDays(checkIn, nightCount);

    let token;
    try {
      token = await getToken(AMADEUS_CLIENT_ID.value(), AMADEUS_CLIENT_SECRET.value());
    } catch (err) {
      logger.error('Amadeus auth error', err);
      throw new HttpsError('unavailable', 'Hotel rate provider is unavailable');
    }
    const auth = { Authorization: `Bearer ${token}` };

    // 1) Resolve the nearest Amadeus hotelId(s) by geocode.
    const geoUrl =
      `${AMADEUS_HOST}/v1/reference-data/locations/hotels/by-geocode` +
      `?latitude=${lat}&longitude=${lng}&radius=1&radiusUnit=KM&hotelSource=ALL`;
    let hotelIds = [];
    try {
      const geoRes = await fetch(geoUrl, { headers: auth });
      if (geoRes.ok) {
        const geo = await geoRes.json();
        hotelIds = (geo.data || []).slice(0, 8).map((h) => h.hotelId).filter(Boolean);
      } else {
        logger.warn(`geocode ${geoRes.status} for ${name}`);
      }
    } catch (err) {
      logger.error('geocode error', err);
    }
    if (!hotelIds.length) return { name, currency, checkIn, available: false };

    // 2) Live offers for the stay.
    const offUrl =
      `${AMADEUS_HOST}/v3/shopping/hotel-offers` +
      `?hotelIds=${hotelIds.join(',')}` +
      `&checkInDate=${checkIn}&checkOutDate=${checkOut}` +
      `&adults=${adults}&roomQuantity=1&currency=${currency}&bestRateOnly=true`;

    let offers = [];
    try {
      const offRes = await fetch(offUrl, { headers: auth });
      if (offRes.ok) {
        const off = await offRes.json();
        for (const entry of off.data || []) {
          for (const o of entry.offers || []) {
            const total = parseFloat(o.price && o.price.total);
            if (!Number.isNaN(total)) offers.push(total);
          }
        }
      } else {
        // 4xx here usually means no availability for these dates/occupancy.
        logger.info(`no offers (${offRes.status}) for ${name} ${checkIn}`);
      }
    } catch (err) {
      logger.error('hotel-offers error', err);
    }

    if (!offers.length) return { name, currency, checkIn, available: false };

    // price.total is the whole-stay total per offer → derive nightly.
    const lowestTotal = Math.min(...offers);
    return {
      nightly: round5(lowestTotal / nightCount),
      from: round5(lowestTotal / nightCount),
      total: round5(lowestTotal),
      nights: nightCount,
      guests: adults,
      currency,
      checkIn,
      available: true,
    };
  }
);

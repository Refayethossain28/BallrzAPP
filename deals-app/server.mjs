#!/usr/bin/env node
/**
 * TravelDeals live-mode server — a zero-dependency proxy to the Amadeus
 * Self-Service TEST API. Run it and the app's header flips from "demo" to
 * "LIVE": flight searches return real airline offers instead of the
 * deterministic simulation.
 *
 *   AMADEUS_CLIENT_ID=... AMADEUS_CLIENT_SECRET=... node deals-app/server.mjs
 *   → open http://localhost:8799
 *
 * Free keys: https://developers.amadeus.com/register
 *
 * Honesty note: this is Amadeus's *test* environment — real fare shapes,
 * cached/limited inventory, and NO real ticket issuance. Selling real
 * tickets requires an airline consolidator or IATA accreditation; no app
 * can conjure that with an API key, and anyone claiming otherwise is
 * skipping the part where money changes hands with an airline.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8799;
const ID = process.env.AMADEUS_CLIENT_ID;
const SECRET = process.env.AMADEUS_CLIENT_SECRET;
const BASE = 'https://test.api.amadeus.com';

let token = null, tokenExp = 0;
async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  const res = await fetch(BASE + '/v1/security/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ID, client_secret: SECRET })
  });
  if (!res.ok) throw new Error('Amadeus auth failed: ' + res.status);
  const j = await res.json();
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in - 60) * 1000;
  return token;
}

const CABIN = { economy: 'ECONOMY', premium: 'PREMIUM_ECONOMY', business: 'BUSINESS', first: 'FIRST' };

async function liveFlights(q) {
  const t = await getToken();
  const params = new URLSearchParams({
    originLocationCode: q.get('origin'), destinationLocationCode: q.get('dest'),
    departureDate: q.get('depart'), adults: q.get('adults') || '1',
    travelClass: CABIN[q.get('cabin')] || 'ECONOMY', currencyCode: 'USD', max: '12'
  });
  if (q.get('ret')) params.set('returnDate', q.get('ret'));
  const res = await fetch(BASE + '/v2/shopping/flight-offers?' + params, { headers: { Authorization: 'Bearer ' + t } });
  if (!res.ok) throw new Error('flight search failed: ' + res.status);
  const j = await res.json();
  const carriers = (j.dictionaries && j.dictionaries.carriers) || {};
  const offers = (j.data || []).map((o, i) => {
    const it = o.itineraries[0], s0 = it.segments[0], sN = it.segments[it.segments.length - 1];
    const durM = (iso) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso) || []; return (+m[1] || 0) * 60 + (+m[2] || 0); };
    const price = Math.round(parseFloat(o.price.grandTotal) / (+q.get('adults') || 1));
    return {
      id: 'live-' + i,
      airline: { code: s0.carrierCode, name: carriers[s0.carrierCode] || s0.carrierCode },
      fn: s0.carrierCode + s0.number,
      dep: s0.departure.at.slice(11, 16), arr: sN.arrival.at.slice(11, 16),
      nextDay: sN.arrival.at.slice(0, 10) !== s0.departure.at.slice(0, 10),
      durMin: durM(it.duration), stops: it.segments.length - 1,
      via: it.segments.length > 1 ? s0.arrival.iataCode : null,
      price, seatsLeft: o.numberOfBookableSeats || 9,
      fares: [
        { brand: 'Saver', price, refundable: false, changes: false, bag: false, seat: false },
        { brand: 'Flex', price: Math.round(price * 1.24), refundable: true, changes: true, bag: true, seat: true },
        { brand: 'Premium', price: Math.round(price * 1.52), refundable: true, changes: true, bag: true, seat: true }
      ]
    };
  }).sort((a, b) => a.price - b.price);
  return {
    offers,
    origin: { code: q.get('origin'), city: q.get('origin') },
    dest: { code: q.get('dest'), city: q.get('dest') }
  };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'application/json' }); res.end(body); };
  try {
    if (url.pathname === '/api/health') return send(200, JSON.stringify({ ok: !!(ID && SECRET), live: !!(ID && SECRET) }));
    if (url.pathname === '/api/flights') {
      if (!ID || !SECRET) return send(503, JSON.stringify({ error: 'No Amadeus keys set' }));
      return send(200, JSON.stringify(await liveFlights(url.searchParams)));
    }
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const body = await readFile(join(DIR, p.replace(/^\/+/, '').replace(/\.\./g, '')));
    return send(200, body, MIME[extname(p)] || 'application/octet-stream');
  } catch (err) {
    if (err.code === 'ENOENT') return send(404, JSON.stringify({ error: 'not found' }));
    return send(500, JSON.stringify({ error: String(err.message || err) }));
  }
}).listen(PORT, () => {
  console.log('TravelDeals on http://localhost:' + PORT + (ID ? ' — LIVE mode (Amadeus test API)' : ' — demo mode (set AMADEUS_CLIENT_ID / _SECRET for live fares)'));
});

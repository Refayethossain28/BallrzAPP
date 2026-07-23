/**
 * ApexAI — local intent parser (the on-device concierge brain).
 *
 * A faithful TypeScript port of `_parseIntentLocal` from apexvip-client.html. It
 * turns a free-text request ("collect me from Mayfair tomorrow at 9 for Heathrow
 * T5, BA247") into a structured booking intent, and is the offline fallback when
 * the Cloud Function (parseBookingIntent / Claude) is unavailable — so the chat
 * never goes dark.
 *
 * The original reached into page globals (`state`, `HOTELS`, `_estimateHotelRate`).
 * Here those are injected via `ConciergeContext`, which makes the parser pure and
 * unit-testable. Hotel discovery only runs when a `hotel` context is supplied;
 * without it, the parser handles rides/quotes/etc. exactly as before.
 */

export interface Hotel {
  area: string;
  rating: number;
  [key: string]: unknown;
}

/** The prior booking-in-progress (was `state.booking`) for follow-up turns. */
export interface PriorBooking {
  serviceType?: string | null;
  airport?: string | null;
  dropoff?: string | null;
  date?: string | null;
  time?: string | null;
}

export interface HotelContext {
  hotels: Hotel[];
  estimateRate: (hotel: Hotel, checkIn: string | undefined, nights: number | undefined, guests: number | undefined) => { nightly: number };
  hotelCheckIn?: string;
  hotelNights?: number;
  hotelGuests?: number;
}

export interface ConciergeContext {
  prev?: PriorBooking;
  hotel?: HotelContext;
  /** The live rate card (client PRICES / settings.pricing) — powers on-device
   *  quotes so a price is available even when the Cloud Function is down. */
  rateCard?: Record<string, number>;
  /** Injectable "now" for deterministic date resolution (tests). */
  now?: Date;
}

export interface LocalIntent {
  intent?: string;
  serviceType: string | null;
  pickup: string | null;
  dropoff: string | null;
  airport: string | null;
  flight: string | null;
  date: string | null;
  time: string | null;
  reply: string;
  // Hotel-discovery extras (set only when intent === 'hotel').
  hotels?: Hotel[];
  stayCheckIn?: string;
  stayNights?: number;
}

export function parseIntentLocal(msg: string, ctx: ConciergeContext = {}): LocalIntent {
  const prev = ctx.prev || {};
  const lower = msg.toLowerCase();
  const out: LocalIntent = { serviceType: null, pickup: null, dropoff: null, airport: null, flight: null, date: null, time: null, reply: '' };

  // ── Hotel discovery — "find me a hotel in Mayfair", "where should I stay?" ──
  // Only when the request is about staying somewhere, not a ride TO a hotel, and
  // only when a hotel context (inventory + rate estimator) is supplied.
  const _rideSignal = /\b(car|chauffeur|drive|driver|take me|pick (me|us) up|collect (me|us)|going to|ride|transfer|airport|terminal|flight|to the\b)\b/i;
  const _hotelSignal = /\b(hotels?|stay(?:ing|s)?|accommodation|somewhere to stay|place to stay|where (?:to|should i|can i) stay|book(?:ing)? a room|need a room|a room for)\b/i;
  if (ctx.hotel && _hotelSignal.test(msg) && !_rideSignal.test(msg)) {
    const HOTELS = ctx.hotel.hotels;
    const areas: Array<[RegExp, string]> = [
      [/mayfair/i, 'mayfair'], [/knightsbridge/i, 'knightsbridge'], [/piccadilly/i, 'piccadilly'],
      [/covent\s*garden|the\s*strand|\bstrand\b/i, 'strand'], [/hyde\s*park/i, 'hyde park'],
      [/london\s*bridge|the\s*shard|southwark/i, 'london bridge'], [/whitehall|westminster/i, 'whitehall'],
    ];
    let matched = HOTELS, areaLabel = '';
    for (const [re, key] of areas) {
      if (re.test(msg)) { const f = HOTELS.filter((h) => h.area.toLowerCase().includes(key)); if (f.length) { matched = f; areaLabel = key; } break; }
    }
    // Stay dates from the message — drives live/estimated pricing
    const _now = ctx.now ? new Date(ctx.now) : new Date(); _now.setHours(12, 0, 0, 0);
    const _toISO = (d: Date) => d.toISOString().slice(0, 10);
    const nightsM = msg.match(/\b(\d{1,2})\s*nights?\b/i);
    if (nightsM) out.stayNights = Math.min(14, Math.max(1, parseInt(nightsM[1], 10)));
    if (/\btonight\b|\btoday\b/i.test(msg)) out.stayCheckIn = _toISO(_now);
    else if (/\btomorrow\b/i.test(msg)) { const d = new Date(_now); d.setDate(d.getDate() + 1); out.stayCheckIn = _toISO(d); }
    else if (/\bweekend\b/i.test(msg)) { const d = new Date(_now); d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7)); out.stayCheckIn = _toISO(d); if (!out.stayNights) out.stayNights = 2; }
    else { const _days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']; for (let i = 0; i < _days.length; i++) { if (lower.includes(_days[i])) { const d = new Date(_now); d.setDate(d.getDate() + ((i - d.getDay() + 7) % 7 || 7)); out.stayCheckIn = _toISO(d); break; } } }
    const _ci = out.stayCheckIn || ctx.hotel.hotelCheckIn, _n = out.stayNights || ctx.hotel.hotelNights;
    // Budget filter — "under £800", "below 700"
    const budget = msg.match(/(?:under|below|less than|up to|max(?:imum)?)\s*£?\s*([\d,]{3,5})/i);
    if (budget) { const cap = parseInt(budget[1].replace(/,/g, ''), 10); const f = matched.filter((h) => ctx.hotel!.estimateRate(h, _ci, _n, ctx.hotel!.hotelGuests).nightly <= cap); if (f.length) matched = f; }
    matched = [...matched].sort((a, b) => b.rating - a.rating).slice(0, 5);
    const where = areaLabel ? ` in ${areaLabel.replace(/\b\w/g, (c) => c.toUpperCase())}` : ' in London';
    out.intent = 'hotel';
    out.hotels = matched.length ? matched : HOTELS.slice(0, 5);
    out.reply = matched.length
      ? `With pleasure. Here ${matched.length === 1 ? 'is a hotel' : 'are some of London\'s finest hotels'}${where}${budget ? ` under £${budget[1]}` : ''}. Tap to book directly — and I'll have a chauffeur ready whenever you arrive.`
      : `I couldn't find an exact match${where}, but here are London's finest stays. Tap to book, and I'll arrange your car.`;
    return out;
  }

  // Service type
  if (/airport|terminal|heathrow|gatwick|stansted|luton|city airport|arrivals|departures|flying|flight|BA\d|EK\d/i.test(msg)) {
    out.serviceType = 'airport';
  } else if (/\bhour(ly)?\b|\bby the hour\b/i.test(msg)) {
    out.serviceType = 'hourly';
  } else if (/\bfull.?day\b|\ball.?day\b|\bday hire\b|\bday chauffeur\b/i.test(msg)) {
    out.serviceType = 'day';
  }

  // Airport terminals
  const AP: Array<[RegExp, string]> = [
    [/heathrow\s*(t|terminal)?\s*5/i, 'Heathrow T5'],
    [/heathrow\s*(t|terminal)?\s*4/i, 'Heathrow T4'],
    [/heathrow\s*(t|terminal)?\s*3/i, 'Heathrow T3'],
    [/heathrow\s*(t|terminal)?\s*2/i, 'Heathrow T2'],
    [/heathrow/i, 'Heathrow T5'],
    [/gatwick\s*(north|south)?/i, 'Gatwick North'],
    [/stansted/i, 'Stansted'],
    [/luton/i, 'Luton'],
    [/city\s*airport|london\s*city/i, 'London City Airport'],
    [/biggin\s*hill/i, 'Biggin Hill'],
    [/farnborough/i, 'Farnborough'],
  ];
  for (const [re, label] of AP) {
    if (re.test(msg)) { out.airport = label; out.serviceType = out.serviceType || 'airport'; break; }
  }

  // Flight number — require NO space between UPPERCASE airline code and digits (BA247, EK034)
  // "at 1700" must NOT match — "at" is not an airline code
  const flt = msg.match(/\b([A-Z]{2}\d{3,4})\b/);
  if (flt) { out.flight = flt[1].toUpperCase(); out.serviceType = 'airport'; }

  // Time — "3pm", "14:30", "3:30 pm", "at 1700" (4-digit 24h), "at 9"
  const tmMatch =
    msg.match(/\b(\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i) ||
    msg.match(/\b(\d{1,2}\s*(?:am|pm))\b/i) ||
    msg.match(/\bat\s+((?:0[0-9]|1[0-9]|2[0-3])[0-5][0-9])\b/i) ||
    msg.match(/\bfor\s+((?:0[0-9]|1[0-9]|2[0-3])[0-5][0-9])\b/i) ||
    msg.match(/\bat\s+(\d{1,2})\b/i);
  if (tmMatch) {
    const raw = tmMatch[1].trim();
    // Convert 4-digit military time "1700" → "17:00"
    out.time = /^\d{4}$/.test(raw) ? raw.slice(0, 2) + ':' + raw.slice(2) : raw;
  }

  // Date keywords
  const now = ctx.now ? new Date(ctx.now) : new Date();
  if (/\btoday\b/i.test(msg)) out.date = now.toISOString().slice(0, 10);
  else if (/\btomorrow\b/i.test(msg)) { const d = new Date(now); d.setDate(d.getDate() + 1); out.date = d.toISOString().slice(0, 10); }
  else {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (let i = 0; i < days.length; i++) {
      if (lower.includes(days[i])) { const d = new Date(now); const diff = (i - now.getDay() + 7) % 7 || 7; d.setDate(d.getDate() + diff); out.date = d.toISOString().slice(0, 10); break; }
    }
  }

  // Temporal boundary — used to stop address extraction before time/date words
  const _tBound = '(?=\\s*(?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at\\s+\\d|\\bfor\\b|on\\s+\\w|\\d+\\s*(?:am|pm))|[,\\.]|$)';
  const _addrPat = '(?:\\d+[\\s-]+)?[A-Za-z][^,\\.]{2,39}?';

  // "from X to Y" pattern (pickup → destination)
  const fromTo = msg.match(new RegExp(`\\bfrom\\s+(${_addrPat})\\s+to\\s+([^,\\.]+)`, 'i'));
  if (fromTo) {
    out.pickup = fromTo[1].trim();
    if (!out.airport) out.dropoff = fromTo[2].trim();
  } else {
    // "from 37 Letchworth Street SW17 8SX tomorrow at..." — address allows leading digits
    const fm = msg.match(new RegExp(`\\bfrom\\s+(${_addrPat})${_tBound}`, 'i'));
    if (fm) out.pickup = fm[1].trim();
    const tm2 = msg.match(/\bto\s+([A-Za-z][^,\.]{3,40})/i);
    if (tm2 && !out.airport) out.dropoff = tm2[1].trim();
  }

  // Pickup fallback — "pick me up at X", "collect me from X"
  if (!out.pickup) {
    const pu = msg.match(/(?:pick(?:ing)?\s+(?:me|us)\s+up|collect(?:ing)?\s+(?:me|us))(?:\s+(?:at|from))?\s+((?:\d+[\s-]+)?[A-Za-z][^,\.]{3,40})/i);
    if (pu) out.pickup = pu[1].trim();
  }

  // Context-aware: if airport/destination already captured in a prior turn but pickup
  // is still missing, treat this follow-up message as the pickup address
  if (!out.pickup && (prev.airport || prev.dropoff) && !out.airport) {
    const isAddress =
      /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(msg) ||  // UK postcode (SW17 8SX)
      /^\s*\d+\s+[A-Za-z]/.test(msg) ||                         // starts with house number
      (msg.split(/\s+/).length <= 8 &&
       !/\b(?:heathrow|gatwick|stansted|luton|airport|terminal|hotel|station)\b/i.test(msg));
    if (isAddress) {
      out.pickup = msg.trim();
      out.serviceType = prev.serviceType || out.serviceType || 'airport';
      if (!out.airport) out.airport = prev.airport || null;
      if (!out.dropoff) out.dropoff = prev.dropoff || null;
      if (!out.date) out.date = prev.date || null;
      if (!out.time) out.time = prev.time || null;
    }
  }

  // Build natural reply
  const dest = out.airport || out.dropoff;
  const timeStr = out.time ? ` at ${out.time}` : '';
  const dateStr = out.date ? ` on ${new Date(out.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}` : '';

  // ── Quotes — "how much for a V-Class to Heathrow?" ──────────────────────────
  // Answered on-device from the rate card so a real price is given even when the
  // Cloud Function (Claude) is unreachable. Keys mirror the client PRICES card.
  const _quoteSignal = /\b(how much|price|priced|quote|cost|costs|fare|fares|rate|rates|charges?|estimate)\b|£/i;
  if (_quoteSignal.test(msg)) {
    const rc = ctx.rateCard || {};
    const veh = /\bv[\s-]?class\b|\bmercedes\s*v\b|\bmpv\b|people\s*carrier|\b[67][\s-]?seat/i.test(msg) ? 'v' : 's';
    const vlabel = veh === 'v' ? 'V-Class' : 'S-Class';
    const has = (k: string): boolean => typeof rc[k] === 'number' && rc[k] > 0;
    const money = (n: number): string => '£' + Math.round(n);
    const when = `${dateStr}${timeStr}`;
    out.intent = 'quote';
    // Airport fare key by terminal, falling back to the generic airport fare.
    const a = (out.airport || '').toLowerCase();
    const apKey =
      a.includes('heathrow') ? 'heathrow_' + veh :
      a.includes('gatwick') ? 'gatwick_' + veh :
      a.includes('stansted') ? 'stansted_' + veh :
      a.includes('luton') ? 'luton_' + veh :
      a.includes('city') ? 'city_' + veh : 'airport_' + veh;

    if (out.serviceType === 'airport' || out.airport) {
      const price = has(apKey) ? rc[apKey] : (has('airport_' + veh) ? rc['airport_' + veh] : null);
      const where = out.airport || 'the airport';
      out.reply = price != null
        ? `A ${vlabel} to ${where} is ${money(price)}, all-inclusive — one fixed fare, no surge, with meet-and-greet and flight tracking${out.flight ? ` for ${out.flight}` : ''} included. Shall I book it${when}?`
        : `I'd be glad to quote a ${vlabel} to ${where}. Let me confirm the exact fare for you.`;
      return out;
    }
    if (out.serviceType === 'hourly') {
      const rate = has('hourly_' + veh + '_rate') ? rc['hourly_' + veh + '_rate'] : null;
      out.reply = rate != null
        ? `Hourly hire in a ${vlabel} is ${money(rate)} per hour, with a two-hour minimum. Shall I arrange it${when}?`
        : `Hourly hire in a ${vlabel} — let me confirm the current rate for you.`;
      return out;
    }
    if (out.serviceType === 'day') {
      const price = has('day_' + veh) ? rc['day_' + veh] : null;
      out.reply = price != null
        ? `A full day with a ${vlabel} chauffeur is ${money(price)} — eight hours entirely at your disposal. Shall I book it${when}?`
        : `A full-day ${vlabel} chauffeur — let me confirm today's rate for you.`;
      return out;
    }
    if (out.pickup && out.dropoff) {
      const min = has('min_fare_' + veh) ? rc['min_fare_' + veh] : null;
      const perkm = has('per_km_' + veh) ? rc['per_km_' + veh] : null;
      out.reply = min != null
        ? `A ${vlabel} from ${out.pickup} to ${out.dropoff} starts at ${money(min)}${perkm != null ? `, then about £${perkm.toFixed(2)} per km` : ''}. Confirm the route and I'll price it to the penny.`
        : `A ${vlabel} from ${out.pickup} to ${out.dropoff} — share the route and I'll price it precisely.`;
      return out;
    }
    // Quote intent without enough specifics — offer the headline rates.
    const bits: string[] = [];
    if (has('airport_' + veh)) bits.push(`airport transfers from ${money(rc['airport_' + veh])}`);
    if (has('hourly_' + veh + '_rate')) bits.push(`hourly hire at ${money(rc['hourly_' + veh + '_rate'])} per hour`);
    if (has('day_' + veh)) bits.push(`a full day at ${money(rc['day_' + veh])}`);
    out.reply = bits.length
      ? `For a ${vlabel}: ${bits.join(', ')}. Tell me your route or airport and I'll give you an exact fare.`
      : `Tell me your pickup, destination or airport and I'll quote a ${vlabel} for you.`;
    return out;
  }

  if (out.serviceType === 'airport' && dest && out.pickup) {
    out.reply = `Of course. I'll arrange an airport transfer from ${out.pickup} to ${dest}${out.flight ? `, monitoring flight ${out.flight}` : ''}${dateStr}${timeStr}. Please review your booking details and select a vehicle.`;
  } else if (out.serviceType === 'airport' && dest) {
    out.reply = `Certainly. I'll arrange a transfer to ${dest}${out.flight ? ` for flight ${out.flight}` : ''}${dateStr}${timeStr}. What is your pickup address?`;
  } else if (out.pickup && dest) {
    out.reply = `Understood — a chauffeur from ${out.pickup} to ${dest}${dateStr}${timeStr}. I'll prepare your vehicle options now.`;
  } else if (out.serviceType === 'hourly') {
    out.reply = `I'll arrange an hourly hire${out.pickup ? ` from ${out.pickup}` : ''}${dateStr}${timeStr}. Please proceed to select your vehicle and duration.`;
  } else if (out.serviceType === 'day') {
    out.reply = `A full-day chauffeur is a wonderful choice. Where would you like your driver to collect you${dateStr}?`;
  } else if (out.pickup || out.dropoff) {
    out.serviceType = out.serviceType || 'airport';
    out.reply = `I have${out.pickup ? ` ${out.pickup}` : ''}${dest ? ` → ${dest}` : ''}${dateStr}${timeStr}. Shall I proceed to vehicle selection?`;
  } else {
    out.reply = `Of course. Could you tell me your pickup address${out.airport ? '' : ' and destination'}, and when you need the car?`;
    out.serviceType = null;
  }

  return out;
}

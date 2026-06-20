// Flight tracking for airport pickups. Real lookup via AviationStack when
// FLIGHT_API_KEY is set; otherwise a deterministic mock so airport requests
// still show live-style status (and drive SLA adjustment) without a key.

const BASE = "https://api.aviationstack.com/v1/flights";

export function flightMode() {
  return process.env.FLIGHT_API_KEY ? "live" : "mock";
}

export async function getFlightStatus(flightNumber) {
  const num = (flightNumber || "").toUpperCase().replace(/\s+/g, "");
  if (!num) return null;

  if (process.env.FLIGHT_API_KEY) {
    try {
      return await fetchLive(num);
    } catch (err) {
      console.warn("[flight] live lookup failed, using mock:", err.message);
    }
  }
  return mockStatus(num);
}

async function fetchLive(num) {
  const url = `${BASE}?access_key=${process.env.FLIGHT_API_KEY}&flight_iata=${num}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const f = data?.data?.[0];
  if (!f) return { flight: num, status: "unknown", source: "live" };
  const delayMinutes = f.departure?.delay || f.arrival?.delay || 0;
  return {
    flight: num,
    status: f.flight_status || "scheduled",
    scheduled: f.arrival?.scheduled || f.departure?.scheduled || null,
    estimated: f.arrival?.estimated || f.departure?.estimated || null,
    gate: f.arrival?.gate || f.departure?.gate || null,
    delayMinutes,
    source: "live",
  };
}

// Deterministic pseudo-status from the flight number so demos are stable.
function mockStatus(num) {
  const seed = [...num].reduce((s, c) => s + c.charCodeAt(0), 0);
  const delayMinutes = seed % 5 === 0 ? 25 + (seed % 20) : 0;
  const status = delayMinutes ? "delayed" : "on time";
  const base = Date.now() + 90 * 60000;
  return {
    flight: num,
    status,
    scheduled: new Date(base).toISOString(),
    estimated: new Date(base + delayMinutes * 60000).toISOString(),
    gate: String.fromCharCode(65 + (seed % 6)) + ((seed % 30) + 1),
    delayMinutes,
    source: "mock",
  };
}

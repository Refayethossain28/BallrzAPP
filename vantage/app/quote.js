// Rate engine — shared by the API and the parser. Pure functions, no I/O.
// A real deployment would pull distance from a maps API; here it's a stand-in.

export const RATES = {
  base: 45,
  perMile: 3.25,
  airportFee: 35,
  hourly: 95,
  vehicle: {
    Sedan: 1.0,
    "Mercedes S-Class": 1.4,
    SUV: 1.3,
    "Cadillac Escalade": 1.45,
    "Sprinter Executive": 1.8,
    Any: 1.2,
  },
};

// Stand-in for a real distance lookup (Google/Mapbox). Deterministic by type.
function estimateMiles(type) {
  if (type === "airport") return 22;
  if (type === "hourly") return 0;
  return 9;
}

/**
 * Build an itemized quote for a request payload.
 * Returns null for concierge requests (priced as a manual service fee).
 */
export function quoteFor({ type, vehicle = "Any", hours }) {
  if (type === "concierge") return null;
  const vm = RATES.vehicle[vehicle] ?? RATES.vehicle.Any;
  const lines = [];

  if (type === "hourly") {
    const hrs = Number.isFinite(hours) && hours > 0 ? hours : 3;
    const hourlyBase = RATES.hourly * hrs;
    lines.push([`Hourly (${hrs} hrs @ $${RATES.hourly})`, hourlyBase]);
    lines.push([`Vehicle class ×${vm}`, hourlyBase * (vm - 1)]);
  } else {
    const miles = estimateMiles(type);
    const distance = miles * RATES.perMile;
    lines.push(["Base fare", RATES.base]);
    lines.push([`Distance (~${miles} mi @ $${RATES.perMile})`, distance]);
    lines.push([`Vehicle class ×${vm}`, (RATES.base + distance) * (vm - 1)]);
    if (type === "airport") lines.push(["Airport meet & greet", RATES.airportFee]);
  }

  const total = Math.round(lines.reduce((sum, [, amt]) => sum + amt, 0));
  return { lines: lines.map(([label, amt]) => [label, Math.round(amt)]), total };
}

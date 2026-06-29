/**
 * Flight status. From `lookupFlight` in apexvip-client.html.
 *
 * Normalization + validation mirror the backend (`checkFlightStatus`). The demo
 * fallback (used when offline or on a provider error) reproduces the source rule:
 * a flight whose last digit is odd is shown delayed ~45 min. `checkFlight`
 * orchestrates live-then-demo and returns one normalized summary either way.
 */

import type { ApexClient } from '../apexClient.ts';

export type FlightBackend = Pick<ApexClient, 'checkFlightStatus'>;

/** Uppercase, strip whitespace — the form the backend expects. */
export function normalizeFlightNumber(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, '');
}

/** Matches the backend's accepted flight-number shape. */
export function isValidFlightNumber(flight: string): boolean {
  return /^[A-Z0-9]{3,8}$/.test(flight);
}

export interface FlightSummary {
  flight: string;
  delayed: boolean;
  delayMins: number;
  status: 'delayed' | 'on-time';
  available: boolean;
}

/** The on-device demo result (odd last digit → delayed ~45 min). */
export function demoFlightStatus(flight: string): FlightSummary {
  const digits = flight.replace(/\D/g, '');
  const last = parseInt(digits.slice(-1), 10);
  const delayed = Number.isFinite(last) && last % 2 === 1;
  const delayMins = delayed ? 45 : 0;
  return { flight, delayed, delayMins, status: delayed ? 'delayed' : 'on-time', available: false };
}

/**
 * Resolve a flight's status: try the backend, fall back to the demo rule on no
 * backend or any error. Returns a normalized summary; invalid input returns a
 * neutral on-time result rather than throwing (the UI only nudges the time).
 */
export async function checkFlight(backend: FlightBackend | null, rawFlight: string): Promise<FlightSummary> {
  const flight = normalizeFlightNumber(rawFlight);
  if (!isValidFlightNumber(flight)) {
    return { flight, delayed: false, delayMins: 0, status: 'on-time', available: false };
  }
  if (backend) {
    try {
      const d = await backend.checkFlightStatus({ flight });
      if (d.available) {
        const delayed = d.delayed || false;
        const delayMins = d.delayMins || 0;
        return { flight, delayed, delayMins, status: delayed ? 'delayed' : 'on-time', available: true };
      }
    } catch {
      // fall through to the demo rule
    }
  }
  return demoFlightStatus(flight);
}

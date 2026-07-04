/**
 * Booking payload assembly — the money-path document the client writes to
 * `bookings/` on confirmation. Lifted from `confirmBooking()` in
 * apexvip-client.html so the field mapping (service labels, fare figures,
 * payment status, PA mode) has ONE tested implementation.
 *
 * Pure: the caller appends `createdAt: serverTimestamp()` and writes the doc.
 */

export const SERVICE_LABELS: Record<string, string> = {
  airport: 'Airport Transfer',
  hourly: 'By the Hour',
  day: 'By the Day',
  point: 'Point to Point',
};

export interface BookingDraft {
  serviceType?: string;
  pickup?: string;
  dropoff?: string;
  airport?: string;
  flight?: string;
  date?: string;
  time?: string;
  vehicle?: string;
  vehicleId?: string;
  concierge?: unknown;
}

export interface BookingPayloadInput {
  ref: string;
  clientId: string;
  clientName?: string;
  clientEmail?: string;
  booking: BookingDraft;
  /** VAT-inclusive total, base fare, discount and VAT from the fare engine. */
  fare: { total: number; base: number; discount: number; vat: number };
  /** APEX applied against this fare at checkout (0 when paid fully in cash). */
  apexRedeemed?: number;
  promoApplied?: boolean;
  squarePaymentId?: string | null;
  paMode?: boolean;
  paPassenger?: unknown;
  location?: string;
}

/**
 * Build the bookings/ document. Throws on a payload that would produce an
 * undispatschable booking (no client, or no pickup AND no airport) — the
 * screens validate first, so throwing here is a last-line guard.
 */
export function buildBookingPayload(input: BookingPayloadInput): Record<string, unknown> {
  if (!input.clientId) throw new Error('booking payload requires clientId');
  const b = input.booking || {};
  if (!(b.pickup || '').trim() && !(b.airport || '').trim()) {
    throw new Error('booking payload requires a pickup or an airport');
  }
  const serviceType = b.serviceType || 'airport';
  return {
    ref: input.ref,
    clientId: input.clientId,
    clientName: input.clientName || '',
    clientEmail: input.clientEmail || '',
    serviceType,
    serviceLabel: SERVICE_LABELS[serviceType] || 'Airport Transfer',
    pickup: b.pickup || '',
    dropoff: b.dropoff || '',
    airport: b.airport || '',
    flight: b.flight || '',
    date: b.date || '',
    time: b.time || '',
    vehicle: b.vehicle || 'Mercedes S-Class',
    vehicleId: b.vehicleId || '',
    price: input.fare.total,
    baseFare: input.fare.base,
    discount: input.fare.discount,
    vat: input.fare.vat,
    apexRedeemed: Math.max(0, Math.floor(Number(input.apexRedeemed) || 0)),
    promoApplied: !!input.promoApplied,
    status: 'confirmed',
    squarePaymentId: input.squarePaymentId || null,
    paymentStatus: input.squarePaymentId ? 'paid' : 'pending',
    driverName: '',
    driverRating: null,
    driverPlate: '',
    location: input.location || 'london',
    concierge: b.concierge || null,
    paMode: !!input.paMode,
    paPassenger: input.paMode ? (input.paPassenger ?? null) : null,
  };
}

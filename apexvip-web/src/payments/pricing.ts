/**
 * ApexVIP fare pricing — the VAT-inclusive quote math.
 *
 * Lifted from `confirmBooking` in apexvip-client.html so the money math is pure
 * and unit-tested. A promo applies a 20% discount; VAT is shown as the 1/6 of the
 * (VAT-inclusive) total that represents the 20% UK VAT component. Identical
 * arithmetic to the source — only typed and testable.
 */

export interface FareQuote {
  /** The headline fare before any discount. */
  base: number;
  /** Promo discount (20% of base, rounded), or 0. */
  discount: number;
  /** What the customer pays: base − discount. */
  total: number;
  /** The VAT component already included in `total` (1/6, rounded). */
  vat: number;
}

export const PROMO_RATE = 0.2;

export function quoteFare(base: number, promoApplied: boolean): FareQuote {
  const discount = promoApplied ? Math.round(base * PROMO_RATE) : 0;
  const total = base - discount;
  const vat = Math.round(total / 6);
  return { base, discount, total, vat };
}

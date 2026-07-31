/**
 * Post-trip rating. From `submitRating` in apexvip-client.html.
 *
 * The validation mirrors the backend (`submitTripRating`): an integer 1–5 and a
 * comment capped at 1000 chars. The typed wrapper submits via the contract.
 */

import type { ApexClient } from '../apexClient.ts';

export type RatingBackend = Pick<ApexClient, 'submitTripRating'>;

export const MAX_RATING_COMMENT = 1000;

/** True for a whole-number rating in 1..5 (matches the backend's check). */
export function isValidRating(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

/** Cap a rating comment to the backend's maximum length. */
export function clampComment(comment: string): string {
  return comment.slice(0, MAX_RATING_COMMENT);
}

export interface RatingInput {
  bookingRef: string;
  rating: number;
  comment?: string;
  driverId?: string;
}

/**
 * Submit a trip rating. Returns false (without calling the backend) when the
 * rating is out of range or there's no booking reference / backend.
 */
export async function submitRating(backend: RatingBackend | null, input: RatingInput): Promise<boolean> {
  if (!isValidRating(input.rating) || !input.bookingRef) return false;
  if (!backend) return false;
  await backend.submitTripRating({
    bookingRef: input.bookingRef,
    rating: input.rating,
    comment: clampComment(input.comment || ''),
    driverId: input.driverId,
  });
  return true;
}

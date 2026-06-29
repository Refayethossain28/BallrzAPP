/**
 * Chauffeur chat. From `sendQuickMsg` / `sendCustomMsg` in apexvip-client.html
 * (and the driver app's reply path).
 *
 * `prepareChauffeurMessage` validates/normalizes a message the same way the
 * backend (`sendChauffeurMessage`) does — non-empty, ≤ 2000 chars, a whitelisted
 * sender role — so a bad message is caught before the round-trip.
 */

import type { ApexClient } from '../apexClient.ts';

export type ChatBackend = Pick<ApexClient, 'sendChauffeurMessage'>;

export const MAX_CHAT_MESSAGE = 2000;
export type ChatRole = 'client' | 'driver' | 'concierge';
const ROLES: ChatRole[] = ['client', 'driver', 'concierge'];

export interface ChauffeurMessage {
  bookingRef: string;
  message: string;
  fromRole: ChatRole;
}

/**
 * Build a valid chauffeur-message payload, or throw with the reason. Trims the
 * text, enforces the length bound, and normalizes an unknown role to 'client'.
 */
export function prepareChauffeurMessage(input: { bookingRef?: string; message?: string; fromRole?: string }): ChauffeurMessage {
  const bookingRef = (input.bookingRef || '').trim();
  const message = (input.message || '').trim();
  if (!bookingRef) throw new Error('bookingRef is required');
  if (!message) throw new Error('message is required');
  if (message.length > MAX_CHAT_MESSAGE) throw new Error('message too long');
  const fromRole = ROLES.includes(input.fromRole as ChatRole) ? (input.fromRole as ChatRole) : 'client';
  return { bookingRef, message, fromRole };
}

/** Send a chauffeur message via the contract. Returns false when offline. */
export async function sendChauffeurMessage(
  backend: ChatBackend | null,
  input: { bookingRef?: string; message?: string; fromRole?: string },
): Promise<boolean> {
  const payload = prepareChauffeurMessage(input);
  if (!backend) return false;
  await backend.sendChauffeurMessage(payload);
  return true;
}

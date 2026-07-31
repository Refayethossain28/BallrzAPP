/**
 * ApexAI concierge orchestration.
 *
 * Mirrors the source-selection logic of `sendConciergeMsg` in apexvip-client.html,
 * lifted out of the DOM so it's typed and testable:
 *
 *   1. Hotel discovery is always resolved locally (it needs the on-device
 *      inventory + booking links), regardless of the backend.
 *   2. Otherwise, if the backend is available, ask the Cloud Function
 *      (parseBookingIntent / Claude) — fully typed via the shared contract.
 *   3. If the backend is absent or errors, fall back to the on-device parser so
 *      the chat never goes dark.
 *
 * The UI (rendering messages, applying fields to the booking) stays in the page;
 * this returns the structured result for the page to apply.
 */

import type { ApexClient } from '../apexClient.ts';
import type { BookingIntentResult } from '@apexvip/contract';
import { parseIntentLocal, type ConciergeContext, type LocalIntent } from './intent.ts';

export interface ChatTurn {
  role: string;
  content: string;
}

export interface ConciergeRequest {
  message: string;
  history?: ChatTurn[];
  trips?: unknown[];
  now?: string;
}

export interface ConciergeDeps {
  /** The typed callable client, or null when Firebase is unavailable (offline). */
  backend: Pick<ApexClient, 'parseBookingIntent'> | null;
  /** Context for the local parser (prior booking, hotel inventory, clock). */
  context?: ConciergeContext;
}

export type ConciergeResult = LocalIntent | BookingIntentResult;

export async function resolveConcierge(
  req: ConciergeRequest,
  deps: ConciergeDeps,
): Promise<ConciergeResult> {
  const { message } = req;
  const ctx = deps.context;

  // 1) Hotel discovery is handled locally (with booking links), regardless of backend.
  const localFirst = parseIntentLocal(message, ctx);
  if (localFirst.intent === 'hotel') return localFirst;

  // 2) Backend (Claude) when available — typed end-to-end via the contract.
  if (deps.backend) {
    try {
      return await deps.backend.parseBookingIntent({
        message,
        history: req.history,
        trips: req.trips,
        now: req.now,
      });
    } catch {
      // 3) Fall back to the on-device parser so the chat never goes dark.
      return parseIntentLocal(message, ctx);
    }
  }

  // 3) No backend configured — local parser.
  return parseIntentLocal(message, ctx);
}

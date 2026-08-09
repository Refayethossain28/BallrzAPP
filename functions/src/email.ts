/**
 * Shared email secret — SendGrid is used by the booking notifications
 * (index.ts) and Atlas Pro fulfilment (atlas.ts). Secrets are params and may
 * only be defined once per name, so the definition lives here rather than in
 * either consumer (same arrangement as stripe.ts).
 *
 * Set with: firebase functions:secrets:set SENDGRID_API_KEY
 */
import { defineSecret } from 'firebase-functions/params';

export const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');

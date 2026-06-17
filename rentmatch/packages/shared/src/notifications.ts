/**
 * Notification copy — pure mapping from a deal event to the title/body shown in
 * a push or email. Shared so the Cloud Function trigger and any future channel
 * render identical wording, and so the copy is unit-testable.
 */
export type DealEventType =
  | 'message'
  | 'viewing_proposed'
  | 'viewing_confirmed'
  | 'agreed'
  | 'contract_drafted'
  | 'signing_opened'
  | 'signed'
  | 'completed';

export interface NotificationContext {
  /** Display name of whoever triggered the event. */
  fromName: string;
  /** Short label for the property, e.g. "Hackney, London". */
  listingLabel: string;
  /** Optional message preview (for `message` events). */
  preview?: string;
}

export interface Notification {
  title: string;
  body: string;
}

export function buildNotification(type: DealEventType, ctx: NotificationContext): Notification {
  switch (type) {
    case 'message':
      return { title: `New message from ${ctx.fromName}`, body: ctx.preview?.trim() || `About ${ctx.listingLabel}` };
    case 'viewing_proposed':
      return { title: 'Viewing proposed', body: `${ctx.fromName} proposed a viewing for ${ctx.listingLabel}.` };
    case 'viewing_confirmed':
      return { title: 'Viewing confirmed', body: `Your viewing for ${ctx.listingLabel} is confirmed.` };
    case 'agreed':
      return { title: 'Terms agreed', body: `${ctx.fromName} agreed to proceed for ${ctx.listingLabel}.` };
    case 'contract_drafted':
      return { title: 'Tenancy agreement ready', body: `The agreement for ${ctx.listingLabel} is ready to review.` };
    case 'signing_opened':
      return { title: 'Signature requested', body: `Please review and sign the tenancy for ${ctx.listingLabel}.` };
    case 'signed':
      return { title: 'Agreement signed', body: `${ctx.fromName} signed the tenancy for ${ctx.listingLabel}.` };
    case 'completed':
      return { title: 'Tenancy completed 🎉', body: `The tenancy for ${ctx.listingLabel} is now in force.` };
  }
}

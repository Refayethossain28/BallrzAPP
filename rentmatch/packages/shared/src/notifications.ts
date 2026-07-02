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

export interface ComplianceReminderContext {
  /** Short label for the property, e.g. "Hackney, London". */
  propertyLabel: string;
  /** Document label, e.g. "Gas Safety Record (CP12)". */
  docLabel: string;
  /** Whole days until expiry; ≤ 0 once the document has lapsed. */
  daysToExpiry: number;
}

/**
 * Copy for a compliance-expiry reminder. Kept here (not in `compliance.ts`) so
 * every channel renders identical wording, and takes primitives so it stays
 * free of any compliance-module import.
 */
export function buildComplianceReminder(ctx: ComplianceReminderContext): Notification {
  if (ctx.daysToExpiry <= 0) {
    return {
      title: `Action needed: ${ctx.docLabel} expired`,
      body: `The ${ctx.docLabel} for ${ctx.propertyLabel} has expired. Renew it to keep the property legally lettable.`,
    };
  }
  const days = `${ctx.daysToExpiry} day${ctx.daysToExpiry === 1 ? '' : 's'}`;
  return {
    title: `${ctx.docLabel} expires in ${days}`,
    body: `Renew the ${ctx.docLabel} for ${ctx.propertyLabel} before it lapses to avoid a fine or a blocked Section 21.`,
  };
}

export interface RentReminderContext {
  tenantName: string;
  propertyLabel: string;
  /** "overdue" ⇒ arrears owed; "due-soon" ⇒ the upcoming charge. */
  kind: 'due-soon' | 'overdue';
  /** Formatted amount, e.g. "£1,200". */
  amount: string;
  /** Formatted due date for due-soon reminders. */
  dueDate?: string;
}

/** Copy for a landlord-facing rent reminder (upcoming or overdue). */
export function buildRentReminder(ctx: RentReminderContext): Notification {
  if (ctx.kind === 'overdue') {
    return {
      title: `Rent overdue — ${ctx.tenantName}`,
      body: `${ctx.amount} of rent is outstanding for ${ctx.propertyLabel}.`,
    };
  }
  return {
    title: `Rent due soon — ${ctx.tenantName}`,
    body: `${ctx.amount} is due${ctx.dueDate ? ` on ${ctx.dueDate}` : ''} for ${ctx.propertyLabel}.`,
  };
}

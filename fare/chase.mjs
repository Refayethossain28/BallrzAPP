/**
 * fare/chase.mjs — automated payment chasing. The decision of *what* to
 * chase is pure and lives in the engine (chasePlan); this module is the
 * effect loop: once an hour, for every account with chasing enabled, send
 * the reminders the plan calls for and log them (the log is what stops the
 * same reminder going twice).
 */
import E from './engine-node.mjs';
import * as store from './db.mjs';
import { invoicePdf } from './pdf.mjs';
import { sendReminder, emailEnabled } from './email.mjs';

export async function chaseTick(db, { log = () => {} } = {}) {
  if (!emailEnabled()) return { sent: 0, skipped: 'email disabled' };
  const todayISO = E.isoDate(Date.now());
  let sent = 0;
  for (const accountId of store.accountsWithInvoices(db)) {
    const settings = E.normaliseSettings(store.getSettings(db, accountId));
    if (!settings.chaseEnabled) continue;
    const account = store.getAccount(db, accountId);
    const plan = E.chasePlan(
      store.listInvoices(db, accountId),
      store.listEmailLog(db, accountId),
      store.listClients(db, accountId, { includeArchived: true }),
      settings,
      todayISO
    );
    for (const item of plan) {
      try {
        const pdf = invoicePdf(item.invoice, { logoDataUrl: settings.logo });
        const result = await sendReminder({
          to: item.recipient,
          replyTo: settings.email || account?.email || undefined,
          businessName: settings.businessName,
          clientName: item.invoice.snapshot?.client?.name || 'client',
          invoice: item.invoice,
          reminderNo: item.reminderNo,
          pdf,
          formatMoney: E.formatMoney,
          formatDateLong: E.formatDateLong,
        });
        store.logEmail(db, accountId, {
          invoiceId: item.invoice.id, kind: 'reminder',
          recipient: item.recipient, providerId: result.id,
        });
        sent++;
        log(`chase: reminder ${item.reminderNo} for ${item.invoice.displayNumber} → ${item.recipient}`);
      } catch (err) {
        log(`chase: FAILED for invoice ${item.invoice.displayNumber}: ${err.message}`);
      }
    }
  }
  return { sent };
}

export function startChaser(db, { intervalMs = 60 * 60 * 1000, log = () => {} } = {}) {
  const run = () => chaseTick(db, { log }).catch((err) => log(`chase tick error: ${err.message}`));
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 15 * 1000).unref?.(); // first pass shortly after boot
  return timer;
}

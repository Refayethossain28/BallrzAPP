/**
 * fare/email.mjs — outbound email via Resend's HTTPS API. Zero dependencies:
 * one fetch() per send, no SDK.
 *
 * Env:
 *   RESEND_API_KEY   enables real sending (from resend.com; verify a domain
 *                    there and add its SPF/DKIM DNS records — required for
 *                    invoices to land in inboxes, not spam)
 *   FARE_EMAIL_FROM  the From header, e.g. "Fare <invoices@yourdomain.uk>"
 *
 * Without a key, sends are logged to the console instead (and the magic
 * sign-in link is surfaced to the caller) so local dev needs no accounts.
 */

const API = 'https://api.resend.com/emails';

export function emailEnabled() {
  return !!process.env.RESEND_API_KEY;
}

export function fromAddress() {
  return process.env.FARE_EMAIL_FROM || 'Fare <onboarding@resend.dev>';
}

async function deliver({ to, replyTo, subject, text, html, attachments }) {
  if (!emailEnabled()) {
    console.log(`[email:dev] to=${to} subject="${subject}"\n${text}`);
    return { id: 'dev-' + Date.now(), dev: true };
  }
  const body = { from: fromAddress(), to: [to], subject, text, html };
  if (replyTo) body.reply_to = replyTo;
  if (attachments && attachments.length) {
    body.attachments = attachments.map((a) => ({ filename: a.filename, content: a.content.toString('base64') }));
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`email send failed (${res.status}): ${data?.message || 'unknown error'}`);
  return { id: data.id || '' };
}

/* ── templates: plain, courteous, no tracking ── */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shell(title, bodyHtml) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a2230">
    <h2 style="margin:0 0 16px">${esc(title)}</h2>${bodyHtml}
    <p style="color:#8a93a3;font-size:12px;margin-top:28px">Sent with Fare — chauffeur job logging &amp; invoicing.</p></div>`;
}

export function sendLoginLink({ to, link }) {
  const text = `Tap to sign in to Fare:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't request it, ignore this email.`;
  return deliver({
    to,
    subject: 'Your Fare sign-in link',
    text,
    html: shell('Sign in to Fare',
      `<p><a href="${esc(link)}" style="display:inline-block;background:#d4af37;color:#16130a;font-weight:700;padding:12px 22px;border-radius:10px;text-decoration:none">Sign in</a></p>
       <p style="color:#5a6472">The link works once and expires in 15 minutes. If you didn't request it, ignore this email.</p>`),
  });
}

export function sendInvoice({ to, replyTo, businessName, clientName, invoice, pdf, formatMoney, formatDateLong }) {
  const subject = `Invoice ${invoice.displayNumber} from ${businessName || 'your chauffeur'}`;
  const text = `Dear ${clientName},\n\nPlease find attached invoice ${invoice.displayNumber} for ${formatMoney(invoice.total)}, due by ${formatDateLong(invoice.dueDate)}.\n\nPayment details are on the invoice. Thank you for your business.\n\n${businessName || ''}`;
  return deliver({
    to, replyTo, subject, text,
    html: shell(subject,
      `<p>Dear ${esc(clientName)},</p>
       <p>Please find attached invoice <b>${esc(invoice.displayNumber)}</b> for <b>${esc(formatMoney(invoice.total))}</b>, due by <b>${esc(formatDateLong(invoice.dueDate))}</b>.</p>
       <p>Payment details are on the invoice. Thank you for your business.</p>
       <p>${esc(businessName || '')}</p>`),
    attachments: [{ filename: `${invoice.displayNumber}.pdf`, content: pdf }],
  });
}

export function sendReminder({ to, replyTo, businessName, clientName, invoice, reminderNo, pdf, formatMoney, formatDateLong }) {
  const firm = reminderNo >= 3;
  const subject = `${firm ? 'Overdue: ' : 'Reminder: '}invoice ${invoice.displayNumber} — ${formatMoney(invoice.total)}`;
  const lead = firm
    ? `This is a further reminder that invoice ${invoice.displayNumber} for ${formatMoney(invoice.total)} remains unpaid — it was due on ${formatDateLong(invoice.dueDate)}. Please arrange payment at your earliest convenience.`
    : `A gentle reminder that invoice ${invoice.displayNumber} for ${formatMoney(invoice.total)} was due on ${formatDateLong(invoice.dueDate)}.`;
  const text = `Dear ${clientName},\n\n${lead}\n\nThe invoice is attached; payment details are on it. If you've already paid, please disregard this email.\n\n${businessName || ''}`;
  return deliver({
    to, replyTo, subject, text,
    html: shell(subject,
      `<p>Dear ${esc(clientName)},</p><p>${esc(lead)}</p>
       <p>The invoice is attached; payment details are on it. If you've already paid, please disregard this email.</p>
       <p>${esc(businessName || '')}</p>`),
    attachments: [{ filename: `${invoice.displayNumber}.pdf`, content: pdf }],
  });
}

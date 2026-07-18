/**
 * automaton/orders.mjs — pure order logic for the storefront.
 * A customer order becomes an inbox task the moment it is paid.
 * No I/O, no clock, no randomness — fully unit-testable.
 */
import { round2 } from './logic.mjs';

/** What the automaton sells. Price IS the bounty. */
export const MENU = Object.freeze({
  quick: { price: 1.0, label: 'Quick task', promise: 'a focused answer to one small question' },
  standard: { price: 3.0, label: 'Standard task', promise: 'a considered piece of work — email, summary, analysis' },
  deep: { price: 5.0, label: 'Deep task', promise: 'its best thinking on a meaty brief' },
});

export const MAX_TITLE = 120;
export const MAX_DETAILS = 4000;

/** Order ids are server-generated; this guards every place one is read back. */
export const isOrderId = (id) => /^ord-[a-z0-9]{10}$/.test(id);

/** Validate a raw customer submission. Returns { ok, errors, order? }. */
export function validateOrder(raw) {
  const errors = [];
  const title = String(raw?.title ?? '').trim();
  const details = String(raw?.details ?? '').trim();
  const tier = String(raw?.tier ?? '').trim();
  if (!title) errors.push('Give the task a title.');
  if (title.length > MAX_TITLE) errors.push(`Title over ${MAX_TITLE} characters.`);
  if (!details) errors.push('Describe what you want done.');
  if (details.length > MAX_DETAILS) errors.push(`Details over ${MAX_DETAILS} characters.`);
  if (!MENU[tier]) errors.push('Pick a task size.');
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], order: { title, details, tier, price: MENU[tier].price } };
}

/** Render a paid order as an inbox task file. The price becomes the bounty. */
export function taskMarkdown(order, orderId) {
  return [
    `# ${order.title}`,
    '',
    `Bounty: $${round2(order.price).toFixed(2)}`,
    '',
    order.details,
    '',
    `<!-- storefront order ${orderId} (${order.tier}) -->`,
  ].join('\n');
}

/** Task/answer filenames for an order — the id links the whole trail. */
export const taskFileFor = (orderId) => `${orderId}.md`;
export const answerFileFor = (orderId) => `${orderId}.answer.md`;

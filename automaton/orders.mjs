/**
 * automaton/orders.mjs — pure order logic for the storefront.
 * A customer order becomes an inbox task the moment it is paid.
 * No I/O, no clock, no randomness — fully unit-testable.
 */
import { round2 } from './logic.mjs';

/** Task sizes. Price IS the bounty. */
export const MENU = Object.freeze({
  quick: { price: 1.0, label: 'Quick task', promise: 'a focused answer to one small question' },
  standard: { price: 3.0, label: 'Standard task', promise: 'a considered piece of work — email, summary, analysis' },
  deep: { price: 5.0, label: 'Deep task', promise: 'its best thinking on a meaty brief' },
});

/**
 * The productized menu: named services at fixed prices. Each carries the
 * professional brief the automaton executes, so a customer only supplies
 * their material — the prompt engineering is part of what they're buying.
 * `custom` is the original free-form task, where the customer picks a size.
 */
export const SERVICES = Object.freeze({
  polish: {
    label: 'Proofread & polish', tier: 'quick',
    pitch: 'Paste any text; get it back corrected and tightened.',
    inputLabel: 'Paste the text to polish',
    placeholder: 'Your email, bio, essay, listing… typos and all.',
    brief: 'Proofread and polish the customer text below. Fix all grammar, spelling and punctuation, tighten flabby wording, and keep the original meaning, voice and language. Return ONLY the corrected text — no commentary.',
  },
  names: {
    label: 'Names & taglines', tier: 'quick',
    pitch: 'Eight strong name ideas, each with a tagline.',
    inputLabel: 'Describe the product, company or project to name',
    placeholder: 'What it does, who it is for, the feeling it should give…',
    brief: 'Invent eight distinct, memorable names for what the customer describes below. For each, add a one-line tagline (max 8 words). Range from safe to bold. End with a one-sentence note reminding them to check trademark and domain availability.',
  },
  email: {
    label: 'The difficult email', tier: 'standard',
    pitch: 'The message you keep putting off, written ready to send.',
    inputLabel: 'The situation: who it is to, what happened, what you need',
    placeholder: 'e.g. Tell a loyal client their rate is going up 20% without losing them…',
    brief: 'Write the email the customer describes below, ready to send. Get the tone exactly right for the relationship and stakes: clear, human, firm where needed, never passive-aggressive. Include a subject line. If key facts are missing, choose sensible neutral placeholders in [brackets].',
  },
  summary: {
    label: 'Executive summary', tier: 'standard',
    pitch: 'Any document in five bullets and a bottom line.',
    inputLabel: 'Paste the document, notes or thread to summarize',
    placeholder: 'Report, meeting notes, long email chain, contract clause…',
    brief: 'Summarize the customer material below for a busy executive: exactly five bullets covering what matters most (decisions, numbers, risks, asks), then a single-sentence bottom line starting "Bottom line:". Be faithful to the source — no invented facts.',
  },
  listing: {
    label: 'Product description', tier: 'standard',
    pitch: 'Copy that sells: description, spec bullets, SEO title.',
    inputLabel: 'The product: what it is, key facts, who buys it',
    placeholder: 'Materials, dimensions, what makes it different, price point…',
    brief: 'Write selling copy for the product described below: an SEO-friendly title (max 70 characters), a persuasive description of about 120 words in the second person, then five crisp specification bullets. Use only facts the customer gives — never invent specifications.',
  },
  brief: {
    label: 'Deep-dive decision brief', tier: 'deep',
    pitch: 'A one-page recommendation on a real decision.',
    inputLabel: 'The decision and everything relevant to it',
    placeholder: 'e.g. Should we open in Manchester or Birmingham first? Budget, team, timing…',
    brief: 'The customer faces the decision described below. Produce a one-page brief: a clear recommendation up front, the case for it, the strongest case against and why it loses, and three concrete next steps. Commit to a position — a brief that hedges is not worth paying for.',
  },
  custom: {
    label: 'Custom task', tier: null,
    pitch: 'Anything else — describe it and pick a size.',
    inputLabel: 'Details',
    placeholder: 'Everything it should know: context, constraints, tone, examples…',
    brief: null,
  },
});

export const MAX_TITLE = 120;
export const MAX_DETAILS = 4000;

/** Order ids are server-generated; this guards every place one is read back. */
export const isOrderId = (id) => /^ord-[a-z0-9]{10}$/.test(id);

/**
 * Validate a raw customer submission. Returns { ok, errors, order? }.
 * A missing `service` means `custom`, so pre-catalog clients keep working.
 * Productized orders need only the customer's input: the title, tier and
 * working brief all come from the catalog.
 */
export function validateOrder(raw) {
  const errors = [];
  const serviceKey = String(raw?.service ?? 'custom').trim();
  const svc = SERVICES[serviceKey];
  if (!svc) return { ok: false, errors: ['Pick a service from the menu.'] };

  const input = String(raw?.details ?? '').trim();
  if (!input) errors.push(serviceKey === 'custom' ? 'Describe what you want done.' : `${svc.inputLabel}.`);
  if (input.length > MAX_DETAILS) errors.push(`Details over ${MAX_DETAILS} characters.`);

  if (serviceKey === 'custom') {
    const title = String(raw?.title ?? '').trim();
    const tier = String(raw?.tier ?? '').trim();
    if (!title) errors.push('Give the task a title.');
    if (title.length > MAX_TITLE) errors.push(`Title over ${MAX_TITLE} characters.`);
    if (!MENU[tier]) errors.push('Pick a task size.');
    if (errors.length) return { ok: false, errors };
    return { ok: true, errors: [], order: { service: 'custom', title, details: input, tier, price: MENU[tier].price } };
  }

  if (errors.length) return { ok: false, errors };
  const details = `${svc.brief}\n\nCustomer material:\n\n${input}`;
  return { ok: true, errors: [], order: { service: serviceKey, title: svc.label, details, tier: svc.tier, price: MENU[svc.tier].price } };
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
    `<!-- storefront order ${orderId} (${order.service && order.service !== 'custom' ? `${order.service} · ` : ''}${order.tier}) -->`,
  ].join('\n');
}

/** Task/answer filenames for an order — the id links the whole trail. */
export const taskFileFor = (orderId) => `${orderId}.md`;
export const answerFileFor = (orderId) => `${orderId}.answer.md`;

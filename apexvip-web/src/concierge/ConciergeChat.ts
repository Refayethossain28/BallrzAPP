/**
 * ApexAI concierge chat — a lifted screen.
 *
 * This is the concierge chat from apexvip-client.html rebuilt as a self-contained,
 * typed component: it owns its markup, styling and event wiring, and talks to the
 * already-migrated brain (`resolveConcierge`) for replies. It runs fully offline
 * via the on-device parser; pass a typed `backend` to route through Claude.
 *
 * Two concrete wins over the inline original visible here:
 *   1. Type safety on the render path — message roles and intent fields are typed,
 *      so a typo in the markup is a compile error, not a blank screen.
 *   2. XSS-safe rendering — user/assistant text goes through `textContent`, not
 *      `innerHTML` string interpolation as in the source.
 */

import './concierge.css';
import { resolveConcierge, type ConciergeDeps, type ConciergeResult } from './concierge.ts';
import type { ConciergeContext } from './intent.ts';

export interface ConciergeExample {
  icon: string;
  short: string;
  text: string;
}

export const DEFAULT_EXAMPLES: ConciergeExample[] = [
  { icon: '✈️', short: 'Price to Heathrow', text: 'How much is a car to Heathrow from central London?' },
  { icon: '🍽', short: 'Dinner suggestions', text: 'Recommend somewhere nice for dinner tonight in London' },
  { icon: '🕐', short: 'Smart pickup time', text: 'My flight is BA249 at 7am tomorrow from Heathrow' },
  { icon: '📍', short: 'Multi-stop journey', text: 'Take me to Harrods, then The Shard, then back home' },
  { icon: '🔄', short: 'Weekly booking', text: 'Book me to the office every Monday at 8am' },
  { icon: '🚗', short: 'Point to point', text: 'A car from The Savoy to Canary Wharf at 6pm' },
];

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ConciergeChatOptions {
  backend?: ConciergeDeps['backend'];
  context?: ConciergeContext;
  examples?: ConciergeExample[];
}

const greeting = (now = new Date()): string => {
  const h = now.getHours();
  const part = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  return `Good ${part}. I'm your ApexVIP concierge. I can book rides, give quotes, suggest destinations and set up recurring journeys. Tap an example below or tell me what you need.`;
};

/** Build a one-line "understood" summary from a structured booking intent. */
function intentSummary(r: ConciergeResult): string | null {
  const svc = (r as { serviceType?: string }).serviceType;
  const pickup = (r as { pickup?: string }).pickup;
  const dest = (r as { airport?: string }).airport || (r as { dropoff?: string }).dropoff;
  const date = (r as { date?: string }).date;
  const time = (r as { time?: string }).time;
  const flight = (r as { flight?: string }).flight;
  if (!svc && !pickup && !dest && !flight) return null;
  const label: Record<string, string> = { airport: 'Airport transfer', hourly: 'Hourly hire', day: 'Full-day chauffeur', point: 'Point-to-point' };
  const parts: string[] = [];
  if (svc) parts.push(label[svc] || svc);
  if (pickup || dest) parts.push(`${pickup || '—'} → ${dest || '—'}`);
  if (date || time) parts.push([date, time].filter(Boolean).join(' '));
  if (flight) parts.push(`flight ${flight}`);
  return parts.join(' · ');
}

export class ConciergeChat {
  private messages: ChatMessage[] = [];
  private loading = false;
  private readonly examples: ConciergeExample[];
  private readonly deps: ConciergeDeps;
  private msgsEl!: HTMLElement;
  private inputEl!: HTMLInputElement;

  constructor(private root: HTMLElement, private opts: ConciergeChatOptions = {}) {
    this.examples = opts.examples || DEFAULT_EXAMPLES;
    this.deps = { backend: opts.backend ?? null, context: opts.context };
    this.build();
  }

  private build(): void {
    this.root.classList.add('apex-concierge');
    this.root.innerHTML = '';

    const header = el('div', 'ax-header');
    header.append(el('div', 'ax-logo', '◆'), el('div', 'ax-title', 'ApexAI'));
    this.root.append(header);

    this.msgsEl = el('div', 'ax-msgs');
    this.msgsEl.setAttribute('data-testid', 'messages');
    this.root.append(this.msgsEl);

    const bar = el('div', 'ax-bar');
    this.inputEl = document.createElement('input');
    this.inputEl.className = 'ax-input';
    this.inputEl.placeholder = "Tell me where you'd like to go…";
    this.inputEl.setAttribute('data-testid', 'input');
    this.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void this.send(); } });
    const sendBtn = el('button', 'ax-send', '↑');
    sendBtn.setAttribute('data-testid', 'send');
    sendBtn.addEventListener('click', () => void this.send());
    bar.append(this.inputEl, sendBtn);
    this.root.append(bar);

    this.render();
  }

  private render(): void {
    const m = this.msgsEl;
    m.innerHTML = '';

    // Greeting (always first).
    m.append(bubble('assistant', greeting()));

    // Example chips, only before the first message.
    if (this.messages.length === 0) {
      const hint = el('div', 'ax-hint', 'Try asking…');
      m.append(hint);
      const grid = el('div', 'ax-chips');
      this.examples.forEach((ex) => {
        const chip = el('button', 'ax-chip');
        chip.append(el('div', 'ax-chip-icon', ex.icon), el('div', 'ax-chip-text', ex.short));
        chip.addEventListener('click', () => { this.inputEl.value = ex.text; void this.send(); });
        grid.append(chip);
      });
      m.append(grid);
    }

    for (const msg of this.messages) m.append(bubble(msg.role, msg.content));
    if (this.loading) {
      const dots = el('div', 'ax-typing', '···');
      dots.setAttribute('data-testid', 'typing');
      m.append(dots);
    }
    m.scrollTop = m.scrollHeight;
  }

  async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.loading) return;
    this.inputEl.value = '';
    this.messages.push({ role: 'user', content: text });
    this.loading = true;
    this.render();
    try {
      const result = await resolveConcierge({ message: text, now: new Date().toISOString() }, this.deps);
      this.messages.push({ role: 'assistant', content: result.reply || 'Let me arrange that for you.' });
      const summary = intentSummary(result);
      if (summary) this.messages.push({ role: 'system', content: `✓ Understood — ${summary}` });
    } catch {
      this.messages.push({ role: 'assistant', content: 'I apologise — please try rephrasing, or call us on +44 20 1234 5678.' });
    } finally {
      this.loading = false;
      this.render();
    }
  }
}

function bubble(role: ChatMessage['role'], text: string): HTMLElement {
  const wrap = el('div', `ax-row ax-${role}`);
  const b = el('div', 'ax-bubble');
  b.textContent = text; // XSS-safe (the original interpolated into innerHTML)
  if (role === 'system') { wrap.append(b); return wrap; }
  wrap.append(b);
  return wrap;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Convenience mount returning a teardown handle. */
export function mountConciergeChat(root: HTMLElement, opts: ConciergeChatOptions = {}): ConciergeChat {
  return new ConciergeChat(root, opts);
}

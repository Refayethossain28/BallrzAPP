/**
 * HTML escaping — the single source for the `esc()` helper the three HTML apps
 * use before interpolating user/driver-controlled strings into innerHTML
 * templates (names, addresses, chat messages, rating comments, bank fields…).
 *
 * Escapes the five HTML-special characters, which also neutralises quote
 * breakouts inside HTML-parsed attribute values (e.g. inline onclick strings).
 */

const MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a value for safe interpolation into HTML. null/undefined → ''. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
}

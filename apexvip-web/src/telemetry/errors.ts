/**
 * Error telemetry (pure part). The apps' `reportError()` uses these to turn a
 * thrown value into a compact, deduplicated report for the `errors` collection
 * — replacing the silent `.catch(()=>{})` swallows so production failures
 * become visible in the admin instead of vanishing.
 */

export interface ErrorReport {
  message: string;
  stack: string;
  fingerprint: string;
  app: string;
  screen: string;
}

/** Normalize any thrown value to a message string. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e && 'message' in e) return String((e as { message: unknown }).message);
  return String(e ?? 'unknown error');
}

/**
 * A stable, short dedupe key for an error: same message + top stack frame →
 * same fingerprint, so one flaky listener can't flood the collection.
 */
export function errorFingerprint(message: string, stack = ''): string {
  const top = (stack.split('\n').find((l) => l.trim().startsWith('at ')) || '').trim();
  const src = `${message}|${top}`;
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Build the report document (caller appends its own timestamp field). */
export function formatErrorReport(e: unknown, ctx: { app: string; screen?: string }): ErrorReport {
  const message = errorMessage(e).slice(0, 500);
  const stack = (e instanceof Error && e.stack ? e.stack : '').slice(0, 1500);
  return {
    message,
    stack,
    fingerprint: errorFingerprint(message, stack),
    app: ctx.app,
    screen: ctx.screen || '',
  };
}

/**
 * Session throttle policy: report a fingerprint only once, and stop entirely
 * after `max` distinct reports (a hard cap against error loops). Mutates
 * `seen` when it approves.
 */
export function shouldReport(fingerprint: string, seen: Set<string>, max = 20): boolean {
  if (seen.has(fingerprint) || seen.size >= max) return false;
  seen.add(fingerprint);
  return true;
}

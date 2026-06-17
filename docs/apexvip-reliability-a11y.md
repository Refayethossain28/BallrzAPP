# ApexVIP — Reliability & Accessibility

## Reliability
- **Global crash reporting** — `reportError()` captures `window.onerror` and
  `unhandledrejection`, keeps the last 50 errors on-device (`apexvip_errors`) and,
  when Firebase is up, writes to a write-only Firestore `errors` collection.
- **Render guard** — `render()` is wrapped in try/catch; a screen error shows a
  friendly "Something went wrong / Reload" recovery view instead of a white screen,
  and logs the stack via `reportError`.
- **Swap in Sentry/Crashlytics** later by calling your SDK from inside
  `reportError()` — it's the single choke point for all error reporting.

## Accessibility
- **Keyboard support** — `enhanceA11y()` runs after every render and gives every
  `onclick` element button semantics (`role="button"`, `tabindex="0"`), Enter/Space
  activation, and an `aria-label` from its text when one is missing.
- **Focus visibility** — a global `:focus-visible` gold outline.
- **Reduced motion** — `prefers-reduced-motion` suppresses animations/transitions
  app-wide.

### Still to do for full WCAG 2.2 AA (manual)
- Colour-contrast audit of muted greys on dark/light themes.
- Screen-reader pass (VoiceOver/TalkBack) on the booking and payment flows.
- `aria-live` on dynamic regions (concierge replies, form errors).
- Hit-target sizes ≥ 44px and visible labels on all icon-only controls.

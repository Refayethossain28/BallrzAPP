# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** — do not open a public issue.
Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. You'll get an acknowledgement within 7 days.

Please include the app affected (e.g. `coin/`, `functions/`, `voyager/`), steps
to reproduce, and impact. Good-faith research on your own data/devices is
welcome; don't test against other people's data on the live Firebase project.

## Scope

The portfolio is offline-first: most apps store everything on-device and have
no server attack surface. The security-relevant surfaces are:

- **Cloud backend** (`functions/`, `functions-side/`) — Firebase Cloud
  Functions: booking dispatch, Stripe payments/webhooks, push notifications.
- **Firestore rules** (`firestore.rules`, `storage.rules`) — owner/member
  scoping for every cloud-enabled app (ApexVIP, Concierge, Ripple, Bloom,
  Orbit REAL, Atlas convoy, AIOS sync). Rules are unit-tested in CI
  (`functions/test`, emulator job in `.github/workflows/ci.yml`).
- **Companion servers** (`voyager/server.mjs`, `seeker/server.mjs`,
  `aios/server.mjs`, `lingua/server.mjs`, `imposter/server.mjs`, …) —
  zero-dependency local proxies. SSRF-guarded (hostname and resolved-IP
  checks), bound to localhost by default, API keys stay server-side.
- **Client-side crypto** (`coin/`, `neura/`, `ripple/` App Lock) — from-scratch
  SHA-256/ECDSA verified against published test vectors (FIPS 180-4,
  RFC 4231, RFC 6979); App Lock uses WebCrypto AES-GCM + PBKDF2.

## Secrets

No credentials are committed to this repository. Deployment credentials live
in GitHub Actions secrets; runtime secrets (Stripe, Anthropic) live in Google
Secret Manager / environment variables. Firebase *web* config values that
appear in client code are public identifiers by design, not secrets — access
control is enforced by the Firestore/Storage security rules.

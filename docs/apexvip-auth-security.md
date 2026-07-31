# ApexVIP — Auth & Security

What the client app now supports, and the one-time operator steps to switch each on.

## In the app (already wired)
- **Email/password** sign-in & registration (Firebase Auth).
- **Email verification** — sent on sign-up; a banner on Home prompts unverified
  users to verify, with a one-tap **Resend**.
- **Password reset** — "Forgot password?" sends a reset email.
- **Social sign-in** — Continue with **Google** / **Apple** (creates a client
  profile on first use).
- **Friendly errors** — Firebase error codes mapped to clear messages.
- **App Check** — activates automatically when a reCAPTCHA key is set.
- Graceful **demo fallback** when Firebase isn't configured (`client@apexvip.com`
  / `password`) so the offline prototype still works.

## Operator setup (Firebase Console)

1. **Enable sign-in providers** — Authentication → Sign-in method:
   - Email/Password (and "Email link" if desired).
   - Google.
   - Apple (needs an Apple Developer account, Services ID, key & domains).
2. **App Check** — App Check → register the web app with **reCAPTCHA v3**, copy the
   **site key** into `APEXVIP_RECAPTCHA_KEY` in `firebase.js`. Then enforce App Check
   on Firestore, Functions and Storage. (Use a debug token for local dev.)
3. **Authorized domains** — Authentication → Settings → add your production domain
   (e.g. `refayethossain28.github.io` and any custom domain) so social popups work.

## Firestore security rules

`firestore.rules` is secure-by-default (deny all, then allow). Highlights:
- Users read/write only their **own** profile.
- **Bookings** readable/updatable by the owning client, the assigned driver, or an
  admin; chat messages restricted to the booking's two participants.
- `settings` is world-readable (pricing); `analytics` is write-only; lead-capture
  collections are create-only.
- Elevated access via custom claims: `admin` and `driver`.

Deploy:
```sh
firebase deploy --only firestore:rules
```

Set custom claims from a trusted backend / Cloud Function:
```js
await admin.auth().setCustomUserClaims(uid, { admin: true });   // or { driver: true }
```

> Review these rules against your final data model and Cloud Functions before launch.
> Functions use the Admin SDK and bypass rules, so keep their own authz checks.

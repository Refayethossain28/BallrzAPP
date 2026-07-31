# Orbit — Real Mode setup

Orbit's marketplace is **real out of the box on one device**: open the app in
two tabs, book a ride in one ("👤 Ask REAL captains"), go online in 🧢 Captain
mode in the other, and accept. The request travels over `BroadcastChannel`; a
real human claims it, drives every status, and earns the real 80% into their
wallet. No account, no setup, works on the static site.

To make the same marketplace work **across different devices** (a rider on one
phone, a captain on another), Orbit syncs ride requests over Firestore.

## One-time setup (~3 minutes)

The repo already ships a Firebase project in [`config.js`](./config.js)
(`apexvip-1b4a9`, the same project the other apps use — Orbit keeps to its own
`orbit_rides` collection). To activate it:

1. **Enable anonymous sign-in** — Firebase console → Authentication →
   Sign-in method → Anonymous → Enable.
2. **Deploy the security rules** — from the repo root:

   ```sh
   firebase deploy --only firestore:rules
   ```

That's it. When the app can reach Firebase, captains see requests from every
device; when it can't (offline, `file:` URL, rules not deployed), it degrades
gracefully to same-device tabs plus the simulated fleet.

To use a **different** Firebase project, replace the object in
[`config.js`](./config.js) with your project's web config (Project settings →
General → Your apps → Web). Set it to `null` to disable cloud sync entirely.

## What the rules enforce (server-side, not just in the app)

See the `orbit_rides` block in [`../firestore.rules`](../firestore.rules):

- Only a signed-in user may create a request, only **as themselves**, only
  with `status: 'OPEN'` and a positive fare.
- The **fare and route are frozen** — no update (rider's or captain's) may
  change `fare`, `riderUid`, `fromId`, `toId` or `classId`. A captain who
  could edit the fare could charge anything; the rules make that impossible.
- A captain may only **claim an OPEN request**, stamping their own uid.
- Only the **assigned captain** may advance the trip, one legal step at a
  time (claimed → arriving → arrived → in trip → completed).
- Only the **rider** may cancel, and never once the trip has started.

The same state machine lives client-side in [`engine.js`](./engine.js)
(`marketClaim` / `marketAdvance` / `marketCancel` / `marketResolveClaim`,
unit-tested), so both tabs of the zero-config mode agree without a server.

## What "real" does and doesn't mean here

Real: two humans, two devices, one ride — real matching, real status updates,
real 80/20 earnings into the captain's wallet. Not real (yet): the money is
in-app demo credit, not a payment rail (the repo's Concierge app shows the
Stripe pattern if you want to wire real billing), and there is no vetting,
insurance or dispatch operation behind the captains. Don't use it to move
actual strangers around a city.

# ApexVIP — Backend Consolidation Plan

> ## ✅ DONE — 22 Jul 2026
> Executed by the `backend-consolidate.yml` workflow (audit → cutover, runs
> #1–#5). Findings vs. the plan below: all 18 repo callables/triggers were
> **already deployed as gen-2** with every secret in Secret Manager and the
> legacy runtime config empty, so no porting or reconciliation was needed. What
> remained was **nine orphaned gen-1 functions**; a repo-wide grep found zero
> callers, so eight were deleted (sources first backed up to
> `gs://gcf-sources-254410067879-us-central1/consolidation-backup/20260722T154302Z/`)
> and `functions:apexvip` was redeployed loudly. `whatsappWebhook` (gen-1) is the
> single deliberate survivor — it may be registered as an external Meta callback;
> confirm and retire it before launch. §8's definition of done is met, and a
> blanket `firebase deploy --only functions:apexvip` is now safe. The plan below
> is kept for history.

- **Deployed (live):** a **gen-1** codebase in the `apexvip-1b4a9` project. Source
  is *not* in this repo. It serves most of the callables the apps use.
- **Repo (`functions/`):** a **gen-2** codebase (Firebase Functions v2). Source is
  here and tested, but it's only partially deployed and overlaps with the live one.

A blanket `firebase deploy --only functions` from the repo would **delete the live
gen-1 functions it can't see** — so until this plan is done, only ever deploy with
`--only functions:<name>` for functions that already live in the repo.

---

## 1. What each app actually calls

The three apps invoke **9 callables** + rely on **2 Firestore triggers**. Where
each lives today:

| Callable (app → backend)   | In repo? | Live (gen-1)? | Notes |
|----------------------------|:--------:|:-------------:|-------|
| `getHotelRates`            | ✅       | ✅ | Amadeus proxy. Repo version is canonical. |
| `processSquarePayment`     | ✅\*     | ✅ | \*Repo version is **hardened** (#104): auth, amount check, ownership. Live one is **not** — port or replace. |
| `parseBookingIntent`       | ✅\*\*   | ✅ | **This is ApexAI.** \*\*Now a **Claude-backed gen-2** function in this repo (forces a structured `booking_intent` tool call, `ANTHROPIC_API_KEY` secret). The *live* gen-1 one is separate — reconcile/replace on cutover. |
| `sendChauffeurMessage`     | ✅       | ✅ | **Stub working** (writes `bookings/{id}/messages`). Reconcile field names + any push side-effect. |
| `submitTripRating`         | ✅       | ✅ | **Stub working** (booking + driver-average). Reconcile where ratings live. |
| `generateReferralCode`     | ✅       | ✅ | **Stub working** (per-user code on `users/{uid}`). Reconcile code format. |
| `applyReferralCode`        | ✅       | ✅ | **Stub working** (credits both, blocks self/double). Reconcile amount + anti-abuse. |
| `checkFlightStatus`        | ✅       | ✅ | **Live** via AviationStack (`FLIGHT_API_KEY`); neutral fallback if the key is unset. |
| `validateApplePayMerchant` | ✅\*     | ✅ | \*Stub — needs Apple merchant cert/key. Throws until provisioned. |
| **Trigger** `onBookingWrite`   | ✅   | ?  | Booking email/SMS. Repo gen-2. |
| **Trigger** `onBookingCreated` | ✅   | ?  | Dispatch → `open_jobs`. Repo gen-2. Overlaps with live `assignDriverToBooking`. |

Repo-only extras not called by the apps: `captureSquarePayment`,
`refundSquarePayment` (payment scaffold). `linguaAI` + `ripple*` (Lingua, Ripple)
have been **moved out** to their own `side-apps` codebase (§6 — done).

Live-only extras (no app caller, keep if used operationally): `assignDriverToBooking`,
`sendBookingConfirmation`, `onbookingstatuschange`, `notifyDriverAssigned`,
`hotelCancellation`, `whatsappWebhook`.

**Status:** all 9 callables now have repo source. `getHotelRates`,
`processSquarePayment`, `parseBookingIntent` and `checkFlightStatus` (live via
AviationStack) are real; referral / chat / rating are working Firestore
implementations; only `validateApplePayMerchant` remains a stub (needs the Apple
merchant cert/key). The remaining work is to **recover the live source**
(`functions/recovered/`), reconcile each against it, then cut over (§3 → §7).
⚠️ Do not deploy over a working gen-1 twin before reconciling.

---

## 2. Pick the source of truth

**Recommendation: the repo becomes the single source of truth**, but we *fold the
live source into it first* rather than rewrite from scratch. Rewriting 7 callables
blind risks behaviour drift (referral maths, flight-status shape, chat fan-out).

So the target is: **one repo codebase** containing the recovered live functions +
the repo's hardened/new ones, deployed under the existing names.

---

## 3. Step 1 — Recover the deployed source

You can pull the source of each deployed function:

```sh
# List everything that's actually deployed, with gen + trigger
gcloud functions list --project apexvip-1b4a9

# For each gen-1 function, find its source archive and download it
gcloud functions describe parseBookingIntent --project apexvip-1b4a9 --region <region> \
  --format='value(sourceArchiveUrl)'        # gs://gcf-sources-.../...zip
gsutil cp <that-gs-url> ./recovered/parseBookingIntent.zip
```

(Or: **Cloud Console → Cloud Functions → <fn> → Source** tab → download.) Unzip
each, diff against the repo where a function already exists, and copy the
app-facing callables (`parseBookingIntent`, `checkFlightStatus`,
`sendChauffeurMessage`, `submitTripRating`, `generateReferralCode`,
`applyReferralCode`, `validateApplePayMerchant`) into the repo's `functions/`.

> Keep the recovered source out of the repo until reviewed (gitignore `recovered/`),
> then port the cleaned versions in.

---

## 4. Step 2 — Port into one codebase

For each recovered callable:

1. Rewrite to **Functions v2** (`onCall`) to match the repo's style, OR keep it
   gen-1 in a clearly-separated file (mixing gens in one deploy is allowed; the
   constraint is name uniqueness, see §5).
2. Wire secrets via `defineSecret` (e.g. an Anthropic key if `parseBookingIntent`
   is LLM-backed — see the ApexAI note below), and bind them in the function options.
3. Add the same security baseline we applied to payments: **require `request.auth`**,
   validate inputs, and check ownership where a function mutates a booking/job.
4. Add a unit test where logic is pure (referral codes, intent parsing fallbacks),
   following `scripts/test-apexvip-*.mjs`.

> **Claude calls now use the official `@anthropic-ai/sdk`.** `linguaAI` and
> `parseBookingIntent` go through a memoized `anthropicClient(apiKey)` (one client
> per warm instance) instead of raw `fetch` — port any recovered LLM-backed
> function to the same helper. Square/Amadeus stay on `fetch` (no SDK needed).

### ApexAI / `parseBookingIntent` — **done in this repo**
ApexAI now has a Claude-backed `parseBookingIntent` in `functions/index.js`: it
mirrors `linguaAI` (model `claude-opus-4-8`, `ANTHROPIC_API_KEY` secret,
`api.anthropic.com/v1/messages`) and **forces a structured `booking_intent` tool
call** so the client keeps receiving deterministic `{intent, reply, serviceType,
pickup, …}` JSON — the same shape `_parseIntentLocal` produces, which stays as the
offline fallback. Driver-mode calls (`mode:'driver'`) return a plain `{reply}`.
On cutover, decide whether this replaces the *live* gen-1 `parseBookingIntent` or
the live one is ported here; set the `ANTHROPIC_API_KEY` secret before deploying
(`firebase functions:secrets:set ANTHROPIC_API_KEY`).

---

## 5. Step 3 — Reconcile dispatch (the deferred #3)

Two functions both want to turn a new booking into driver work:

- **live** `assignDriverToBooking` (gen-1)
- **repo** `onBookingCreated` → writes `open_jobs/{bookingId}` (status `open`,
  `market`, 80% `pay`)

Running both = double dispatch. We've chosen **`onBookingCreated`** as the single
owner — it's in git, market-aware, idempotent on booking id, and matches the
driver app's `open_jobs.where('market',…)` query.

- [x] **Admin manual broadcast fixed** — `broadcastDispatch` now writes
  `open_jobs/{bookingDocId}` (stable id, not a random one) and stamps `market`
  (+`clientId`), so admin-broadcast jobs appear in the driver query and can't
  double-broadcast. *(This was the change held back from #104.)*
- [ ] **Operational (live backend):** delete/retire `assignDriverToBooking` so it
  doesn't also dispatch. The two repo writers (`onBookingCreated` + admin
  `broadcastDispatch`) now both target the stable `open_jobs/{bookingId}` doc, so
  they coalesce rather than duplicate; whether the gen-1 `assignDriverToBooking`
  uses the same id is unknown — confirm from its recovered source before relying
  on coalescing across both backends.
- Alternative (not taken): keep `assignDriverToBooking` and retire
  `onBookingCreated` — but then the market + 80%-pay logic must be ported into it.

---

## 6. Step 4 — Split out the non-ApexVIP functions  ✅ done

`linguaAI`, `ripplePushOnMessage`, `rippleMaintenance`, `ripplePushOnCall` serve
the **Lingua** and **Ripple** apps and were only in `functions/index.js` because
of an earlier merge. They now live in their **own codebase**, `functions-side/`,
registered in `firebase.json` as the `side-apps` codebase. `functions/` is the
`apexvip` codebase. Deploy them independently:

```sh
firebase deploy --only functions:apexvip       # ApexVIP backend
firebase deploy --only functions:side-apps      # Lingua + Ripple
```

So an ApexVIP deploy never touches Lingua/Ripple and vice-versa, and each has a
smaller cold-start surface. (`@anthropic-ai/sdk` + the `anthropicClient` helper are
duplicated into `functions-side/` for `linguaAI`.)

---

## 7. Step 5 — Cut over safely

The migration hazard: **you can't deploy a function over an existing one of a
different generation** — the gen-1 must be deleted first, leaving a brief gap for
that one function. Do it per-function in a low-traffic window:

```sh
# one function at a time
firebase deploy --only functions:getHotelRates        # already same-named/gen → safe update
gcloud functions delete checkFlightStatus --project apexvip-1b4a9 --region <region>   # if gen changes
firebase deploy --only functions:checkFlightStatus    # redeploy from repo (gen-2)
```

Order: deploy the **net-new** repo functions first (no clash), then the
**same-name same-gen** updates (safe), then the **gen-changing** ones
(delete→deploy) last. Verify each in the app before the next.

**Per-function checklist**
- [ ] Source in repo, reviewed, secrets bound.
- [ ] `request.auth` enforced; inputs validated.
- [ ] Smoke-tested from the actual app screen that calls it.
- [ ] Old/duplicate version deleted.

**Rollback:** keep the recovered source zips; if a ported function misbehaves,
redeploy the original from its zip (`firebase deploy` from the unpacked recovered
dir) while you fix forward.

---

## 8. Definition of done
- [ ] All 9 app callables + both triggers have source in `functions/` and are the
      deployed versions.
- [ ] Exactly one dispatch path; admin broadcast and the function agree on
      `open_jobs` shape (id = bookingId, `market` set).
- [ ] `processSquarePayment` deployed is the **hardened** one (#104).
- [ ] Lingua/Ripple functions live in their own codebase.
- [ ] `gcloud functions list` shows no orphan/duplicate ApexVIP functions.
- [ ] Update §0 of `apexvip-go-live-checklist.md` to drop the "two backends" warning.

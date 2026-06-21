# ApexVIP — Backend Consolidation Plan

**Goal:** one Cloud Functions codebase, in this repo, that the three apps depend
on — reviewable, testable, and safe to deploy. Today there are **two**:

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
| `parseBookingIntent`       | ❌       | ✅ | **This is ApexAI.** Source only in the live backend. |
| `checkFlightStatus`        | ❌       | ✅ | Source only live. |
| `sendChauffeurMessage`     | ❌       | ✅ | Source only live. |
| `submitTripRating`         | ❌       | ✅ | Source only live. |
| `generateReferralCode`     | ❌       | ✅ | Source only live. |
| `applyReferralCode`        | ❌       | ✅ | Source only live. |
| `validateApplePayMerchant` | ❌       | ✅ | Source only live. |
| **Trigger** `onBookingWrite`   | ✅   | ?  | Booking email/SMS. Repo gen-2. |
| **Trigger** `onBookingCreated` | ✅   | ?  | Dispatch → `open_jobs`. Repo gen-2. Overlaps with live `assignDriverToBooking`. |

Repo-only extras not called by the apps: `captureSquarePayment`,
`refundSquarePayment` (payment scaffold), and `linguaAI` + `ripple*` — those
belong to **other apps** (Lingua, Ripple) and should move to their own codebases
(see §6), not ship with ApexVIP.

Live-only extras (no app caller, keep if used operationally): `assignDriverToBooking`,
`sendBookingConfirmation`, `onbookingstatuschange`, `notifyDriverAssigned`,
`hotelCancellation`, `whatsappWebhook`.

**The crux:** 7 of the 9 callables the apps depend on exist **only** in the live
backend with no source in git. Step 1 is to recover that source.

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

### ApexAI / `parseBookingIntent`
ApexAI in **this repo** does *not* call Anthropic — it calls `parseBookingIntent`
and falls back to a local rule-based parser (`_parseIntentLocal`). Whether the
*live* `parseBookingIntent` is LLM-backed is only knowable from the recovered
source. If you want ApexAI to genuinely use Claude, this is where to wire it:
mirror `linguaAI` (model `claude-opus-4-8`, `ANTHROPIC_API_KEY` secret,
`api.anthropic.com/v1/messages`), force a structured tool-call so the client keeps
getting deterministic `{intent, …}` JSON, and keep `_parseIntentLocal` as the
offline fallback.

---

## 5. Step 3 — Reconcile dispatch (the deferred #3)

Two functions both want to turn a new booking into driver work:

- **live** `assignDriverToBooking` (gen-1)
- **repo** `onBookingCreated` → writes `open_jobs/{bookingId}` (status `open`,
  `market`, 80% `pay`)

Running both = double dispatch. Decide **one** owner:

- **Keep `onBookingCreated`** (recommended — it's in git, market-aware, idempotent
  on booking id, and matches the driver app's `open_jobs.where('market',…)` query).
  Then **delete** `assignDriverToBooking`, and fix the admin app's manual
  `broadcastDispatch` to write `open_jobs` with **`doc(bookingId)`** (not a random
  id) and include the **`market`** field, so admin-broadcast jobs show up in the
  driver query too. *(This is the change held back from #104.)*
- Or keep `assignDriverToBooking` and retire `onBookingCreated` — but then port the
  market + 80%-pay logic into it.

---

## 6. Step 4 — Split out the non-ApexVIP functions

`linguaAI`, `ripplePushOnMessage`, `rippleMaintenance`, `ripplePushOnCall` serve
the **Lingua** and **Ripple** apps. They're only in `functions/index.js` because
of an earlier merge. Move them to their own Firebase codebase(s) /
`firebase.json` `codebase` entries so an ApexVIP deploy never touches them and
vice-versa. This also shrinks ApexVIP's cold-start surface.

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

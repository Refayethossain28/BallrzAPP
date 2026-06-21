# `recovered/` — deployed gen-1 source, for review only

This is the **scratch landing area** for the source of the functions that are
**deployed live** on `apexvip-1b4a9` but have **no source in this repo**. Pull them
here, diff them against the repo stubs, then fold the cleaned behaviour into
`functions/index.js`. Nothing in here is committed (see `.gitignore`).

See `docs/apexvip-backend-consolidation.md` for the full plan. Quick recipe:

```sh
# from repo root — list what's actually deployed (gen + trigger)
gcloud functions list --project apexvip-1b4a9

# for each gen-1 callable with no repo source, pull its source archive
for fn in checkFlightStatus sendChauffeurMessage submitTripRating \
          generateReferralCode applyReferralCode validateApplePayMerchant \
          parseBookingIntent assignDriverToBooking; do
  url=$(gcloud functions describe "$fn" --project apexvip-1b4a9 --region <region> \
        --format='value(sourceArchiveUrl)')
  [ -n "$url" ] && gsutil cp "$url" "functions/recovered/$fn.zip"
done
# (Or Cloud Console → Cloud Functions → <fn> → Source → download.)
```

## Reconcile against the repo stubs

`functions/index.js` now carries **v2 `onCall` stubs** for the six app-facing
callables (marked `CONSOLIDATION STUB`). For each, diff the recovered source
against the stub and decide:

| Function | Repo stub status | What to verify against live source |
|---|---|---|
| `generateReferralCode` | **Working** (per-user code on `users/{uid}`) | Code format/length; where the live one stores it. |
| `applyReferralCode` | **Working** (credits both parties, blocks self/double) | Credit amount, anti-abuse rules, collection names. |
| `sendChauffeurMessage` | **Working** (writes `bookings/{id}/messages`) | Subcollection path + field names the chat listeners read; any push/notify side-effect. |
| `submitTripRating` | **Working** (writes booking + driver aggregate) | Where ratings live; how the driver average is computed. |
| `checkFlightStatus` | **Stub** — needs a flight-data provider | Which API/key the live one uses; map its response to `{delayed,delayMins,origin,…}`. |
| `validateApplePayMerchant` | **Stub** — needs Apple merchant cert/key | Apple merchant id + certificate handling; the POST to `validationURL`. |

Then follow the §7 cut-over (delete the gen-1 function, deploy the repo one,
verify in-app, one function at a time). Do **not** deploy a stub over a working
gen-1 function before reconciling — it would regress live behaviour.

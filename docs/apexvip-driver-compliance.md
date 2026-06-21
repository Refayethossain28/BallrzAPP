# ApexVIP — Driver & Vehicle Compliance Model

How driver/vehicle credentials (licence, PCO, insurance, DBS, V5C, badge) are
collected, **verified by an admin**, tracked for expiry, and **enforced** so an
uncompliant driver can't go online or be assigned a job. This is the one
operational layer the apps didn't model; it's required before real trading
(see `apexvip-go-live-checklist.md` §0).

## The split: evidence (driver) vs. verdict (admin)

Two separate things, deliberately kept apart so a driver can't approve themselves:

| | Written by | Where | Trust |
|---|---|---|---|
| **Evidence** — the uploaded file | the driver | `drivers/{uid}.documents.{type}` | untrusted (it's just an upload) |
| **Verdict** — approved + expiry | an **admin** only | `drivers/{uid}.compliance` | authoritative; **rules block the driver from writing it** |

The apps enforce on the **verdict** (`compliance.compliant`), never on the raw
upload status.

### `drivers/{uid}.documents.{type}` (driver-writable evidence)
```jsonc
{
  "licence": { "url": "https://…", "fileName": "licence.pdf",
               "uploadedAt": "2026-06-21", "status": "pending" }
}
```
`status` here is cosmetic ("Under review") — the driver sets it, so it carries no
authority. The admin verdict is what counts.

### `drivers/{uid}.compliance` (admin-only verdict)
```jsonc
{
  "compliant": true,                     // ← the single flag the apps enforce on
  "reviewedBy": "<admin uid>",
  "reviewedAt": <serverTimestamp>,
  "docs": {
    "licence":   { "approved": true,  "expiresAt": "2031-04-02" },
    "pco":       { "approved": true,  "expiresAt": "2027-09-30" },
    "insurance": { "approved": true,  "expiresAt": "2026-12-15" },
    "dbs":       { "approved": true,  "expiresAt": "2029-01-10" },
    "v5c":       { "approved": true },                       // no expiry
    "badge":     { "approved": false, "note": "Photo unclear" }
  }
}
```

## Required documents

| Key | Document | Expiry tracked |
|---|---|:---:|
| `licence` | UK Driving Licence | ✅ |
| `pco` | PCO / Private Hire Vehicle licence | ✅ |
| `insurance` | Hire-&-reward / motor-trade insurance | ✅ |
| `dbs` | Enhanced DBS check | ✅ |
| `v5c` | Vehicle registration (V5C logbook) | — |
| `badge` | TfL PCO driver badge | ✅ |

A driver is **`compliant`** when **every** required doc is `approved` **and** no
expiry-tracked doc is past its `expiresAt`. Admins are warned about docs expiring
within **30 days**.

## Lifecycle

```
driver uploads ─▶ documents.{type}.status = pending
                      │
            admin reviews evidence in the Drivers screen
                      │
        approve (+ expiry)            reject (+ note)
                      ▼                        ▼
   compliance.docs.{type}.approved=true   approved=false
                      │
        recompute compliance.compliant = all approved & none expired
```
Expiry is live: an approved doc whose `expiresAt` has passed flips the driver
back to **not compliant** automatically (computed on read), with no admin action
needed — they must re-upload and be re-approved.

## Enforcement points

| Where | Rule |
|---|---|
| **Driver app — Go Online** | Blocked unless `compliance.compliant` is true; the toast lists what's missing/expired. |
| **Admin — manual assign** (`confirmDispatch`) | Blocked for a non-compliant driver. |
| **Admin — Drivers screen** | Each driver card shows a compliance chip (✅ Compliant / ⚠️ Expiring / ⛔ Action needed); the detail modal is the review UI. |
| **Security rules** | Drivers may write `documents` (uploads) but **not** `compliance`; only admins write the verdict. Users can't self-promote `role`. |

> Broadcast dispatch (`open_jobs`) is claimed by drivers via a transaction; the
> primary gate there is the **Go Online** block (an uncompliant driver never goes
> online, so never sees open jobs). The manual-assign block covers the admin path.
> A future hardening could also check `compliance.compliant` inside the claim
> rule/transaction.

## Vehicles (`vehicles/{id}`)

Per-vehicle records, one doc per vehicle, **admin-managed** (a driver may read
their own; only an admin writes — same self-approval guard as the compliance
verdict). Managed from the admin Drivers → driver modal.

```jsonc
{ "driverId": "<uid>", "reg": "LB12 ABC", "type": "S-Class",
  "motExpiry": "2027-03-01", "taxExpiry": "2026-11-30", "active": true,
  "createdAt": <serverTimestamp> }
```

A driver counts as compliant only if they also have **≥1 active vehicle with both
MOT and road tax in date**. Vehicle expiry feeds the same chip/gate as the
credentials, and an expired MOT/tax flips `compliant` to false (recomputed daily).

## Expiry reminders (`remindExpiringDocs`)

A daily scheduled function (08:00 Europe/London, in the `apexvip` codebase) that:
- emails the **driver** + the **ops inbox** (`OPS_EMAIL`) at 30 / 14 / 7 / 3 / 1
  days before any credential or vehicle MOT/road-tax expiry, on the day, and
  weekly once expired (via SendGrid — same `sendEmail` as booking notifications);
- **recomputes `compliance.compliant`** each day so an expired credential or
  MOT/tax takes the driver off-duty within 24h without any admin action.

Deploy with the rest of the ApexVIP backend: `firebase deploy --only functions:apexvip:remindExpiringDocs`.

## Not yet modelled (future)
- An immutable audit trail of approvals (currently last-write-wins on the verdict).
- Which specific vehicle a booking is assigned to (today dispatch carries a
  vehicle *class*, not a `vehicleId`).

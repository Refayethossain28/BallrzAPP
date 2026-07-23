# ApexVIP — Audit Log

An **append-only** record of staff actions, for a regulated PHV operator's
accountability trail. Idea borrowed from Fixr's operator console; built into the
ApexVIP admin (**Audit Log** screen).

## Model — `audit_log/{id}`
```jsonc
{ "ts": <serverTimestamp>, "actorUid": "<uid>", "actorName": "ops@apexvip.com",
  "action": "dispatch_assign", "target": "APX-1234", "detail": "to Marco R." }
```

## What's recorded
| `action` | Logged when |
|---|---|
| `booking_create` | an operator creates a booking via Quick Intake |
| `dispatch_broadcast` | a booking is broadcast to drivers |
| `dispatch_assign` | a booking is manually assigned to a driver |
| `compliance_update` | a driver's documents are reviewed/saved |
| `vehicle_add` / `vehicle_update` / `vehicle_remove` | a vehicle record changes |
| `payout` | a driver is paid out (also written **server-side** by `payoutDriver`) |
| `payout_approve` / `payout_reject` | a payout request is actioned |
| `pricing_update` | the tariff is saved |

## Immutability
Firestore rules: **create** by staff (`isAdmin()` / `isDriver()`), **read** by
admins, and **update/delete are denied for everyone** — entries can't be altered
or removed. The payout entry is additionally written **server-side** (Admin SDK)
so the money-movement record can't be skipped or forged from the client.

## Viewer
Admin → **Audit Log**: the latest 100 actions, newest first, with actor + time.

## Future
- Server-side entries for the driver-side claim and go-online events.

*(CSV export and date-range filtering shipped — see the Audit Log screen's
FROM/TO filter and "Export CSV" button.)*

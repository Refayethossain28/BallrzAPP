# ApexVIP — Screen-Capture Shot List

Exact taps to film for the documentary (pairs with `apexvip-voiceover-script.md`).
Record the real PWAs on device — **client** (`apexvip-client.html`), **driver**
(`apexvip-driver.html`), **admin** (`apexvip-admin.html`). Capture at 60fps,
portrait for the phone apps, landscape for the admin. Keep a clean demo account.

> Tip: seed demo data first (a couple of bookings, one approved driver, one
> vehicle) so boards aren't empty on camera.

| # | Scene (VO beat) | App | Exact actions to capture | Hold |
|---|---|---|---|---|
| 1 | Cold open (0:00) | — | The splash video `splash-bg.mp4` full-bleed; gold wordmark draws on. | 3s |
| 2 | Positioning (0:14) | all 3 | Quick triptych: each app's home screen, 1s each, then settle on the client home. | 4s |
| 3 | Passenger services (0:30) | client | Home → tap through **Airport / By the Hour / By the Day / Point-to-Point** chips; scroll **Discover**. | 6s |
| 4 | Hotels (0:38) | client | Open the **Hotels** tab; let live nightly rates load on 2–3 cards. | 4s |
| 5 | ApexAI (0:54) | client | Open **ApexAI** chat → type *"Collect me from Mayfair tomorrow at 9 for BA247"* → show the parsed fields fill + the confirmation card slide up. | 8s |
| 6 | Pay (1:08) | client | Booking summary → show **VAT-inclusive total** → Apple/Google Pay sheet → "Confirmed". | 5s |
| 7 | Driver online (1:14) | driver | Toggle **Go Online** → a job overlay appears → **one-tap claim**. | 6s |
| 8 | Driver trip + pay (1:24) | driver | Trip steps (en route → arrived → on board → complete); cut to **Earnings** ticking; the **Payouts · active** badge. | 6s |
| 9 | Compliance (1:34) | admin | **Drivers** → open a driver → approve documents (chips go green) → show a **red "Expired"** flag and the compliance gate. | 8s |
| 10 | Live board + audit (1:48) | admin | **Live Map** + **dispatch board**; then **Audit Log** scrolling recent actions. | 6s |
| 11 | Quick Intake (1:58) | admin | **Bookings → ⚡ Quick Intake** → paste a text booking → **Parse with ApexAI** → fields fill → **Create** → it lands on the board. | 8s |
| 12 | Comparison (2:08) | graphic | Animate the competitor table (from the deck) — green ticks march down the ApexVIP column. | 6s |
| 13 | Close (2:24) | — | Gold wordmark on black; tagline *"Beyond the journey."* fades up. | 4s |

## Capture settings
- **Phone apps:** install as PWA (Add to Home Screen) so there's no browser chrome;
  record with the device recorder or QuickTime (iPhone via cable).
- **Admin:** full-screen the browser; 1440×900+; hide bookmarks bar.
- **Cursor/taps:** enable touch-indicator on the phone; on desktop use a subtle
  click highlight.

## Honesty guardrail
Film only what exists. Don't stage a live fleet, real customer PII, or an operating
history. The licensing/insurance/go-live steps are still ahead
(`apexvip-launch-runbook.md`) — the film says **"built to launch,"** not "live."

## Asset checklist
- [ ] `splash-bg.mp4` for open/close
- [ ] Seeded demo: 2 bookings, 1 approved+vetted driver, 1 vehicle (MOT/tax in date)
- [ ] One un-vetted driver (to show the red "Expired"/blocked state)
- [ ] Competitor table graphic (export the deck slide)
- [ ] Licensed music bed + the gold wordmark sting

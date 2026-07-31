# Fixr — operator demo

Live app: **https://fixr-se8d.onrender.com**

> ⚠️ Free-tier wake-up: the first load after idle takes ~40s. **Open the URL ~1
> minute before any demo** so it's warm.

---

## The 60-second demo (screen-share or hand them your phone)

**Setup:** have three tabs open — `/` (console), `/driver/?d=d1` (driver),
`/client/` (passenger).

1. **The hook (15s).** On the console, paste a *messy real* message into AI Inbound
   Intake and hit **Parse into a booking**:
   > "need an SUV for the Hendersons tmrw around 7 to catch BA292 out of JFK, 3 ppl couple bags"

   → It extracts client, airport run, flight BA292, SUV, 3 pax, and an instant quote.
   *Say:* "Your dispatcher pastes whatever the client texts — it books itself."

2. **Dispatch (15s).** Hit **Confirm**, then on the board: **confirm → assign a
   driver → en route**. *Say:* "One board, every trip, full audit trail — nothing
   lives in someone's WhatsApp."

3. **Driver side (15s).** Switch to the driver tab → the trip is there → tap
   **Start trip**, then **Complete**. *Say:* "Your driver runs it from their phone;
   completing it captures the fare and pays the driver their cut automatically."

4. **Client side (15s).** Switch to the passenger tab → it shows the ride tracking,
   the assigned driver, the fare. *Say:* "And your VIP sees one clean experience —
   your brand, not a third-party app."

**Close:** "Flat monthly, your own Stripe, no per-ride rake — and it does your VIP
concierge requests on the same system. Want to run a week of your real trips through it?"

---

## What to emphasize per objection

| They say… | You say… |
|---|---|
| "I already use Limo Anywhere." | "Modern UI, your own Stripe — no forced processing, no payment holds, and a human answers support." |
| "Moovs is cheaper." | "Moovs takes 5% of every ride. Flat monthly here — you keep the fare." |
| "We run on spreadsheets/WhatsApp." | "Every request is owned and searchable — it doesn't walk out the door when staff leave." |
| "What about concierge requests?" | "Same engine — a dinner booking is just another request type. Transport's the wedge." |

## The ask (pick one)
- **Design partner:** "Run your next 10 trips through it — I'll set you up and sit with your dispatcher for an hour."
- **Pricing anchor:** "$149/mo flat, no rake. I onboard you personally."

(Full strategy: `GTM.md`. Economics: `MODEL.md`.)

---

## Pre-demo checklist
- [ ] Open the live URL ~1 min early (warm it up).
- [ ] `/api/health` shows `intake":"llm"` (AI on) and `db":"postgres"`.
- [ ] Three tabs ready: console, driver, client.
- [ ] (Optional) `STRIPE_SECRET_KEY` test key added so "fare captured" is real — see `PAYMENTS-SETUP.md`.
- [ ] Anthropic account has a few dollars of credit so live parses don't fall back.

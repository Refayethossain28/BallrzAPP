# 📣 Sponsored Places — Atlas's only advertising

Waze-style, sold by you, no ad networks, no tracking. A local business pays
for a **labelled pin on the map** and **at most one labelled search
suggestion** when a nearby driver searches for something related.

## The honesty rules (built into the code)

- Every sponsored surface is **labelled**: "Ad" on the map label, a
  SPONSORED badge in search, "Sponsored" on the tap card.
- **Never while driving**: pins are not drawn while actively navigating
  (following the route). They appear when browsing, planning, or stopped.
- **At most one** sponsored search suggestion, and only when the query
  genuinely relates (name match or category keywords) and the place is
  within ~12 km. Unrelated searches never show ads.
- Map pins are capped at 8, nearest first, and only at street zooms.
- **No tracking**: relevance is location + query. Nothing about the user is
  stored, profiled, or sent anywhere. The pins are plain data, like POIs.
- No sponsors → the whole feature is invisible.

## Selling a pin

Suggested pricing: **£25–50/month** per pin for a small business (compare:
a local paper ad). Use a Stripe **subscription** Payment Link so it renews.

1. Stripe Dashboard → Payment Links → **+ New** → subscription, monthly.
   - Add metadata: `product` = `atlas-sponsored`.
   - Add custom fields so the buyer tells you what to list: business name,
     address, one-line tagline, category (cafe / food / fuel / ev /
     parking / shop).
2. Share the link with the business. When they pay, the existing
   `atlasProWebhook` records the sale in **`atlas_sponsored_sales`**
   (status `awaiting-pin`) with their answers.
3. Create the pin in Firestore → **`atlas_sponsored`** (any doc id):

   ```
   name:      "Beanhouse Coffee"        (≤40 chars)
   tagline:   "Flat whites · open 7am"  (≤60 chars)
   lat:       51.50123                  (number — from a maps app)
   lon:       -0.12345
   kind:      "cafe"                    (cafe|food|fuel|ev|parking|shop)
   active:    true
   paidUntil: 1790000000000             (ms timestamp — end of paid period)
   ```

4. Mark the sale doc `status: "live"`. When they stop paying, set
   `active: false` (or just let `paidUntil` lapse — expired pins vanish
   client-side automatically).

Deploy the rules once: `firebase deploy --only firestore:rules`.

## Where ads will never go

Turn-by-turn guidance, the cockpit, voice prompts, the dashcam recording,
Guardian, and convoy screens. Ads live only in browsing/planning surfaces.
If a future PR ever violates that, it's a bug — cite this file.

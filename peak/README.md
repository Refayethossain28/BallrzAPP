# Peak — move, fuel, rest

*The brief was "design the ultimate app." This is the design.*

## The thesis

The biggest apps ever won by riding a **daily, involuntary need** (see
[`concepts/README.md`](../concepts/README.md)). The most involuntary need of
all is the one you carry around: your own body. It trains, eats and sleeps
every single day whether or not any app is watching. Peak's bet is that the
ultimate app is not the one with the most features — it's **the one that
upgrades its user**, and can prove it with a number.

So Peak collapses the three pillars of physical performance into one loop:

- **Move** — a real training plan with real progressive overload, not a
  video playlist.
- **Fuel** — calorie and macro targets computed from clinical metabolism
  math, not vibes.
- **Rest** — sleep treated as a training session, with cycle-aligned
  bedtimes and a running debt.

…and scores the day **once, honestly, out of 100**. A day scoring 60+ keeps
the streak alive; banked scores become XP and levels (*Rookie → Peak*).
Nothing is credited silently: unlogged meals score zero, and overshooting
calories scores exactly the same as undershooting by the same margin —
bingeing is not rewarded.

## What the engine knows

Every rule is a pure, deterministic, clock-injected function in
[`engine.js`](./engine.js) — zero DOM, zero I/O, unit-tested in
[`scripts/test-peak-logic.mjs`](../scripts/test-peak-logic.mjs) (30 tests):

| Domain | The math |
|---|---|
| Metabolism | Mifflin-St Jeor BMR → activity-multiplied TDEE → goal calories (cut −20% with a safety floor, build +10%) → macros (protein by g/kg per goal, fat 25% kcal, carbs fill) |
| Hydration | 35 ml/kg, clamped to a sane band |
| Strength | Epley 1RM (+ the 60–95% training-load table), greedy per-side **barbell plate math**, and **double progression** (8–12 window: top → +2.5 kg, fail → −10%, else +1 rep) |
| Programming | A deterministic split generator for 2–6 days/week × gym/dumbbells/bodyweight — seeded, so the same seed always deals the same plan |
| Fuel | A built-in food library, log totals, remaining/percent state |
| Sleep | 90-minute cycles + 15 min to drift off: last-night stats, cycle-aligned bedtimes counted back from the alarm, 7-night sleep debt |
| The loop | The Peak score (Move 40 · Fuel 30 · Rest 30 · water +5 bonus, capped at 100), streaks that an unfinished today can't break, XP banking, a triangular level curve, and a seeded daily prompt |

[`index.html`](./index.html) owns everything else — four tabs (Today, Train,
Fuel, Rest), `localStorage` persistence, the service-worker shell. No
account, no tracking, fully offline, installable PWA.

## Honest limitations

This is a concept prototype: the food library is 20 staples (not a barcode
database), steps are typed in (no HealthKit bridge), and the formulas are
population estimates — guidance, not medical advice.

# ＋ Lifeline — emergency first aid that works when nothing else does

**Lifeline** is an offline-first emergency companion: step-by-step first-aid
guides, one-tap emergency numbers for 40+ regions, disaster-preparedness
checklists, and a medical ID card responders can read in seconds.

Why it matters: in the moments that decide whether someone lives —
cardiac arrest, choking, severe bleeding, anaphylaxis — most bystanders
freeze because they don't know what to do. And in exactly the situations
where help is needed most (disasters, remote areas, network outages),
internet connectivity is the first thing to fail. Lifeline is built for
that gap:

- **Works with zero signal.** A service worker precaches the entire app on
  first visit. After that it opens instantly, forever, with no network.
- **No account, no server, no tracking.** There is literally no backend.
  Your medical ID and checklist progress live only in your browser's local
  storage.
- **Installable.** Add it to any phone's home screen as a PWA — it behaves
  like a native app at 0 bytes of app-store friction.
- **No build step, no dependencies.** Plain HTML/CSS/JS modules. Anyone can
  audit every line in minutes, host it anywhere, or copy it onto a USB
  stick for a community centre.

## What's inside

| Tab | What it does |
| --- | --- |
| 🚨 Emergency | Searchable library of 18 first-aid guides (CPR adult/child, choking, bleeding, stroke FAST, heart attack, anaphylaxis, burns, seizures, drowning, poisoning, hypothermia, heatstroke, fractures, head injury, recovery position, nosebleed), each as large-type numbered steps written for a panicking bystander. A pinned one-tap call button dials your region's emergency number. |
| 📞 Numbers | Emergency numbers for 40+ countries/regions, tap-to-dial, with a saved "home region". |
| 🎒 Prepare | Three research-backed checklists — 72-hour go-bag, shelter-in-place home kit, and a household emergency plan — with locally saved progress. |
| 🪪 My Card | An In-Case-of-Emergency medical ID (blood type, allergies, conditions, medications, contacts) that responders can read from the lock screen, printable to keep in a wallet. Stored on-device only. |

## Run it

It's a static site — any file server works:

```bash
cd lifeline
python3 -m http.server 8080
# open http://localhost:8080
```

(Service workers require `localhost` or HTTPS.)

## Test it

Data integrity is tested with Node's built-in test runner — no dependencies:

```bash
node --test lifeline/test/data.test.mjs
```

Tests verify every guide is complete and actionable, life-threatening
scenarios always say "call first", every region has dialable numbers, and
checklists are substantial and duplicate-free.

## Medical content

Guidance follows widely published public first-aid standards (European
Resuscitation Council, Red Cross, NHS public guidance). Lifeline is a
quick-reference aid — it is **not** medical advice, not a substitute for
accredited first-aid training, and never a reason to delay calling your
local emergency number.

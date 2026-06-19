# BallrzAPP

Product concepts and runnable prototypes for two consumer apps, plus an earlier
trading-app build. Full write-ups live in [`concepts/`](./concepts/).

## ▶️ Live demos

Live on GitHub Pages — open on desktop or mobile, no install needed:

- **[Landing page](https://refayethossain28.github.io/BallrzAPP/)** — links to everything below
- **⭐ [Ripple — private messenger](https://refayethossain28.github.io/BallrzAPP/ripple/)** — a messaging app like WhatsApp, but one that finally puts you in control. **Schedule** messages to send later, **edit** and **unsend** them, set a chat to **auto-disappear**, run inline **polls**, fire **slash commands** (`/poll`, `/remind 10m …`, `/expire 1h`, `/me`, `/shrug`, `/shout`, `/clear`), write rich text (`*bold*`, `_italic_`, `` `code` ``), record voice notes, send photos, and **search every chat instantly**. Reactions, threaded replies, delivery & read ticks, typing indicators, pin / mute / archive, starred messages, per-chat wallpapers and accent. Optional **App Lock** encrypts everything on the device (AES-GCM, PBKDF2). It's alive out of the box: message the built-in **Echo** auto-responder, or open two tabs to chat live over `BroadcastChannel` — **no account needed to try it**. The product logic (search ranking, disappearing/scheduled dispatch, poll tally, reaction toggling, sync de-duplication) lives in [`ripple/engine.js`](./ripple/engine.js) and is deterministic and unit-tested (`npm run test:ripple`). Going multi-user with real people is one transport swap away — the data model, Firestore wiring and E2E-encryption plan are in [`ripple/SETUP.md`](./ripple/SETUP.md). Offline-first, **installable PWA**.
- **⭐ [Cusp — what to do right now](https://refayethossain28.github.io/BallrzAPP/cusp/)** — the decision engine your to-do list is missing. Every other app *lists* your tasks; Cusp *decides*: of everything on your plate, what should you do **right now**? The on-device **Salience Engine** (a proprietary, fully-specified scoring algorithm — see [`cusp/engine.js`](./cusp/engine.js)) scores every task across six fields — importance, deadline *tightness* (effort ÷ time left, not just time left), how its mental load fits your current energy, whether it fits the minutes you actually have free, momentum (context-switch cost), and staleness — then **shows its working** so the recommendation is auditable, not a black box. Add tasks, set "I've got 25 minutes" and your energy, and Cusp surfaces the one thing, a right-now plan that packs your window, a focus timer, dependency gating, and a decision-debt nudge for tasks you keep skipping. Deterministic and unit-tested (`npm run test:cusp`), offline, no account, **installable PWA**.
- **⭐ [Omni — do-everything app](https://refayethossain28.github.io/BallrzAPP/omni/)** — one offline-first home for your day: tasks & calendar, notes, calculator, unit/currency converter, timers & pomodoro, habit streaks, money log, weather, text tools, password generator, **QR codes** (a from-scratch encoder, verified bit-for-bit against a reference library) and a world clock — with a ⌘K command palette to jump anywhere. No account, no cloud, **installable PWA**, everything stored on-device. Pure logic is covered by `npm test`.
- **🗣️ [Lingua — learn & translate any language](https://refayethossain28.github.io/BallrzAPP/lingua/)** — pick from 90+ languages, then **translate** text or get a short **teaching** lesson with pronunciation. Real dialect support: Arabic *Fusha (MSA), Egyptian, Saudi, Emirati, Levantine, Gulf, Iraqi, Maghrebi* and Urdu *Standard, Lahori, Karachi, Dakhini, Hyderabadi, Rekhta*. Runs offline with a built-in starter phrasebook; toggle **Live AI** to route translations and lessons through Claude via a zero-dependency local proxy ([`lingua/server.mjs`](./lingua/server.mjs)) that keeps your API key server-side. **Installable PWA**. Start the proxy with `cd lingua && ANTHROPIC_API_KEY=sk-ant-… node server.mjs`.
- **[Apex](https://refayethossain28.github.io/BallrzAPP/rentmatch.html)** — UK lettings marketplace. Landlords advertise property (with real listing photos, offline illustration fallback), renters search & enquire, both parties message and book a viewing, then sign a UK-compliant Assured Shorthold Tenancy. The landlord is charged £100 on signing. Toggle **Renter ↔ Landlord** in the header to play both sides — the whole deal lifecycle runs in one browser, offline. **Installable PWA** with an Apex splash screen (Safari/Chrome → Add to Home Screen). The production architecture lives in [`rentmatch/`](./rentmatch/) and [`docs/rentmatch-foundation.md`](./docs/rentmatch-foundation.md).
- **[Concierge split](https://refayethossain28.github.io/BallrzAPP/concepts/prototypes/concierge-split/)** (Concept 1) — chat → agent proposes a bill split → you confirm → idempotent payment requests. Runs offline in stub mode; the "Live" Claude toggle needs the local proxy.
- **[Flow game](https://refayethossain28.github.io/BallrzAPP/concepts/prototypes/flow-game/)** (Concept 2) — adaptive tap arcade: on-device skill model + offline level pool keep every round on the edge. Lives, combos, bonuses, 2-player duel, sound, and an **installable PWA**.
- **[FX Signal Pro](https://refayethossain28.github.io/BallrzAPP/trading-app/fx-signal-pro.html)** — single-file currency-pair trading signal app.

### 📲 Install Flow as an app

The Flow game is a PWA — add it to your home screen for a full-screen, offline,
native-feeling launch:

- **iOS (Safari):** open the [Flow game](https://refayethossain28.github.io/BallrzAPP/concepts/prototypes/flow-game/) → **Share** → **Add to Home Screen**.
- **Android (Chrome):** open it → menu **⋮** → **Install app** / **Add to Home screen**.

## Concepts

| # | Concept | Spec | Prototype |
|---|---------|------|-----------|
| 1 | AI Life Concierge | [`concepts/01-ai-life-concierge.md`](./concepts/01-ai-life-concierge.md) | [web](./concepts/prototypes/concierge-split/) · [native iOS slice](./concepts/concept-1-concierge/) |
| 2 | AI Infinite Game | [`concepts/02-ai-infinite-game.md`](./concepts/02-ai-infinite-game.md) | [web](./concepts/prototypes/flow-game/) |

See the [concepts index](./concepts/README.md) for the full reasoning, build
order, and what would kill each idea.

## Running locally

The web prototypes are zero-build single-file HTML — clone and open:

```sh
git clone https://github.com/refayethossain28/BallrzAPP.git && cd BallrzAPP
open ripple/index.html                     # WhatsApp-but-better private messenger
open cusp/index.html                       # "what to do right now" — the Salience Engine
open omni/index.html                       # the do-everything super-app
open lingua/index.html                     # learn & translate any language (+ dialects)
open concepts/prototypes/flow-game/index.html
```

Live AI translations & lessons in Lingua (key stays server-side):

```sh
cd lingua
ANTHROPIC_API_KEY=sk-ant-... node server.mjs   # then open http://localhost:8788
```

Live Claude tool-use in the concierge prototype:

```sh
cd concepts/prototypes/concierge-split
ANTHROPIC_API_KEY=sk-ant-... node server.mjs   # then open index.html, toggle "Live"
```

The Concept 1 native iOS slice (SwiftUI + a `swift test`-able kernel) opens in
Xcode 15+ — see [its README](./concepts/concept-1-concierge/).

---

<details>
<summary>Original app entry point</summary>

```swift
import SwiftUI
import Firebase

@main
struct BallrzApp: App {
    init() {
        FirebaseApp.configure()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
```
</details>

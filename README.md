# BallrzAPP

Product concepts and runnable prototypes for two consumer apps, plus an earlier
trading-app build. Full write-ups live in [`concepts/`](./concepts/).

## ▶️ Live demos

Live on GitHub Pages — open on desktop or mobile, no install needed:

- **[Landing page](https://refayethossain28.github.io/BallrzAPP/)** — links to everything below
- **⭐ [Omni — do-everything app](https://refayethossain28.github.io/BallrzAPP/omni/)** — one offline-first home for your day: tasks & calendar, notes, calculator, unit/currency converter, timers & pomodoro, habit streaks, money log, weather, text tools, password generator, **QR codes** (a from-scratch encoder, verified bit-for-bit against a reference library) and a world clock — with a ⌘K command palette to jump anywhere. No account, no cloud, **installable PWA**, everything stored on-device. Pure logic is covered by `npm test`.
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
open omni/index.html                       # the do-everything super-app
open concepts/prototypes/flow-game/index.html
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

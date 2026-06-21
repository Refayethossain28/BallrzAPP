# Lingua — learn & translate any language (and its dialects)

A single-file, offline-first **PWA** for learning and translating any of 90+
languages. Pick a language and you get:

- **📚 Learn** — a structured course: ordered units (greetings → numbers →
  travel → …) with on-device progress tracking. Open a unit for a lesson, then
  jump straight into practice or chat for it. Tick units off as you go.
- **🔁 Translate** — type text in any language and translate it into the one
  you're studying (and back, via the swap arrow). Results show the native
  script, romanized pronunciation, a literal gloss, register, and dialect notes.
- **🎓 Teach me** — pick a topic and level for a short, dialect-aware lesson with
  pronunciation, plus an "ask anything about this language" box.
- **🃏 Practice** — turn a topic into **flashcards** (recall + reveal, mark
  *Got it* / *Again*) and a **multiple-choice quiz** with scoring. AI-generated
  sets when Live AI is on; offline basics otherwise.
- **💬 Chat** — practise a real conversation with an AI tutor who replies in your
  chosen dialect, gives romanization + an English gloss, and gently corrects you.
- **🔊 Listen** — tap the speaker on any phrase to hear it read aloud (browser
  speech synthesis; uses the dialect's voice where available). Works offline.
- **🎤 Speak** — dictate into the translate box or chat with the mic button
  (Web Speech API; Chrome/Edge/Safari).
- **🕘 Saved** — every translation is saved on-device automatically; reopen, replay
  the audio, or delete from the **Saved** panel. No account, no cloud.

### Dialect support
- **Arabic** — Fusha (MSA), Egyptian, Saudi, Emirati, Levantine, Gulf, Iraqi,
  Maghrebi, Sudanese, Yemeni.
- **Urdu** — Standard, Lahori, Karachi, Dakhini, Hyderabadi, Rekhta.
- **English** — British, American, Australian, Indian.
- **Spanish** — Castilian, Mexican, Rioplatense, Colombian/Andean.
- **Portuguese** — Brazilian, European · **French** — Metropolitan, Québécois ·
  **German** — Germany, Austrian, Swiss · **Chinese** — Mainland, Taiwan.

Each is treated as a distinct variety with its own phrasing and notes.

## Launching it

### Option 0 — Open it and paste your Anthropic key (quickest; works on the live link)

Open the app (locally or the hosted link), tap the **AI** pill (top-right), and
paste your `sk-ant-…` key. It's stored **only in your browser** (localStorage)
and sent **directly** to `api.anthropic.com` using Anthropic's official
`anthropic-dangerous-direct-browser-access` header — no proxy, no deploy. The
pill flips to **AI: your key** and everything (Translate, Teach, Practice, Chat,
Learn) uses real Claude.

> ⚠️ Bring-your-own-key sends the key from the browser. Great for your own
> device; on a shared/public machine use the local proxy or hosted function
> instead. Get a key at <https://console.anthropic.com> → API Keys.

### Option 1 — Open it directly (offline mode)

The app is one HTML file. Just open it in a browser:

```sh
open lingua/index.html        # macOS
# xdg-open lingua/index.html  # Linux
# start lingua\index.html     # Windows
```

You get the full UI and a built-in starter phrasebook (a few essentials per
language). The AI pill shows **offline**; free-form translations and lessons
will prompt you to enable Live AI.

### Option 2 — Run with Live AI (accurate translations & lessons) — recommended

This starts a tiny zero-dependency proxy (`server.mjs`) that routes
Translate / Teach / Ask to **Claude**. Your API key stays server-side — the
browser never sees it. Requires **Node 18+** and an Anthropic API key
(get one at <https://console.anthropic.com> → API Keys):

```sh
cd lingua
ANTHROPIC_API_KEY=sk-ant-... node server.mjs
```

You'll see `Lingua on http://localhost:8788`. Open **http://localhost:8788** in
your browser — the pill flips to **AI: live** and every answer is labelled
"✦ Claude AI".

> Open the page via `http://localhost:8788`, not as a `file://`, so the page and
> the `/ai` proxy share one origin.

**Options:**

| Variable            | Default           | Purpose                          |
| ------------------- | ----------------- | -------------------------------- |
| `ANTHROPIC_API_KEY` | _(none)_          | Enables Live AI. Without it, the client uses the offline starter set. |
| `PORT`              | `8788`            | Port to serve on.                |
| `LINGUA_MODEL`      | `claude-opus-4-8` | Model id (e.g. `claude-sonnet-4-6`). |

### Confirm the AI is connected (one-command self-test)

With the server running in another terminal, check the health endpoint and post
a sample translation. If Claude is wired up you'll get a real translation back:

```sh
# 1) Is the key loaded?  →  expect "live":true
curl -s http://localhost:8788/health

# 2) Ask Claude to translate "Good morning, how are you?" into Egyptian Arabic
curl -s -X POST http://localhost:8788/ai \
  -H 'content-type: application/json' \
  -d '{"mode":"translate","text":"Good morning, how are you?","sourceName":"English","targetName":"Arabic","dialect":"Egyptian"}'
```

- **Connected:** step 1 shows `"live":true` and step 2 returns
  `{"ok":true,"result":{"translation":"…","pronunciation":"…",…}}`.
- **Not connected:** step 1 shows `"live":false` and step 2 returns
  `{"ok":false,"error":"no ANTHROPIC_API_KEY in env"}` — set the key and restart
  the server.

### Option 3 — Hosted (cloud) AI for the live web link

So the public link (GitHub Pages) gets accurate AI **without anyone running a
local proxy**, Lingua can call a Firebase Cloud Function (`linguaAI`) that holds
the Anthropic key server-side. The function lives in this repo at
[`functions/index.js`](../functions/index.js).

Deploy it once (needs the Firebase CLI and access to the project):

```sh
firebase functions:secrets:set ANTHROPIC_API_KEY      # paste your sk-ant-… key
firebase deploy --only functions:linguaAI
```

That's it — the client is already wired to use it. On the hosted page, the AI
pill flips to **AI: cloud** on the first successful call. Notes:

- The browser calls the function via the Firebase SDK; the key never reaches the
  client. The web Firebase config in `index.html` is the public project config
  (safe to expose).
- To disable the cloud fallback entirely, set `LINGUA_HOSTED_AI = false` near the
  top of the `index.html` script.
- The callable caps input length to bound cost on a public endpoint. For heavier
  protection, enable Firebase **App Check** on the function.

**Engine priority:** local proxy (`/health` live) → your own key (BYOK) → hosted
`linguaAI` → offline starter set. Every answer is labelled so you always know
which produced it.

### Install as an app (PWA)

Open the page in Safari/Chrome → **Add to Home Screen** / **Install app** for a
full-screen, offline launch.

## How it works

- The model does the linguistics — translation, dialect rendering, romanization
  and grammar explanation — which is what a strong LLM is good at and what
  hard-coded tables get wrong.
- For Translate, Teach, Practice and Chat the proxy **forces a tool call**, so
  Claude returns structured JSON the front-end renders deterministically (no
  brittle parsing). Chat additionally passes the running conversation.
- For free-form **Ask**, Claude answers in prose.
- Audio (🔊), speech input (🎤) and Saved translations are pure on-device browser
  features — they need no AI engine and work offline.
- The same logic runs in two places: `server.mjs` (local proxy) and the
  `linguaAI` Cloud Function (hosted), so both paths return identical shapes.
- When no AI engine is reachable, the client falls back to the offline starter
  set and clearly labels every answer (`✦ Claude AI` vs. `offline starter set`).
- Audio and Saved translations are pure on-device features — they keep working
  with no network and no AI engine.

## Files

| File                    | What it is                                          |
| ----------------------- | --------------------------------------------------- |
| `index.html`            | The whole app (UI + logic, single file).            |
| `server.mjs`            | Zero-dependency local Claude proxy (`npm start`).   |
| `../functions/index.js` | Hosted `linguaAI` Cloud Function (cloud AI path).   |
| `manifest.json`         | PWA manifest.                                        |
| `sw.js`                 | Service worker (offline shell; never caches `/ai`). |
| `icon.*`                | App icons (regenerate via `node scripts/gen-lingua-icons.mjs`). |

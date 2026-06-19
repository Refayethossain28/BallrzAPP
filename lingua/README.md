# Lingua — learn & translate any language (and its dialects)

A single-file, offline-first **PWA** for learning and translating any of 90+
languages. Pick a language and you get two modes:

- **🔁 Translate** — type text in any language and translate it into the one
  you're studying (and back, via the swap arrow). Results show the native
  script, romanized pronunciation, a literal gloss, register, and dialect notes.
- **🎓 Teach me** — pick a topic and level for a short, dialect-aware lesson with
  pronunciation, plus an "ask anything about this language" box.

### Dialect support
- **Arabic** — Fusha (MSA), Egyptian, Saudi, Emirati, Levantine, Gulf, Iraqi,
  Maghrebi.
- **Urdu** — Standard, Lahori, Karachi, Dakhini, Hyderabadi, Rekhta.

Each is treated as a distinct variety with its own phrasing and notes.

## Launching it

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

### Install as an app (PWA)

Open the page in Safari/Chrome → **Add to Home Screen** / **Install app** for a
full-screen, offline launch.

## How it works

- The model does the linguistics — translation, dialect rendering, romanization
  and grammar explanation — which is what a strong LLM is good at and what
  hard-coded tables get wrong.
- For Translate and Teach the proxy **forces a tool call**, so Claude returns
  structured JSON the front-end renders deterministically (no brittle parsing).
- For free-form **Ask**, Claude answers in prose.
- When the proxy is unreachable, the client falls back to the offline starter
  set and clearly labels every answer (`✦ Claude AI` vs. `offline starter set`).

## Files

| File              | What it is                                          |
| ----------------- | --------------------------------------------------- |
| `index.html`      | The whole app (UI + logic, single file).            |
| `server.mjs`      | Zero-dependency local Claude proxy (`npm start`).   |
| `manifest.json`   | PWA manifest.                                        |
| `sw.js`           | Service worker (offline shell; never caches `/ai`). |
| `icon.*`          | App icons (regenerate via `node scripts/gen-lingua-icons.mjs`). |

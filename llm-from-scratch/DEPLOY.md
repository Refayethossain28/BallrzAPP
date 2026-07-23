# Deploy the Live AI (Fable 5) proxy

The **My Own AI Model** page ([`web/`](./web/)) ships a from-scratch GPT that runs
entirely in the browser. The optional **⚡ Live AI (Fable 5)** toggle routes the
same prompt box to real frontier Claude through [`server.mjs`](./server.mjs), a
zero-dependency Node proxy that keeps your Anthropic API key server-side.

Locally that's just:

```bash
ANTHROPIC_API_KEY=sk-ant-... node server.mjs   # http://localhost:8789
```

To make the toggle work on the **hosted** GitHub Pages page too, the prompt needs
a public proxy. There are two ways:

## Option A — Firebase Cloud Function (already wired, auto-deploys)

The repo ships an HTTPS function, **`llmLive`** in
[`functions-side/index.js`](../functions-side/index.js), that does exactly what
`server.mjs` does but hosted — reusing the project's existing `ANTHROPIC_API_KEY`
secret (the same one Lingua uses). The GitHub Pages app defaults to this function
(`https://us-central1-apexvip-1b4a9.cloudfunctions.net/llmLive`), so the toggle
lights up on the hosted page with **no setup** — *as long as*:

1. The `FIREBASE_SERVICE_ACCOUNT` repo secret is set (the `firebase-deploy.yml`
   workflow uses it to auto-deploy `functions-side/**` on push to `main`).
2. The project's `ANTHROPIC_API_KEY` secret exists:
   `firebase functions:secrets:set ANTHROPIC_API_KEY`.

If either is missing the function simply isn't reachable and the app falls back to
the on-device model (the toggle stays greyed out) — nothing breaks. To deploy by
hand: `firebase deploy --only functions:side-apps --project apexvip-1b4a9`.

## Option B — any Node host (Render, Fly, a VPS)

Prefer to run the standalone `server.mjs` instead? Deploy it and paste its URL into
the app via **“connect Fable 5 proxy”** (that overrides the default above).

## Deploy on Render (free)

1. Go to **dashboard.render.com → New → Web Service** and pick this repo
   (`refayethossain28/BallrzAPP`), branch `main`.
2. Set:
   - **Root Directory:** `llm-from-scratch`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
3. **Environment → Add Environment Variable** (mark secret):
   - `ANTHROPIC_API_KEY` = your `sk-ant-…` key
   - *(optional)* `LLM_LIVE_MODEL` = `claude-fable-5` (default), or any current Claude id
   - *(optional)* `ALLOW_ORIGINS` = `https://refayethossain28.github.io` (the default
     already includes this; add more comma-separated origins if you fork the page)
4. Create the service. Render gives you a URL like `https://my-ai-model.onrender.com`.
5. Open the hosted app → tap **“connect Fable 5 proxy”** under the Generate button →
   paste that URL. The toggle lights up and **⚡ Live AI (Fable 5)** streams from the
   real model. (The URL is saved on your device in `localStorage`; nothing is
   committed to the repo.)

Any host that runs Node works the same way (Fly.io, Railway, a VPS) — it only needs
`ANTHROPIC_API_KEY` in the environment and a public HTTPS URL.

## ⚠️ Cost & abuse note — read this

A public proxy holds **your** API key, so anyone who reaches it can spend your
Anthropic credits. **Option A (the Firebase default) is baked into a public page, so
the URL is effectively public** — same tradeoff the repo already makes for Lingua's
hosted AI. Built-in brakes are *deterrents, not a paywall*:

- **CORS origin allowlist** — browsers on other sites are refused (`ALLOW_ORIGINS`).
  This does **not** stop non-browser clients (curl, scripts), which ignore CORS.
- **Short replies** — `max_tokens` capped at 512 (`LLM_MAX_TOKENS`).
- **Per-IP rate limit** — the standalone `server.mjs` adds one (`LLM_RATE_MAX`,
  `LLM_RATE_WINDOW_MS`); the serverless function relies on input caps + your
  Anthropic spend limit instead.

**Strongly recommended: set a monthly spend limit in your Anthropic console.** That
is the real backstop. Beyond that: keep any standalone URL private-ish, suspend the
service when done, and for real protection put the proxy behind auth (a secret your
own front-end sends) or a platform rate-limiter. If you'd rather the hosted page
*not* use your key for every visitor, don't deploy `llmLive` (or unset the
`ANTHROPIC_API_KEY` secret) — the app falls back to the on-device model, and you can
still use Live AI locally.

# Deploy the Live AI (Fable 5) proxy

The **My Own AI Model** page ([`web/`](./web/)) ships a from-scratch GPT that runs
entirely in the browser. The optional **⚡ Live AI (Fable 5)** toggle routes the
same prompt box to real frontier Claude through [`server.mjs`](./server.mjs), a
zero-dependency Node proxy that keeps your Anthropic API key server-side.

Locally that's just:

```bash
ANTHROPIC_API_KEY=sk-ant-... node server.mjs   # http://localhost:8789
```

To make the toggle work on the **hosted** GitHub Pages page too, deploy the proxy
somewhere public and point the page at it.

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

A public proxy holds **your** API key, so anyone who learns the URL can spend your
Anthropic credits. The proxy has built-in brakes, but they are *deterrents, not a
paywall*:

- **CORS origin allowlist** — browsers on other sites are refused (`ALLOW_ORIGINS`).
  This does **not** stop non-browser clients (curl, scripts), which ignore CORS.
- **Per-IP rate limit** — default 20 requests/minute (`LLM_RATE_MAX`,
  `LLM_RATE_WINDOW_MS`).
- **Short replies** — `max_tokens` capped at 512 (`LLM_MAX_TOKENS`).

Recommended: set a **spend limit** in your Anthropic console, keep the Render URL
private-ish (don't post it publicly), and **suspend/delete the service** when you're
done demoing. On Render's free tier the service also sleeps when idle, which limits
runaway cost. If you want real protection, put the proxy behind auth (e.g. a secret
header your own front-end sends) or a platform rate-limiter.

# Deploy Voyager's proxy — open any site on the hosted page

The hosted Voyager (GitHub Pages) is a *static* page. Big sites — Google,
YouTube's homepage, most logins — send an `X-Frame-Options` header that tells
the browser "never show me inside a frame," and **only a server can strip that
header**. A static page cannot. So to open those sites, Voyager's proxy
(`voyager/server.mjs`) has to run *somewhere*.

You deploy it **once**, paste its URL into Voyager's Settings, and from then on
the hosted site opens any site — for you and anyone you share it with.

> **Read this first — it's a web proxy.** Whoever runs the proxy can see the
> traffic that flows through it, and an open proxy can be abused by strangers
> (bandwidth, using it as an anonymiser). Keep the built-in **SSRF guard on**
> (the default), and for a public deploy set a **`PROXY_KEY`** (see "Locking it"
> below) so only you can use it. Watch your host's usage/billing. Don't put
> anything you wouldn't run yourself behind it.

## What you're deploying

A single zero-dependency Node file: `voyager/server.mjs` (it loads
`voyager/proxy.js` next to it). Node 18+. It listens on `$PORT`, serves the app
at `/`, proxies at `/proxy?url=…`, and answers `/__voyager/ping`.

Environment variables:

| Var | Set it to | Why |
|-----|-----------|-----|
| `PORT` | (platform sets this) | the port to listen on |
| `HOST` | `0.0.0.0` | bind all interfaces so the platform can reach it |
| `PROXY_KEY` | *(optional)* a long random string | locks the proxy — see "Locking it" below |

Leave `VOYAGER_ALLOW_PRIVATE` **unset** in production — it disables the guard
that blocks internal/loopback hosts, and is only for local dev/tests.

### Locking it (optional but recommended for a public deploy)

By default the proxy is **open** (anyone with the URL can use it; the SSRF
guard still blocks internal hosts). To restrict it to just you, set a
**`PROXY_KEY`** env var to any long random string, then in Voyager →
**Settings → Full browser (proxy)** append `?key=<that value>` to the URL,
e.g. `https://voyager-proxy.onrender.com/proxy?key=abc123…`. The key travels in
the URL, so it works even on phones (unlike an Origin allowlist, which browsers
often drop on framed navigations). Requests without the right key get a 403.

> Don't use `ALLOWED_ORIGINS` — it's kept only for back-compat and is
> unreliable, because mobile browsers frequently omit the Origin/Referer header
> when loading a page inside a frame.

## Option A — Render.com (free tier, no card, easiest)

The repo already ships a Render **Blueprint** (`render.yaml`) with a
`voyager-proxy` service, so this is nearly one click:

1. On [dashboard.render.com](https://dashboard.render.com): **New → Blueprint**.
2. Pick this repo (`refayethossain28/BallrzAPP`) and the `main` branch → **Apply**.
   Render reads `render.yaml`, finds `voyager-proxy`, and deploys it with
   `HOST=0.0.0.0` already set. (The blueprint also lists other apps — deploy
   only `voyager-proxy` if that's all you want.)
3. When it's live, copy its URL, e.g. `https://voyager-proxy.onrender.com`.
4. In Voyager → **Settings → Full browser (proxy)**, paste that URL (just the
   address — `/proxy` is added for you). The status line turns green
   **✓ connected**. Now open Google. *(To lock it to just you, add a
   `PROXY_KEY` — see "Locking it" above.)*

Prefer to do it by hand instead of the blueprint? **New → Web Service**, connect
the repo, Runtime **Node**, Build command `npm install`, Start command
`node voyager/server.mjs`, and add the two env vars above.

> Free-tier note: Render spins the service down after ~15 min idle, so the
> first page after a nap takes ~30s to wake. A paid instance or a cheap
> always-on host avoids that.

## Option B — Fly.io / Railway

Same idea — point the start command at `node voyager/server.mjs`, set `HOST=0.0.0.0`
(and optionally `PROXY_KEY`). Fly needs a tiny `fly.toml` with an `[http_service]` on the
internal port your `PORT` uses; Railway autodetects the start command.

## Option C — Google Cloud Run (fits this repo's Firebase project)

Cloud Run runs a container. From the repo root:

```sh
gcloud run deploy voyager-proxy \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars HOST=0.0.0.0 \
  --command node --args voyager/server.mjs
```

It prints a `https://voyager-proxy-….run.app` URL — paste it into Settings
(`/proxy` is added for you).

## Option D — any VPS / your own box

```sh
HOST=0.0.0.0 PORT=8790 node voyager/server.mjs   # add PROXY_KEY=… to lock it
```

Put it behind a TLS reverse proxy (Caddy/nginx) so the URL is `https://` — the
hosted app is HTTPS and browsers block mixed content, so the proxy must be HTTPS
too. Then paste `https://your-domain` into Settings (`/proxy` is added for you).

## After deploying

- **Settings → Full browser (proxy)** should show **✓ connected**.
- Type `google.com` — it opens. In-page links and searches drive the omnibox,
  history and back/forward, because the proxy injects a small bridge script.
- YouTube **videos** already play without any of this (Voyager loads YouTube's
  embeddable player) — the proxy is for everything else.

## Honest limits

It's a proxy, not a browser engine. Very heavy single-page apps, DRM video
playback, WebSocket-heavy apps and cookie-based logins (cookies are not
forwarded, by design) may partially work or not at all. Static-ish sites, docs,
news, search results and most content render fine.

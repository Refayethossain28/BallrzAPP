# Put your TimeCoin network on the internet (free, ~5 minutes)

One deploy gives you a URL that **is** a shared TimeCoin network: anyone who
opens it gets the app, already connected to your relay. Phones, laptops,
friends on the other side of the world — all mining and paying on one chain.

## Deploy to Render (free tier)

1. Go to **[dashboard.render.com](https://dashboard.render.com)** and sign in
   with your GitHub account.
2. Click **New → Web Service** and pick your **BallrzAPP** repository.
3. Fill in exactly:
   - **Root Directory:** `coin`
   - **Build Command:** *(leave empty)*
   - **Start Command:** `node server.mjs`
   - **Instance Type:** `Free`
4. Click **Deploy Web Service** and wait for it to go live.

That's it — the server has zero dependencies, so there is nothing to build.

## Use it

- Your service gets a URL like `https://ballrzcoin.onrender.com`. **Open it on
  any device** — the app loads and shows *"⇄ relay connected — syncing across
  devices"*. No settings needed: the app detects it's being served by a relay.
- Tap the **invite link** in the Network panel to copy a shareable URL and send
  it to friends. (Or send them the plain service URL — same thing.)
- Prefer the GitHub Pages copy of the app? Paste your Render URL into the
  **Network** panel there and save — it must be `https://`.

## Good to know

- **Free tier sleeps.** After ~15 idle minutes Render suspends the service; the
  next visitor waits ~30–60 seconds while it wakes. Fine for a small community
  network.
- **The relay holds no power.** It passes messages but can't mint coins, forge
  blocks or read keys — every phone re-validates everything (see
  [`SECURITY.md`](SECURITY.md) for what it *could* do: censor or delay).
- **The chain lives in browsers, not the relay.** The relay keeps only a short
  message buffer; if it restarts, connected nodes simply re-announce their
  chains and everyone reconverges on the heaviest one.

## Keeping it healthy as your circle grows

The relay is hardened for more than a handful of users out of the box — its
message buffer is bounded by both count and bytes (so memory can't run away),
and `POST /msg` is rate-limited per client so one flooder can't drown the box.
Watch it any time at **`https://your-relay.onrender.com/status`** (held
messages, bytes, connected clients, posts, rate-limited rejections, uptime).

Optional tuning via environment variables (Render → your service → Environment):

- **`SELF_URL`** — set this to your own service URL (e.g.
  `https://your-relay.onrender.com`). The relay then pings itself every ~10
  minutes so the free tier doesn't fall asleep between visitors. (This uses your
  free monthly hours; one service stays comfortably under the limit.)
- **`RELAY_MAX_HELD`** / **`RELAY_MAX_BYTES`** — how many recent messages / how
  many bytes to keep buffered (defaults 3000 / 64 MB).
- **`RELAY_RATE_CAP`** / **`RELAY_RATE_REFILL`** — per-client burst size and
  refill rate for `POST /msg` (defaults 150 burst, 30/sec). The defaults let a
  node announce its whole chain and offer list in one go, while still throttling
  a genuine flood.
- **`RELAY_TRUST_PROXIES`** — how many proxies sit in front of the relay, used to
  find the real client IP in `x-forwarded-for` for rate-limiting (default **1**,
  correct for Render's single edge proxy). Only the right-most that many hops are
  trusted, so a client can't spoof the header to dodge the limit. Set **0** if you
  run the relay with no proxy in front, so it keys on the socket address directly.

When a single free instance isn't enough, the honest next steps are a **paid
instance** (no sleeping, more memory) and/or **several relays** — the app
already supports a relay pool with failover, so you can point a circle at more
than one. Beyond that, scale comes from *many circles*, not one giant relay.

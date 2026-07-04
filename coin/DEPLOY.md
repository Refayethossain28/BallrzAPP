# Put your BallrzCoin network on the internet (free, ~5 minutes)

One deploy gives you a URL that **is** a shared BallrzCoin network: anyone who
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
  next visitor waits ~30–60 seconds while it wakes. Fine for a toy network.
- **The relay holds no power.** It passes messages but can't mint coins, forge
  blocks or read keys — every phone re-validates everything (see
  [`SECURITY.md`](SECURITY.md) for what it *could* do: censor or delay).
- **The chain lives in browsers, not the relay.** The relay keeps only a short
  message buffer; if it restarts, connected nodes simply re-announce their
  chains and everyone reconverges on the heaviest one.

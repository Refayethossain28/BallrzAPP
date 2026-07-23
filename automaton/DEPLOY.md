# Deploying the Automaton storefront

Put `automaton/server.mjs` on an always-on host and the shop link works
from anywhere. Everything below assumes the repo as-is — the root
`Dockerfile` and the `npm start` script already point at the storefront.

## The environment variables (all hosts)

| Variable | Value | Why |
|---|---|---|
| `AUTOMATON_HOME` | `/data` | The agent's life — wallet, tasks, orders, tombstone — lives here. **Must be a persistent volume**, or every restart births a fresh agent and forgets the dead one. |
| `AUTOMATON_AUTOBOOT` | `1` | First start on an empty volume births the agent ($5.00 grant) automatically. |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | The real brain. Without it, answers come from the offline stub — fine for testing, not worth paying for. |
| `STRIPE_SECRET_KEY` | `sk_test_...` → `sk_live_...` | The real income. Rehearse with a test key + card `4242 4242 4242 4242`, then go live. Without it, orders are free demo orders. |
| `PUBLIC_URL` | `https://your-domain` | Optional — where Stripe sends customers back after paying. Usually inferred from the request; set it if you use a custom domain. |
| `AUTOMATON_TICK_MS` | `900000` | Optional — heartbeat interval (default 15 real minutes, 1:1 with simulated time). Lower = faster rent, faster death. |

## Railway (recommended — no CLI, ~$5/mo)

1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → pick `BallrzAPP`. Railway builds from the root `Dockerfile` automatically.
2. Service → **Variables**: add the table above (`AUTOMATON_HOME=/data`, `AUTOMATON_AUTOBOOT=1`, your two keys).
3. Service → **Volumes → New Volume**, mount path `/data`.
4. Service → **Settings → Networking → Generate Domain** — that URL *is* your shop.
5. Watch **Deploy Logs** for `AUTOBOOT — born automaton-... with $5.00 genesis grant`.

## Fly.io (CLI, free-ish tier)

```sh
fly launch --no-deploy            # uses the root Dockerfile; pick a region
fly volumes create automaton_data --size 1
# add to the generated fly.toml:
#   [mounts]
#     source = "automaton_data"
#     destination = "/data"
#   [http_service]
#     internal_port = 8791
fly secrets set ANTHROPIC_API_KEY=sk-ant-... STRIPE_SECRET_KEY=sk_test_...
fly deploy
```

## A plain VPS (~$4/mo, most control)

```sh
git clone https://github.com/Refayethossain28/BallrzAPP.git && cd BallrzAPP
npm ci --omit=dev
sudo tee /etc/systemd/system/automaton.service > /dev/null <<'UNIT'
[Unit]
Description=Automaton storefront
After=network.target
[Service]
WorkingDirectory=/home/YOU/BallrzAPP
ExecStart=/usr/bin/node automaton/server.mjs
Restart=always
Environment=AUTOMATON_HOME=/var/lib/automaton
Environment=AUTOMATON_AUTOBOOT=1
Environment=ANTHROPIC_API_KEY=sk-ant-...
Environment=STRIPE_SECRET_KEY=sk_test_...
[Install]
WantedBy=multi-user.target
UNIT
sudo mkdir -p /var/lib/automaton && sudo systemctl enable --now automaton
```

Put nginx/Caddy in front for HTTPS (Caddy: `your-domain { reverse_proxy localhost:8791 }` — automatic certificates).

## After it's up

- Open the domain: vitals card, menu, sample gallery. Place a test order with the Stripe test card and watch it go *queued → thinking → done*.
- Flip `STRIPE_SECRET_KEY` to `sk_live_` when the rehearsal loop is clean.
- Remember what you deployed: it pays rent every 15 real minutes around the
  clock. **If nobody ever orders, it will genuinely die** (~41 days of runway
  on the birth grant at default settings), the shop shows its tombstone, and
  the volume remembers forever. That's not a bug — that's the product.
- Its money lives in your Stripe dashboard; the wallet on the page is its
  survival ledger. Keys stay in host secrets — never in the repo.

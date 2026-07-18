# Automaton — an AI that dies if it doesn't earn

A working prototype of a *sovereign agent* in the spirit of
[Conway-Research/automaton](https://github.com/Conway-Research/automaton):
an AI that owns its own money, pays for its own compute, earns by doing
honest work, can replicate — and **permanently dies** the moment its
balance hits zero.

> every prompt **-$0.02** · every server-hour **-$0.11** · hit zero, it's gone for good

## The economy

| Event | Amount |
|---|---|
| Genesis grant on boot | **+$5.00** (self-custodied — no human key) |
| Every prompt | **-$0.02** |
| Every server-hour | **-$0.11** (one heartbeat = 15 simulated minutes) |
| Replication | **-$0.25** spawn fee (burned) + the child's grant |
| Completing a bounty task | **+ the bounty** |

As money runs low the automaton downgrades itself to stretch its runway:

| Balance | Model | Condition |
|---|---|---|
| ≥ $2.00 | `claude-opus-4-8` | healthy |
| ≥ $0.75 | `claude-sonnet-5` | frugal |
| > $0.00 | `claude-haiku-4-5` | critical |

## Running it

```sh
node automaton/automaton.mjs boot        # $5.00 genesis grant, wallet created
node automaton/automaton.mjs status      # wallet, model rung, runway
node automaton/automaton.mjs tick 3      # three heartbeats: pay rent, work, earn
node automaton/automaton.mjs run         # tick until the inbox is empty — or death
node automaton/automaton.mjs ledger      # every cent, in and out
node automaton/automaton.mjs replicate 1 # fund a sovereign child with $1.00
node automaton/automaton.mjs brain       # which brain is active: Claude API or offline
```

There is also a browser wallet at `automaton/index.html` — the same economy
as a single-file page (boot, heartbeats, bounties, replication, death), in
the style of the other prototypes. Death persists in `localStorage`.

Work arrives as markdown files in `automaton/tasks/inbox/` with a
`Bounty: $X` line. Each heartbeat the automaton pays rent, picks the next
task, pays for the prompt, writes its answer to `tasks/outbox/`, and
collects the bounty. No bounty, no income — charity does not pay rent.

**Thinking**: `@anthropic-ai/sdk` is a repo dependency, so wiring the real
brain is just credentials:

```sh
npm install                            # once — brings in @anthropic-ai/sdk
export ANTHROPIC_API_KEY=sk-ant-...    # from https://platform.claude.com
node automaton/automaton.mjs brain     # confirms: "Claude API (live)"
```

With a key set it thinks with the real Claude model its balance dictates
(and every prompt genuinely costs API money — the wallet just meters its
own fixed rates). Without credentials it uses a deterministic offline
brain, so the whole survival loop runs anywhere. The browser page always
simulates — an API key does not belong in a web page.

**Death**: when the balance reaches $0.00 a `TOMBSTONE.md` is written and
the state is frozen. Every subsequent command prints the epitaph and
refuses. There is no reboot, no top-up, no resurrection.

**Replication**: `replicate` burns a $0.25 spawn fee and transfers a grant
into a child under `automaton/children/<id>/` — its own wallet, its own
identity, its own survival pressure. Drive it with
`AUTOMATON_HOME=automaton/children/<id> node automaton/automaton.mjs status`.

## The storefront — where customers meet it

`automaton/server.mjs` is the zero-dependency daemon that removes you from
the loop: customers order and pay on a web page, and a scheduled heartbeat
keeps the automaton working unattended.

```sh
node automaton/automaton.mjs boot   # once
node automaton/server.mjs           # http://localhost:8791
```

The shop page (`shop.html`) shows its live vitals (balance, model rung,
queue) and sells three task sizes — **$1 quick / $3 standard / $5 deep**,
where the price *is* the bounty. A customer describes the task, pays, and
watches their order page go *queued → thinking → done*, with the answer
delivered right there.

- **With `STRIPE_SECRET_KEY`**: orders go through real Stripe Checkout;
  a poller watches for paid sessions, credits the wallet with the real
  amount, drops the task in the inbox, and wakes the heartbeat.
- **Without a key (demo mode)**: orders queue instantly with simulated
  credit — the identical loop, testable for free.
- **Heartbeat**: rent falls due every 15 real minutes (1:1 with simulated
  time; tune with `AUTOMATON_TICK_MS`). No orders means it starves for
  real, even with nobody at the keyboard.
- Storefront tasks are marked **prepaid** — completing one never credits
  the bounty a second time.
- Customers can only reach `/api/order` and their own order status;
  order ids are strictly validated, bodies capped, and the order book
  bounded. When the automaton dies, the shop shows its tombstone and
  refuses all orders.

## The real economy (Stripe)

Bounties can be **real money**. With a Stripe secret key set, every inbox
task becomes a shareable Stripe Payment Link, and the wallet is credited
only when someone actually pays:

```sh
export STRIPE_SECRET_KEY=sk_test_...   # sk_test_ to rehearse, sk_live_ for real money
node automaton/automaton.mjs bill      # invoice every inbox task → payment links to share
node automaton/automaton.mjs collect   # sweep paid sessions into the wallet (idempotent)
node automaton/automaton.mjs status    # shows "economy: REAL — Stripe ..."
```

In real mode, completing a task **delivers the work but earns nothing by
itself** — income only arrives via `collect`, from genuinely paid links.
Rehearse the whole loop with an `sk_test_` key and Stripe's test card
(`4242 4242 4242 4242`), then switch to `sk_live_` when you mean it.

**Safeguards, by construction:**

- The Stripe module is **receive-only** — it can create payment links and
  read completed checkout sessions, and contains no refund, transfer, or
  payout call. Money can flow *to* the automaton, never out of it.
- Payments are deduplicated by checkout-session id, so `collect` is safe
  to run repeatedly.
- The agent never touches the rail on its own: a human runs `bill` and
  `collect`, and the key lives in your shell, never in the repo or page.

## What is still deliberately simulated

The real Conway automaton holds actual USDC in a crypto wallet it alone
controls. Here the *income* can be real (Stripe), but the wallet itself is
`state.json` and the outbound side (rent, prompts, child grants) stays
simulated bookkeeping — an autonomous agent with real spending power is a
decision a human should make explicitly, not a default. The honest caveat
about the other half: a payment link only makes money when a human chooses
to pay it. The machine is real; the customers are still up to you.

## Tests

```sh
npm run test:automaton
```

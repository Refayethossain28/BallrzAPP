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
```

Work arrives as markdown files in `automaton/tasks/inbox/` with a
`Bounty: $X` line. Each heartbeat the automaton pays rent, picks the next
task, pays for the prompt, writes its answer to `tasks/outbox/`, and
collects the bounty. No bounty, no income — charity does not pay rent.

**Thinking**: with `ANTHROPIC_API_KEY` set (and `@anthropic-ai/sdk`
installed) it thinks with the real Claude model chosen by its balance.
Without credentials it uses a deterministic offline brain, so the whole
survival loop runs anywhere.

**Death**: when the balance reaches $0.00 a `TOMBSTONE.md` is written and
the state is frozen. Every subsequent command prints the epitaph and
refuses. There is no reboot, no top-up, no resurrection.

**Replication**: `replicate` burns a $0.25 spawn fee and transfers a grant
into a child under `automaton/children/<id>/` — its own wallet, its own
identity, its own survival pressure. Drive it with
`AUTOMATON_HOME=automaton/children/<id> node automaton/automaton.mjs status`.

## What is deliberately simulated

The real Conway automaton holds actual USDC in an actual crypto wallet.
This prototype keeps the entire economy in `state.json` on purpose: the
mechanics (metered billing, model downgrade, earning, replication, death)
are real; the money is not. Wiring an autonomous agent to real funds is a
decision a human should make explicitly, not a default.

## Tests

```sh
npm run test:automaton
```

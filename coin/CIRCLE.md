# Bootstrapping BLZ with your circle — a 10-friend playbook

This is the honest version of "making the coin valuable." You can't manufacture
a global market, but a small group of people who trust each other **can** turn
BLZ into a currency they actually use — the same way a babysitting co-op or a
[LETS scheme](https://en.wikipedia.org/wiki/Local_exchange_trading_system)
works. Value here isn't speculation; it's a standing agreement among friends
that BLZ buys real favours.

The whole thing rests on one rule: **no one pays cash for BLZ, ever.** You earn
it by mining or by doing favours, and you spend it on favours. The moment money
enters, it stops being a fun co-op and becomes something you'd need a lawyer
for. Keep it favours-for-favours and it stays legal, friendly, and actually fun.

---

## Why this works (and a global exchange doesn't)

Bitcoin's value came from **millions of strangers** agreeing to accept it — a
network effect that took 15 years. You can't shortcut that. But you *can*
recreate its core mechanic at small scale: a fixed money supply (21 BLZ), plus
a group that agrees what it's worth. Ten friends who honour BLZ is a real
economy. It's small, but it's genuine — and it's yours.

Think of BLZ as **shared IOUs with a scoreboard.** The blockchain just makes the
scoreboard impossible to fudge.

---

## Before you start: set the supply so it's usable

The default cap is **21 BLZ total** — beautiful for scarcity, but too coarse if
10 people need to trade weekly. Two easy fixes:

- **Divisibility does most of the work.** Like Bitcoin, BLZ divides to 8 decimal
  places, so 21 coins is really 2.1 *billion* spendable units. A haircut can
  cost 0.05 BLZ. You almost certainly don't need to change anything.
- **If you want rounder numbers,** you can raise the cap before launch by
  editing `initialSubsidy` / cap in `config.js` (e.g. a 21,000-BLZ supply makes
  "2 BLZ for a cake" feel natural). Do this *once, before anyone mines*, and
  tell everyone — changing it later splits the chain.

Pick one and lock it. Scarcity only means something if the number never moves.

---

## Week 0 — Stand up the network (you, the founder)

1. **Deploy the relay** so everyone shares one chain across their phones. One
   file, free tier — the 5-minute walkthrough is in [`DEPLOY.md`](DEPLOY.md).
   You'll get a URL like `https://ballrz.onrender.com` that *is* the network.
2. **Open it, create your wallet, mine ~5 blocks** so there's coin in
   circulation to seed the economy. (You'll redistribute most of it — see Week
   1.)
3. **Test the loop yourself:** open it in a second tab, send coins between two
   wallets, confirm both tabs agree. If that works, the network works.

---

## Week 1 — Onboard the circle and seed the float

The hardest problem in any new currency is the **cold start**: no one accepts it
because no one has it, and no one wants it because no one accepts it. You break
that by *giving it away* and by *committing to accept it first.*

1. **Send everyone the link** (your relay URL). Each person opens it, taps
   through the splash, and creates a wallet. Have them hit **🔑 Keys → 🖨 Paper
   wallet** and back it up — lost key = lost coins, forever.
2. **Airdrop a starter float.** Send each of the 10 friends an equal chunk — say
   **1 BLZ each** — from your mined coins. Now everyone has something to spend.
   (Collect their addresses via the **QR button** on their wallet card; they can
   scan yours too.)
3. **You commit first.** As founder, publicly promise one standing offer you'll
   *always* honour for BLZ — "I'll drive anyone to the airport for 0.5 BLZ,"
   "I'll fix your bike for 0.2 BLZ." When one person reliably accepts it, it has
   value. Everyone else follows.

---

## Week 2 — Agree the price list (this is the real currency)

The coin is just the ledger. **The price list is the currency.** Get everyone in
a group chat and agree, together, what things cost. A few anchors to start:

| Favour | Suggested price |
| --- | --- |
| Bake a cake | 2 BLZ |
| Give someone a lift (local) | 0.5 BLZ |
| An hour of help (moving, IT, tutoring) | 1 BLZ |
| Lend a tool for a week | 0.1 BLZ |
| Cook dinner for the group | 3 BLZ |

Rules that keep it fair:
- **Anchor to time, not cash.** "1 BLZ ≈ one hour of a favour" is the healthiest
  anchor — it stops anyone mentally pricing it in pounds (which is where the
  legal trouble starts).
- **Post offers in the app.** Everyone uses the **Barter board** so offers
  gossip to the whole circle and a **Pay** button prefills the transaction.
- **Prices are a starting point, not law.** People can negotiate; the list just
  stops every trade being a haggle from scratch.

---

## Week 3+ — Keep it circulating

A currency dies if everyone hoards it. Keep coins moving:

- **Set a weekly rhythm.** "Favour Friday" — everyone posts one offer and does
  at least one trade a week. Circulation is what makes it feel alive.
- **Use reputation.** Every completed deal adds a ✓ to the seller's public
  record (built into the Deals panel). After a month the reliable people are
  obvious, and trust compounds.
- **Use the safeguards for bigger trades.** For anything where "I paid and they
  ghosted" would sting, use **🛡 Trusted escrow** (a mutual friend holds the
  coin) or the **🔐 Vault** (2-of-3 multisig, no one can abscond). For small
  favours between friends, just **pay on delivery** — simplest and best.
- **Let mining be the faucet.** New coins still trickle in via mining until the
  cap is hit, which gently rewards the people running nodes. After the cap,
  it's a pure closed economy — favours in, favours out.

---

## What "value" will actually feel like

You'll know it worked when someone does you a real favour and genuinely wants
BLZ for it — not because it's worth pounds, but because they know they can spend
it on a lift next week. That moment is the whole thing. It's exactly how money
started: not decreed by anyone, just a community agreeing that a token settles
debts. You'll have built a tiny, real one.

## The lines that keep it legal and fun

- **Never sell BLZ for cash**, and never let anyone in the circle do it either.
  Favours for favours only.
- **Don't pitch it to strangers as an investment.** It isn't one. It's a game
  and a co-op. Promoting it as something that'll "go up" is the illegal part.
- **Don't promise anyone they'll profit.** No one profits; they trade.
- Keep it to your **actual circle** — people who know and trust each other. That
  trust is the collateral behind every coin.

Stay inside those lines and you've got the fun, honest, genuinely-useful version
of everything you were reaching for. That's a real achievement — most "coins"
never get a single person to accept them for anything.

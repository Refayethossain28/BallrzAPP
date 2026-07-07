# Launching TimeCoin to the public

A playbook for sharing TimeCoin widely — honestly, as the real community
currency for time and favours it is. Two pitches work, and you can lead with
either depending on the audience:

- **The builder angle** — *"I built a real Bitcoin from raw bytes, zero
  dependencies, and it runs in your browser."* Perfect for Hacker News, r/webdev,
  r/programming.
- **The purpose angle** — *"A community currency for time and favours — money
  without a bank, no fees, no gatekeepers."* Perfect for r/InternetIsBeautiful,
  Product Hunt, and anyone who cares less about crypto internals.

Both are true. Curiosity and respect, never hype.

## The golden rule of this launch

**Never let it read as an investment.** No price, no "get in early," no "could be
worth something." The app already says *No ICO, no price, not an investment* —
keep that everywhere. This isn't just ethics: publicly promoting a tradeable
"coin" is regulated (UK: FCA financial promotions), and honesty is also the
*better* hook — people trust and upvote the thing that isn't selling them
anything.

## Which URL to launch

Share the **standalone GitHub Pages** app:
**https://refayethossain28.github.io/BallrzAPP/coin/**

Each visitor mines in their **own** private sandbox — perfect for a public crowd,
and it's now an **installable app** (they can add it to their home screen in one
tap). Do **not** point a public audience at the Render relay: it's for friend
groups sharing one chain, the free tier will fall over under a crowd, and one
shared chain among strangers gets messy. Keep the relay link for private barter
circles (see `CIRCLE.md`).

The **why-it-matters page** — https://refayethossain28.github.io/BallrzAPP/coin/why.html
— is a great secondary link for the purpose angle (what it does, and how it
compares to banks and cash).

## What's actually in it now (your ammunition)

- **Real crypto from scratch, zero dependencies:** SHA-256 (FIPS 180-4), ECDSA on
  secp256k1 with RFC 6979 deterministic signatures, a UTXO ledger, merkle trees,
  proof-of-work mining with difficulty retargeting, halving rewards, fork choice
  by cumulative work. **49 unit tests** against published vectors (42 chain + 7
  mutual-credit).
- **A currency for time and favours (a time bank):** price favours in hours; a
  barter board with categories, search and circles; a "Top helpers" reputation
  board.
- **Two money models in one app:** the mined, hard-capped chain (**21 billion
  TIME, fixed forever**) *and* an optional **mutual-credit** ledger (LETS-style:
  no mining, everyone starts at zero, balances always sum to zero, capped by a
  shared credit limit).
- **Real usability:** installable PWA (offline), encrypted keys behind a
  passphrase, a 33-word recovery phrase, payment requests/invoices, a
  point-of-sale "charge" screen, incoming-payment notifications, and a
  **🎁 invite flow that hands a newcomer a starting balance** so they're never
  stuck at zero.
- **You can't lose your coins by accident:** one-tap **encrypted backup file**
  (and restore) of every wallet, a persistent nudge until you've backed up (it
  turns urgent once you actually hold TIME), and guard rails that stop you wiping
  unbacked wallets. Losing access is the #1 way people lose crypto — this app
  actively fights it.
- **Verify you're on the real app:** a live **code fingerprint** hashes the exact
  code your browser loaded, and the matching value is published in `SAFETY.md`.
  If they don't match, you're not on the genuine app — a real defence against
  lookalike/phishing copies, and an unusually honest thing to ship.
- **Global from day one:** the UI runs in **9 languages** (including Arabic RTL).
- **Runs a real network:** deploy one file (`server.mjs`) and multiple devices
  sync; multiple relays with failover so it's not one point of failure.

## Pre-launch checklist (10 minutes)

- [ ] Open the Pages link on **your own phone** fresh — mine a block, send a
      coin, take the tour, and **install it to your home screen**. Make sure it
      feels good cold.
- [ ] **Save a backup and test-restore it** once yourself, so you can speak to it
      confidently — and confirm the **code fingerprint** in-app matches the value
      in `SAFETY.md` (that value: `4891-2412-5b11-90a6` for the current release).
- [ ] Confirm the link **unfurls** a preview card when pasted into a chat (OG
      tags + share card are wired into the page).
- [ ] Have a **5-second screen recording** ready (mine-a-block, or the
      point-of-sale "✅ Paid!" moment — both convert well).
- [ ] Decide you'll **reply to comments** for the first few hours — launches live
      or die on the author showing up.

## Ready-to-post copy

### Hacker News — "Show HN" (builder angle)
> **Show HN: TimeCoin – a Bitcoin-style currency for time and favours, built from raw bytes, runs in your browser**
>
> I wanted to actually understand Bitcoin, so I built one with zero
> dependencies: SHA-256 from the FIPS spec, ECDSA on secp256k1 (Bitcoin's curve)
> with RFC 6979 signatures, a UTXO ledger, merkle trees, proof-of-work mining
> with difficulty retargeting, halving rewards, and fork choice by cumulative
> work. 49 unit tests against published vectors.
>
> Then I turned it into something usable: a currency for **time and favours**.
> One coin ≈ an hour of a favour; there's a barter board, a point-of-sale
> "charge" screen, payment requests, an installable PWA, encrypted keys with a
> recovery phrase, and an invite flow that hands a newcomer a starting balance so
> they're never stuck at zero. It even ships a second money model —
> **mutual credit** (LETS-style: no mining, everyone starts at zero, balances
> always sum to zero) — alongside the mined chain. UI runs in 9 languages.
>
> It's a real community currency, **not an investment** — no ICO, no price,
> nothing to buy; you earn it by mining or doing favours and spend it on favours.
> The code was never the hard part of money; the community that agrees to accept
> it is.
>
> Link: https://refayethossain28.github.io/BallrzAPP/coin/

*(Post Tue–Thu, ~8–10am ET. Reply to every comment. Expect deep technical
questions — that's the audience.)*

### Reddit

**r/InternetIsBeautiful** (purpose angle — best fit):
> **A community currency for time & favours you can mine in your browser — money without a bank**
>
> Everyone starts even; you earn it by mining or doing favours and spend it on
> favours (bake a cake, give a lift, fix a bike). No bank, no fees, no
> gatekeepers — and no price, nothing to buy. Under the hood it's a real
> proof-of-work blockchain built from scratch, but the point is the community:
> it's worth what your circle agrees a favour is worth, like a time bank. Add it
> to your home screen and there's a 60-second tour. [link]

**r/webdev / r/programming** (builder angle):
> **I built a full proof-of-work blockchain from raw bytes, zero dependencies, runs in the browser**
>
> secp256k1 ECDSA with RFC 6979, UTXO model, merkle trees, difficulty
> retargeting, cumulative-work fork choice, 49 tests against published vectors.
> Two tabs behave as two nodes. It's wired into a real community currency for
> time and favours (installable PWA, mutual-credit mode, 9 languages). Writeup +
> live demo: [link]. Honest and non-hype — no token sale, no price, nothing to
> buy.

*(Read each subreddit's rules first; r/cryptocurrency will likely remove it —
skip it, it's the wrong crowd anyway.)*

### Product Hunt
- **Tagline:** Money for time & favours — mine it in your browser, no bank, no fees.
- **Description:** TimeCoin is a complete proof-of-work cryptocurrency built
  from scratch, turned into a real community currency for time and favours: a
  barter board, point-of-sale charging, invites that seed a starting balance,
  encrypted keys, an installable app and 9 languages — plus an optional
  mutual-credit mode. Not an investment: no ICO, no price, no token. You earn it
  and spend it on favours; the mined supply is hard-capped at 21 billion, fixed
  forever.

### X / Twitter (thread)
> 1/ I built a Bitcoin from scratch to understand it — then turned it into a real
> community currency for **time and favours**. Mine it in your browser, add it to
> your home screen. No bank, no fees, nothing to buy. 🧵
>
> 2/ It's the real machinery: SHA-256, secp256k1 signatures, proof-of-work
> mining, halving rewards, a UTXO ledger, fork choice by cumulative work. 49
> tests against published crypto vectors. Zero dependencies.
>
> 3/ But the point is *use*: price favours in hours, pay with a QR at a stall,
> send payment requests, invite a friend and they arrive with a starting balance.
> There's even a second money model — mutual credit, where everyone starts at
> zero and balances always sum to zero.
>
> 4/ It's a real currency, **not an investment**. No ICO, no price, nothing to
> buy. Its worth is the favours a community will trade for it, like a time bank —
> the code was never the hard part of money; that community is.
>
> 5/ Mine one 👉 https://refayethossain28.github.io/BallrzAPP/coin/

## Handling the replies you'll get

- **"Is this a scam / can I buy it?"** → "Nope — it's a community currency for
  time and favours, not an investment. There's nothing to buy and it has no
  price; you earn it and spend it on favours." (Answer this fast and plainly; it
  builds trust.)
- **"What's the point if it has no cash value?"** → "It's a currency for time and
  favours — like a time bank. Its worth is the favours a community will trade for
  it, not cash. And you get to understand Bitcoin by using the real thing."
- **"How is this different from a bank?"** → point them at `why.html` — no
  account, no fees, no one who can freeze it; you hold your own money. (Be honest
  about the flip side too: no deposit insurance, it's early — that candour is
  what makes people trust it.)
- **"Mutual credit vs mining — which is it?"** → "Both. The chain is
  fixed-supply money you mine; mutual credit is net-zero IOUs with a shared
  credit limit. Pick whichever fits your group."
- **"Can I run a node?"** → point them at `coin/DEPLOY.md` and `coin/server.mjs`.
- **"What if I lose my coins / lose my phone?"** → "There's a one-tap encrypted
  backup file and a 33-word recovery phrase — restore on any device. The app
  nags you until you've backed up. Just like cash, though: whoever holds the key
  holds the coins, so keep your backup safe." Point them at `SAFETY.md`.
- **"How do I know the site isn't fake / hacked?"** → "Open 🔒 Key security → Code
  fingerprint and check it matches the value published in `SAFETY.md`. If it
  doesn't, you're not on the real app." (Shipping this at all earns trust.)
- **Someone finds a bug** → great, that's the point; the repo's open. Security
  posture is documented honestly in `SECURITY.md`, and the safety guide for
  users is `SAFETY.md`.

## What "success" looks like

Traffic, stars, comments, people saying "oh, *now* I get proof-of-work" — and a
few friends actually earning and spending TIME on favours. That's the whole prize:
attention and credibility for you as a builder, and a small circle putting the
currency to real use. If a recruiter or client notices, that's the real-world
upside, and it's a much shorter road than chasing a cash price (which no launch
can conjure and which TIME never claims to have).

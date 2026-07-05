# Launching BallrzCoin to the public

A playbook for sharing BallrzCoin widely — honestly, as the fun educational toy
it is. The pitch that works is the true one: *"I built a real Bitcoin from raw
bytes; mine one in your browser; only 21 will ever exist."* Curiosity and
respect, not hype.

## The golden rule of this launch

**Never let it read as an investment.** No price, no "get in early," no
"could be worth something." The app already says *No ICO, no price, no
promises* — keep that everywhere. This isn't just ethics: framing a tradeable
"coin" to the public is regulated (UK: FCA financial promotions), and honesty is
also the *better* hook — people trust and upvote the thing that isn't selling
them anything.

## Which URL to launch

Share the **standalone GitHub Pages** app:
**https://refayethossain28.github.io/BallrzAPP/coin/**

Each visitor mines in their **own** private sandbox — perfect for a public crowd.
Do **not** point a public audience at the Render relay (`ballrzcoin.onrender.com`):
it's for friend groups sharing one chain, the free tier will fall over under a
crowd, and one shared chain among strangers gets messy. Keep the relay link for
private barter circles.

## Pre-launch checklist (10 minutes)

- [ ] Open the Pages link on **your own phone** fresh — mine a block, send a
      coin, take the tour. Make sure it feels good cold.
- [ ] Confirm the link **unfurls** a preview card when pasted into a chat (the
      share card is wired into the page's OG tags).
- [ ] Have the **screenshot/GIF** ready (a 5-second mine-a-block clip converts
      best on social).
- [ ] Decide you'll **reply to comments** for the first few hours — launches
      live or die on the author showing up.

## Ready-to-post copy

### Hacker News — "Show HN"
> **Show HN: BallrzCoin – a working Bitcoin-style cryptocurrency you mine in your browser**
>
> I wanted to actually understand Bitcoin, so I built one from raw bytes with
> zero dependencies: SHA-256 from the FIPS spec, ECDSA on secp256k1 (Bitcoin's
> curve) with RFC 6979 signatures, a UTXO ledger, merkle trees, proof-of-work
> mining with difficulty retargeting, halving block rewards, and fork choice by
> cumulative work. 32 unit tests against published vectors.
>
> It runs entirely in the browser — mine real blocks, send signed transactions,
> watch two tabs converge on the heaviest chain like two nodes. I made it the
> scarcest asset I could: only 21 BLZ will ever exist (vs Bitcoin's 21M). There's
> an interactive "how it works" tour, paper-wallet cold storage, and a barter
> board so a group can trade favours with it.
>
> It's a teaching toy on purpose — no ICO, no price, no token sale, nothing to
> buy. The code was never the hard part of Bitcoin; the people, power and time
> are. Building it taught me that in my bones.
>
> Link: https://refayethossain28.github.io/BallrzAPP/coin/

*(Post Tue–Thu, ~8–10am ET. Reply to every comment. Expect deep technical
questions — that's the audience.)*

### Reddit
**r/InternetIsBeautiful** (best fit — they love self-contained web toys):
> **A working Bitcoin-style cryptocurrency you can mine in your browser — only 21 coins will ever exist**
>
> Built from scratch (real SHA-256, secp256k1 signatures, proof-of-work,
> halving rewards). Mine a block, send a coin, open a second tab and watch them
> sync like two nodes. It's a teaching toy — no price, nothing to buy — but
> every mechanism is the real thing. There's a 60-second "how it works" tour.
> [link]

**r/webdev / r/programming** (lead with the build):
> **I built a full proof-of-work blockchain from raw bytes, zero dependencies, runs in the browser**
>
> secp256k1 ECDSA with RFC 6979, UTXO model, merkle trees, difficulty
> retargeting, cumulative-work fork choice, 32 tests against published vectors.
> Two tabs behave as two nodes. Writeup + live demo: [link]. Honest toy — no
> token, no sale.

*(Read each subreddit's rules first; r/cryptocurrency will likely remove it —
skip it, it's the wrong crowd anyway.)*

### Product Hunt
- **Tagline:** Mine a real Bitcoin-style coin in your browser — only 21 exist.
- **Description:** BallrzCoin is a complete proof-of-work cryptocurrency built
  from scratch and running in your browser: real mining, secp256k1 signatures,
  halving rewards, a barter board, paper wallets and an interactive tour. A
  teaching toy, not an investment — no ICO, no price, no token. Just the purest
  way to *understand* how Bitcoin works: by using one.

### X / Twitter (thread)
> 1/ I built a Bitcoin from scratch to understand it — and you can mine it in
> your browser right now. Only 21 coins will ever exist. 🧵
>
> 2/ It's the real machinery: SHA-256, secp256k1 signatures, proof-of-work
> mining, halving rewards, a UTXO ledger, fork choice by cumulative work. 32
> tests against published crypto vectors. Zero dependencies.
>
> 3/ Open two tabs → they behave like two nodes converging on the heaviest
> chain. There's a 60-sec tour that teaches mining, wallets and consensus as you
> click.
>
> 4/ It's a toy on purpose. No ICO, no price, nothing to buy. The code was never
> the hard part of Bitcoin — the people, the power and the 15 years of trust
> are. Building it made that obvious.
>
> 5/ Mine one 👉 https://refayethossain28.github.io/BallrzAPP/coin/

## Handling the replies you'll get

- **"Is this a scam / can I buy it?"** → "Nope — it's a teaching toy, there's
  nothing to buy and it has no price. Just mine and play." (Answer this fast and
  plainly; it builds trust.)
- **"What's the point if it's worthless?"** → "To understand Bitcoin by
  building it. Best crypto education there is."
- **"Can I run a node?"** → point them at `coin/DEPLOY.md` (the relay) and
  `coin/server.mjs`.
- **Someone finds a bug** → great, that's the point; the repo's open.

## What "success" looks like

Traffic, stars, comments, people saying "oh, *now* I get proof-of-work." That's
the whole prize — attention and credibility for you as a builder. If a recruiter
or client notices, that's the real-world upside, and it's a much shorter road
than trying to make a toy coin valuable (which no launch can do).

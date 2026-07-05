# Launching BallrzCoin to the public

A playbook for sharing BallrzCoin widely — honestly, as the real community
currency for time and favours it is. The pitch that works is the true one: *"I
built a real Bitcoin from raw bytes and turned it into a currency for time and
favours; mine one in your browser; the supply is hard-capped at 21 billion,
fixed forever."* Curiosity and respect, not hype.

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
> watch two tabs converge on the heaviest chain like two nodes. The supply is
> hard-capped at 21 billion BLZ, fixed forever and enforced by consensus — a
> permanent, un-inflatable ceiling sized for a worldwide community. There's an
> interactive "how it works" tour, paper-wallet cold storage, and a barter board
> so a group can actually trade favours and time with it.
>
> It's a real community currency for time and favours, not an investment — no
> ICO, no price, no token sale, nothing to buy; you earn it by mining or doing
> favours and spend it on favours. The code was never the hard part of money;
> the community that agrees to accept it is. Building it taught me that in my
> bones.
>
> Link: https://refayethossain28.github.io/BallrzAPP/coin/

*(Post Tue–Thu, ~8–10am ET. Reply to every comment. Expect deep technical
questions — that's the audience.)*

### Reddit
**r/InternetIsBeautiful** (best fit — they love self-contained web apps):
> **A working Bitcoin-style community currency you can mine in your browser — supply hard-capped at 21 billion, fixed forever**
>
> Built from scratch (real SHA-256, secp256k1 signatures, proof-of-work,
> halving rewards). Mine a block, send a coin, open a second tab and watch them
> sync like two nodes. It's a real currency for time and favours — no price,
> nothing to buy — that a community earns and spends on favours; every mechanism
> is the real thing. There's a 60-second "how it works" tour. [link]

**r/webdev / r/programming** (lead with the build):
> **I built a full proof-of-work blockchain from raw bytes, zero dependencies, runs in the browser**
>
> secp256k1 ECDSA with RFC 6979, UTXO model, merkle trees, difficulty
> retargeting, cumulative-work fork choice, 32 tests against published vectors.
> Two tabs behave as two nodes. It's a real community currency for time and
> favours. Writeup + live demo: [link]. Honest and non-hype — no token sale, no
> price, nothing to buy.

*(Read each subreddit's rules first; r/cryptocurrency will likely remove it —
skip it, it's the wrong crowd anyway.)*

### Product Hunt
- **Tagline:** Mine a real Bitcoin-style community currency in your browser — 21 billion hard cap, fixed forever.
- **Description:** BallrzCoin is a complete proof-of-work cryptocurrency built
  from scratch and running in your browser: real mining, secp256k1 signatures,
  halving rewards, a barter board, paper wallets and an interactive tour. A real
  community currency for time and favours, not an investment — no ICO, no price,
  no token. You earn it and spend it on favours, and the supply is hard-capped
  at 21 billion, fixed forever.

### X / Twitter (thread)
> 1/ I built a Bitcoin from scratch to understand it — then turned it into a
> real community currency for time and favours. You can mine it in your browser
> right now. Supply hard-capped at 21 billion, fixed forever. 🧵
>
> 2/ It's the real machinery: SHA-256, secp256k1 signatures, proof-of-work
> mining, halving rewards, a UTXO ledger, fork choice by cumulative work. 32
> tests against published crypto vectors. Zero dependencies.
>
> 3/ Open two tabs → they behave like two nodes converging on the heaviest
> chain. There's a 60-sec tour that teaches mining, wallets and consensus as you
> click. Earn BLZ by mining or doing favours; spend it on favours with your
> people.
>
> 4/ It's a real currency, not an investment. No ICO, no price, nothing to buy.
> The value is favours and goods, not cash — it comes from a community agreeing
> to accept it, like a time bank. The code was never the hard part of money;
> that community is. Building it made that obvious.
>
> 5/ Mine one 👉 https://refayethossain28.github.io/BallrzAPP/coin/

## Handling the replies you'll get

- **"Is this a scam / can I buy it?"** → "Nope — it's a community currency for
  time and favours, not an investment. There's nothing to buy and it has no
  price; you earn it and spend it on favours." (Answer this fast and plainly; it
  builds trust.)
- **"What's the point if it has no cash value?"** → "It's a currency for time
  and favours — like a time bank. Its worth is the favours a community will
  trade for it, not cash. And you get to understand Bitcoin by using the real
  thing."
- **"Can I run a node?"** → point them at `coin/DEPLOY.md` (the relay) and
  `coin/server.mjs`.
- **Someone finds a bug** → great, that's the point; the repo's open.

## What "success" looks like

Traffic, stars, comments, people saying "oh, *now* I get proof-of-work" — and a
few friends actually earning and spending BLZ on favours. That's the whole prize
— attention and credibility for you as a builder, and a small circle putting the
currency to real use. If a recruiter or client notices, that's the real-world
upside, and it's a much shorter road than chasing a cash price (which no launch
can conjure and which BLZ never claims to have).

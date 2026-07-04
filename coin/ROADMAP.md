# The road from toy to real cryptocurrency — honestly

BallrzCoin now has the three things software alone can give a cryptocurrency:
correct consensus code ([`engine.js`](engine.js), 31 tests), real cross-device
networking ([`server.mjs`](server.mjs) + [`config.js`](config.js)), and a
written security audit ([`SECURITY.md`](SECURITY.md)). This document is about
everything else — the parts that are *not* software, so nobody reading this
repo is misled about what makes a currency valuable.

## The blunt truth about value

**Scarcity does not create value; demand for something scarce does.** Only 21
BLZ will ever exist, but value is a price agreed between a buyer and a seller,
and there is no buyer. Bitcoin's price is the product of things no codebase
contains:

1. **Security budget** — thousands of independent miners burning real
   electricity make rewriting Bitcoin's history cost billions. BallrzCoin's
   history can be rewritten by one laptop (SECURITY.md #3). Nobody stores value
   in a ledger a stranger can edit.
2. **Distribution and liquidity** — millions of holders, deep markets, years
   of price discovery. A coin held by one person has no market price at all.
3. **Trust accumulated over time** — 15+ years of surviving attacks, forks,
   bans and bubbles. Trust cannot be shipped in a release; it only accretes.
4. **Ecosystem** — wallets, exchanges, custodians, auditors, documentation,
   developers. Each exists because the others do; bootstrapping the circle is
   the hard part.

## What the real road looks like (and who walks each mile)

| Stage | What it takes | Who can do it |
| --- | --- | --- |
| Hardened node software | Constant-time crypto, binary wire format, DoS-resistant p2p gossip, incremental validation, encrypted key custody | Engineers (buildable — months of specialist work) |
| Independent security audits | Multiple paid firms attacking the code and the economics, publicly reporting | Third-party auditors (bought, not built) |
| A genuine network | Hundreds of independent operators choosing to run nodes and mine — decentralisation is people, not a feature flag | The public (earned, not deployed) |
| Fair launch | Published emission schedule, no premine games, credible commitment not to rug — the *social* contract that makes early holders trust it | Founders' conduct over years |
| Legal standing | Whether a token is a security, money-transmission licensing, KYC/AML on any exchange touching it, tax treatment — varies by country; in the UK, marketing crypto to the public is FCA-regulated | Lawyers and regulators (this is where "make it happen" legally requires professionals — selling tokens to the public without this work can be a crime) |
| A market | Exchanges willing to list, market-makers, custody, an actual reason people want the asset | The market decides; nobody can decree it |

## What this repo will honestly claim

BallrzCoin is a **complete, correct, working model** of how Bitcoin works — the
best kind of teaching tool, because every rule is real and every attack in the
test suite really is rejected. It is not, and will not pretend to be, an
investment. If you take one idea from it, take this one: *the code was never
the hard part of Bitcoin — the consensus of millions of strangers was.*

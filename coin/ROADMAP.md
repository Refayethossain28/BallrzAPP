# The road for a real community currency — honestly

BallrzCoin now has the three things software alone can give a cryptocurrency:
correct consensus code ([`engine.js`](engine.js) + [`mutual.js`](mutual.js), 47 tests), real cross-device
networking ([`server.mjs`](server.mjs) + [`config.js`](config.js)), and a
written security audit ([`SECURITY.md`](SECURITY.md)). This document is about
everything else — the parts that are *not* software, so nobody reading this
repo is misled about where a community currency's worth actually comes from.

## The blunt truth about value

**Scarcity does not create value; a community agreeing to accept something
does.** The supply is hard-capped at 21,000,000,000 BLZ (21 billion), fixed
forever and enforced by consensus — a ceiling sized for a worldwide community,
not a number you can inflate away. But that cap is not what makes BLZ worth
anything: value comes from people agreeing to accept it for time and favours,
the way a time bank or LETS scheme works. BLZ has no price and nothing to buy;
its worth is measured in the favours and goods a community will trade for it,
never in cash. Bitcoin's *price* — a very different thing — is the product of
things no codebase contains:

1. **Security budget** — thousands of independent miners burning real
   electricity make rewriting Bitcoin's history cost billions. BallrzCoin's
   history is far cheaper to rewrite (SECURITY.md #3), so a BLZ community has to
   be one of people who already trust each other — a barter circle, not a market
   of strangers.
2. **A community that accepts it** — a currency for time and favours is only as
   real as the circle of people willing to earn and spend it. That circle is
   built person by person, not shipped in a release.
3. **Trust accumulated over time** — 15+ years of surviving attacks, forks,
   bans and bubbles gave Bitcoin its credibility. Trust cannot be shipped in a
   release; it only accretes, and a favour-and-goods currency earns it the same
   slow way.
4. **Ecosystem** — wallets, documentation, the barter board, the people running
   nodes. Each exists because the others do; bootstrapping the circle is the
   hard part.

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

BallrzCoin is a **complete, correct, working currency** for time and favours —
every rule is real and every attack in the test suite really is rejected. You
earn BLZ by mining or by doing favours, and you spend it on favours and time
inside a community that has agreed to accept it, exactly like a time bank or
LETS scheme. It is not, and will not pretend to be, an investment: there is no
ICO, no price, no token sale, nothing to buy — the value is favours and goods,
not cash. If you take one idea from it, take this one: *the code was never the
hard part of money — the consensus of a community willing to accept it was.*

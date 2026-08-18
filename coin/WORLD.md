# How TimeCoin goes worldwide — a federation, not an empire

TimeCoin's ambition is to be the world's bartering currency: anywhere on
Earth, an hour of your time is good for an hour of someone else's. This
document explains the architecture that can actually deliver that — and why it
is deliberately **not** "one world blockchain".

## Why not one global chain

A single worldwide chain is only as strong as the cost of attacking it.
Bitcoin's history is safe because rewriting it costs gigawatts; TimeCoin is
mined in browsers, so a single worldwide chain would hand the world's barter
economy to whoever pointed one GPU at it. The full list of what a
strangers-scale chain requires — hardened networking, audits, thousands of
independent miners, legal standing — is in [`ROADMAP.md`](ROADMAP.md), and no
codebase can ship it by itself.

The internet never solved this problem either — it routed around it. There is
no World Computer; there are millions of networks that agree on how to talk to
each other. TimeCoin goes worldwide the same way.

## The federation

**The circle is the unit of trust.** Each community runs its own relay and its
own chain: its money is mined, held and spent among people who chose each
other. Every consensus guarantee (proof-of-work, maturity, the finality
window) operates at the scale where its security model is honest.

**The commons is the unit of discovery.** Any relay can serve as a *commons* —
a well-known meeting point where circles announce themselves (a name and a
relay URL). Join it from the app's Network panel (🌍 The World Commons) and
the world's circles appear as neighbours. The commons is a convention, not an
authority: anyone can run one, circles can join several, and leaving is just
removing the relay. A censoring commons is routed around by the next one.

**Neighbours federate the social layer — never the money.** Connecting to
another circle shares offers, identities and reputation, and *only* those:
the `PEER_BLOCK` firewall in the app refuses a neighbour's chain, transactions,
mutual-credit entries, credit limits and deal records outright. A circle on
the other side of the world can show you what it will barter; it cannot touch
what you own ([`SECURITY.md`](SECURITY.md) #11).

**Bridges settle between circles.** Trade across circles moves as **net-zero
mutual credit** ([`bridge.js`](bridge.js), [`mutual.js`](mutual.js)): a signed
IOU is forwarded circle-to-circle, each hop bounded by that circle's own
credit limit. No coins leave home, no exchange rate exists — an hour is an
hour on both sides. This is the same clearing pattern time-bank federations
and the WIR have run for decades, with unforgeable signatures instead of
paper ledgers.

**Reputation travels with the person.** Receipts and vouches
([`reputation.js`](reputation.js)) are signed, portable and re-verified on
arrival, and the app shows how many attestations come from people *you*
already know — so a stranger arrives not as a stranger but as someone whose
history can be checked ([`SECURITY.md`](SECURITY.md) #10).

## What worldwide barter looks like in practice

1. A circle in Lagos and a circle in Leeds both join a commons.
2. Leeds sees Lagos under Neighbouring circles, taps **Connect** —
   offers and reputations flow, coins don't.
3. A Leeds member commissions a favour from a Lagos member (a translation, a
   design, an hour of tutoring — anything that crosses distance), priced in
   hours like everything else.
4. Payment moves as bridged favour-credit, bounded by each circle's credit
   limit; the doer banks an hour good in their own community.
5. The receipt joins the doer's passport; next time, anywhere, they're one
   hour more trusted.

The scale ceiling is generous because everything stays local: a commons holds
only tiny circle announcements, each relay's buffer is bounded and
rate-limited, and no chain ever grows past its own circle's history.

## Honest limits (and their route to fixed)

- **Circle labels are self-asserted** ([`SECURITY.md`](SECURITY.md) #12):
  anyone can announce a relay under any name. Connecting is manual, the
  firewall means a fake can only show you fake *offers*, and a signed
  circle-identity scheme is the designed fix.
- **Bridge trust is counterparty trust:** a bridge that accepts a favour on
  one side and doesn't forward it is a defaulting middleman, bounded by the
  credit limit — a social risk, priced in hours, never a way to counterfeit.
- **A commons operator can decline to list a circle.** So can a phone book.
  Run another commons; the app joins any URL.

## Running a commons

Deploy one more copy of the relay (same 5 minutes as [`DEPLOY.md`](DEPLOY.md),
e.g. as `the-commons` on Render's free tier) and share its URL — or set it as
`commonsUrl` in [`config.js`](config.js) so every copy of your app offers
one-tap joining. A commons needs nothing special: it is an ordinary relay that
circles choose to treat as a meeting square.

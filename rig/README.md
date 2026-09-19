# Rig — a real proof-of-work miner

Rig is a mining app that refuses to lie to you. Everything it hashes is genuine:
FIPS 180-4 SHA-256 implemented from the spec, double-SHA-256 over real 80-byte
Bitcoin block headers, real compact-"bits" targets. The unit tests prove it the
only way that matters — by recomputing the actual **Bitcoin genesis block hash**
(`000000000019d668…`) from raw bytes, and by cross-checking the SHA-256 against
`node:crypto` on two hundred inputs. The app has a "verify genesis" button so
you can watch it do the same in your browser.

## What you can mine

| Coin | What it is | What you earn |
| --- | --- | --- |
| **Bitcoin (BTC)** | Practice mode against the *real* network difficulty, with pool-style vardiff shares | Practice shares — never BTC. The reality-check card shows live, honest maths: your measured hashrate vs ~10²¹ H/s of ASICs, expected wait per block in multiples of the age of the universe |
| **Ballrz (BLZ)** | Local chain, 20 s blocks, 50 BLZ reward halving every 500 blocks | Real blocks on a real difficulty-retargeting chain that lives on your device |
| **Nugget (NUG)** | Local chain, 60 s blocks | Same, scarcer |
| **Ember (EMB)** | Local chain, 180 s blocks, mean retarget | Same, hard-won |

Local coins are real proof-of-work on a chain your device is the whole network
for: deterministic genesis, Bitcoin-style ×4-clamped difficulty retargeting,
halving subsidies with a hard cap. They have **no cash value** and the app says
so on its face.

Want mining that counts beyond one device? The repo's
[TimeCoin](../coin/README.md) is a full cryptocurrency (UTXO ledger, secp256k1
signatures, cumulative-work consensus) with its own miner at
[`../coin/mine.html`](../coin/mine.html) — Rig links to it.

## The honesty rule

The one thing Rig will never do is show a BTC balance. Browser mining of real
Bitcoin stopped being viable around 2011; apps that promise phone-mined bitcoin
are simulations or scams. Rig's Bitcoin mode exists to let you *feel* real
mining — live hashrate, shares, near-miss hashes — while the reality-check card
tells you exactly what those hashes are worth against the real network
(spoiler: at 200 kH/s, one expected block per several ages of the universe).

## Files

- `engine.js` — every rule, pure and clock-injected: SHA-256/SHA-256d, header
  serialization, bits↔target maths, `mineRange` nonce scanning, chains,
  rewards, retargeting, vardiff, hashrate windows, the reality-check maths.
  Tested in [`../scripts/test-rig-logic.mjs`](../scripts/test-rig-logic.mjs).
- `index.html` — the whole UI; owns the DOM, the clock, storage and the loop.
- `manifest.json`, `sw.js`, `icon.svg` + PNGs — installable, offline-first.

Run the tests: `npm run test:rig`

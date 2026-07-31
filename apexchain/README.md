# ApexChain — ApexCoin (AXC) as a real ERC-20

The ApexVIP loyalty coin, deployable to any EVM chain. Once withdrawn from the
app, AXC is an ordinary token: hold it in any wallet, send it to anyone, use it
anywhere ERC-20s work — and deposit it back into ApexVIP against bookings
(1.00 AXC = 1 APEX = £1 in-app).

## Supply model — bridge-custodial

The ApexVIP treasury (the contract owner) **mints only when coins leave the
in-app ledger** and **burns what comes back**, so `totalSupply()` always equals
the coins circulating *outside* the apps. Nothing here can inflate balances:
in-app coins are guarded by `firestore.rules` + the coin ledger, on-chain
supply by `onlyOwner` mint. The bridge itself is
[`../functions/src/chain.ts`](../functions/src/chain.ts) (withdraw / deposit /
signature-verified wallet linking).

## Layout

- [`contracts/ApexCoin.sol`](./contracts/ApexCoin.sol) — OpenZeppelin
  ERC20 + Burnable + Ownable, 2 decimals, `mint` gated to the treasury.
- [`artifacts/ApexCoin.json`](./artifacts/ApexCoin.json) — the **committed**
  compiled artifact (like `apexvip-engine.js`): tests, the deploy script and
  the functions emulator test consume it without needing the Solidity
  toolchain. Rebuild with `npm run compile` after any contract change.
  Compiled for the `paris` EVM so the bytecode runs on older L2s and the test
  EVM alike.

## Commands

```sh
cd apexchain
npm install
npm run compile   # solc-js (compiler ships in the npm package) → artifacts/
npm test          # deploys to an in-process EVM (ganache) and asserts the
                  # bridge guarantees: owner-only mint, free transfers,
                  # burn-on-deposit, the supply invariant
npm run deploy    # CHAIN_RPC_URL=… CHAIN_TREASURY_KEY=… node deploy.mjs
```

The full app-ledger ↔ chain round trip is proven in
`functions/npm run test:emulator:chain` — the real Cloud Functions bridging to
a real EVM. Deployment runbook + the regulatory picture:
[`../docs/apexvip-apexcoin-onchain.md`](../docs/apexvip-apexcoin-onchain.md).

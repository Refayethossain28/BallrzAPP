# ApexCoin on-chain — APEX as a real cryptocurrency

ApexCoin now exists in two forms with one total supply:

- **In-app APEX/AXC** — the server-authoritative loyalty ledger
  (`users/{uid}.apexBalance`, `drivers/{uid}.apexcoin`, the append-only
  `coin_ledger`; written only by Cloud Functions).
- **On-chain AXC** — a standard ERC-20 ([`apexchain/contracts/ApexCoin.sol`](../apexchain/contracts/ApexCoin.sol),
  2 decimals, 1.00 AXC = 1 APEX = £1 redeemable in-app). Once withdrawn it is
  usable **outside the ApexVIP environment**: any wallet, any transfer, any
  venue that speaks ERC-20.

## How value crosses the boundary

```
        withdrawCoinsOnchain                    plain ERC-20 world
 app ────────────────────────▶ user's wallet ──▶ other wallets, DEXes, …
ledger  deduct → treasury MINTS       │
   ▲                                  │ transfer AXC to the treasury
   │    depositCoinsOnchain           ▼
   └───────────────────────── treasury address
        verify tx → credit once → BURN
```

- **Withdraw** (`withdrawCoinsOnchain`): transactionally deducts the app
  balance and writes a `withdraw` ledger row FIRST, then the treasury mints
  AXC to the requested wallet. Idempotent per `idempotencyKey` (a retry
  returns the original tx, never mints twice); a chain failure triggers a
  compensating refund so coins are never lost in flight.
- **Deposit** (`depositCoinsOnchain`): the user transfers AXC to the treasury
  from their **linked wallet** and claims the tx hash. The function verifies
  the transfer on-chain, credits exactly once (ledger id = tx hash), and
  burns what arrived.
- **Linking** (`linkChainWallet`): requires an ethers `personal_sign`
  signature over `ApexVIP wallet link for user {uid}` — so nobody can link
  someone else's wallet and claim their deposits. `users.chainAddress` is
  blocked from self-writes in `firestore.rules` for the same reason.

**Invariant:** tokens are minted only against a ledger deduction and burned on
return, so `totalSupply()` always equals the coins outside the app — the
admin panel's "On ApexChain" figure.

## Proven, not promised

- `apexchain/npm test` — the contract on a real in-process EVM: owner-only
  mint, free third-party transfers, burn, the supply invariant.
- `functions/npm run test:emulator:chain` — the REAL Cloud Functions bridging
  to a real EVM: signature-gated linking, idempotent withdraw (no double
  mint/deduct), overdraft rejection, wallet-to-wallet transfers outside the
  app, deposit credited once then burned, double-claim and deposit-theft
  attempts rejected.

## Runbook — testnet first

1. **Deploy the token** (e.g. Base Sepolia):
   ```sh
   cd apexchain && npm install
   CHAIN_RPC_URL=https://sepolia.base.org CHAIN_TREASURY_KEY=0x… npm run deploy
   ```
   The treasury key needs a little testnet ETH for gas (mints are ~50k gas).
2. **Store the treasury key** as a functions secret:
   ```sh
   firebase functions:secrets:set CHAIN_TREASURY_KEY
   ```
3. **Create `settings/chain`** in Firestore (the deploy script prints it):
   ```json
   { "enabled": true, "rpcUrl": "https://sepolia.base.org",
     "contractAddress": "0x…", "chainId": 84532,
     "explorerBase": "https://sepolia.basescan.org/tx/" }
   ```
4. **Deploy the bridge functions** (scoped, per `functions/README.md`):
   `linkChainWallet`, `withdrawCoinsOnchain`, `depositCoinsOnchain`.

Until every piece is configured the bridge **fails closed** with a clear
message and the apps behave exactly as before — the repo's standard
partial-setup behaviour. Flip `settings/chain.enabled` to `false` to pause
withdrawals/deposits instantly without a deploy.

The client UI lives on the **Tier benefits** screen (`apex-benefits`):
link wallet (MetaMask `personal_sign`), withdraw to any address with a block
explorer link, deposit by pasting the tx hash.

## ⚠️ Before any mainnet deployment

A transferable token redeemable for £1 of services is not a loyalty gimmick
in the eyes of regulators:

- **UK**: likely e-money / regulated cryptoasset territory — FCA registration
  under the MLRs, the financial-promotions regime for anything marketing the
  token, plus AML/KYC obligations on withdrawals and deposits.
- **Custody**: the treasury key controls the mint. Use an HSM/KMS or a
  multisig (e.g. Safe) as the owner, not a raw secret, and consider a
  third-party contract audit despite the OpenZeppelin base.
- **Peg risk**: "1 AXC = £1 in-app" is ApexVIP's promise, not the market's.
  Once AXC trades freely it can price above or below the peg; honouring
  deposits at £1 is then a real balance-sheet liability.

Ship testnet, demo it, and get regulatory advice before mainnet. The code
path is identical either way — only `settings/chain` and the key change.

/**
 * Emulator integration test: APEX leaves the app as a REAL ERC-20 and comes
 * back — the full circle, against real infrastructure end to end.
 *
 * Boots an in-process EVM (ganache) next to the Functions emulator, deploys
 * the compiled ApexCoin contract, then drives the actual bridge callables:
 *
 *   link     — a wallet is linked only with a valid ethers signature.
 *   withdraw — deducts the app ledger and MINTS AXC to the wallet; idempotent
 *              per key (no double mint), rejects overdrafts.
 *   outside  — the withdrawn AXC moves wallet-to-wallet with plain ethers,
 *              no ApexVIP anywhere: the "usable outside the environment" test.
 *   deposit  — a transfer back to the treasury is verified on-chain, credited
 *              exactly once (double-claims and other users' transfers are
 *              rejected), and BURNED — so totalSupply() always equals the
 *              coins still outside the app.
 *
 * Run:  npm run test:emulator:chain   (from functions/)
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { Contract, ContractFactory, JsonRpcProvider, Wallet } from 'ethers';

// ganache lives in apexchain's devDependencies (the contract's own toolchain);
// requiring it across packages keeps this repo to ONE copy of the EVM.
const require_ = createRequire(import.meta.url);
const ganache = require_('../../apexchain/node_modules/ganache');
const artifact = JSON.parse(readFileSync(new URL('../../apexchain/artifacts/ApexCoin.json', import.meta.url), 'utf8'));

process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
const FUNCTIONS_ORIGIN = process.env.FUNCTIONS_EMULATOR_ORIGIN || 'http://127.0.0.1:5001';
const RPC_PORT = 8546;
// Test-only keys; ganache below funds these three explicitly. TREASURY_KEY
// must match CHAIN_TREASURY_KEY in the npm script so the functions runtime
// signs as the treasury.
const TREASURY_KEY = '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bca9c95dc0f78dbdcb9e6ce4';
const USER_KEY = '0x6cbed15c793ce57650b9877cf6fa156fbef513c4e6134f022a85b1ffdd59b2a1';
const FRIEND_KEY = '0x6370fd033278c143179d81c5526140625662b8daa446c22ee2d73db3707e620c';
const HUNDRED_ETH = '0x56bc75e2d63100000';

admin.initializeApp({ projectId: 'demo-apexvip' });
const db = admin.firestore();

let failed = false;
const check = (cond, msg) => { if (!cond) { failed = true; console.error('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } };

function emulatorToken(uid) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: 'https://securetoken.google.com/demo-apexvip', aud: 'demo-apexvip',
    iat: now, exp: now + 3600, auth_time: now, sub: uid, user_id: uid, uid,
    firebase: { identities: {}, sign_in_provider: 'custom' },
  })}.`;
}

/** POST a callable like the SDK does; returns {ok, result|error}. */
async function call(name, uid, data) {
  const res = await fetch(`${FUNCTIONS_ORIGIN}/demo-apexvip/us-central1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${emulatorToken(uid)}` },
    body: JSON.stringify({ data: data ?? {} }),
  });
  const body = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, result: body.result } : { ok: false, error: body.error || {} };
}

async function main() {
  // ── Boot the chain and deploy ApexCoin ─────────────────────────────────────
  console.log('→ starting a local EVM and deploying ApexCoin…');
  const server = ganache.server({
    wallet: { accounts: [TREASURY_KEY, USER_KEY, FRIEND_KEY].map((secretKey) => ({ secretKey, balance: HUNDRED_ETH })) },
    logging: { quiet: true },
  });
  await server.listen(RPC_PORT);
  const rpcUrl = `http://127.0.0.1:${RPC_PORT}`;
  const provider = new JsonRpcProvider(rpcUrl);
  const treasury = new Wallet(TREASURY_KEY, provider);
  const coin = await new ContractFactory(artifact.abi, artifact.bytecode, treasury).deploy(treasury.address);
  await coin.waitForDeployment();
  const contractAddress = await coin.getAddress();
  console.log(`  ApexCoin at ${contractAddress}, treasury ${treasury.address}`);

  // The user's external wallets — plain EVM accounts, nothing ApexVIP about them.
  const userWallet = new Wallet(USER_KEY, provider);
  const friendWallet = new Wallet(FRIEND_KEY, provider);
  const userAddr = userWallet.address;
  const friendAddr = friendWallet.address;
  const asUser = new Contract(contractAddress, artifact.abi, userWallet);
  const asFriend = new Contract(contractAddress, artifact.abi, friendWallet);
  const balOf = async (a) => Number(await coin.balanceOf(a));

  // Bridge config the functions read (the treasury key travels via env/secret).
  await db.doc('settings/chain').set({ enabled: true, rpcUrl, contractAddress, explorerBase: 'https://explorer.example/tx/' });
  await db.doc('users/chain-client').set({ role: 'client', apexBalance: 20 });

  // ── 1. Linking requires a real signature ───────────────────────────────────
  console.log('→ linking the external wallet (signature-verified)…');
  const badSig = await friendWallet.signMessage('ApexVIP wallet link for user chain-client');
  const badLink = await call('linkChainWallet', 'chain-client', { address: userAddr, signature: badSig });
  check(!badLink.ok, 'a signature from the WRONG key does not link the wallet');
  const goodSig = await userWallet.signMessage('ApexVIP wallet link for user chain-client');
  const link = await call('linkChainWallet', 'chain-client', { address: userAddr, signature: goodSig });
  check(link.ok && link.result.address === userAddr, `wallet linked with a valid signature (${userAddr.slice(0, 10)}…)`);

  // ── 2. Withdraw: ledger deducted, AXC minted, idempotent ──────────────────
  console.log('→ withdrawing 12 APEX to the wallet…');
  const w1 = await call('withdrawCoinsOnchain', 'chain-client', { amount: 12, address: userAddr, idempotencyKey: 'k1' });
  check(w1.ok && w1.result.withdrawn === 12, `withdrew 12 APEX (got ${JSON.stringify(w1.result || w1.error).slice(0, 120)})`);
  check(w1.ok && /^0x[0-9a-f]{64}$/.test(w1.result.txHash), 'mint tx hash returned');
  check(w1.ok && w1.result.explorer.startsWith('https://explorer.example/tx/0x'), 'explorer link built from settings');
  let user = (await db.doc('users/chain-client').get()).data();
  check(user.apexBalance === 8, `app balance deducted to 8 (got ${user.apexBalance})`);
  check(await balOf(userAddr) === 1200, `wallet holds 12.00 AXC on-chain (got ${await balOf(userAddr)})`);
  check(Number(await coin.totalSupply()) === 1200, 'totalSupply == coins outside the app');

  const w1again = await call('withdrawCoinsOnchain', 'chain-client', { amount: 12, address: userAddr, idempotencyKey: 'k1' });
  check(w1again.ok && w1again.result.withdrawn === 12 && w1again.result.txHash === w1.result.txHash, 'retried withdrawal returns the original tx (idempotent)');
  check(await balOf(userAddr) === 1200, 'retry did not double-mint');
  user = (await db.doc('users/chain-client').get()).data();
  check(user.apexBalance === 8, 'retry did not double-deduct');

  const over = await call('withdrawCoinsOnchain', 'chain-client', { amount: 100, address: userAddr, idempotencyKey: 'k2' });
  check(!over.ok, 'overdraft withdrawal rejected');

  // ── 3. Outside the environment: plain ERC-20 transfers, no ApexVIP ────────
  console.log('→ moving AXC wallet-to-wallet outside ApexVIP…');
  await (await asUser.transfer(friendAddr, 700)).wait();
  check(await balOf(friendAddr) === 700, `a third party now holds 7.00 AXC (got ${await balOf(friendAddr)})`);

  // ── 4. Deposit: verified, credited once, burned ────────────────────────────
  console.log('→ depositing 5.00 AXC back into the app…');
  const depTx = await (await asUser.transfer(treasury.address, 500)).wait();
  const dep = await call('depositCoinsOnchain', 'chain-client', { txHash: depTx.hash });
  check(dep.ok && dep.result.deposited === 5, `deposit credited 5 APEX (got ${JSON.stringify(dep.result || dep.error).slice(0, 120)})`);
  user = (await db.doc('users/chain-client').get()).data();
  check(user.apexBalance === 13, `app balance is 13 after deposit (got ${user.apexBalance})`);
  check(Number(await coin.totalSupply()) === 700, `deposit was burned — supply equals the 7.00 AXC still outside (got ${Number(await coin.totalSupply())})`);

  const depAgain = await call('depositCoinsOnchain', 'chain-client', { txHash: depTx.hash });
  check(depAgain.ok && depAgain.result.deposited === 0 && depAgain.result.alreadyClaimed, 'double-claiming the same tx credits nothing');
  user = (await db.doc('users/chain-client').get()).data();
  check(user.apexBalance === 13, 'double-claim did not change the balance');

  // ── 5. Only YOUR wallet's transfers credit you ─────────────────────────────
  console.log('→ deposit-theft attempts are rejected…');
  const friendTx = await (await asFriend.transfer(treasury.address, 200)).wait();
  const steal = await call('depositCoinsOnchain', 'chain-client', { txHash: friendTx.hash });
  check(!steal.ok, 'claiming a transfer from someone ELSE\'s wallet is rejected');
  await db.doc('users/chain-nolink').set({ role: 'client', apexBalance: 0 });
  const nolink = await call('depositCoinsOnchain', 'chain-nolink', { txHash: friendTx.hash });
  check(!nolink.ok, 'claiming without a linked wallet is rejected');

  await server.close();
}

main()
  .then(() => { console.log(failed ? '\nCHAIN BRIDGE TEST FAILED' : '\nCHAIN BRIDGE TEST PASSED'); process.exit(failed ? 1 : 0); })
  .catch((e) => { console.error('error:', e?.message || e); process.exit(1); });

/**
 * Deploy ApexCoin to a real network and print the `settings/chain` doc the
 * backend bridge reads. Testnet first — see ../docs/apexvip-apexcoin-onchain.md
 * (and its regulatory section before considering any mainnet).
 *
 *   CHAIN_RPC_URL=https://sepolia.base.org \
 *   CHAIN_TREASURY_KEY=0x… \
 *   node deploy.mjs
 */
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';

const rpcUrl = process.env.CHAIN_RPC_URL;
const key = process.env.CHAIN_TREASURY_KEY;
if (!rpcUrl || !key) {
  console.error('Set CHAIN_RPC_URL and CHAIN_TREASURY_KEY (the treasury private key).');
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(new URL('./artifacts/ApexCoin.json', import.meta.url), 'utf8'));
const provider = new JsonRpcProvider(rpcUrl);
const treasury = new Wallet(key, provider);

console.log(`deploying ApexCoin from treasury ${treasury.address} …`);
const coin = await new ContractFactory(artifact.abi, artifact.bytecode, treasury).deploy(treasury.address);
await coin.waitForDeployment();
const address = await coin.getAddress();
const net = await provider.getNetwork();

console.log(`\nApexCoin deployed: ${address} (chainId ${net.chainId})`);
console.log('\nCreate the Firestore doc settings/chain with:');
console.log(JSON.stringify({ enabled: true, rpcUrl, contractAddress: address, chainId: Number(net.chainId), explorerBase: '<block explorer tx URL prefix, e.g. https://sepolia.basescan.org/tx/>' }, null, 2));
console.log('\nand store the treasury key as the CHAIN_TREASURY_KEY functions secret:');
console.log('  firebase functions:secrets:set CHAIN_TREASURY_KEY');

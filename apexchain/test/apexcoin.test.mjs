/**
 * ApexCoin ERC-20 tests — run against a real in-process EVM (ganache), not
 * mocks: deploy the compiled artifact, then assert the bridge-custodial
 * guarantees the Cloud Functions rely on.
 *
 * Run: npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, Contract } from 'ethers';

const artifact = JSON.parse(readFileSync(new URL('../artifacts/ApexCoin.json', import.meta.url), 'utf8'));

let ganacheProvider, provider, treasury, alice, bob, coin;

before(async () => {
  ganacheProvider = ganache.provider({ wallet: { deterministic: true }, logging: { quiet: true } });
  provider = new BrowserProvider(ganacheProvider);
  [treasury, alice, bob] = await Promise.all([provider.getSigner(0), provider.getSigner(1), provider.getSigner(2)]);
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, treasury);
  coin = await factory.deploy(await treasury.getAddress());
  await coin.waitForDeployment();
});
after(async () => { await ganacheProvider.disconnect(); });

const as = (signer) => coin.connect(signer);
const bal = async (who) => Number(await coin.balanceOf(await who.getAddress()));

test('identity: ApexCoin / AXC with 2 decimals (1.00 AXC = 1 APEX)', async () => {
  assert.equal(await coin.name(), 'ApexCoin');
  assert.equal(await coin.symbol(), 'AXC');
  assert.equal(Number(await coin.decimals()), 2);
  assert.equal(Number(await coin.totalSupply()), 0); // nothing exists until a withdrawal
});

test('only the treasury can mint', async () => {
  let reverted = false;
  try { await (await as(alice).mint(await alice.getAddress(), 100_00)).wait(); }
  catch { reverted = true; } // ethers v6 rejects at estimateGas — still a revert
  assert.ok(reverted, 'non-owner mint must revert');
  assert.equal(Number(await coin.totalSupply()), 0);
  await (await as(treasury).mint(await alice.getAddress(), 12_00)).wait(); // £12 withdrawal
  assert.equal(await bal(alice), 12_00);
  assert.equal(Number(await coin.totalSupply()), 12_00);
});

test('withdrawn AXC is an ordinary ERC-20 — transfers outside the app work', async () => {
  await (await as(alice).transfer(await bob.getAddress(), 7_00)).wait();
  assert.equal(await bal(alice), 5_00);
  assert.equal(await bal(bob), 7_00);
});

test('bridge invariant: totalSupply == coins outside the app (deposit burns)', async () => {
  // Alice sends 5.00 AXC back to the treasury (a deposit)…
  await (await as(alice).transfer(await treasury.getAddress(), 5_00)).wait();
  // …and the bridge burns what it received.
  await (await as(treasury).burn(5_00)).wait();
  assert.equal(await bal(alice), 0);
  assert.equal(await bal(treasury), 0);
  // Outside supply is exactly Bob's 7.00 AXC.
  assert.equal(Number(await coin.totalSupply()), 7_00);
  assert.equal(await bal(bob), 7_00);
});

test('a non-treasury holder cannot burn someone else\'s coins', async () => {
  let reverted = false;
  try { await (await as(bob).burnFrom(await treasury.getAddress(), 1)).wait(); }
  catch { reverted = true; }
  assert.ok(reverted, 'burnFrom without allowance must revert');
  assert.equal(Number(await coin.totalSupply()), 7_00);
});

/**
 * Compile contracts/ApexCoin.sol → artifacts/ApexCoin.json ({abi, bytecode}).
 *
 * Uses solc-js (the compiler ships inside the npm package — no downloads), with
 * an import callback that resolves @openzeppelin/* from node_modules. The
 * artifact is COMMITTED, like apexvip-engine.js: consumers (tests, the deploy
 * script, the functions emulator test) never need the Solidity toolchain.
 *
 * Run: npm run compile
 */
import solc from 'solc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE = 'contracts/ApexCoin.sol';

const input = {
  language: 'Solidity',
  sources: { [SOURCE]: { content: readFileSync(join(ROOT, SOURCE), 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // 'paris' — no PUSH0/MCOPY, so the bytecode runs everywhere: older L2s,
    // and the ganache EVM the tests + emulator bridge test run against.
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

function findImports(path) {
  try {
    const resolved = path.startsWith('@')
      ? resolve(ROOT, 'node_modules', path)
      : resolve(ROOT, dirname(SOURCE), path);
    return { contents: readFileSync(resolved, 'utf8') };
  } catch {
    return { error: `import not found: ${path}` };
  }
}

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage);
  process.exit(1);
}
for (const w of (out.errors || []).filter((e) => e.severity === 'warning')) {
  console.warn(w.formattedMessage);
}

const c = out.contracts[SOURCE].ApexCoin;
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
writeFileSync(
  join(ROOT, 'artifacts/ApexCoin.json'),
  JSON.stringify({ contractName: 'ApexCoin', abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2),
);
console.log(`compiled ApexCoin.sol → artifacts/ApexCoin.json (${c.evm.bytecode.object.length / 2} bytes)`);

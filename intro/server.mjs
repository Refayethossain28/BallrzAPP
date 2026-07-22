#!/usr/bin/env node
/**
 * Intro — Apple Wallet pass server
 * ================================
 *
 * A zero-dependency Node server (same pattern as lingua/server.mjs) that turns
 * an Intro card token into a signed .pkpass. Apple only opens Wallet passes
 * signed with a Pass Type ID certificate from the Apple Developer Programme,
 * so the certificates stay HERE, server-side — the app just POSTs the card's
 * share token and gets the pass back. Full setup: intro/WALLET.md.
 *
 *   PASS_TYPE_ID=pass.com.you.intro \
 *   TEAM_ID=AB12CD34EF \
 *   PASS_CERT=path/to/pass-cert.pem \
 *   PASS_KEY=path/to/pass-key.pem \
 *   [PASS_KEY_PASSPHRASE=…] \
 *   WWDR_CERT=path/to/wwdr.pem \
 *   [BASE_URL=https://refayethossain28.github.io/BallrzAPP/intro/] \
 *   [PORT=8787] \
 *   node intro/server.mjs
 *
 *   POST /pass  {"token":"1.…"}  → application/vnd.apple.pkpass
 *   GET  /      → {ok, configured}
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { buildPkpass } from './pass.mjs';

// The engine is a UMD file and the repo is type:module, so load it the same
// way the unit tests do — in a vm sandbox with a CommonJS-shaped module.
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'engine.js'), 'utf8'),
  sandbox, { filename: 'intro/engine.js' }
);
const Intro = sandbox.module.exports;

const PORT = Number(process.env.PORT || 8787);
const BASE_URL = process.env.BASE_URL || 'https://refayethossain28.github.io/BallrzAPP/intro/';

function loadConfig() {
  const { PASS_TYPE_ID, TEAM_ID, PASS_CERT, PASS_KEY, WWDR_CERT } = process.env;
  if (!PASS_TYPE_ID || !TEAM_ID || !PASS_CERT || !PASS_KEY) return null;
  try {
    return {
      passTypeId: PASS_TYPE_ID,
      teamId: TEAM_ID,
      signerCertPem: readFileSync(PASS_CERT, 'utf8'),
      signerKeyPem: readFileSync(PASS_KEY, 'utf8'),
      signerKeyPassphrase: process.env.PASS_KEY_PASSPHRASE || undefined,
      wwdrPem: WWDR_CERT ? readFileSync(WWDR_CERT, 'utf8') : undefined,
    };
  } catch (e) {
    console.error('Could not read certificates:', e.message);
    return null;
  }
}
const config = loadConfig();

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify(obj));
};

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method === 'GET') { json(res, 200, { ok: true, service: 'intro-pass', configured: !!config }); return; }
  if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/pass') {
    json(res, 404, { error: 'POST /pass with {"token":"1.…"}' }); return;
  }
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1 << 20) req.destroy(); });
  req.on('end', () => {
    if (!config) { json(res, 503, { error: 'Pass signing is not configured — see intro/WALLET.md' }); return; }
    let token = '';
    try { token = String(JSON.parse(body || '{}').token || ''); } catch (e) { /* fall through */ }
    const card = Intro.decodeCard(token);
    if (!card) { json(res, 400, { error: 'Not a valid Intro card token' }); return; }
    try {
      const shareUrl = BASE_URL.split('#')[0] + '#c=' + Intro.encodeCard(card, { avatar: false });
      const pkpass = buildPkpass(card, { ...config, shareUrl });
      res.writeHead(200, {
        'content-type': 'application/vnd.apple.pkpass',
        'content-disposition': 'attachment; filename="' + Intro.vcardFilename(card).replace(/\.vcf$/, '.pkpass') + '"',
        ...cors,
      });
      res.end(pkpass);
    } catch (e) {
      console.error('Pass build failed:', e);
      json(res, 500, { error: 'Pass build failed: ' + e.message });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Intro pass server on http://localhost:${PORT}  (signing ${config ? 'CONFIGURED ✅' : 'NOT configured — see intro/WALLET.md'})`);
});

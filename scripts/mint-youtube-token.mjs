#!/usr/bin/env node
/**
 * Mints the YouTube refresh token for the Atlas community channel — the
 * one-time, owner-side half of clip uploads (atlasClipPublish uses it
 * forever after via the ATLAS_YT_* secrets).
 *
 * Uses Google's device flow so it works from any terminal, no local
 * webserver: it prints a URL + code, you approve on your phone while
 * signed in as the CHANNEL's Google account, and the refresh token prints
 * here.
 *
 * Run: node scripts/mint-youtube-token.mjs <client_id> <client_secret>
 * (Create the OAuth client in Google Cloud console as type "TVs and
 *  Limited Input devices" — see atlas/YOUTUBE.md.)
 */
const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error('usage: node scripts/mint-youtube-token.mjs <client_id> <client_secret>');
  process.exit(1);
}

const form = (o) => new URLSearchParams(o);
const dev = await (await fetch('https://oauth2.googleapis.com/device/code', {
  method: 'POST',
  body: form({ client_id: clientId, scope: 'https://www.googleapis.com/auth/youtube.upload' }),
})).json();
if (!dev.device_code) { console.error('device code failed:', dev); process.exit(1); }

console.log('\n1. On any device, open:  ' + dev.verification_url);
console.log('2. Enter the code:       ' + dev.user_code);
console.log('3. Sign in as the Atlas channel\'s Google account and approve.\n');

const deadline = Date.now() + dev.expires_in * 1000;
let token = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, (dev.interval || 5) * 1000));
  const res = await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: form({ client_id: clientId, client_secret: clientSecret,
                 device_code: dev.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
  })).json();
  if (res.refresh_token) { token = res.refresh_token; break; }
  if (res.error && res.error !== 'authorization_pending' && res.error !== 'slow_down') {
    console.error('failed:', res.error_description || res.error); process.exit(1);
  }
  process.stdout.write('.');
}
if (!token) { console.error('\ntimed out — run again'); process.exit(1); }

console.log('\n\nRefresh token (store it as a secret, never commit it):\n');
console.log(token);
console.log('\ncd functions');
console.log('firebase functions:secrets:set ATLAS_YT_REFRESH_TOKEN   # paste the token above');

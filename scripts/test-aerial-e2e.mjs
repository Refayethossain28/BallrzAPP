#!/usr/bin/env node
/**
 * End-to-end browser test for Aerial — internet radio, podcasts and live TV.
 *
 * Drives the REAL aerial/index.html in headless Chromium against media that
 * ffmpeg synthesises at run time, so the whole chain is exercised exactly as a
 * phone would run it: fetch → M3U8 parser → TS demuxer → fMP4 remuxer → MSE,
 * plus the direct <audio>/<video> path and the live-playlist refresh loop.
 *
 * Fixtures (ffmpeg, into a mkdtemp dir that is removed afterwards; test
 * pattern + sine, 320x180, 6 s, 2 s segments):
 *   a) HLS VOD, MPEG-TS segments, H.264 baseline + AAC-LC      (-hls_segment_type mpegts)
 *   b) HLS VOD, fMP4 segments with an EXT-X-MAP init segment    (-hls_segment_type fmp4)
 *   c) a hand-written master playlist: (a) at 500 kbps + a 160x90 / 150 kbps H.264 rendition
 *   d) HLS VOD, fMP4 segments, VP9 + Opus, at 320x180 and at 160x90, plus a
 *      hand-written master over the two — Playwright's open-source Chromium
 *      ships WITHOUT H.264/AAC decoders, so these are the HLS cases that must
 *      actually play there (the H.264 cases are judged "codec-limited", below)
 *   e) a direct WebM file (VP9/Opus) and a direct Opus .ogg (radio-style audio)
 *   f) two "live" streams: a sliding-window media playlist (no ENDLIST, 3-segment
 *      window, advancing one segment every 2 s, EXT-X-DISCONTINUITY where the
 *      6 s fixture wraps) that the server regenerates on every request — over
 *      the TS segments of (a) at /live/ and over the fMP4 segments + init of
 *      (d) at /live-vp9/.
 *
 * Server: a tiny node:http server on 127.0.0.1 serving the repo root (so
 * /aerial/index.html and /aerial/engine.js load), the fixture dir under /fx/
 * and the live playlists under /live/ and /live-vp9/, with the right content
 * types (m3u8 → application/vnd.apple.mpegurl, ts → video/mp2t, m4s/mp4 →
 * video/mp4, webm, ogg), HTTP Range support, Access-Control-Allow-Origin: *
 * and no caching.
 *
 * Browser: headless Chromium via Playwright, which is a dev-only tool resolved
 * by absolute path from apexvip-web/node_modules (or AERIAL_E2E_PLAYWRIGHT /
 * the bare 'playwright' module); browsers under PLAYWRIGHT_BROWSERS_PATH
 * (/opt/pw-browsers); never downloaded. Launch order: Playwright's bundled
 * build → any chromium-<build>/chrome-linux/chrome found under PLAYWRIGHT_BROWSERS_PATH
 * (used when the installed Playwright expects a newer build than is on disk)
 * → the 'chrome' channel. Flags: --autoplay-policy=no-user-gesture-required,
 * --mute-audio, and --proxy-server=direct:// + --proxy-bypass-list=* so the
 * sandbox's HTTPS_PROXY is never used for localhost.
 *
 * Each case opens http://127.0.0.1:PORT/aerial/index.html#play=<fixture url>
 * (the contract in SPEC.md: the page opens the TV tab, starts that URL and
 * exposes window.__aerial = {status, error, strategy, variantIndex,
 * currentTime(), buffered(), lib()} with document.body.dataset.status
 * mirroring status) and polls window.__aerial every 250 ms for up to 20 s:
 *   • PASS (✓) when status becomes 'playing', currentTime() passes 1.5 s and
 *     keeps increasing across two consecutive polls, and buffered() is non-empty;
 *   • the master-playlist cases must also report variantIndex as a number;
 *   • the live cases must keep currentTime increasing for ≥ 8 s — one segment beyond
 *     the 6 s window, so a refreshed playlist had to be fetched — and never error
 *     (they get 30 s);
 *   • CODEC-LIMITED (~, counted apart from ✓): when the launched browser says
 *     MediaSource.isTypeSupported('video/mp4; codecs="avc1.42e01e,mp4a.40.2"')
 *     is false (Playwright's open-source Chromium), the H.264/AAC cases (a, b,
 *     c, the TS live stream) cannot play. Such a case is accepted only when the
 *     page fetched the playlist (and, except for the master, a segment or init)
 *     from this server and then ended in status 'error' with a message that
 *     names the decoder: says the browser cannot decode / lacks the codec AND
 *     names the codec id the stream carries (avc1.PPCCLL from the SPS the TS
 *     demuxer parsed, the init segment or the CODECS attribute; mp4a.40.x).
 *     Any other outcome — a stall, a generic error, 'playing' without advance,
 *     an error before anything was fetched — FAILS. A codec-limited case proves
 *     only that the player got as far as the codec check; the real play /
 *     master / live verdicts come from the VP9/Opus cases, which such a
 *     browser does decode;
 *   • page console errors, uncaught page errors and failed/4xx requests to
 *     this server are collected into the failure message.
 * One line per case; the summary counts passed, codec-limited and failed
 * separately; exit 1 on any failure, 0 otherwise. A screenshot of the first
 * case that really plays is saved for the human (AERIAL_E2E_SCREENSHOT,
 * default <os tmpdir>/aerial-e2e-playing.png; the path is printed).
 *
 * Cleanup: the fixture dir, the browser and the server are released on every
 * exit path — normal end, a failed fixture sanity assert, an uncaught error or
 * unhandled rejection outside runCase, SIGINT/SIGTERM/SIGHUP. The process
 * 'exit' hook removes the dir synchronously; the signal and crash handlers
 * close the browser and the server first. AERIAL_E2E_KEEP=1 keeps the dir.
 *
 * SKIPPABLE — exits 0 with a "[skip] reason" line when ffmpeg is not on PATH,
 * Playwright cannot be imported, or no browser can be launched. CI does not run
 * this file; it is a local verification tool. Zero dependencies in package.json.
 *
 * Env: AERIAL_E2E_ROOT=<dir> serves that directory as /aerial/ instead of the
 * repo's aerial/ (used to validate the harness itself against a stub);
 * AERIAL_E2E_PLAYWRIGHT, AERIAL_E2E_CHROMIUM (executable), AERIAL_E2E_TIMEOUT
 * (ms per case), AERIAL_E2E_SCREENSHOT (png path), AERIAL_E2E_KEEP=1 keeps the
 * fixture dir. Run: node scripts/test-aerial-e2e.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, createReadStream, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir, constants as osConstants } from 'node:os';
import { join, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AERIAL_ROOT = process.env.AERIAL_E2E_ROOT ? resolve(process.env.AERIAL_E2E_ROOT) : join(ROOT, 'aerial');
const TIMEOUT_MS = Number(process.env.AERIAL_E2E_TIMEOUT) > 0 ? Number(process.env.AERIAL_E2E_TIMEOUT) : 20000;
const LIVE_TIMEOUT_MS = TIMEOUT_MS + 10000;
// One segment MORE than the live window (3 × 2 s): the first playlist alone buffers 6 s, so only a refreshed
// playlist whose new segment was fetched, appended and played can carry the playhead this far.
const LIVE_MIN_ADVANCE_SEC = 8;
const POLL_MS = 250;
// A committed test must not know any developer's directories: the OS temp dir unless the env says otherwise.
const SCREENSHOT = process.env.AERIAL_E2E_SCREENSHOT || join(tmpdir(), 'aerial-e2e-playing.png');
const H264_MSE = 'video/mp4; codecs="avc1.42e01e,mp4a.40.2"';
const VP9_CODECS = 'vp09.00.10.08,opus';          // what the engine reads back from ffmpeg's vpcC + Opus init (mp4CodecsFromInit)
const VP9_MSE = `video/mp4; codecs="${VP9_CODECS}"`;
const CHROMIUM_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--proxy-server=direct://',
  '--proxy-bypass-list=*',
];
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

const skip = (reason) => { console.log(`[skip] ${reason}`); process.exit(0); };
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/* ---------- 0. cleanup on every exit path ---------- */
// Everything that outlives a crash is held here, null until created: the ~1 MB fixture dir in the OS temp dir,
// the http server and the browser child process. Before this hook existed a failed sanity assert, a Playwright
// rejection outside runCase's try/catch or a Ctrl-C left the dir behind and the server open. Node runs 'exit'
// listeners synchronously, so the dir is removed there with rmSync; signals and uncaught errors go through
// die(), which closes the browser and the server first and then exits (a timer caps how long that may take).
let FX = null, server = null, browser = null, context = null;
let fixturesRemoved = false;
function removeFixtures() {
  if (fixturesRemoved || !FX) return;
  fixturesRemoved = true;
  if (process.env.AERIAL_E2E_KEEP === '1') { console.log(`  fixtures kept: ${FX}`); return; }
  try { rmSync(FX, { recursive: true, force: true }); } catch (e) { console.error(`  could not remove ${FX}: ${e.message}`); }
}
process.on('exit', removeFixtures);
let dying = false;
function die(code, why) {
  if (dying) return;                                   // a second failure while shutting down: 'exit' still removes the fixtures
  dying = true;
  console.error(why);
  setTimeout(() => process.exit(code), 5000).unref();  // never hang on a browser that will not close
  shutdown().catch(() => {}).finally(() => process.exit(code));
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => die(128 + osConstants.signals[sig], `\naerial e2e: ${sig} — closing the browser and the server, removing the fixtures`));
// With no 'unhandledRejection' listener Node raises an unhandled rejection here too (--unhandled-rejections=throw,
// the default), so a throwing top-level await lands here as well as a synchronous throw.
process.on('uncaughtException', (err) => die(1, `\naerial e2e: harness error — ${(err && err.stack) || err}`));

/* ---------- 1. preconditions: ffmpeg, Playwright ---------- */
{
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) skip('ffmpeg is not on PATH (needed to synthesise the HLS/WebM/Opus fixtures)');
}
async function importPlaywright() {
  const candidates = [];
  if (process.env.AERIAL_E2E_PLAYWRIGHT) candidates.push(process.env.AERIAL_E2E_PLAYWRIGHT);
  candidates.push(join(ROOT, 'apexvip-web', 'node_modules', 'playwright', 'index.mjs'));
  candidates.push('playwright');
  const errors = [];
  for (const c of candidates) {
    const spec = c.startsWith('/') ? pathToFileURL(c).href : c;
    if (c.startsWith('/') && !existsSync(c)) { errors.push(`${c}: not found`); continue; }
    try { const mod = await import(spec); if (mod.chromium) return { chromium: mod.chromium, from: c }; errors.push(`${c}: no chromium export`); }
    catch (e) { errors.push(`${c}: ${String(e && e.message || e).split('\n')[0]}`); }
  }
  return { error: errors.join('; ') };
}
const PW = await importPlaywright();
if (!PW.chromium) skip(`Playwright could not be imported (${PW.error})`);

/* ---------- 2. fixtures ---------- */
FX = mkdtempSync(join(tmpdir(), 'aerial-e2e-'));     // removed by the 'exit' hook above, whatever happens from here on
const ffmpeg = (args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { encoding: 'utf8', cwd: FX });
  if (r.error) return { ok: false, err: String(r.error.message) };
  if (r.status !== 0) return { ok: false, err: (r.stderr || '').trim().split('\n').slice(-3).join(' | ') || `exit ${r.status}` };
  return { ok: true };
};
const SRC = (w, h) => ['-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=25`, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '6'];
const X264 = (kbps) => ['-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-pix_fmt', 'yuv420p', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0', '-b:v', `${kbps}k`];
const VP9 = (kbps) => ['-c:v', 'libvpx-vp9', '-b:v', `${kbps}k`, '-deadline', 'realtime', '-cpu-used', '8', '-g', '50', '-keyint_min', '50', '-pix_fmt', 'yuv420p'];
const HLS = (type) => ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', type];
const FIXTURES = {
  ts: () => { mkdirSync(join(FX, 'ts')); return ffmpeg([...SRC(320, 180), ...X264(500), '-c:a', 'aac', '-b:a', '64k', ...HLS('mpegts'), '-hls_segment_filename', 'ts/seg%03d.ts', 'ts/index.m3u8']); },
  fmp4: () => { mkdirSync(join(FX, 'fmp4')); return ffmpeg([...SRC(320, 180), ...X264(500), '-c:a', 'aac', '-b:a', '64k', ...HLS('fmp4'), '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'fmp4/seg%03d.m4s', 'fmp4/index.m3u8']); },
  low: () => { mkdirSync(join(FX, 'low')); return ffmpeg([...SRC(160, 90), ...X264(150), '-c:a', 'aac', '-b:a', '32k', ...HLS('mpegts'), '-hls_segment_filename', 'low/seg%03d.ts', 'low/index.m3u8']); },
  vp9: () => { mkdirSync(join(FX, 'vp9')); return ffmpeg([...SRC(320, 180), ...VP9(400), '-c:a', 'libopus', '-b:a', '64k', ...HLS('fmp4'), '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'vp9/seg%03d.m4s', 'vp9/index.m3u8']); },
  vp9low: () => { mkdirSync(join(FX, 'vp9low')); return ffmpeg([...SRC(160, 90), ...VP9(120), '-c:a', 'libopus', '-b:a', '32k', ...HLS('fmp4'), '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'vp9low/seg%03d.m4s', 'vp9low/index.m3u8']); },
  webm: () => ffmpeg([...SRC(320, 180), ...VP9(400), '-c:a', 'libopus', '-b:a', '64k', '-f', 'webm', 'direct.webm']),
  opus: () => ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '6', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg', 'radio.ogg']),
};
const fixtureResult = {};
for (const [name, make] of Object.entries(FIXTURES)) fixtureResult[name] = make();
if (fixtureResult.ts.ok && fixtureResult.low.ok) {
  // (c) hand-written master: the 320x180 TS rendition at 500 kbps and the 160x90 one at 150 kbps.
  writeFileSync(join(FX, 'master.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=500000,AVERAGE-BANDWIDTH=480000,RESOLUTION=320x180,FRAME-RATE=25.000,CODECS="avc1.42c01e,mp4a.40.2"', 'ts/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=150000,AVERAGE-BANDWIDTH=140000,RESOLUTION=160x90,FRAME-RATE=25.000,CODECS="avc1.42c01e,mp4a.40.2"', 'low/index.m3u8',
    '',
  ].join('\n'));
}
if (fixtureResult.vp9.ok && fixtureResult.vp9low.ok) {
  // (d) the VP9/Opus master: the only master open-source Chromium can play, so the only one whose variant choice
  // and ABR are verified for real there (the H.264 master above is codec-limited in that browser).
  writeFileSync(join(FX, 'master-vp9.m3u8'), [
    '#EXTM3U', '#EXT-X-VERSION:7',
    `#EXT-X-STREAM-INF:BANDWIDTH=480000,AVERAGE-BANDWIDTH=460000,RESOLUTION=320x180,FRAME-RATE=25.000,CODECS="${VP9_CODECS}"`, 'vp9/index.m3u8',
    `#EXT-X-STREAM-INF:BANDWIDTH=160000,AVERAGE-BANDWIDTH=150000,RESOLUTION=160x90,FRAME-RATE=25.000,CODECS="${VP9_CODECS}"`, 'vp9low/index.m3u8',
    '',
  ].join('\n'));
}
// sanity: the fixtures look like what the cases assume
const readText = (p) => readFileSync(p, 'utf8');
if (fixtureResult.ts.ok) assert.ok(/#EXT-X-ENDLIST/.test(readText(join(FX, 'ts', 'index.m3u8'))) && existsSync(join(FX, 'ts', 'seg002.ts')), 'TS VOD has 3 segments and ENDLIST');
if (fixtureResult.fmp4.ok) assert.ok(/#EXT-X-MAP:URI="init\.mp4"/.test(readText(join(FX, 'fmp4', 'index.m3u8'))), 'fMP4 VOD carries EXT-X-MAP');
if (fixtureResult.vp9.ok) assert.ok(/#EXT-X-MAP:URI="init\.mp4"/.test(readText(join(FX, 'vp9', 'index.m3u8'))) && existsSync(join(FX, 'vp9', 'seg002.m4s')), 'VP9 VOD carries EXT-X-MAP and has 3 segments');
if (fixtureResult.vp9low.ok) assert.ok(/#EXT-X-MAP:URI="init\.mp4"/.test(readText(join(FX, 'vp9low', 'index.m3u8'))), 'VP9 low rendition carries EXT-X-MAP');

/* ---------- 3. the server ---------- */
const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/mp4', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.aac': 'audio/aac',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const LIVE_WINDOW = 3, LIVE_SEG_SEC = 2, LIVE_LOOP = 3;      // the 6 s fixtures have 3 segments of 2 s
const LIVE = {                                                 // url prefix → the fixture whose segments the window slides over
  '/live': { dir: 'ts', ext: 'ts', map: null, version: 3 },               // H.264/AAC MPEG-TS: codec-limited in open-source Chromium
  '/live-vp9': { dir: 'vp9', ext: 'm4s', map: 'init.mp4', version: 7 },   // VP9/Opus fMP4 + EXT-X-MAP: plays wherever MSE does
};
const liveStartedAt = Date.now();
function livePlaylist(now, kind) {
  const seq0 = Math.floor((now - liveStartedAt) / (LIVE_SEG_SEC * 1000));
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${kind.version}`, `#EXT-X-TARGETDURATION:${LIVE_SEG_SEC}`, `#EXT-X-MEDIA-SEQUENCE:${seq0}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${seq0 > 0 ? Math.floor((seq0 - 1) / LIVE_LOOP) : 0}`];
  if (kind.map) lines.push(`#EXT-X-MAP:URI="${kind.map}"`);
  for (let seq = seq0; seq < seq0 + LIVE_WINDOW; seq++) {
    if (seq > 0 && seq % LIVE_LOOP === 0) lines.push('#EXT-X-DISCONTINUITY');   // the 6 s fixture wraps: timestamps restart
    lines.push(`#EXTINF:${LIVE_SEG_SEC}.000000,`, `seg${seq}.${kind.ext}`);
  }
  return lines.join('\n') + '\n';                                                 // no ENDLIST: it is live
}
function baseHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', Expires: '0', 'Accept-Ranges': 'bytes',
  }, extra || {});
}
function sendText(res, status, body, type) {
  res.writeHead(status, baseHeaders({ 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }));
  res.end(body);
}
function sendFile(req, res, file) {
  let st;
  try { st = statSync(file); } catch { return sendText(res, 404, `not found: ${req.url}\n`); }
  if (st.isDirectory()) { file = join(file, 'index.html'); try { st = statSync(file); } catch { return sendText(res, 404, `not found: ${req.url}\n`); } }
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  const size = st.size;
  let start = 0, end = size - 1, status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] !== '' || range[2] !== '')) {
    if (range[1] === '') { start = Math.max(0, size - Number(range[2])); }          // suffix: last N bytes
    else { start = Number(range[1]); end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1); }
    if (start >= size || start > end) {
      res.writeHead(416, baseHeaders({ 'Content-Range': `bytes */${size}` })); return res.end();
    }
    status = 206;
  }
  const headers = baseHeaders({ 'Content-Type': type, 'Content-Length': size === 0 ? 0 : end - start + 1 });
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}
function safeJoin(root, urlPath) {
  const p = resolve(root, '.' + decodeURIComponent(urlPath).replace(/\\/g, '/'));
  return (p === root || p.startsWith(root + sep)) ? p : null;
}
server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'OPTIONS') { res.writeHead(204, baseHeaders()); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed\n');
  const path = url.pathname;
  const m = /^(\/live(?:-vp9)?)\/(index\.m3u8|init\.mp4|seg(\d+)\.(ts|m4s))$/.exec(path);
  if (m) {
    const kind = LIVE[m[1]];
    if (m[2] === 'index.m3u8') return sendText(res, 200, livePlaylist(Date.now(), kind), TYPES['.m3u8']);
    if (m[2] === 'init.mp4') return kind.map ? sendFile(req, res, join(FX, kind.dir, kind.map)) : sendText(res, 404, `not found: ${req.url}\n`);
    if (m[4] !== kind.ext) return sendText(res, 404, `not found: ${req.url}\n`);
    return sendFile(req, res, join(FX, kind.dir, `seg${String(Number(m[3]) % LIVE_LOOP).padStart(3, '0')}.${kind.ext}`));
  }
  let file = null;
  if (path.startsWith('/fx/')) file = safeJoin(FX, path.slice(3));
  else if (path === '/aerial' || path.startsWith('/aerial/')) file = safeJoin(AERIAL_ROOT, path.slice('/aerial'.length) || '/');
  else file = safeJoin(ROOT, path);
  if (!file) return sendText(res, 403, 'forbidden\n');
  sendFile(req, res, file);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ---------- 4. the browser ---------- */
function discoverChromiums() {
  const found = [];
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.env.AERIAL_E2E_CHROMIUM) found.push({ label: 'AERIAL_E2E_CHROMIUM', exe: process.env.AERIAL_E2E_CHROMIUM });
  if (!dir || !existsSync(dir)) return found;
  const builds = [];
  for (const name of readdirSync(dir)) {
    let m = /^chromium-(\d+)$/.exec(name);
    if (m) { for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) builds.push({ n: Number(m[1]), full: 1, exe: join(dir, name, rel), label: `bundled chromium (${name})` }); }
    m = /^chromium_headless_shell-(\d+)$/.exec(name);
    if (m) { for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-linux/chrome-headless-shell', 'chrome-headless-shell-mac/chrome-headless-shell', 'chrome-headless-shell-win/chrome-headless-shell.exe']) builds.push({ n: Number(m[1]), full: 0, exe: join(dir, name, rel), label: `bundled chromium (${name})` }); }
  }
  builds.sort((a, b) => b.n - a.n || b.full - a.full);
  for (const b of builds) if (existsSync(b.exe)) found.push({ label: b.label, exe: b.exe });
  return found;
}
async function launchBrowser() {
  const attempts = [{ label: 'bundled chromium', opts: {} }];
  for (const c of discoverChromiums()) attempts.push({ label: c.label, opts: { executablePath: c.exe } });
  attempts.push({ label: 'chrome', opts: { channel: 'chrome' } });
  const errors = [];
  for (const a of attempts) {
    try {
      // Signals are handled by die() above (which also closes the server and removes the fixtures), not by
      // Playwright's own handlers, which would exit the process before that cleanup ran.
      const browser = await PW.chromium.launch({ headless: true, args: CHROMIUM_ARGS, timeout: 30000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, ...a.opts });
      return { browser, label: a.label };
    } catch (e) { errors.push(`${a.label}: ${String(e && e.message || e).split('\n')[0]}`); }
  }
  return { error: errors.join('; ') };
}
const launched = await launchBrowser();
if (!launched.browser) { await shutdown(); skip(`no browser could be launched (${launched.error})`); }
browser = launched.browser;
context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 420, height: 800 } });
const probe = await (async () => {
  const page = await context.newPage();
  try {
    return await page.evaluate(([h264, vp9]) => ({
      ua: navigator.userAgent,
      mse: typeof MediaSource !== 'undefined',
      h264: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(h264),
      vp9: typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(vp9),
      webm: document.createElement('video').canPlayType('video/webm; codecs="vp9,opus"'),
      ogg: document.createElement('audio').canPlayType('audio/ogg; codecs="opus"'),
    }), [H264_MSE, VP9_MSE]);
  } finally { await page.close(); }
})();
const codecLimited = !probe.h264;
console.log(`aerial e2e: ${BASE} serving ${AERIAL_ROOT === join(ROOT, 'aerial') ? 'aerial/' : AERIAL_ROOT} as /aerial/, fixtures in ${FX}`);
console.log(`  browser: ${launched.label} — ${probe.ua.replace(/^Mozilla\/5\.0 /, '')} (playwright from ${PW.from})`);
console.log(`  codecs: MSE ${probe.mse ? 'yes' : 'NO'} · H.264/AAC ${probe.h264 ? 'yes' : 'NO → H.264 HLS cases judged codec-limited'} · VP9/Opus fMP4 ${probe.vp9 ? 'yes' : 'NO'} · webm "${probe.webm}" · ogg/opus "${probe.ogg}"`);

/* ---------- 5. the cases ---------- */
const CASES = [
  { id: 'hls-ts', label: 'HLS VOD · MPEG-TS segments (H.264/AAC)', url: `${BASE}/fx/ts/index.m3u8`, h264: true, needs: ['ts'] },
  { id: 'hls-fmp4', label: 'HLS VOD · fMP4 segments + EXT-X-MAP (H.264/AAC)', url: `${BASE}/fx/fmp4/index.m3u8`, h264: true, needs: ['fmp4'] },
  { id: 'hls-master', label: 'HLS master · 320x180@500k + 160x90@150k (H.264/AAC TS)', url: `${BASE}/fx/master.m3u8`, h264: true, master: true, needs: ['ts', 'low'] },
  { id: 'hls-vp9', label: 'HLS VOD · fMP4 segments + EXT-X-MAP (VP9/Opus)', url: `${BASE}/fx/vp9/index.m3u8`, needs: ['vp9'] },
  { id: 'hls-master-vp9', label: 'HLS master · 320x180@480k + 160x90@160k (VP9/Opus fMP4)', url: `${BASE}/fx/master-vp9.m3u8`, master: true, needs: ['vp9', 'vp9low'] },
  { id: 'webm', label: 'direct WebM file (VP9/Opus)', url: `${BASE}/fx/direct.webm`, needs: ['webm'] },
  { id: 'opus', label: 'direct Opus .ogg (radio-style audio)', url: `${BASE}/fx/radio.ogg`, needs: ['opus'] },
  { id: 'hls-live', label: 'HLS live · sliding 3-segment window, no ENDLIST (H.264/AAC TS)', url: `${BASE}/live/index.m3u8`, h264: true, live: true, needs: ['ts'] },
  { id: 'hls-live-vp9', label: 'HLS live · sliding 3-segment window, no ENDLIST (VP9/Opus fMP4)', url: `${BASE}/live-vp9/index.m3u8`, live: true, needs: ['vp9'] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtRanges = (b) => b.map(([s, e]) => `${s.toFixed(1)}–${e.toFixed(1)}`).join(',');
// "Names the decoder": the message says the browser cannot decode / lacks the codec AND names the codec id the
// stream carries — avc1.PPCCLL (from the SPS the TS demuxer parsed, the init segment or the master's CODECS) or
// mp4a.40.x for AAC. A generic "codec" or parse error does not qualify: only a stream that reached the codec
// check with its real codec ids does.
const namesDecoder = (msg) => /decod|codec/i.test(msg) && /\bavc1\.[0-9a-f]{6}\b|\bmp4a\.40\.\d+\b/i.test(msg);

// Read the contract object from the page; null until the UI has exposed it.
const SNAPSHOT = () => {
  const a = window.__aerial;
  if (!a || typeof a !== 'object') return null;
  const safe = (f) => { try { return typeof f === 'function' ? f() : f; } catch (e) { return `throws: ${e && e.message}`; } };
  const ranges = (b) => {
    if (!b) return [];
    if (Array.isArray(b)) return b.map((r) => Array.isArray(r) ? [Number(r[0]), Number(r[1])] : [Number(r.start), Number(r.end)]);
    if (typeof b.length === 'number' && typeof b.start === 'function') { const o = []; for (let i = 0; i < b.length; i++) o.push([b.start(i), b.end(i)]); return o; }
    return [];
  };
  const t = safe(a.currentTime);
  return {
    status: a.status, error: a.error == null ? null : String(a.error), strategy: a.strategy == null ? null : String(a.strategy),
    variantIndex: a.variantIndex, variantType: typeof a.variantIndex,
    t: typeof t === 'number' && isFinite(t) ? t : (typeof t === 'string' ? t : null),
    buffered: ranges(safe(a.buffered)), bodyStatus: document.body && document.body.dataset ? document.body.dataset.status : undefined,
  };
};

let screenshotDone = false;
async function runCase(c) {
  const page = await context.newPage();
  const problems = [];
  const note = (s) => { s = String(s).replace(/\s+/g, ' ').slice(0, 240); if (!problems.includes(s)) problems.push(s); };
  // What the page really asked this server for: the evidence a codec-limited verdict is conditioned on.
  const fetched = { playlists: 0, media: 0 };
  page.on('request', (r) => { const u = r.url(); if (!u.startsWith(BASE)) return; if (/\.m3u8(\?|$)/.test(u)) fetched.playlists++; else if (/\.(ts|m4s|mp4)(\?|$)/.test(u)) fetched.media++; });
  page.on('pageerror', (e) => note(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) note(`console: ${m.text()}`); });   // 4xx from our server are noted with their URL below
  page.on('requestfailed', (r) => { if (r.url().startsWith(BASE)) note(`request failed: ${r.method()} ${r.url().slice(BASE.length)} — ${r.failure() && r.failure().errorText}`); });   // the UI's directory calls (radio-browser etc.) are not under test
  page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(BASE)) note(`http ${r.status()}: ${r.url().slice(BASE.length)}`); });
  const t0 = Date.now();
  const timeout = c.live ? LIVE_TIMEOUT_MS : TIMEOUT_MS;
  const result = { pass: false, codecLimited: false, detail: '', snap: null };
  const finish = (pass, detail, extra) => Object.assign(result, { pass, detail }, extra || {});
  try {
    await page.goto(`${BASE}/aerial/index.html#play=${encodeURIComponent(c.url)}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    let prevT = null, incStreak = 0, firstPlayT = null, maxT = -Infinity, lastSnap = null;
    let variantNumeric = false, sawHooks = false, everErrored = null;
    while (Date.now() - t0 < timeout) {
      let s = null;
      try { s = await page.evaluate(SNAPSHOT); } catch (e) { note(`evaluate: ${e.message}`); }
      if (s) {
        sawHooks = true; lastSnap = s; result.snap = s;
        if (s.variantType === 'number' && Number.isFinite(s.variantIndex)) variantNumeric = true;
        if (s.status === 'playing' && firstPlayT === null && typeof s.t === 'number') firstPlayT = s.t;
        if (typeof s.t === 'number') {
          if (prevT !== null && s.t > prevT + 1e-3) incStreak++; else if (prevT !== null && s.t <= prevT) incStreak = 0;
          prevT = s.t; if (s.t > maxT) maxT = s.t;
        }
        if (s.status === 'error') { everErrored = s.error || '(no message)'; break; }
        const advanced = firstPlayT !== null ? maxT - firstPlayT : 0;
        const strict = s.status === 'playing' && typeof s.t === 'number' && s.t > 1.5 && incStreak >= 2 && s.buffered.length > 0;
        if (strict && (!c.live || advanced >= LIVE_MIN_ADVANCE_SEC)) {
          if (c.master && !variantNumeric) { finish(false, `playing but variantIndex is ${s.variantType} (${JSON.stringify(s.variantIndex)}), expected a number`); break; }
          if (s.bodyStatus !== s.status) { finish(false, `document.body.dataset.status is ${JSON.stringify(s.bodyStatus)} while __aerial.status is 'playing'`); break; }
          finish(true, `playing t=${s.t.toFixed(1)}s buffered=[${fmtRanges(s.buffered)}] strategy=${s.strategy}${c.master ? ` variant=${s.variantIndex}` : ''}${c.live ? ` advanced=${advanced.toFixed(1)}s` : ''}`);
          if (!screenshotDone) {
            try { mkdirSync(dirname(SCREENSHOT), { recursive: true }); await page.screenshot({ path: SCREENSHOT }); screenshotDone = true; console.log(`  screenshot: ${SCREENSHOT} (${c.id})`); }
            catch (e) { note(`screenshot failed: ${e.message}`); }
          }
          break;
        }
      }
      await sleep(POLL_MS);
    }
    if (!result.detail) {
      const s = lastSnap;
      const where = s ? `status=${s.status} strategy=${s.strategy} t=${typeof s.t === 'number' ? s.t.toFixed(1) : s.t} buffered=[${fmtRanges(s.buffered)}]` : 'window.__aerial never appeared';
      if (!sawHooks) finish(false, `window.__aerial never appeared within ${secs(timeout)}`);
      else if (everErrored !== null) {
        // Codec-limited (H.264/AAC in a browser without that decoder): the one accepted outcome is an error that names
        // the decoder, reached after the page really fetched the stream from this server — the playlist, and for a
        // media playlist a segment or init too (the master is rejected from its CODECS attributes before any media
        // is fetched). It is reported as codec-limited, never as a pass: it proves the player got as far as the
        // codec check, nothing about playback.
        const relaxed = codecLimited && c.h264;
        const fetchedEnough = fetched.playlists >= 1 && (c.master || fetched.media >= 1);
        if (relaxed && namesDecoder(everErrored) && fetchedEnough) finish(true, `codec-limited: fetched ${fetched.playlists} playlist(s) + ${fetched.media} media file(s), then the player named the missing decoder: "${everErrored}"`, { codecLimited: true });
        else if (relaxed && namesDecoder(everErrored)) finish(false, `error names the decoder but the page fetched nothing first (playlists=${fetched.playlists}, media=${fetched.media}): "${everErrored}"`);
        else finish(false, `status 'error': ${everErrored} (${where})`);
      } else if (s.status === 'loading') finish(false, `stalled in 'loading' for ${secs(timeout)} (${where})`);
      else if (s.status === 'playing') finish(false, c.live ? `playing but currentTime advanced only ${(firstPlayT === null ? 0 : maxT - firstPlayT).toFixed(1)}s of the ${LIVE_MIN_ADVANCE_SEC}s required in ${secs(timeout)} (${where})` : `status 'playing' but currentTime did not advance past 1.5 s with non-empty buffered within ${secs(timeout)} (${where})`);
      else finish(false, `never reached 'playing' within ${secs(timeout)} (${where})`);
    }
  } catch (e) {
    finish(false, `harness error: ${e.message.split('\n')[0]}`);
  } finally {
    await page.close().catch(() => {});
  }
  result.ms = Date.now() - t0;
  result.problems = problems;
  return result;
}

/* ---------- 6. run ---------- */
let passed = 0, limited = 0, failed = 0, skipped = 0;
const t0 = Date.now();
for (const c of CASES) {
  const missing = c.needs.filter((n) => !fixtureResult[n].ok);
  if (missing.length) {
    skipped++;
    console.log(`  - ${c.id.padEnd(14)} ${c.label}\n      [skip] ffmpeg could not build fixture ${missing.join(', ')}: ${missing.map((n) => fixtureResult[n].err).join(' / ')}`);
    continue;
  }
  const r = await runCase(c);
  const noted = (n, head) => r.problems.length ? `\n      ${head}:\n        ${r.problems.slice(0, n).join('\n        ')}${r.problems.length > n ? `\n        … ${r.problems.length - n} more` : ''}` : '';
  if (r.pass && r.codecLimited) { limited++; console.log(`  ~ ${c.id.padEnd(14)} ${c.label} — ${r.detail} (${secs(r.ms)})${noted(4, 'page errors (non-fatal)')}`); }
  else if (r.pass) { passed++; console.log(`  ✓ ${c.id.padEnd(14)} ${c.label} — ${r.detail} (${secs(r.ms)})${noted(4, 'page errors (non-fatal)')}`); }
  else { failed++; console.error(`  ✗ ${c.id.padEnd(14)} ${c.label} — ${r.detail} (${secs(r.ms)})${noted(8, 'page errors')}`); }
}
const ran = passed + limited + failed;
if (ran === 0) { await shutdown(); skip('no case could run: ffmpeg built none of the fixtures'); }
console.log(`\naerial e2e: ${passed} passed, ${limited} codec-limited, ${failed} failed (of ${ran}${skipped ? `, ${skipped} skipped` : ''}; ${Date.now() - t0} ms)`);
if (limited) console.log('  codec-limited: this browser has no H.264/AAC decoder, so those cases only prove the player fetched the stream and named the missing codec; the VP9/Opus cases carry the real play / master / live verdicts.');
await shutdown();
process.exit(failed ? 1 : 0);

async function shutdown() {
  const ctx = context, br = browser, srv = server;
  context = null; browser = null; server = null;
  try { if (ctx) await ctx.close(); } catch { /* already gone */ }
  try { if (br) await br.close(); } catch { /* already gone */ }
  if (srv) {
    const closed = new Promise((r) => srv.close(() => r()));
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();   // keep-alive sockets would otherwise hold close() open
    await closed;
  }
  removeFixtures();
}

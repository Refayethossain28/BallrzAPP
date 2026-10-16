#!/usr/bin/env node
/**
 * Unit tests for the HLS section of aerial/engine.js — the M3U8 playlist parser
 * (master + media, RFC 8216 and the Apple low-latency extensions), attribute lists,
 * EXT-X-DEFINE substitution, adaptive-bitrate choice, the throughput EWMA, live
 * timing (edge, start, reload, merge), buffer planning, gap jumping, key IVs and
 * audio rendition selection. Every fixture is an inline string.
 * Run: node scripts/_parts/assemble.mjs && node scripts/_parts/test-hls.mjs
 */
import { loadEngine, runner, deepEq } from './harness.mjs';

const E = loadEngine();
const { test, run, assert } = runner('hls');
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const approx = (a, b, m, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${m}: ${a} ≠ ${b}`);
const bytes = u8 => Array.from(u8);
const noThrow = (fn, m) => { let r; assert.doesNotThrow(() => { r = fn(); }, m); return r; };

/* ================= fixtures ================= */
const MASTER_URL = 'https://cdn.example.com/aerial/master.m3u8';
const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="Aerial demo",LANGUAGE="en"
#EXT-X-SESSION-DATA:DATA-ID="com.example.credits",URI="meta/credits.json"
#EXT-X-SESSION-KEY:METHOD=AES-128,URI="keys/session.key"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="a1/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="Français",LANGUAGE="fr",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="a2/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="Commentary",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=NO,CHANNELS="2",URI="a4/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud2",NAME="Surround",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6/JOC",URI="a3/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="s1/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc1",NAME="CC",LANGUAGE="en",INSTREAM-ID="CC1"

# the variants are deliberately not in bandwidth order
#EXT-X-STREAM-INF:BANDWIDTH=2177116,AVERAGE-BANDWIDTH=2000000,CODECS="avc1.640020,mp4a.40.2",RESOLUTION=960x540,FRAME-RATE=60.000,AUDIO="aud1",SUBTITLES="sub1",CLOSED-CAPTIONS="cc1"
v5/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=520929,AVERAGE-BANDWIDTH=500000,CODECS="avc1.42c00d,mp4a.40.2",RESOLUTION=416x234,FRAME-RATE=29.970,AUDIO="aud1",SUBTITLES="sub1"
v1/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1031000,AVERAGE-BANDWIDTH=1000000,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=29.970,AUDIO="aud1",SUBTITLES="sub1"
v2/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4523000,AVERAGE-BANDWIDTH=4500000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=60.000,AUDIO="aud1",SUBTITLES="sub1"
v6/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8102000,AVERAGE-BANDWIDTH=8000000,CODECS="hvc1.2.4.L123.B0,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60.000,VIDEO-RANGE=PQ,AUDIO="aud2",SUBTITLES="sub1"
v8/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=128000,AVERAGE-BANDWIDTH=125000,CODECS="mp4a.40.2",AUDIO="aud1"
a1/prog_index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=200000,CODECS="avc1.640020",RESOLUTION=960x540,URI="v5/iframe_index.m3u8"
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=450000,CODECS="avc1.64001f",RESOLUTION=1280x720,URI="v6/iframe_index.m3u8"
`;

const FMP4_URL = 'https://cdn.example.com/vod/fmp4/prog_index.m3u8';
const FMP4 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"
#EXTINF:6.00000,
#EXT-X-BYTERANGE:400000@720
main.mp4
#EXTINF:6.00000,
#EXT-X-BYTERANGE:350000
main.mp4
#EXTINF:3.50000,
#EXT-X-BYTERANGE:150000
main.mp4
#EXT-X-ENDLIST
`;

const TS_URL = 'https://media.example.com/vod/ts/index.m3u8';
const TS_VOD = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1.key"
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
seg1.ts
#EXT-X-DISCONTINUITY
#EXT-X-KEY:METHOD=AES-128,URI="k2.key",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:5.005,Advert, with a comma
ad0.ts
#EXT-X-DISCONTINUITY
#EXT-X-KEY:METHOD=NONE
#EXTINF:9.009,
seg2.ts
#EXT-X-ENDLIST
`;

const LIVE_URL = 'https://live.example.com/ch1/index.m3u8';
const liveFixture = (mediaSequence, count, extra = '') => {
  let s = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n${extra}`;
  for (let i = 0; i < count; i++) s += `#EXTINF:6.000,\nseg${mediaSequence + i}.ts\n`;
  return s;
};
const LIVE1 = liveFixture(100, 5);
const LIVE2 = liveFixture(102, 5);
const LIVE3 = liveFixture(101, 5);

const LL_URL = 'https://ll.example.com/1M/index.m3u8';
const LLHLS = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:4
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.0,CAN-SKIP-UNTIL=24.0,HOLD-BACK=12
#EXT-X-PART-INF:PART-TARGET=0.5
#EXT-X-MEDIA-SEQUENCE:266
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.00008,
fileSequence266.mp4
#EXTINF:4.00008,
fileSequence267.mp4
#EXT-X-PART:DURATION=0.50000,URI="filePart268.0.mp4",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.50000,URI="filePart268.1.mp4"
#EXTINF:4.00008,
fileSequence268.mp4
#EXT-X-PART:DURATION=0.50000,URI="filePart269.0.mp4",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.50000,URI="filePart269.1.mp4"
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="filePart269.2.mp4"
#EXT-X-RENDITION-REPORT:URI="../2M/index.m3u8",LAST-MSN=268,LAST-PART=1
`;

const DEFINE_URL = 'https://example.com/live/index.m3u8?session=xyz&other=1';
const DEFINE = `#EXTM3U
#EXT-X-DEFINE:NAME="host",VALUE="https://cdn.example.com"
#EXT-X-DEFINE:NAME="token",VALUE="abc123"
#EXT-X-DEFINE:QUERYPARAM="session"
#EXT-X-DEFINE:QUERYPARAM="absent"
#EXT-X-DEFINE:IMPORT="missing"
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=AES-128,URI="{$host}/key?token={$token}"
#EXTINF:6,
{$host}/seg1.ts?s={$session}
#EXTINF:6,
{$host}/seg2.ts?x={$missing}
#EXTINF:6,
{$host}/seg3.ts?x={$undefined}
#EXT-X-ENDLIST
`;

const PDT_URL = 'https://example.com/pdt/index.m3u8';
const PDT = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-PROGRAM-DATE-TIME:2026-10-16T12:00:00.000Z
#EXTINF:6,
a.ts
#EXTINF:4.5,
b.ts
#EXT-X-DISCONTINUITY
#EXTINF:6,
c.ts
#EXT-X-PROGRAM-DATE-TIME:2026-10-16T13:00:00+01:00
#EXTINF:6,
d.ts
#EXT-X-PROGRAM-DATE-TIME:not a date
#EXTINF:6,
e.ts
#EXT-X-DATERANGE:ID="ad-1",CLASS="com.example.ad",START-DATE="2026-10-16T12:00:00Z",DURATION=30.0,X-AD-ID="123",SCTE35-OUT=0xFC30
#EXT-X-DATERANGE:CLASS="broken"
#EXT-X-ENDLIST
`;

const MESSY = '﻿\r\n  #EXTM3U  \r\n# a comment\r\n\r\n#EXT-X-TARGETDURATION:8\r\n#ext-x-media-sequence:7\r\n#EXT-X-START:TIME-OFFSET=-12.5,PRECISE=YES\r\n#EXT-X-BITRATE:800\r\n#EXT-X-SOMETHING-NEW:FOO=1\r\n#EXTINF:7.5 ,  Title  \r\n\t seg7.ts \t\r\n#EXT-X-GAP\r\n#EXTINF:7.5\r\nseg8.ts\r\n#EXT-X-DISCONTINUITY\r\n#EXT-X-DISCONTINUITY-SEQUENCE:5\r\nstray.ts\r\n#EXTINF:junk,\r\nseg9.ts\r\n#EXT-X-ENDLIST\r\n';

/* ================= hlsParseAttributes ================= */
test('attributes: quoting, numbers, resolution, codecs, hex', () => {
  const a = E.hlsParseAttributes('BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000,CODECS="avc1.4d401f, mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=29.970,IV=0x0A0B,NAME="x, y",DEFAULT=YES,TIME-OFFSET=-10.5,CHANNELS="2"');
  deepEq(a, { BANDWIDTH: 1280000, 'AVERAGE-BANDWIDTH': 1000000, CODECS: ['avc1.4d401f', 'mp4a.40.2'], RESOLUTION: { width: 1280, height: 720 }, 'FRAME-RATE': 29.97, IV: '0x0A0B', NAME: 'x, y', DEFAULT: 'YES', 'TIME-OFFSET': -10.5, CHANNELS: '2' });
  assert.equal(typeof a.IV, 'string');
  assert.equal(typeof a.CHANNELS, 'string', 'quoted numbers stay strings');
});
test('attributes: tolerant of whitespace, lowercase names, duplicates, missing quote, junk', () => {
  deepEq(E.hlsParseAttributes(' bandwidth = 5 , , name="unterminated'), { BANDWIDTH: 5, NAME: 'unterminated' });
  deepEq(E.hlsParseAttributes('A=1,A=2'), { A: 2 });
  deepEq(E.hlsParseAttributes('novalue,B=x,=3,C='), { B: 'x', C: '' });
  deepEq(E.hlsParseAttributes('RESOLUTION=wide,CODECS=avc1.42c00d'), { RESOLUTION: 'wide', CODECS: ['avc1.42c00d'] });
  deepEq(E.hlsParseAttributes(''), {});
  for (const junk of [null, undefined, 42, {}, [], new Uint8Array(3)]) deepEq(noThrow(() => E.hlsParseAttributes(junk)), {});
});

/* ================= hlsParse: master ================= */
test('master: variants with every attribute, absolute urls, index', () => {
  const m = E.hlsParse(MASTER, MASTER_URL);
  assert.equal(m.kind, 'master');
  deepEq(m.errors, []);
  assert.equal(m.version, 6);
  assert.equal(m.independentSegments, true);
  assert.equal(m.variants.length, 6);
  deepEq(m.variants[0], { uri: 'v5/prog_index.m3u8', url: 'https://cdn.example.com/aerial/v5/prog_index.m3u8', bandwidth: 2177116, averageBandwidth: 2000000, codecs: ['avc1.640020', 'mp4a.40.2'], resolution: { width: 960, height: 540 }, frameRate: 60, audioGroup: 'aud1', subtitlesGroup: 'sub1', name: null, videoRange: null, index: 0 });
  deepEq(m.variants[4].codecs, ['hvc1.2.4.L123.B0', 'mp4a.40.2']);
  assert.equal(m.variants[4].videoRange, 'PQ');
  assert.equal(m.variants[4].audioGroup, 'aud2');
  assert.equal(m.variants[5].resolution, null);
  assert.equal(m.variants[5].frameRate, null);
  deepEq(m.variants.map(v => v.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(m.iFrameStreams, 2);
  assert.equal(m.url, MASTER_URL);
});
test('master: media renditions, session data/key', () => {
  const m = E.hlsParse(MASTER, MASTER_URL);
  assert.equal(m.media.length, 6);
  deepEq(m.media[0], { type: 'AUDIO', groupId: 'aud1', name: 'English', language: 'en', isDefault: true, autoselect: true, forced: false, uri: 'a1/prog_index.m3u8', url: 'https://cdn.example.com/aerial/a1/prog_index.m3u8', channels: 2 });
  assert.equal(m.media[3].channels, 6, 'CHANNELS="6/JOC" → 6');
  assert.equal(m.media[4].type, 'SUBTITLES');
  deepEq([m.media[5].type, m.media[5].uri, m.media[5].url, m.media[5].channels], ['CLOSED-CAPTIONS', null, null, null]);
  deepEq(m.sessionData, [
    { dataId: 'com.example.title', value: 'Aerial demo', uri: null, url: null, language: 'en' },
    { dataId: 'com.example.credits', value: null, uri: 'meta/credits.json', url: 'https://cdn.example.com/aerial/meta/credits.json', language: null }
  ]);
  assert.equal(m.sessionKeys.length, 1);
  assert.equal(m.sessionKeys[0].url, 'https://cdn.example.com/aerial/keys/session.key');
  assert.equal(m.sessionKeys[0].method, 'AES-128');
  deepEq(m.unsupported, []);
});
test('master: STREAM-INF without URI / BANDWIDTH, no variants → invalid', () => {
  const m = E.hlsParse('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-STREAM-INF:CODECS="mp4a.40.2"\nx.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\n', 'https://h/');
  assert.equal(m.kind, 'master');
  assert.equal(m.variants.length, 1);
  assert.equal(m.variants[0].bandwidth, 0);
  assert.ok(m.errors.some(e => /without URI/.test(e)) && m.errors.some(e => /without BANDWIDTH/.test(e)) && m.errors.some(e => /end of playlist/.test(e)), m.errors.join('|'));
  const inv = E.hlsParse('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="x"\n#EXT-X-STREAM-INF:BANDWIDTH=1\n', 'https://h/');
  assert.equal(inv.kind, 'invalid');
  assert.equal(inv.errors[0], 'master playlist has no variants');
});

/* ================= hlsParse: media ================= */
test('media: fMP4 VOD with MAP + BYTERANGE continuation', () => {
  const p = E.hlsParse(FMP4, FMP4_URL);
  assert.equal(p.kind, 'media');
  deepEq(p.errors, []);
  deepEq([p.version, p.targetDuration, p.mediaSequence, p.playlistType, p.endList, p.live, p.independentSegments, p.encrypted], [7, 6, 0, 'VOD', true, false, true, false]);
  assert.equal(p.segments.length, 3);
  deepEq(p.segments.map(s => s.byteRange), [{ offset: 720, length: 400000 }, { offset: 400720, length: 350000 }, { offset: 750720, length: 150000 }]);
  deepEq(p.segments[0].map, { uri: 'main.mp4', url: 'https://cdn.example.com/vod/fmp4/main.mp4', byteRange: { offset: 0, length: 720 } });
  assert.equal(p.segments[2].map, p.segments[0].map, 'map object applies to every following segment');
  deepEq(p.segments.map(s => [s.seq, s.start, s.end]), [[0, 0, 6], [1, 6, 12], [2, 12, 15.5]]);
  approx(p.totalDuration, 15.5, 'totalDuration');
  deepEq(p.segments.map(s => s.url), Array(3).fill('https://cdn.example.com/vod/fmp4/main.mp4'));
  assert.equal(p.segments[0].title, null);
  assert.equal(p.startOffset, null);
});
test('media: byte range without offset and no previous range is an error, not a throw', () => {
  const p = E.hlsParse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n#EXT-X-BYTERANGE:1000\nf.mp4\n#EXT-X-ENDLIST', 'https://h/x.m3u8');
  deepEq(p.segments[0].byteRange, { offset: 0, length: 1000 });
  assert.ok(p.errors.some(e => /no previous byte range/.test(e)), p.errors.join('|'));
  const bad = E.hlsParse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n#EXT-X-BYTERANGE:lots\nf.mp4\n#EXT-X-ENDLIST', 'https://h/x.m3u8');
  assert.equal(bad.segments[0].byteRange, null);
  assert.ok(bad.errors.some(e => /EXT-X-BYTERANGE/.test(e)));
});
test('media: TS VOD with discontinuities and AES-128 keys with/without IV', () => {
  const p = E.hlsParse(TS_VOD, TS_URL);
  deepEq(p.errors, []);
  assert.equal(p.segments.length, 4);
  deepEq(p.segments.map(s => s.discontinuity), [false, false, true, true]);
  deepEq(p.segments.map(s => s.discSeq), [0, 0, 1, 2]);
  deepEq(p.segments.map(s => s.seq), [0, 1, 2, 3]);
  const k0 = p.segments[0].key;
  deepEq([k0.method, k0.uri, k0.url, k0.iv, k0.keyFormat, k0.keyFormatVersions], ['AES-128', 'https://keys.example.com/k1.key', 'https://keys.example.com/k1.key', null, 'identity', '1']);
  assert.equal(p.segments[1].key, k0, 'key object applies until changed');
  const k2 = p.segments[2].key;
  assert.equal(k2.url, 'https://media.example.com/vod/ts/k2.key');
  deepEq(bytes(k2.iv), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(k2.iv.length, 16);
  assert.equal(p.segments[3].key, null, 'METHOD=NONE clears the key');
  assert.equal(p.encrypted, true);
  assert.equal(p.segments[2].title, 'Advert, with a comma');
  approx(p.segments[3].start, 23.023, 'start');
  approx(p.totalDuration, 32.032, 'total');
  deepEq(p.unsupported, []);
});
test('media: SAMPLE-AES, odd IVs and key formats are reported, never thrown', () => {
  const p = E.hlsParse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k",IV=0x1234,KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF:6,\na.ts\n#EXT-X-KEY:METHOD=AES-128,IV=zzz\n#EXTINF:6,\nb.ts\n#EXT-X-KEY:URI="k"\n#EXTINF:6,\nc.ts\n#EXT-X-ENDLIST', 'https://h/p/x.m3u8');
  deepEq(p.unsupported, ['SAMPLE-AES', 'KEYFORMAT com.apple.streamingkeydelivery']);
  const iv = bytes(p.segments[0].key.iv);
  deepEq(iv.slice(0, 14), Array(14).fill(0));
  deepEq(iv.slice(14), [0x12, 0x34], 'short IV is zero-extended');
  assert.ok(p.errors.some(e => /16-bit/.test(e)));
  assert.equal(p.segments[1].key.iv, null);
  assert.equal(p.segments[1].key.url, null);
  assert.ok(p.errors.some(e => /not a hex/.test(e)) && p.errors.some(e => /without URI/.test(e)));
  assert.equal(p.segments[2].key, p.segments[1].key, 'a key tag without METHOD is ignored');
  assert.ok(p.errors.some(e => /without METHOD/.test(e)));
  assert.equal(p.encrypted, true);
});
test('media: live playlist (no ENDLIST) basics', () => {
  const p = E.hlsParse(LIVE1, LIVE_URL);
  deepEq([p.live, p.endList, p.playlistType, p.mediaSequence, p.targetDuration], [true, false, null, 100, 6]);
  deepEq(p.segments.map(s => s.seq), [100, 101, 102, 103, 104]);
  deepEq(p.segments.map(s => s.start), [0, 6, 12, 18, 24]);
  assert.equal(p.totalDuration, 30);
  assert.equal(p.segments[0].url, 'https://live.example.com/ch1/seg100.ts');
});
test('media: LL-HLS parts, hints, reports and server control still yield full segments', () => {
  const p = E.hlsParse(LLHLS, LL_URL);
  assert.equal(p.kind, 'media');
  deepEq(p.errors, []);
  deepEq(p.segments.map(s => [s.seq, s.uri]), [[266, 'fileSequence266.mp4'], [267, 'fileSequence267.mp4'], [268, 'fileSequence268.mp4']]);
  deepEq(p.serverControl, { canSkipUntil: 24, canSkipDateRanges: false, holdBack: 12, partHoldBack: 1, canBlockReload: true });
  deepEq(p.partInf, { partTarget: 0.5 });
  assert.equal(p.partCount, 4);
  deepEq(p.preloadHints, [{ type: 'PART', uri: 'filePart269.2.mp4', url: 'https://ll.example.com/1M/filePart269.2.mp4', byteRangeStart: null, byteRangeLength: null }]);
  deepEq(p.renditionReports, [{ uri: '../2M/index.m3u8', url: 'https://ll.example.com/2M/index.m3u8', lastMsn: 268, lastPart: 1 }]);
  deepEq(p.unsupported, ['EXT-X-PART', 'EXT-X-PRELOAD-HINT']);
  assert.equal(p.segments[0].map.url, 'https://ll.example.com/1M/init.mp4');
  assert.equal(p.live, true);
  approx(p.totalDuration, 12.00024, 'total');
});
test('media: EXT-X-SKIP shifts the first sequence number', () => {
  const p = E.hlsParse('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-SKIP:SKIPPED-SEGMENTS=5\n#EXTINF:4,\na.mp4\n', 'https://h/x.m3u8');
  deepEq([p.skippedSegments, p.segments[0].seq], [5, 15]);
  assert.ok(p.unsupported.includes('EXT-X-SKIP'));
});
test('media: EXT-X-DEFINE substitution (NAME/VALUE, QUERYPARAM, IMPORT, undefined)', () => {
  const p = E.hlsParse(DEFINE, DEFINE_URL);
  assert.equal(p.kind, 'media');
  deepEq(p.variables, { host: 'https://cdn.example.com', token: 'abc123', session: 'xyz' });
  assert.equal(p.segments[0].url, 'https://cdn.example.com/seg1.ts?s=xyz');
  assert.equal(p.segments[0].key.url, 'https://cdn.example.com/key?token=abc123');
  assert.equal(p.segments[1].url, 'https://cdn.example.com/seg2.ts?x={$missing}', 'unknown value is left as written');
  assert.equal(p.segments[2].url, 'https://cdn.example.com/seg3.ts?x={$undefined}');
  deepEq(p.unsupported, ['EXT-X-DEFINE QUERYPARAM', 'EXT-X-DEFINE IMPORT']);
  assert.ok(p.errors.some(e => /QUERYPARAM="absent"/.test(e)) && p.errors.some(e => /IMPORT="missing"/.test(e)) && p.errors.some(e => /undefined variable \{\$undefined\}/.test(e)), p.errors.join('|'));
  const withVars = E.hlsParse(DEFINE, DEFINE_URL, { variables: { missing: 'm' } });
  assert.equal(withVars.segments[1].url, 'https://cdn.example.com/seg2.ts?x=m', 'master variables satisfy IMPORT');
  assert.ok(!withVars.unsupported.includes('EXT-X-DEFINE IMPORT'));
  const redefine = E.hlsParse('#EXTM3U\n#EXT-X-DEFINE:NAME="a",VALUE="1"\n#EXT-X-DEFINE:NAME="a",VALUE="2"\n#EXT-X-DEFINE:NAME="bad name",VALUE="x"\n#EXT-X-DEFINE:VALUE="x"\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n{$a}.ts\n', 'https://h/');
  assert.equal(redefine.segments[0].uri, '1.ts');
  assert.equal(redefine.errors.filter(e => /EXT-X-DEFINE/.test(e)).length, 3);
});
test('media: PROGRAM-DATE-TIME propagation and DATERANGE', () => {
  const p = E.hlsParse(PDT, PDT_URL);
  const t0 = Date.UTC(2026, 9, 16, 12, 0, 0);
  deepEq(p.segments.map(s => s.programDateTime), [t0, t0 + 6000, t0 + 10500, t0, t0 + 6000], 'explicit tags reset the chain; durations extend it; invalid tag keeps the chain');
  assert.ok(p.errors.some(e => /ISO 8601/.test(e)));
  assert.equal(p.dateRanges.length, 1);
  deepEq(p.dateRanges[0], { id: 'ad-1', class: 'com.example.ad', startDate: t0, endDate: null, duration: 30, plannedDuration: null, endOnNext: false, attrs: { 'X-AD-ID': '123', 'SCTE35-OUT': '0xFC30' } });
  assert.ok(p.errors.some(e => /EXT-X-DATERANGE without ID/.test(e)));
  const none = E.hlsParse(LIVE1, LIVE_URL);
  deepEq(none.segments.map(s => s.programDateTime), [null, null, null, null, null]);
});
test('media: relative, absolute, scheme-relative, root-relative and dotted URLs', () => {
  const p = E.hlsParse('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nseg.ts\n#EXTINF:1,\nhttps://other.com/x.ts\n#EXTINF:1,\n//cdn.example.com/y.ts\n#EXTINF:1,\n/abs/z.ts\n#EXTINF:1,\n../up/w.ts\n#EXTINF:1,\n?only=query\n#EXT-X-ENDLIST', 'https://example.com/a/b/index.m3u8?tok=1');
  deepEq(p.segments.map(s => s.url), ['https://example.com/a/b/seg.ts', 'https://other.com/x.ts', 'https://cdn.example.com/y.ts', 'https://example.com/abs/z.ts', 'https://example.com/a/up/w.ts', 'https://example.com/a/b/index.m3u8?only=query']);
  deepEq(p.segments.map(s => s.uri), ['seg.ts', 'https://other.com/x.ts', '//cdn.example.com/y.ts', '/abs/z.ts', '../up/w.ts', '?only=query']);
  const noBase = E.hlsParse('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nseg.ts\n');
  assert.equal(noBase.segments[0].url, 'seg.ts');
  assert.equal(noBase.url, null);
});
test('media: BOM, CRLF, blank lines, comments, whitespace, lowercase tags, GAP, BITRATE, START, unknown tags, bad lines', () => {
  const p = E.hlsParse(MESSY, 'https://h/live/x.m3u8');
  assert.equal(p.kind, 'media');
  deepEq([p.targetDuration, p.mediaSequence, p.discontinuitySequence], [8, 7, 0], 'discontinuity-sequence after a segment is ignored');
  deepEq(p.startOffset, { timeOffset: -12.5, precise: true });
  deepEq(p.segments.map(s => [s.seq, s.uri, s.duration, s.title, s.gap, s.bitrate, s.discontinuity, s.discSeq]), [
    [7, 'seg7.ts', 7.5, 'Title', false, 800000, false, 0],
    [8, 'seg8.ts', 7.5, null, true, 800000, false, 0],
    [9, 'seg9.ts', 8, null, false, 800000, true, 1]
  ]);
  deepEq(p.unknownTags, ['EXT-X-SOMETHING-NEW']);
  assert.ok(p.errors.some(e => /stray\.ts/.test(e)), 'stray URI reported');
  assert.ok(p.errors.some(e => /EXTINF without a duration/.test(e)));
  assert.ok(p.errors.some(e => /must precede the first segment/.test(e)));
  assert.equal(p.errors.filter(e => /EXTM3U/.test(e)).length, 0, 'header after BOM/blank lines is fine');
});
test('media: missing #EXTM3U and missing TARGETDURATION are errors but still parse', () => {
  const p = E.hlsParse('#EXTINF:5,\na.ts\n#EXTINF:7.2,\nb.ts\n#EXT-X-ENDLIST', 'https://h/x.m3u8');
  assert.equal(p.kind, 'media');
  assert.equal(p.segments.length, 2);
  assert.equal(p.targetDuration, 8, 'fallback: ceil of the longest segment');
  assert.ok(p.errors.some(e => /missing #EXTM3U/.test(e)) && p.errors.some(e => /missing EXT-X-TARGETDURATION/.test(e)), p.errors.join('|'));
});
test('media: mixed master/media tags, duplicate version, bad values', () => {
  const p = E.hlsParse('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:abc\n#EXT-X-PLAYLIST-TYPE:LIVE\n#EXT-X-MEDIA-SEQUENCE:x\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n#EXTINF:1,\na.ts\n', 'https://h/x.m3u8');
  assert.equal(p.kind, 'master', 'variants win when both are present');
  assert.equal(p.version, 3);
  assert.ok(p.errors.some(e => /mixes master and media/.test(e)));
  assert.ok(p.errors.some(e => /EXT-X-VERSION appears more than once/.test(e)));
  assert.ok(p.errors.some(e => /EXT-X-TARGETDURATION/.test(e)) && p.errors.some(e => /VOD or EVENT/.test(e)) && p.errors.some(e => /EXT-X-MEDIA-SEQUENCE is not an integer/.test(e)));
});
test('garbage: binary junk, HTML page, empty, non-strings → invalid without throwing', () => {
  const junk = new Uint8Array(4096);
  let s = 12345;
  for (let i = 0; i < junk.length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; junk[i] = s >>> 24; }
  for (const input of [junk, junk.buffer, String.fromCharCode(...junk.slice(0, 1000)), '<!DOCTYPE html>\n<html><body><h1>404 Not Found</h1></body></html>', '', '   \n\n', null, undefined, 42, {}, [], true, '#EXTM3U', '#EXTM3U\n#EXT-X-ENDLIST', '#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n']) {
    const r = noThrow(() => E.hlsParse(input, 'https://h/x.m3u8'), 'parse must not throw');
    assert.equal(r.kind, 'invalid', `kind for ${String(input).slice(0, 20)}`);
    assert.ok(Array.isArray(r.errors) && r.errors.length >= 1);
    assert.ok(r.errors.length <= 52, 'error list is capped');
  }
  const html = E.hlsParse('<html></html>', 'https://h/');
  assert.equal(html.errors[0], 'not an HLS playlist');
  const empty = E.hlsParse('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-ENDLIST', 'https://h/');
  assert.equal(empty.errors[0], 'media playlist has no segments');
  const many = '#EXTM3U\n' + Array.from({ length: 500 }, (_, i) => `line${i}.ts`).join('\n');
  const r = E.hlsParse(many, 'https://h/');
  assert.ok(r.errors.length <= 52 && r.errors.some(e => /more errors/.test(e)), 'overflow note');
});
test('parse: deterministic (same input → identical JSON)', () => {
  for (const [text, url] of [[MASTER, MASTER_URL], [FMP4, FMP4_URL], [TS_VOD, TS_URL], [LIVE1, LIVE_URL], [LLHLS, LL_URL], [DEFINE, DEFINE_URL], [PDT, PDT_URL], [MESSY, 'https://h/']]) {
    assert.equal(JSON.stringify(E.hlsParse(text, url)), JSON.stringify(E.hlsParse(text, url)));
  }
});

/* ================= variants: label, sort, choose ================= */
const V = [
  { bandwidth: 520929, averageBandwidth: 500000, resolution: { width: 416, height: 234 }, frameRate: 29.97, codecs: ['avc1.42c00d', 'mp4a.40.2'] },
  { bandwidth: 1031000, averageBandwidth: 1000000, resolution: { width: 640, height: 360 }, frameRate: 29.97, codecs: ['avc1.4d401e', 'mp4a.40.2'] },
  { bandwidth: 2177116, averageBandwidth: 2000000, resolution: { width: 960, height: 540 }, frameRate: 60, codecs: ['avc1.640020', 'mp4a.40.2'] },
  { bandwidth: 4523000, averageBandwidth: 4500000, resolution: { width: 1280, height: 720 }, frameRate: 60, codecs: ['avc1.64001f', 'mp4a.40.2'] },
  { bandwidth: 8102000, averageBandwidth: 8000000, resolution: { width: 1920, height: 1080 }, frameRate: 60, codecs: ['hvc1.2.4.L123.B0', 'mp4a.40.2'] },
  { bandwidth: 128000, averageBandwidth: 125000, resolution: null, frameRate: null, codecs: ['mp4a.40.2'] }
];
const noHevc = codecs => !codecs.some(c => /^(hvc1|hev1)/.test(c));
const choose = (opts) => E.hlsChooseVariant(V, opts);

test('variant label', () => {
  assert.equal(E.hlsVariantLabel(V[4]), '1080p60 · 8 Mbps');
  assert.equal(E.hlsVariantLabel(V[0]), '234p · 500 kbps');
  assert.equal(E.hlsVariantLabel({ bandwidth: 5200000, resolution: { width: 1920, height: 1080 } }), '1080p · 5.2 Mbps');
  assert.equal(E.hlsVariantLabel(V[5]), 'Audio · 125 kbps');
  assert.equal(E.hlsVariantLabel({ bandwidth: 900000 }), '900 kbps');
  assert.equal(E.hlsVariantLabel({ codecs: ['avc1.42c00d'] }), '–');
  for (const junk of [null, undefined, 'x', 7, {}]) assert.equal(noThrow(() => E.hlsVariantLabel(junk)), '–');
});
test('sort variants ascending by bandwidth, stable, non-mutating', () => {
  const m = E.hlsParse(MASTER, MASTER_URL);
  const before = JSON.stringify(m.variants);
  const sorted = E.hlsSortVariants(m.variants);
  deepEq(sorted.map(v => v.bandwidth), [128000, 520929, 1031000, 2177116, 4523000, 8102000]);
  deepEq(sorted.map(v => v.index), [5, 1, 2, 0, 3, 4]);
  assert.equal(JSON.stringify(m.variants), before);
  deepEq(E.hlsSortVariants([{ bandwidth: 1, name: 'a' }, { bandwidth: 1, name: 'b' }, null, 'x']).map(v => v.name), ['a', 'b']);
  deepEq(E.hlsSortVariants(null), []);
  deepEq(E.hlsSortVariants('nope'), []);
});
test('choose: unknown bandwidth → first guess ≤ 1.5 Mbps, or lowest', () => {
  assert.equal(choose({ bandwidth: null }), 1);
  assert.equal(choose({}), 1);
  assert.equal(choose({ bandwidth: 0 }), 1);
  assert.equal(choose({ bandwidth: NaN }), 1);
  assert.equal(E.hlsChooseVariant([V[3], V[4]], { bandwidth: null }), 0, 'nothing under 1.5 Mbps → lowest');
  assert.equal(choose({ bandwidth: null, current: 3 }), 3, 'no measurement yet → stay put');
  assert.equal(choose({ bandwidth: null, current: 4, supportedCodecs: noHevc }), 1, 'current no longer eligible → fresh pick');
});
test('choose: budget = bandwidth × safety, highest fitting, exact ties and boundaries', () => {
  assert.equal(choose({ bandwidth: 3000000 }), 2, '2.4 Mbps budget → 540p');
  assert.equal(choose({ bandwidth: 2177116 / 0.8 }), 2, 'exactly on the boundary is still ≤');
  assert.equal(choose({ bandwidth: 2177116 / 0.8 - 1 }), 1);
  assert.equal(choose({ bandwidth: 100000 }), 5, 'nothing fits → lowest (audio-only)');
  assert.equal(choose({ bandwidth: 20000000 }), 4);
  assert.equal(choose({ bandwidth: 3000000, safety: 1 }), 2);
  assert.equal(choose({ bandwidth: 3000000, safety: 0.3 }), 0);
  const tied = [{ bandwidth: 1000, name: 'first' }, { bandwidth: 1000, name: 'second' }, { bandwidth: 500 }];
  assert.equal(E.hlsChooseVariant(tied, { bandwidth: 2000 }), 0, 'exact tie → first listed');
  assert.equal(E.hlsChooseVariant([{ bandwidth: 500 }, { bandwidth: 500 }], { bandwidth: 1 }), 0, 'lowest tie → first listed');
});
test('choose: caps (maxHeight, maxBandwidth) never drop below the lowest', () => {
  assert.equal(choose({ bandwidth: 20000000, maxHeight: 540 }), 2);
  assert.equal(choose({ bandwidth: 20000000, maxHeight: 720 }), 3);
  assert.equal(choose({ bandwidth: 20000000, maxBandwidth: 1031000 }), 1);
  assert.equal(choose({ bandwidth: 20000000, maxBandwidth: 1030999 }), 0);
  assert.equal(choose({ bandwidth: 20000000, maxHeight: 100, maxBandwidth: 1 }), 5, 'caps exclude all → lowest (audio-only has no height to cap)');
  assert.equal(E.hlsChooseVariant(V.slice(0, 5), { bandwidth: 20000000, maxHeight: 100 }), 0);
});
test('choose: codec filter removes hevc; a filter that throws or rejects all is survivable', () => {
  assert.equal(choose({ bandwidth: 20000000, supportedCodecs: noHevc }), 3);
  assert.equal(choose({ bandwidth: 20000000, supportedCodecs: () => false }), 4, 'reject-all → treated as unknown support');
  assert.equal(choose({ bandwidth: 20000000, supportedCodecs: () => { throw new Error('boom'); } }), 4);
  assert.equal(E.hlsChooseVariant([{ bandwidth: 100, codecs: [] }, { bandwidth: 200, codecs: ['hvc1'] }], { bandwidth: 10000, supportedCodecs: noHevc }), 0, 'no codecs listed → cannot be rejected');
});
test('choose: up-switch hysteresis with low and high buffer, partial step, immediate down-switch', () => {
  // budget 2.4 Mbps targets 540p (2.177 Mbps) but 2.177 × 1.25 = 2.72 > 2.4 → stay at 360p
  assert.equal(choose({ bandwidth: 3000000, current: 1, bufferedSec: 5 }), 1);
  assert.equal(choose({ bandwidth: 3000000, current: 1, bufferedSec: 20 }), 2, 'a healthy buffer waives the hysteresis');
  assert.equal(choose({ bandwidth: 3000000, current: 1, bufferedSec: 5, upHysteresis: 1 }), 2);
  assert.equal(choose({ bandwidth: 3500000, current: 1, bufferedSec: 5 }), 2, '2.8 Mbps budget ≥ 2.72 → up');
  assert.equal(choose({ bandwidth: 6000000, current: 0, bufferedSec: 5 }), 2, 'budget 4.8 Mbps: 720p needs 5.65, 540p needs 2.72 → step to 540p');
  assert.equal(choose({ bandwidth: 6000000, current: 0, bufferedSec: 25 }), 3);
  assert.equal(choose({ bandwidth: 1000000, current: 3, bufferedSec: 40 }), 0, 'down-switch is immediate regardless of buffer');
  assert.equal(choose({ bandwidth: 3000000, current: 2, bufferedSec: 0 }), 2, 'target == current');
  assert.equal(choose({ bandwidth: 3000000, current: 99, bufferedSec: 0 }), 2, 'bogus current ignored');
  assert.equal(choose({ bandwidth: 3000000, current: 4, supportedCodecs: noHevc }), 2, 'current filtered out → direct pick');
});
test('choose: junk-safe and deterministic', () => {
  assert.equal(E.hlsChooseVariant([], { bandwidth: 1 }), -1);
  assert.equal(E.hlsChooseVariant(null, { bandwidth: 1 }), -1);
  assert.equal(E.hlsChooseVariant('x'), -1);
  assert.equal(E.hlsChooseVariant([null, 'x', { bandwidth: 'high' }], { bandwidth: 1 }), -1);
  assert.equal(E.hlsChooseVariant([null, { bandwidth: 300 }], { bandwidth: 1 }), 1);
  assert.equal(E.hlsChooseVariant(E.hlsParse(MASTER, MASTER_URL), { bandwidth: 3000000 }), 0, 'accepts the master object (960x540 is index 0 there)');
  const opts = { bandwidth: 6000000, current: 0, bufferedSec: 5, supportedCodecs: noHevc, maxHeight: 1080 };
  assert.equal(choose(opts), choose(opts));
});

/* ================= EWMA ================= */
test('ewma: null before the first sample; the first sample is reported as itself', () => {
  const s0 = E.hlsEwmaCreate();
  deepEq([s0.fastHalfLife, s0.slowHalfLife, s0.samples], [3, 9, 0]);
  assert.equal(E.hlsEwmaEstimate(s0), null);
  const s1 = E.hlsEwmaSample(s0, 1000000, 1000);
  approx(E.hlsEwmaEstimate(s1), 8000000, 'one sample of 1 MB/s = 8 Mbps');
  assert.equal(s0.samples, 0, 'input state untouched');
  assert.equal(s1.samples, 1);
});
test('ewma: hand-computed two-sample sequence, min(fast, slow)', () => {
  const hl = (v1, v2, h) => { const a = Math.pow(0.5, 1 / h); return (a * (1 - a) * v1 + (1 - a) * v2) / (1 - a * a); };
  let s = E.hlsEwmaCreate(3, 9);
  s = E.hlsEwmaSample(s, 1000000, 1000);   // 8 Mbps for 1 s
  s = E.hlsEwmaSample(s, 250000, 1000);    // 2 Mbps for 1 s
  const fast = hl(8e6, 2e6, 3), slow = hl(8e6, 2e6, 9);
  assert.ok(fast < slow, 'fast tracks the drop sooner');
  approx(E.hlsEwmaEstimate(s), fast, 'min picks fast after a drop');
  approx(E.hlsEwmaEstimate(s), 4654960.0, 'absolute check: (8e6·a + 2e6)/(1+a), a = 0.5^(1/3)', 1e-6);
  let r = E.hlsEwmaCreate(3, 9);
  r = E.hlsEwmaSample(r, 250000, 1000);
  r = E.hlsEwmaSample(r, 1000000, 1000);
  approx(E.hlsEwmaEstimate(r), hl(2e6, 8e6, 9), 'min picks slow after a rise (conservative)');
});
test('ewma: duration weighting, constant rate stays exact, custom half-lives', () => {
  let s = E.hlsEwmaCreate(2, 6);
  for (const ms of [250, 4000, 100, 12000]) s = E.hlsEwmaSample(s, 500 * ms, ms);   // always 4 Mbps
  approx(E.hlsEwmaEstimate(s), 4000000, 'constant rate');
  let a = E.hlsEwmaCreate(3, 9), b = E.hlsEwmaCreate(3, 9);
  a = E.hlsEwmaSample(E.hlsEwmaSample(a, 1000000, 1000), 125000, 100);    // 10 Mbps for 0.1 s
  b = E.hlsEwmaSample(E.hlsEwmaSample(b, 1000000, 1000), 5000000, 4000);  // 10 Mbps for 4 s
  assert.ok(E.hlsEwmaEstimate(b) > E.hlsEwmaEstimate(a), 'a longer sample moves the estimate further');
  approx(E.hlsEwmaCreate(0.5, 2).fastHalfLife, 0.5, 'custom');
  deepEq([E.hlsEwmaCreate(-1, 'x').fastHalfLife, E.hlsEwmaCreate(-1, 'x').slowHalfLife], [3, 9], 'junk half-lives → defaults');
});
test('ewma: junk samples and junk state are ignored, deterministic', () => {
  const s = E.hlsEwmaSample(E.hlsEwmaCreate(), 1000000, 1000);
  for (const [b, ms] of [[0, 1000], [1000, 0], [-5, 100], [NaN, 100], ['x', 100], [100, -1], [100, Infinity]]) {
    deepEq(E.hlsEwmaSample(s, b, ms), s, `ignored ${b}/${ms}`);
  }
  assert.equal(E.hlsEwmaEstimate(null), null);
  assert.equal(E.hlsEwmaEstimate('x'), null);
  assert.equal(E.hlsEwmaEstimate({ samples: 3 }), null, 'no weight → null');
  approx(E.hlsEwmaEstimate(E.hlsEwmaSample(undefined, 100, 100)), 8000, 'sampling from nothing starts a fresh state');
  assert.equal(JSON.stringify(E.hlsEwmaSample(s, 777, 33)), JSON.stringify(E.hlsEwmaSample(s, 777, 33)));
});

/* ================= live timing ================= */
const live1 = E.hlsParse(LIVE1, LIVE_URL), live2 = E.hlsParse(LIVE2, LIVE_URL), live3 = E.hlsParse(LIVE3, LIVE_URL);
test('live edge and start', () => {
  assert.equal(E.hlsLiveEdge(live1), 30);
  assert.equal(E.hlsLiveStart(live1), 12, 'edge − 3 × target');
  assert.equal(E.hlsLiveStart(live1, { holdBack: 25 }), 5);
  assert.equal(E.hlsLiveStart(live1, { holdBack: 60 }), 0);
  assert.equal(E.hlsLiveStart(live1, { holdBack: 1 }), 12, 'hold-back below 3 × target does not apply');
  const ll = E.hlsParse(LLHLS, LL_URL);
  approx(E.hlsLiveStart(ll), 0.00024, 'server HOLD-BACK=12 beats 3 × 4');
  assert.equal(E.hlsLiveEdge(null), 0);
  assert.equal(E.hlsLiveStart({}), 0);
  assert.equal(E.hlsLiveStart({ segments: [] }), 0);
});
test('reload delay per RFC 8216 §6.3.4', () => {
  assert.equal(E.hlsReloadDelay(null, live1), 6000, 'first load → target duration');
  assert.equal(E.hlsReloadDelay(live1, live1), 3000, 'unchanged → half');
  assert.equal(E.hlsReloadDelay(live1, live2), 6000, 'changed → full');
  const short = E.hlsParse(liveFixture(0, 3).replace('TARGETDURATION:6', 'TARGETDURATION:1'), LIVE_URL);
  assert.equal(E.hlsReloadDelay(short, short), 1000, 'never below 1 s');
  assert.equal(E.hlsReloadDelay(null, null), 1000);
  assert.equal(E.hlsReloadDelay('x', { segments: [{ seq: 1, duration: 4, end: 4 }] }), 4000, 'target falls back to the longest segment');
});
test('merge: advancing reload keeps the timeline continuous', () => {
  const m = E.hlsMerge(live1, live2);
  deepEq([m.stale, m.advanced, m.jumped], [false, 2, false]);
  deepEq(m.segments.map(s => [s.seq, s.start, s.end]), [[102, 12, 18], [103, 18, 24], [104, 24, 30], [105, 30, 36], [106, 36, 42]]);
  assert.equal(E.hlsLiveEdge(m), 42);
  assert.equal(E.hlsLiveStart(m), 24);
  assert.equal(live2.segments[0].start, 0, 'input playlist not mutated');
  assert.equal(m.kind, 'media');
  assert.equal(m.totalDuration, 30);
  const again = E.hlsMerge(m, E.hlsParse(liveFixture(104, 5), LIVE_URL));
  deepEq(again.segments.map(s => s.start), [24, 30, 36, 42, 48]);
  assert.equal(again.advanced, 2);
});
test('merge: stale (backwards) reload is flagged, still anchored', () => {
  const m = E.hlsMerge(live2, live3);
  deepEq([m.stale, m.advanced, m.jumped], [true, 0, false]);
  assert.equal(m.segments[0].seq, 101);
  assert.equal(m.segments[1].start, 0, 'seq 102 keeps the start it had');
  assert.equal(m.segments[0].start, -6, 'the one before it is placed backwards from the anchor');
  const same = E.hlsMerge(live1, live1);
  deepEq([same.stale, same.advanced, same.jumped], [false, 0, false]);
});
test('merge: no shared sequence → anchored at the previous end and flagged jumped', () => {
  const far = E.hlsParse(liveFixture(200, 3), LIVE_URL);
  const m = E.hlsMerge(live1, far);
  deepEq([m.stale, m.advanced, m.jumped], [false, 3, true]);
  deepEq(m.segments.map(s => s.start), [30, 36, 42]);
  const back = E.hlsMerge(far, live1);
  deepEq([back.stale, back.jumped], [true, true]);
  const changed = E.hlsMerge(live1, E.hlsParse(LIVE2.replace('#EXTINF:6.000,\nseg102.ts', '#EXTINF:5.000,\nseg102.ts'), LIVE_URL));
  assert.ok(changed.errors.some(e => /segment 102 changed duration/.test(e)));
});
test('merge: junk-safe', () => {
  const first = E.hlsMerge(null, live1);
  deepEq([first.stale, first.advanced, first.jumped], [false, 5, false]);
  deepEq(first.segments.map(s => s.start), [0, 6, 12, 18, 24]);
  assert.equal(E.hlsMerge(live1, null), null);
  const inv = E.hlsParse('junk');
  assert.equal(E.hlsMerge(live1, inv), inv);
  assert.equal(E.hlsMerge(E.hlsParse(MASTER, MASTER_URL), live2).advanced, 5);
  assert.equal(E.hlsMerge({ segments: [] }, live2).advanced, 5);
});
test('segment at / next segment', () => {
  deepEq([0, 5.999, 6, 29.999, 30, -1, 100, NaN].map(t => E.hlsSegmentAt(live1, t)), [0, 0, 1, 4, -1, -1, -1, -1]);
  const merged = E.hlsMerge(live1, live2);
  deepEq([11.9, 12, 41.9, 42].map(t => E.hlsSegmentAt(merged, t)), [-1, 0, 4, -1]);
  const gappy = { segments: [{ start: 0, end: 0, duration: 0 }, { start: 0, end: 2, duration: 2 }, { start: 2, end: 2, duration: 0 }, { start: 2, end: 4, duration: 2 }] };
  deepEq([0, 1.5, 2, 3.9, 4].map(t => E.hlsSegmentAt(gappy, t)), [1, 1, 3, 3, -1], 'zero-length segments are never "at"');
  assert.equal(E.hlsSegmentAt(null, 1), -1);
  assert.equal(E.hlsSegmentAt({ segments: [] }, 0), -1);
  assert.equal(E.hlsNextSegment(live1, 101).seq, 102);
  assert.equal(E.hlsNextSegment(live1, 104), null);
  assert.equal(E.hlsNextSegment(live1, null).seq, 100);
  assert.equal(E.hlsNextSegment(live1, undefined).seq, 100);
  assert.equal(E.hlsNextSegment(live1, 50).seq, 100, 'fell behind the window → oldest available');
  assert.equal(E.hlsNextSegment(live1, 'x').seq, 100);
  assert.equal(E.hlsNextSegment(null, 1), null);
  assert.equal(E.hlsNextSegment({ segments: [] }, null), null);
});
test('live status: latency grows with time since reload; behind-live and stalled thresholds', () => {
  const st = E.hlsLiveStatus({ playlist: live1, currentTime: 10, now: NOW, lastReloadAt: NOW - 2000 });
  deepEq(st, { latencySec: 22, behindLive: false, stalledPlaylist: false });
  assert.equal(E.hlsLiveStatus({ playlist: live1, currentTime: 0, now: NOW, lastReloadAt: NOW - 2000 }).behindLive, true, '32 s > 18 + 12');
  assert.equal(E.hlsLiveStatus({ playlist: live1, currentTime: 0, now: NOW, lastReloadAt: NOW }).behindLive, false, '30 s is not > 30');
  assert.equal(E.hlsLiveStatus({ playlist: live1, currentTime: 10, now: NOW, lastReloadAt: NOW - 18001 }).stalledPlaylist, true);
  assert.equal(E.hlsLiveStatus({ playlist: live1, currentTime: 10, now: NOW, lastReloadAt: NOW - 18000 }).stalledPlaylist, false);
  assert.equal(E.hlsLiveStatus({ playlist: live1, currentTime: 35, now: NOW, lastReloadAt: NOW }).latencySec, 0, 'never negative');
  deepEq(E.hlsLiveStatus({ playlist: live1, currentTime: 10 }), { latencySec: 20, behindLive: false, stalledPlaylist: false }, 'no clock → no elapsed');
  deepEq(E.hlsLiveStatus({ playlist: E.hlsParse(TS_VOD, TS_URL), currentTime: 1, now: NOW, lastReloadAt: 0 }), { latencySec: 0, behindLive: false, stalledPlaylist: false }, 'VOD');
  deepEq(E.hlsLiveStatus(null), { latencySec: 0, behindLive: false, stalledPlaylist: false });
  deepEq(E.hlsLiveStatus({ playlist: 'x', currentTime: 'y' }), { latencySec: 0, behindLive: false, stalledPlaylist: false });
});

/* ================= buffer plan / gap jump ================= */
test('buffer plan: ranges table', () => {
  const plan = (currentTime, buffered, extra) => E.hlsBufferPlan(Object.assign({ currentTime, buffered }, extra));
  deepEq(plan(10, [[0, 25]]), { action: 'load', bufferedAhead: 15, holeAhead: null, evictBefore: null });
  deepEq(plan(10, [[0, 45]]), { action: 'wait', bufferedAhead: 35, holeAhead: null, evictBefore: null });
  deepEq(plan(10, [[0, 40]]), { action: 'wait', bufferedAhead: 30, holeAhead: null, evictBefore: null }, 'exactly target → wait');
  deepEq(plan(10, [[0, 12], [14, 40]]), { action: 'load', bufferedAhead: 2, holeAhead: { start: 12, end: 14 }, evictBefore: null });
  deepEq(plan(50, [[0, 120]]), { action: 'wait', bufferedAhead: 70, holeAhead: null, evictBefore: 20 }, 'total 120 > 60 → evict before currentTime − 30');
  deepEq(plan(50, [[0, 120]], { maxBuffer: 200 }), { action: 'wait', bufferedAhead: 70, holeAhead: null, evictBefore: null });
  deepEq(plan(5, []), { action: 'load', bufferedAhead: 0, holeAhead: null, evictBefore: null });
  deepEq(plan(5, [[8, 20]]), { action: 'load', bufferedAhead: 0, holeAhead: { start: 5, end: 8 }, evictBefore: null });
  deepEq(plan(10, [[0, 10.05], [10.1, 30]]), { action: 'load', bufferedAhead: 20, holeAhead: null, evictBefore: null }, 'sub-tolerance gap is one range');
  deepEq(plan(10, [[14, 40], [0, 12]]), { action: 'load', bufferedAhead: 2, holeAhead: { start: 12, end: 14 }, evictBefore: null }, 'unsorted input');
  deepEq(plan(10, [[0, 25]], { targetBuffer: 10 }), { action: 'wait', bufferedAhead: 15, holeAhead: null, evictBefore: null });
  deepEq(plan(25, [[0, 30]]), { action: 'load', bufferedAhead: 5, holeAhead: null, evictBefore: null });
  deepEq(plan(10, [[0, 8]]), { action: 'load', bufferedAhead: 0, holeAhead: null, evictBefore: null }, 'everything behind');
  deepEq(plan(0.05, [[0.1, 20]]), { action: 'load', bufferedAhead: 19.95, holeAhead: null, evictBefore: null }, 'within tolerance before a range start counts as inside');
});
test('buffer plan: live trims the back-buffer; VOD keeps it until maxBuffer', () => {
  deepEq(E.hlsBufferPlan({ currentTime: 50, buffered: [[0, 55]], live: true }), { action: 'load', bufferedAhead: 5, holeAhead: null, evictBefore: 20 });
  deepEq(E.hlsBufferPlan({ currentTime: 50, buffered: [[0, 55]], live: false }), { action: 'load', bufferedAhead: 5, holeAhead: null, evictBefore: null });
  deepEq(E.hlsBufferPlan({ currentTime: 50, buffered: [[25, 55]], live: true }).evictBefore, null, 'nothing older than 30 s');
  deepEq(E.hlsBufferPlan({ currentTime: 50, buffered: [[10, 20]], live: true }).evictBefore, 20, 'stale range behind is evictable');
});
test('buffer plan: junk-safe, deterministic', () => {
  deepEq(E.hlsBufferPlan(null), { action: 'load', bufferedAhead: 0, holeAhead: null, evictBefore: null });
  deepEq(E.hlsBufferPlan({ currentTime: 'x', buffered: 'y' }), { action: 'load', bufferedAhead: 0, holeAhead: null, evictBefore: null });
  deepEq(E.hlsBufferPlan({ currentTime: 5, buffered: [[3, 1], [NaN, 2], 'z', null, [2], { start: 4, end: 9 }, [10, 10]] }), { action: 'load', bufferedAhead: 4, holeAhead: null, evictBefore: null }, 'bad ranges skipped, {start,end} accepted');
  deepEq(E.hlsBufferPlan({ currentTime: 5, buffered: [[0, 20]], targetBuffer: -1, maxBuffer: 'x' }), { action: 'load', bufferedAhead: 15, holeAhead: null, evictBefore: null }, 'junk options → defaults');
  const o = { currentTime: 12.345, buffered: [[0, 13], [13.5, 40], [41, 90]], live: true };
  assert.equal(JSON.stringify(E.hlsBufferPlan(o)), JSON.stringify(E.hlsBufferPlan(o)));
});
test('gap jump: ranges table', () => {
  const jump = (currentTime, buffered, stalledMs, readyState) => E.hlsGapJump({ currentTime, buffered, stalledMs, readyState });
  assert.equal(jump(10, [[0, 10], [10.5, 30]], 1500, 2), 10.55);
  assert.equal(jump(10, [[0, 10], [10.5, 30]], 1000, 2), 10.55, 'threshold inclusive');
  assert.equal(jump(10, [[0, 10], [10.5, 30]], 999, 2), null);
  assert.equal(jump(10, [[0, 10], [13, 30]], 1500, 2), null, '3 s ahead is too far');
  assert.equal(jump(10, [[0, 10], [12, 30]], 1500, 2), 12.05, 'exactly 2 s ahead');
  assert.equal(jump(10, [[0, 30]], 1500, 2), null, 'stalled inside buffered media is not a gap');
  assert.equal(jump(10, [[0, 10], [10.5, 30]], 1500, 4), null, 'HAVE_ENOUGH_DATA → not starved');
  assert.equal(jump(10, [[0, 10], [10.5, 30]], 1500, undefined), 10.55, 'unknown readyState is fine');
  assert.equal(jump(0, [[0.08, 20]], 1200, 1), 0.13, 'initial gap before the first append');
  assert.equal(jump(9.95, [[0, 10], [10.5, 30]], 1500, 2), 10.55, 'within tolerance of a range end');
  assert.equal(jump(10, [[0, 10.5]], 1500, 2), null, 'media ahead beyond tolerance');
  assert.equal(jump(10, [], 1500, 2), null);
  assert.equal(jump(10, [[0, 5]], 1500, 2), null, 'everything behind');
  assert.equal(jump(10, [[0, 10.05], [10.08, 11], [11.5, 30]], 1500, 2), null, 'tiny gaps merge: still inside buffered media');
});
test('gap jump: junk-safe', () => {
  for (const o of [null, undefined, {}, { currentTime: 'x', buffered: [[0, 1]], stalledMs: 5000 }, { currentTime: 1, buffered: 'x', stalledMs: 5000 }, { currentTime: 1, buffered: [[2, 3]], stalledMs: 'x' }]) {
    assert.equal(noThrow(() => E.hlsGapJump(o)), null);
  }
});

/* ================= keys, timestamp offset ================= */
test('key iv: explicit or big-endian sequence number', () => {
  const explicit = E.hlsParse(TS_VOD, TS_URL).segments[2].key;
  deepEq(bytes(E.hlsKeyIv(explicit, 999)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.notEqual(E.hlsKeyIv(explicit, 1), explicit.iv, 'a fresh array every call');
  deepEq(bytes(E.hlsKeyIv({ iv: null }, 0x01020304)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
  deepEq(bytes(E.hlsKeyIv({ iv: null }, 7)), [...Array(15).fill(0), 7]);
  deepEq(bytes(E.hlsKeyIv(null, 2 ** 32 + 1)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1], 'wide sequence numbers use the full 64 bits');
  deepEq(bytes(E.hlsKeyIv({ iv: new Uint8Array(4) }, 5)), [...Array(15).fill(0), 5], 'malformed iv falls back to seq');
  deepEq(bytes(E.hlsKeyIv({ iv: Array(16).fill(255) }, 5)), Array(16).fill(255), 'plain arrays accepted');
  for (const [k, s] of [[undefined, undefined], ['x', 'y'], [{}, -3], [{ iv: 'abc' }, NaN], [null, 1.9]]) {
    const iv = noThrow(() => E.hlsKeyIv(k, s));
    assert.equal(iv.length, 16);
    assert.equal(iv[15], s === 1.9 ? 1 : 0);
  }
});
test('timestamp offset', () => {
  assert.equal(E.hlsTimestampOffset({ segmentStart: 12, firstDts: 900000, timescale: 90000 }), 2);
  assert.equal(E.hlsTimestampOffset({ segmentStart: 0, firstDts: 126000, timescale: 90000 }), -1.4);
  assert.equal(E.hlsTimestampOffset({ segmentStart: 30, firstDts: 0, timescale: 44100 }), 30);
  assert.equal(E.hlsTimestampOffset({ segmentStart: 30, firstDts: 10, timescale: 0 }), 30);
  assert.equal(E.hlsTimestampOffset({ segmentStart: 'x', firstDts: 10, timescale: 10 }), -1);
  assert.equal(E.hlsTimestampOffset(null), 0);
  assert.equal(E.hlsTimestampOffset({}), 0);
});

/* ================= audio renditions ================= */
test('select audio rendition: default, autoselect, language rules', () => {
  const m = E.hlsParse(MASTER, MASTER_URL);
  const pick = (variant, opts) => { const r = E.hlsSelectAudioRendition(m.media, variant, opts); return r ? r.name : null; };
  assert.equal(pick(m.variants[0]), 'English', 'DEFAULT=YES');
  assert.equal(pick(m.variants[0], { language: 'fr' }), 'Français');
  assert.equal(pick(m.variants[0], { language: 'FR-ca' }), 'Français', 'primary subtag match, case-insensitive');
  assert.equal(pick(m.variants[0], { language: 'de' }), 'English', 'no match → default');
  assert.equal(pick(m.variants[0], { language: 'en' }), 'English', 'Commentary (AUTOSELECT=NO) is never auto-picked');
  assert.equal(pick(m.variants[4]), 'Surround');
  assert.equal(pick(m.variants[4], { language: 'fr' }), 'Surround', 'group has no French → its default');
  assert.equal(pick({ audioGroup: null }), null);
  assert.equal(pick({ audioGroup: 'nope' }), null);
  assert.equal(E.hlsSelectAudioRendition(m, m.variants[0]).name, 'English', 'accepts the master object');
  const noDefault = [{ type: 'audio', groupId: 'g', name: 'a', autoselect: false }, { type: 'AUDIO', groupId: 'g', name: 'b', autoselect: true }];
  assert.equal(E.hlsSelectAudioRendition(noDefault, { audioGroup: 'g' }).name, 'b', 'autoselect beats first');
  assert.equal(E.hlsSelectAudioRendition([{ type: 'AUDIO', groupId: 'g', name: 'only' }], { audioGroup: 'g' }).name, 'only');
  for (const [media, v] of [[null, {}], ['x', { audioGroup: 'g' }], [[null, 'x'], { audioGroup: 'g' }], [m.media, null]]) assert.equal(noThrow(() => E.hlsSelectAudioRendition(media, v)), null);
});

run();

#!/usr/bin/env node
/**
 * Media integration test for Aerial — MPEG-TS in, fragmented MP4 out.
 *
 * The exact pipeline the browser runs for an HLS TS stream (index.html's
 * processTs / appendTsSamples / flushTs), but in Node and judged by an
 * independent decoder:
 *
 *   ffmpeg → H.264 + AAC in MPEG-TS (four fixtures, see below)
 *     → tsDemux, one call per segment with the state threaded in order,
 *       tsFlush at the end                                   (TS section)
 *     → mp4InitSegment(tracks) + one mp4MediaSegment per segment per track,
 *       sequence numbers increasing, tfdt = the segment's first dts rescaled
 *       into the track timescale and shifted so the stream starts at 0, the
 *       way hlsTimestampOffset shifts the SourceBuffer           (MP4 section)
 *     → init + segments concatenated → remuxed.mp4
 *     → ffmpeg decodes it without a single error; ffprobe agrees on codecs,
 *       profile, dimensions, sample rate, channels, packet counts, keyframes,
 *       monotonic dts and the per-packet pts/dts lists (= the source's, shifted
 *       by the one common offset).
 *
 * Fixtures (320x180, 25 fps, 4 s, GOP 25, AAC 48 kHz):
 *   (a) Constrained Baseline, no B-frames: pts == dts for every frame.
 *   (b) High with B-frames (-bf 2): pts order differs from dts order, so the
 *       composition offsets and the reorder delay have to come out right.
 *   (c) (b) cut by ffmpeg's HLS muxer into 1 s TS segments and demuxed segment
 *       by segment with the state threaded: a video PES has no declared length
 *       (it closes on the next PUSI) and an access unit closes on the next
 *       delimiter, so the last two frames of every segment are only emitted
 *       while demuxing the next one, and the last two of all on tsFlush. Its
 *       remux must have the same sample table (every dts, duration, cts, size,
 *       flag and byte) as the remux of the unsegmented (b).
 *   (d) audio-only AAC.
 *   (e) two independent encodes (the second with its own 90 kHz clock starting
 *       at 100 s and a different length) joined by an EXT-X-DISCONTINUITY in a
 *       playlist: what index.html does there (flushTs → fresh tsCreateState →
 *       a new hlsTimestampOffset so the restarted clock lands at seg.start) is
 *       emulated, and the remux must play straight through: dts monotonic
 *       across the join, the second part starting exactly at the first
 *       segment's playlist duration, packet counts and sizes of both sources.
 *
 * Sample sizes are checked against ffmpeg's own TS→MP4 remux of the same
 * source (-c copy, AUDs filtered out): AVCC lengths replace start codes of
 * either width, so the TS packet sizes themselves are not comparable.
 *
 * "First video pts is 0": the common offset is the earliest dts of the first
 * segment (what hlsTimestampOffset is fed), so the first video frame presents
 * at its own composition offset — 0 without B-frames, the reorder delay
 * (has_b_frames frames) with them — and the test asserts exactly that, ±1 frame.
 *
 * ffprobe prints the first audio packet of any fragmented MP4 (ffmpeg's own
 * included) with duration N/A; that one field is the only thing not asserted.
 *
 * Needs ffmpeg + ffprobe on PATH (ubuntu-latest has them); prints "[skip]" and
 * exits 0 otherwise. Zero npm deps; the engine is loaded in a vm sandbox like
 * every other prototype test. Run: node scripts/test-aerial-media.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEngine() {
  const sandbox = { module: { exports: {} }, TextEncoder, TextDecoder, console };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(ROOT, 'aerial', 'engine.js'), 'utf8'), sandbox, { filename: 'aerial/engine.js' });
  return sandbox.module.exports;
}
const E = loadEngine();

const onPath = (cmd) => { const r = spawnSync(cmd, ['-version'], { encoding: 'utf8' }); return !r.error && r.status === 0; };
if (!onPath('ffmpeg') || !onPath('ffprobe')) {
  console.log('[skip] aerial media: ffmpeg/ffprobe not on PATH');
  process.exit(0);
}

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m); // cross-realm safe
const bytesEq = (a, b, m) => assert.ok(Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength)), m);
const TS_CLOCK = 90000, FPS = 25, FRAME = TS_CLOCK / FPS, SECONDS = 4, AAC_FRAME = 1024;
const SYNC = 0x02000000, NONSYNC = 0x01010000; // trun sample_flags the muxer writes for key / non-key samples
// ffprobe prints the first packet of a fragmented MP4 track with duration N/A (ffmpeg's own files too).
const durationIs = (p, i, want) => p.duration === want || (i === 0 && Number.isNaN(p.duration));

/* ---------- ffmpeg / ffprobe ---------- */
const DIR = mkdtempSync(join(tmpdir(), 'aerial-media-'));
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));
const V = ['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=${FPS}`];
const A = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const X264 = (profile, bf) => ['-c:v', 'libx264', '-profile:v', profile, '-pix_fmt', 'yuv420p', '-g', String(FPS), '-bf', String(bf)];
const AAC = ['-c:a', 'aac', '-b:a', '64k'];
function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-nostdin', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'ffmpeg ' + args.join(' ') + '\n' + r.stderr);
  return r;
}
function ffprobe(file, ...args) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-of', 'json', ...args, file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, 'ffprobe ' + file + ': ' + r.stderr);
  return JSON.parse(r.stdout);
}
const streamsOf = (file) => ffprobe(file, '-show_streams').streams;
// ffprobe's packet list of one stream: numbers coerced (ffprobe prints some as strings), decode (file) order.
const packetsOf = (file, spec) => ffprobe(file, '-show_packets', '-select_streams', spec).packets
  .map((p) => ({ pts: +p.pts, dts: +p.dts, duration: +p.duration, size: +p.size, key: String(p.flags).includes('K') }));
const bytesOf = (file) => new Uint8Array(readFileSync(file));
const isSorted = (list) => list.every((v, i) => i === 0 || v > list[i - 1]);

/* ---------- the pipeline, as index.html runs it ---------- */
// Track descriptions from a demux result, exactly as processTs builds them.
function tracksOf(r) {
  const v = r.video && r.video.codec && r.video.sps && r.video.pps ? r.video : null;
  const a = r.audio && r.audio.codec ? r.audio : null;
  const tracks = [];
  if (v) tracks.push({ id: 1, type: 'video', timescale: v.timescale || TS_CLOCK, duration: 0, width: v.width || 0, height: v.height || 0, sps: v.sps, pps: v.pps, codec: v.codec });
  if (a) {
    const conf = a.config || {};
    tracks.push({
      id: 2, type: 'audio', timescale: a.timescale || a.sampleRate || TS_CLOCK, duration: 0, codec: a.codec,
      audio: { objectType: conf.objectType || 2, sampleRateIndex: typeof conf.sampleRateIndex === 'number' ? conf.sampleRateIndex : 4, sampleRate: a.sampleRate || 44100, channels: a.channels || conf.channels || 2 },
    });
  }
  return tracks;
}
const samplesOf = (r, t) => { const src = t.type === 'video' ? r.video : r.audio; return src && src.samples ? src.samples : []; };
// Demux the segments in order (state threaded), flush, then mux: init + one moof/mdat per segment per track.
// `info[i]` = {discontinuity, start} from the playlist (hlsParse); a segment flagged discontinuity is handled the way
// index.html's processTs handles it: the old state is flushed (its last access unit lands in the previous
// segment's fragment, under the old offset), a fresh state demuxes the new segment, and a new timestamp offset
// puts the restarted 90 kHz clock at the segment's playlist start.
function remux(segments, outFile, info) {
  const segs = segments.map((bytes, i) => ({ bytes, discontinuity: i > 0 && !!(info && info[i] && info[i].discontinuity), start: info && info[i] ? info[i].start : 0 }));
  let state = E.tsCreateState();
  const results = [], errors = [];
  // The flush completes the last access unit of a timeline, so its samples belong to that timeline's last fragment.
  const drain = () => {
    const fin = E.tsFlush(state);
    errors.push(...fin.errors);
    const last = results[results.length - 1];
    for (const k of ['video', 'audio']) if (fin[k] && fin[k].samples.length) {
      if (last[k]) last[k].samples.push(...fin[k].samples); else last[k] = fin[k];
    }
  };
  for (const seg of segs) {
    if (seg.discontinuity) { drain(); state = E.tsCreateState(); }
    const r = E.tsDemux(seg.bytes, state);
    state = r.state; results.push(r); errors.push(...r.errors);
  }
  drain();
  const tracks = tracksOf(results[0]);
  assert.ok(tracks.length, 'the first segment yields at least one track');
  const init = E.mp4InitSegment(tracks);
  assert.ok(init, 'init segment built');
  // Every TS timestamp is a 90 kHz tick; the SourceBuffer offset of a timeline is computed from the earliest dts of
  // its first segment (index.html takes the video's first dts, which differs from the earliest by the a/v skew at most).
  const earliest = (r) => Math.min(...tracks.map((t) => samplesOf(r, t)).filter((s) => s.length).map((s) => s[0].dts));
  const firstDts = earliest(results[0]);
  const shift0 = E.hlsTimestampOffset({ segmentStart: 0, firstDts, timescale: TS_CLOCK }); // seconds, negative
  assert.equal(shift0, -firstDts / TS_CLOCK);
  let seq = 0, shift = shift0;
  const parts = [init], frags = [], timelines = [{ segIndex: 0, firstDts, shift: shift0 }];
  results.forEach((r, segIndex) => {
    if (segIndex > 0 && segs[segIndex].discontinuity) {
      const first = earliest(r);
      shift = E.hlsTimestampOffset({ segmentStart: segs[segIndex].start, firstDts: first, timescale: TS_CLOCK });
      timelines.push({ segIndex, firstDts: first, shift });
    }
    for (const t of tracks) {
      const samples = samplesOf(r, t);
      if (!samples.length) continue;
      const bmdt = Math.max(0, Math.round((samples[0].dts / TS_CLOCK + shift) * t.timescale));
      const media = E.mp4MediaSegment(t, samples, { sequenceNumber: ++seq, baseMediaDecodeTime: bmdt });
      assert.ok(media, 'media segment built');
      parts.push(media);
      frags.push({ segIndex, trackId: t.id, seq, bmdt, count: samples.length });
    }
  });
  const remuxed = E.concatBytes(parts);
  writeFileSync(outFile, Buffer.from(remuxed.buffer, remuxed.byteOffset, remuxed.byteLength));
  return { results, errors, tracks, init, firstDts, timelines, frags, remuxed, out: outFile, video: tracks.find((t) => t.type === 'video') || null, audio: tracks.find((t) => t.type === 'audio') || null };
}
// Per-track sample table of a remuxed file, read back with the engine's parser: dts from tfdt + durations,
// every trun field, and the sample bytes from the mdat.
function sampleTable(bytes) {
  const boxes = E.mp4ParseBoxes(bytes);
  assert.equal(boxes.truncated, false);
  const byTrack = {};
  let lastSeq = 0;
  for (const moof of boxes.filter((b) => b.type === 'moof')) {
    const seq = E.mp4FindBox(moof, 'mfhd').sequenceNumber;
    assert.ok(seq > lastSeq, 'sequence numbers increase'); lastSeq = seq;
    for (const traf of moof.children.filter((b) => b.type === 'traf')) {
      const tfhd = E.mp4FindBox(traf, 'tfhd'), tfdt = E.mp4FindBox(traf, 'tfdt'), trun = E.mp4FindBox(traf, 'trun');
      const t = byTrack[tfhd.trackId] || (byTrack[tfhd.trackId] = { samples: [], chunks: [] });
      let dts = tfdt.baseMediaDecodeTime, pos = moof.offset + trun.dataOffset;
      for (const s of trun.samples) {
        t.samples.push({ dts, pts: dts + s.cts, duration: s.duration, size: s.size, flags: s.flags, cts: s.cts });
        t.chunks.push(bytes.subarray(pos, pos + s.size));
        dts += s.duration; pos += s.size;
      }
    }
  }
  for (const id in byTrack) { byTrack[id].bytes = E.concatBytes(byTrack[id].chunks); delete byTrack[id].chunks; }
  return byTrack;
}

/* ---------- fixtures (built once, on first use) ---------- */
const built = {};
function fixture(name) {
  if (built[name]) return built[name];
  const src = join(DIR, name + '.ts'), out = join(DIR, name + '-remuxed.mp4');
  let f;
  if (name === 'baseline') {
    ffmpeg([...V, ...A, '-t', String(SECONDS), ...X264('baseline', 0), ...AAC, '-f', 'mpegts', src]);
    f = { src, segments: [bytesOf(src)] };
  } else if (name === 'high') {
    ffmpeg([...V, ...A, '-t', String(SECONDS), ...X264('high', 2), ...AAC, '-f', 'mpegts', src]);
    f = { src, segments: [bytesOf(src)] };
  } else if (name === 'hls') {
    const playlist = join(DIR, 'hls.m3u8');
    ffmpeg(['-i', fixture('high').src, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'mpegts', '-hls_list_size', '0', playlist]);
    const pl = E.hlsParse(readFileSync(playlist, 'utf8'), playlist);
    assert.ok(pl.segments && pl.segments.length >= 3, 'the HLS cut produced several segments: ' + JSON.stringify(pl.errors));
    const files = pl.segments.map((s) => join(DIR, s.uri));
    f = { src: fixture('high').src, segments: files.map(bytesOf), segmentFiles: files };
  } else if (name === 'audio') {
    ffmpeg([...A, '-t', String(SECONDS), ...AAC, '-f', 'mpegts', src]);
    f = { src, segments: [bytesOf(src)] };
  } else if (name === 'disc') {
    // (e) two independent encodes: different picture and tone, the second 3 s long with its 90 kHz clock starting
    // at 100 s; a hand-written playlist joins them with EXT-X-DISCONTINUITY. The first EXTINF is the real span of
    // the first file (its audio outlasts its video by the AAC padding), so the second timeline starts after it.
    const src2 = join(DIR, name + '-2.ts'), playlist = join(DIR, name + '.m3u8');
    ffmpeg([...V, ...A, '-t', String(SECONDS), ...X264('baseline', 0), ...AAC, '-f', 'mpegts', src]);
    ffmpeg(['-f', 'lavfi', '-i', `testsrc=size=320x180:rate=${FPS}`, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '3', ...X264('baseline', 0), ...AAC, '-output_ts_offset', '100', '-f', 'mpegts', src2]);
    const span = (file) => { const all = [...packetsOf(file, 'v:0'), ...packetsOf(file, 'a:0')]; return (Math.max(...all.map((p) => p.pts + p.duration)) - Math.min(...all.map((p) => p.dts))) / TS_CLOCK; };
    const d0 = Math.ceil(span(src) * 1000) / 1000, d1 = Math.ceil(span(src2) * 1000) / 1000;
    writeFileSync(playlist, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:${d0.toFixed(3)},\n${name}.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:${d1.toFixed(3)},\n${name}-2.ts\n#EXT-X-ENDLIST\n`);
    const pl = E.hlsParse(readFileSync(playlist, 'utf8'), playlist);
    deepEq(pl.segments.map((s) => [s.uri, s.discontinuity, s.start]), [[name + '.ts', false, 0], [name + '-2.ts', true, d0]], 'the playlist parses as two segments with a discontinuity at the second');
    f = { src, src2, segments: [bytesOf(src), bytesOf(src2)], info: pl.segments.map((s) => ({ discontinuity: s.discontinuity, start: s.start })), starts: [0, d0], durations: [d0, d1] };
    f.srcV2 = packetsOf(src2, 'v:0'); f.srcA2 = packetsOf(src2, 'a:0');
    f.ref2 = join(DIR, name + '-2-ffmpeg.mp4');
    ffmpeg(['-i', src2, '-c', 'copy', '-bsf:v', 'filter_units=remove_types=9', '-f', 'mp4', f.ref2]);
    f.refV2 = packetsOf(f.ref2, 'v:0'); f.refA2 = packetsOf(f.ref2, 'a:0');
  } else throw new Error('unknown fixture ' + name);
  const streams = streamsOf(f.src);
  f.srcVideo = streams.find((s) => s.codec_type === 'video') || null;
  f.srcAudio = streams.find((s) => s.codec_type === 'audio') || null;
  f.srcV = f.srcVideo ? packetsOf(f.src, 'v:0') : [];
  f.srcA = f.srcAudio ? packetsOf(f.src, 'a:0') : [];
  // ffmpeg's own remux of the same TS into MP4 (AUDs filtered out): the reference for sample sizes.
  f.ref = join(DIR, name + '-ffmpeg.mp4');
  ffmpeg(['-i', f.src, '-c', 'copy', ...(f.srcVideo ? ['-bsf:v', 'filter_units=remove_types=9'] : []), '-f', 'mp4', f.ref]);
  f.refV = f.srcVideo ? packetsOf(f.ref, 'v:0') : [];
  f.refA = packetsOf(f.ref, 'a:0');
  Object.assign(f, remux(f.segments, out, f.info));
  return (built[name] = f);
}

/* ---------- the assertion groups, per fixture ---------- */
function describe(name, label, want) {
  test(`${label}: demux is clean, tracks match the source, init codecs = demuxer codecs, one moof per segment per track`, () => {
    const f = fixture(name);
    deepEq(f.errors, []);
    if (want.video) {
      assert.ok(f.video, 'video track'); assert.ok(f.srcVideo, 'source has video');
      assert.match(f.video.codec, /^avc1\.[0-9a-f]{6}$/);
      deepEq([f.video.width, f.video.height, f.video.timescale], [f.srcVideo.width, f.srcVideo.height, TS_CLOCK]);
      deepEq([E.nalType(f.video.sps), E.nalType(f.video.pps)], [7, 8]);
      const sps = E.parseSps(f.video.sps);
      deepEq([sps.ok, sps.width, sps.height, sps.profileIdc, sps.codec], [true, 320, 180, want.profileIdc, f.video.codec]);
    } else assert.equal(f.video, null, 'no video track');
    assert.ok(f.audio, 'audio track'); assert.ok(f.srcAudio, 'source has audio');
    deepEq([f.audio.codec, f.audio.timescale, f.audio.audio.sampleRate, f.audio.audio.channels, f.audio.audio.objectType, f.audio.audio.sampleRateIndex],
      ['mp4a.40.2', +f.srcAudio.sample_rate, +f.srcAudio.sample_rate, f.srcAudio.channels, 2, 3]);
    deepEq(E.mp4CodecsFromInit(f.init), want.video ? [f.video.codec, 'mp4a.40.2'] : ['mp4a.40.2']);
    deepEq(E.mp4TracksFromInit(f.init).map((t) => [t.id, t.type, t.timescale, t.codec]), f.tracks.map((t) => [t.id, t.type, t.timescale, t.codec]));
    assert.equal(f.frags.length, f.segments.length * f.tracks.length, 'one moof per segment per track');
    deepEq(f.frags.map((x) => x.seq), f.frags.map((_, i) => i + 1), 'sequence numbers 1..n');
    assert.ok(f.frags.some((x) => x.bmdt === 0), 'the stream starts at 0');
    for (const t of f.tracks) {
      const mine = f.frags.filter((x) => x.trackId === t.id);
      assert.equal(mine.length, f.segments.length, `track ${t.id} has one fragment per segment`);
      assert.ok(isSorted(mine.map((x) => x.bmdt)), `track ${t.id} tfdt increases across fragments`);
    }
    // The trun flags as written: every AAC frame a sync sample, IDR frames sync, the rest non-sync.
    const table = sampleTable(f.remuxed);
    assert.equal(table[f.audio.id].samples.length, f.srcA.length);
    assert.ok(table[f.audio.id].samples.every((s) => s.flags === SYNC && s.cts === 0 && s.duration === AAC_FRAME), 'every AAC frame is a 1024-sample sync sample');
    if (want.video) {
      const vs = table[f.video.id].samples;
      assert.equal(vs.length, f.srcV.length);
      deepEq(vs.map((s) => s.flags), f.srcV.map((p) => (p.key ? SYNC : NONSYNC)), 'video sync flags follow the source keyframes');
      assert.ok(vs.every((s) => s.duration === FRAME), 'every frame lasts 1/25 s');
    }
  });

  test(`${label}: "ffmpeg -v error -i remuxed.mp4 -f null -" decodes end to end without a single error`, () => {
    const f = fixture(name);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', f.out, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal((r.stderr || '').trim(), '');
    assert.equal((r.stdout || '').trim(), '');
  });

  test(`${label}: ffprobe -show_streams: ${want.video ? 'h264 ' + want.profile + ' 320x180 + ' : ''}aac 48000 Hz, channels and time bases as the source`, () => {
    const f = fixture(name);
    const mine = streamsOf(f.out);
    assert.equal(mine.length, f.tracks.length);
    const v = mine.find((s) => s.codec_type === 'video') || null, a = mine.find((s) => s.codec_type === 'audio') || null;
    if (want.video) {
      deepEq([v.codec_name, v.profile, v.width, v.height, v.level, v.pix_fmt, v.has_b_frames, v.time_base],
        ['h264', want.profile, f.srcVideo.width, f.srcVideo.height, f.srcVideo.level, f.srcVideo.pix_fmt, want.bframes, '1/' + TS_CLOCK]);
      assert.equal(v.profile, f.srcVideo.profile);
    } else assert.equal(v, null);
    deepEq([a.codec_name, a.profile, a.sample_rate, a.channels, a.channel_layout, a.time_base],
      ['aac', 'LC', '48000', f.srcAudio.channels, f.srcAudio.channel_layout, '1/48000']);
    assert.equal(a.sample_rate, f.srcAudio.sample_rate);
  });

  test(`${label}: ffprobe -show_packets: counts and keyframes = source, dts monotonic, first video pts = ${want.bframes ? 'the reorder delay' : '0'} (±1 frame), last ≈ ${SECONDS} s`, () => {
    const f = fixture(name);
    const a = packetsOf(f.out, 'a:0');
    assert.equal(a.length, f.srcA.length, 'audio packet count');
    assert.ok(a.length > 150, 'audio packets present');
    assert.ok(isSorted(a.map((p) => p.dts)), 'audio dts strictly increasing');
    assert.ok(a.every((p, i) => p.key && durationIs(p, i, AAC_FRAME) && p.pts === p.dts), 'every AAC frame is a 1024-sample keyframe');
    if (!want.video) return;
    const v = packetsOf(f.out, 'v:0');
    assert.equal(v.length, f.srcV.length, 'video packet count');
    assert.equal(v.length, FPS * SECONDS);
    assert.equal(v.filter((p) => p.key).length, f.srcV.filter((p) => p.key).length, 'keyframe count');
    assert.equal(v.filter((p) => p.key).length, SECONDS, 'one IDR per GOP');
    assert.ok(v[0].key, 'starts on a keyframe');
    assert.ok(isSorted(v.map((p) => p.dts)), 'video dts strictly increasing');
    assert.ok(v.every((p) => p.duration === FRAME), 'every frame lasts 1/25 s');
    // The offset is the earliest dts, so the first frame presents at its own composition offset: 0 without
    // B-frames, has_b_frames frames of reorder delay with them.
    assert.ok(Math.abs(v[0].pts - want.bframes * FRAME) <= FRAME, `first video pts ${v[0].pts} vs reorder delay ${want.bframes * FRAME}`);
    // The stream starts at 0 on whichever track comes first; the other is within a frame of it.
    assert.equal(Math.min(v[0].dts, Math.round(a[0].dts * TS_CLOCK / 48000)), 0, 'the earliest dts is 0');
    assert.ok(v[0].dts >= 0 && v[0].dts <= FRAME, `first video dts ${v[0].dts} within a frame of 0`);
    const lastPts = Math.max(...v.map((p) => p.pts));
    assert.ok(Math.abs(lastPts / TS_CLOCK - SECONDS) <= 2 * FRAME / TS_CLOCK, `last video pts ${lastPts / TS_CLOCK}s ≈ ${SECONDS}s`);
  });

  test(`${label}: per-packet pts/dts lists = the source's shifted by the common offset${want.bframes ? '; pts order differs from dts order' : '; pts == dts throughout'}`, () => {
    const f = fixture(name);
    const a = packetsOf(f.out, 'a:0');
    deepEq(a.map((p) => p.pts), f.srcA.map((p) => Math.round((p.pts - f.firstDts) * 48000 / TS_CLOCK)), 'audio pts (48 kHz) = source pts shifted and rescaled');
    deepEq(a.map((p) => p.size), f.srcA.map((p) => p.size - 7), 'raw AAC frames = ADTS frames minus the 7-byte header');
    deepEq(a.map((p) => p.size), f.refA.map((p) => p.size), 'audio sizes = ffmpeg\'s own remux');
    if (!want.video) return;
    const v = packetsOf(f.out, 'v:0');
    deepEq(v.map((p) => p.pts), f.srcV.map((p) => p.pts - f.firstDts), 'video pts list');
    deepEq(v.map((p) => p.dts), f.srcV.map((p) => p.dts - f.firstDts), 'video dts list');
    deepEq(v.map((p) => p.key), f.srcV.map((p) => p.key), 'key flags per packet');
    deepEq(v.map((p) => p.size), f.refV.map((p) => p.size), 'sample sizes = ffmpeg\'s own remux (AVCC lengths for start codes of either width, AUD dropped, SPS/PPS/SEI kept)');
    deepEq(v.map((p) => p.key), f.refV.map((p) => p.key), 'key flags = ffmpeg\'s own remux');
    if (want.bframes) {
      assert.ok(!isSorted(v.map((p) => p.pts)), 'B-frames: pts order differs from dts order');
      assert.ok(v.some((p) => p.pts - p.dts > FRAME), 'composition offsets of more than one frame');
    } else assert.ok(v.every((p) => p.pts === p.dts), 'no B-frames: pts == dts');
  });
}

describe('baseline', '(a) baseline', { video: true, profile: 'Constrained Baseline', profileIdc: 66, bframes: 0 });
describe('high', '(b) high', { video: true, profile: 'High', profileIdc: 100, bframes: 2 });
describe('hls', '(c) hls segments', { video: true, profile: 'High', profileIdc: 100, bframes: 2 });
describe('audio', '(d) audio-only', { video: false, bframes: 0 });

/* ---------- (c): state threading across segment boundaries ---------- */
test('(c) hls segments: the cut really splits the stream, and the trailing access units of every segment are completed by the next segment', () => {
  const f = fixture('hls');
  const perSegment = f.segmentFiles.map((file) => ({ v: packetsOf(file, 'v:0').length, a: packetsOf(file, 'a:0').length }));
  assert.ok(perSegment.length >= 3);
  assert.ok(perSegment.every((c) => c.v > 0 && c.a > 0), 'every segment carries both streams');
  assert.equal(perSegment.reduce((n, c) => n + c.v, 0), f.srcV.length, 'segment video packets sum to the source');
  assert.equal(perSegment.reduce((n, c) => n + c.a, 0), f.srcA.length, 'segment audio packets sum to the source');
  // A video PES has no declared length (it closes on the next PUSI) and an access unit closes on the next
  // delimiter, so the last two frames of every segment are emitted while demuxing the next segment, and the
  // last two of all on tsFlush (merged into the last fragment). Audio PES packets declare their length, so
  // every audio frame lands in its own segment's fragment.
  const LAG = 2, last = perSegment.length - 1;
  const videoFrags = f.frags.filter((x) => x.trackId === 1).map((x) => x.count);
  deepEq(videoFrags, perSegment.map((c, i) => c.v - (i < last ? LAG : 0) + (i > 0 ? LAG : 0)), 'video samples per fragment: two carried over each boundary');
  deepEq(f.frags.filter((x) => x.trackId === 2).map((x) => x.count), perSegment.map((c) => c.a), 'audio frames per fragment');
  // Each fragment's tfdt is the dts of its first sample (in source order), shifted by the same offset as (b).
  assert.equal(f.firstDts, fixture('high').firstDts);
  let k = 0;
  deepEq(f.frags.filter((x) => x.trackId === 1).map((x) => x.bmdt), videoFrags.map((n) => { const d = f.srcV[k].dts - f.firstDts; k += n; return d; }), 'video tfdt per fragment');
  k = 0;
  deepEq(f.frags.filter((x) => x.trackId === 2).map((x) => x.bmdt), perSegment.map((c) => { const d = Math.round((f.srcA[k].dts - f.firstDts) * 48000 / TS_CLOCK); k += c.a; return d; }), 'audio tfdt per fragment');
});

test('(c) hls segments: the segmented remux has the same sample table as the unsegmented (b) remux — same counts, dts, durations, cts, flags, bytes', () => {
  const seg = fixture('hls'), whole = fixture('high');
  const a = sampleTable(seg.remuxed), b = sampleTable(whole.remuxed);
  deepEq(Object.keys(a), ['1', '2']); deepEq(Object.keys(b), ['1', '2']);
  for (const id of ['1', '2']) {
    assert.equal(a[id].samples.length, b[id].samples.length, `track ${id} sample count`);
    deepEq(a[id].samples, b[id].samples, `track ${id} sample table`);
    bytesEq(a[id].bytes, b[id].bytes, `track ${id} sample bytes`);
  }
  assert.equal(a['1'].samples.length, FPS * SECONDS);
  assert.ok(a['1'].samples.some((s) => s.cts > 0) && a['1'].samples.every((s) => s.cts >= 0), 'B-frame composition offsets, never negative');
  // Only the fragmentation differs: more moofs, same init.
  bytesEq(seg.init, whole.init, 'identical init segments');
  assert.ok(seg.frags.length > whole.frags.length);
  // ffprobe sees the same packets too (an independent reading of the two files).
  for (const spec of ['v:0', 'a:0']) deepEq(packetsOf(seg.out, spec), packetsOf(whole.out, spec), 'ffprobe packets ' + spec);
});

/* ---------- (e): a discontinuity — fresh demux state, new offset, one continuous output timeline ---------- */
test('(e) discontinuity: a fresh state per timeline, the old one drained into its own fragment, one init (same codecs), a second offset at the playlist start of segment 1', () => {
  const f = fixture('disc');
  deepEq(f.errors, []);
  assert.equal(f.timelines.length, 2, 'two timelines');
  deepEq(f.timelines.map((t) => t.segIndex), [0, 1]);
  assert.ok(f.timelines[1].firstDts > 99 * TS_CLOCK && f.timelines[1].firstDts < 102 * TS_CLOCK, 'the second encode really starts its clock near 100 s: ' + f.timelines[1].firstDts);
  assert.equal(f.timelines[1].shift, f.starts[1] - f.timelines[1].firstDts / TS_CLOCK, 'new offset = seg.start − first dts, as hlsTimestampOffset defines it');
  assert.equal(f.frags.length, 4, 'one moof per segment per track');
  // Every access unit of each source lands in its own segment's fragment: the first timeline's last unit only comes
  // out of tsFlush, which index.html runs before abandoning the state (and this harness merges into fragment 0).
  deepEq(f.frags.filter((x) => x.trackId === f.video.id).map((x) => x.count), [f.srcV.length, f.srcV2.length], 'video samples per fragment = source packets');
  deepEq(f.frags.filter((x) => x.trackId === f.audio.id).map((x) => x.count), [f.srcA.length, f.srcA2.length], 'audio frames per fragment = source packets');
  // The second timeline starts where the playlist says: its earliest sample sits at seg.start, the other track within a frame.
  const start1 = Math.round(f.starts[1] * TS_CLOCK);
  const seg1 = f.frags.filter((x) => x.segIndex === 1), in90k = (x) => Math.round(x.bmdt * TS_CLOCK / f.tracks.find((t) => t.id === x.trackId).timescale);
  assert.ok(Math.abs(Math.min(...seg1.map(in90k)) - start1) <= 1, `earliest tfdt of segment 1 = ${Math.min(...seg1.map(in90k))} vs playlist start ${start1}`);
  assert.ok(seg1.every((x) => Math.abs(in90k(x) - start1) <= FRAME), 'both tracks start within a frame of the playlist start');
  const seg0 = f.frags.filter((x) => x.segIndex === 0);
  assert.ok(seg0.some((x) => x.bmdt === 0), 'the first timeline starts at 0');
  for (const t of f.tracks) assert.ok(isSorted(f.frags.filter((x) => x.trackId === t.id).map((x) => x.bmdt)), `track ${t.id} tfdt increases across the discontinuity`);
  deepEq(E.mp4CodecsFromInit(f.init), [f.video.codec, 'mp4a.40.2']);
});

test('(e) discontinuity: ffmpeg decodes the joined remux end to end without a single error', () => {
  const f = fixture('disc');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', f.out, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stderr || '').trim(), '');
});

test('(e) discontinuity: ffprobe sees one monotonic timeline — counts, keyframes and sizes of both sources, part 2 starting at the playlist start, pts lists = each source shifted by its own offset', () => {
  const f = fixture('disc');
  const v = packetsOf(f.out, 'v:0'), a = packetsOf(f.out, 'a:0');
  assert.equal(v.length, f.srcV.length + f.srcV2.length, 'video packets = both sources');
  assert.equal(a.length, f.srcA.length + f.srcA2.length, 'audio packets = both sources');
  assert.equal(v.filter((p) => p.key).length, f.srcV.filter((p) => p.key).length + f.srcV2.filter((p) => p.key).length, 'keyframes = both sources');
  assert.ok(isSorted(v.map((p) => p.dts)), 'video dts strictly increasing across the join');
  assert.ok(isSorted(a.map((p) => p.dts)), 'audio dts strictly increasing across the join');
  assert.ok(v.every((p) => p.duration === FRAME) && v.every((p) => p.pts === p.dts), 'every frame 1/25 s, no B-frames');
  const n = f.srcV.length, start1 = Math.round(f.starts[1] * TS_CLOCK), shift1 = Math.round(f.timelines[1].shift * TS_CLOCK);
  assert.ok(v[n].key, 'part 2 opens on its IDR');
  assert.ok(Math.abs(v[n].dts - start1) <= FRAME, `part 2's first video dts ${v[n].dts} within a frame of the playlist start ${start1}`);
  assert.ok(v[n].dts >= v[n - 1].dts + FRAME, 'no overlap with the last frame of part 1');
  assert.ok(v[n - 1].pts + FRAME <= Math.round(f.starts[1] * TS_CLOCK) + 1, 'part 1 ends by its EXTINF');
  deepEq(v.slice(0, n).map((p) => p.pts), f.srcV.map((p) => p.pts - f.firstDts), 'part 1 video pts = source 1 shifted to 0');
  deepEq(v.slice(n).map((p) => p.pts), f.srcV2.map((p) => p.pts + shift1), 'part 2 video pts = source 2 shifted onto the playlist timeline');
  const m = f.srcA.length, a1 = f.frags.find((x) => x.segIndex === 1 && x.trackId === f.audio.id).bmdt;
  deepEq(a.slice(0, m).map((p) => p.pts), f.srcA.map((p) => Math.round((p.pts - f.firstDts) * 48000 / TS_CLOCK)), 'part 1 audio pts (48 kHz)');
  deepEq(a.slice(m).map((p) => p.pts), f.srcA2.map((p, i) => a1 + i * AAC_FRAME), 'part 2 audio pts: its tfdt then 1024-sample steps');
  assert.ok(a[m].dts > a[m - 1].dts, 'part 2 audio starts after part 1 ended');
  deepEq(v.map((p) => p.size), [...f.refV, ...f.refV2].map((p) => p.size), 'video sample sizes = ffmpeg\'s own remux of each source');
  deepEq(a.map((p) => p.size), [...f.refA, ...f.refA2].map((p) => p.size), 'audio sample sizes = ffmpeg\'s own remux of each source');
  // Dropping the flush, keeping the old state, or anchoring the new offset at 0 instead of seg.start would each break one of the above.
});

/* ---- run ---- */
const t0 = Date.now();
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n${err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err}\n`);
    process.exitCode = 1;
  }
}
console.log(`\naerial media: ${passed}/${tests.length} passed (${Date.now() - t0} ms)`);
if (passed !== tests.length) process.exit(1);

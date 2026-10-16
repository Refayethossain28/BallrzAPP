/* ===== HLS: M3U8 playlists (RFC 8216 + Apple extensions), adaptive bitrate, live timing, buffer maths ===== */
var HLS = (function () {
  'use strict';

  var MAX_ERRORS = 50;                 // junk input must not turn into a megabyte of error strings
  var DEFAULT_TARGET_DURATION = 10;    // used only when a media playlist omits the (required) tag
  var FIRST_GUESS_BPS = 1500000;       // with no throughput sample yet, start no higher than 1.5 Mbps
  var DEFAULT_SAFETY = 0.8, DEFAULT_UP_HYSTERESIS = 1.25, UP_BUFFER_SEC = 20;
  var DEFAULT_FAST_HALF_LIFE = 3, DEFAULT_SLOW_HALF_LIFE = 9;
  var LIVE_HOLD_TARGETS = 3;           // RFC 8216 §6.3.3: start ≥ 3 target durations from the live end
  var MIN_RELOAD_MS = 1000;
  var BUFFER_TOLERANCE = 0.1;          // buffered ranges closer than this are one range (frame-gap noise)
  var KEEP_BEHIND_SEC = 30;            // how much played media stays appended for instant short seeks back
  var GAP_JUMP_STALL_MS = 1000, GAP_JUMP_MAX_AHEAD = 2, GAP_JUMP_NUDGE = 0.05;
  var VAR_RE = /\{\$([A-Za-z0-9_-]+)\}/g; // EXT-X-DEFINE variable reference
  var isNum = UTIL.isNum;

  /* ---------- small helpers ---------- */
  function num(v) { return isNum(v) ? v : null; }
  function positiveOr(v, d) { return isNum(v) && v > 0 ? v : d; }
  function str(v) { return v === undefined || v === null || v === '' ? null : String(v); }
  function yes(v) { return String(v == null ? '' : v).toUpperCase() === 'YES'; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function hasSegments(pl) { return !!(pl && typeof pl === 'object' && Array.isArray(pl.segments)); }
  function lastSeqOf(pl) { return pl.segments.length ? pl.segments[pl.segments.length - 1].seq : null; }
  // Target duration with a fallback, because every live-timing rule divides or multiplies by it.
  function targetOf(pl) {
    if (isNum(pl.targetDuration) && pl.targetDuration > 0) return pl.targetDuration;
    var max = 0;
    for (var i = 0; i < pl.segments.length; i++) if (isNum(pl.segments[i].duration) && pl.segments[i].duration > max) max = pl.segments[i].duration;
    return max > 0 ? Math.ceil(max) : DEFAULT_TARGET_DURATION;
  }
  function holdBackOf(pl) { return pl.serverControl && isNum(pl.serverControl.holdBack) && pl.serverControl.holdBack > 0 ? pl.serverControl.holdBack : 0; }
  function textInput(text) {
    if (typeof text === 'string') return text;
    if (text && ArrayBuffer.isView(text)) return UTIL.textOf(new Uint8Array(text.buffer, text.byteOffset, text.byteLength));
    if (Object.prototype.toString.call(text) === '[object ArrayBuffer]') return UTIL.textOf(new Uint8Array(text));
    return null;
  }

  /* ---------- attribute lists (RFC 8216 §4.2) ---------- */
  function convertAttr(name, value, quoted) {
    if (name === 'CODECS') return value.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
    var res = /^(\d+)x(\d+)$/i.exec(value);
    if (name === 'RESOLUTION' && res) return { width: +res[1], height: +res[2] };
    if (quoted) return value;
    if (/^0x[0-9a-f]+$/i.test(value)) return value;          // hex stays text: IVs are 128-bit, far beyond a double
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value;
  }
  // "NAME=value,NAME="quoted, with comma",…" → object. Tolerant: whitespace, missing close quote, junk tokens.
  function hlsParseAttributes(input) {
    var out = {};
    if (typeof input !== 'string') return out;
    var s = input, i = 0, n = s.length;
    while (i < n) {
      while (i < n && (s[i] === ',' || s[i] === ' ' || s[i] === '\t')) i++;
      if (i >= n) break;
      var j = i;
      while (j < n && s[j] !== '=' && s[j] !== ',') j++;
      if (j >= n || s[j] === ',') { i = j; continue; }     // token without '=' is not an attribute
      var name = s.slice(i, j).trim().toUpperCase();
      i = j + 1;
      while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
      var value, quoted = false;
      if (s[i] === '"') {
        var close = s.indexOf('"', i + 1);
        if (close === -1) close = n;
        value = s.slice(i + 1, close); quoted = true;
        var comma = s.indexOf(',', close + 1);
        i = comma === -1 ? n : comma + 1;
      } else {
        var end = s.indexOf(',', i);
        if (end === -1) end = n;
        value = s.slice(i, end).trim();
        i = end + 1;
      }
      if (name) out[name] = convertAttr(name, value, quoted);
    }
    return out;
  }
  function codecList(v) {
    if (Array.isArray(v)) return v.filter(function (c) { return typeof c === 'string' && c; });
    if (typeof v === 'string') return convertAttr('CODECS', v, true);
    return [];
  }
  function resolutionOf(v) { return v && isNum(v.width) && isNum(v.height) ? { width: v.width, height: v.height } : null; }
  // "<n>[@<o>]" (EXT-X-BYTERANGE tag value and BYTERANGE attribute).
  function parseByteRange(v) {
    var m = /^\s*(\d+)\s*(?:@\s*(\d+)\s*)?$/.exec(String(v == null ? '' : v));
    return m ? { length: +m[1], offset: m[2] === undefined ? null : +m[2] } : null;
  }
  function queryParam(url, name) {
    var p = UTIL.splitUrl(url), parts = p && p.query ? p.query.slice(1).split('&') : [];
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if ((eq === -1 ? parts[i] : parts[i].slice(0, eq)) === name) return eq === -1 ? '' : parts[i].slice(eq + 1);
    }
    return null;
  }

  /* ---------- playlist parser ---------- */
  function hlsParse(text, baseUrl, opts) {
    opts = opts || {};
    var base = typeof baseUrl === 'string' ? baseUrl.trim() : '';
    var errors = [], overflow = 0, unsupported = [], unknownTags = [], vars = {};
    function err(lineNo, msg) { if (errors.length < MAX_ERRORS) errors.push((lineNo ? 'line ' + lineNo + ': ' : '') + msg); else overflow++; }
    function note(what) { if (unsupported.indexOf(what) === -1) unsupported.push(what); }
    function resolve(uri) { return base ? UTIL.resolveUrl(base, uri) : uri; }
    function invalid(why) { return { kind: 'invalid', url: base || null, errors: [why].concat(errors) }; }

    var src = textInput(text);
    if (src === null) return invalid('playlist is not text');
    var lines = src.replace(/^﻿/, '').split(/\r\n|\n|\r/);

    var version = null, independentSegments = false, startOffset = null;
    var variants = [], media = [], iFrameStreams = 0, sessionData = [], sessionKeys = [];
    var targetDuration = null, mediaSequence = 0, discontinuitySequence = 0, playlistType = null, endList = false, iFramesOnly = false;
    var segments = [], serverControl = null, partInf = null, partCount = 0, preloadHints = [], renditionReports = [], skippedSegments = 0, dateRanges = [];
    var sawMasterTags = false, sawMediaTags = false;
    // Tags apply to the NEXT URI line (EXTINF, BYTERANGE, …) or to every following segment (KEY, MAP, BITRATE).
    var pendingStreamInf = null, pendingInf = null, pendingByteRange = null, pendingDisc = false, pendingGap = false, pendingPdt = null;
    var key = null, map = null, bitrate = null, discCount = 0, nextPdt = null, clock = 0, lastSeg = null;

    function substitute(s, lineNo) {
      if (s.indexOf('{$') === -1) return s;
      return s.replace(VAR_RE, function (m, name) {
        if (hasOwn(vars, name)) return vars[name];
        err(lineNo, 'undefined variable {$' + name + '}');
        return m;
      });
    }
    function parseIv(v, lineNo) {
      if (v === undefined) return null;
      var s = String(v);
      if (!/^0x[0-9a-f]+$/i.test(s)) { err(lineNo, 'EXT-X-KEY IV is not a hex value'); return null; }
      var hex = s.slice(2);
      if (hex.length !== 32) err(lineNo, 'EXT-X-KEY IV is ' + (hex.length * 4) + '-bit, expected 128');
      // Read it as one big-endian 128-bit integer: short values are zero-extended, long ones keep the low bits.
      return UTIL.bytesOfHex(('00000000000000000000000000000000' + hex).slice(-32));
    }
    // Returns a key object, null for METHOD=NONE, or undefined when the tag is unusable.
    function parseKey(a, lineNo, tag) {
      var method = String(a.METHOD == null ? '' : a.METHOD).toUpperCase();
      if (!method) { err(lineNo, tag + ' without METHOD'); return undefined; }
      if (method === 'NONE') return null;
      var uri = typeof a.URI === 'string' ? a.URI : '';
      if (!uri) err(lineNo, tag + ' without URI');
      var keyFormat = str(a.KEYFORMAT) || 'identity';
      if (method !== 'AES-128') note(method);
      if (keyFormat !== 'identity') note('KEYFORMAT ' + keyFormat);
      return { method: method, uri: uri, url: uri ? resolve(uri) : null, iv: parseIv(a.IV, lineNo), keyFormat: keyFormat, keyFormatVersions: str(a.KEYFORMATVERSIONS) || '1' };
    }
    function parseDateRange(a, lineNo) {
      var id = str(a.ID), startDate = a['START-DATE'] === undefined ? null : UTIL.parseDate(a['START-DATE']);
      if (!id) { err(lineNo, 'EXT-X-DATERANGE without ID'); return; }
      if (startDate === null) { err(lineNo, 'EXT-X-DATERANGE without a valid START-DATE'); return; }
      var endDate = a['END-DATE'] === undefined ? null : UTIL.parseDate(a['END-DATE']);
      var known = { ID: 1, CLASS: 1, 'START-DATE': 1, 'END-DATE': 1, DURATION: 1, 'PLANNED-DURATION': 1, 'END-ON-NEXT': 1 }, attrs = {};
      Object.keys(a).forEach(function (k) { if (!known[k]) attrs[k] = a[k]; });
      dateRanges.push({ id: id, class: str(a.CLASS), startDate: startDate, endDate: endDate, duration: num(a.DURATION), plannedDuration: num(a['PLANNED-DURATION']), endOnNext: yes(a['END-ON-NEXT']), attrs: attrs });
    }
    function define(a, lineNo) {
      if (a.NAME !== undefined) {
        var name = String(a.NAME);
        if (!/^[A-Za-z0-9_-]+$/.test(name)) err(lineNo, 'EXT-X-DEFINE has an invalid NAME');
        else if (hasOwn(vars, name)) err(lineNo, 'EXT-X-DEFINE redefines ' + name);
        else if (a.VALUE === undefined) err(lineNo, 'EXT-X-DEFINE without VALUE');
        else vars[name] = String(a.VALUE);
      } else if (a.IMPORT !== undefined) {
        var im = String(a.IMPORT);
        if (opts.variables && hasOwn(opts.variables, im)) vars[im] = String(opts.variables[im]);
        else { note('EXT-X-DEFINE IMPORT'); err(lineNo, 'EXT-X-DEFINE IMPORT="' + im + '" has no value (pass the master playlist variables)'); }
      } else if (a.QUERYPARAM !== undefined) {
        var qp = String(a.QUERYPARAM), qv = queryParam(base, qp);
        if (qv !== null) vars[qp] = qv;
        else { note('EXT-X-DEFINE QUERYPARAM'); err(lineNo, 'EXT-X-DEFINE QUERYPARAM="' + qp + '" is not in the playlist URL'); }
      } else err(lineNo, 'EXT-X-DEFINE without NAME, IMPORT or QUERYPARAM');
    }
    function emitVariant(uri, lineNo) {
      var a = pendingStreamInf, bw = num(a.BANDWIDTH);
      pendingStreamInf = null;
      if (bw === null) { err(lineNo, 'EXT-X-STREAM-INF without BANDWIDTH'); bw = 0; }
      variants.push({
        uri: uri, url: resolve(uri), bandwidth: bw, averageBandwidth: num(a['AVERAGE-BANDWIDTH']), codecs: codecList(a.CODECS),
        resolution: resolutionOf(a.RESOLUTION), frameRate: num(a['FRAME-RATE']), audioGroup: str(a.AUDIO), subtitlesGroup: str(a.SUBTITLES),
        name: str(a.NAME), videoRange: str(a['VIDEO-RANGE']), index: variants.length
      });
    }
    function emitSegment(uri, lineNo) {
      var duration = pendingInf.duration, byteRange = null;
      if (pendingByteRange) {
        var offset = pendingByteRange.offset;
        if (offset === null) {
          // RFC 8216 §4.3.2.2: no offset means "right after the previous segment's range".
          if (lastSeg && lastSeg.byteRange) offset = lastSeg.byteRange.offset + lastSeg.byteRange.length;
          else { err(lineNo, 'EXT-X-BYTERANGE without offset and no previous byte range'); offset = 0; }
        }
        byteRange = { offset: offset, length: pendingByteRange.length };
      }
      var pdt = pendingPdt !== null ? pendingPdt : nextPdt;
      var seg = {
        seq: mediaSequence + skippedSegments + segments.length, uri: uri, url: resolve(uri), duration: duration, title: pendingInf.title,
        discontinuity: pendingDisc, discSeq: discontinuitySequence + discCount, byteRange: byteRange, map: map, key: key,
        programDateTime: pdt, start: clock, end: clock + duration, gap: pendingGap, bitrate: bitrate
      };
      segments.push(seg);
      clock = seg.end;
      nextPdt = pdt === null ? null : pdt + duration * 1000;
      lastSeg = seg;
      pendingInf = null; pendingByteRange = null; pendingDisc = false; pendingGap = false; pendingPdt = null;
    }
    function tag(name, value, lineNo) {
      var a;
      switch (name) {
        case 'EXTM3U': break;
        case 'EXT-X-VERSION':
          if (version !== null) err(lineNo, 'EXT-X-VERSION appears more than once');
          else if (!/^\d+$/.test(value.trim())) err(lineNo, 'EXT-X-VERSION is not an integer');
          else version = +value.trim();
          break;
        case 'EXT-X-INDEPENDENT-SEGMENTS': independentSegments = true; break;
        case 'EXT-X-START':
          a = hlsParseAttributes(value);
          if (num(a['TIME-OFFSET']) === null) err(lineNo, 'EXT-X-START without TIME-OFFSET');
          else startOffset = { timeOffset: a['TIME-OFFSET'], precise: yes(a.PRECISE) };
          break;
        case 'EXT-X-DEFINE': define(hlsParseAttributes(value), lineNo); break;

        /* master */
        case 'EXT-X-STREAM-INF':
          sawMasterTags = true;
          if (pendingStreamInf) err(lineNo - 1, 'EXT-X-STREAM-INF without URI');
          pendingStreamInf = hlsParseAttributes(value);
          break;
        case 'EXT-X-MEDIA':
          sawMasterTags = true;
          a = hlsParseAttributes(value);
          var type = str(a.TYPE), groupId = str(a['GROUP-ID']);
          if (!type || !groupId) { err(lineNo, 'EXT-X-MEDIA without TYPE or GROUP-ID'); break; }
          if (a.NAME === undefined) err(lineNo, 'EXT-X-MEDIA without NAME');
          var muri = str(a.URI), ch = parseInt(String(a.CHANNELS == null ? '' : a.CHANNELS), 10);
          media.push({
            type: type.toUpperCase(), groupId: groupId, name: str(a.NAME) || '', language: str(a.LANGUAGE), isDefault: yes(a.DEFAULT),
            autoselect: yes(a.AUTOSELECT), forced: yes(a.FORCED), uri: muri, url: muri ? resolve(muri) : null, channels: isNum(ch) ? ch : null
          });
          break;
        case 'EXT-X-I-FRAME-STREAM-INF': sawMasterTags = true; iFrameStreams++; break;
        case 'EXT-X-SESSION-DATA':
          sawMasterTags = true;
          a = hlsParseAttributes(value);
          if (!str(a['DATA-ID'])) { err(lineNo, 'EXT-X-SESSION-DATA without DATA-ID'); break; }
          if (a.VALUE === undefined && !str(a.URI)) err(lineNo, 'EXT-X-SESSION-DATA without VALUE or URI');
          sessionData.push({ dataId: String(a['DATA-ID']), value: a.VALUE === undefined ? null : String(a.VALUE), uri: str(a.URI), url: str(a.URI) ? resolve(a.URI) : null, language: str(a.LANGUAGE) });
          break;
        case 'EXT-X-SESSION-KEY':
          sawMasterTags = true;
          var sk = parseKey(hlsParseAttributes(value), lineNo, 'EXT-X-SESSION-KEY');
          if (sk) sessionKeys.push(sk);
          break;

        /* media */
        case 'EXTINF':
          sawMediaTags = true;
          var comma = value.indexOf(','), durText = (comma === -1 ? value : value.slice(0, comma)).trim();
          var dm = /^-?\d+(\.\d+)?/.exec(durText), duration = dm ? Number(dm[0]) : NaN;
          if (!isNum(duration)) { err(lineNo, 'EXTINF without a duration'); duration = targetDuration || 0; }
          else if (duration < 0) { err(lineNo, 'EXTINF duration is negative'); duration = 0; }
          if (pendingInf) err(lineNo - 1, 'EXTINF without URI');
          pendingInf = { duration: duration, title: comma === -1 ? null : str(value.slice(comma + 1).trim()) };
          break;
        case 'EXT-X-TARGETDURATION':
          sawMediaTags = true;
          var td = num(Number(value.trim()));
          if (td === null || td <= 0 || value.trim() === '') err(lineNo, 'EXT-X-TARGETDURATION is not a positive number');
          else targetDuration = Math.ceil(td);
          break;
        case 'EXT-X-MEDIA-SEQUENCE':
        case 'EXT-X-DISCONTINUITY-SEQUENCE':
          sawMediaTags = true;
          if (segments.length) { err(lineNo, name + ' must precede the first segment'); break; }
          if (!/^\d+$/.test(value.trim())) { err(lineNo, name + ' is not an integer'); break; }
          if (name === 'EXT-X-MEDIA-SEQUENCE') mediaSequence = +value.trim(); else discontinuitySequence = +value.trim();
          break;
        case 'EXT-X-PLAYLIST-TYPE':
          sawMediaTags = true;
          var pt = value.trim().toUpperCase();
          if (pt === 'VOD' || pt === 'EVENT') playlistType = pt; else err(lineNo, 'EXT-X-PLAYLIST-TYPE must be VOD or EVENT');
          break;
        case 'EXT-X-ENDLIST': sawMediaTags = true; endList = true; break;
        case 'EXT-X-I-FRAMES-ONLY': sawMediaTags = true; iFramesOnly = true; break;
        case 'EXT-X-BYTERANGE':
          sawMediaTags = true;
          pendingByteRange = parseByteRange(value);
          if (!pendingByteRange) err(lineNo, 'EXT-X-BYTERANGE is not <n>[@<o>]');
          break;
        case 'EXT-X-MAP':
          sawMediaTags = true;
          a = hlsParseAttributes(value);
          if (!str(a.URI)) { err(lineNo, 'EXT-X-MAP without URI'); break; }
          var mbr = a.BYTERANGE === undefined ? null : parseByteRange(a.BYTERANGE);
          if (a.BYTERANGE !== undefined && !mbr) err(lineNo, 'EXT-X-MAP BYTERANGE is not <n>[@<o>]');
          map = { uri: String(a.URI), url: resolve(a.URI), byteRange: mbr ? { offset: mbr.offset === null ? 0 : mbr.offset, length: mbr.length } : null };
          break;
        case 'EXT-X-KEY':
          sawMediaTags = true;
          var k = parseKey(hlsParseAttributes(value), lineNo, 'EXT-X-KEY');
          if (k !== undefined) key = k;
          break;
        case 'EXT-X-DISCONTINUITY': sawMediaTags = true; pendingDisc = true; discCount++; break;
        case 'EXT-X-GAP': sawMediaTags = true; pendingGap = true; break;
        case 'EXT-X-BITRATE':
          sawMediaTags = true;
          var kbps = num(Number(value.trim()));
          if (kbps === null || kbps <= 0 || value.trim() === '') err(lineNo, 'EXT-X-BITRATE is not a positive number'); else bitrate = kbps * 1000;
          break;
        case 'EXT-X-PROGRAM-DATE-TIME':
          sawMediaTags = true;
          var ms = UTIL.parseDate(value.trim());
          if (ms === null) err(lineNo, 'EXT-X-PROGRAM-DATE-TIME is not an ISO 8601 date'); else pendingPdt = ms;
          break;
        case 'EXT-X-DATERANGE': sawMediaTags = true; parseDateRange(hlsParseAttributes(value), lineNo); break;
        case 'EXT-X-SERVER-CONTROL':
          sawMediaTags = true;
          a = hlsParseAttributes(value);
          serverControl = { canSkipUntil: num(a['CAN-SKIP-UNTIL']), canSkipDateRanges: yes(a['CAN-SKIP-DATERANGES']), holdBack: num(a['HOLD-BACK']), partHoldBack: num(a['PART-HOLD-BACK']), canBlockReload: yes(a['CAN-BLOCK-RELOAD']) };
          break;
        case 'EXT-X-PART-INF':
          sawMediaTags = true;
          partInf = { partTarget: num(hlsParseAttributes(value)['PART-TARGET']) };
          note('EXT-X-PART');
          break;
        case 'EXT-X-PART': sawMediaTags = true; partCount++; note('EXT-X-PART'); break;
        case 'EXT-X-PRELOAD-HINT':
          sawMediaTags = true;
          a = hlsParseAttributes(value);
          preloadHints.push({ type: str(a.TYPE), uri: str(a.URI), url: str(a.URI) ? resolve(a.URI) : null, byteRangeStart: num(a['BYTERANGE-START']), byteRangeLength: num(a['BYTERANGE-LENGTH']) });
          note('EXT-X-PRELOAD-HINT');
          break;
        case 'EXT-X-RENDITION-REPORT':
          sawMediaTags = true;
          a = hlsParseAttributes(value);
          renditionReports.push({ uri: str(a.URI), url: str(a.URI) ? resolve(a.URI) : null, lastMsn: num(a['LAST-MSN']), lastPart: num(a['LAST-PART']) });
          break;
        case 'EXT-X-SKIP':
          sawMediaTags = true;
          var skipped = num(hlsParseAttributes(value)['SKIPPED-SEGMENTS']);
          if (segments.length || skipped === null || skipped < 0) err(lineNo, 'EXT-X-SKIP must precede the first segment and carry SKIPPED-SEGMENTS');
          else skippedSegments = Math.floor(skipped);
          note('EXT-X-SKIP');
          break;
        default:
          if (unknownTags.length < MAX_ERRORS && unknownTags.indexOf(name) === -1) unknownTags.push(name);
      }
    }

    var sawHeader = false, first = true;
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim(), lineNo = li + 1;
      if (!line) continue;
      if (first) {
        first = false;
        sawHeader = line.toUpperCase() === '#EXTM3U';
        if (!sawHeader) err(lineNo, 'missing #EXTM3U header');
      }
      if (line.charAt(0) === '#') {
        if (line.slice(0, 4).toUpperCase() !== '#EXT') continue;   // a comment
        var colon = line.indexOf(':');
        var name = (colon === -1 ? line.slice(1) : line.slice(1, colon)).trim().toUpperCase();
        var value = colon === -1 ? '' : line.slice(colon + 1);
        if (name !== 'EXT-X-DEFINE') value = substitute(value, lineNo);
        tag(name, value, lineNo);
        continue;
      }
      var uri = substitute(line, lineNo);
      if (pendingStreamInf) emitVariant(uri, lineNo);
      else if (pendingInf) emitSegment(uri, lineNo);
      else err(lineNo, 'URI without a preceding EXTINF or EXT-X-STREAM-INF: ' + UTIL.truncate(uri, 60));
    }
    if (pendingStreamInf) err(0, 'EXT-X-STREAM-INF without URI at end of playlist');
    if (pendingInf) err(0, 'EXTINF without URI at end of playlist');
    if (variants.length && segments.length) err(0, 'playlist mixes master and media tags');
    if (overflow) errors.push('…and ' + overflow + ' more error' + (overflow === 1 ? '' : 's'));

    if (variants.length) {
      return {
        kind: 'master', url: base || null, errors: errors, version: version === null ? 1 : version, independentSegments: independentSegments,
        variants: variants, media: media, iFrameStreams: iFrameStreams, sessionData: sessionData, sessionKeys: sessionKeys,
        startOffset: startOffset, variables: vars, unsupported: unsupported, unknownTags: unknownTags
      };
    }
    if (segments.length) {
      if (targetDuration === null) { errors.push('missing EXT-X-TARGETDURATION'); targetDuration = targetOf({ segments: segments }); }
      return {
        kind: 'media', url: base || null, errors: errors, version: version === null ? 1 : version, targetDuration: targetDuration,
        mediaSequence: mediaSequence, discontinuitySequence: discontinuitySequence, playlistType: playlistType, endList: endList, live: !endList,
        iFramesOnly: iFramesOnly, independentSegments: independentSegments, segments: segments, totalDuration: clock, startOffset: startOffset,
        encrypted: segments.some(function (s) { return !!s.key; }), unsupported: unsupported, serverControl: serverControl,
        partInf: partInf, partCount: partCount, preloadHints: preloadHints, renditionReports: renditionReports, skippedSegments: skippedSegments,
        dateRanges: dateRanges, variables: vars, unknownTags: unknownTags
      };
    }
    return invalid(sawMasterTags ? 'master playlist has no variants' : sawMediaTags ? 'media playlist has no segments' : sawHeader ? 'playlist has no variants or segments' : 'not an HLS playlist');
  }

  /* ---------- variants ---------- */
  function hlsVariantLabel(v) {
    if (!v || typeof v !== 'object') return '–';
    var parts = [], codecs = Array.isArray(v.codecs) ? v.codecs : [];
    var h = v.resolution && isNum(v.resolution.height) && v.resolution.height > 0 ? Math.round(v.resolution.height) : 0;
    if (h) {
      var fps = isNum(v.frameRate) ? Math.round(v.frameRate) : 0;
      parts.push(h + 'p' + (fps > 30 ? fps : ''));     // "1080p60" only when the rate is worth mentioning
    } else if (codecs.length && codecs.every(function (c) { return UTIL.codecKind(c) === 'audio'; })) parts.push('Audio');
    var br = UTIL.formatBitrate(isNum(v.averageBandwidth) && v.averageBandwidth > 0 ? v.averageBandwidth : v.bandwidth);
    if (br !== '–') parts.push(br);
    return parts.length ? parts.join(' · ') : '–';
  }
  function hlsSortVariants(variants) {
    var list = Array.isArray(variants) ? variants.filter(function (v) { return v && typeof v === 'object'; }) : [];
    return UTIL.stableSort(list, function (a, b) {
      var d = (isNum(a.bandwidth) ? a.bandwidth : 0) - (isNum(b.bandwidth) ? b.bandwidth : 0);
      if (d) return d;
      return (a.resolution && isNum(a.resolution.height) ? a.resolution.height : 0) - (b.resolution && isNum(b.resolution.height) ? b.resolution.height : 0);
    });
  }
  // Highest-bandwidth candidate satisfying pred; the first listed wins an exact tie (playlist order is author preference).
  function pick(list, pred) {
    var best = null;
    for (var i = 0; i < list.length; i++) if (pred(list[i]) && (best === null || list[i].bw > best.bw)) best = list[i];
    return best;
  }
  function lowest(list) {
    var best = list[0];
    for (var i = 1; i < list.length; i++) if (list[i].bw < best.bw) best = list[i];
    return best;
  }
  function hlsChooseVariant(variants, opts) {
    var list = Array.isArray(variants) ? variants : (variants && Array.isArray(variants.variants) ? variants.variants : []);
    opts = opts || {};
    var safety = positiveOr(opts.safety, DEFAULT_SAFETY), hysteresis = positiveOr(opts.upHysteresis, DEFAULT_UP_HYSTERESIS);
    var maxHeight = num(opts.maxHeight), maxBandwidth = num(opts.maxBandwidth);
    var supported = typeof opts.supportedCodecs === 'function' ? opts.supportedCodecs : null;
    var all = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v && typeof v === 'object' && isNum(v.bandwidth)) all.push({ i: i, bw: v.bandwidth, h: v.resolution && isNum(v.resolution.height) ? v.resolution.height : null, codecs: codecList(v.codecs) });
    }
    if (!all.length) return -1;
    // Codec support is a hard filter (the decoder cannot be argued with); if it rejects everything we still
    // answer with the lowest so the UI fails on a real append error rather than on nothing.
    var playable = all.filter(function (c) {
      if (!supported || !c.codecs.length) return true;
      try { return supported(c.codecs) !== false; } catch (e) { return true; }
    });
    if (!playable.length) playable = all;
    // Caps are preferences: they never drop below the lowest playable variant.
    var capped = playable.filter(function (c) { return (maxHeight === null || c.h === null || c.h <= maxHeight) && (maxBandwidth === null || c.bw <= maxBandwidth); });
    if (!capped.length) capped = [lowest(playable)];
    var current = null;
    if (isNum(opts.current)) for (var j = 0; j < capped.length; j++) if (capped[j].i === opts.current) current = capped[j];
    var bandwidth = num(opts.bandwidth);
    if (bandwidth === null || bandwidth <= 0) {
      if (current) return current.i;                      // nothing measured yet: no reason to move
      var guess = pick(capped, function (c) { return c.bw <= FIRST_GUESS_BPS; });
      return (guess || lowest(capped)).i;
    }
    var budget = bandwidth * safety;
    var target = pick(capped, function (c) { return c.bw <= budget; }) || lowest(capped);
    if (!current || target.bw <= current.bw) return target.i;   // down-switches are immediate
    if (positiveOr(opts.bufferedSec, 0) >= UP_BUFFER_SEC) return target.i;
    // Step up only as far as the extra headroom allows, so a jittery estimate does not oscillate.
    var up = pick(capped, function (c) { return c.bw > current.bw && c.bw * hysteresis <= budget; });
    return up ? up.i : current.i;
  }

  /* ---------- throughput estimate: duration-weighted EWMA, fast + slow half-lives ---------- */
  function ewmaState(state) {
    var s = state && typeof state === 'object' ? state : {};
    return {
      fastHalfLife: positiveOr(s.fastHalfLife, DEFAULT_FAST_HALF_LIFE), slowHalfLife: positiveOr(s.slowHalfLife, DEFAULT_SLOW_HALF_LIFE),
      fast: isNum(s.fast) ? s.fast : 0, slow: isNum(s.slow) ? s.slow : 0, weight: positiveOr(s.weight, 0), samples: isNum(s.samples) && s.samples > 0 ? Math.floor(s.samples) : 0
    };
  }
  function hlsEwmaCreate(fastSec, slowSec) { return ewmaState({ fastHalfLife: fastSec, slowHalfLife: slowSec }); }
  function hlsEwmaSample(state, bytes, ms) {
    var st = ewmaState(state);
    if (!isNum(bytes) || !isNum(ms) || bytes <= 0 || ms <= 0) return st;   // an aborted or instant fetch tells us nothing
    var sec = ms / 1000, bps = bytes * 8 / sec;
    var af = Math.pow(0.5, sec / st.fastHalfLife), as = Math.pow(0.5, sec / st.slowHalfLife);
    st.fast = af * st.fast + (1 - af) * bps;
    st.slow = as * st.slow + (1 - as) * bps;
    st.weight += sec;
    st.samples += 1;
    return st;
  }
  function hlsEwmaEstimate(state) {
    var st = ewmaState(state);
    if (st.samples < 1 || st.weight <= 0) return null;
    // Divide out the zero start value so the first sample is reported as itself, not as a fraction of it.
    var fast = st.fast / (1 - Math.pow(0.5, st.weight / st.fastHalfLife));
    var slow = st.slow / (1 - Math.pow(0.5, st.weight / st.slowHalfLife));
    return Math.min(fast, slow);
  }

  /* ---------- live timing ---------- */
  function hlsLiveEdge(pl) { return hasSegments(pl) && pl.segments.length ? pl.segments[pl.segments.length - 1].end : 0; }
  function hlsLiveStart(pl, opts) {
    if (!hasSegments(pl) || !pl.segments.length) return 0;
    var holdBack = opts && isNum(opts.holdBack) && opts.holdBack > 0 ? opts.holdBack : holdBackOf(pl);
    var start = hlsLiveEdge(pl) - Math.max(holdBack, LIVE_HOLD_TARGETS * targetOf(pl));
    return Math.max(0, pl.segments[0].start, start);
  }
  // RFC 8216 §6.3.4: wait one target duration after a changed playlist, half of one after an unchanged reload.
  function hlsReloadDelay(prev, next) {
    if (!hasSegments(next)) return MIN_RELOAD_MS;
    var changed = !hasSegments(prev) || lastSeqOf(prev) !== lastSeqOf(next) || prev.segments.length !== next.segments.length || !!prev.endList !== !!next.endList;
    return Math.max(MIN_RELOAD_MS, Math.round(targetOf(next) * (changed ? 1000 : 500)));
  }
  // Put a reloaded playlist on the timeline the player is already using: segments keep the start/end they
  // had before, new ones follow on, so currentTime never jumps when the window slides.
  function hlsMerge(prev, next) {
    if (!hasSegments(next)) return next;
    var out = Object.assign({}, next, { segments: next.segments.map(function (s) { return Object.assign({}, s); }), stale: false, advanced: next.segments.length, jumped: false });
    if (!hasSegments(prev) || !prev.segments.length || !out.segments.length) return out;
    var bySeq = new Map();
    prev.segments.forEach(function (s) { bySeq.set(s.seq, s); });
    var prevLast = prev.segments[prev.segments.length - 1], anchor = -1, anchorStart, i, s, t;
    for (i = 0; i < out.segments.length && anchor === -1; i++) if (bySeq.has(out.segments[i].seq)) anchor = i;
    if (anchor === -1) { anchor = 0; anchorStart = prevLast.end; out.jumped = true; }
    else {
      var shared = bySeq.get(out.segments[anchor].seq);
      anchorStart = shared.start;
      if (Math.abs(shared.duration - out.segments[anchor].duration) > 0.001) out.errors = (out.errors || []).concat(['segment ' + shared.seq + ' changed duration between reloads']);
    }
    for (i = anchor, t = anchorStart; i < out.segments.length; i++) { s = out.segments[i]; s.start = t; s.end = t + s.duration; t = s.end; }
    for (i = anchor - 1, t = anchorStart; i >= 0; i--) { s = out.segments[i]; s.end = t; s.start = t - s.duration; t = s.start; }
    out.stale = out.segments[out.segments.length - 1].seq < prevLast.seq;
    out.advanced = out.stale ? 0 : out.segments.filter(function (x) { return x.seq > prevLast.seq; }).length;
    return out;
  }
  function hlsSegmentAt(pl, t) {
    if (!hasSegments(pl) || !isNum(t)) return -1;
    var segs = pl.segments, lo = 0, hi = segs.length - 1;
    while (lo <= hi) {                                   // starts are ascending: binary search, then check the end
      var mid = (lo + hi) >> 1;
      if (segs[mid].start <= t) lo = mid + 1; else hi = mid - 1;
    }
    for (var i = hi; i >= 0 && segs[i].start <= t; i--) if (t < segs[i].end) return i;
    return -1;
  }
  // The segment after lastSeq, or the oldest one still listed when the player fell out of the live window.
  function hlsNextSegment(pl, lastSeq) {
    if (!hasSegments(pl)) return null;
    if (!isNum(lastSeq)) return pl.segments.length ? pl.segments[0] : null;
    for (var i = 0; i < pl.segments.length; i++) if (pl.segments[i].seq > lastSeq) return pl.segments[i];
    return null;
  }

  /* ---------- buffer maths ---------- */
  // Sorted, cleaned, and merged across sub-tolerance gaps: [[start, end], …].
  function normalizeRanges(buffered) {
    var raw = [];
    if (Array.isArray(buffered)) {
      for (var i = 0; i < buffered.length; i++) {
        var r = buffered[i];
        if (Array.isArray(r) && isNum(r[0]) && isNum(r[1]) && r[1] > r[0]) raw.push([r[0], r[1]]);
        else if (r && typeof r === 'object' && isNum(r.start) && isNum(r.end) && r.end > r.start) raw.push([r.start, r.end]);
      }
    }
    raw.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    for (var j = 0; j < raw.length; j++) {
      var last = out[out.length - 1];
      if (last && raw[j][0] <= last[1] + BUFFER_TOLERANCE) last[1] = Math.max(last[1], raw[j][1]);
      else out.push(raw[j]);
    }
    return out;
  }
  function hlsBufferPlan(o) {
    o = o || {};
    var ranges = normalizeRanges(o.buffered), t = isNum(o.currentTime) ? o.currentTime : 0;
    var target = positiveOr(o.targetBuffer, 30), max = positiveOr(o.maxBuffer, 60);
    var cur = null, next = null, total = 0, i;
    for (i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      total += r[1] - r[0];
      if (r[0] - BUFFER_TOLERANCE <= t && t < r[1]) cur = r;
      else if (r[0] > t && !next) next = r;
    }
    var ahead = cur ? Math.max(0, cur[1] - t) : 0;
    var hole = next ? { start: cur ? cur[1] : t, end: next[0] } : null;
    var cut = t - KEEP_BEHIND_SEC, evictable = ranges.length > 0 && ranges[0][0] < cut;
    // A live stream's past is never replayed from the buffer; VOD keeps it until the whole buffer is too big.
    var evictBefore = evictable && (o.live ? true : total > max) ? cut : null;
    return { action: ahead < target ? 'load' : 'wait', bufferedAhead: UTIL.round(ahead, 3), holeAhead: hole, evictBefore: evictBefore };
  }
  function hlsGapJump(o) {
    o = o || {};
    if (!isNum(o.stalledMs) || o.stalledMs < GAP_JUMP_STALL_MS || !isNum(o.currentTime)) return null;
    if (isNum(o.readyState) && o.readyState >= 3) return null;   // HAVE_FUTURE_DATA: starved of nothing, so not a gap
    var ranges = normalizeRanges(o.buffered), t = o.currentTime;
    for (var i = 0; i < ranges.length; i++) {
      if (ranges[i][0] <= t && t < ranges[i][1] - BUFFER_TOLERANCE) return null;   // media ahead: a decoder stall, not a gap
      if (ranges[i][0] > t) return ranges[i][0] - t <= GAP_JUMP_MAX_AHEAD ? UTIL.round(ranges[i][0] + GAP_JUMP_NUDGE, 3) : null;
    }
    return null;
  }
  // RFC 8216 §5.2: without an explicit IV the key's IV is the media sequence number as a 128-bit big-endian integer.
  function hlsKeyIv(key, seq) {
    var iv = new Uint8Array(16);
    if (key && key.iv && key.iv.length === 16) {
      for (var i = 0; i < 16; i++) iv[i] = key.iv[i] & 0xff;
      return iv;
    }
    UTIL.writeU64be(iv, 8, isNum(seq) && seq > 0 ? Math.floor(seq) : 0);
    return iv;
  }
  function hlsTimestampOffset(o) {
    o = o || {};
    var start = isNum(o.segmentStart) ? o.segmentStart : 0;
    if (!isNum(o.firstDts) || !isNum(o.timescale) || o.timescale <= 0) return start;
    return start - o.firstDts / o.timescale;
  }

  /* ---------- renditions ---------- */
  function langOf(r) { return String(r.language == null ? '' : r.language).toLowerCase(); }
  function primaryLang(l) { return l.split('-')[0]; }
  function preferDefault(list) {
    for (var i = 0; i < list.length; i++) if (list[i].isDefault) return list[i];
    for (var j = 0; j < list.length; j++) if (list[j].autoselect) return list[j];
    return list[0];
  }
  function hlsSelectAudioRendition(media, variant, opts) {
    var list = Array.isArray(media) ? media : (media && Array.isArray(media.media) ? media.media : []);
    var group = variant && variant.audioGroup != null && variant.audioGroup !== '' ? String(variant.audioGroup) : null;
    if (!group) return null;
    var cands = list.filter(function (r) { return r && typeof r === 'object' && String(r.type).toUpperCase() === 'AUDIO' && r.groupId === group; });
    if (!cands.length) return null;
    var lang = opts && opts.language ? String(opts.language).toLowerCase() : '';
    if (lang) {
      // AUTOSELECT=NO renditions are only for explicit user picks, not language matching (RFC 8216 §4.3.4.1).
      var auto = cands.filter(function (r) { return r.autoselect || r.isDefault; });
      var exact = auto.filter(function (r) { return langOf(r) === lang; });
      var match = exact.length ? exact : auto.filter(function (r) { return langOf(r) && primaryLang(langOf(r)) === primaryLang(lang); });
      if (match.length) return preferDefault(match);
    }
    return preferDefault(cands);
  }
  function hlsLiveStatus(o) {
    o = o || {};
    var pl = o.playlist;
    if (!hasSegments(pl) || pl.endList) return { latencySec: 0, behindLive: false, stalledPlaylist: false };
    var td = targetOf(pl), t = isNum(o.currentTime) ? o.currentTime : 0;
    // The edge we know is as old as the last reload; the real one has moved on by that much.
    var elapsed = isNum(o.now) && isNum(o.lastReloadAt) ? Math.max(0, o.now - o.lastReloadAt) / 1000 : 0;
    var latency = Math.max(0, hlsLiveEdge(pl) + elapsed - t);
    var hold = Math.max(holdBackOf(pl), LIVE_HOLD_TARGETS * td);
    return { latencySec: UTIL.round(latency, 3), behindLive: latency > hold + 2 * td, stalledPlaylist: elapsed > LIVE_HOLD_TARGETS * td };
  }

  return {
    hlsParseAttributes: hlsParseAttributes, hlsParse: hlsParse,
    hlsVariantLabel: hlsVariantLabel, hlsSortVariants: hlsSortVariants, hlsChooseVariant: hlsChooseVariant,
    hlsEwmaCreate: hlsEwmaCreate, hlsEwmaSample: hlsEwmaSample, hlsEwmaEstimate: hlsEwmaEstimate,
    hlsLiveEdge: hlsLiveEdge, hlsLiveStart: hlsLiveStart, hlsReloadDelay: hlsReloadDelay, hlsMerge: hlsMerge,
    hlsSegmentAt: hlsSegmentAt, hlsNextSegment: hlsNextSegment, hlsBufferPlan: hlsBufferPlan, hlsGapJump: hlsGapJump,
    hlsKeyIv: hlsKeyIv, hlsTimestampOffset: hlsTimestampOffset, hlsSelectAudioRendition: hlsSelectAudioRendition, hlsLiveStatus: hlsLiveStatus
  };
})();

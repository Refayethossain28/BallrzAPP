/* ===== PODCAST: tolerant XML, RSS/Atom podcast feeds, the open directory (iTunes Search), OPML ===== */
var PODCAST = (function () {
  'use strict';

  var MAX_DEPTH = 256;          // real feeds nest ~6 deep; a document thousands deep is an attack, not a feed
  var MAX_ERRORS = 100;         // enough to diagnose a feed; a document that is nothing but errors must not allocate per byte
  var MAX_DESCRIPTION = 20000;  // show notes run to a few KB; anything bigger is junk the UI would truncate anyway
  var MAX_TITLE = 500;
  var MAX_CATEGORIES = 20;
  var MAX_URL = 2048;
  var ITUNES = 'https://itunes.apple.com';
  var MS_DURATION_THRESHOLD = 7 * 24 * 3600;  // no episode lasts a week: a bigger plain number is milliseconds (a known generator bug)

  /* ---------- small coercions: feeds and callers send anything ---------- */
  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function str(v) { return typeof v === 'string' ? v : (typeof v === 'number' && isFinite(v)) ? String(v) : ''; }
  function text(v, max) { return UTIL.collapseWs(str(v)).slice(0, max || MAX_TITLE); }
  function num(v, dflt) {
    if (typeof v === 'string') v = v.trim() === '' ? NaN : Number(v);
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }
  function localName(name) { name = str(name); return name.slice(name.lastIndexOf(':') + 1).toLowerCase(); }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /* ---------- entities ---------- */
  // The XML five, the whole Latin-1 block (U+00A0..U+00FF in order) and the punctuation/symbol names that
  // actually turn up in show notes. Unknown names are left as written: guessing would corrupt the text.
  var LATIN1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
    'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
    'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');
  var ENTITIES = {
    amp: 38, lt: 60, gt: 62, quot: 34, apos: 39,
    OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402, circ: 710, tilde: 732,
    ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207,
    ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222,
    dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249, rsaquo: 8250,
    oline: 8254, frasl: 8260, euro: 8364, trade: 8482, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596,
    minus: 8722, infin: 8734, ne: 8800, le: 8804, ge: 8805, hearts: 9829
  };
  LATIN1.forEach(function (name, i) { ENTITIES[name] = 160 + i; });
  // Numeric references in 0x80-0x9F are Windows-1252 in every real feed (&#146; for an apostrophe is endemic);
  // browsers remap them the same way (HTML spec "numeric character reference end state").
  var CP1252 = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
  var ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{0,31}));/g;
  function codePointChar(cp) {
    if (cp >= 0x80 && cp <= 0x9F) cp = CP1252[cp - 0x80];
    if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF) || cp > 0x10FFFF) return '\uFFFD';
    return String.fromCodePoint(cp);
  }
  function decodeEntities(s) {
    s = str(s);
    if (s.indexOf('&') === -1) return s;
    return s.replace(ENTITY_RE, function (m, hex, dec, name) {
      if (hex) return codePointChar(parseInt(hex, 16));
      if (dec) return codePointChar(parseInt(dec, 10));
      return hasOwn(ENTITIES, name) ? String.fromCodePoint(ENTITIES[name]) : m;
    });
  }

  /* ---------- XML: a tolerant tokenizer + tree builder ---------- */
  // Node shape: {name, attrs, children, text}. Text runs are '#text' children (so mixed content keeps its order)
  // and `text` on an element is its direct text, concatenated. Names keep their namespace prefix as written.
  var NAME_RE = /[A-Za-z_:\u00C0-\uD7FF\uF900-\uFFFD][-.0-9A-Za-z_:\u00B7\u00C0-\uD7FF\uF900-\uFFFD]*/y;
  var ATTR_NAME_RE = /[^\s"'<>\/=]+/y;
  var UNQUOTED_RE = /[^\s>]*/y;
  var WS_RE = /\s*/y;
  function sticky(re, s, at) { re.lastIndex = at; var m = re.exec(s); return m ? m[0] : null; }
  function makeNode(name) { return { name: name, attrs: {}, children: [], text: '' }; }
  function isElement(node) { return isObj(node) && typeof node.name === 'string' && node.name.charAt(0) !== '#' && Array.isArray(node.children); }
  function sameName(a, b) { return a === b || a.toLowerCase() === b.toLowerCase(); }
  // Bytes are recognised by shape, not `instanceof`: a fetch() body or a test fixture may come from another realm.
  function textInput(input) {
    if (typeof input === 'string') return input;
    var tag = Object.prototype.toString.call(input);
    if (tag === '[object Uint8Array]') return UTIL.textOf(input);
    if (tag === '[object ArrayBuffer]') return UTIL.textOf(new Uint8Array(input));
    return null;
  }

  function xmlParse(input) {
    var text = textInput(input);
    if (text === null) return { ok: false, root: null, errors: ['input is not text'] };
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');
    var n = text.length, i = 0;
    var errors = [], suppressed = 0, lineNo = 1, linePos = 0;
    var doc = makeNode('#document'), stack = [doc];
    var depthWarned = false;

    // Errors arrive in document order, so one forward scan serves every line-number lookup.
    function err(at, msg) {
      if (errors.length >= MAX_ERRORS) { suppressed++; return; }
      for (var nl = text.indexOf('\n', linePos); nl !== -1 && nl < at; nl = text.indexOf('\n', linePos)) { lineNo++; linePos = nl + 1; }
      linePos = at;
      errors.push('line ' + lineNo + ': ' + msg);
    }
    function parent() { return stack[stack.length - 1]; }
    function addText(s) {
      if (!s) return;
      var p = parent(), last = p.children[p.children.length - 1];
      if (last && last.name === '#text') last.text += s;
      else p.children.push({ name: '#text', attrs: {}, children: [], text: s });
      p.text += s;
    }
    // Pop every element above stack[k] as unclosed, then stack[k] itself (the one a close tag matched).
    function unwind(k, at, why) {
      for (var d = stack.length - 1; d > k; d--) err(at, 'unclosed <' + stack[d].name + '> ' + why);
      stack.length = k;
    }
    function findOpen(name) {
      var d;
      for (d = stack.length - 1; d >= 1; d--) if (stack[d].name === name) return d;
      for (d = stack.length - 1; d >= 1; d--) if (sameName(stack[d].name, name)) return d;
      return -1;
    }
    // '<!DOCTYPE ...>' (with an optional [internal subset]) or any other '<!...>' declaration: skipped whole.
    // Custom entities declared in the subset are not expanded; a reference to one stays literal.
    function skipDeclaration(at) {
      var j = at + 2, depth = 0, quote = '', isDoctype = /^<!doctype/i.test(text.substr(at, 9));
      while (j < n) {
        var ch = text.charAt(j);
        if (quote) { if (ch === quote) quote = ''; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '[') depth++;
        else if (ch === ']') depth--;
        else if (ch === '>' && depth <= 0) break;
        j++;
      }
      if (j >= n) { err(at, 'unterminated ' + (isDoctype ? 'DOCTYPE' : 'markup declaration')); return n; }
      if (!isDoctype) err(at, 'unexpected markup declaration skipped');
      return j + 1;
    }
    function closeTag(at) {
      var name = sticky(NAME_RE, text, at + 2);
      var gt = text.indexOf('>', at + 2), nextLt = text.indexOf('<', at + 2), end;
      if (gt === -1 || (nextLt !== -1 && nextLt < gt)) { err(at, 'malformed close tag'); end = nextLt === -1 ? n : nextLt; }
      else end = gt + 1;
      if (name === null) { err(at, 'close tag without a name ignored'); return end; }
      var k = findOpen(name);
      if (k < 1) { err(at, 'stray </' + name + '> ignored'); return end; }
      unwind(k, at, 'closed by </' + name + '>');
      return end;
    }
    function openTag(at, name) {
      var j = at + 1 + name.length, attrs = {}, selfClosing = false, done = false;
      while (j < n) {
        j += sticky(WS_RE, text, j).length;
        if (j >= n) break;
        var ch = text.charAt(j);
        if (ch === '>') { j++; done = true; break; }
        if (ch === '/' && text.charAt(j + 1) === '>') { j += 2; done = true; selfClosing = true; break; }
        if (ch === '<') { err(j, 'unclosed start tag <' + name + '>'); done = true; break; }  // the '<' belongs to the next token
        var an = sticky(ATTR_NAME_RE, text, j);
        if (an === null) { err(j, 'unexpected "' + ch + '" in <' + name + '> skipped'); j++; continue; }
        j += an.length;
        j += sticky(WS_RE, text, j).length;
        var value = '';
        if (text.charAt(j) === '=') {
          j++;
          j += sticky(WS_RE, text, j).length;
          var q = text.charAt(j);
          if (q === '"' || q === "'") {
            var e = text.indexOf(q, j + 1), raw = e === -1 ? null : text.slice(j + 1, e);
            if (raw === null || raw.indexOf('<') !== -1) {
              // An unbalanced quote would swallow the rest of the document. XML forbids '<' inside a value, so
              // the first '<' or '>' after the quote is a far more likely end of this tag than the next quote.
              err(j, 'unterminated attribute value in <' + name + '>');
              var stop = j + 1;
              while (stop < n && text.charAt(stop) !== '<' && text.charAt(stop) !== '>') stop++;
              value = text.slice(j + 1, stop); j = stop;
            } else { value = raw; j = e + 1; }
          } else { value = sticky(UNQUOTED_RE, text, j); j += value.length; }
        }
        if (an === '__proto__') err(j, 'attribute __proto__ ignored');
        else if (hasOwn(attrs, an)) err(j, 'duplicate attribute ' + an + ' in <' + name + '> ignored');
        else attrs[an] = decodeEntities(value);
      }
      if (!done) err(at, 'unclosed start tag <' + name + '> at end of input');
      var el = makeNode(name);
      el.attrs = attrs;
      parent().children.push(el);
      if (!selfClosing) {
        if (stack.length - 1 < MAX_DEPTH) stack.push(el);
        else if (!depthWarned) { depthWarned = true; err(at, 'nesting deeper than ' + MAX_DEPTH + '; deeper elements kept empty'); }
      }
      return j;
    }

    while (i < n) {
      var lt = text.indexOf('<', i);
      if (lt === -1) { addText(decodeEntities(text.slice(i))); break; }
      if (lt > i) addText(decodeEntities(text.slice(i, lt)));
      i = lt;
      var c = text.charAt(i + 1), name;
      if (c === '!') {
        if (text.startsWith('<!--', i)) {
          var ce = text.indexOf('-->', i + 4);
          if (ce === -1) { err(i, 'unterminated comment'); i = n; } else i = ce + 3;
        } else if (text.startsWith('<![CDATA[', i)) {
          var de = text.indexOf(']]>', i + 9);
          if (de === -1) { err(i, 'unterminated CDATA section'); addText(text.slice(i + 9)); i = n; }
          else { addText(text.slice(i + 9, de)); i = de + 3; }
        } else i = skipDeclaration(i);
      } else if (c === '?') {
        var pe = text.indexOf('?>', i + 2);
        if (pe === -1) { err(i, 'unterminated processing instruction'); var g = text.indexOf('>', i + 2); i = g === -1 ? n : g + 1; }
        else i = pe + 2;
      } else if (c === '/') {
        i = closeTag(i);
      } else if ((name = sticky(NAME_RE, text, i + 1)) !== null) {
        i = openTag(i, name);
      } else {
        err(i, 'stray "<" treated as text');
        addText('<');
        i++;
      }
    }
    for (var d = stack.length - 1; d >= 1; d--) err(n, 'unclosed <' + stack[d].name + '> at end of input');

    var roots = doc.children.filter(isElement);
    if (!roots.length) {
      errors.push(text.trim() ? 'no root element' : 'empty document');
      return { ok: false, root: null, errors: errors };
    }
    if (roots.length > 1) errors.push('content after the root element ignored');
    if (suppressed) errors.push(suppressed + ' more error(s) not shown');
    return { ok: true, root: roots[0], errors: errors };
  }

  function xmlChildren(node, name) {
    if (!isObj(node) || !Array.isArray(node.children)) return [];
    var want = name == null ? null : str(name);
    return node.children.filter(function (c) { return isElement(c) && (want === null || sameName(c.name, want)); });
  }
  function xmlChild(node, name) {
    if (!isObj(node) || !Array.isArray(node.children)) return null;
    var want = str(name);
    for (var k = 0; k < node.children.length; k++) {
      var c = node.children[k];
      if (isElement(c) && sameName(c.name, want)) return c;
    }
    return null;
  }
  function deepText(node, depth) {
    if (!Array.isArray(node.children) || !node.children.length || depth > MAX_DEPTH) return str(node.text);
    var s = '';
    for (var k = 0; k < node.children.length; k++) {
      var c = node.children[k];
      if (isObj(c)) s += c.name === '#text' ? str(c.text) : deepText(c, depth + 1);
    }
    return s;
  }
  function xmlText(node) {
    if (typeof node === 'string') return node.trim();
    return isObj(node) ? deepText(node, 0).trim() : '';
  }
  // Attribute lookup that forgives case (xmlUrl / xmlurl / XMLURL all occur in OPML files in the wild).
  function attr(node, name) {
    if (!isObj(node) || !isObj(node.attrs)) return '';
    if (hasOwn(node.attrs, name)) return str(node.attrs[name]);
    var keys = Object.keys(node.attrs);
    for (var k = 0; k < keys.length; k++) if (sameName(keys[k], name)) return str(node.attrs[keys[k]]);
    return '';
  }
  // The markup inside an element, rebuilt from the tree: text as text, child elements as tags. This is what
  // a description that contained raw (unescaped) HTML looked like before the XML parser saw it.
  function innerMarkup(node, depth) {
    var s = '';
    for (var k = 0; k < node.children.length; k++) {
      var c = node.children[k];
      if (!isObj(c)) continue;
      if (c.name === '#text') s += str(c.text);
      else if (isElement(c)) s += c.children.length && depth < MAX_DEPTH ? '<' + c.name + '>' + innerMarkup(c, depth + 1) + '</' + c.name + '>' : '<' + c.name + '/>';
    }
    return s;
  }

  /* ---------- HTML → plain text ---------- */
  var BLOCK_RE = /<\/?(?:p|div|br|ul|ol|h[1-6]|blockquote|pre|tr|table|thead|tbody|tfoot|section|article|header|footer|hr|dd|dt|dl|figure|figcaption|address|aside|nav|main|center|form|fieldset|details|summary|caption)\b[^>]*>/gi;
  function stripHtml(html) {
    var s = str(html);
    if (!s) return '';
    s = s.replace(/\r\n?/g, '\n')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<\/br\s*>/gi, '')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<\/li\s*>/gi, '')
      .replace(/<\/?(?:td|th)\b[^>]*>/gi, ' ')
      .replace(BLOCK_RE, '\n')
      .replace(/<\/?[A-Za-z][^>]*>/g, '');     // a bare '<' followed by a space or digit ("a < b", "<3") is text and survives
    s = decodeEntities(s).replace(/\u00A0/g, ' ');
    return s.replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  // Rich text of a feed element: its content as HTML (escaped or CDATA'd markup is text to the XML parser; raw
  // markup became child elements and is rebuilt), then flattened.
  function richText(node) { return isObj(node) ? stripHtml(innerMarkup(node, 0)).slice(0, MAX_DESCRIPTION) : ''; }

  /* ---------- durations ---------- */
  var CLOCK_RE = /^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2})(?:\.(\d+))?$/;
  var ISO_RE = /^p(?:(\d+)d)?t?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/;
  var WORDS_RE = /^(?:(\d+)\s*h(?:ours?|rs?)?\.?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?\.?)?\s*(?:(\d+)\s*s(?:ec(?:ond)?s?)?\.?)?$/;
  function podcastDurationSeconds(v) {
    if (typeof v === 'number') return isFinite(v) && v >= 0 ? plainSeconds(v) : null;
    var s = str(v).trim().toLowerCase(), m;
    if (!s) return null;
    if ((m = /^(\d+(?:\.\d+)?)$/.exec(s))) return plainSeconds(+m[1]);
    if ((m = CLOCK_RE.exec(s))) return UTIL.round((+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +('0.' + m[4]) : 0), 3);
    if ((m = ISO_RE.exec(s)) && (m[1] || m[2] || m[3] || m[4])) return UTIL.round((+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0)), 3);
    if ((m = WORDS_RE.exec(s)) && (m[1] || m[2] || m[3])) return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
    return null;
  }
  function plainSeconds(n) { return UTIL.round(n > MS_DURATION_THRESHOLD ? n / 1000 : n, 3); }

  /* ---------- feed URLs ---------- */
  var FEED_SCHEMES = { feed: 1, itpc: 1, pcast: 1, podcast: 1, rss: 1 };
  var HOST_RE = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9\u00A0-\uFFFF-]+(?:\.[a-z0-9\u00A0-\uFFFF-]+)+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;
  // Canonical form of whatever a person pasted: feed:/itpc:/pcast: → https:, scheme-less → https://, scheme and
  // host lowercased, fragment dropped, empty path → '/'. The same feed must always produce the same key.
  function podcastNormalizeFeedUrl(s) {
    if (typeof s !== 'string') return null;
    s = s.trim().replace(/^<(.+)>$/, '$1').trim();
    if (!s || s.length > MAX_URL || /[\s<>"]/.test(s)) return null;
    var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(s);
    // "example.com:8080/feed" and "localhost:3000/rss" have a colon but no scheme; a scheme has no dot and is
    // not followed by a port number.
    var hasScheme = !!m && (hasOwn(FEED_SCHEMES, m[1].toLowerCase()) || m[2].indexOf('//') === 0 || (m[1].indexOf('.') === -1 && !/^\d/.test(m[2])));
    if (hasScheme) {
      var scheme = m[1].toLowerCase(), rest = m[2];
      if (hasOwn(FEED_SCHEMES, scheme)) s = /^https?:\/\//i.test(rest) ? rest : 'https://' + rest.replace(/^\/+/, '');
      else if (scheme !== 'http' && scheme !== 'https') return null;
    } else s = (s.indexOf('//') === 0 ? 'https:' : 'https://') + s;
    var p = UTIL.splitUrl(s);
    if (!p || !p.scheme || !p.authority) return null;
    var at = p.authority.lastIndexOf('@');
    var userinfo = at === -1 ? '' : p.authority.slice(0, at + 1);
    var host = (at === -1 ? p.authority : p.authority.slice(at + 1)).toLowerCase();
    if (!HOST_RE.test(host)) return null;
    s = p.scheme.toLowerCase() + '//' + userinfo + host + (p.path || '/') + p.query;
    return UTIL.isHttpUrl(s) ? s : null;
  }
  // Does typed input mean "subscribe to this address" rather than "search for these words"? Anything with a
  // scheme is an address; a bare domain is a search unless it carries a path or a feed-ish host label.
  function podcastIsFeedUrl(s) {
    if (typeof s !== 'string') return false;
    s = s.trim();
    if (!s || /\s/.test(s)) return false;
    if (/^([a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(s)) return podcastNormalizeFeedUrl(s) !== null;
    var m = /^(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d{1,5})?(\/\S*)?$/i.exec(s);
    if (!m || podcastNormalizeFeedUrl(s) === null) return false;
    return (m[2] || '').length > 1 || /^(?:feeds?|rss|podcasts?)\./i.test(m[1]);
  }
  function podcastEpisodeKey(feedUrl, ep) {
    var feed = podcastNormalizeFeedUrl(feedUrl) || str(feedUrl).trim();
    var id = typeof ep === 'string' ? ep.trim() : isObj(ep) ? (str(ep.id).trim() || str(ep.url).trim()) : '';
    return feed && id ? 'podcast:' + feed + '#' + id : null;
  }
  function absUrl(base, u) {
    u = str(u).trim();
    if (!u || u.length > MAX_URL) return '';
    if (base) u = UTIL.resolveUrl(base, u);
    return UTIL.isHttpUrl(u) ? u : '';
  }

  /* ---------- feed parsing ---------- */
  var NON_MEDIA_EXT = { pdf: 1, txt: 1, html: 1, htm: 1, jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, svg: 1, vtt: 1, srt: 1, json: 1, xml: 1, zip: 1 };
  var PLAYABLE_APP_TYPES = { 'application/ogg': 1, 'application/x-mpegurl': 1, 'application/vnd.apple.mpegurl': 1, 'application/octet-stream': 1, 'application/mp4': 1 };
  // Many feeds attach transcripts, PDFs and artwork as extra enclosures; those are not episodes.
  function playableType(type, url) {
    var t = str(type).toLowerCase().split(';')[0].trim();
    if (!t) return !hasOwn(NON_MEDIA_EXT, UTIL.extOf(url));
    return t.indexOf('audio/') === 0 || t.indexOf('video/') === 0 || hasOwn(PLAYABLE_APP_TYPES, t);
  }
  function lengthOf(v) { var n = num(v, 0); return n > 0 ? Math.floor(n) : null; }
  function positiveInt(v) { var s = str(v).trim(); return /^\d{1,6}$/.test(s) && +s > 0 ? +s : null; }
  function explicitOf(v) {
    var s = str(v).trim().toLowerCase();
    if (s === 'yes' || s === 'true' || s === 'explicit') return true;
    if (s === 'no' || s === 'false' || s === 'clean') return false;
    return null;
  }
  // "editor@example.com (Jane Doe)" (RSS managingEditor) and "Jane Doe <jane@example.com>" both mean Jane Doe.
  function personName(s) {
    s = text(s);
    var m = /^\S+@\S+\s*\(([^)]+)\)\s*$/.exec(s);
    if (m) return text(m[1]);
    return text(s.replace(/<[^>]*>/g, ''));
  }
  function firstNonEmpty(node, names, fn) {
    for (var k = 0; k < names.length; k++) {
      var kids = xmlChildren(node, names[k]);
      for (var j = 0; j < kids.length; j++) { var v = fn(kids[j]); if (v) return v; }
    }
    return '';
  }
  function plain(node) { return text(stripHtml(xmlText(node))); }
  function hrefOrText(node) { return attr(node, 'href') || attr(node, 'url') || xmlText(xmlChild(node, 'url')) || xmlText(node); }
  function linkOf(node, base) {
    var links = xmlChildren(node, 'link').concat(xmlChildren(node, 'atom:link'));
    for (var k = 0; k < links.length; k++) {
      var l = links[k], rel = attr(l, 'rel').toLowerCase(), u = absUrl(base, xmlText(l));
      if (!u && (rel === '' || rel === 'alternate')) u = absUrl(base, attr(l, 'href'));
      if (u) return u;
    }
    return '';
  }
  function dateOf(node) {
    return firstNonEmpty(node, ['pubDate', 'dc:date', 'published', 'updated', 'issued', 'atom:published', 'atom:updated', 'a10:updated', 'lastBuildDate'], function (c) {
      var t = UTIL.parseDate(xmlText(c));
      return UTIL.isNum(t) ? t : '';
    }) || null;
  }
  // Every element called `name` anywhere below `node`, in document order. An unclosed <item> swallows the items
  // after it as children; walking the whole subtree still finds them.
  function collectItems(node, name, depth) {
    var out = [];
    for (var k = 0; k < node.children.length; k++) {
      var c = node.children[k];
      if (!isElement(c)) continue;
      if (sameName(c.name, name)) out.push(c);
      if (depth < MAX_DEPTH) out = out.concat(collectItems(c, name, depth + 1));
    }
    return out;
  }
  function mediaGroupChildren(item, name) {
    var out = xmlChildren(item, name);
    xmlChildren(item, 'media:group').forEach(function (g) { out = out.concat(xmlChildren(g, name)); });
    return out;
  }
  // Enclosure preference: <enclosure url> → <media:content url> of an audio/video type → link rel=enclosure.
  function enclosureOf(item, base) {
    var candidates = [];
    xmlChildren(item, 'enclosure').forEach(function (e) { candidates.push({ url: attr(e, 'url'), type: attr(e, 'type'), length: attr(e, 'length') }); });
    mediaGroupChildren(item, 'media:content').forEach(function (e) {
      var type = attr(e, 'type'), medium = attr(e, 'medium').toLowerCase();
      if (!type && (medium === 'audio' || medium === 'video')) type = medium + '/*';
      if (!medium || medium === 'audio' || medium === 'video') candidates.push({ url: attr(e, 'url'), type: type, length: attr(e, 'fileSize') });
    });
    xmlChildren(item, 'link').concat(xmlChildren(item, 'atom:link')).forEach(function (l) {
      if (attr(l, 'rel').toLowerCase() === 'enclosure') candidates.push({ url: attr(l, 'href'), type: attr(l, 'type'), length: attr(l, 'length') });
    });
    for (var k = 0; k < candidates.length; k++) {
      var url = absUrl(base, candidates[k].url);
      if (!url || !playableType(candidates[k].type, url)) continue;
      var type = str(candidates[k].type).toLowerCase().split(';')[0].trim();
      if (!type || type.slice(-2) === '/*') type = UTIL.classifyMedia(url).mime || '';
      return { url: url, type: type, length: lengthOf(candidates[k].length) };
    }
    return null;
  }
  function episodeOf(item, base, show) {
    var media = enclosureOf(item, base);
    if (!media) return null;
    var link = linkOf(item, base);
    var guid = xmlChild(item, 'guid');
    // A guid is only a link when it says so and is an absolute address; "ns-003" resolved against the feed is nonsense.
    if (!link && guid && attr(guid, 'isPermaLink').toLowerCase() !== 'false' && UTIL.isHttpUrl(xmlText(guid))) link = absUrl(base, xmlText(guid));
    var id = firstNonEmpty(item, ['guid', 'id'], xmlText) || media.url || link;
    var explicit = explicitOf(firstNonEmpty(item, ['itunes:explicit'], xmlText));
    var episodeType = firstNonEmpty(item, ['itunes:episodeType'], xmlText).toLowerCase();
    return {
      id: text(id, MAX_URL),
      title: firstNonEmpty(item, ['title', 'itunes:title'], plain) || 'Untitled episode',
      description: firstNonEmpty(item, ['content:encoded', 'content', 'itunes:summary', 'description', 'summary', 'itunes:subtitle'], richText),
      url: media.url, type: media.type, length: media.length,
      duration: podcastDurationSeconds(firstNonEmpty(item, ['itunes:duration'], xmlText) || mediaDuration(item)),
      published: dateOf(item),
      image: firstNonEmpty(item, ['itunes:image'], function (c) { return absUrl(base, hrefOrText(c)); })
        || firstNonEmpty(item, ['media:thumbnail'], function (c) { return absUrl(base, attr(c, 'url')); })
        || firstNonEmpty(item, ['media:group'], function (g) { return firstNonEmpty(g, ['media:thumbnail'], function (c) { return absUrl(base, attr(c, 'url')); }); }),
      link: link,
      season: positiveInt(firstNonEmpty(item, ['itunes:season', 'podcast:season'], xmlText)),
      episode: positiveInt(firstNonEmpty(item, ['itunes:episode', 'podcast:episode'], xmlText)),
      explicit: explicit === null ? show.explicit : explicit,
      episodeType: episodeType === 'trailer' || episodeType === 'bonus' ? episodeType : 'full'
    };
  }
  function mediaDuration(item) {
    var all = mediaGroupChildren(item, 'media:content');
    for (var k = 0; k < all.length; k++) if (attr(all[k], 'duration')) return attr(all[k], 'duration');
    return '';
  }
  function categoriesOf(channel) {
    var out = [], seen = {};
    function add(t) { t = text(t, 100); var k = t.toLowerCase(); if (t && !seen[k] && out.length < MAX_CATEGORIES) { seen[k] = 1; out.push(t); } }
    function walk(node, depth) {
      xmlChildren(node, 'itunes:category').forEach(function (c) {
        add(attr(c, 'text') || str(c.text));
        if (depth < 4) walk(c, depth + 1);
      });
    }
    walk(channel, 0);
    if (!out.length) xmlChildren(channel, 'category').forEach(function (c) { add(attr(c, 'term') || attr(c, 'label') || xmlText(c)); });
    return out;
  }
  function feedResult(ok, error, warnings) {
    return { ok: ok, kind: null, title: '', author: '', description: '', image: '', link: '', language: '', categories: [], explicit: false, episodes: [], count: 0, skipped: 0, error: error, warnings: warnings || [] };
  }
  function podcastParseFeed(input, feedUrl) {
    var base = podcastNormalizeFeedUrl(feedUrl) || '';
    var doc = xmlParse(input);
    if (!doc.ok) return feedResult(false, doc.errors[0] || 'not XML', doc.errors);
    var root = doc.root, rn = localName(root.name), kind, channel;
    if (rn === 'html' || rn === 'body' || rn === 'head') return feedResult(false, 'this is a web page, not a podcast feed', doc.errors);
    if (rn === 'rss' || rn === 'rdf') { kind = 'rss'; channel = xmlChild(root, 'channel') || root; }
    else if (rn === 'channel') { kind = 'rss'; channel = root; }
    else if (rn === 'feed') { kind = 'atom'; channel = root; }
    else return feedResult(false, 'not a podcast feed (root element <' + text(root.name, 60) + '>)', doc.errors);

    var out = feedResult(true, null, doc.errors);
    out.kind = kind;
    out.explicit = explicitOf(firstNonEmpty(channel, ['itunes:explicit'], xmlText)) === true;
    out.title = firstNonEmpty(channel, ['title'], plain) || UTIL.urlHost(base) || 'Untitled podcast';
    out.author = firstNonEmpty(channel, ['itunes:author', 'dc:creator', 'managingEditor'], function (c) { return personName(xmlText(c)); })
      || firstNonEmpty(channel, ['author'], function (c) { return personName(xmlText(xmlChild(c, 'name')) || xmlText(c)); })
      || firstNonEmpty(channel, ['itunes:owner'], function (c) { return personName(xmlText(xmlChild(c, 'itunes:name'))); });
    out.description = firstNonEmpty(channel, ['itunes:summary', 'description', 'subtitle', 'itunes:subtitle', 'summary'], richText);
    out.image = firstNonEmpty(channel, ['itunes:image'], function (c) { return absUrl(base, hrefOrText(c)); })
      || firstNonEmpty(channel, ['image'], function (c) { return absUrl(base, xmlText(xmlChild(c, 'url')) || attr(c, 'href') || (xmlChildren(c).length ? '' : xmlText(c))); })
      || firstNonEmpty(channel, ['media:thumbnail'], function (c) { return absUrl(base, attr(c, 'url')); })
      || firstNonEmpty(channel, ['logo', 'icon'], function (c) { return absUrl(base, xmlText(c)); });
    out.link = linkOf(channel, base);
    out.language = text(firstNonEmpty(channel, ['language', 'dc:language'], xmlText) || attr(channel, 'xml:lang') || attr(root, 'xml:lang'), 20).toLowerCase();
    out.categories = categoriesOf(channel);

    var items = collectItems(root, kind === 'atom' ? 'entry' : 'item', 0), seen = {}, episodes = [];
    for (var k = 0; k < items.length; k++) {
      var ep = episodeOf(items[k], base, out);
      if (!ep || seen[ep.id]) { out.skipped++; continue; }
      seen[ep.id] = 1;
      episodes.push(ep);
    }
    out.episodes = UTIL.sortBy(episodes, function (e) { return e.published; }, true);
    out.count = out.episodes.length;
    return out;
  }
  // Same id (falling back to url) is the same episode; the fresh copy wins because feeds correct titles and
  // URLs, while fields only the known copy has survive. Newest first, nulls last, fresh before known on ties.
  function podcastMergeEpisodes(known, fresh) {
    var byKey = new Map(), order = [];
    function keyOf(ep) { return isObj(ep) ? (str(ep.id).trim() || str(ep.url).trim()) : ''; }
    (Array.isArray(fresh) ? fresh : []).forEach(function (ep) {
      var k = keyOf(ep);
      if (!k) return;
      if (byKey.has(k)) byKey.set(k, Object.assign({}, byKey.get(k), ep)); else { byKey.set(k, Object.assign({}, ep)); order.push(k); }
    });
    (Array.isArray(known) ? known : []).forEach(function (ep) {
      var k = keyOf(ep);
      if (!k) return;
      if (byKey.has(k)) byKey.set(k, Object.assign({}, ep, byKey.get(k))); else { byKey.set(k, Object.assign({}, ep)); order.push(k); }
    });
    return UTIL.sortBy(order.map(function (k) { return byKey.get(k); }), function (e) { return UTIL.isNum(e.published) ? e.published : null; }, true);
  }

  /* ---------- the open directory (iTunes Search API: JSON, CORS-enabled, no key) ---------- */
  function itunesSearchUrl(term, opts) {
    term = text(term, 200);
    if (!term) return null;
    opts = isObj(opts) ? opts : {};
    var limit = Math.round(UTIL.clamp(num(opts.limit, 25), 1, 200));
    var country = /^[A-Za-z]{2}$/.test(str(opts.country)) ? opts.country.toUpperCase() : 'GB';
    return ITUNES + '/search?media=podcast&entity=podcast&term=' + encodeURIComponent(term) + '&limit=' + limit + '&country=' + country;
  }
  // Takes a numeric collection id or an Apple Podcasts page URL (…/id1200361736), which people paste.
  function itunesLookupUrl(id) {
    var s = str(id).trim(), m = /^(\d{1,20})$/.exec(s) || /\/id(\d{1,20})(?=[\/?#]|$)/.exec(s);
    return m ? ITUNES + '/lookup?id=' + m[1] + '&entity=podcast' : null;
  }
  // Apple's CDN serves any size: the 100px thumbnail URL re-requested at 600px is the same art, sharper.
  function upscaleArtwork(u) { return str(u).replace(/\/\d+x\d+(?:bb)?(\.[a-z]+)$/i, '/600x600bb$1'); }
  function podcastNormalizeItunes(r) {
    if (!isObj(r)) return null;
    var feedUrl = podcastNormalizeFeedUrl(r.feedUrl);
    if (!feedUrl) return null;
    var id = num(r.collectionId, 0) || num(r.trackId, 0);
    var genre = text(r.primaryGenreName, 100);
    if (!genre && Array.isArray(r.genres)) genre = text(r.genres.filter(function (g) { return str(g) && str(g).toLowerCase() !== 'podcasts'; })[0], 100);
    var count = num(r.trackCount, -1);
    return {
      type: 'show',
      id: id > 0 ? 'itunes:' + Math.floor(id) : 'feed:' + feedUrl,
      title: text(r.collectionName) || text(r.trackName) || UTIL.urlHost(feedUrl),
      author: text(r.artistName),
      feedUrl: feedUrl,
      image: absUrl('', r.artworkUrl600) || absUrl('', upscaleArtwork(r.artworkUrl100)) || absUrl('', r.artworkUrl60),
      genre: genre,
      episodeCount: count >= 0 ? Math.floor(count) : null,
      link: absUrl('', r.collectionViewUrl) || absUrl('', r.trackViewUrl)
    };
  }

  /* ---------- OPML ---------- */
  function opmlParse(input) {
    var doc = xmlParse(input);
    if (!doc.ok) return [];
    var out = [], seen = {};
    function walk(node, depth) {
      xmlChildren(node).forEach(function (c) {
        if (sameName(c.name, 'outline')) {
          var url = podcastNormalizeFeedUrl(attr(c, 'xmlUrl'));
          if (url && !seen[url]) { seen[url] = 1; out.push({ title: text(attr(c, 'text')) || text(attr(c, 'title')) || UTIL.urlHost(url), feedUrl: url }); }
        }
        if (depth < MAX_DEPTH) walk(c, depth + 1);   // folders nest outlines; some exporters nest feeds under feeds
      });
    }
    walk(doc.root, 0);
    return out;
  }
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function rfc822(ms) {
    var d = new Date(ms);
    return DAYS[d.getUTCDay()] + ', ' + pad2(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds()) + ' GMT';
  }
  // XML 1.0 forbids most C0 control characters even when escaped, so they are dropped before escaping.
  function xmlEsc(s) { return UTIL.escapeHTML(str(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')); }
  function opmlBuild(subs, opts) {
    opts = isObj(opts) ? opts : {};
    var lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', '  <head>', '    <title>' + xmlEsc(text(opts.title) || 'Aerial podcast subscriptions') + '</title>'];
    if (UTIL.isNum(opts.now)) lines.push('    <dateCreated>' + rfc822(opts.now) + '</dateCreated>');
    lines.push('  </head>', '  <body>');
    var seen = {};
    (Array.isArray(subs) ? subs : []).forEach(function (s) {
      if (!isObj(s)) return;
      var url = podcastNormalizeFeedUrl(s.feedUrl);
      if (!url || seen[url]) return;
      seen[url] = 1;
      var title = text(s.title) || UTIL.urlHost(url), link = absUrl('', s.link);
      lines.push('    <outline type="rss" text="' + xmlEsc(title) + '" title="' + xmlEsc(title) + '" xmlUrl="' + xmlEsc(url) + '"' + (link ? ' htmlUrl="' + xmlEsc(link) + '"' : '') + '/>');
    });
    lines.push('  </body>', '</opml>', '');
    return lines.join('\n');
  }

  /* ---------- featured shows ---------- */
  // Known public feed URLs of well-known shows, offered as labelled suggestions on first paint. Publishers move
  // feeds without notice and this list cannot be verified from here, so the UI must treat any that fail to load
  // as a dead suggestion (hide it or show the error), never as an app failure.
  function featured(slug, title, author, feedUrl) { return { type: 'show', id: 'featured:' + slug, title: title, author: author, feedUrl: feedUrl, image: '', featured: true }; }
  var PODCAST_FEATURED = [
    featured('planet-money', 'Planet Money', 'NPR', 'https://feeds.npr.org/510289/podcast.xml'),
    featured('hidden-brain', 'Hidden Brain', 'NPR', 'https://feeds.npr.org/510308/podcast.xml'),
    featured('ted-talks-daily', 'TED Talks Daily', 'TED', 'https://feeds.feedburner.com/TEDTalks_audio'),
    featured('the-daily', 'The Daily', 'The New York Times', 'https://feeds.simplecast.com/54nAGcIl'),
    featured('99-percent-invisible', '99% Invisible', 'Roman Mars', 'https://feeds.simplecast.com/BqbsxVfO'),
    featured('radiolab', 'Radiolab', 'WNYC Studios', 'https://feeds.simplecast.com/EmVW7VGp'),
    featured('freakonomics-radio', 'Freakonomics Radio', 'Freakonomics Radio + Stitcher', 'https://feeds.simplecast.com/Y8lFbOT4'),
    featured('darknet-diaries', 'Darknet Diaries', 'Jack Rhysider', 'https://feeds.megaphone.fm/darknetdiaries'),
    featured('science-vs', 'Science Vs', 'Spotify Studios', 'https://feeds.megaphone.fm/sciencevs'),
    featured('the-vergecast', 'The Vergecast', 'The Verge', 'https://feeds.megaphone.fm/vergecast'),
    featured('huberman-lab', 'Huberman Lab', 'Scicomm Media', 'https://feeds.megaphone.fm/hubermanlab'),
    featured('this-american-life', 'This American Life', 'This American Life', 'https://www.thisamericanlife.org/podcast/rss.xml'),
    featured('lex-fridman-podcast', 'Lex Fridman Podcast', 'Lex Fridman', 'https://lexfridman.com/feed/podcast/'),
    featured('syntax', 'Syntax', 'Wes Bos & Scott Tolinski', 'https://feed.syntax.fm/'),
    featured('infinite-monkey-cage', 'The Infinite Monkey Cage', 'BBC Radio 4', 'https://podcasts.files.bbci.co.uk/b00snr0w.rss')
  ];

  return {
    xmlParse: xmlParse, xmlChild: xmlChild, xmlChildren: xmlChildren, xmlText: xmlText,
    podcastParseFeed: podcastParseFeed, podcastDurationSeconds: podcastDurationSeconds, stripHtml: stripHtml,
    itunesSearchUrl: itunesSearchUrl, itunesLookupUrl: itunesLookupUrl, podcastNormalizeItunes: podcastNormalizeItunes,
    podcastNormalizeFeedUrl: podcastNormalizeFeedUrl, podcastIsFeedUrl: podcastIsFeedUrl, podcastEpisodeKey: podcastEpisodeKey,
    opmlParse: opmlParse, opmlBuild: opmlBuild, PODCAST_FEATURED: PODCAST_FEATURED, podcastMergeEpisodes: podcastMergeEpisodes
  };
})();

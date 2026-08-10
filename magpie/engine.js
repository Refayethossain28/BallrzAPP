/**
 * Magpie — the web scraper
 * ========================
 *
 * A real internet scraper built the honest way: everything that makes a
 * scraper a *scraper* — the HTML parser, the CSS selector engine, the
 * repeated-structure detector that finds "the list of things" on a page by
 * itself, the recipe runner that turns a page into rows, table/link/image/
 * metadata harvesters, CSV/JSON/Markdown export, pagination discovery, the
 * Robots Exclusion Protocol, and change-watching diffs — is implemented from
 * scratch in this one pure, deterministic, framework-free file. No cheerio,
 * no DOMParser dependency, no black box: the same HTML + the same recipe
 * always produce the same rows, and every part is unit-tested.
 *
 * The pipeline (what real scrapers do, done honestly at prototype scale)
 * ----------------------------------------------------------------------
 *   1. PARSE     parseHTML() is a from-scratch tolerant HTML parser —
 *                 tokenizer + tree builder with void elements, implied end
 *                 tags (<li>, <td>, <p>, <option>…), rawtext (<script>,
 *                 <style>) and entity decoding, the way browsers cope with
 *                 the real, messy web.
 *   2. SELECT    select() is a CSS selector engine over that tree: tags,
 *                 .classes, #ids, [attr], [attr=v], [attr^=], [attr$=],
 *                 [attr*=], compound selectors, descendant and > child
 *                 combinators, :first-child/:last-child/:nth-child(n), and
 *                 comma unions — evaluated in document order.
 *   3. DETECT    detectRepeats() finds the page's repeating structures (the
 *                 product grid, the article list, the search results) by
 *                 grouping siblings with the same tag+class signature, and
 *                 suggestRecipe() turns the best one into a ready-to-run
 *                 recipe with guessed title/link/image/price fields.
 *   4. EXTRACT   runRecipe() applies {itemSelector, fields:[{name, selector,
 *                 attr}]} and returns clean rows; extractTables() lifts real
 *                 <table>s into header-keyed objects; extractLinks/Images/
 *                 Emails/Meta() harvest the usual suspects, URLs absolutised
 *                 against the page.
 *   5. EXPORT    toCSV() (RFC 4180 quoting), toJSON() and toMarkdown() turn
 *                 rows into files worth keeping.
 *   6. CRAWL     findNextUrl() discovers pagination (rel=next, « next »
 *                 links); parseRobots()/robotsAllowed() implement robots.txt
 *                 with longest-match precedence; normalizeUrl() canonicalises
 *                 and strips tracking params; createJob() is a polite,
 *                 deduping page frontier with hard caps.
 *   7. WATCH     contentHash() fingerprints what a recipe saw and diffRows()
 *                 reports exactly which rows appeared and disappeared, so a
 *                 saved scrape becomes a change monitor.
 *
 * UMD so it runs in the browser (window.Magpie), under Node/vm for tests,
 * and inside the companion fetch server — same pattern as the other
 * prototypes.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Magpie = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================== *
   *  0. Entities & text cleaning                                        *
   * ================================================================== */

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    copy: '©', reg: '®', trade: '™', deg: '°', pound: '£',
    euro: '€', yen: '¥', cent: '¢', sect: '§', para: '¶',
    middot: '·', laquo: '«', raquo: '»', ndash: '–',
    mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“',
    rdquo: '”', hellip: '…', bull: '•', dagger: '†',
    times: '×', divide: '÷', frac12: '½', frac14: '¼',
    plusmn: '±', micro: 'µ', larr: '←', uarr: '↑',
    rarr: '→', darr: '↓', star: '☆', starf: '★' };

  // &amp; → &, &#8212; → —, &#x2014; → —. Unknown entities pass through.
  function decodeEntities(s) {
    return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
      function (m, body) {
        if (body.charAt(0) === '#') {
          var hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
          var code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
          if (!isFinite(code) || code <= 0 || code > 0x10FFFF) return m;
          try { return String.fromCodePoint(code); } catch (e) { return m; }
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
      });
  }

  // Collapse runs of whitespace (incl. newlines and NBSP) to single spaces.
  function cleanText(s) {
    return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim();
  }

  /* ================================================================== *
   *  1. The HTML parser — tokenizer + tolerant tree builder             *
   * ================================================================== */

  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
    link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };

  // Content of these is rawtext: markup inside is data, not elements.
  var RAWTEXT = { script: 1, style: 1, textarea: 1, title: 1 };

  // Opening tag T implies the end of an open sibling in IMPLIES[T] — the
  // browser behaviour that makes `<li>a<li>b` two list items, not nested ones.
  var IMPLIES = { li: { li: 1 }, dt: { dt: 1, dd: 1 }, dd: { dt: 1, dd: 1 },
    td: { td: 1, th: 1 }, th: { td: 1, th: 1 }, tr: { tr: 1, td: 1, th: 1 },
    option: { option: 1 }, optgroup: { option: 1, optgroup: 1 },
    p: { p: 1 }, thead: { tr: 1, td: 1, th: 1 }, tbody: { tr: 1, td: 1, th: 1 },
    tfoot: { tr: 1, td: 1, th: 1 } };
  // Block-level openers also close an open <p> (HTML5 "closes a p element").
  var CLOSES_P = { address: 1, article: 1, aside: 1, blockquote: 1, div: 1, dl: 1,
    fieldset: 1, figure: 1, footer: 1, form: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1,
    h6: 1, header: 1, hr: 1, main: 1, nav: 1, ol: 1, pre: 1, section: 1, table: 1, ul: 1 };

  var ATTR_RE = /([^\s=\/>"'<]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

  function parseAttrs(s) {
    var attrs = {};
    var m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(s)) !== null) {
      var name = m[1].toLowerCase();
      if (name === '/' || name === '') continue;
      var val = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
      if (!Object.prototype.hasOwnProperty.call(attrs, name)) attrs[name] = decodeEntities(val);
    }
    return attrs;
  }

  function makeEl(tag, attrs, parent) {
    return { type: 'el', tag: tag, attrs: attrs || {}, children: [], parent: parent || null };
  }

  /**
   * Parse an HTML string into a tree: {type:'root', children:[…]} of
   * {type:'el', tag, attrs, children, parent} and {type:'text', text} nodes.
   * Tolerant by design — unclosed tags, stray end tags, comments, doctype,
   * CDATA and rawtext content are all handled the way real pages need.
   */
  function parseHTML(html) {
    html = String(html == null ? '' : html);
    var root = { type: 'root', tag: '#root', attrs: {}, children: [], parent: null };
    var stack = [root];
    var i = 0, n = html.length;

    function top() { return stack[stack.length - 1]; }
    function addText(raw) {
      if (!raw) return;
      var t = decodeEntities(raw);
      top().children.push({ type: 'text', text: t, parent: top() });
    }
    function openTag(tag, attrs, selfClosed) {
      // implied end tags: <li> closes <li>, block tags close <p>, …
      var implies = IMPLIES[tag] || null;
      var closesP = CLOSES_P[tag] === 1;
      while (stack.length > 1) {
        var cur = top().tag;
        if (implies && implies[cur] === 1) { stack.pop(); continue; }
        if (closesP && cur === 'p') { stack.pop(); continue; }
        break;
      }
      var el = makeEl(tag, attrs, top());
      top().children.push(el);
      if (!selfClosed && VOID[tag] !== 1) stack.push(el);
      return el;
    }
    function closeTag(tag) {
      for (var s = stack.length - 1; s >= 1; s--) {
        if (stack[s].tag === tag) { stack.length = s; return; }
      }
      // stray end tag: ignored, like a browser
    }

    while (i < n) {
      var lt = html.indexOf('<', i);
      if (lt === -1) { addText(html.slice(i)); break; }
      if (lt > i) addText(html.slice(i, lt));
      i = lt;

      if (html.startsWith('<!--', i)) {                    // comment
        var endC = html.indexOf('-->', i + 4);
        i = endC === -1 ? n : endC + 3;
        continue;
      }
      if (html.startsWith('<![CDATA[', i)) {               // CDATA (XML-ish feeds)
        var endD = html.indexOf(']]>', i + 9);
        addText(html.slice(i + 9, endD === -1 ? n : endD));
        i = endD === -1 ? n : endD + 3;
        continue;
      }
      if (html.charAt(i + 1) === '!' || html.charAt(i + 1) === '?') { // doctype / PI
        var endB = html.indexOf('>', i);
        i = endB === -1 ? n : endB + 1;
        continue;
      }
      if (html.charAt(i + 1) === '/') {                    // end tag
        var endE = html.indexOf('>', i);
        if (endE === -1) { i = n; break; }
        var closeName = html.slice(i + 2, endE).trim().toLowerCase().replace(/[^a-z0-9:-].*$/, '');
        if (closeName) closeTag(closeName);
        i = endE + 1;
        continue;
      }

      var m = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(i, i + 64));
      if (!m) { addText('<'); i++; continue; }             // lone '<' is text
      var tag = m[1].toLowerCase();
      // find the closing '>' respecting quoted attribute values
      var j = i + 1 + m[1].length, inQ = '';
      while (j < n) {
        var ch = html.charAt(j);
        if (inQ) { if (ch === inQ) inQ = ''; }
        else if (ch === '"' || ch === "'") inQ = ch;
        else if (ch === '>') break;
        j++;
      }
      if (j >= n) break;                                   // truncated tag
      var inner = html.slice(i + 1 + m[1].length, j);
      var selfClosed = /\/\s*$/.test(inner);
      var el = openTag(tag, parseAttrs(inner), selfClosed);
      i = j + 1;

      if (RAWTEXT[tag] === 1 && !selfClosed) {             // rawtext: scan to </tag
        var closeRe = new RegExp('</' + tag + '\\s*>', 'i');
        var rest = html.slice(i);
        var cm = closeRe.exec(rest);
        var rawEnd = cm ? cm.index : rest.length;
        var raw = rest.slice(0, rawEnd);
        if (raw) el.children.push({ type: 'text', text: tag === 'title' || tag === 'textarea' ? decodeEntities(raw) : raw, parent: el });
        i += rawEnd + (cm ? cm[0].length : 0);
        stack.pop();                                       // rawtext never nests
      }
    }
    return root;
  }

  /* ---- tree walking ---- */

  // Depth-first, document order. cb(el) on element nodes; return false to stop.
  function walk(node, cb) {
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.type === 'el') {
        if (cb(c) === false) return false;
        if (walk(c, cb) === false) return false;
      }
    }
    return true;
  }

  var SKIP_TEXT = { script: 1, style: 1, noscript: 1, template: 1 };

  // The human-visible text of a node, whitespace-normalised.
  function text(node) {
    var out = [];
    (function rec(nd) {
      if (nd.type === 'text') { out.push(nd.text); return; }
      if (nd.type === 'el' && SKIP_TEXT[nd.tag] === 1) return;
      var kids = nd.children || [];
      for (var i = 0; i < kids.length; i++) rec(kids[i]);
      // block-ish elements separate words (their text never runs together)
      if (nd.type === 'el' && !/^(a|b|i|u|em|strong|span|small|sub|sup|code|abbr|mark|time|s|q|cite)$/.test(nd.tag)) out.push(' ');
    })(node);
    return cleanText(out.join(''));
  }

  function attrOf(node, name) {
    if (!node || node.type !== 'el') return null;
    var v = node.attrs[String(name).toLowerCase()];
    return v == null ? null : v;
  }

  /* ================================================================== *
   *  2. The CSS selector engine                                         *
   * ================================================================== */

  // One compound selector: div.item#x[href^="http"]:first-child
  function parseCompound(s) {
    var out = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
    var re = /^([a-zA-Z][a-zA-Z0-9-]*|\*)|^#([\w-]+)|^\.([\w-]+)|^\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]|^:([\w-]+)(?:\(\s*([^)]*)\s*\))?/;
    var rest = s;
    while (rest.length) {
      var m = re.exec(rest);
      if (!m) return null;                                 // unparsable selector
      if (m[1]) out.tag = m[1] === '*' ? null : m[1].toLowerCase();
      else if (m[2]) out.id = m[2];
      else if (m[3]) out.classes.push(m[3]);
      else if (m[4]) out.attrs.push({ name: m[4].toLowerCase(), op: m[5] || null,
        val: m[6] != null ? m[6] : m[7] != null ? m[7] : m[8] != null ? m[8] : null });
      else if (m[9]) out.pseudos.push({ name: m[9].toLowerCase(), arg: m[10] != null ? m[10] : null });
      rest = rest.slice(m[0].length);
    }
    return out;
  }

  // "ul.list > li a" → [{comb:' ', c}, {comb:'>', c}, {comb:' ', c}]
  function parseSelector(selector) {
    var alts = String(selector == null ? '' : selector).split(',');
    var parsed = [];
    for (var a = 0; a < alts.length; a++) {
      var srcTokens = alts[a].trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
      if (!srcTokens.length) continue;
      var steps = [], comb = ' ';
      for (var t = 0; t < srcTokens.length; t++) {
        if (srcTokens[t] === '>') { comb = '>'; continue; }
        var c = parseCompound(srcTokens[t]);
        if (!c) { steps = null; break; }
        steps.push({ comb: comb, c: c });
        comb = ' ';
      }
      if (steps && steps.length) parsed.push(steps);
    }
    return parsed;
  }

  function elementChildren(node) {
    var out = [], kids = node.children || [];
    for (var i = 0; i < kids.length; i++) if (kids[i].type === 'el') out.push(kids[i]);
    return out;
  }

  function matchesCompound(el, c) {
    if (c.tag && el.tag !== c.tag) return false;
    if (c.id && el.attrs.id !== c.id) return false;
    if (c.classes.length) {
      var cls = ' ' + String(el.attrs['class'] || '') + ' ';
      for (var i = 0; i < c.classes.length; i++) {
        if (cls.indexOf(' ' + c.classes[i] + ' ') === -1) return false;
      }
    }
    for (var a = 0; a < c.attrs.length; a++) {
      var spec = c.attrs[a];
      var v = el.attrs[spec.name];
      if (v == null) return false;
      if (spec.op) {
        var want = String(spec.val == null ? '' : spec.val);
        if (spec.op === '=' && v !== want) return false;
        if (spec.op === '^=' && v.indexOf(want) !== 0) return false;
        if (spec.op === '$=' && (want === '' || v.slice(-want.length) !== want)) return false;
        if (spec.op === '*=' && v.indexOf(want) === -1) return false;
        if (spec.op === '~=' && (' ' + v + ' ').indexOf(' ' + want + ' ') === -1) return false;
        if (spec.op === '|=' && v !== want && v.indexOf(want + '-') !== 0) return false;
      }
    }
    for (var p = 0; p < c.pseudos.length; p++) {
      var ps = c.pseudos[p];
      var sibs = el.parent ? elementChildren(el.parent) : [el];
      var idx = sibs.indexOf(el);
      if (ps.name === 'first-child') { if (idx !== 0) return false; }
      else if (ps.name === 'last-child') { if (idx !== sibs.length - 1) return false; }
      else if (ps.name === 'nth-child') {
        var wantN = parseInt(ps.arg, 10);
        if (!isFinite(wantN) || idx + 1 !== wantN) return false;
      }
      else return false;                                   // unsupported pseudo
    }
    return true;
  }

  /**
   * All elements under `root` matching `selector`, in document order.
   */
  function select(root, selector) {
    var alts = parseSelector(selector);
    if (!alts.length) return [];
    var hits = [], seen = [];
    for (var a = 0; a < alts.length; a++) {
      var steps = alts[a];
      var seeds = [root];
      for (var s = 0; s < steps.length; s++) {
        var step = steps[s], next = [];
        for (var i = 0; i < seeds.length; i++) {
          var seed = seeds[i];
          if (step.comb === '>') {
            var kids = elementChildren(seed);
            for (var k = 0; k < kids.length; k++) if (matchesCompound(kids[k], step.c)) next.push(kids[k]);
          } else {
            walk(seed, function (el) { if (matchesCompound(el, step.c)) next.push(el); });
          }
        }
        seeds = next;
        if (!seeds.length) break;
      }
      for (var h = 0; h < seeds.length; h++) if (seen.indexOf(seeds[h]) === -1) { seen.push(seeds[h]); }
    }
    // document order: one walk over the whole tree, keep matched ones
    walk(root, function (el) { if (seen.indexOf(el) !== -1) hits.push(el); });
    return hits;
  }

  function selectOne(root, selector) {
    var r = select(root, selector);
    return r.length ? r[0] : null;
  }

  /* ================================================================== *
   *  3. URLs — absolutising, canonicalising, same-origin                *
   * ================================================================== */

  var TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_eid|igshid|ref_src|spm|yclid|_hs\w+)$/i;

  // Make a link absolute against the page it was found on. Returns null for
  // links a scraper can't fetch (javascript:, mailto:, tel:, #fragment).
  function absolutize(href, base) {
    href = String(href == null ? '' : href).trim();
    if (!href || href.charAt(0) === '#') return null;
    if (/^(javascript|mailto|tel|data|blob|about):/i.test(href)) return null;
    try {
      var u = base ? new URL(href, base) : new URL(href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      u.hash = '';
      return u.href;
    } catch (e) { return null; }
  }

  // Canonicalise a user-typed or crawled URL: default scheme, strip fragment
  // and tracking params, drop default ports, keep everything meaningful.
  function normalizeUrl(raw) {
    raw = String(raw == null ? '' : raw).trim();
    if (!raw) return null;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) raw = 'https://' + raw;
    var u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!/\./.test(u.hostname) && u.hostname !== 'localhost') return null;
    u.hash = '';
    var keep = [];
    u.searchParams.forEach(function (v, k) { if (!TRACKING_PARAM.test(k)) keep.push([k, v]); });
    u.search = '';
    for (var i = 0; i < keep.length; i++) u.searchParams.append(keep[i][0], keep[i][1]);
    var href = u.href;
    // bare-origin trailing slash is noise: https://x.com/ ≡ https://x.com
    return href;
  }

  function sameOrigin(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch (e) { return false; }
  }

  /* ================================================================== *
   *  4. Harvesters — tables, links, images, emails, metadata            *
   * ================================================================== */

  /**
   * Every real <table> on the page as {headers, rows, objects}: headers from
   * the first row of <th> (or the first row), rows as arrays of cell text,
   * objects keyed by header when headers exist.
   */
  function extractTables(doc) {
    var out = [];
    var tables = select(doc, 'table');
    for (var t = 0; t < tables.length; t++) {
      var trs = select(tables[t], 'tr');
      if (!trs.length) continue;
      var grid = [];
      var headerCells = null;
      for (var r = 0; r < trs.length; r++) {
        // nested tables: only rows whose nearest table is this one
        var anc = trs[r].parent;
        while (anc && anc.tag !== 'table') anc = anc.parent;
        if (anc !== tables[t]) continue;
        var cells = [], kidsQ = select(trs[r], 'td, th'), isHeader = true;
        for (var c = 0; c < kidsQ.length; c++) {
          var cell = kidsQ[c];
          var anc2 = cell.parent;
          while (anc2 && anc2.tag !== 'tr') anc2 = anc2.parent;
          if (anc2 !== trs[r]) continue;
          if (cell.tag !== 'th') isHeader = false;
          cells.push(text(cell));
        }
        if (!cells.length) continue;
        if (isHeader && headerCells == null && grid.length === 0) headerCells = cells;
        else grid.push(cells);
      }
      if (headerCells == null && grid.length > 1) { headerCells = null; }
      var objects = null;
      if (headerCells && headerCells.length) {
        objects = [];
        for (var g = 0; g < grid.length; g++) {
          var obj = {};
          for (var h = 0; h < headerCells.length; h++) {
            obj[headerCells[h] || 'col' + (h + 1)] = grid[g][h] != null ? grid[g][h] : '';
          }
          objects.push(obj);
        }
      }
      if (grid.length || (headerCells && headerCells.length)) {
        out.push({ headers: headerCells || [], rows: grid, objects: objects || [] });
      }
    }
    return out;
  }

  /** Every hyperlink: {text, url}, absolutised, deduped by URL. */
  function extractLinks(doc, baseUrl) {
    var out = [], seen = {};
    var as = select(doc, 'a');
    for (var i = 0; i < as.length; i++) {
      var url = absolutize(attrOf(as[i], 'href'), baseUrl);
      if (!url || seen[url] === 1) continue;
      seen[url] = 1;
      out.push({ text: text(as[i]), url: url,
        external: baseUrl ? !sameOrigin(url, baseUrl) : false });
    }
    return out;
  }

  /** Every image: {src, alt}, absolutised (srcset's first candidate counts). */
  function extractImages(doc, baseUrl) {
    var out = [], seen = {};
    var imgs = select(doc, 'img');
    for (var i = 0; i < imgs.length; i++) {
      var src = attrOf(imgs[i], 'src');
      if (!src) {
        var ss = attrOf(imgs[i], 'srcset') || attrOf(imgs[i], 'data-src');
        if (ss) src = ss.split(',')[0].trim().split(/\s+/)[0];
      }
      var url = absolutize(src, baseUrl);
      if (!url || seen[url] === 1) continue;
      seen[url] = 1;
      out.push({ src: url, alt: cleanText(attrOf(imgs[i], 'alt') || '') });
    }
    return out;
  }

  /** Email addresses found anywhere in the page (mailto: and plain text). */
  function extractEmails(doc) {
    var found = {}, out = [];
    var as = select(doc, 'a');
    for (var i = 0; i < as.length; i++) {
      var href = String(attrOf(as[i], 'href') || '');
      var mm = /^mailto:([^?]+)/i.exec(href);
      if (mm) { var e0 = mm[1].toLowerCase().trim(); if (!found[e0]) { found[e0] = 1; out.push(e0); } }
    }
    var body = text(doc);
    var re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, m;
    while ((m = re.exec(body)) !== null) {
      var e = m[0].toLowerCase();
      if (!found[e]) { found[e] = 1; out.push(e); }
    }
    return out;
  }

  /**
   * Page metadata: title, description, canonical URL, language, Open Graph
   * fields, and the @type of every JSON-LD block — the page's own summary.
   */
  function extractMeta(doc, baseUrl) {
    var meta = { title: '', description: '', canonical: null, lang: null, og: {}, jsonLd: [] };
    var t = selectOne(doc, 'title');
    if (t) meta.title = text(t);
    var htmlEl = selectOne(doc, 'html');
    if (htmlEl) meta.lang = attrOf(htmlEl, 'lang');
    var metas = select(doc, 'meta');
    for (var i = 0; i < metas.length; i++) {
      var name = String(attrOf(metas[i], 'name') || '').toLowerCase();
      var prop = String(attrOf(metas[i], 'property') || '').toLowerCase();
      var content = attrOf(metas[i], 'content');
      if (content == null) continue;
      if (name === 'description' && !meta.description) meta.description = cleanText(content);
      if (prop.indexOf('og:') === 0) meta.og[prop.slice(3)] = cleanText(content);
    }
    if (!meta.description && meta.og.description) meta.description = meta.og.description;
    if (!meta.title && meta.og.title) meta.title = meta.og.title;
    var canon = selectOne(doc, 'link[rel=canonical]');
    if (canon) meta.canonical = absolutize(attrOf(canon, 'href'), baseUrl);
    var lds = select(doc, 'script[type="application/ld+json"]');
    for (var l = 0; l < lds.length; l++) {
      var rawKids = lds[l].children || [];
      var raw = rawKids.length && rawKids[0].type === 'text' ? rawKids[0].text : '';
      try {
        var parsed = JSON.parse(raw);
        var list = Array.isArray(parsed) ? parsed : [parsed];
        for (var x = 0; x < list.length; x++) {
          var ty = list[x] && list[x]['@type'];
          if (ty) meta.jsonLd.push(String(Array.isArray(ty) ? ty[0] : ty));
        }
      } catch (e) { /* malformed JSON-LD is common; skip it */ }
    }
    return meta;
  }

  /* ================================================================== *
   *  5. The detector — find the page's repeating structures             *
   * ================================================================== */

  // A stable signature for "these siblings are the same kind of thing".
  function sig(el) {
    var cls = String(el.attrs['class'] || '').split(/\s+/).filter(Boolean).sort();
    return el.tag + (cls.length ? '.' + cls.join('.') : '');
  }

  // A selector that (re-)finds this element: nearest #id anchor, then
  // tag.class steps, capped at 3 levels — readable, not over-specified.
  function buildSelector(el) {
    var parts = [];
    var cur = el, depth = 0;
    while (cur && cur.type === 'el' && depth < 3) {
      if (cur.attrs.id) { parts.unshift('#' + cur.attrs.id); return parts.join(' > '); }
      var cls = String(cur.attrs['class'] || '').split(/\s+/).filter(Boolean);
      parts.unshift(cur.tag + (cls.length ? '.' + cls.slice(0, 2).join('.') : ''));
      cur = cur.parent;
      depth++;
    }
    return parts.join(' > ');
  }

  /**
   * Find repeating structures — the lists a human sees instantly. Groups the
   * element children of every container by tag+class signature; a group of
   * ≥ minCount siblings that carry text is a candidate, scored by count and
   * richness (links, images, headings make a list more "scrapeable").
   * Returns [{selector, count, score, sample}] best-first.
   */
  function detectRepeats(doc, opts) {
    var minCount = (opts && opts.minCount) || 3;
    var candidates = [];
    walk(doc, function (container) {
      if (/^(html|head|script|style|select|thead|tbody|table|tr)$/.test(container.tag)) return;
      var kids = elementChildren(container);
      if (kids.length < minCount) return;
      var groups = {};
      for (var i = 0; i < kids.length; i++) {
        var s = sig(kids[i]);
        (groups[s] = groups[s] || []).push(kids[i]);
      }
      for (var key in groups) {
        var g = groups[key];
        if (g.length < minCount) continue;
        if (/^(br|hr|option|meta|link|script|style|input)/.test(g[0].tag)) continue;
        var withText = 0, withLink = 0, withImg = 0, withHead = 0, totalLen = 0;
        for (var k = 0; k < g.length; k++) {
          var tx = text(g[k]);
          if (tx) { withText++; totalLen += tx.length; }
          if (select(g[k], 'a').length || g[k].tag === 'a') withLink++;
          if (select(g[k], 'img').length) withImg++;
          if (select(g[k], 'h1, h2, h3, h4').length) withHead++;
        }
        if (!withText) continue;
        var itemSel = buildSelector(container);
        itemSel = (itemSel ? itemSel + ' > ' : '') + key.replace(/^([a-z0-9]+)((?:\.[\w-]+)*)$/,
          function (mm, tag2, cls2) { return tag2 + cls2.split('.').slice(0, 3).join('.'); });
        var score = g.length
          * (1 + (withLink / g.length) * 2 + (withImg / g.length) + (withHead / g.length))
          * Math.min(1, totalLen / g.length / 20 + 0.25);
        candidates.push({ selector: itemSel, count: g.length,
          score: Math.round(score * 100) / 100, sample: text(g[0]).slice(0, 140) });
      }
    });
    candidates.sort(function (a, b) { return b.score - a.score || b.count - a.count; });
    // dedupe by selector (same group can be seen through nested walks)
    var out = [], seen = {};
    for (var c = 0; c < candidates.length; c++) {
      if (seen[candidates[c].selector] === 1) continue;
      seen[candidates[c].selector] = 1;
      out.push(candidates[c]);
    }
    return out.slice(0, (opts && opts.limit) || 8);
  }

  /**
   * Turn the best repeat into a ready-to-run recipe: guesses a title field
   * (first heading or link text), a link field, an image and a price when the
   * items have them. Returns null when the page has no usable repeats.
   */
  var PRICE_RE = /(?:[£$€¥]\s?\d[\d,]*(?:\.\d{1,2})?)|(?:\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|GBP|EUR|kr|zł))/;

  function suggestRecipe(doc, opts) {
    var reps = detectRepeats(doc, opts);
    if (!reps.length) return null;
    var chosen = reps[0];
    var items = select(doc, chosen.selector);
    if (!items.length) return null;
    var first = items[0];
    var fields = [];
    var titleEl = selectOne(first, 'h1, h2, h3, h4, h5') || selectOne(first, 'a');
    fields.push({ name: 'title', selector: titleEl && titleEl !== first ? buildLocalSelector(first, titleEl) : '', attr: 'text' });
    var linkEl = first.tag === 'a' ? first : selectOne(first, 'a');
    if (linkEl) fields.push({ name: 'link', selector: linkEl === first ? '' : 'a', attr: 'href' });
    if (selectOne(first, 'img')) fields.push({ name: 'image', selector: 'img', attr: 'src' });
    // a price-looking sub-element?
    var priceSel = null;
    walk(first, function (el) {
      if (priceSel) return false;
      var cls = String(el.attrs['class'] || '');
      if (/price|cost|amount/i.test(cls) || (PRICE_RE.test(text(el)) && text(el).length < 24)) {
        priceSel = buildLocalSelector(first, el);
        return false;
      }
    });
    if (priceSel) fields.push({ name: 'price', selector: priceSel, attr: 'text' });
    return { itemSelector: chosen.selector, fields: fields, count: items.length };
  }

  // A selector for `el` relative to `scope` (tag.class, one or two steps).
  function buildLocalSelector(scope, el) {
    var parts = [], cur = el, depth = 0;
    while (cur && cur !== scope && cur.type === 'el' && depth < 2) {
      var cls = String(cur.attrs['class'] || '').split(/\s+/).filter(Boolean);
      parts.unshift(cur.tag + (cls.length ? '.' + cls[0] : ''));
      cur = cur.parent;
      depth++;
    }
    return parts.join(' > ');
  }

  /* ================================================================== *
   *  6. The recipe runner — page → rows                                 *
   * ================================================================== */

  /**
   * Run a recipe over a parsed page. recipe = {itemSelector, fields:[{name,
   * selector, attr}]} where attr is 'text' (default), 'html' is not offered
   * (scrapers want data, not markup) or an attribute name like 'href'.
   * URL-ish attributes (href, src) are absolutised against baseUrl. Rows
   * where every field came up empty are dropped.
   */
  function runRecipe(doc, recipe, baseUrl) {
    if (!recipe || !recipe.itemSelector || !Array.isArray(recipe.fields) || !recipe.fields.length) {
      return { rows: [], count: 0, error: 'recipe needs an item selector and at least one field' };
    }
    var items = select(doc, recipe.itemSelector);
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      var row = {}, any = false;
      for (var f = 0; f < recipe.fields.length; f++) {
        var field = recipe.fields[f];
        var name = cleanText(field.name) || 'field' + (f + 1);
        var target = field.selector ? selectOne(items[i], field.selector) : items[i];
        var val = '';
        if (target) {
          var attr = (field.attr || 'text').toLowerCase();
          if (attr === 'text') val = text(target);
          else {
            val = attrOf(target, attr);
            val = val == null ? '' : cleanText(val);
            if ((attr === 'href' || attr === 'src') && val) val = absolutize(val, baseUrl) || val;
          }
        }
        if (val) any = true;
        row[name] = val;
      }
      if (any) rows.push(row);
    }
    return { rows: rows, count: rows.length, error: null };
  }

  /* ================================================================== *
   *  7. Export — CSV (RFC 4180), JSON, Markdown                         *
   * ================================================================== */

  function columnsOf(rows) {
    var cols = [], seen = {};
    for (var i = 0; i < rows.length; i++) {
      for (var k in rows[i]) if (seen[k] !== 1) { seen[k] = 1; cols.push(k); }
    }
    return cols;
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Rows → CSV with a header line; RFC 4180 quoting; \r\n line ends. */
  function toCSV(rows, columns) {
    rows = rows || [];
    var cols = columns && columns.length ? columns : columnsOf(rows);
    var lines = [cols.map(csvCell).join(',')];
    for (var i = 0; i < rows.length; i++) {
      lines.push(cols.map(function (c) { return csvCell(rows[i][c]); }).join(','));
    }
    return lines.join('\r\n');
  }

  /** Rows → pretty JSON (stable field order per columnsOf). */
  function toJSON(rows) {
    return JSON.stringify(rows || [], null, 2);
  }

  /** Rows → a GitHub-flavoured Markdown table. */
  function toMarkdown(rows, columns) {
    rows = rows || [];
    var cols = columns && columns.length ? columns : columnsOf(rows);
    if (!cols.length) return '';
    var esc = function (v) { return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); };
    var out = ['| ' + cols.map(esc).join(' | ') + ' |',
               '| ' + cols.map(function () { return '---'; }).join(' | ') + ' |'];
    for (var i = 0; i < rows.length; i++) {
      out.push('| ' + cols.map(function (c) { return esc(rows[i][c]); }).join(' | ') + ' |');
    }
    return out.join('\n');
  }

  /* ================================================================== *
   *  8. Pagination + the crawl frontier                                 *
   * ================================================================== */

  /**
   * The page's "next page" link, absolutised — <link rel=next>, <a rel=next>,
   * or an anchor whose text says next (next, more, older, ›, », →). Returns
   * null when there's nowhere further to go (or "next" points at itself).
   */
  function findNextUrl(doc, baseUrl) {
    var cand = selectOne(doc, 'link[rel=next]') || selectOne(doc, 'a[rel=next]');
    if (cand) {
      var u0 = absolutize(attrOf(cand, 'href'), baseUrl);
      if (u0 && u0 !== baseUrl) return u0;
    }
    var NEXT_RE = /^(next|next\s*(page|›|»)?|more|older(\s*posts?)?|›|»|→|>|>>)$/i;
    var as = select(doc, 'a');
    for (var i = 0; i < as.length; i++) {
      var t = text(as[i]);
      if (t && t.length <= 24 && NEXT_RE.test(t)) {
        var u = absolutize(attrOf(as[i], 'href'), baseUrl);
        if (u && u !== baseUrl) return u;
      }
    }
    return null;
  }

  /**
   * A polite multi-page scrape frontier: seeded with a URL, capped at
   * maxPages, dedupes what it has seen. next() hands out the next URL to
   * fetch; feed(html, finalUrl) parses it, runs the recipe, accumulates rows
   * (deduped across pages) and queues the discovered next page.
   */
  function createJob(startUrl, recipe, opts) {
    opts = opts || {};
    var maxPages = Math.max(1, Math.min(50, opts.maxPages || 5));
    var seen = {}, queue = [], rows = [], rowKeys = {}, pages = 0;
    var start = normalizeUrl(startUrl);
    if (start) { queue.push(start); seen[start] = 1; }
    return {
      next: function () {
        if (pages >= maxPages) return null;
        return queue.length ? queue.shift() : null;
      },
      feed: function (html, pageUrl) {
        pages++;
        var doc = parseHTML(html);
        var res = runRecipe(doc, recipe, pageUrl);
        var added = 0;
        for (var i = 0; i < res.rows.length; i++) {
          var key = JSON.stringify(res.rows[i]);
          if (rowKeys[key] === 1) continue;
          rowKeys[key] = 1;
          rows.push(res.rows[i]);
          added++;
        }
        var nxt = findNextUrl(doc, pageUrl);
        if (nxt) {
          var norm = normalizeUrl(nxt);
          if (norm && seen[norm] !== 1 && pages + queue.length < maxPages) {
            seen[norm] = 1;
            queue.push(norm);
          }
        }
        return { added: added, nextQueued: queue.length > 0 };
      },
      rows: function () { return rows; },
      stats: function () { return { pages: pages, rows: rows.length, pending: queue.length, maxPages: maxPages }; }
    };
  }

  /* ================================================================== *
   *  9. robots.txt — the Robots Exclusion Protocol                      *
   * ================================================================== */

  /**
   * Parse robots.txt into groups: [{agents:[…], rules:[{allow, path}]}].
   * Comments stripped; group boundaries per the original 1994 protocol +
   * Google's longest-match extension implemented in robotsAllowed().
   */
  function parseRobots(txt) {
    var groups = [], cur = null, sawRule = false;
    var lines = String(txt == null ? '' : txt).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/#.*$/, '').trim();
      if (!line) continue;
      var m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      var key = m[1].toLowerCase(), val = m[2].trim();
      if (key === 'user-agent') {
        if (!cur || sawRule) { cur = { agents: [], rules: [] }; groups.push(cur); sawRule = false; }
        cur.agents.push(val.toLowerCase());
      } else if ((key === 'allow' || key === 'disallow') && cur) {
        sawRule = true;
        cur.rules.push({ allow: key === 'allow', path: val });
      }
    }
    return groups;
  }

  /**
   * Is `path` fetchable for `ua` under these rules? The most specific
   * matching group wins (exact substring UA match beats *), then the longest
   * matching path rule decides; Allow wins ties; no match = allowed.
   * An empty Disallow means "everything allowed" per the protocol.
   */
  function robotsAllowed(groups, ua, path) {
    groups = groups || [];
    ua = String(ua == null ? '*' : ua).toLowerCase();
    path = String(path == null ? '/' : path) || '/';
    var best = null, bestSpec = -1;
    for (var i = 0; i < groups.length; i++) {
      for (var a = 0; a < groups[i].agents.length; a++) {
        var agent = groups[i].agents[a];
        var spec = agent === '*' ? 0 : ua.indexOf(agent) !== -1 ? agent.length : -1;
        if (spec > bestSpec) { bestSpec = spec; best = groups[i]; }
      }
    }
    if (!best) return true;
    var verdict = true, matchLen = -1;
    for (var r = 0; r < best.rules.length; r++) {
      var rule = best.rules[r];
      if (rule.path === '') { if (matchLen < 0 && !rule.allow) verdict = true; continue; }
      // '*' wildcards and '$' end anchors, per Google's extension
      var rx = '^' + rule.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      var anchored = /\$$/.test(rule.path);
      if (anchored) rx = rx.slice(0, -1) + '$';
      var re;
      try { re = new RegExp(rx); } catch (e) { continue; }
      if (re.test(path)) {
        var len = rule.path.length + (rule.allow ? 0.5 : 0); // Allow wins ties
        if (len > matchLen) { matchLen = len; verdict = rule.allow; }
      }
    }
    return verdict;
  }

  /* ================================================================== *
   *  10. Watch — fingerprints and diffs                                 *
   * ================================================================== */

  /** FNV-1a 32-bit hash of whatever a recipe saw, as 8 hex chars. */
  function contentHash(value) {
    var s = typeof value === 'string' ? value : JSON.stringify(value);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /**
   * What changed between two scrapes of the same recipe: rows that appeared,
   * rows that disappeared, and how many stayed. Rows compare by value.
   */
  function diffRows(oldRows, newRows) {
    oldRows = oldRows || []; newRows = newRows || [];
    var oldKeys = {}, newKeys = {};
    for (var i = 0; i < oldRows.length; i++) oldKeys[JSON.stringify(oldRows[i])] = 1;
    for (var j = 0; j < newRows.length; j++) newKeys[JSON.stringify(newRows[j])] = 1;
    var added = [], removed = [], same = 0;
    for (var a = 0; a < newRows.length; a++) {
      if (oldKeys[JSON.stringify(newRows[a])] === 1) same++;
      else added.push(newRows[a]);
    }
    for (var r = 0; r < oldRows.length; r++) {
      if (newKeys[JSON.stringify(oldRows[r])] !== 1) removed.push(oldRows[r]);
    }
    return { added: added, removed: removed, unchanged: same,
      changed: added.length > 0 || removed.length > 0 };
  }

  /* ================================================================== *
   *  Exports                                                            *
   * ================================================================== */

  return {
    // text
    decodeEntities: decodeEntities, cleanText: cleanText,
    // parse + tree
    parseHTML: parseHTML, walk: walk, text: text, attrOf: attrOf,
    // select
    select: select, selectOne: selectOne, parseSelector: parseSelector,
    matchesCompound: matchesCompound,
    // urls
    absolutize: absolutize, normalizeUrl: normalizeUrl, sameOrigin: sameOrigin,
    // harvesters
    extractTables: extractTables, extractLinks: extractLinks,
    extractImages: extractImages, extractEmails: extractEmails, extractMeta: extractMeta,
    // detection
    detectRepeats: detectRepeats, suggestRecipe: suggestRecipe, buildSelector: buildSelector,
    // recipes
    runRecipe: runRecipe,
    // export
    toCSV: toCSV, toJSON: toJSON, toMarkdown: toMarkdown, columnsOf: columnsOf,
    // crawl
    findNextUrl: findNextUrl, createJob: createJob,
    parseRobots: parseRobots, robotsAllowed: robotsAllowed,
    // watch
    contentHash: contentHash, diffRows: diffRows
  };
});

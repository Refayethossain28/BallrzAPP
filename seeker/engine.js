/**
 * Seeker — the search engine
 * ==========================
 *
 * A real internet search engine built the honest way: everything that makes a
 * search engine a *search engine* — the text pipeline, the inverted index, the
 * ranking function, the query language, typo tolerance, spelling correction,
 * snippet generation, the crawler's brain (robots.txt, URL canonicalisation,
 * the frontier), result fusion across live web sources, and the instant-answer
 * box — is implemented from scratch in this one pure, deterministic,
 * framework-free file. No search library, no black box: the same index + the
 * same query always produce the same ranking, and every part is unit-tested.
 *
 * The pipeline (what the big engines do, done honestly at prototype scale)
 * -----------------------------------------------------------------------
 *   1. CRAWL      extractPage() parses fetched HTML (title, meta description,
 *                  visible text, links, noindex); normalizeUrl() canonicalises
 *                  (resolves relative links, strips fragments and tracking
 *                  params); parseRobots()/robotsAllowed() implement the Robots
 *                  Exclusion Protocol; createCrawler() is a breadth-first
 *                  frontier that dedupes and respects page/depth caps.
 *   2. INDEX      tokenize() folds case + diacritics; stem() is the classic
 *                  Porter (1980) suffix-stripping algorithm; addDoc() builds a
 *                  positional inverted index with per-field (title/body/tags)
 *                  term frequencies, so phrases and field queries work.
 *   3. QUERY      parseQuery() understands "exact phrases", -exclusions, OR,
 *                  title:/url:/site: fields, and DuckDuckGo-style !bangs.
 *   4. RANK       BM25 (k1=1.2, b=0.75) — the same ranking family Lucene,
 *                  Elasticsearch and every serious engine uses — over
 *                  field-weighted term frequencies, boosted by term proximity
 *                  and exact-title matches, damped by coverage so documents
 *                  matching the whole query beat partial matches.
 *   5. FORGIVE    unknown terms fall back to bounded Damerau–Levenshtein
 *                  fuzzy matching over the vocabulary; didYouMean() proposes a
 *                  frequency-weighted spelling correction; suggest() completes
 *                  prefixes for search-as-you-type.
 *   6. PRESENT    snippet() picks the best window of the document and marks
 *                  every hit; rrfMerge() fuses the on-device ranking with live
 *                  internet sources by Reciprocal Rank Fusion; instantAnswer()
 *                  answers maths, unit conversions and world-clock queries
 *                  without leaving the page.
 *
 * UMD so it runs in the browser (window.Seeker), under Node/vm for tests, and
 * inside the companion crawl server — same pattern as the other prototypes.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.Seeker = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================== *
   *  1. Text pipeline — folding, tokenizing, stemming                   *
   * ================================================================== */

  // Lowercase + strip diacritics (café → cafe) so accents never hide a match.
  function fold(s) {
    s = String(s == null ? '' : s).toLowerCase();
    try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* pre-NFKD engines */ }
    return s;
  }

  // Words = runs of letters/digits (apostrophes dropped: don't → dont).
  function tokenize(s) {
    return fold(s).replace(/['’]/g, '').match(/[a-z0-9]+/g) || [];
  }

  // The 60-ish highest-frequency English words. They ARE indexed (so the
  // phrase "to be or not to be" still works) but are ignored for ranking
  // whenever the query has any content-bearing term.
  var STOPWORDS = {};
  ('a an and are as at be but by for from had has have he her his i if in is it its ' +
   'me my no not of on or our she so that the their them then there these they this ' +
   'to up us was we were what when which who will with you your').split(' ')
    .forEach(function (w) { STOPWORDS[w] = 1; });

  /* ---- Porter stemmer (M.F. Porter, 1980) — the classic algorithm ---- */
  var C = '[^aeiou][^aeiouy]*', V = '[aeiouy][aeiou]*';
  var mgr0 = new RegExp('^(' + C + ')?' + V + C);                     // measure m > 0
  var meq1 = new RegExp('^(' + C + ')?' + V + C + '(' + V + ')?$');   // m == 1
  var mgr1 = new RegExp('^(' + C + ')?' + V + C + V + C);             // m > 1
  var hasV = new RegExp('^(' + C + ')?[aeiouy]');                     // stem contains a vowel

  var STEP2 = { ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize',
    bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous', ization: 'ize',
    ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive', fulness: 'ful',
    ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble', logi: 'log' };
  var STEP3 = { icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: '' };

  function stem(w) {
    w = String(w);
    if (w.length < 3) return w;
    var first = w.charAt(0);
    if (first === 'y') w = 'Y' + w.slice(1); // leading y is a consonant

    // Step 1a — plurals
    if (/(ss|i)es$/.test(w)) w = w.replace(/es$/, '');
    else if (/[^s]s$/.test(w)) w = w.replace(/s$/, '');

    // Step 1b — -eed / -ed / -ing
    var m;
    if ((m = /eed$/.exec(w))) {
      if (mgr0.test(w.slice(0, -3))) w = w.slice(0, -1);
    } else if ((m = /(ed|ing)$/.exec(w))) {
      var st = w.slice(0, -m[1].length);
      if (hasV.test(st)) {
        w = st;
        if (/(at|bl|iz)$/.test(w)) w += 'e';
        else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
        else if (/^[^aeiou][^aeiouy]*[aeiouy][^aeiouwxy]$/.test(w)) w += 'e'; // cvc, m=1
      }
    }

    // Step 1c — y → i when the stem has a vowel
    if (/y$/.test(w) && hasV.test(w.slice(0, -1))) w = w.slice(0, -1) + 'i';

    // Step 2 — double suffixes (m > 0)
    for (var suf2 in STEP2) {
      if (w.length > suf2.length && w.slice(-suf2.length) === suf2) {
        var s2 = w.slice(0, -suf2.length);
        if (mgr0.test(s2)) w = s2 + STEP2[suf2];
        break;
      }
    }
    // Step 3 (m > 0)
    for (var suf3 in STEP3) {
      if (w.length > suf3.length && w.slice(-suf3.length) === suf3) {
        var s3 = w.slice(0, -suf3.length);
        if (mgr0.test(s3)) w = s3 + STEP3[suf3];
        break;
      }
    }
    // Step 4 — strip remaining suffix when m > 1
    var m4 = /(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(w);
    if (m4) {
      if (mgr1.test(w.slice(0, -m4[1].length))) w = w.slice(0, -m4[1].length);
    } else if ((m4 = /(s|t)(ion)$/.exec(w))) {
      if (mgr1.test(w.slice(0, -3))) w = w.slice(0, -3);
    }
    // Step 5a — trailing e
    if (/e$/.test(w)) {
      var s5 = w.slice(0, -1);
      if (mgr1.test(s5) ||
          (meq1.test(s5) && !/^[^aeiou][^aeiouy]*[aeiouy][^aeiouwxy]$/.test(s5))) w = s5;
    }
    // Step 5b — -ll → -l when m > 1
    if (/ll$/.test(w) && mgr1.test(w)) w = w.slice(0, -1);

    return first === 'y' ? 'y' + w.slice(1) : w;
  }

  /* ================================================================== *
   *  2. Edit distance (Damerau–Levenshtein, banded)                     *
   * ================================================================== */

  // Distance capped at `max` (returns max+1 when exceeded) — transpositions
  // count 1 because "teh" → "the" is the single most common human typo.
  function editDistance(a, b, max) {
    max = max || 2;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > max) return max + 1;
    var prevPrev = [], prev = [], cur = [], i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur = [i];
      var rowMin = i;
      for (j = 1; j <= lb; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          v = Math.min(v, prevPrev[j - 2] + 1);
        }
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prevPrev = prev; prev = cur;
    }
    return prev[lb];
  }

  /* ================================================================== *
   *  3. The inverted index                                              *
   * ================================================================== */

  // Field weights: a hit in the title is worth far more than one in the body.
  var W_TITLE = 6, W_BODY = 1, W_TAGS = 3;
  var BM25_K1 = 1.2, BM25_B = 0.75;
  var POS_CAP = 120;       // positions stored per term per doc (phrases/proximity)
  var BODY_CAP = 6000;     // chars of body kept for snippets + serialization
  // Positions: title tokens start at 0, body at +1000, tags at +100000 — the
  // gaps make phrases and proximity impossible across field boundaries.
  var BODY_OFF = 1000, TAGS_OFF = 100000;

  function createIndex() {
    return { v: 1, seq: 1, docs: {}, byUrl: {}, post: {}, words: {}, n: 0, totalWlen: 0 };
  }

  function indexField(entry, tokens, offset, weight, whichTf, index, seen) {
    for (var i = 0; i < tokens.length; i++) {
      var raw = tokens[i], st = stem(raw);
      var p = entry.terms[st];
      if (!p) p = entry.terms[st] = { w: 0, ft: 0, fb: 0, fg: 0, pos: [] };
      p.w += weight; p[whichTf] += 1;
      if (p.pos.length < POS_CAP) p.pos.push(offset + i);
      if (!seen[raw]) { seen[raw] = 1; index.words[raw] = (index.words[raw] || 0) + 1; }
    }
  }

  // Add (or replace, keyed by URL) one document. doc: {url, title, body, tags?,
  // source?, emoji?}. Returns the doc id.
  function addDoc(index, doc) {
    var url = String(doc.url || '');
    if (url && index.byUrl[url] != null) removeDoc(index, index.byUrl[url]);
    var id = 'd' + (index.seq++);
    var title = String(doc.title || ''), body = String(doc.body || ''), tags = String(doc.tags || '');
    var tT = tokenize(title), tB = tokenize(body), tG = tokenize(tags);
    var entry = { terms: {} }, seen = {};
    indexField(entry, tT, 0, W_TITLE, 'ft', index, seen);
    indexField(entry, tB, BODY_OFF, W_BODY, 'fb', index, seen);
    indexField(entry, tG, TAGS_OFF, W_TAGS, 'fg', index, seen);
    var wlen = tT.length * W_TITLE + tB.length * W_BODY + tG.length * W_TAGS;
    index.docs[id] = { id: id, url: url, title: title, body: body.slice(0, BODY_CAP),
      tags: tags, source: doc.source || 'index', emoji: doc.emoji || '', wlen: wlen };
    for (var st in entry.terms) {
      var post = index.post[st];
      if (!post) post = index.post[st] = {};
      post[id] = entry.terms[st];
    }
    if (url) index.byUrl[url] = id;
    index.n += 1; index.totalWlen += wlen;
    return id;
  }

  function removeDoc(index, id) {
    var d = index.docs[id];
    if (!d) return false;
    for (var st in index.post) {
      var post = index.post[st];
      if (post[id]) {
        delete post[id];
        var empty = true;
        for (var k in post) { empty = false; break; }
        if (empty) delete index.post[st];
      }
    }
    // words[] frequencies decay only on rebuild — an accepted, documented
    // approximation (they only steer suggestions, never ranking).
    if (d.url && index.byUrl[d.url] === id) delete index.byUrl[d.url];
    index.n -= 1; index.totalWlen -= d.wlen;
    delete index.docs[id];
    return true;
  }

  function serializeIndex(index) { return JSON.stringify(index); }
  function deserializeIndex(json) {
    var x = JSON.parse(json);
    if (!x || x.v !== 1 || !x.docs || !x.post) throw new Error('not a Seeker index');
    return x;
  }

  /* ================================================================== *
   *  4. Query language                                                  *
   * ================================================================== */

  // "exact phrase"  -excluded  OR  title:term  url:path  site:host  !bang
  function parseQuery(q) {
    q = String(q == null ? '' : q);
    var phrases = [], fields = [], exclude = [], words = [];
    var rest = q.replace(/"([^"]*)"/g, function (_, ph) {
      var toks = tokenize(ph);
      if (toks.length) phrases.push(toks.map(stem));
      return ' ';
    });
    var parts = rest.split(/\s+/);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p) continue;
      if (p === 'OR') { if (words.length) words[words.length - 1].or = true; continue; }
      var neg = p.charAt(0) === '-';
      if (neg) p = p.slice(1);
      var fm = /^(title|url|site):(.*)$/.exec(p);
      if (fm && fm[2]) {
        var ftoks = tokenize(fm[2]);
        if (fm[1] === 'title' && ftoks.length) {
          if (neg) exclude.push(stem(ftoks[0]));
          else words.push({ raw: ftoks[0], stem: stem(ftoks[0]), field: 'title' });
        } else if (ftoks.length) {
          fields.push({ field: fm[1], value: fold(fm[2]).replace(/["']/g, '') });
        }
        continue;
      }
      var toks = tokenize(p);
      for (var t = 0; t < toks.length; t++) {
        if (neg) exclude.push(stem(toks[t]));
        else words.push({ raw: toks[t], stem: stem(toks[t]) });
      }
    }
    // Drop stopwords from ranking terms when any content term exists.
    var content = words.filter(function (w) { return !STOPWORDS[w.raw]; });
    var terms = content.length ? content : words;
    return { phrases: phrases, terms: terms, exclude: exclude, fields: fields };
  }

  /* ---- !bangs — jump straight to the right site, DuckDuckGo-style ---- */
  var BANGS = {
    g:    { name: 'Google',        url: 'https://www.google.com/search?q={q}' },
    w:    { name: 'Wikipedia',     url: 'https://en.wikipedia.org/wiki/Special:Search?search={q}' },
    yt:   { name: 'YouTube',       url: 'https://www.youtube.com/results?search_query={q}' },
    gh:   { name: 'GitHub',        url: 'https://github.com/search?q={q}' },
    so:   { name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q={q}' },
    ddg:  { name: 'DuckDuckGo',    url: 'https://duckduckgo.com/?q={q}' },
    maps: { name: 'Google Maps',   url: 'https://www.google.com/maps/search/{q}' },
    img:  { name: 'Google Images', url: 'https://www.google.com/search?tbm=isch&q={q}' },
    r:    { name: 'Reddit',        url: 'https://www.reddit.com/search/?q={q}' },
    x:    { name: 'X',             url: 'https://x.com/search?q={q}' },
    amz:  { name: 'Amazon',        url: 'https://www.amazon.co.uk/s?k={q}' },
    imdb: { name: 'IMDb',          url: 'https://www.imdb.com/find/?q={q}' },
    hn:   { name: 'Hacker News',   url: 'https://hn.algolia.com/?q={q}' },
    npm:  { name: 'npm',           url: 'https://www.npmjs.com/search?q={q}' }
  };

  // parseBang('!w porter stemmer') → {bang:'w', name:'Wikipedia', url:...}
  function parseBang(q) {
    var m = /^\s*!(\w+)\s*(.*)$/.exec(String(q || '')) || (function () {
      var t = /^(.*?)\s+!(\w+)\s*$/.exec(String(q || ''));
      return t ? [t[0], t[2], t[1]] : null;
    })();
    if (!m) return null;
    var b = BANGS[m[1].toLowerCase()];
    if (!b) return null;
    return { bang: m[1].toLowerCase(), name: b.name,
      url: b.url.replace('{q}', encodeURIComponent(m[2].trim())) };
  }

  /* ================================================================== *
   *  5. Search — BM25 + coverage + proximity + forgiveness              *
   * ================================================================== */

  function idf(index, st) {
    var post = index.post[st], df = 0;
    if (post) for (var k in post) df++;
    // BM25's idf, floored at a small positive so ubiquitous terms still count.
    return Math.max(0.05, Math.log(1 + (index.n - df + 0.5) / (df + 0.5)));
  }

  function bm25(index, p, wlen) {
    var avg = index.n ? index.totalWlen / index.n : 1;
    return (p.w * (BM25_K1 + 1)) / (p.w + BM25_K1 * (1 - BM25_B + BM25_B * (wlen / (avg || 1))));
  }

  // Expand an unmatched stem to close vocabulary stems (typo forgiveness).
  function fuzzyExpand(index, raw) {
    var max = raw.length <= 4 ? 1 : 2, best = [];
    for (var w in index.words) {
      if (Math.abs(w.length - raw.length) > max) continue;
      var d = editDistance(raw, w, max);
      if (d <= max) best.push({ w: w, d: d, n: index.words[w] });
    }
    best.sort(function (a, b) { return a.d - b.d || b.n - a.n || (a.w < b.w ? -1 : 1); });
    var stems = {}, out = [];
    for (var i = 0; i < best.length && out.length < 4; i++) {
      var st = stem(best[i].w);
      if (!stems[st] && index.post[st]) { stems[st] = 1; out.push({ stem: st, word: best[i].w, d: best[i].d }); }
    }
    return out;
  }

  // Expand a prefix to indexed stems (search-as-you-type on the last token).
  function prefixExpand(index, raw, limit) {
    var hits = [];
    for (var w in index.words) {
      if (w.length > raw.length && w.slice(0, raw.length) === raw) hits.push({ w: w, n: index.words[w] });
    }
    hits.sort(function (a, b) { return b.n - a.n || (a.w < b.w ? -1 : 1); });
    var stems = {}, out = [];
    for (var i = 0; i < hits.length && out.length < (limit || 5); i++) {
      var st = stem(hits[i].w);
      if (!stems[st] && index.post[st]) { stems[st] = 1; out.push(st); }
    }
    return out;
  }

  function hostOf(url) {
    var m = /^[a-z]+:\/\/([^/?#]+)/i.exec(String(url || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // The ranker. opts: {limit, prefix (treat last term as a prefix), fuzzy}.
  // Returns {results:[{id, doc, score, matched}], total, terms, corrections}.
  function search(index, q, opts) {
    opts = opts || {};
    var parsed = parseQuery(q);
    var qterms = parsed.terms, corrections = {};
    if (!qterms.length && !parsed.phrases.length) return { results: [], total: 0, terms: [], corrections: {} };

    // Build the list of (stem alternatives × weight) each query term matches.
    var groups = [];
    for (var i = 0; i < qterms.length; i++) {
      var t = qterms[i], alts = [];
      if (index.post[t.stem]) alts.push({ stem: t.stem, mult: 1 });
      var isLast = i === qterms.length - 1;
      if (!alts.length && opts.prefix && isLast && t.raw.length >= 2) {
        prefixExpand(index, t.raw).forEach(function (st) { alts.push({ stem: st, mult: 0.85 }); });
      }
      if (!alts.length && opts.fuzzy !== false && t.raw.length >= 3) {
        var fz = fuzzyExpand(index, t.raw);
        fz.forEach(function (f) { alts.push({ stem: f.stem, mult: f.d === 1 ? 0.75 : 0.5 }); });
        if (fz.length) corrections[t.raw] = fz[0].word;
      }
      groups.push({ term: t, alts: alts, or: !!t.or });
    }
    for (var pi = 0; pi < parsed.phrases.length; pi++) {
      parsed.phrases[pi].forEach(function (st) {
        groups.push({ term: { raw: st, stem: st }, alts: index.post[st] ? [{ stem: st, mult: 1 }] : [], phrase: true });
      });
    }

    // Candidates = union of all matched postings; per-doc per-group best score.
    var cand = {}; // id → {score, matched, positions:{stem:[pos]}}
    var nGroups = groups.length;
    for (var g = 0; g < nGroups; g++) {
      var grp = groups[g];
      for (var a = 0; a < grp.alts.length; a++) {
        var alt = grp.alts[a], post = index.post[alt.stem], tIdf = idf(index, alt.stem);
        for (var id in post) {
          var p = post[id], doc = index.docs[id];
          if (!doc) continue;
          if (grp.term.field === 'title' && !p.ft) continue;
          var s = tIdf * bm25(index, p, doc.wlen) * alt.mult;
          var c = cand[id];
          if (!c) c = cand[id] = { gs: {}, pos: {} };
          if (!c.gs[g] || s > c.gs[g]) c.gs[g] = s;
          c.pos[alt.stem] = p.pos;
        }
      }
    }

    // Field filters, exclusions, phrase verification, final scoring.
    var results = [];
    outer:
    for (var cid in cand) {
      var d = index.docs[cid], c2 = cand[cid];
      for (var f = 0; f < parsed.fields.length; f++) {
        var ff = parsed.fields[f];
        if (ff.field === 'url' && fold(d.url).indexOf(ff.value) === -1) continue outer;
        if (ff.field === 'site' && hostOf(d.url).indexOf(ff.value) === -1) continue outer;
      }
      for (var e = 0; e < parsed.exclude.length; e++) {
        var xp = index.post[parsed.exclude[e]];
        if (xp && xp[cid]) continue outer;
      }
      for (var ph = 0; ph < parsed.phrases.length; ph++) {
        if (!phraseInDoc(index, cid, parsed.phrases[ph])) continue outer;
      }
      var matched = 0, score = 0;
      for (var gg = 0; gg < nGroups; gg++) if (c2.gs[gg]) { matched++; score += c2.gs[gg]; }
      if (!matched) continue;
      // Coverage: full matches must dominate partials (quadratic damping).
      var coverage = matched / nGroups;
      score *= 0.15 + 0.85 * coverage * coverage;
      // Proximity: terms close together beat terms scattered apart.
      if (matched > 1) score *= 1 + 0.25 / Math.max(1, minSpan(c2.pos) - matched + 1);
      // Exact / leading title match is what you meant.
      var ftit = fold(d.title);
      var qflat = qterms.map(function (t) { return t.raw; }).join(' ');
      if (qflat && ftit === qflat) score *= 1.8;
      else if (qflat && ftit.indexOf(qflat) === 0) score *= 1.3;
      results.push({ id: cid, doc: d, score: score, matched: matched });
    }

    results.sort(function (a, b) {
      return b.score - a.score || (a.doc.title < b.doc.title ? -1 : a.doc.title > b.doc.title ? 1 : 0) ||
             (a.id < b.id ? -1 : 1);
    });
    var total = results.length;
    if (opts.limit) results = results.slice(0, opts.limit);
    var stems = [];
    groups.forEach(function (grp) { grp.alts.forEach(function (al) { if (stems.indexOf(al.stem) === -1) stems.push(al.stem); }); });
    return { results: results, total: total, terms: stems, corrections: corrections };
  }

  // Smallest window (in token positions) containing one occurrence of each
  // matched stem — the classic proximity measure, over the capped positions.
  function minSpan(posByStem) {
    var lists = [], count = 0;
    for (var st in posByStem) { lists.push(posByStem[st]); count++; }
    if (count < 2) return 1;
    var events = [];
    for (var i = 0; i < lists.length; i++)
      for (var j = 0; j < lists[i].length; j++) events.push([lists[i][j], i]);
    events.sort(function (a, b) { return a[0] - b[0]; });
    var need = lists.length, have = 0, counts = {}, best = Infinity, lo = 0;
    for (var hi = 0; hi < events.length; hi++) {
      var t = events[hi][1];
      counts[t] = (counts[t] || 0) + 1;
      if (counts[t] === 1) have++;
      while (have === need) {
        best = Math.min(best, events[hi][0] - events[lo][0] + 1);
        var u = events[lo][1];
        counts[u]--; if (!counts[u]) have--;
        lo++;
      }
    }
    return best === Infinity ? 1000 : best;
  }

  function phraseInDoc(index, id, stems) {
    if (!stems.length) return true;
    var first = index.post[stems[0]];
    if (!first || !first[id]) return false;
    var starts = first[id].pos;
    for (var s = 0; s < starts.length; s++) {
      var ok = true;
      for (var k = 1; k < stems.length; k++) {
        var post = index.post[stems[k]];
        if (!post || !post[id] || post[id].pos.indexOf(starts[s] + k) === -1) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }

  /* ---- did you mean — frequency-weighted spelling correction ---- */
  function didYouMean(index, q) {
    var toks = tokenize(q);
    if (!toks.length) return null;
    var changed = false;
    var out = toks.map(function (w) {
      if (index.words[w] || STOPWORDS[w] || w.length < 3 || /^\d+$/.test(w)) return w;
      var max = w.length <= 4 ? 1 : 2, best = null;
      for (var v in index.words) {
        if (Math.abs(v.length - w.length) > max) continue;
        var d = editDistance(w, v, max);
        if (d <= max) {
          var sc = index.words[v] / Math.pow(4, d); // frequent + close wins
          if (!best || sc > best.sc || (sc === best.sc && v < best.v)) best = { v: v, sc: sc };
        }
      }
      if (best) { changed = true; return best.v; }
      return w;
    });
    return changed ? out.join(' ') : null;
  }

  /* ---- suggest — completions for search-as-you-type ---- */
  function suggest(index, q, limit) {
    limit = limit || 8;
    var toks = tokenize(q);
    if (!toks.length || /\s$/.test(q)) return [];
    var last = toks[toks.length - 1], head = toks.slice(0, -1).join(' ');
    var seen = {}, out = [];
    // Title-led completions first — whole results you can jump to.
    for (var id in index.docs) {
      var ft = fold(index.docs[id].title);
      if (ft && ft.indexOf(toks.join(' ')) === 0 && !seen[ft]) {
        seen[ft] = 1; out.push({ text: index.docs[id].title, kind: 'title' });
      }
    }
    // Then word completions on the token being typed.
    var words = [];
    for (var w in index.words)
      if (w.length > last.length && w.slice(0, last.length) === last) words.push({ w: w, n: index.words[w] });
    words.sort(function (a, b) { return b.n - a.n || (a.w < b.w ? -1 : 1); });
    for (var i = 0; i < words.length && out.length < limit; i++) {
      var text = (head ? head + ' ' : '') + words[i].w;
      if (!seen[text]) { seen[text] = 1; out.push({ text: text, kind: 'word' }); }
    }
    return out.slice(0, limit);
  }

  /* ---- snippet — best window of the document, hits marked ---- */
  // Returns [{t:'text'|'hit', s:'...'}] segments (HTML-safe by construction:
  // the caller escapes each segment's text; the engine never emits markup).
  function snippet(body, stems, maxWords) {
    maxWords = maxWords || 32;
    body = String(body || '');
    var words = [], re = /\S+/g, m;
    while ((m = re.exec(body))) words.push({ s: m[0], at: m.index });
    if (!words.length) return [{ t: 'text', s: '' }];
    var stemSet = {};
    (stems || []).forEach(function (s) { stemSet[s] = 1; });
    var hits = words.map(function (w) {
      var toks = tokenize(w.s);
      for (var i = 0; i < toks.length; i++) if (stemSet[stem(toks[i])]) return true;
      return false;
    });
    // Best window: most distinct hit-words; earliest wins ties.
    var best = 0, bestScore = -1;
    for (var start = 0; start < words.length; start += 8) {
      var score = 0;
      for (var k = start; k < Math.min(words.length, start + maxWords); k++) if (hits[k]) score++;
      if (score > bestScore) { bestScore = score; best = start; }
      if (start + maxWords >= words.length) break;
    }
    var end = Math.min(words.length, best + maxWords);
    var segs = [], run = '';
    if (best > 0) run = '… ';
    for (var i2 = best; i2 < end; i2++) {
      if (hits[i2]) {
        if (run) segs.push({ t: 'text', s: run });
        segs.push({ t: 'hit', s: words[i2].s });
        run = ' ';
      } else {
        run += words[i2].s + ' ';
      }
    }
    if (end < words.length) run = run.replace(/\s*$/, '') + ' …';
    if (run) segs.push({ t: 'text', s: run });
    return segs;
  }

  /* ================================================================== *
   *  6. Result fusion — one ranking across every source                 *
   * ================================================================== */

  // Reciprocal Rank Fusion (Cormack et al.): each source contributes
  // weight / (K + rank) per item; scores add when sources agree on a URL.
  // items: [{lists: [{source, weight, items:[{title,url,snippet,...}]}]}]
  var RRF_K = 12;
  function rrfMerge(lists, limit) {
    var byUrl = {}, order = [];
    for (var l = 0; l < lists.length; l++) {
      var src = lists[l], w = src.weight == null ? 1 : src.weight;
      for (var r = 0; r < src.items.length; r++) {
        var it = src.items[r];
        var key = fold(it.url || (src.source + '#' + r)).replace(/[?#].*$/, '').replace(/\/$/, '');
        var e = byUrl[key];
        if (!e) { e = byUrl[key] = { item: it, score: 0, sources: [] }; order.push(key); }
        e.score += w / (RRF_K + r);
        if (e.sources.indexOf(src.source) === -1) e.sources.push(src.source);
        // Prefer the richer snippet when two sources return the same URL.
        if ((it.snippet || '').length > (e.item.snippet || '').length) {
          e.item = Object.assign({}, e.item, { snippet: it.snippet });
        }
      }
    }
    var out = order.map(function (k) { return byUrl[k]; });
    out.sort(function (a, b) {
      return b.score - a.score ||
        (fold(a.item.title) < fold(b.item.title) ? -1 : fold(a.item.title) > fold(b.item.title) ? 1 : 0);
    });
    out.forEach(function (e) { e.item = Object.assign({}, e.item, { sources: e.sources, fused: e.score }); });
    return (limit ? out.slice(0, limit) : out).map(function (e) { return e.item; });
  }

  /* ================================================================== *
   *  7. The crawler's brain — URLs, robots.txt, the frontier            *
   * ================================================================== */

  var TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|msclkid|mc_eid|igshid|ref_src)$/i;

  // Canonicalise: resolve against base, http(s) only, drop #fragment and
  // tracking params, lowercase the host. Returns null for non-web schemes.
  function normalizeUrl(href, base) {
    href = String(href == null ? '' : href).trim();
    if (!href || /^(javascript|mailto|tel|data|blob|about):/i.test(href)) return null;
    var u;
    try { u = base ? new URL(href, base) : new URL(href); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if (u.search) {
      var kept = [];
      u.search.slice(1).split('&').forEach(function (kv) {
        if (kv && !TRACKING_PARAMS.test(kv.split('=')[0])) kept.push(kv);
      });
      u.search = kept.length ? '?' + kept.join('&') : '';
    }
    return u.href;
  }

  function sameOrigin(a, b) {
    var ma = /^([a-z]+:\/\/[^/?#]+)/i.exec(String(a) || ''), mb = /^([a-z]+:\/\/[^/?#]+)/i.exec(String(b) || '');
    return !!(ma && mb) && ma[1].toLowerCase() === mb[1].toLowerCase();
  }

  /* ---- HTML → document. From-scratch tag stripping (no DOM needed) ---- */
  function decodeEntities(s) {
    var MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—',
      ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©' };
    return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (all, code) {
      if (code.charAt(0) === '#') {
        var n = code.charAt(1).toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
      }
      return MAP[code.toLowerCase()] || all;
    });
  }

  function extractPage(html, url) {
    html = String(html || '');
    var meta = function (name) {
      var re = new RegExp('<meta[^>]+(?:name|property)=["\']' + name + '["\'][^>]*>', 'i');
      var tag = re.exec(html);
      if (!tag) return '';
      var c = /content=["']([^"']*)["']/i.exec(tag[0]);
      return c ? decodeEntities(c[1]).trim() : '';
    };
    var tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    var title = tm ? decodeEntities(tm[1]).replace(/\s+/g, ' ').trim() : '';
    if (!title) title = meta('og:title');
    var description = meta('description') || meta('og:description');
    var robotsMeta = meta('robots').toLowerCase();
    var noindex = robotsMeta.indexOf('noindex') !== -1;
    var canonical = (function () {
      var lm = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html);
      if (!lm) return null;
      var hm = /href=["']([^"']*)["']/i.exec(lm[0]);
      return hm ? normalizeUrl(hm[1], url) : null;
    })();

    // Links, before we strip tags.
    var links = [], seen = {}, lre = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>/gi, lm2;
    while ((lm2 = lre.exec(html))) {
      var abs = normalizeUrl(decodeEntities(lm2[1]), url);
      if (abs && !seen[abs]) { seen[abs] = 1; links.push(abs); }
    }

    // Visible text: kill non-content elements wholesale, then strip tags.
    var body = html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    body = decodeEntities(body).replace(/\s+/g, ' ').trim().slice(0, 12000);

    return { url: canonical || normalizeUrl(url) || String(url || ''), title: title,
      description: description, body: body, links: links, noindex: noindex };
  }

  /* ---- robots.txt (Robots Exclusion Protocol, simplified faithfully) ---- */
  function parseRobots(txt) {
    var groups = [], cur = null, lastWasUa = false;
    String(txt || '').split(/\r?\n/).forEach(function (line) {
      line = line.replace(/#.*$/, '').trim();
      if (!line) return;
      var m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
      if (!m) return;
      var key = m[1].toLowerCase(), val = m[2].trim();
      if (key === 'user-agent') {
        if (!lastWasUa || !cur) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
        cur.agents.push(val.toLowerCase());
        lastWasUa = true;
        return;
      }
      lastWasUa = false;
      if (!cur) return;
      if (key === 'allow') cur.allow.push(val);
      else if (key === 'disallow') cur.disallow.push(val);
    });
    return groups;
  }

  // Longest-match-wins between Allow and Disallow (Google's documented rule);
  // an empty Disallow means "allow everything"; no matching group = allowed.
  function robotsAllowed(groups, userAgent, path) {
    userAgent = String(userAgent || '').toLowerCase();
    path = String(path || '/');
    var grp = null, star = null;
    for (var i = 0; i < groups.length; i++) {
      for (var a = 0; a < groups[i].agents.length; a++) {
        var ag = groups[i].agents[a];
        if (ag === '*') { if (!star) star = groups[i]; }
        else if (userAgent.indexOf(ag) !== -1 && !grp) grp = groups[i];
      }
    }
    grp = grp || star;
    if (!grp) return true;
    var verdict = true, bestLen = -1;
    grp.disallow.forEach(function (rule) {
      if (rule && path.indexOf(rule) === 0 && rule.length > bestLen) { bestLen = rule.length; verdict = false; }
    });
    grp.allow.forEach(function (rule) {
      if (rule && path.indexOf(rule) === 0 && rule.length >= bestLen) { bestLen = rule.length; verdict = true; }
    });
    return verdict;
  }

  /* ---- the frontier — breadth-first, deduped, capped ---- */
  function createCrawler(seedUrl, opts) {
    opts = opts || {};
    var seed = normalizeUrl(seedUrl);
    var st = { queue: [], seen: {}, fetched: 0,
      maxPages: opts.maxPages || 25, maxDepth: opts.maxDepth == null ? 3 : opts.maxDepth,
      sameOriginOnly: opts.sameOriginOnly !== false, origin: seed };
    if (seed) { st.queue.push({ url: seed, depth: 0 }); st.seen[seed] = 1; }
    return st;
  }

  function crawlerNext(st) {
    if (st.fetched >= st.maxPages || !st.queue.length) return null;
    st.fetched += 1;
    return st.queue.shift();
  }

  function crawlerAdd(st, urls, depth) {
    var added = 0;
    for (var i = 0; i < urls.length; i++) {
      var u = normalizeUrl(urls[i]);
      if (!u || st.seen[u]) continue;
      if (depth > st.maxDepth) continue;
      if (st.sameOriginOnly && !sameOrigin(u, st.origin)) continue;
      st.seen[u] = 1;
      st.queue.push({ url: u, depth: depth });
      added++;
    }
    return added;
  }

  /* ================================================================== *
   *  8. Instant answers — maths, conversions, world clock               *
   * ================================================================== */

  /* ---- calculator: a real recursive-descent parser, no eval() ---- */
  function calc(expr) {
    var s = String(expr || '').replace(/,/g, '').replace(/×/g, '*').replace(/÷/g, '/')
      .replace(/\^/g, '**').replace(/\s+/g, '');
    if (!/^[\d.+\-*/%()]+$/.test(s) || !/\d/.test(s)) return null;
    if (!/[+\-*/%]/.test(s.replace(/^[-+]/, ''))) return null; // a bare number isn't a question
    var pos = 0;
    function peek() { return s.charAt(pos); }
    function number() {
      var m = /^\d+(\.\d+)?|^\.\d+/.exec(s.slice(pos));
      if (!m) throw 0;
      pos += m[0].length;
      return parseFloat(m[0]);
    }
    function base() {
      if (peek() === '(') { pos++; var v = expr3(); if (peek() !== ')') throw 0; pos++; return v; }
      if (peek() === '-') { pos++; return -base(); }
      if (peek() === '+') { pos++; return base(); }
      return number();
    }
    function power() {
      var v = base();
      if (s.slice(pos, pos + 2) === '**') { pos += 2; return Math.pow(v, power()); } // right-assoc
      return v;
    }
    function expr2() {
      var v = power();
      while (peek() && '*/%'.indexOf(peek()) !== -1 && s.slice(pos, pos + 2) !== '**') {
        var op = s.charAt(pos++); var r = power();
        v = op === '*' ? v * r : op === '/' ? v / r : v % r;
      }
      return v;
    }
    function expr3() {
      var v = expr2();
      while (peek() === '+' || peek() === '-') { var op = s.charAt(pos++); var r = expr2(); v = op === '+' ? v + r : v - r; }
      return v;
    }
    try {
      var v2 = expr3();
      if (pos !== s.length || !isFinite(v2)) return null;
      return Math.round(v2 * 1e10) / 1e10;
    } catch (e) { return null; }
  }

  /* ---- unit conversion: factor tables per dimension ---- */
  var UNITS = {
    km: { d: 'len', f: 1000 }, kilometre: { d: 'len', f: 1000 }, kilometer: { d: 'len', f: 1000 },
    m: { d: 'len', f: 1 }, metre: { d: 'len', f: 1 }, meter: { d: 'len', f: 1 },
    cm: { d: 'len', f: 0.01 }, mm: { d: 'len', f: 0.001 },
    mi: { d: 'len', f: 1609.344 }, mile: { d: 'len', f: 1609.344 }, miles: { d: 'len', f: 1609.344 },
    yd: { d: 'len', f: 0.9144 }, yard: { d: 'len', f: 0.9144 },
    ft: { d: 'len', f: 0.3048 }, foot: { d: 'len', f: 0.3048 }, feet: { d: 'len', f: 0.3048 },
    inch: { d: 'len', f: 0.0254 }, inches: { d: 'len', f: 0.0254 }, 'in': { d: 'len', f: 0.0254 },
    kg: { d: 'mass', f: 1 }, kilogram: { d: 'mass', f: 1 }, kilograms: { d: 'mass', f: 1 },
    g: { d: 'mass', f: 0.001 }, gram: { d: 'mass', f: 0.001 }, grams: { d: 'mass', f: 0.001 },
    lb: { d: 'mass', f: 0.45359237 }, lbs: { d: 'mass', f: 0.45359237 }, pound: { d: 'mass', f: 0.45359237 }, pounds: { d: 'mass', f: 0.45359237 },
    oz: { d: 'mass', f: 0.028349523125 }, ounce: { d: 'mass', f: 0.028349523125 }, ounces: { d: 'mass', f: 0.028349523125 },
    st: { d: 'mass', f: 6.35029318 }, stone: { d: 'mass', f: 6.35029318 },
    l: { d: 'vol', f: 1 }, litre: { d: 'vol', f: 1 }, liter: { d: 'vol', f: 1 }, litres: { d: 'vol', f: 1 },
    ml: { d: 'vol', f: 0.001 },
    gal: { d: 'vol', f: 4.54609 }, gallon: { d: 'vol', f: 4.54609 }, gallons: { d: 'vol', f: 4.54609 }, // imperial
    pint: { d: 'vol', f: 0.56826125 }, pints: { d: 'vol', f: 0.56826125 },
    mph: { d: 'speed', f: 0.44704 }, kmh: { d: 'speed', f: 0.2777778 }, kph: { d: 'speed', f: 0.2777778 },
    knots: { d: 'speed', f: 0.514444 }, knot: { d: 'speed', f: 0.514444 },
    kb: { d: 'data', f: 1e3 }, mb: { d: 'data', f: 1e6 }, gb: { d: 'data', f: 1e9 }, tb: { d: 'data', f: 1e12 },
    kib: { d: 'data', f: 1024 }, mib: { d: 'data', f: 1048576 }, gib: { d: 'data', f: 1073741824 },
    c: { d: 'temp' }, celsius: { d: 'temp' }, f: { d: 'temp' }, fahrenheit: { d: 'temp' }, k: { d: 'temp' }, kelvin: { d: 'temp' }
  };
  function tempTo(v, from, to) {
    var c = from === 'c' ? v : from === 'f' ? (v - 32) * 5 / 9 : v - 273.15;
    return to === 'c' ? c : to === 'f' ? c * 9 / 5 + 32 : c + 273.15;
  }
  function convert(q) {
    var m = /^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([a-z°]+)\s+(?:in|to|as|into)\s+°?\s*([a-z°]+)\s*\??\s*$/i
      .exec(fold(q).replace(/°/g, ''));
    if (!m) return null;
    var v = parseFloat(m[1]);
    var uf = UNITS[m[2]], ut = UNITS[m[3]];
    if (!uf || !ut || uf.d !== ut.d) return null;
    var tKey = function (u) { return u === 'fahrenheit' ? 'f' : u === 'celsius' ? 'c' : u === 'kelvin' ? 'k' : u; };
    var out = uf.d === 'temp' ? tempTo(v, tKey(m[2]), tKey(m[3])) : v * uf.f / ut.f;
    out = Math.round(out * 1e6) / 1e6;
    return { value: out, from: m[2], to: m[3], text: m[1] + ' ' + m[2] + ' = ' + out + ' ' + m[3] };
  }

  /* ---- world clock: parse the city; the shell renders the moment ---- */
  var TIMEZONES = {
    london: 'Europe/London', manchester: 'Europe/London', paris: 'Europe/Paris',
    berlin: 'Europe/Berlin', madrid: 'Europe/Madrid', rome: 'Europe/Rome',
    amsterdam: 'Europe/Amsterdam', zurich: 'Europe/Zurich', geneva: 'Europe/Zurich',
    dubai: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai', riyadh: 'Asia/Riyadh',
    istanbul: 'Europe/Istanbul', moscow: 'Europe/Moscow', mumbai: 'Asia/Kolkata',
    delhi: 'Asia/Kolkata', karachi: 'Asia/Karachi', dhaka: 'Asia/Dhaka',
    singapore: 'Asia/Singapore', 'hong kong': 'Asia/Hong_Kong', shanghai: 'Asia/Shanghai',
    beijing: 'Asia/Shanghai', tokyo: 'Asia/Tokyo', seoul: 'Asia/Seoul',
    sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', auckland: 'Pacific/Auckland',
    'new york': 'America/New_York', boston: 'America/New_York', miami: 'America/New_York',
    toronto: 'America/Toronto', chicago: 'America/Chicago', dallas: 'America/Chicago',
    denver: 'America/Denver', 'los angeles': 'America/Los_Angeles',
    'san francisco': 'America/Los_Angeles', seattle: 'America/Los_Angeles',
    vancouver: 'America/Vancouver', 'mexico city': 'America/Mexico_City',
    'sao paulo': 'America/Sao_Paulo', 'buenos aires': 'America/Argentina/Buenos_Aires',
    cairo: 'Africa/Cairo', lagos: 'Africa/Lagos', nairobi: 'Africa/Nairobi',
    johannesburg: 'Africa/Johannesburg', utc: 'UTC'
  };
  function parseTimeQuery(q) {
    var m = /^\s*(?:what(?:'?s| is)?\s+)?(?:the\s+)?time(?:\s+is\s+it)?\s+in\s+(.+?)\s*\??\s*$/i.exec(fold(q));
    if (!m) return null;
    var city = m[1].trim();
    var tz = TIMEZONES[city];
    if (!tz) return null;
    return { city: city.replace(/\b[a-z]/g, function (ch) { return ch.toUpperCase(); }), zone: tz };
  }

  /* ---- percentages: "15% of 80" ---- */
  function parsePercent(q) {
    var m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(-?\d+(?:[,.]\d+)*)\s*$/i
      .exec(fold(q));
    if (!m) return null;
    var pct = parseFloat(m[1]), base = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(pct) || !isFinite(base)) return null;
    var v = Math.round(pct * base / 100 * 1e10) / 1e10;
    return { value: v, text: m[1] + '% of ' + m[2] + ' = ' + v };
  }

  /* ---- live currency: "100 usd to gbp", "£50 in eur" ----
   * The engine parses; the shell resolves with live ECB rates. The code table
   * is the ECB reference set (what frankfurter.app serves keylessly). */
  var CURRENCIES = {};
  ('usd eur gbp jpy aud bgn brl cad chf cny czk dkk hkd huf idr ils inr isk ' +
   'krw mxn myr nok nzd php pln ron sek sgd thb try zar').split(' ')
    .forEach(function (c) { CURRENCIES[c] = 1; });
  var CURRENCY_SYMBOLS = { '$': 'usd', '£': 'gbp', '€': 'eur', '¥': 'jpy' };
  function parseCurrency(q) {
    var m = /^\s*(?:convert\s+)?([$£€¥])?\s*(\d+(?:[,.]\d+)*)\s*([a-z]{3})?\s+(?:in|to|into|as)\s+(?:([a-z]{3})|([$£€¥]))\s*$/i
      .exec(fold(q));
    if (!m) return null;
    var from = m[3] ? m[3].toLowerCase() : (m[1] ? CURRENCY_SYMBOLS[m[1]] : null);
    var to = m[4] ? m[4].toLowerCase() : (m[5] ? CURRENCY_SYMBOLS[m[5]] : null);
    if (!from || !to || !CURRENCIES[from] || !CURRENCIES[to] || from === to) return null;
    var amount = parseFloat(m[2].replace(/,/g, ''));
    if (!isFinite(amount)) return null;
    return { amount: amount, from: from.toUpperCase(), to: to.toUpperCase() };
  }

  /* ---- crypto prices: "bitcoin price", "eth price in gbp" ---- */
  var CRYPTO = { btc: 'bitcoin', bitcoin: 'bitcoin', eth: 'ethereum', ethereum: 'ethereum',
    sol: 'solana', solana: 'solana', doge: 'dogecoin', dogecoin: 'dogecoin',
    xrp: 'ripple', ripple: 'ripple', ada: 'cardano', cardano: 'cardano',
    ltc: 'litecoin', litecoin: 'litecoin', bnb: 'binancecoin', trx: 'tron', tron: 'tron',
    xmr: 'monero', monero: 'monero' };
  function parseCrypto(q) {
    var m = /^\s*(?:price of\s+)?(\w+)\s+(?:price|value)(?:\s+in\s+([a-z]{3}))?\s*$/i.exec(fold(q)) ||
            (/^\s*price of\s+(\w+)\s*$/i.exec(fold(q)));
    if (!m) return null;
    var id = CRYPTO[String(m[1]).toLowerCase()];
    if (!id) return null;
    var vs = m[2] ? String(m[2]).toLowerCase() : 'usd';
    return { id: id, symbol: String(m[1]).toUpperCase(), vs: vs };
  }

  /* ---- weather: "weather in london", "tokyo weather" ---- */
  function parseWeather(q) {
    var f = fold(q).replace(/\?+\s*$/, '').trim();
    var m = /^weather\s+(?:in|at|for)\s+(.+)$/.exec(f) ||
            /^weather\s+(.+)$/.exec(f) ||
            /^(.+?)\s+weather$/.exec(f);
    if (!m) return null;
    var place = m[1].trim();
    if (!place || place.length > 60 || /["\-:!]/.test(place)) return null;
    return { place: place };
  }

  /* ---- dictionary: "define serendipity", "meaning of petrichor" ---- */
  function parseDefine(q) {
    var m = /^\s*(?:define|definition of|meaning of|what does)\s+([a-z][a-z\- ]*?)(?:\s+mean)?\s*\??\s*$/i
      .exec(fold(q));
    if (!m) return null;
    var word = m[1].trim();
    if (!word || word.split(/\s+/).length > 3) return null;
    return { word: word };
  }

  /* ---- date maths (clock-injected: `now` in ms, UTC arithmetic) ---- */
  var DAY_MS = 86400000;
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
    august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  var NAMED_DAYS = { christmas: [11, 25], 'christmas day': [11, 25], 'new year': [0, 1],
    'new years': [0, 1], "new year's": [0, 1], halloween: [9, 31],
    valentines: [1, 14], "valentine's day": [1, 14], 'valentines day': [1, 14] };

  function isoOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function dateFloor(ms) { return Math.floor(ms / DAY_MS) * DAY_MS; }

  // "christmas" | "25 december" | "december 25" | "25 dec 2027" → next occurrence (UTC ms)
  function parseDateSpec(s, now) {
    s = fold(s).replace(/\?+\s*$/, '').trim();
    var md = NAMED_DAYS[s], y = null, m2;
    if (!md) {
      if ((m2 = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)(?:\s+(\d{4}))?$/.exec(s))) {
        if (MONTHS[m2[2]] == null) return null;
        md = [MONTHS[m2[2]], parseInt(m2[1], 10)]; y = m2[3] ? parseInt(m2[3], 10) : null;
      } else if ((m2 = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/.exec(s))) {
        if (MONTHS[m2[1]] == null) return null;
        md = [MONTHS[m2[1]], parseInt(m2[2], 10)]; y = m2[3] ? parseInt(m2[3], 10) : null;
      } else return null;
    }
    if (md[1] < 1 || md[1] > 31) return null;
    var nowD = new Date(dateFloor(now));
    var year = y != null ? y : nowD.getUTCFullYear();
    var t = Date.UTC(year, md[0], md[1]);
    if (y == null && t < dateFloor(now)) t = Date.UTC(year + 1, md[0], md[1]);
    var chk = new Date(t);
    if (chk.getUTCMonth() !== md[0] || chk.getUTCDate() !== md[1]) return null; // e.g. 31 feb
    return t;
  }

  function parseDateQuery(q, now) {
    var f = fold(q).replace(/\?+\s*$/, '').trim();
    var m = /^(?:how many\s+)?days\s+(?:until|till|to)\s+(.+)$/.exec(f);
    if (m) {
      var t = parseDateSpec(m[1], now);
      if (t == null) return null;
      var days = Math.round((t - dateFloor(now)) / DAY_MS);
      return { kind: 'days-until', days: days, dateISO: isoOf(t),
        weekday: WEEKDAYS[new Date(t).getUTCDay()], label: m[1].trim() };
    }
    m = /^(\d+)\s+(day|week|month)s?\s+from\s+(?:today|now)$/.exec(f);
    if (m) {
      var n = parseInt(m[1], 10), t2;
      if (m[2] === 'day') t2 = dateFloor(now) + n * DAY_MS;
      else if (m[2] === 'week') t2 = dateFloor(now) + n * 7 * DAY_MS;
      else { var d0 = new Date(dateFloor(now)); t2 = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + n, Math.min(d0.getUTCDate(), 28)); }
      return { kind: 'date-from-now', n: n, unit: m[2], dateISO: isoOf(t2),
        weekday: WEEKDAYS[new Date(t2).getUTCDay()] };
    }
    m = /^what\s+day\s+(?:is|was|falls on)\s+(.+)$/.exec(f);
    if (m && m[1] !== 'it' && m[1] !== 'today') {
      var t3 = parseDateSpec(m[1], now);
      if (t3 == null) return null;
      return { kind: 'weekday-of', dateISO: isoOf(t3), weekday: WEEKDAYS[new Date(t3).getUTCDay()],
        label: m[1].trim() };
    }
    return null;
  }

  // One front door: what kind of instant answer (if any) does this query earn?
  // On-device types (calc/percent/convert/time/date) carry their answer; live
  // types (currency/crypto/weather/define) carry what the shell should fetch.
  function instantAnswer(q, now) {
    now = now == null ? 0 : now;
    var s = String(q == null ? '' : q).trim()
      .replace(/^(?:what\s+is|what's|whats|how\s+much\s+is)\s+/i, '')
      .replace(/[?=]+\s*$/, '');
    var v = calc(s);
    if (v !== null) return { type: 'calc', query: q, value: v, text: s + ' = ' + v };
    var p = parsePercent(s);
    if (p) return { type: 'percent', query: q, value: p.value, text: p.text };
    var cv = convert(s);
    if (cv) return { type: 'convert', query: q, value: cv.value, text: cv.text };
    var cur = parseCurrency(s);
    if (cur) return { type: 'currency', query: q, amount: cur.amount, from: cur.from, to: cur.to };
    var cr = parseCrypto(s);
    if (cr) return { type: 'crypto', query: q, id: cr.id, symbol: cr.symbol, vs: cr.vs };
    var t = parseTimeQuery(s);
    if (t) return { type: 'time', query: q, city: t.city, zone: t.zone };
    var dq = parseDateQuery(s, now);
    if (dq) { dq.type = 'date'; dq.query = q; return dq; }
    var w = parseWeather(s);
    if (w) return { type: 'weather', query: q, place: w.place };
    var df = parseDefine(s);
    if (df) return { type: 'define', query: q, word: df.word };
    return null;
  }

  /* ================================================================== */

  return {
    // text pipeline
    fold: fold, tokenize: tokenize, stem: stem, STOPWORDS: STOPWORDS,
    editDistance: editDistance,
    // index
    createIndex: createIndex, addDoc: addDoc, removeDoc: removeDoc,
    serializeIndex: serializeIndex, deserializeIndex: deserializeIndex,
    // query + rank
    parseQuery: parseQuery, parseBang: parseBang, BANGS: BANGS,
    search: search, idf: idf, suggest: suggest, didYouMean: didYouMean,
    snippet: snippet, rrfMerge: rrfMerge,
    // crawler brain
    normalizeUrl: normalizeUrl, sameOrigin: sameOrigin, extractPage: extractPage,
    parseRobots: parseRobots, robotsAllowed: robotsAllowed,
    createCrawler: createCrawler, crawlerNext: crawlerNext, crawlerAdd: crawlerAdd,
    // instant answers
    calc: calc, convert: convert, parseTimeQuery: parseTimeQuery,
    parsePercent: parsePercent, parseCurrency: parseCurrency, parseCrypto: parseCrypto,
    parseWeather: parseWeather, parseDefine: parseDefine,
    parseDateSpec: parseDateSpec, parseDateQuery: parseDateQuery,
    instantAnswer: instantAnswer
  };
});

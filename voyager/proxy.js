/**
 * Voyager proxy — the part that makes it a proper, full browser
 * =============================================================
 *
 * Voyager's chrome renders pages in a sandboxed <iframe> using your device's
 * real web engine. That's enough for most of the web — but the biggest sites
 * (YouTube, Google, X, Instagram, most logins and banks) send an
 * `X-Frame-Options` / CSP `frame-ancestors` header that tells your browser:
 * "refuse to display me inside a frame you don't own." Your browser obeys —
 * that header is what stops clickjacking — so those pages stay blank.
 *
 * The only honest way past it is to stop asking the site to be framed and
 * instead FETCH it ourselves, on a server, strip the framing header, rewrite
 * its links so they keep flowing through us, and hand the result back to the
 * frame from OUR origin — where no cross-origin framing rule applies. That is
 * what a "web proxy browser" is, and it's what voyager/server.mjs does. This
 * file is the pure, testable brains of it: no sockets, no fetch, just the URL
 * math and HTML/CSS rewriting, so every rule can be unit-tested in isolation.
 *
 * Honest limits (said plainly, in keeping with the rest of Voyager):
 *   • A proxy is not a from-scratch engine. Pages render and you can browse
 *     them, but very heavy single-page apps, DRM video playback, WebSockets
 *     and some strict-CORS APIs may partially work or not at all.
 *   • Cookies are OFF by default, so logins don't persist — that keeps one
 *     shared proxy origin from mixing every site's session together, and
 *     keeps the proxy from being a credential funnel.
 *   • The proxy operator sees the traffic. Run it yourself, locally. It is
 *     bound to localhost and refuses private/internal hosts (SSRF guard) so
 *     it can't be turned against your own network.
 *
 * UMD so server.mjs and the Node tests share exactly one implementation.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.VoyagerProxy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Schemes we never rewrite — they aren't navigable fetches. */
  var INERT = /^(#|javascript:|data:|mailto:|tel:|blob:|about:|vbscript:)/i;

  /** Resolve a possibly-relative URL against the page it appeared on. */
  function absolutize(href, base) {
    var s = String(href == null ? '' : href).trim();
    if (!s || INERT.test(s)) return null;
    try { return new URL(s, base).href; } catch (e) { return null; }
  }

  /**
   * Wrap an absolute http(s) URL so the browser routes it back through us.
   * proxyPath may already carry a query (e.g. "/proxy?key=SECRET" when the
   * deployment is key-locked), so the `url` param joins with the right
   * separator and the key rides along on every rewritten link.
   */
  function proxify(absUrl, proxyPath) {
    var s = String(absUrl == null ? '' : absUrl);
    if (!/^https?:\/\//i.test(s)) return s;
    var p = String(proxyPath == null ? '/proxy' : proxyPath);
    var sep = p.indexOf('?') === -1 ? '?' : '&';
    if (s.indexOf(p + sep + 'url=') === 0) return s;    // already proxied
    return p + sep + 'url=' + encodeURIComponent(s);
  }

  /** absolutize + proxify in one step; returns null when the value is inert. */
  function rewriteUrl(value, base, proxyPath) {
    var abs = absolutize(value, base);
    return abs == null ? null : proxify(abs, proxyPath);
  }

  /* ── CSS: url(...) and @import ── */
  function rewriteCss(css, base, proxyPath) {
    css = String(css == null ? '' : css);
    css = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, function (m, dq, sq, uq) {
      var val = dq != null ? dq : (sq != null ? sq : uq);
      var r = rewriteUrl(val, base, proxyPath);
      return r == null ? m : 'url("' + r + '")';
    });
    css = css.replace(/@import\s+(?:url\()?\s*(?:"([^"]*)"|'([^']*)')\s*\)?/gi, function (m, dq, sq) {
      var val = dq != null ? dq : sq;
      var r = rewriteUrl(val, base, proxyPath);
      return r == null ? m : '@import "' + r + '"';
    });
    return css;
  }

  /* ── srcset="url 1x, url 2x" ── */
  function rewriteSrcset(value, base, proxyPath) {
    return String(value).split(',').map(function (cand) {
      var seg = cand.trim().split(/\s+/);
      if (seg[0]) { var r = rewriteUrl(seg[0], base, proxyPath); if (r != null) seg[0] = r; }
      return seg.join(' ');
    }).join(', ');
  }

  /** Read a `<base href>` if the document sets one, else the page URL itself. */
  function effectiveBase(html, pageUrl) {
    var m = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(html);
    if (!m) return pageUrl;
    var v = m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
    var abs = absolutize(v, pageUrl);
    return abs || pageUrl;
  }

  /**
   * The client shim injected into every proxied page. It keeps URLs created
   * AFTER load flowing through the proxy (fetch/XHR/dynamic links) and bridges
   * in-page navigation up to the Voyager chrome via postMessage, so the
   * omnibox, history and back/forward track the real page you're on.
   * Written as a joined array to keep the `</script>` terminator safe.
   */
  function clientShim(pageUrl, proxyPath, opts) {
    var trackers = Math.floor(Number(opts && opts.trackers) || 0);
    var body = [
      '(function(){',
      'var B=' + JSON.stringify(proxyPath) + ',PAGE=' + JSON.stringify(pageUrl) + ',TRK=' + trackers + ';',
      'var SEP=B.indexOf("?")===-1?"?":"&";',   // key-locked proxies pass B="/proxy?key=…"
      'function abs(u){try{return new URL(u,PAGE).href;}catch(e){return null;}}',
      'function P(u){if(u==null)return u;var s=String(u);',
      'if(/^(#|javascript:|data:|mailto:|tel:|blob:|about:)/i.test(s))return s;',
      'if(s.indexOf(B+SEP+"url=")===0)return s;var a=abs(s);',
      'if(!a||!/^https?:/i.test(a))return s;return B+SEP+"url="+encodeURIComponent(a);}',
      'function real(u){var s=String(u||""),k=B+SEP+"url=";',
      'if(s.indexOf(k)===0){try{return decodeURIComponent(s.slice(k.length));}catch(e){}}return abs(s)||s;}',
      // fetch / XHR keep flowing through the proxy
      'var of=window.fetch;if(of)window.fetch=function(i,init){try{if(typeof i==="string")i=P(i);else if(i&&i.url)i=new Request(P(i.url),i);}catch(e){}return of.call(this,i,init);};',
      'var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{u=P(u);}catch(e){}return xo.apply(this,[m,u].concat([].slice.call(arguments,2)));};',
      // link clicks: proxy the target, and tell the chrome where we went
      'document.addEventListener("click",function(e){if(e.defaultPrevented||e.button)return;',
      'var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;',
      'var h=a.getAttribute("href");if(!h||/^(#|javascript:|mailto:|tel:)/i.test(h))return;',
      // links are already server-rewritten to /proxy?url=…; real() decodes back to the true target
      'var t=real(h);if(!t||!/^https?:/i.test(t))return;e.preventDefault();',
      'if(a.target==="_blank"){parent.postMessage({voyager:"open",url:t},"*");return;}',
      'parent.postMessage({voyager:"navigate",url:t},"*");location.href=P(t);},true);',
      // GET forms (site search boxes): build the query, then navigate proxied
      'document.addEventListener("submit",function(e){var f=e.target;if(!f||f.tagName!=="FORM")return;',
      'if((f.getAttribute("method")||"get").toLowerCase()!=="get")return;e.preventDefault();',
      'var act=real(f.getAttribute("action")||PAGE);var qs="";try{qs=new URLSearchParams(new FormData(f)).toString();}catch(x){}',
      'var tgt=act+(act.indexOf("?")>=0?"&":"?")+qs;parent.postMessage({voyager:"navigate",url:tgt},"*");location.href=P(tgt);},true);',
      // report where we landed (redirects included) so the chrome can catch up
      'function announce(){try{parent.postMessage({voyager:"loaded",url:PAGE,title:document.title,trackers:TRK},"*");}catch(e){}}',
      'if(document.readyState==="complete")announce();window.addEventListener("load",announce);',
      '})();'
    ].join('');
    return '<script>' + body + '<\/script>';
  }

  /**
   * Rewrite a full HTML document so every link, asset and style keeps flowing
   * through the proxy, framing blocks are removed, and the client shim is in.
   */
  function rewriteHtml(html, pageUrl, proxyPath, opts) {
    html = String(html == null ? '' : html);
    proxyPath = proxyPath || '/proxy';
    var base = effectiveBase(html, pageUrl);

    html = html.replace(/<base\b[^>]*>/gi, '');                       // we resolve to absolute ourselves
    html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');

    html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, function (m, o, css, c) {
      return o + rewriteCss(css, base, proxyPath) + c;
    });
    html = html.replace(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, function (m, dq, sq) {
      var v = dq != null ? dq : sq, q = dq != null ? '"' : "'";
      return 'style=' + q + rewriteCss(v, base, proxyPath) + q;
    });
    html = html.replace(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, function (m, dq, sq) {
      var v = dq != null ? dq : sq, q = dq != null ? '"' : "'";
      return 'srcset=' + q + rewriteSrcset(v, base, proxyPath) + q;
    });
    html = html.replace(/\b(href|src|poster|action|formaction|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
      function (m, attr, dq, sq, uq) {
        var val = dq != null ? dq : (sq != null ? sq : uq);
        var r = rewriteUrl(val, base, proxyPath);
        if (r == null) return m;
        var q = sq != null ? "'" : '"';
        return attr + '=' + q + r + q;
      });

    var shim = clientShim(base, proxyPath, opts);
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, function (m) { return m + shim; });
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, function (m) { return m + shim; });
    return shim + html;
  }

  /* ── response headers: keep content-type, drop everything that fights framing ── */
  var DROP = /^(x-frame-options|content-security-policy|content-security-policy-report-only|content-length|content-encoding|transfer-encoding|strict-transport-security|set-cookie|x-content-type-options|x-xss-protection|report-to|nel|permissions-policy|cross-origin-embedder-policy|cross-origin-opener-policy|cross-origin-resource-policy)$/i;
  function isDroppedHeader(name) { return DROP.test(String(name || '')); }

  /* ── SSRF guard: refuse private / internal / loopback / metadata hosts ── */
  function isBlockedHost(host) {
    var h = String(host == null ? '' : host).toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return true;
    if (h === 'localhost' || /(^|\.)localhost$/.test(h)) return true;
    if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
    if (/^127\./.test(h)) return true;                         // loopback
    if (/^10\./.test(h)) return true;                          // private A
    if (/^192\.168\./.test(h)) return true;                    // private C
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;     // private B
    if (/^169\.254\./.test(h)) return true;                    // link-local / cloud metadata
    if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;           // IPv6 unique-local
    if (/^fe80:/.test(h)) return true;                         // IPv6 link-local
    return false;
  }

  /** Is a fetched content-type HTML / CSS (so it needs rewriting)? */
  function isHtml(ct) { return /\btext\/html|application\/xhtml\+xml/i.test(String(ct || '')); }
  function isCss(ct) { return /\btext\/css/i.test(String(ct || '')); }

  /* ════════════════════════ reader extraction ════════════════════════ */

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (m, e) {
        var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
        if (e.charAt(0) === '#') {
          var code = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          try { return String.fromCharCode(code); } catch (x) { return m; }
        }
        return named[e.toLowerCase()] != null ? named[e.toLowerCase()] : m;
      });
  }

  function stripTags(html) {
    return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** The document <title>, cleaned of the trailing " - Site name" tail. */
  function readTitle(html) {
    var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    var t = m ? stripTags(m[1]) : '';
    var h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    return (h1 ? stripTags(h1[1]) : '') || t.replace(/\s*[|–—-]\s*[^|–—-]{1,40}$/, '') || t;
  }

  /**
   * Readability-lite: pull the main article out of a page as clean text + a
   * minimal HTML skeleton (headings, paragraphs, lists, links, images). No
   * DOM, no dependencies — it scores block candidates by how much real
   * paragraph text they hold, strips chrome (nav/aside/footer/script/style/
   * forms), and keeps the winner. Good enough for articles, docs and posts;
   * this is what feeds Reader mode and the searchable web memory.
   */
  function extractReadable(html, pageUrl) {
    html = String(html == null ? '' : html);
    var title = readTitle(html);

    // isolate <body>, then remove non-content chrome wholesale
    var body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    var work = body ? body[1] : html;
    work = work
      .replace(/<(script|style|noscript|template|svg|iframe|form|button|select)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(nav|aside|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');

    // candidate containers: article, main, or divs/sections — pick the one with the most <p> text
    var best = null, bestScore = 0;
    var re = /<(article|main|section|div)[^>]*>([\s\S]*?)<\/\1>/gi, m;
    while ((m = re.exec(work))) {
      var inner = m[2];
      var paras = inner.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
      var textLen = 0;
      for (var i = 0; i < paras.length; i++) textLen += stripTags(paras[i]).length;
      var score = textLen + (m[1].toLowerCase() === 'article' ? 800 : m[1].toLowerCase() === 'main' ? 300 : 0);
      if (score > bestScore) { bestScore = score; best = inner; }
    }
    var region = best || work;

    // keep only content-bearing tags, as a clean skeleton
    var kept = [];
    var tagRe = /<(h[1-6]|p|li|blockquote|pre|figcaption)[^>]*>([\s\S]*?)<\/\1>/gi, k;
    while ((k = tagRe.exec(region))) {
      var tag = k[1].toLowerCase();
      var txt = stripTags(k[2]);
      if (!txt) continue;
      if ((tag === 'p' || tag === 'blockquote') && txt.length < 2) continue;
      kept.push({ tag: tag, text: txt });
    }
    // images with a src (resolved absolute)
    var imgs = [];
    var imgRe = /<img[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>/gi, im;
    while ((im = imgRe.exec(region)) && imgs.length < 12) {
      var src = im[1] != null ? im[1] : (im[2] != null ? im[2] : im[3]);
      var abs = absolutize(src, pageUrl);
      if (abs && /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(abs)) imgs.push(abs);
    }

    var textParts = [];
    for (var j = 0; j < kept.length; j++) textParts.push(kept[j].text);
    var text = textParts.join('\n\n');
    var words = text ? text.split(/\s+/).length : 0;

    // minimal, safe HTML skeleton (text is entity-escaped, so it's inert)
    function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
    var htmlParts = [];
    for (var b = 0; b < kept.length; b++) {
      var t2 = kept[b].tag, x = esc(kept[b].text);
      if (t2 === 'li') htmlParts.push('<li>' + x + '</li>');
      else if (/^h[1-6]$/.test(t2)) htmlParts.push('<' + t2 + '>' + x + '</' + t2 + '>');
      else if (t2 === 'blockquote') htmlParts.push('<blockquote>' + x + '</blockquote>');
      else if (t2 === 'pre') htmlParts.push('<pre>' + x + '</pre>');
      else htmlParts.push('<p>' + x + '</p>');
    }
    return { title: title, text: text, html: htmlParts.join('\n'), words: words, images: imgs };
  }

  /* ── feeds: discovery + a minimal RSS/Atom parser (for Follow) ── */

  /** The RSS/Atom feed URLs a page advertises via <link rel="alternate">, absolutized. */
  function discoverFeeds(html, pageUrl) {
    var out = [], m;
    var re = /<link\b[^>]*>/gi;
    var s = String(html == null ? '' : html);
    while ((m = re.exec(s)) && out.length < 3) {
      var tag = m[0];
      if (!/rel\s*=\s*["']?alternate["']?/i.test(tag)) continue;
      if (!/type\s*=\s*["']?application\/(rss|atom)\+xml["']?/i.test(tag)) continue;
      var href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(tag);
      if (!href) continue;
      var abs = absolutize(href[1] != null ? href[1] : (href[2] != null ? href[2] : href[3]), pageUrl);
      if (abs && out.indexOf(abs) === -1) out.push(abs);
    }
    return out;
  }

  function feedField(block, tag) {
    var m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(block);
    if (!m) return '';
    return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')).trim();
  }

  /**
   * Parse just enough RSS 2.0 / Atom to follow a site: the feed title and its
   * items' {title, url, ts}. Pure string work — no XML DOM, unit-testable.
   */
  function parseFeed(xml, feedUrl) {
    var s = String(xml == null ? '' : xml);
    var isAtom = /<feed[\s>]/i.test(s) && !/<rss[\s>]/i.test(s);
    var items = [], m;
    if (isAtom) {
      var head = s.split(/<entry[\s>]/i)[0];
      var title = feedField(head, 'title');
      var re = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
      while ((m = re.exec(s)) && items.length < 20) {
        var e = m[1];
        var link = /<link\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/i.exec(e);
        var url = link ? absolutize(link[1] != null ? link[1] : link[2], feedUrl) : null;
        if (!url) continue;
        var when = feedField(e, 'updated') || feedField(e, 'published');
        items.push({ title: feedField(e, 'title'), url: url, ts: when ? (Date.parse(when) || null) : null });
      }
      return { title: title, items: items };
    }
    var chanHead = s.split(/<item[\s>]/i)[0];
    var rssTitle = feedField(chanHead, 'title');
    var ire = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
    while ((m = ire.exec(s)) && items.length < 20) {
      var it = m[1];
      var u = feedField(it, 'link') || feedField(it, 'guid');
      u = u ? absolutize(u, feedUrl) : null;
      if (!u || !/^https?:/i.test(u)) continue;
      var pub = feedField(it, 'pubDate') || feedField(it, 'dc:date');
      items.push({ title: feedField(it, 'title'), url: u, ts: pub ? (Date.parse(pub) || null) : null });
    }
    return { title: rssTitle, items: items };
  }

  /* ── ad / tracker blocking: a curated host blocklist ── */
  var TRACKERS = [
    'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com', 'googletagservices.com',
    'google-analytics.com', 'analytics.google.com', 'adservice.google.com', 'pagead2.googlesyndication.com',
    'g.doubleclick.net', 'connect.facebook.net', 'facebook.com/tr', 'ads-twitter.com', 'analytics.twitter.com',
    'scorecardresearch.com', 'quantserve.com', 'adnxs.com', 'adsystem.com', 'amazon-adsystem.com',
    'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'pubmatic.com', 'rubiconproject.com',
    'openx.net', 'casalemedia.com', 'moatads.com', 'adsafeprotected.com', 'bidswitch.net', 'rlcdn.com',
    'hotjar.com', 'mixpanel.com', 'segment.com', 'segment.io', 'fullstory.com', 'mouseflow.com',
    'newrelic.com', 'nr-data.net', 'branch.io', 'amplitude.com', 'clarity.ms', 'bat.bing.com',
    'sentry.io', 'doubleverify.com', 'yieldmo.com', 'sharethrough.com', 'teads.tv', 'smartadserver.com',
  ];

  /**
   * Should a fetched sub-resource be blocked as an ad/tracker? Matches a host
   * against the blocklist by exact host or as a subdomain of a listed domain
   * (so "www.google-analytics.com" and "ssl.google-analytics.com" both go).
   * A couple of entries include a path fragment (e.g. facebook.com/tr) matched
   * against the full URL. Pure and list-injectable so it's unit-testable.
   */
  function isTracker(url, list) {
    var hosts = list || TRACKERS;
    var s = String(url == null ? '' : url).toLowerCase();
    var host = (function () {
      var m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(s);
      var h = m ? m[1] : s.split('/')[0];
      var at = h.lastIndexOf('@'); if (at !== -1) h = h.slice(at + 1);
      var colon = h.lastIndexOf(':'); if (colon !== -1 && h.indexOf(']') === -1) h = h.slice(0, colon);
      return h;
    })();
    for (var i = 0; i < hosts.length; i++) {
      var d = hosts[i];
      if (d.indexOf('/') !== -1) { if (s.indexOf(d) !== -1) return true; continue; } // host+path fragment
      if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
    }
    return false;
  }

  /**
   * The receipt behind the shield: how many DISTINCT tracker URLs does this
   * page's HTML ask for (script/img/iframe/link srcs and hrefs)? The server
   * counts before rewriting and the shim reports it up, so the chrome can say
   * "this page carried N trackers" with a straight face. Pure and testable.
   */
  function countTrackers(html, list) {
    var seen = {}, n = 0, m;
    var re = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
    var s = String(html == null ? '' : html);
    while ((m = re.exec(s))) {
      var u = m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]);
      if (!u || seen[u]) continue;
      seen[u] = 1;
      if (isTracker(u, list)) n++;
    }
    return n;
  }

  /**
   * Soft open-relay guard for a PUBLICLY DEPLOYED proxy: is `origin` (the
   * Origin/Referer of an incoming /proxy request) allowed by `allowlist`?
   * An empty allowlist means "no restriction" (fine for a localhost box).
   * A missing origin is allowed only when the allowlist is empty — a deployed
   * proxy with an allowlist rejects requests that don't declare a known origin.
   * Referer/Origin can be spoofed, so this only stops casual abuse; the real
   * protections are the SSRF host guard and keeping the deployment small.
   */
  function originAllowed(origin, allowlist) {
    var list = (allowlist || []).map(function (o) { return String(o).replace(/\/+$/, '').toLowerCase(); }).filter(Boolean);
    if (!list.length) return true;
    var o = String(origin == null ? '' : origin).toLowerCase();
    if (!o) return false;
    // origin may arrive as a full Referer URL — reduce to scheme://host[:port]
    var m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(o);
    var norm = (m ? m[1] : o).replace(/\/+$/, '');
    return list.indexOf(norm) !== -1;
  }

  return {
    absolutize: absolutize,
    proxify: proxify,
    rewriteUrl: rewriteUrl,
    rewriteCss: rewriteCss,
    rewriteSrcset: rewriteSrcset,
    effectiveBase: effectiveBase,
    clientShim: clientShim,
    rewriteHtml: rewriteHtml,
    isDroppedHeader: isDroppedHeader,
    isBlockedHost: isBlockedHost,
    originAllowed: originAllowed,
    isTracker: isTracker,
    countTrackers: countTrackers,
    discoverFeeds: discoverFeeds,
    parseFeed: parseFeed,
    TRACKERS: TRACKERS,
    stripTags: stripTags,
    extractReadable: extractReadable,
    isHtml: isHtml,
    isCss: isCss,
  };
});

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
  function clientShim(pageUrl, proxyPath) {
    var body = [
      '(function(){',
      'var B=' + JSON.stringify(proxyPath) + ',PAGE=' + JSON.stringify(pageUrl) + ';',
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
      'function announce(){try{parent.postMessage({voyager:"loaded",url:PAGE,title:document.title},"*");}catch(e){}}',
      'if(document.readyState==="complete")announce();window.addEventListener("load",announce);',
      '})();'
    ].join('');
    return '<script>' + body + '<\/script>';
  }

  /**
   * Rewrite a full HTML document so every link, asset and style keeps flowing
   * through the proxy, framing blocks are removed, and the client shim is in.
   */
  function rewriteHtml(html, pageUrl, proxyPath) {
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

    var shim = clientShim(base, proxyPath);
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
    isHtml: isHtml,
    isCss: isCss,
  };
});

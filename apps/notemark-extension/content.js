/* NoteMark content script — highlight text and pin sticky notes on any page. */
(function () {
  'use strict';
  if (window.__noteMarkLoaded) return;
  window.__noteMarkLoaded = true;

  var pageKey = location.origin + location.pathname + location.search;
  var annotations = []; // {id, type:'highlight', text, occurrence} | {id, type:'note', selector, text}
  var mode = null;      // null | 'highlight' | 'note'

  // ---------- Styles ----------
  var style = document.createElement('style');
  style.setAttribute('data-nm-ui', '');
  style.textContent = [
    '.notemark-highlight { background: #ffd54a !important; color: #1a1a1a !important; border-radius: 2px; padding: 0 1px; cursor: pointer; }',
    '.notemark-flash { outline: 3px solid #f5a623 !important; outline-offset: 2px; transition: outline-color 0.3s; }',
    '.notemark-note { position: absolute; z-index: 2147483644; width: 210px; background: #fff8c4; color: #333;',
    '  border: 1px solid #e6d98a; border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,0.25);',
    '  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '.notemark-note-head { display: flex; justify-content: space-between; align-items: center;',
    '  padding: 4px 8px; background: #f7e98d; border-radius: 8px 8px 0 0; font-size: 11px; color: #7a6b1e; font-weight: 600; }',
    '.notemark-note-head button { border: none; background: none; cursor: pointer; font-size: 14px; color: #7a6b1e; padding: 0 2px; line-height: 1; }',
    '.notemark-note textarea { width: 100%; min-height: 64px; border: none; background: transparent; resize: vertical;',
    '  padding: 8px; font: inherit; color: inherit; outline: none; box-sizing: border-box; display: block; }',
    '#notemark-toolbar { position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;',
    '  display: flex; flex-direction: column; align-items: flex-end; gap: 8px;',
    '  font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '#notemark-panel { display: none; flex-direction: column; gap: 6px; background: #171b26; border: 1px solid #2c3350;',
    '  border-radius: 12px; padding: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }',
    '#notemark-panel.nm-open { display: flex; }',
    '#notemark-panel button { display: flex; align-items: center; gap: 8px; border: 1px solid transparent; background: #222842;',
    '  color: #e6e9f4; border-radius: 8px; padding: 7px 12px; cursor: pointer; font: inherit; white-space: nowrap; }',
    '#notemark-panel button:hover { background: #2b3252; }',
    '#notemark-panel button.nm-active { border-color: #ffd54a; background: #3a3620; color: #ffd54a; }',
    '#notemark-fab { width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;',
    '  background: #ffd54a; color: #1a1a1a; font-weight: 800; font-size: 15px;',
    '  box-shadow: 0 6px 18px rgba(0,0,0,0.4); }',
    '#notemark-fab:hover { background: #ffe075; }',
    '#notemark-hint { background: #171b26; color: #aeb6d0; border: 1px solid #2c3350; border-radius: 8px;',
    '  padding: 5px 10px; font-size: 12px; display: none; }',
    '#notemark-hint.nm-open { display: block; }'
  ].join('\n');
  document.documentElement.appendChild(style);

  // ---------- Text-position machinery (find & wrap Nth occurrence) ----------
  function textNodesUnder(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('[data-nm-ui], .notemark-note, #notemark-toolbar')) return NodeFilter.FILTER_REJECT;
        var tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function buildIndex() {
    var nodes = textNodesUnder(document.body);
    var full = '';
    var entries = nodes.map(function (n) {
      var e = { node: n, start: full.length };
      full += n.data;
      return e;
    });
    return { full: full, entries: entries };
  }

  function findSegments(text, occurrence) {
    var idx = buildIndex();
    var pos = -1, from = 0;
    for (var i = 0; i <= occurrence; i++) {
      pos = idx.full.indexOf(text, from);
      if (pos === -1) return null;
      from = pos + 1;
    }
    var end = pos + text.length;
    var segs = [];
    idx.entries.forEach(function (e) {
      var nStart = e.start;
      var nEnd = e.start + e.node.data.length;
      if (nEnd <= pos || nStart >= end) return;
      segs.push({
        node: e.node,
        start: Math.max(0, pos - nStart),
        end: Math.min(e.node.data.length, end - nStart)
      });
    });
    return segs;
  }

  function wrapSegments(segs, id) {
    // Wrap in reverse document order; each segment lives in its own text node.
    for (var i = segs.length - 1; i >= 0; i--) {
      var s = segs[i];
      if (s.end <= s.start) continue;
      var range = document.createRange();
      range.setStart(s.node, s.start);
      range.setEnd(s.node, s.end);
      var span = document.createElement('span');
      span.className = 'notemark-highlight';
      span.setAttribute('data-nm-id', id);
      try {
        range.surroundContents(span);
      } catch (e) { /* node changed underneath us; skip this segment */ }
    }
  }

  function occurrenceOfRange(range, text) {
    var idx = buildIndex();
    var abs = null;
    var sc = range.startContainer;
    if (sc.nodeType === Node.TEXT_NODE) {
      for (var i = 0; i < idx.entries.length; i++) {
        if (idx.entries[i].node === sc) {
          abs = idx.entries[i].start + range.startOffset;
          break;
        }
      }
    }
    if (abs === null) {
      // Selection started on an element boundary: use the first text node it touches.
      for (var j = 0; j < idx.entries.length; j++) {
        var n = idx.entries[j].node;
        if (range.intersectsNode && range.intersectsNode(n)) {
          abs = idx.entries[j].start;
          break;
        }
      }
    }
    if (abs === null) return null;
    var occ = 0, from = 0;
    while (true) {
      var p = idx.full.indexOf(text, from);
      if (p === -1 || p >= abs) break;
      occ++;
      from = p + 1;
    }
    return occ;
  }

  function unwrapHighlight(id) {
    var spans = document.querySelectorAll('.notemark-highlight[data-nm-id="' + id + '"]');
    spans.forEach(function (span) {
      var parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parent.normalize();
    });
  }

  // ---------- Sticky notes ----------
  function cssPath(el) {
    if (!(el instanceof Element)) return null;
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        return parts.join(' > ');
      }
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      node = parent;
    }
    parts.unshift('body');
    return parts.join(' > ');
  }

  function renderNote(ann) {
    var anchor = null;
    try { anchor = document.querySelector(ann.selector); } catch (e) { /* bad selector */ }

    var note = document.createElement('div');
    note.className = 'notemark-note';
    note.setAttribute('data-nm-ui', '');
    note.setAttribute('data-nm-id', ann.id);

    var head = document.createElement('div');
    head.className = 'notemark-note-head';
    var label = document.createElement('span');
    label.textContent = 'NoteMark';
    var close = document.createElement('button');
    close.textContent = '×';
    close.title = 'Delete note';
    close.addEventListener('click', function () { deleteAnnotation(ann.id); });
    head.appendChild(label);
    head.appendChild(close);

    var ta = document.createElement('textarea');
    ta.value = ann.text || '';
    ta.placeholder = 'Write a note…';
    var t;
    ta.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        ann.text = ta.value;
        persist();
      }, 350);
    });

    note.appendChild(head);
    note.appendChild(ta);
    document.body.appendChild(note);

    if (anchor) {
      var rect = anchor.getBoundingClientRect();
      var left = rect.right + window.scrollX + 10;
      if (left + 220 > document.documentElement.scrollWidth) {
        left = Math.max(10, rect.left + window.scrollX);
      }
      note.style.top = (rect.top + window.scrollY) + 'px';
      note.style.left = left + 'px';
    } else {
      note.style.top = (window.scrollY + 80) + 'px';
      note.style.left = '20px';
    }
    return note;
  }

  // ---------- Persistence ----------
  function persist() {
    var payload = {};
    if (annotations.length) {
      payload[pageKey] = annotations;
      chrome.storage.local.set(payload, updateBadge);
    } else {
      chrome.storage.local.remove(pageKey, updateBadge);
    }
  }

  function updateBadge() {
    try {
      chrome.runtime.sendMessage({ type: 'nm-badge', count: annotations.length });
    } catch (e) { /* extension context gone (reloaded); ignore */ }
  }

  function deleteAnnotation(id) {
    var ann = annotations.find(function (a) { return a.id === id; });
    if (!ann) return;
    if (ann.type === 'highlight') {
      unwrapHighlight(id);
    } else {
      var el = document.querySelector('.notemark-note[data-nm-id="' + id + '"]');
      if (el) el.remove();
    }
    annotations = annotations.filter(function (a) { return a.id !== id; });
    persist();
  }

  function newId() {
    return 'nm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Toolbar ----------
  var toolbar = document.createElement('div');
  toolbar.id = 'notemark-toolbar';
  toolbar.setAttribute('data-nm-ui', '');

  var hint = document.createElement('div');
  hint.id = 'notemark-hint';

  var panel = document.createElement('div');
  panel.id = 'notemark-panel';

  var highlightBtn = document.createElement('button');
  highlightBtn.textContent = '✍ Highlight text';
  var noteBtn = document.createElement('button');
  noteBtn.textContent = '📌 Add sticky note';

  var fab = document.createElement('button');
  fab.id = 'notemark-fab';
  fab.textContent = 'NM';
  fab.title = 'NoteMark tools';

  panel.appendChild(highlightBtn);
  panel.appendChild(noteBtn);
  toolbar.appendChild(hint);
  toolbar.appendChild(panel);
  toolbar.appendChild(fab);
  document.body.appendChild(toolbar);

  function setMode(next) {
    mode = (mode === next) ? null : next;
    highlightBtn.classList.toggle('nm-active', mode === 'highlight');
    noteBtn.classList.toggle('nm-active', mode === 'note');
    if (mode === 'highlight') {
      hint.textContent = 'Select text on the page to highlight it';
    } else if (mode === 'note') {
      hint.textContent = 'Click any element to pin a note to it';
    }
    hint.classList.toggle('nm-open', mode !== null);
  }

  fab.addEventListener('click', function () {
    var open = panel.classList.toggle('nm-open');
    if (!open) {
      mode = null;
      highlightBtn.classList.remove('nm-active');
      noteBtn.classList.remove('nm-active');
      hint.classList.remove('nm-open');
    }
  });
  highlightBtn.addEventListener('click', function () { setMode('highlight'); });
  noteBtn.addEventListener('click', function () { setMode('note'); });

  // ---------- Mode interactions ----------
  document.addEventListener('mouseup', function (e) {
    if (mode !== 'highlight') return;
    if (e.target instanceof Element && e.target.closest('[data-nm-ui]')) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    var text = range.toString();
    if (!text.trim()) return;
    var occurrence = occurrenceOfRange(range, text);
    if (occurrence === null) return;
    var segs = findSegments(text, occurrence);
    if (!segs || !segs.length) return;
    var id = newId();
    wrapSegments(segs, id);
    annotations.push({ id: id, type: 'highlight', text: text, occurrence: occurrence, created: Date.now() });
    sel.removeAllRanges();
    persist();
  });

  document.addEventListener('click', function (e) {
    if (mode !== 'note') return;
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('[data-nm-ui]')) return;
    e.preventDefault();
    e.stopPropagation();
    var selector = cssPath(e.target) || 'body';
    var ann = { id: newId(), type: 'note', selector: selector, text: '', created: Date.now() };
    annotations.push(ann);
    var el = renderNote(ann);
    var ta = el.querySelector('textarea');
    if (ta) ta.focus();
    persist();
    setMode('note'); // toggles note mode back off after placing one
  }, true);

  // ---------- Restore on load ----------
  chrome.storage.local.get(pageKey, function (data) {
    var saved = data && data[pageKey];
    if (Array.isArray(saved)) {
      annotations = saved;
      annotations.forEach(function (ann) {
        if (ann.type === 'highlight') {
          var segs = findSegments(ann.text, ann.occurrence);
          if (segs) wrapSegments(segs, ann.id);
        } else if (ann.type === 'note') {
          renderNote(ann);
        }
      });
    }
    updateBadge();
  });

  // ---------- Popup messaging ----------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'nm-list') {
      sendResponse({
        pageKey: pageKey,
        annotations: annotations.map(function (a) {
          return {
            id: a.id,
            type: a.type,
            preview: a.type === 'highlight'
              ? a.text
              : (a.text && a.text.trim() ? a.text : '(empty note)')
          };
        })
      });
    } else if (msg.type === 'nm-jump') {
      var target = null;
      var ann = annotations.find(function (a) { return a.id === msg.id; });
      if (ann && ann.type === 'highlight') {
        target = document.querySelector('.notemark-highlight[data-nm-id="' + msg.id + '"]');
      } else if (ann) {
        target = document.querySelector('.notemark-note[data-nm-id="' + msg.id + '"]');
      }
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('notemark-flash');
        setTimeout(function () { target.classList.remove('notemark-flash'); }, 1600);
      }
      sendResponse({ ok: !!target });
    } else if (msg.type === 'nm-delete') {
      deleteAnnotation(msg.id);
      sendResponse({ ok: true, count: annotations.length });
    }
  });
})();

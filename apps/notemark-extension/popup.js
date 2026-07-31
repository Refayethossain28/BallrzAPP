/* NoteMark popup — lists annotations for the current tab. */
'use strict';

var listEl = document.getElementById('list');
var globalEl = document.getElementById('global-count');
var currentTabId = null;

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function showEmpty(message) {
  listEl.textContent = '';
  listEl.appendChild(el('div', 'empty', message));
}

function refreshGlobalCount() {
  chrome.storage.local.get(null, function (all) {
    var total = 0;
    Object.keys(all || {}).forEach(function (k) {
      if (Array.isArray(all[k])) total += all[k].length;
    });
    globalEl.textContent = total + ' total';
  });
}

function renderList(annotations) {
  listEl.textContent = '';
  if (!annotations.length) {
    showEmpty('No annotations on this page yet. Use the NM button in the page corner to highlight text or pin notes.');
    return;
  }
  annotations.forEach(function (a) {
    var item = el('div', 'item');
    item.appendChild(el('div', 'kind ' + (a.type === 'highlight' ? 'h' : 'n'),
      a.type === 'highlight' ? 'H' : 'N'));
    var prev = el('div', 'preview', a.preview);
    prev.title = a.preview;
    item.appendChild(prev);
    var del = el('button', 'del', '×');
    del.title = 'Delete annotation';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      chrome.tabs.sendMessage(currentTabId, { type: 'nm-delete', id: a.id }, function () {
        void chrome.runtime.lastError;
        loadAnnotations();
        refreshGlobalCount();
      });
    });
    item.appendChild(del);
    item.addEventListener('click', function () {
      chrome.tabs.sendMessage(currentTabId, { type: 'nm-jump', id: a.id }, function () {
        void chrome.runtime.lastError;
      });
    });
    listEl.appendChild(item);
  });
}

function loadAnnotations() {
  chrome.tabs.sendMessage(currentTabId, { type: 'nm-list' }, function (res) {
    if (chrome.runtime.lastError || !res) {
      showEmpty('NoteMark cannot run on this page (browser pages and the Web Store are off-limits).');
      return;
    }
    renderList(res.annotations || []);
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  if (!tabs || !tabs.length) {
    showEmpty('No active tab found.');
    return;
  }
  currentTabId = tabs[0].id;
  loadAnnotations();
});

refreshGlobalCount();

/* NoteMark background service worker — install setup and badge counts. */
'use strict';

chrome.runtime.onInstalled.addListener(function (details) {
  console.log('NoteMark installed:', details.reason);
  chrome.action.setBadgeBackgroundColor({ color: '#f5a623' });
  chrome.action.setBadgeTextColor({ color: '#1a1a1a' });
});

function pageKeyFromUrl(url) {
  try {
    var u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin + u.pathname + u.search;
  } catch (e) {
    return null;
  }
}

function setBadge(tabId, count) {
  chrome.action.setBadgeText({
    tabId: tabId,
    text: count > 0 ? String(count) : ''
  });
}

function refreshBadgeForTab(tabId, url) {
  var key = pageKeyFromUrl(url);
  if (!key) {
    setBadge(tabId, 0);
    return;
  }
  chrome.storage.local.get(key, function (data) {
    var anns = data && data[key];
    setBadge(tabId, Array.isArray(anns) ? anns.length : 0);
  });
}

// Content script reports its live count after any change.
chrome.runtime.onMessage.addListener(function (msg, sender) {
  if (msg && msg.type === 'nm-badge' && sender.tab && typeof sender.tab.id === 'number') {
    setBadge(sender.tab.id, msg.count | 0);
  }
});

// Keep the badge accurate when switching or loading tabs.
chrome.tabs.onActivated.addListener(function (info) {
  chrome.tabs.get(info.tabId, function (tab) {
    if (chrome.runtime.lastError || !tab) return;
    refreshBadgeForTab(tab.id, tab.url || '');
  });
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status === 'complete') {
    refreshBadgeForTab(tabId, tab.url || '');
  }
});

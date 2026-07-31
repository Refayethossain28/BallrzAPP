# NoteMark — page annotator (Chrome extension, Manifest V3)

Highlight text and pin sticky notes on any web page. Annotations are stored
per URL in `chrome.storage.local` and restored automatically when you revisit
the page.

## Load it in Chrome (unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select this folder (`notemark-extension/`).
4. Visit any http/https page — a round **NM** button appears in the
   bottom-right corner.

## Using it

- Click **NM** to open the toolbar.
- **Highlight text**: toggle it on, then select any text on the page. The
  selection is wrapped in yellow highlight spans and saved.
- **Add sticky note**: toggle it on, then click any element. A yellow sticky
  note is pinned next to it; type into it and it autosaves.
- Click the extension's toolbar icon (the puzzle-piece menu if unpinned) to
  open the **popup**: it lists every annotation on the current tab with
  jump-to (click a row) and delete (×), plus a global count across all pages.
- The badge on the extension icon shows how many annotations the current
  page has.

## Files

| File            | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `manifest.json` | MV3 manifest: content script, popup action, background worker  |
| `content.js`    | Floating toolbar, highlighting, sticky notes, persistence      |
| `popup.html/js` | Annotation list for the current tab, jump-to and delete        |
| `background.js` | Service worker: install hook and per-tab badge counts          |
| `icon.svg`      | The NoteMark icon artwork                                      |

## A note on icons

Chrome does **not** accept SVG for extension icons (`icons` /
`action.default_icon` must be PNG for reliable rendering, and the Chrome Web
Store requires PNG for publishing). To keep this demo manifest 100% loadable,
the icon fields are simply omitted — Chrome then shows a default lettered
icon, which is fine for an unpacked demo. `icon.svg` is included as the
source artwork; for store publishing, export it to PNG at 16/32/48/128 px and
add:

```json
"icons": { "16": "icon16.png", "32": "icon32.png", "48": "icon48.png", "128": "icon128.png" },
"action": { "default_icon": { "16": "icon16.png", "32": "icon32.png" }, ... }
```

## Limitations (by design, it's a demo)

- Highlights are re-anchored by text content and occurrence index, so they
  can drift on pages whose text changes between visits.
- Sticky notes anchor to a CSS selector path; heavy DOM changes can move or
  orphan a note (orphans fall back to the top-left of the page).
- Pages that block content scripts (`chrome://`, the Web Store, some PDFs)
  cannot be annotated.

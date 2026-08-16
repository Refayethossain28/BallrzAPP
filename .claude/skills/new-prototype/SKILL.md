---
name: new-prototype
description: >
  Scaffold a new BallrzAPP concept prototype following the house conventions:
  a root-level app directory with a pure clock-injected engine, a vm-sandboxed
  unit test in scripts/, smoke-test-clean inline HTML, a zero-dependency icon
  generator, and npm test registration. Use whenever the user asks to start,
  scaffold, or spin up a new prototype/concept app in this repo.
---

# New prototype scaffold

Every prototype in this repo follows the same shape. When creating one named
`<name>` (short, lowercase, one word — like `glimpse`, `magpie`, `seeker`):

## 1. Directory layout (repo root)

```
<name>/
  index.html      # the whole UI — inline classic <script>, loads engine.js via <script src>
  engine.js       # ALL logic — pure, deterministic, zero DOM, zero I/O
  manifest.json   # PWA manifest (name, icons 180/192/512, standalone, theme colors)
  sw.js           # offline-first service worker precaching the shell
  icon.svg        # the motif (also rasterized to PNGs by the icon generator)
```

## 2. The engine (the load-bearing convention)

`engine.js` is a **classic script** (not an ES module) wrapped in an IIFE that
exports both ways, so the same file loads in a browser `<script>`, in the
headless smoke sandbox, and via `module.exports` in the test runner:

```js
(function (root) {
  'use strict';
  // ... pure functions only ...
  var api = { /* every rule of the app */ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.<Name>Engine = api;
})(typeof self !== 'undefined' ? self : this);
```

Rules that make it testable (see `glimpse/engine.js` for the reference example):
- **Clock-injected**: every time-dependent function takes `now` as a parameter.
  Never call `Date.now()` inside the engine.
- **Seeded randomness**: deterministic hashing (FNV-1a) instead of `Math.random()`
  wherever output must be stable for tests.
- Zero DOM, zero network, zero storage — `index.html` owns all of that.

## 3. Unit test: `scripts/test-<name>-logic.mjs`

Copy the pattern from `scripts/test-glimpse-logic.mjs`: load `engine.js` into a
`vm` sandbox (`sandbox.self = sandbox`, `module.exports` capture), use
`node:assert/strict`, a fixed `NOW = Date.UTC(...)`, and compare cross-realm
values by JSON shape. Zero dependencies — Node built-ins only. Header comment
explains what the engine does and ends with `Run: node scripts/test-<name>-logic.mjs`.

## 4. Register the test in root `package.json`

- Append `&& node scripts/test-<name>-logic.mjs` to the end of the `test` script.
- Add `"test:<name>": "node scripts/test-<name>-logic.mjs"`.

## 5. Icons: `scripts/gen-<name>-icons.mjs`

Zero-dependency PNG encoder (copy the approach from `scripts/gen-magpie-icons.mjs`
— `node:zlib` + minimal PNG chunks), rasterizing the same motif as `icon.svg`
into `icon-180.png`, `icon-192.png`, `icon-512.png` inside `<name>/`. Run it and
commit the PNGs.

## 6. Smoke-test cleanliness

`scripts/smoke-prototypes.mjs` automatically discovers and executes every inline
classic `<script>` in every `.html` file in a stubbed-DOM vm sandbox. So the new
`index.html` must not reference any identifier it doesn't define or load — a
top-level `ReferenceError` fails CI. Run `npm run test:smoke` before committing.

## 7. Verify before committing

```
npm run test:<name>   # the new unit test
npm run test:smoke    # inline-script sanity across all prototypes
```

Both must pass. Full `npm test` is what CI runs; the two commands above are the
fast local subset that covers a new prototype.

## 8. Publishing (only if asked)

Prototypes are published by `.github/workflows/pages.yml` via explicit `cp`
lines into `_site/`. If the prototype should go live, add a copy block there and
confirm `node scripts/check-published-assets.mjs` passes — every asset the page
or its service worker references must actually be copied, or visitors get 404s.

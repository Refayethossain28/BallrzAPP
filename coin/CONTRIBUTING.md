# Shipping a change to TimeCoin — the release checklist

TimeCoin is used by real people trading real time and favours, so every change
follows the same short, boring routine. Nothing here is clever; it just makes
sure a change is **verifiable, honest, and reaches everyone's device cleanly**.
Do these steps in order for every change to the app.

The four steps: **fingerprint → cache → tests → verify.** Then commit, push, PR.

---

## 0. Make the change

Keep the house style: **zero dependencies**, plain UMD modules that work both in
the browser (`self.BallrzX`) and the Node test sandbox (`module.exports`), and a
test for anything with real logic. New shared logic goes in its own `*.js`
module (like `mutual.js`, `reputation.js`, `bridge.js`) with a matching
`../scripts/test-*.mjs`, not buried in `index.html`.

---

## 1. Fingerprint — only if you changed hashed app code

The app shows a **code fingerprint** (in **🔒 Key security**) so anyone can check
they're running the genuine, untampered code. It is a SHA-256 over these files:

```
index.html  engine.js  mutual.js  reputation.js  bridge.js  config.js  qr.js  wordlist.js  i18n.js
```

If your change touched **any** of those, recompute it and publish the new value.

```sh
cd coin && node -e 'const{readFileSync}=require("fs"),{createHash}=require("crypto");
const f=["index.html","engine.js","mutual.js","reputation.js","bridge.js","config.js","qr.js","wordlist.js","i18n.js"];
const j=f.map(n=>n+"\n"+readFileSync(n,"utf8")).join("\n");
const h=createHash("sha256").update(Buffer.from(j,"utf8")).digest("hex");
console.log(h.slice(0,4)+"-"+h.slice(4,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16));
console.log(h);'
```

Then update the value in two places:

- **`SAFETY.md`** → the "Current release fingerprint" block (both the short
  `xxxx-xxxx-xxxx-xxxx` form **and** the full SHA-256).
- **`PUBLIC-LAUNCH.md`** → the short form in the launch checklist.

> If you added a **new** file that ships in the browser, add it to the file list
> above, in the same list inside `SAFETY.md`'s regeneration snippet, **and** in
> `computeFingerprint()` in `index.html` — all three must match, in this order.

Docs (`*.md`), the relay (`server.mjs`), the service worker (`sw.js`) and the
separate pages (`mine.html`, `join.html`, etc.) are **not** in the fingerprint —
changing only those means you can skip this step.

---

## 2. Cache — bump if you changed anything the app caches

The service worker (`sw.js`) precaches the app so it works offline. When any
cached file changes, bump the cache name so every device fetches the new copy
instead of a stale one:

```js
var CACHE = 'ballrzcoin-vNN';   // ← increment NN
```

If you added a browser-served file, also add it to the `SHELL` list in `sw.js`
(and to the static routes in `server.mjs` so the relay serves it).

---

## 3. Tests — run the whole suite

```sh
npm test          # from the repo root — must exit 0
```

Every module with logic has one (`test:coin`, `test:mutual`, `test:reputation`,
`test:bridge`, `test:relay`, `test:coinqr`, …); a new module means a new
`../scripts/test-*.mjs` wired into the `test` script in `package.json`.

---

## 4. Verify — actually drive the feature

Tests passing is necessary, not sufficient. Open the real app and exercise the
change end-to-end. A headless run (Chromium is preinstalled) catches wiring bugs
tests miss — module load order, event handlers, render calls. The pattern used
throughout this project: start the relay in-process, drive the page, assert on
the DOM / on what reaches the relay, and **fail on any console error**.

```js
import { createRelay } from '/abs/path/to/coin/server.mjs';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const server = createRelay({ rateCapacity: 100000 });
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(base, { waitUntil: 'domcontentloaded' });  // NOT networkidle — the app polls forever
// … drive the feature, assert on the DOM, then: process.exit(errors.length ? 1 : 0)
```

For a fingerprint change, confirm the value the browser shows in **🔒 Key
security** matches what you published in `SAFETY.md`.

---

## 5. Commit, push, open a PR

- One focused change per PR (they auto-deploy). Descriptive commit message.
- Push to your working branch and open the PR against `main`.
- Wait for CI (**test**, **ui**, **dispatch**) to go green, then merge.

---

## The honesty rule

TimeCoin is deliberately **"not crypto — nothing to buy, no price, not an
investment,"** just a fair way for neighbours to trade time and favours. Keep it
that way: never frame it as an investment, and keep the disclosures in
[`SECURITY.md`](SECURITY.md) truthful. When you add something that carries a real
limitation (as portable reputation and circle bridges do), **say so plainly** in
`SECURITY.md` and surface it in the UI rather than hiding it. That candour is
what earns the trust the currency asks for.

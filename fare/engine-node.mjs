/**
 * fare/engine-node.mjs — loads the browser-shaped classic script
 * public/engine.js into Node. The repo is type:module, so a plain require()
 * would mis-read the classic script as ESM; evaluating it with an injected
 * `module` mirrors exactly what the vm test sandbox and a <script> tag do.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./public/engine.js', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('module', 'self', src)(mod, {});

export default mod.exports;

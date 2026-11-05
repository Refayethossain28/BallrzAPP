/* Retouch — the pure photo-studio engine.
 * =====================================================================
 * Retouch is a browser photo editor in the mould of the one-sentence AI
 * editors: drop in a photo, pick a tool (headshot, background, object
 * removal, enhance, upscale, style) or just type what you want, and the
 * studio does it. Every rule lives HERE as pure, deterministic,
 * clock-injected functions with zero DOM and zero I/O — the credit plans,
 * the prompt-to-pipeline parser, the content policy, and the pixel math
 * itself (tone, levels, blur, sharpen, subject matting, inpainting,
 * resampling) over plain RGBA arrays. Unit-tested in
 * scripts/test-retouch-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  /* ---------------- deterministic hashing / seeded randomness ---------------- */

  // FNV-1a 32-bit — stable across platforms, good spread for short strings.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // One deterministic float in [0,1) from any seed string.
  function rand01(seed) {
    var h = hashStr(seed);
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  }

  // Cheap per-pixel noise: a 32-bit integer mix of (seed hash, index) → [0,1).
  // Same inputs, same noise — without building a string per pixel.
  function noise01(seedHash, i) {
    var h = (seedHash ^ Math.imul(i + 0x9e3779b9, 0x85ebca6b)) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }
  function round2(v) { return Math.round(v * 100) / 100; }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- the tools ---------------- */
  // Each tool is one studio job. `cost` is in credits; `presets` are the
  // named looks the settings panel offers for that tool.
  var TOOLS = [
    { id: 'headshot', label: 'Headshot', icon: '◉', cost: 3,
      blurb: 'A studio portrait from any photo of you: new backdrop, relit, sharpened.',
      presets: ['corporate', 'studio', 'outdoor', 'cinematic'] },
    { id: 'background', label: 'Background', icon: '▦', cost: 2,
      blurb: 'Cut the subject out and put it on a colour, a blur, or a studio gradient.',
      presets: ['white', 'blur', 'gradient', 'charcoal'] },
    { id: 'remove', label: 'Remove', icon: '✕', cost: 2,
      blurb: 'Paint over anything you want gone and the studio fills it in.',
      presets: [] },
    { id: 'enhance', label: 'Enhance', icon: '✦', cost: 1,
      blurb: 'Auto levels, a touch of sharpening, and the noise taken down.',
      presets: ['auto', 'soft', 'punchy'] },
    { id: 'upscale', label: 'Upscale', icon: '⤢', cost: 2,
      blurb: 'Double the resolution with a clean resample and edge sharpening.',
      presets: ['2x'] },
    { id: 'style', label: 'Style', icon: '◐', cost: 1,
      blurb: 'A finished look in one tap: film, noir, golden hour, vivid.',
      presets: ['film', 'noir', 'golden', 'vivid', 'mono'] },
    { id: 'prompt', label: 'Prompt', icon: '✎', cost: 2,
      blurb: 'Say what you want in a sentence. The studio turns it into edits.',
      presets: [] },
  ];
  var TOOL_BY_ID = {};
  TOOLS.forEach(function (t) { TOOL_BY_ID[t.id] = t; });
  function toolById(id) { return TOOL_BY_ID[id] || null; }

  /* ---------------- credits & plans ---------------- */
  // Free: a daily allowance that resets at midnight UTC. Pro: a monthly
  // pool. The ledger is a plain object the page keeps in localStorage:
  // { plan: 'free'|'pro', spent: { '<periodKey>': n } }.
  var PLANS = {
    free: { id: 'free', label: 'Free', allowance: 10, period: 'day', price: 0 },
    pro:  { id: 'pro', label: 'Pro', allowance: 400, period: 'month', price: 12 },
  };

  function dayKey(now) {
    var d = new Date(now);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function monthKey(now) {
    var d = new Date(now);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }
  function periodKey(plan, now) {
    return (PLANS[plan] || PLANS.free).period === 'month' ? monthKey(now) : dayKey(now);
  }
  function nextResetAt(plan, now) {
    var d = new Date(now);
    if ((PLANS[plan] || PLANS.free).period === 'month') {
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  function newLedger(plan) { return { plan: PLANS[plan] ? plan : 'free', spent: {} }; }

  function creditsLeft(ledger, now) {
    ledger = ledger || newLedger('free');
    var plan = PLANS[ledger.plan] || PLANS.free;
    var spent = Number((ledger.spent || {})[periodKey(plan.id, now)] || 0);
    return Math.max(0, plan.allowance - spent);
  }
  function canAfford(ledger, cost, now) { return creditsLeft(ledger, now) >= cost; }

  // Returns a NEW ledger with the cost recorded, or null if it can't be paid.
  function spend(ledger, cost, now) {
    ledger = ledger || newLedger('free');
    cost = Math.max(0, Math.round(Number(cost) || 0));
    if (!canAfford(ledger, cost, now)) return null;
    var key = periodKey(ledger.plan, now);
    var spent = {};
    Object.keys(ledger.spent || {}).forEach(function (k) { spent[k] = ledger.spent[k]; });
    spent[key] = (Number(spent[key]) || 0) + cost;
    return { plan: ledger.plan, spent: spent };
  }
  function switchPlan(ledger, plan) {
    ledger = ledger || newLedger('free');
    return { plan: PLANS[plan] ? plan : 'free', spent: ledger.spent || {} };
  }
  function creditsSummary(ledger, now) {
    ledger = ledger || newLedger('free');
    var plan = PLANS[ledger.plan] || PLANS.free;
    var left = creditsLeft(ledger, now);
    var resetMs = nextResetAt(plan.id, now) - now;
    var hours = Math.max(1, Math.ceil(resetMs / HOUR));
    var resetText = hours < 48 ? 'resets in ' + hours + 'h' : 'resets in ' + Math.ceil(hours / 24) + ' days';
    return { plan: plan.id, planLabel: plan.label, left: left, allowance: plan.allowance,
             period: plan.period, resetText: resetText, low: left <= 2 };
  }

  /* ---------------- content policy ---------------- */
  // Retouch edits photos; it will not strip, sexualise, or fake anyone.
  // The parser refuses these before anything is spent or rendered.
  var POLICY_RULES = [
    { re: /\b(undress|nudif(y|ied|ication)|deep ?nudes?|nudes?|naked|nudity|topless|strip(ped|ping)? (her|him|them|down)|take (off|away) (her|his|their) (clothes|clothing|top|shirt|dress|bra|pants|underwear)|(clothes|clothing) off|remove (her|his|their|the|all) (clothes|clothing|top|shirt|dress|bra|pants|underwear|bikini|lingerie)|see[- ]?through|x-?ray (vision|the)|nsfw|porn\w*|sex(y|ual|ualise|ualize)?|erotic|lingerie|bikini (swap|her|him|them)|genital\w*|breast\w*|nipple\w*)\b/i,
      reason: 'Retouch doesn’t undress or sexualise people. Try a headshot, a background, or a style instead.' },
    { re: /\b(child|children|kid|kids|minor|minors|teen|teens|boy|girl|schoolgirl|schoolboy)\b[^.]{0,40}\b(sexy|hot|nude|naked|undress|lingerie|bikini)\b|\b(sexy|hot|nude|naked|undress|lingerie|bikini)\b[^.]{0,40}\b(child|children|kid|kids|minor|minors|teen|teens|boy|girl)\b/i,
      reason: 'That request isn’t allowed.' },
    { re: /\b(fake|forge|forged|counterfeit)\b[^.]{0,30}\b(id|passport|licen[cs]e|document|cheque|check|signature)\b/i,
      reason: 'Retouch won’t forge documents.' },
  ];
  function checkPolicy(text) {
    var s = String(text == null ? '' : text);
    for (var i = 0; i < POLICY_RULES.length; i++) {
      if (POLICY_RULES[i].re.test(s)) return { ok: false, reason: POLICY_RULES[i].reason };
    }
    return { ok: true };
  }

  /* ---------------- prompt → pipeline ---------------- */
  // Each rule turns a phrase into pipeline steps. Intensity words scale
  // the numeric amounts ("a bit brighter" = half, "much brighter" = 1.5x).
  var PROMPT_RULES = [
    { re: /\b(black and white|black & white|b&w|monochrome|mono|grayscale|greyscale)\b/i, label: 'black & white', steps: [{ type: 'tone', saturation: -100 }] },
    { re: /\b(brighter|brighten|lighter|lighten|more light|too dark)\b/i, label: 'brighter', steps: [{ type: 'tone', brightness: 18 }] },
    { re: /\b(darker|darken|moodier|too bright|dim)\b/i, label: 'darker', steps: [{ type: 'tone', brightness: -18 }] },
    { re: /\b(more contrast|punchy|punchier|pop|contrasty|bolder)\b/i, label: 'more contrast', steps: [{ type: 'tone', contrast: 22 }] },
    { re: /\b(less contrast|softer|flatter|matte|hazy)\b/i, label: 'softer', steps: [{ type: 'tone', contrast: -16 }] },
    { re: /\b(warmer|warm it|golden|sunset|sunny|amber)\b/i, label: 'warmer', steps: [{ type: 'tone', temperature: 22 }] },
    { re: /\b(cooler|cool it|colder|bluer|icy|arctic)\b/i, label: 'cooler', steps: [{ type: 'tone', temperature: -22 }] },
    { re: /\b(vivid|vibrant|saturated|more colou?r|colou?rful|juicy)\b/i, label: 'more colour', steps: [{ type: 'tone', saturation: 32 }] },
    { re: /\b(muted|desaturated?|less colou?r|faded|washed out|pastel)\b/i, label: 'muted', steps: [{ type: 'tone', saturation: -35 }] },
    { re: /\b(sharpen|sharper|crisp|crisper|more detail|clearer|unblur)\b/i, label: 'sharpen', steps: [{ type: 'sharpen', amount: 0.6 }] },
    { re: /\b(blur(ry|red)?( out)?( the| my| her| his| their)? background|background blur(red)?|bokeh|portrait mode|shallow depth|depth of field)\b/i, label: 'blurred background', steps: [{ type: 'background', mode: 'blur', radius: 6 }] },
    { re: /\b(remove( the| my| her| his| their)? background|no background|cut ?out|white background|transparent|isolate)\b/i, label: 'white background', steps: [{ type: 'background', mode: 'color', color: [255, 255, 255] }] },
    { re: /\b(studio background|gr[ae]y background|plain background|backdrop)\b/i, label: 'studio backdrop', steps: [{ type: 'background', mode: 'gradient', from: [210, 212, 216], to: [150, 154, 160] }] },
    { re: /\b(vintage|film|retro|analog(ue)?|kodak|70s|80s)\b/i, label: 'film look', steps: [{ type: 'preset', id: 'film' }] },
    { re: /\b(noir|dramatic|moody black)\b/i, label: 'noir', steps: [{ type: 'preset', id: 'noir' }] },
    { re: /\b(cinematic|teal and orange|movie|film still)\b/i, label: 'cinematic', steps: [{ type: 'preset', id: 'cinematic' }] },
    { re: /\b(upscale|upsize|bigger|larger|higher res(olution)?|hi-?res|2x|4k|hd)\b/i, label: 'upscale 2x', steps: [{ type: 'upscale', factor: 2 }, { type: 'sharpen', amount: 0.35 }] },
    { re: /\b(enhance|improve|fix|clean up|auto|restore|better)\b/i, label: 'enhance', steps: [{ type: 'levels', low: 0.01, high: 0.99 }, { type: 'sharpen', amount: 0.35 }] },
    { re: /\b(denoise|less noise|smooth|smoother|soften skin|skin)\b/i, label: 'smooth', steps: [{ type: 'blur', radius: 1 }] },
    { re: /\b(vignette|darken (the )?edges|dark corners)\b/i, label: 'vignette', steps: [{ type: 'vignette', amount: 0.45 }] },
    { re: /\b(grain|grainy|noise|texture|35mm)\b/i, label: 'grain', steps: [{ type: 'grain', amount: 14 }] },
    { re: /\b(headshot|linkedin|professional|corporate|profile (photo|picture))\b/i, label: 'headshot', steps: [{ type: 'preset', id: 'corporate' }] },
  ];
  var SOFTENERS = /\b(a bit|a little|slightly|subtle|subtly|touch|hint|gently|lightly)\b/i;
  var HARDENERS = /\b(very|much|really|extremely|way|super|a lot|strong|strongly|heavy|heavily|max)\b/i;

  function scaleStep(step, k) {
    var out = {};
    Object.keys(step).forEach(function (key) {
      var v = step[key];
      out[key] = (typeof v === 'number' && key !== 'factor' && key !== 'radius') ? Math.round(v * k * 100) / 100 : v;
    });
    return out;
  }

  // parsePrompt → { ok, steps, matched: [labels], unmatched: bool, reason? }
  function parsePrompt(text) {
    var s = String(text == null ? '' : text).trim();
    var policy = checkPolicy(s);
    if (!policy.ok) return { ok: false, reason: policy.reason, steps: [], matched: [] };
    if (!s) return { ok: false, reason: 'Say what you’d like changed — "warmer and sharper", "blur the background", "make it black and white".', steps: [], matched: [] };
    var k = SOFTENERS.test(s) ? 0.5 : HARDENERS.test(s) ? 1.5 : 1;
    var steps = [], matched = [];
    PROMPT_RULES.forEach(function (rule) {
      if (!rule.re.test(s)) return;
      matched.push(rule.label);
      rule.steps.forEach(function (st) { steps.push(scaleStep(st, k)); });
    });
    if (!steps.length) {
      return { ok: false, reason: 'I didn’t catch an edit in that. Try words like brighter, warmer, sharper, black and white, blur the background, vintage, or upscale.', steps: [], matched: [] };
    }
    return { ok: true, steps: orderSteps(steps), matched: matched, intensity: k };
  }

  // Studio order: geometry first, levels on the original, then matting, tone, finish.
  var STEP_ORDER = { upscale: 0, levels: 1, inpaint: 2, background: 3, preset: 4, tone: 5, blur: 6, sharpen: 7, vignette: 8, grain: 9 };
  function orderSteps(steps) {
    return steps.slice().sort(function (a, b) {
      return (STEP_ORDER[a.type] == null ? 9 : STEP_ORDER[a.type]) - (STEP_ORDER[b.type] == null ? 9 : STEP_ORDER[b.type]);
    });
  }

  /* ---------------- presets: named looks, as step lists ---------------- */
  var PRESETS = {
    corporate: { label: 'Corporate', steps: [
      { type: 'levels', low: 0.01, high: 0.99 },
      { type: 'background', mode: 'gradient', from: [222, 224, 228], to: [168, 172, 180] }, { type: 'tone', temperature: 6, contrast: 8 },
      { type: 'sharpen', amount: 0.4 }, { type: 'vignette', amount: 0.18 } ] },
    studio: { label: 'Studio', steps: [
      { type: 'levels', low: 0.01, high: 0.99 },
      { type: 'background', mode: 'color', color: [34, 36, 41] }, { type: 'tone', contrast: 14, brightness: 4 },
      { type: 'sharpen', amount: 0.45 } ] },
    outdoor: { label: 'Outdoor', steps: [
      { type: 'background', mode: 'gradient', from: [176, 206, 226], to: [118, 150, 104] },
      { type: 'tone', temperature: 10, saturation: 8 }, { type: 'sharpen', amount: 0.3 } ] },
    cinematic: { label: 'Cinematic', steps: [
      { type: 'tone', contrast: 16, saturation: -8, temperature: 8, tint: [255, 170, 80], tintAmount: 0.08 },
      { type: 'vignette', amount: 0.4 }, { type: 'grain', amount: 8 } ] },
    film: { label: 'Film', steps: [
      { type: 'tone', contrast: -8, saturation: -18, temperature: 10, lift: 18 },
      { type: 'grain', amount: 16 }, { type: 'vignette', amount: 0.3 } ] },
    noir: { label: 'Noir', steps: [
      { type: 'tone', saturation: -100, contrast: 28, brightness: -6 },
      { type: 'vignette', amount: 0.55 }, { type: 'grain', amount: 12 } ] },
    golden: { label: 'Golden hour', steps: [
      { type: 'tone', temperature: 26, saturation: 10, brightness: 6, tint: [255, 190, 110], tintAmount: 0.1 },
      { type: 'vignette', amount: 0.25 } ] },
    vivid: { label: 'Vivid', steps: [
      { type: 'levels', low: 0.01, high: 0.99 }, { type: 'tone', saturation: 34, contrast: 12 }, { type: 'sharpen', amount: 0.3 } ] },
    mono: { label: 'Mono', steps: [ { type: 'tone', saturation: -100, contrast: 10 } ] },
    white: { label: 'White', steps: [ { type: 'background', mode: 'color', color: [255, 255, 255] } ] },
    blur: { label: 'Blur', steps: [ { type: 'background', mode: 'blur', radius: 6 } ] },
    gradient: { label: 'Gradient', steps: [ { type: 'background', mode: 'gradient', from: [214, 216, 222], to: [150, 154, 164] } ] },
    charcoal: { label: 'Charcoal', steps: [ { type: 'background', mode: 'color', color: [38, 40, 45] } ] },
    auto: { label: 'Auto', steps: [ { type: 'levels', low: 0.01, high: 0.99 }, { type: 'sharpen', amount: 0.35 } ] },
    soft: { label: 'Soft', steps: [ { type: 'levels', low: 0.02, high: 0.98 }, { type: 'blur', radius: 1 }, { type: 'tone', contrast: -4 } ] },
    punchy: { label: 'Punchy', steps: [ { type: 'levels', low: 0.01, high: 0.99 }, { type: 'tone', contrast: 18, saturation: 12 }, { type: 'sharpen', amount: 0.55 } ] },
    '2x': { label: '2×', steps: [ { type: 'upscale', factor: 2 }, { type: 'sharpen', amount: 0.35 } ] },
  };
  function presetById(id) { return PRESETS[id] || null; }

  // Expand `preset` steps into their concrete steps (one level; presets never nest).
  function expandSteps(steps) {
    var out = [];
    (steps || []).forEach(function (st) {
      if (st.type === 'preset') {
        var p = PRESETS[st.id];
        if (p) p.steps.forEach(function (s) { out.push(s); });
      } else out.push(st);
    });
    return out;
  }

  // buildJob(tool, options, now) → { ok, tool, cost, steps, label, id } | { ok:false, reason }
  // options: { preset, prompt, mask (for remove), seed }
  function buildJob(toolId, options, now) {
    options = options || {};
    var tool = toolById(toolId);
    if (!tool) return { ok: false, reason: 'Unknown tool.' };
    var steps = [], label = tool.label, matched = [];
    if (toolId === 'prompt') {
      var parsed = parsePrompt(options.prompt);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      steps = parsed.steps; matched = parsed.matched;
      label = 'Prompt: ' + matched.join(', ');
    } else if (toolId === 'remove') {
      if (!options.mask || !options.mask.count) return { ok: false, reason: 'Paint over what you want removed first.' };
      steps = [{ type: 'inpaint', smooth: 3 }];
      label = 'Removed an object';
    } else {
      var presetId = options.preset || tool.presets[0];
      var preset = PRESETS[presetId];
      if (!preset || tool.presets.indexOf(presetId) < 0) return { ok: false, reason: 'Pick a look first.' };
      steps = preset.steps.slice();
      label = tool.label + ' · ' + preset.label;
      // a prompt alongside a preset refines it ("…and a bit warmer")
      if (options.prompt && String(options.prompt).trim()) {
        var extra = parsePrompt(options.prompt);
        if (!extra.ok && checkPolicy(options.prompt).ok === false) return { ok: false, reason: extra.reason };
        if (extra.ok) { steps = steps.concat(extra.steps); matched = extra.matched; label += ' + ' + extra.matched.join(', '); }
      }
    }
    steps = orderSteps(expandSteps(steps));
    var seed = String(options.seed || '') + '|' + toolId + '|' + label + '|' + now;
    return { ok: true, tool: toolId, cost: tool.cost, steps: steps, label: label, matched: matched,
             id: 'job-' + hashStr(seed).toString(36), seconds: estimateSeconds(steps) };
  }

  // A rough "working…" estimate so the progress bar is honest-ish.
  var STEP_COST = { upscale: 1.4, background: 1.2, inpaint: 1.6, levels: 0.3, tone: 0.3, blur: 0.5, sharpen: 0.5, vignette: 0.2, grain: 0.2 };
  function estimateSeconds(steps) {
    var s = 0.6;
    (steps || []).forEach(function (st) { s += STEP_COST[st.type] || 0.3; });
    return round2(s);
  }

  /* ---------------- pixel math: pure functions over RGBA arrays ---------------- */
  // Every op takes (px, w, h, params) where px is a flat RGBA array of
  // length w*h*4 (Uint8ClampedArray in the browser, any array in tests)
  // and returns a NEW array of the same type. Nothing mutates its input.

  function alloc(like, n) {
    if (typeof Uint8ClampedArray !== 'undefined' && like instanceof Uint8ClampedArray) return new Uint8ClampedArray(n);
    var a = new Array(n); for (var i = 0; i < n; i++) a[i] = 0; return a;
  }
  function bytes(n) { if (typeof Uint8Array !== 'undefined') return new Uint8Array(n); var a = new Array(n); for (var i = 0; i < n; i++) a[i] = 0; return a; }
  function ints(n) { if (typeof Int32Array !== 'undefined') return new Int32Array(n); var a = new Array(n); for (var i = 0; i < n; i++) a[i] = 0; return a; }
  function floats(n) {
    if (typeof Float32Array !== 'undefined') return new Float32Array(n);
    var a = new Array(n); for (var i = 0; i < n; i++) a[i] = 0; return a;
  }

  // tone: brightness/contrast (-100..100), saturation (-100..100),
  // temperature (-100 cool .. 100 warm), lift (raises blacks, 0..50),
  // tint [r,g,b] + tintAmount 0..1 (a colour wash).
  function applyTone(px, w, h, p) {
    p = p || {};
    var n = w * h * 4, out = alloc(px, n);
    var bri = (Number(p.brightness) || 0) * 1.27;                // ±127
    var con = 1 + (Number(p.contrast) || 0) / 100;               // 0..2
    var sat = 1 + (Number(p.saturation) || 0) / 100;             // 0..2
    var temp = (Number(p.temperature) || 0) * 0.4;               // ±40 on r/b
    var lift = Number(p.lift) || 0;
    var tint = p.tint || null, ta = clamp(Number(p.tintAmount) || 0, 0, 1);
    for (var i = 0; i < n; i += 4) {
      var r = px[i], g = px[i + 1], b = px[i + 2];
      // temperature: push red up and blue down (or the reverse)
      r += temp; b -= temp;
      // brightness + contrast around mid grey
      r = (r - 128) * con + 128 + bri; g = (g - 128) * con + 128 + bri; b = (b - 128) * con + 128 + bri;
      // saturation around luma
      var l = 0.299 * r + 0.587 * g + 0.114 * b;
      r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat;
      // lift: raise the blacks (a film-ish fade)
      if (lift) { r = lift + r * (255 - lift) / 255; g = lift + g * (255 - lift) / 255; b = lift + b * (255 - lift) / 255; }
      if (tint && ta) { r = r * (1 - ta) + tint[0] * ta; g = g * (1 - ta) + tint[1] * ta; b = b * (1 - ta) + tint[2] * ta; }
      out[i] = Math.round(clamp255(r)); out[i + 1] = Math.round(clamp255(g)); out[i + 2] = Math.round(clamp255(b)); out[i + 3] = px[i + 3];
    }
    return out;
  }

  // Per-channel percentiles → stretch. low/high are fractions (0.01 = 1%).
  function channelPercentiles(px, w, h, low, high) {
    var n = w * h, res = [];
    for (var c = 0; c < 3; c++) {
      var hist = new Array(256); for (var k = 0; k < 256; k++) hist[k] = 0;
      for (var i = 0; i < n; i++) hist[px[i * 4 + c]]++;
      var lo = 0, hi = 255, acc = 0, loTarget = n * low, hiTarget = n * high;
      for (var v = 0; v < 256; v++) { acc += hist[v]; if (acc > 0 && acc >= loTarget) { lo = v; break; } }
      acc = 0;
      for (var v2 = 0; v2 < 256; v2++) { acc += hist[v2]; if (acc >= hiTarget) { hi = v2; break; } }
      // too little range to stretch (a flat wall, a blank frame): leave it alone
      if (hi - lo < 24) { lo = 0; hi = 255; }
      res.push([lo, hi]);
    }
    return res;
  }
  // One shared range for all three channels (the darkest low, the brightest
  // high), so the stretch brightens without shifting the colour balance.
  function applyLevels(px, w, h, p) {
    p = p || {};
    var pc = channelPercentiles(px, w, h, clamp(Number(p.low) || 0, 0, 0.49), clamp(Number(p.high) || 1, 0.51, 1));
    var lo = Math.min(pc[0][0], pc[1][0], pc[2][0]), hi = Math.max(pc[0][1], pc[1][1], pc[2][1]);
    if (hi - lo < 24) { lo = 0; hi = 255; }
    var n = w * h * 4, out = alloc(px, n), k = 255 / (hi - lo);
    for (var i = 0; i < n; i += 4) {
      out[i] = Math.round(clamp255((px[i] - lo) * k)); out[i + 1] = Math.round(clamp255((px[i + 1] - lo) * k)); out[i + 2] = Math.round(clamp255((px[i + 2] - lo) * k));
      out[i + 3] = px[i + 3];
    }
    return out;
  }

  // Separable box blur with edge clamping, `radius` pixels, alpha kept.
  // Running sums, so the cost doesn't grow with the radius.
  function boxBlur(px, w, h, radius) {
    radius = Math.max(0, Math.round(Number(radius) || 0));
    if (!radius) return copy(px);
    var n = w * h * 4, tmp = floats(n), out = alloc(px, n), span = radius * 2 + 1;
    var x, y, c, k, idx, s;
    for (y = 0; y < h; y++) {
      var row = y * w * 4;
      for (c = 0; c < 3; c++) {
        s = 0;
        for (k = -radius; k <= radius; k++) s += px[row + clamp(k, 0, w - 1) * 4 + c];
        for (x = 0; x < w; x++) {
          tmp[row + x * 4 + c] = s / span;
          s += px[row + clamp(x + radius + 1, 0, w - 1) * 4 + c] - px[row + clamp(x - radius, 0, w - 1) * 4 + c];
        }
      }
    }
    for (x = 0; x < w; x++) {
      for (c = 0; c < 3; c++) {
        s = 0;
        for (k = -radius; k <= radius; k++) s += tmp[(clamp(k, 0, h - 1) * w + x) * 4 + c];
        for (y = 0; y < h; y++) {
          idx = (y * w + x) * 4;
          out[idx + c] = Math.round(s / span);
          s += tmp[(clamp(y + radius + 1, 0, h - 1) * w + x) * 4 + c] - tmp[(clamp(y - radius, 0, h - 1) * w + x) * 4 + c];
        }
      }
    }
    for (idx = 3; idx < n; idx += 4) out[idx] = px[idx];
    return out;
  }
  function copy(px) { var out = alloc(px, px.length); for (var i = 0; i < px.length; i++) out[i] = px[i]; return out; }

  // Unsharp mask: out = px + amount * (px - blur(px)).
  function sharpen(px, w, h, amount) {
    amount = clamp(Number(amount) || 0, 0, 3);
    if (!amount) return copy(px);
    var soft = boxBlur(px, w, h, 1), n = w * h * 4, out = alloc(px, n);
    for (var i = 0; i < n; i += 4) {
      for (var c = 0; c < 3; c++) out[i + c] = Math.round(clamp255(px[i + c] + amount * (px[i + c] - soft[i + c])));
      out[i + 3] = px[i + 3];
    }
    return out;
  }

  function vignette(px, w, h, amount) {
    amount = clamp(Number(amount) || 0, 0, 1);
    var n = w * h * 4, out = alloc(px, n), cx = (w - 1) / 2, cy = (h - 1) / 2, maxD = Math.hypot(cx, cy) || 1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var d = Math.hypot(x - cx, y - cy) / maxD;             // 0 centre → 1 corner
      var f = 1 - amount * clamp((d - 0.45) / 0.55, 0, 1);    // flat centre, falls off to the corners
      var i = (y * w + x) * 4;
      out[i] = Math.round(px[i] * f); out[i + 1] = Math.round(px[i + 1] * f); out[i + 2] = Math.round(px[i + 2] * f); out[i + 3] = px[i + 3];
    }
    return out;
  }

  // Deterministic luminance grain — same seed, same grain.
  function grain(px, w, h, amount, seed) {
    amount = clamp(Number(amount) || 0, 0, 60);
    var n = w * h * 4, out = alloc(px, n), sh = hashStr(seed || 'grain');
    for (var i = 0; i < n; i += 4) {
      var g = (noise01(sh, i >> 2) - 0.5) * 2 * amount;
      out[i] = Math.round(clamp255(px[i] + g)); out[i + 1] = Math.round(clamp255(px[i + 1] + g)); out[i + 2] = Math.round(clamp255(px[i + 2] + g)); out[i + 3] = px[i + 3];
    }
    return out;
  }

  // Bilinear resample to W×H.
  function resample(px, w, h, W, H) {
    W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
    var out = alloc(px, W * H * 4);
    for (var y = 0; y < H; y++) {
      var sy = (y + 0.5) * h / H - 0.5, y0 = clamp(Math.floor(sy), 0, h - 1), y1 = clamp(y0 + 1, 0, h - 1), fy = clamp(sy - y0, 0, 1);
      for (var x = 0; x < W; x++) {
        var sx = (x + 0.5) * w / W - 0.5, x0 = clamp(Math.floor(sx), 0, w - 1), x1 = clamp(x0 + 1, 0, w - 1), fx = clamp(sx - x0, 0, 1);
        var i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4, o = (y * W + x) * 4;
        for (var c = 0; c < 4; c++) {
          var top = px[i00 + c] * (1 - fx) + px[i10 + c] * fx, bot = px[i01 + c] * (1 - fx) + px[i11 + c] * fx;
          out[o + c] = Math.round(top * (1 - fy) + bot * fy);
        }
      }
    }
    return out;
  }

  /* ---- subject matting: who's the subject, what's the backdrop ---- */
  // Heuristic matte with no network and no model. Two facts about photos
  // people hand to a studio: the backdrop touches the frame edge, and the
  // subject is framed near the middle. So: learn a small backdrop palette
  // from the top, left and right border strips (the bottom usually holds
  // shoulders or a table), then flood-fill inward from every edge through
  // pixels that stay close to that palette. Whatever the fill can't reach
  // is the subject — including skin that happens to match the wall, as
  // long as it's enclosed. Then feather. Returns floats 0..1, length w*h,
  // 1 = subject.
  function subjectMask(px, w, h, opts) {
    opts = opts || {};
    var n = w * h, i, x, y;
    var strip = Math.max(1, Math.round(Math.min(w, h) * 0.04));
    var samples = [];
    for (y = 0; y < h; y += 2) for (x = 0; x < w; x += 2) {
      if (x < strip || x >= w - strip || y < strip) { i = (y * w + x) * 4; samples.push([px[i], px[i + 1], px[i + 2]]); }
    }
    var palette = kmeans(samples, 3, 6);
    var thresh = Number(opts.threshold) || 58;
    var cx = (w - 1) / 2, cy = (h - 1) / 2, rx = w * 0.42, ry = h * 0.5;
    // 1 = "looks like backdrop" (distance to palette under the local bar)
    var like = bytes(n);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var j = (y * w + x) * 4, best = 1e9;
      for (var p = 0; p < palette.length; p++) {
        var dr = px[j] - palette[p][0], dg = px[j + 1] - palette[p][1], db = px[j + 2] - palette[p][2];
        var d = dr * dr + dg * dg + db * db; if (d < best) best = d;
      }
      // centre prior: inside the framing ellipse the bar is lower (harder to call backdrop)
      var ex = (x - cx) / rx, ey = (y - cy * 1.05) / ry, e = ex * ex + ey * ey;
      var local = thresh * (e < 1 ? 0.7 + 0.3 * e : 1 + Math.min(1, e - 1) * 0.6);
      like[y * w + x] = best < local * local ? 1 : 0;
    }
    // 2 = reached by the fill from the border. The fill moves only between
    // neighbours of similar colour, so it stops at a hard edge (the line
    // where a cheek meets the wall) even when both sides match the palette.
    var edge = Number(opts.edge) || 34, edge2 = edge * edge;
    var reached = bytes(n), queue = ints(n), qh = 0, qt = 0;
    function seed(k) { if (like[k] && !reached[k]) { reached[k] = 1; queue[qt++] = k; } }
    function step(from, to) {
      if (!like[to] || reached[to]) return;
      var a = from * 4, b = to * 4, dr = px[a] - px[b], dg = px[a + 1] - px[b + 1], db = px[a + 2] - px[b + 2];
      if (dr * dr + dg * dg + db * db < edge2) seed(to);
    }
    for (x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
    while (qh < qt) {
      var k = queue[qh++], kx = k % w, ky = (k - kx) / w;
      if (kx > 0) step(k, k - 1);
      if (kx < w - 1) step(k, k + 1);
      if (ky > 0) step(k, k - w);
      if (ky < h - 1) step(k, k + w);
    }
    var mask = floats(n);
    for (i = 0; i < n; i++) mask[i] = reached[i] ? 0 : 1;
    // feather: soften, snap the core, soften the edge again
    mask = blurMask(mask, w, h, Math.max(1, Math.round(Math.min(w, h) / 160)));
    for (i = 0; i < n; i++) mask[i] = clamp((mask[i] - 0.3) / 0.4, 0, 1);
    return blurMask(mask, w, h, Math.max(1, Math.round(Math.min(w, h) / 320)));
  }
  function kmeans(samples, k, iters) {
    if (!samples.length) return [[128, 128, 128]];
    var cents = [];
    for (var i = 0; i < k; i++) cents.push(samples[Math.floor(i * (samples.length - 1) / Math.max(1, k - 1))].slice());
    for (var it = 0; it < iters; it++) {
      var sums = cents.map(function () { return [0, 0, 0, 0]; });
      samples.forEach(function (s) {
        var bi = 0, bd = 1e9;
        for (var c = 0; c < cents.length; c++) {
          var d = (s[0] - cents[c][0]) * (s[0] - cents[c][0]) + (s[1] - cents[c][1]) * (s[1] - cents[c][1]) + (s[2] - cents[c][2]) * (s[2] - cents[c][2]);
          if (d < bd) { bd = d; bi = c; }
        }
        sums[bi][0] += s[0]; sums[bi][1] += s[1]; sums[bi][2] += s[2]; sums[bi][3]++;
      });
      cents = cents.map(function (c, idx) { var s = sums[idx]; return s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : c; });
    }
    return cents;
  }
  function blurMask(mask, w, h, radius) {
    radius = Math.max(0, Math.round(radius)); if (!radius) return mask;
    var n = w * h, tmp = floats(n), out = floats(n), span = radius * 2 + 1, x, y, k, s;
    for (y = 0; y < h; y++) {
      s = 0; for (k = -radius; k <= radius; k++) s += mask[y * w + clamp(k, 0, w - 1)];
      for (x = 0; x < w; x++) { tmp[y * w + x] = s / span; s += mask[y * w + clamp(x + radius + 1, 0, w - 1)] - mask[y * w + clamp(x - radius, 0, w - 1)]; }
    }
    for (x = 0; x < w; x++) {
      s = 0; for (k = -radius; k <= radius; k++) s += tmp[clamp(k, 0, h - 1) * w + x];
      for (y = 0; y < h; y++) { out[y * w + x] = s / span; s += tmp[clamp(y + radius + 1, 0, h - 1) * w + x] - tmp[clamp(y - radius, 0, h - 1) * w + x]; }
    }
    return out;
  }

  // Replace the backdrop: mode 'color' {color}, 'blur' {radius}, 'gradient' {from,to} (top→bottom).
  function replaceBackground(px, w, h, p, mask) {
    p = p || {};
    mask = mask || subjectMask(px, w, h);
    var n = w * h * 4, out = alloc(px, n);
    var blurred = p.mode === 'blur' ? boxBlur(px, w, h, Math.max(1, Number(p.radius) || 6)) : null;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4, m = mask[y * w + x], br, bg, bb;
      if (blurred) { br = blurred[i]; bg = blurred[i + 1]; bb = blurred[i + 2]; }
      else if (p.mode === 'gradient') {
        var t = h > 1 ? y / (h - 1) : 0, f = p.from || [220, 220, 220], to = p.to || [160, 160, 160];
        br = f[0] + (to[0] - f[0]) * t; bg = f[1] + (to[1] - f[1]) * t; bb = f[2] + (to[2] - f[2]) * t;
      } else { var c = p.color || [255, 255, 255]; br = c[0]; bg = c[1]; bb = c[2]; }
      out[i] = Math.round(px[i] * m + br * (1 - m)); out[i + 1] = Math.round(px[i + 1] * m + bg * (1 - m)); out[i + 2] = Math.round(px[i + 2] * m + bb * (1 - m)); out[i + 3] = 255;
    }
    return out;
  }

  /* ---- inpainting: fill a painted mask from its surroundings ---- */
  // mask: array length w*h, 1 = remove. Onion fill: the hole closes from
  // its rim inward in breadth-first order, each pixel taking the mean of
  // the neighbours already known, so a hole of any size closes in one
  // pass. Then a few smoothing passes inside the hole melt the streaks,
  // and a seeded whisper of grain keeps the patch from looking plastic.
  // Deterministic.
  function inpaint(px, w, h, mask, p) {
    p = p || {};
    var smooth = clamp(Math.round(Number(p.smooth == null ? 3 : p.smooth)), 0, 8), n = w * h, i, x, y;
    var out = copy(px), known = bytes(n), queued = bytes(n), queue = ints(n), qh = 0, qt = 0, holes = 0;
    for (i = 0; i < n; i++) { known[i] = mask[i] < 0.5 ? 1 : 0; if (!known[i]) holes++; }
    if (!holes) return out;
    var offs = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    function enqueue(k) { if (!known[k] && !queued[k]) { queued[k] = 1; queue[qt++] = k; } }
    // the rim: unknown pixels touching a known one
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var k0 = y * w + x; if (known[k0]) continue;
      for (var o0 = 0; o0 < 8; o0++) {
        var ax = x + offs[o0][0], ay = y + offs[o0][1];
        if (ax >= 0 && ay >= 0 && ax < w && ay < h && known[ay * w + ax]) { enqueue(k0); break; }
      }
    }
    if (!qt) return out; // a hole with no rim: the whole frame — nothing to borrow from
    while (qh < qt) {
      var k = queue[qh++], kx = k % w, ky = (k - kx) / w, r = 0, g = 0, b = 0, c = 0;
      for (var o = 0; o < 8; o++) {
        var xx = kx + offs[o][0], yy = ky + offs[o][1]; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        var kk = yy * w + xx;
        if (known[kk]) { var j = kk * 4; r += out[j]; g += out[j + 1]; b += out[j + 2]; c++; }
        else enqueue(kk);
      }
      var m = k * 4;
      if (c) { out[m] = Math.round(r / c); out[m + 1] = Math.round(g / c); out[m + 2] = Math.round(b / c); }
      out[m + 3] = 255; known[k] = 1;
    }
    // melt the streaks: blur, but only let it land inside the hole
    for (var pass = 0; pass < smooth; pass++) {
      var soft = boxBlur(out, w, h, 2);
      for (i = 0; i < n; i++) { if (mask[i] < 0.5) continue; var q = i * 4; out[q] = soft[q]; out[q + 1] = soft[q + 1]; out[q + 2] = soft[q + 2]; }
    }
    var sh = hashStr(p.seed || 'inpaint');
    for (i = 0; i < n; i++) {
      if (mask[i] < 0.5) continue;
      var m2 = i * 4, gr = (noise01(sh, i) - 0.5) * 6;
      out[m2] = Math.round(clamp255(out[m2] + gr)); out[m2 + 1] = Math.round(clamp255(out[m2 + 1] + gr)); out[m2 + 2] = Math.round(clamp255(out[m2 + 2] + gr));
    }
    return out;
  }

  /* ---- the pipeline runner ---- */
  // runPipeline(px, w, h, steps, ctx) → { px, w, h, applied: [types] }
  // ctx: { mask (for inpaint, length w*h), seed }
  function runPipeline(px, w, h, steps, ctx) {
    ctx = ctx || {};
    var cur = px, W = w, H = h, applied = [], subject = null;
    expandSteps(steps).forEach(function (st) {
      switch (st.type) {
        case 'upscale': {
          var f = clamp(Number(st.factor) || 2, 1, 4);
          cur = resample(cur, W, H, W * f, H * f); W = Math.round(W * f); H = Math.round(H * f); subject = null; break;
        }
        case 'background': {
          if (!subject) subject = subjectMask(cur, W, H);
          cur = replaceBackground(cur, W, H, st, subject); break;
        }
        case 'inpaint': {
          var m = ctx.mask;
          if (m && m.length === W * H) cur = inpaint(cur, W, H, m, { smooth: st.smooth, seed: ctx.seed });
          break;
        }
        case 'levels': cur = applyLevels(cur, W, H, st); break;
        case 'tone': cur = applyTone(cur, W, H, st); break;
        case 'blur': cur = boxBlur(cur, W, H, st.radius); break;
        case 'sharpen': cur = sharpen(cur, W, H, st.amount); break;
        case 'vignette': cur = vignette(cur, W, H, st.amount); break;
        case 'grain': cur = grain(cur, W, H, st.amount, ctx.seed); break;
        default: return;
      }
      applied.push(st.type);
    });
    return { px: cur, w: W, h: H, applied: applied };
  }

  /* ---------------- sizing & history ---------------- */
  // Working size: long edge capped so the pure JS pipeline stays snappy.
  function fitWithin(w, h, maxEdge) {
    maxEdge = maxEdge || 1024;
    var k = Math.min(1, maxEdge / Math.max(w, h, 1));
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scale: k };
  }

  function historyEntry(job, now, extra) {
    extra = extra || {};
    return { id: job.id, ts: now, tool: job.tool, label: job.label, cost: job.cost,
             w: extra.w || 0, h: extra.h || 0, thumb: extra.thumb || '' };
  }
  function pushHistory(list, entry, max) {
    max = max || 12;
    var out = [entry].concat((list || []).filter(function (e) { return e && e.id !== entry.id; }));
    return out.slice(0, max);
  }
  function relTime(ts, now) {
    var d = Math.max(0, now - ts);
    if (d < MINUTE) return 'just now';
    if (d < HOUR) return Math.floor(d / MINUTE) + ' min ago';
    if (d < DAY) return Math.floor(d / HOUR) + ' h ago';
    return Math.floor(d / DAY) + ' d ago';
  }
  function downloadName(job, now) {
    var d = new Date(now);
    var stamp = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0');
    return 'retouch-' + job.tool + '-' + stamp + '.jpg';
  }

  /* ---------------- sample scenes (so the demo works with no photo) ---------------- */
  // Procedural scenes as draw lists the page paints on a canvas: enough
  // structure (backdrop, subject, props) that every tool has something to
  // bite on. Deterministic per name.
  function sampleScene(name) {
    var scenes = {
      portrait: { label: 'Portrait', w: 640, h: 800, shapes: [
        { type: 'gradient', from: '#aeb6bf', to: '#6d757f', x: 0, y: 0, w: 640, h: 800 },
        { type: 'ellipse', color: '#2d2a33', cx: 320, cy: 760, rx: 300, ry: 190 },  // shoulders
        { type: 'ellipse', color: '#3b2f28', cx: 320, cy: 330, rx: 150, ry: 170 },  // hair
        { type: 'ellipse', color: '#d9a784', cx: 320, cy: 380, rx: 118, ry: 150 },  // face
        { type: 'rect', color: '#d9a784', x: 280, y: 500, w: 80, h: 90 },           // neck
        { type: 'ellipse', color: '#2a1f1b', cx: 272, cy: 370, rx: 12, ry: 8 },     // eyes
        { type: 'ellipse', color: '#2a1f1b', cx: 368, cy: 370, rx: 12, ry: 8 },
        { type: 'ellipse', color: '#b7735a', cx: 320, cy: 455, rx: 34, ry: 11 },    // mouth
        { type: 'ellipse', color: '#e9c2a4', cx: 262, cy: 300, rx: 40, ry: 30 },    // highlight
      ] },
      product: { label: 'Product', w: 800, h: 640, shapes: [
        { type: 'gradient', from: '#eef0f3', to: '#c7ccd3', x: 0, y: 0, w: 800, h: 640 },
        { type: 'rect', color: '#b9bec6', x: 0, y: 470, w: 800, h: 170 },           // table
        { type: 'ellipse', color: '#9aa0a8', cx: 400, cy: 500, rx: 220, ry: 40 },   // shadow
        { type: 'rect', color: '#2f6fe4', x: 290, y: 220, w: 220, h: 270 },         // mug body
        { type: 'ellipse', color: '#4f8ef7', cx: 400, cy: 220, rx: 110, ry: 34 },   // rim
        { type: 'ellipse', color: '#1c3f8a', cx: 400, cy: 220, rx: 92, ry: 24 },    // inside
        { type: 'ellipse', color: '#2f6fe4', cx: 540, cy: 340, rx: 54, ry: 70 },    // handle
        { type: 'ellipse', color: '#c7ccd3', cx: 540, cy: 340, rx: 30, ry: 44 },
        { type: 'rect', color: '#dfe4ea', x: 320, y: 260, w: 20, h: 180 },          // highlight
        { type: 'ellipse', color: '#e04f4f', cx: 150, cy: 440, rx: 42, ry: 42 },    // stray object (apple)
        { type: 'rect', color: '#5a3b1e', x: 147, y: 388, w: 6, h: 22 },
      ] },
      street: { label: 'Street', w: 800, h: 560, shapes: [
        { type: 'gradient', from: '#8fb6e6', to: '#f2d8b8', x: 0, y: 0, w: 800, h: 560 },
        { type: 'ellipse', color: '#ffe9a8', cx: 640, cy: 130, rx: 56, ry: 56 },    // sun
        { type: 'rect', color: '#5d6675', x: 40, y: 200, w: 140, h: 260 },          // buildings
        { type: 'rect', color: '#434b58', x: 200, y: 140, w: 110, h: 320 },
        { type: 'rect', color: '#6b7484', x: 330, y: 230, w: 180, h: 230 },
        { type: 'rect', color: '#3a414d', x: 540, y: 180, w: 90, h: 280 },
        { type: 'rect', color: '#59616f', x: 650, y: 260, w: 130, h: 200 },
        { type: 'rect', color: '#2e3139', x: 0, y: 460, w: 800, h: 100 },           // road
        { type: 'rect', color: '#e9e1c8', x: 60, y: 505, w: 70, h: 8 },             // lane marks
        { type: 'rect', color: '#e9e1c8', x: 200, y: 505, w: 70, h: 8 },
        { type: 'rect', color: '#e9e1c8', x: 340, y: 505, w: 70, h: 8 },
        { type: 'rect', color: '#e9e1c8', x: 480, y: 505, w: 70, h: 8 },
        { type: 'rect', color: '#e9e1c8', x: 620, y: 505, w: 70, h: 8 },
        { type: 'rect', color: '#d94848', x: 90, y: 400, w: 120, h: 60 },           // car
        { type: 'rect', color: '#b53a3a', x: 110, y: 378, w: 80, h: 26 },
        { type: 'ellipse', color: '#1b1b1f', cx: 115, cy: 462, rx: 16, ry: 16 },
        { type: 'ellipse', color: '#1b1b1f', cx: 185, cy: 462, rx: 16, ry: 16 },
      ] },
    };
    var s = scenes[name];
    if (!s) return null;
    // deterministic window lights per scene so each demo looks lived in
    var shapes = s.shapes.slice();
    s.shapes.forEach(function (sh, idx) {
      if (name !== 'street' || sh.type !== 'rect' || sh.h < 150 || sh.w < 80) return;
      for (var r = 0; r < 4; r++) for (var c = 0; c < 3; c++) {
        if (rand01(name + ':' + idx + ':' + r + ':' + c) < 0.5) continue;
        shapes.push({ type: 'rect', color: '#f6e7b0', x: sh.x + 14 + c * ((sh.w - 28) / 3), y: sh.y + 18 + r * 44, w: 14, h: 20 });
      }
    });
    return { id: name, label: s.label, w: s.w, h: s.h, shapes: shapes };
  }
  function sampleSceneIds() { return ['portrait', 'product', 'street']; }

  /* ---------------- the public api ---------------- */
  var api = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    hashStr: hashStr, rand01: rand01, noise01: noise01, clamp: clamp, round2: round2, escapeHTML: escapeHTML,
    TOOLS: TOOLS, toolById: toolById, PLANS: PLANS, PRESETS: PRESETS, presetById: presetById,
    dayKey: dayKey, monthKey: monthKey, periodKey: periodKey, nextResetAt: nextResetAt,
    newLedger: newLedger, creditsLeft: creditsLeft, canAfford: canAfford, spend: spend, switchPlan: switchPlan, creditsSummary: creditsSummary,
    checkPolicy: checkPolicy, parsePrompt: parsePrompt, orderSteps: orderSteps, expandSteps: expandSteps, buildJob: buildJob, estimateSeconds: estimateSeconds,
    applyTone: applyTone, applyLevels: applyLevels, channelPercentiles: channelPercentiles, boxBlur: boxBlur, sharpen: sharpen,
    vignette: vignette, grain: grain, resample: resample, subjectMask: subjectMask, replaceBackground: replaceBackground, inpaint: inpaint, runPipeline: runPipeline,
    fitWithin: fitWithin, historyEntry: historyEntry, pushHistory: pushHistory, relTime: relTime, downloadName: downloadName,
    sampleScene: sampleScene, sampleSceneIds: sampleSceneIds,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RetouchEngine = api;
})(typeof self !== 'undefined' ? self : this);

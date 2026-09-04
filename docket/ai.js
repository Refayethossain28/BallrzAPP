/* Docket — Live AI: the assistant's real brain (optional, BYO-key).
 * =====================================================================
 * Everything in engine.js works offline with zero setup. This module adds
 * the live layer on top: paste an Anthropic API key (stored ONLY in this
 * browser, sent ONLY to api.anthropic.com with Anthropic's official
 * direct-browser-access header — the same pattern as AIOS/Lingua) and
 * Docket gains real understanding:
 *   - READ the photo: Claude transcribes the document from the image and
 *     returns structured fields (sender, category, amount, due date,
 *     reference, the key lines, tailored advice, scam risk);
 *   - DO tasks: ask anything about a document — "appeal this", "write a
 *     reply offering £30/month", "is this a scam?" — and get it done;
 *   - WRITE letters: turn a template draft into a finished, personalised
 *     letter with no [brackets] left in.
 * The network calls live at the bottom; the parsing/normalising helpers
 * above them are pure and unit-tested in scripts/test-docket-logic.mjs.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var API_URL = 'https://api.anthropic.com/v1/messages';
  var MODEL = 'claude-opus-5';
  var KEY_LS = 'docket.anthropicKey.v1';

  var VALID_CATEGORIES = ['fine', 'debt', 'tax', 'legal', 'bill', 'bank', 'insurance',
                          'medical', 'benefits', 'subscription', 'housing', 'delivery', 'junk', 'other'];
  var VALID_SCAM = ['none', 'possible', 'likely'];

  /* ---------------- key management (browser-only storage) ---------------- */
  function getKey() { try { return localStorage.getItem(KEY_LS) || ''; } catch (e) { return ''; } }
  function setKey(k) { try { if (k) localStorage.setItem(KEY_LS, String(k).trim()); else localStorage.removeItem(KEY_LS); } catch (e) {} }
  function ready() { return !!getKey(); }

  /* ---------------- pure helpers (unit-tested) ---------------- */

  // The model is asked for pure JSON, but a live reply can arrive wrapped in
  // code fences or with a stray sentence around it. Find the outermost
  // object and parse it; null when there is no parseable object.
  function extractJSON(text) {
    var s = String(text == null ? '' : text);
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    var cand = s.slice(start, end + 1);
    try { return JSON.parse(cand); } catch (e) {}
    // fences or trailing junk inside the slice: try successively shorter tails
    for (var i = cand.length - 1; i > 0; i--) {
      if (cand.charAt(i) !== '}') continue;
      try { return JSON.parse(cand.slice(0, i + 1)); } catch (e2) {}
    }
    return null;
  }

  // Clamp whatever the model returned into fields the engine can trust:
  // enum-checked category and scam risk, a real ISO due date, a positive
  // finite amount, length-capped strings. Junk in → nulls out, never throws.
  function normalizeAnalysis(a) {
    a = a || {};
    var str = function (v, max) { return v == null ? '' : String(v).trim().slice(0, max || 400); };
    var category = VALID_CATEGORIES.indexOf(a.category) !== -1 ? a.category : null;
    var amount = Number(a.amount);
    if (!isFinite(amount) || amount <= 0) amount = null;
    var currency = ['£', '$', '€'].indexOf(a.currency) !== -1 ? a.currency : '£';
    var due = null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(a.due_date || ''));
    if (m) {
      var ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
      var chk = new Date(ms);
      if (chk.getUTCFullYear() === +m[1] && chk.getUTCMonth() === +m[2] - 1 && chk.getUTCDate() === +m[3]) due = m[0];
    }
    var advice = [];
    if (Array.isArray(a.advice)) {
      for (var i = 0; i < a.advice.length && advice.length < 6; i++) {
        var line = str(a.advice[i], 300);
        if (line) advice.push(line);
      }
    }
    return {
      summary: str(a.summary, 500),
      sender: str(a.sender, 60),
      category: category,
      amount: amount,
      currency: currency,
      dueDate: due,
      ref: str(a.reference, 40) || null,
      keyLines: str(a.key_lines, 2500),
      advice: advice,
      scamRisk: VALID_SCAM.indexOf(a.scam_risk) !== -1 ? a.scam_risk : 'none',
      scamWhy: str(a.scam_why, 300)
    };
  }

  // Letters come back with "SUBJECT: …" as the first line; split it off.
  function parseLetter(text) {
    var s = String(text == null ? '' : text).trim();
    var m = /^subject\s*:\s*(.+)\s*\n+([\s\S]*)$/i.exec(s);
    if (m) return { subject: m[1].trim().slice(0, 150), body: m[2].trim() };
    return { subject: 'Regarding your recent letter', body: s };
  }

  // One compact context string so every task sees the same document facts.
  function docContext(doc) {
    doc = doc || {};
    var parts = ['Document: ' + (doc.title || 'untitled')];
    if (doc.sender) parts.push('From: ' + doc.sender);
    if (doc.category) parts.push('Type: ' + doc.category);
    if (doc.amount) parts.push('Amount: ' + (doc.currency || '£') + doc.amount);
    if (doc.dueDate) parts.push('Due: ' + doc.dueDate);
    if (doc.ref) parts.push('Reference: ' + doc.ref);
    if (doc.text) parts.push('Key lines from the document:\n' + String(doc.text).slice(0, 2500));
    if (doc.ai && doc.ai.summary) parts.push('Earlier AI reading: ' + doc.ai.summary);
    return parts.join('\n');
  }

  /* ---------------- the wire ---------------- */

  function imageBlock(dataURL) {
    var m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(String(dataURL || ''));
    if (!m) return null;
    return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  }

  function call(payload) {
    return fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('Anthropic ' + r.status + ': ' + t.slice(0, 200)); });
      return r.json();
    }).then(function (data) {
      var out = '';
      for (var i = 0; i < (data.content || []).length; i++) {
        if (data.content[i].type === 'text') out += data.content[i].text;
      }
      return out;
    });
  }

  /* ---------------- READ: understand a photographed document ---------------- */
  var ANALYZE_SYSTEM =
    'You are Docket, a paperwork assistant. The user photographed a document they received ' +
    '(and may have typed some of its lines). Read it carefully and reply with ONLY a JSON object — ' +
    'no prose, no code fences — with exactly these fields:\n' +
    '{"summary": one plain-English sentence saying what this document is and what it wants,\n' +
    ' "sender": who sent it (short name, e.g. "Camden Council") or null,\n' +
    ' "category": one of ' + JSON.stringify(VALID_CATEGORIES) + ',\n' +
    ' "amount": the main amount of money at stake as a number, or null,\n' +
    ' "currency": "£" | "$" | "€",\n' +
    ' "due_date": the action/payment deadline as YYYY-MM-DD, or null,\n' +
    ' "reference": the reference/account number, or null,\n' +
    ' "key_lines": the important lines transcribed verbatim from the document (a few lines of text),\n' +
    ' "advice": 3-5 short, concrete tips for handling THIS document in the user\'s favour ' +
    '(discounts, appeal rights, negotiation angles, deadlines to beat),\n' +
    ' "scam_risk": "none" | "possible" | "likely",\n' +
    ' "scam_why": one short sentence explaining the scam risk, or ""}\n' +
    'Be honest: use null when the document does not say. Practical guidance, not legal advice.';

  function analyzeDocument(input) {
    input = input || {};
    var content = [];
    var img = imageBlock(input.photo);
    if (img) content.push(img);
    var lines = [];
    if (input.sender) lines.push('The user says the sender is: ' + input.sender);
    if (input.text) lines.push('Lines the user typed from the document:\n' + String(input.text).slice(0, 2500));
    content.push({ type: 'text', text: (lines.join('\n') || 'Read the photographed document.') });
    return call({
      model: MODEL,
      max_tokens: 2048,
      output_config: { effort: 'low' },
      system: ANALYZE_SYSTEM,
      messages: [{ role: 'user', content: content }]
    }).then(function (text) {
      var parsed = extractJSON(text);
      if (!parsed) throw new Error('Docket AI replied but the reading could not be parsed.');
      return normalizeAnalysis(parsed);
    });
  }

  /* ---------------- DO: free-form tasks on a document ---------------- */
  var TASK_SYSTEM =
    'You are Docket AI, a paperwork assistant that acts in the user\'s favour. You are given the ' +
    'facts of one document the user received (and its photo when available). Do what the user asks: ' +
    'answer questions about it, judge whether it is fair or a scam, plan next steps, negotiate, or ' +
    'compose ready-to-send replies, emails and letters. Be concrete and complete — when asked to ' +
    'write something, write the whole thing so it can be sent as-is, using the real names, amounts, ' +
    'dates and references from the document and inventing nothing. Plain text only, no markdown. ' +
    'Keep answers tight. Practical guidance, not legal advice; for court papers, add one short line ' +
    'recommending free advice (e.g. Citizens Advice).';

  function doTask(doc, instruction, me) {
    var content = [];
    var img = imageBlock(doc && doc.photo);
    if (img) content.push(img);
    content.push({
      type: 'text',
      text: docContext(doc) +
        (me && me.name ? '\nThe user\'s name: ' + me.name : '') +
        '\n\nThe user asks: ' + String(instruction || '').slice(0, 1000)
    });
    return call({
      model: MODEL,
      max_tokens: 4096,
      system: TASK_SYSTEM,
      messages: [{ role: 'user', content: content }]
    });
  }

  /* ---------------- WRITE: personalise a drafted letter ---------------- */
  function writeLetter(doc, kindLabel, me, templateBody) {
    var content = [];
    var img = imageBlock(doc && doc.photo);
    if (img) content.push(img);
    content.push({
      type: 'text',
      text: docContext(doc) +
        '\nThe user\'s name: ' + ((me && me.name) || 'unknown — sign "[Your name]"') +
        '\n\nWrite the finished letter for this goal: ' + String(kindLabel || 'reply appropriately') + '.' +
        (templateBody ? '\nHere is the template draft to improve on:\n' + String(templateBody).slice(0, 3000) : '') +
        '\n\nReply with the complete, ready-to-send letter and nothing else. First line exactly ' +
        '"SUBJECT: <subject line>", then a blank line, then the letter body. Use the real details ' +
        'from the document; leave a [bracketed placeholder] ONLY for facts nobody has given you. ' +
        'Firm, polite, on the user\'s side.'
    });
    return call({
      model: MODEL,
      max_tokens: 4096,
      system: TASK_SYSTEM,
      messages: [{ role: 'user', content: content }]
    }).then(parseLetter);
  }

  var AI = {
    MODEL: MODEL, VALID_CATEGORIES: VALID_CATEGORIES,
    getKey: getKey, setKey: setKey, ready: ready,
    extractJSON: extractJSON, normalizeAnalysis: normalizeAnalysis,
    parseLetter: parseLetter, docContext: docContext, imageBlock: imageBlock,
    analyzeDocument: analyzeDocument, doTask: doTask, writeLetter: writeLetter
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
  root.DocketAI = AI;
})(typeof self !== 'undefined' ? self : this);

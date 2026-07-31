/**
 * ApexVIP repo — "side-apps" Cloud Functions codebase.
 *
 * These functions belong to the OTHER apps in this repo — the Lingua language app
 * (`linguaAI`) and the Ripple messenger (`ripplePush*` / `rippleMaintenance`) — not
 * to ApexVIP. They live in their own Firebase codebase so an ApexVIP functions
 * deploy never touches them and vice-versa. Firebase Functions v2 (Node 20).
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const Anthropic = require('@anthropic-ai/sdk');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

// Anthropic — set once with: firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Anthropic client, memoized per warm instance (keyed by the resolved secret).
let _anthropic = null, _anthropicKey = null;
function anthropicClient(apiKey) {
  if (!_anthropic || _anthropicKey !== apiKey) {
    _anthropic = new Anthropic({ apiKey });
    _anthropicKey = apiKey;
  }
  return _anthropic;
}

/* ===========================================================================
 * linguaAI — hosted Claude proxy for the Lingua language app (lingua/index.html)
 *
 * Mirrors lingua/server.mjs but as a callable Cloud Function so the *live* web
 * link can use Claude without anyone running a local proxy. The browser never
 * holds the Anthropic key — it calls this function, which forces a structured
 * tool call for Translate/Teach (deterministic JSON to render) and lets Claude
 * answer in prose for free-form Ask. If absent or erroring, the client falls
 * back to its offline starter set, so a partial deploy never breaks the UI.
 *
 * Deploy:  firebase functions:secrets:set ANTHROPIC_API_KEY
 *          firebase deploy --only functions:linguaAI
 * =========================================================================== */
const LINGUA_MODEL = process.env.LINGUA_MODEL || 'claude-opus-4-8';

const LINGUA_TRANSLATE_TOOL = {
  name: 'translation_result',
  description: 'Return a precise translation with pronunciation and useful learner notes.',
  input_schema: {
    type: 'object',
    properties: {
      translation:   { type: 'string', description: 'The translated text in the target language/dialect, in its native script.' },
      pronunciation: { type: 'string', description: 'Romanized pronunciation. Empty if the target already uses Latin script.' },
      literal:       { type: 'string', description: 'A word-for-word literal gloss when it differs interestingly; otherwise empty.' },
      register:      { type: 'string', description: "Formality/register note, e.g. 'casual', 'polite/formal', 'spoken only'." },
      notes:         { type: 'string', description: 'One short note on dialect-specific word choice, gender, or usage. Empty if nothing notable.' },
    },
    required: ['translation'],
  },
};
const LINGUA_LESSON_TOOL = {
  name: 'lesson',
  description: 'Return a short, level-appropriate, dialect-aware mini lesson on the requested topic.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      intro: { type: 'string', description: 'One or two sentences of context.' },
      items: {
        type: 'array',
        description: '5–8 example phrases/words for the topic.',
        items: {
          type: 'object',
          properties: {
            phrase:        { type: 'string', description: 'The phrase in the target language/dialect (native script).' },
            pronunciation: { type: 'string', description: 'Romanized pronunciation. Empty if Latin script.' },
            meaning:       { type: 'string', description: 'English meaning / when to use it.' },
          },
          required: ['phrase', 'meaning'],
        },
      },
      tip:         { type: 'string', description: 'One practical learning or cultural tip.' },
      dialectNote: { type: 'string', description: 'How this differs in the requested dialect vs. the standard. Empty if not applicable.' },
    },
    required: ['title', 'items'],
  },
};

function linguaTargetLabel(p) {
  return p.dialect ? `${p.targetName} (${p.dialect} dialect)` : p.targetName;
}

const LINGUA_PRACTICE_TOOL = {
  name: 'practice_set',
  description: 'Return a set of vocabulary/phrase cards for flashcard and quiz practice.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: '8–10 useful items for the requested topic & level.',
        items: {
          type: 'object',
          properties: {
            front:         { type: 'string', description: 'The English prompt / meaning to test recall from.' },
            back:          { type: 'string', description: 'The answer in the target language/dialect (native script).' },
            pronunciation: { type: 'string', description: 'Romanized pronunciation. Empty if Latin script.' },
          },
          required: ['front', 'back'],
        },
      },
    },
    required: ['items'],
  },
};
const LINGUA_CHAT_TOOL = {
  name: 'tutor_reply',
  description: 'Reply as a friendly native-speaker tutor in the target dialect, and gently correct the learner.',
  input_schema: {
    type: 'object',
    properties: {
      reply:         { type: 'string', description: "Conversational reply in the target language/dialect (native script). Short and natural for the learner's level." },
      pronunciation: { type: 'string', description: 'Romanized pronunciation of the reply. Empty if Latin script.' },
      english:       { type: 'string', description: 'A brief English gloss of the reply.' },
      correction:    { type: 'string', description: "A short, encouraging correction of the learner's last message if needed. Empty if it was fine." },
    },
    required: ['reply'],
  },
};

const LINGUA_GRADE_TOOL = {
  name: 'grade_result',
  description: "Grade a learner's attempt at producing a phrase in the target language/dialect.",
  input_schema: {
    type: 'object',
    properties: {
      correct:     { type: 'boolean', description: 'True if the attempt is an acceptable, natural way to express the prompt (minor spelling/diacritic slips still count as correct).' },
      score:       { type: 'integer', description: '0–100 quality score for the attempt.' },
      better:      { type: 'string', description: 'The most natural way a native speaker of this dialect would say it (native script).' },
      pronunciation: { type: 'string', description: "Romanized pronunciation of 'better'. Empty if Latin script." },
      explanation: { type: 'string', description: 'One or two short, encouraging sentences on what was right/wrong.' },
    },
    required: ['correct', 'score', 'better'],
  },
};
const LINGUA_STORY_TOOL = {
  name: 'story',
  description: 'Return a short graded story in the target language/dialect for reading practice.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Story title in the target language (native script).' },
      titleEnglish: { type: 'string' },
      paragraphs: {
        type: 'array',
        description: '3–5 short paragraphs, strictly level-appropriate (A1/beginner = very short simple sentences with common words).',
        items: {
          type: 'object',
          properties: {
            text:          { type: 'string', description: 'Paragraph in the target language/dialect (native script).' },
            pronunciation: { type: 'string', description: 'Romanized pronunciation. Empty if Latin script.' },
            translation:   { type: 'string', description: 'English translation of the paragraph.' },
          },
          required: ['text', 'translation'],
        },
      },
      vocab: {
        type: 'array',
        description: '5–8 key words from the story worth learning.',
        items: {
          type: 'object',
          properties: {
            word:          { type: 'string' },
            pronunciation: { type: 'string' },
            meaning:       { type: 'string' },
          },
          required: ['word', 'meaning'],
        },
      },
    },
    required: ['title', 'paragraphs'],
  },
};

// Returns { sys, messages, tools, force }. Chat passes a conversation; everything
// else is a single user turn.
function linguaBuildRequest(p) {
  if (p.mode === 'translate') {
    const sys =
      'You are an expert translator and dialectologist. Translate accurately into the ' +
      'EXACT requested language and dialect, using the natural phrasing a native speaker of ' +
      'that specific variety would use (not just the standard form). Use the correct native script. ' +
      'Provide romanized pronunciation for non-Latin scripts. Be precise and never invent words.';
    const user =
      `Translate the following from ${p.sourceName} into ${linguaTargetLabel(p)}.` +
      (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '') +
      `\n\nText:\n${JSON.stringify(p.text || '')}`;
    return { sys, messages: [{ role: 'user', content: user }], tools: [LINGUA_TRANSLATE_TOOL], force: 'translation_result' };
  }
  if (p.mode === 'teach') {
    const sys =
      'You are a patient, accurate language tutor. Produce a short, practical mini-lesson ' +
      "for the requested topic, tailored to the learner's level and to the SPECIFIC dialect " +
      'requested (use that variety\'s real vocabulary and pronunciation, not only the standard). ' +
      'Use correct native script and give romanized pronunciation for non-Latin scripts.';
    const user =
      `Teach a ${p.level} learner the topic "${p.topic}" in ${linguaTargetLabel(p)}.` +
      (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '');
    return { sys, messages: [{ role: 'user', content: user }], tools: [LINGUA_LESSON_TOOL], force: 'lesson' };
  }
  if (p.mode === 'practice') {
    const sys =
      'You are a language tutor building flashcards. Produce genuinely useful, correct items ' +
      'for the SPECIFIC dialect requested, with native script and romanized pronunciation for ' +
      "non-Latin scripts. Vary the items; keep them appropriate to the learner's level.";
    const user =
      `Create a practice set of about ${p.count || 10} items on "${p.topic}" for a ${p.level} ` +
      `learner of ${linguaTargetLabel(p)}.` + (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '');
    return { sys, messages: [{ role: 'user', content: user }], tools: [LINGUA_PRACTICE_TOOL], force: 'practice_set' };
  }
  if (p.mode === 'chat') {
    const sys =
      `You are a warm, encouraging native-speaker conversation partner and tutor for a ${p.level || 'beginner'} ` +
      `learner of ${linguaTargetLabel(p)}.` + (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '') +
      " Stay in character as a friendly local. Reply in the target dialect's natural everyday speech, " +
      "kept short and simple for the learner's level. Always provide romanized pronunciation and a brief " +
      'English gloss. If the learner\'s last message has a mistake, add a short kind correction; otherwise leave it empty. ' +
      'Keep the conversation going with a simple question.';
    const history = Array.isArray(p.messages) ? p.messages : [];
    const messages = history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
    if (!messages.length) messages.push({ role: 'user', content: '(Start the conversation with a friendly greeting and a simple question.)' });
    return { sys, messages, tools: [LINGUA_CHAT_TOOL], force: 'tutor_reply' };
  }
  if (p.mode === 'grade') {
    const sys =
      'You are a precise but encouraging language examiner for the SPECIFIC dialect requested. ' +
      'Grade the learner\'s production attempt fairly: accept any natural, correct way to express ' +
      'the prompt (not only the expected answer), forgive minor spelling/diacritic slips, and ' +
      'always show the most natural native phrasing with romanization for non-Latin scripts.';
    const user =
      `Language: ${linguaTargetLabel(p)}. Learner level: ${p.level || 'beginner'}.` +
      (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '') +
      `\n\nPrompt (English): ${JSON.stringify(p.prompt || '')}` +
      `\nExpected answer (one acceptable version): ${JSON.stringify(p.expected || '')}` +
      `\nLearner's attempt: ${JSON.stringify(p.answer || '')}`;
    return { sys, messages: [{ role: 'user', content: user }], tools: [LINGUA_GRADE_TOOL], force: 'grade_result' };
  }
  if (p.mode === 'story') {
    const sys =
      'You are a language-learning author writing graded readers. Write a genuinely interesting ' +
      'micro-story STRICTLY at the requested level, in the SPECIFIC dialect requested (its real ' +
      'everyday vocabulary, not only the standard form). Native script, with romanized ' +
      'pronunciation for non-Latin scripts, and faithful English translations.';
    const user =
      `Write a short graded story for a ${p.level || 'beginner'} learner of ${linguaTargetLabel(p)}` +
      (p.topic ? ` on the theme "${p.topic}"` : '') + '.' +
      (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '');
    return { sys, messages: [{ role: 'user', content: user }], tools: [LINGUA_STORY_TOOL], force: 'story' };
  }
  const sys =
    'You are an expert, accurate language teacher. Answer the learner\'s question about the ' +
    'language/dialect clearly and concisely. Give examples in native script with romanized ' +
    'pronunciation where helpful. If the question is about a specific dialect, answer for that variety.';
  const user =
    `Language: ${linguaTargetLabel(p)}.` +
    (p.dialectNote ? ` Dialect context: ${p.dialectNote}.` : '') +
    `\n\nQuestion: ${p.question || ''}`;
  return { sys, messages: [{ role: 'user', content: user }], tools: null, force: null };
}

async function linguaCallClaude(p, apiKey) {
  const { sys, messages, tools, force } = linguaBuildRequest(p);
  const body = {
    model: LINGUA_MODEL,
    max_tokens: 1500,
    system: sys,
    messages,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = { type: 'tool', name: force };
  }
  const data = await anthropicClient(apiKey).messages.create(body);
  const blocks = data.content || [];
  if (tools) {
    const toolUse = blocks.find((b) => b.type === 'tool_use');
    if (!toolUse) throw new Error('model returned no structured result');
    return toolUse.input || {};
  }
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { answer: text };
}

exports.linguaAI = onCall(
  { secrets: [ANTHROPIC_API_KEY], region: 'us-central1' },
  async (request) => {
    const p = request.data || {};
    const ALLOWED = ['translate', 'teach', 'ask', 'practice', 'chat', 'grade', 'story'];
    const mode = ALLOWED.indexOf(p.mode) >= 0 ? p.mode : 'translate';
    // Light input caps to bound cost/abuse on a public callable.
    if (typeof p.text === 'string' && p.text.length > 4000) {
      throw new HttpsError('invalid-argument', 'Text too long (max 4000 chars).');
    }
    if (typeof p.question === 'string' && p.question.length > 1000) {
      throw new HttpsError('invalid-argument', 'Question too long (max 1000 chars).');
    }
    if (Array.isArray(p.messages) && p.messages.length > 40) {
      p.messages = p.messages.slice(-40); // cap conversation length
    }
    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) throw new HttpsError('failed-precondition', 'ANTHROPIC_API_KEY not configured.');
    try {
      const result = await linguaCallClaude({ ...p, mode }, apiKey);
      return { ok: true, result };
    } catch (err) {
      logger.error('linguaAI', err.message);
      // Return ok:false (not a thrown error) so the client cleanly falls back offline.
      return { ok: false, error: String(err.message || err) };
    }
  }
);

/* ===========================================================================
 * llmLive — hosted Fable 5 proxy for the "My Own AI Model" app
 *   (llm-from-scratch/web/index.html)
 *
 * The app ships a from-scratch GPT that runs in the browser; this HTTPS function
 * powers its optional "⚡ Live AI (Fable 5)" toggle so the *hosted* page can
 * stream real frontier Claude without anyone running a local proxy. Mirrors
 * llm-from-scratch/server.mjs but as a Cloud Function, reusing the SAME
 * project-level ANTHROPIC_API_KEY secret as linguaAI. The browser never holds
 * the key; if this is absent/erroring the client falls back to the on-device model.
 *
 *   GET  (…/llmLive/health) → { ok, live, model }
 *   POST (…/llmLive/ai)     → text/plain stream of the completion
 *
 * Deployed with the side-apps codebase (CI does this on push to main).
 * =========================================================================== */
const { onRequest } = require('firebase-functions/v2/https');

const LLM_LIVE_MODEL = process.env.LLM_LIVE_MODEL || 'claude-fable-5';
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 512);
const LLM_SYSTEM =
  "You are a brilliant, helpful AI assistant. Answer the user's prompt directly " +
  'and well. If the prompt is an unfinished piece of text, continue it naturally ' +
  'in the same voice. Be concise unless asked for depth.';
// Browsers on these origins may call the function; others get a non-matching
// ACAO so their requests are blocked (a deterrent — non-browser clients ignore
// CORS). Override with the ALLOW_ORIGINS env var (comma-separated, or "*").
const LLM_ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS ||
  'https://refayethossain28.github.io,http://localhost:8789,http://localhost:8000')
  .split(',').map((s) => s.trim()).filter(Boolean);
function llmAllowOrigin(origin) {
  if (LLM_ALLOW_ORIGINS.includes('*')) return '*';
  if (origin && LLM_ALLOW_ORIGINS.includes(origin)) return origin;
  return LLM_ALLOW_ORIGINS[0] || '*';
}
function llmSetCors(req, res) {
  res.set('Access-Control-Allow-Origin', llmAllowOrigin(req.headers.origin));
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'content-type');
  res.set('Access-Control-Max-Age', '86400');
}

exports.llmLive = onRequest(
  { secrets: [ANTHROPIC_API_KEY], region: 'us-central1', cors: false },
  async (req, res) => {
    llmSetCors(req, res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    const apiKey = ANTHROPIC_API_KEY.value();
    if (req.method === 'GET') {                     // health probe
      res.set('content-type', 'application/json');
      res.status(200).send(JSON.stringify({ ok: true, live: !!apiKey, model: LLM_LIVE_MODEL }));
      return;
    }
    if (req.method !== 'POST') { res.status(404).send('not found'); return; }
    if (!apiKey) { res.status(502).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }); return; }

    const p = (req.body && typeof req.body === 'object') ? req.body : {};
    const prompt = String(p.prompt || '').slice(0, 8000) || 'Hello!';
    const temperature = Math.max(0, Math.min(1, Number(p.temperature) || 0.8));
    const maxTokens = Math.max(16, Math.min(LLM_MAX_TOKENS, (p.maxTokens | 0) || LLM_MAX_TOKENS));

    try {
      res.set('content-type', 'text/plain; charset=utf-8');
      res.set('cache-control', 'no-cache');
      const stream = anthropicClient(apiKey).messages.stream({
        model: LLM_LIVE_MODEL,
        max_tokens: maxTokens,
        temperature,
        system: LLM_SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      });
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          res.write(ev.delta.text);
        }
      }
      res.end();
    } catch (err) {
      logger.error('llmLive', err.message);
      if (res.headersSent) res.end();
      else res.status(502).json({ ok: false, error: String(err.message || err) });
    }
  }
);

/* ===========================================================================
 * Ripple server-side delivery — push, scheduled dispatch & disappearing sweep
 *
 *  • ripplePushOnMessage  — pushes a web notification the moment a message
 *    becomes deliverable: on create, OR when a scheduled message is released
 *    (scheduledAt cleared). Reads recipients' FCM tokens from the private
 *    `ripple_push/{uid}` collection via the Admin SDK and prunes dead tokens.
 *  • rippleMaintenance    — a 1-minute cron that (a) releases scheduled messages
 *    whose time has come even if the author is offline, and (b) hard-deletes
 *    expired disappearing messages so they're gone server-side, not just hidden.
 *
 * No secrets or external services — just Firebase Cloud Messaging + Firestore.
 * ======================================================================== */
// onDocumentWritten + firebase-admin are already required above (see onBookingWrite).
const { onSchedule } = require('firebase-functions/v2/scheduler');

const RIPPLE_LINK = 'https://refayethossain28.github.io/BallrzAPP/ripple/';

function ripplePreview(m) {
  if (!m) return 'New message';
  if (m.deleted) return 'Message unsent';
  if (m.type === 'image') return '📷 Photo';
  if (m.type === 'voice') return '🎤 Voice message';
  if (m.type === 'poll') return '📊 ' + ((m.meta && m.meta.question) || 'Poll');
  if (m.enc) return '🔒 New message'; // end-to-end encrypted: server can't read it
  const t = String(m.text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New message';
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
}

// Push a message to every member except its sender. Loads tokens, sends, prunes.
async function sendRipplePush(db, chatId, m) {
  const chatSnap = await db.collection('ripple_chats').doc(chatId).get();
  if (!chatSnap.exists) return;
  const chat = chatSnap.data();
  const recipients = (chat.members || []).filter((uid) => uid && uid !== m.senderId);
  if (!recipients.length) return;

  const tokenOwner = {};
  await Promise.all(recipients.map(async (uid) => {
    try {
      const ps = await db.collection('ripple_push').doc(uid).get();
      const toks = (ps.exists && ps.data().fcmTokens) || [];
      toks.forEach((t) => { if (t) tokenOwner[t] = uid; });
    } catch (e) { /* skip */ }
  }));
  const tokens = Object.keys(tokenOwner);
  if (!tokens.length) return;

  const senderName = (m.meta && m.meta.fromName) || 'Someone';
  const isGroup = chat.type === 'group';
  const title = isGroup ? (chat.name || 'New message') : senderName;
  const body = (isGroup ? senderName + ': ' : '') + ripplePreview(m);

  let res;
  try {
    res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { chatId, url: RIPPLE_LINK },
      webpush: {
        fcmOptions: { link: RIPPLE_LINK },
        notification: { icon: RIPPLE_LINK + 'icon-192.png', badge: RIPPLE_LINK + 'icon-192.png', tag: chatId },
      },
    });
  } catch (err) {
    logger.error('sendRipplePush', err.message);
    return;
  }

  const dead = {};
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/invalid-argument') {
      const uid = tokenOwner[tokens[i]];
      (dead[uid] = dead[uid] || []).push(tokens[i]);
    }
  });
  await Promise.all(Object.keys(dead).map((uid) =>
    db.collection('ripple_push').doc(uid).update({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead[uid]),
    }).catch(() => {})
  ));
  logger.info('ripplePush', { chatId, sent: res.successCount, failed: res.failureCount });
}

const isPendingAt = (m, t) => !!(m && m.scheduledAt && m.scheduledAt > t);

exports.ripplePushOnMessage = onDocumentWritten(
  { document: 'ripple_chats/{chatId}/messages/{messageId}', region: 'us-central1' },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : null;
    const after = event.data.after.exists ? event.data.after.data() : null;
    if (!after || after.type === 'system') return; // deleted or system → no push

    const t = Date.now();
    const becameDeliverable =
      (!before && !isPendingAt(after, t)) ||                 // freshly created & due
      (before && isPendingAt(before, t) && !isPendingAt(after, t)); // scheduled → released
    if (!becameDeliverable) return; // edits, reactions, read receipts, etc.

    await sendRipplePush(admin.firestore(), event.params.chatId, after);
  }
);

exports.rippleMaintenance = onSchedule(
  { schedule: 'every 1 minutes', region: 'us-central1' },
  async () => {
    const db = admin.firestore();
    const now = Date.now();

    // (a) Release scheduled messages whose time has come (author may be offline).
    // Clearing scheduledAt makes them deliverable; the onWritten trigger above
    // then fires the push.
    try {
      const due = await db.collectionGroup('messages')
        .where('scheduledAt', '<=', now).limit(450).get();
      const batch = db.batch();
      let n = 0;
      due.forEach((doc) => {
        const m = doc.data();
        if (!m.scheduledAt) return;
        batch.update(doc.ref, { scheduledAt: null, state: 'delivered', ts: now });
        n++;
      });
      if (n) { await batch.commit(); logger.info('rippleMaintenance released', n); }
    } catch (err) { logger.warn('rippleMaintenance release', err.message); }

    // (b) Hard-delete disappearing messages whose expireAt has passed, so they
    // truly vanish server-side (clients already hide them locally).
    try {
      const gone = await db.collectionGroup('messages')
        .where('expireAt', '<=', now).limit(450).get();
      const batch = db.batch();
      let n = 0;
      gone.forEach((doc) => {
        const m = doc.data();
        if (!m.expireAt) return;
        batch.delete(doc.ref);
        n++;
      });
      if (n) { await batch.commit(); logger.info('rippleMaintenance swept', n); }
    } catch (err) { logger.warn('rippleMaintenance sweep', err.message); }
  }
);

/* ===========================================================================
 * ripplePushOnCall — ring the callee on a new incoming WebRTC call, even when
 * their app is closed. High-urgency web push to the callee's FCM tokens; tapping
 * it opens Ripple, which picks up the still-ringing call via its live listener.
 * ======================================================================== */
exports.ripplePushOnCall = onDocumentCreated(
  { document: 'ripple_calls/{callId}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const c = snap.data();
    if (!c || c.status !== 'ringing' || !c.callee) return;

    const db = admin.firestore();
    let tokens = [];
    try {
      const ps = await db.collection('ripple_push').doc(c.callee).get();
      tokens = (ps.exists && ps.data().fcmTokens) || [];
    } catch (e) { return; }
    if (!tokens.length) return;

    const title = c.video ? '📹 Incoming video call' : '📞 Incoming call';
    const body = (c.callerName || 'Someone') + ' is calling…';
    let res;
    try {
      res = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: { type: 'call', callId: event.params.callId, url: RIPPLE_LINK },
        webpush: {
          headers: { Urgency: 'high', TTL: '40' },
          fcmOptions: { link: RIPPLE_LINK },
          notification: {
            icon: RIPPLE_LINK + 'icon-192.png', badge: RIPPLE_LINK + 'icon-192.png',
            tag: 'call-' + event.params.callId, requireInteraction: true,
            vibrate: [300, 200, 300, 200, 300],
          },
        },
      });
    } catch (err) { logger.error('ripplePushOnCall', err.message); return; }

    // prune permanently-invalid tokens
    const dead = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument') dead.push(tokens[i]);
    });
    if (dead.length) {
      await db.collection('ripple_push').doc(c.callee)
        .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) }).catch(() => {});
    }
    logger.info('ripplePushOnCall', { callId: event.params.callId, sent: res.successCount });
  }
);

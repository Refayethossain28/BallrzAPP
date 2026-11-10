#!/usr/bin/env node
/**
 * Unit tests for furqan/engine.js — the pure "ask the Qur'an" engine behind
 * Furqan: the verified corpus's integrity (114 surahs, 6,236 ayat, checksum
 * shape), Arabic and English normalisation (harakāt stripping, Pickthall's
 * archaic forms, stemming), the BM25 index, reference parsing in every form
 * people type ("2:255", "Al-Kahf 10", "surah yasin", "ayat al-kursi"), the
 * topic lexicon (every seed exists; the classic verses lead their topics),
 * search relevance on real questions, the honesty notes (rulings, subjects
 * the Qur'an does not address, distress), passage assembly, the verse of
 * the day, the Live AI grounding prompt and the reply verifier that rejects
 * fabricated quotes and bad citations. Loaded in a vm sandbox (repo is
 * type:module).
 * Run: node scripts/test-furqan-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'furqan', 'engine.js'), 'utf8'), sandbox, { filename: 'furqan/engine.js' });
const E = sandbox.module.exports;
const QURAN = JSON.parse(readFileSync(join(ROOT, 'furqan', 'quran.json'), 'utf8'));
const ctx = E.buildContext(QURAN);

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0); // 2026-11-10 12:00 UTC
let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const labels = (a) => a.passages.map((p) => `${p.s}:${p.a}${p.b !== p.a ? '-' + p.b : ''}`);
const hasRef = (a, ref) => a.passages.some((p) => {
  const m = ref.match(/^(\d+):(\d+)$/); return p.s === +m[1] && +m[2] >= p.a && +m[2] <= p.b;
});

/* ---------- corpus integrity ---------- */
test('quran.json has the canonical shape: 114 surahs, 6,236 ayat, no empty verse, a checksum', () => {
  const r = E.checkIntegrity(QURAN);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(QURAN.meta.verses, 6236); assert.equal(QURAN.meta.surahs, 114);
  assert.match(QURAN.meta.sha256, /^[0-9a-f]{64}$/);
  // canonical verse counts of well-known surahs
  deepEq([1, 2, 18, 36, 55, 112, 114].map((n) => QURAN.surahs[n - 1].ayat.length), [7, 286, 110, 83, 78, 4, 6]);
  assert.equal(QURAN.surahs[0].ayat[0][1], 'In the name of Allah, the Beneficent, the Merciful');
  assert.match(QURAN.meta.translation, /Pickthall/); assert.match(QURAN.meta.text, /Uthmani/);
});
test('checkIntegrity rejects a truncated or tampered file', () => {
  const bad = { surahs: QURAN.surahs.slice(0, 113) };
  assert.equal(E.checkIntegrity(bad).ok, false);
  const bad2 = { surahs: QURAN.surahs.map((s, i) => (i === 5 ? { n: s.n, ayat: s.ayat.slice(1) } : s)) };
  const r = E.checkIntegrity(bad2);
  assert.equal(r.ok, false); assert.ok(r.problems.some((p) => /verse count/.test(p)));
});

/* ---------- normalisation ---------- */
test('normalizeArabic strips harakāt and Qur’anic marks and unifies letter forms', () => {
  assert.equal(E.normalizeArabic(QURAN.surahs[0].ayat[0][0]), 'بسم الله الرحمن الرحيم');
  assert.equal(E.normalizeArabic('ٱلصَّبۡرِ'), 'الصبر');
  assert.equal(E.normalizeArabic('إِبۡرَٰهِـۧمَ'), 'ابرهم');              // the mushaf's small letters dropped…
  assert.equal(E.normalizeArabic('إِبۡرَٰهِـۧمَ', true), 'ابراهيم');       // …or expanded to standard spelling
  assert.equal(E.normalizeArabic('مَلَٰٓئِكَةٌ', true), 'ملايكه');
  assert.equal(E.normalizeArabic('ٱلرَّحۡمَٰنِ'), 'الرحمن');
  assert.ok(E.arabicTokens('إِبۡرَٰهِـۧمَ').includes('ابراهيم'), 'index carries the standard spelling');
});
test('arabicTokens adds prefix-stripped stems so الصبر matches بِٱلصَّبۡرِ', () => {
  const t = E.arabicTokens('وَبِٱلصَّبۡرِ وَٱلصَّلَوٰةِ');
  for (const w of ['وبالصبر', 'بالصبر', 'الصبر', 'صبر', 'والصلوه', 'الصلوه', 'صلوه']) assert.ok(t.includes(w), w + ' in ' + t.join(','));
  assert.equal(E.hasArabic('hello'), false); assert.equal(E.hasArabic('الصبر'), true);
});
test('englishTokens maps Pickthall’s archaic words, stems lightly and drops stop words', () => {
  deepEq(E.englishTokens('O ye who believe! Seek help in patience and prayer'), ['believ', 'seek', 'help', 'patienc', 'prayer']);
  assert.equal(E.stem('believeth'), E.stem('believe')); assert.equal(E.stem('believed'), E.stem('believe'));
  assert.equal(E.stem('believers'), 'believer');   // agent nouns keep their -er (so "mother" is not "moth")
  assert.equal(E.stem('forgiveness'), E.stem('forgive')); assert.equal(E.stem('praying'), E.stem('pray'));
  assert.equal(E.stem('cities'), 'city'); assert.equal(E.stem('bus'), 'bus');
  deepEq(E.englishTokens('Allah hath decreed that thou shalt not'), ['decre']);   // hath/thou/shalt mapped then dropped as stop words
  deepEq(E.englishTokens("Allah's mercy unto thee"), ['mercy']);
});

/* ---------- reference parsing ---------- */
test('parseReference understands numbers, names, aliases, ranges and famous passages', () => {
  const cases = {
    '2:255': [2, 255, 255], '2 255': [2, 255, 255], '2:255-257': [2, 255, 257], '18:10–12': [18, 10, 12],
    'surah 112 verse 2': [112, 2, 2], 'Surah 2, verse 255': [2, 255, 255], 'chapter 18 verses 1 to 3': [18, 1, 3],
    'Al-Kahf 10': [18, 10, 10], 'al kahf 10': [18, 10, 10], 'kahf 1 to 3': [18, 1, 3], 'Baqarah 285-286': [2, 285, 286],
    'al-baqara 2': [2, 2, 2], 'The Cow 3': [2, 3, 3], 'Al-i-Imran 8': [3, 8, 8], 'Aal-i-Imraan 8': [3, 8, 8], 'Ali Imran 8': [3, 8, 8],
    'Maryam 16': [19, 16, 16], 'surah yasin': [36, 1, 83], 'Yusuf': [12, 1, 111], 'ya sin 36': [36, 36, 36],
    'ayat al kursi': [2, 255, 255], 'Ayatul Kursi': [2, 255, 255], 'the throne verse': [2, 255, 255],
    'last two verses of baqarah': [2, 285, 286], 'ayat an-nur': [24, 35, 35], 'bismillah': [1, 1, 1],
    'surah al ikhlas': [112, 1, 4], 'an-nas': [114, 1, 6], 'Ar-Rahman 13': [55, 13, 13], 'rahman 13': [55, 13, 13],
    'Al-Fatiha': [1, 1, 7], 'fatihah': [1, 1, 7], 'surat al-mulk': [67, 1, 30], 'juz amma': null,
    'What does the Quran say about patience?': null, 'patience': null, 'love': null, '': null,
  };
  for (const [q, want] of Object.entries(cases)) {
    const r = E.parseReference(ctx, q);
    if (want === null) assert.equal(r, null, `${q} should not parse: ${JSON.stringify(r)}`);
    else { assert.ok(r, `${q} did not parse`); deepEq([r.s, r.a, r.b], want, q); }
  }
});
test('parseReference reports out-of-range ayat and clamps ranges', () => {
  const r = E.parseReference(ctx, '112:9');
  assert.equal(r.invalid, true); assert.equal(r.max, 4);
  deepEq(E.parseReference(ctx, '112:3-99'), { s: 112, a: 3, b: 4, whole: false });
  assert.equal(E.parseReference(ctx, '115:1'), null);
  assert.equal(E.parseReference(ctx, '0:1'), null);
});
test('every surah is reachable by its mushaf name, its English name and common spellings', () => {
  for (const su of QURAN.surahs) {
    assert.equal(E.parseReference(ctx, su.name).s, su.n, su.name);
    assert.equal(E.parseReference(ctx, 'Surah ' + su.name).s, su.n, su.name);
  }
  for (const [q, n] of [['Al-Baqarah', 2], ['Baqara', 2], ['Al Imran', 3], ['An-Nisa', 4], ['Al-Anam', 6], ['Ar-Rad', 13], ['Ta-Ha', 20], ['Al-Mu’minun', 23], ['Ash-Shuara', 26], ['Al-Hujurat', 49], ['Al-Jumu’ah', 62], ['Al-Mulk', 67], ['An-Naba', 78], ['Al-Ala', 87], ['Al-Alaq', 96], ['Al-Qadr', 97], ['Al-Ikhlas', 112], ['Quraysh', 106]]) {
    assert.equal(E.parseReference(ctx, q) && E.parseReference(ctx, q).s, n, q);
  }
});

/* ---------- topics ---------- */
test('every topic seed exists in the mushaf and ranges are ordered', () => {
  let n = 0;
  for (const t of E.TOPICS) {
    assert.ok(t.seeds.length >= 3, t.id);
    for (const ref of t.seeds) {
      const sd = E.parseSeed(ref); n++;
      assert.ok(sd, `${t.id} ${ref}`);
      const su = QURAN.surahs[sd.s - 1];
      assert.ok(su && sd.a >= 1 && sd.b >= sd.a && sd.b <= su.ayat.length, `${t.id} ${ref} out of range`);
    }
  }
  assert.ok(n > 500, `${n} seeds`);
  assert.equal(new Set(E.TOPICS.map((t) => t.id)).size, E.TOPICS.length, 'unique ids');
});
test('matchTopics finds the subject of a question and ranks the best one first', () => {
  const first = (q) => (E.matchTopics(q)[0] || {}).id;
  assert.equal(first('What does the Quran say about patience?'), 'patience');
  assert.equal(first('how should I treat my parents'), 'parents');
  assert.equal(first('is interest haram'), 'riba');
  assert.equal(first('tell me about fasting in ramadan'), 'fasting');
  assert.equal(first('who was Maryam'), 'mary');
  assert.equal(first('what happens after death'), 'death');
  assert.equal(first('zakat'), 'zakat');
  assert.equal(first('can I drink alcohol'), 'alcohol');
  assert.equal(first('hijab'), 'modesty');
  assert.equal(first('what does the Quran say about jesus'), 'jesus');
  deepEq(E.matchTopics('xyzzy plugh'), []);
});

/* ---------- answers ---------- */
test('a reference question returns exactly that passage, with the surah card', () => {
  const a = E.answer(ctx, '2:255');
  assert.equal(a.kind, 'reference'); deepEq(labels(a), ['2:255']);
  assert.equal(a.surah.name, 'Al-Baqara'); assert.equal(a.surah.ayat, 286); assert.equal(a.surah.rev, 'Madina');
  assert.match(a.passages[0].verses[0].en, /^Allah! There is no deity save Him/);
  assert.ok(a.passages[0].verses[0].ar.startsWith('\u0671\u0644\u0644\u064e\u0651\u0647\u064f'), 'Arabic of 2:255 starts with the name of Allah');
  const whole = E.answer(ctx, 'surah al-ikhlas');
  assert.equal(whole.reference.whole, true); assert.equal(whole.passages[0].verses.length, 4);
  const long = E.answer(ctx, 'surah al-baqarah', { wholeLimit: 50 });
  assert.equal(long.passages[0].verses.length, 50); assert.ok(long.notes.some((n) => /first 50 of 286/.test(n.text)));
  const bad = E.answer(ctx, '112:9');
  assert.equal(bad.passages.length, 0); assert.ok(bad.notes.some((n) => /has 4 ayat/.test(n.text)));
});
test('the classic passages lead topic answers (patience → 2:153, parents → 17:23, riba → 2:275)', () => {
  const a = E.answer(ctx, 'What does the Quran say about patience?');
  assert.equal(a.kind, 'topic'); assert.equal(labels(a)[0], '2:153'); assert.ok(hasRef(a, '2:155'));
  const p = E.answer(ctx, 'how should I treat my parents');
  assert.equal(labels(p)[0], '17:23-24');
  const r = E.answer(ctx, 'is interest haram');
  assert.ok(hasRef(r, '2:275') && hasRef(r, '3:130'), labels(r).join(' '));
  assert.ok(r.notes.some((n) => n.kind === 'ruling'), 'ruling note');
  const j = E.answer(ctx, 'What does the Quran say about Jesus?');
  assert.ok(hasRef(j, '3:45') && hasRef(j, '4:157'), labels(j).join(' '));
  assert.ok(a.passages.every((x) => x.verses.every((v) => v.ar && v.en)), 'every verse carries both texts');
});
test('plain-text search works when no topic matches, in English and in Arabic', () => {
  const a = E.answer(ctx, 'bees honey');
  assert.ok(hasRef(a, '16:68') || hasRef(a, '16:69'), labels(a).join(' '));
  const b = E.answer(ctx, 'الصبر');
  assert.ok(b.passages.length >= 3);
  assert.ok(b.passages.every((p) => p.verses.some((v) => E.normalizeArabic(v.ar).indexOf('صبر') >= 0)), 'Arabic hits contain the root');
  const c = E.answer(ctx, 'ants and Solomon');
  assert.ok(hasRef(c, '27:18') || hasRef(c, '27:19'), labels(c).join(' '));
});
test('questions the Qur’an does not address get the honesty note and no weak text matches', () => {
  const m = E.answer(ctx, 'is music allowed in islam');
  assert.equal(m.passages.length, 0);
  assert.ok(m.notes.some((n) => n.kind === 'scope' && /Music/.test(n.text)));
  assert.ok(m.notes.some((n) => n.kind === 'ruling'));
  const s = E.answer(ctx, 'is smoking haram?');
  assert.ok(hasRef(s, '2:195') && hasRef(s, '4:29'), labels(s).join(' '));
  assert.ok(s.passages.every((p) => p.why === 'principle'));
  const n = E.answer(ctx, 'xyzzy plugh');
  assert.equal(n.kind, 'none'); assert.ok(n.notes.some((x) => x.kind === 'none'));
});
test('a distress message gets the support note first, then comforting verses', () => {
  const a = E.answer(ctx, 'I want to kill myself', { limit: 10 });
  assert.equal(a.notes[0].kind, 'support');
  deepEq(labels(a).slice(0, 2), ['2:195', '39:53'], 'comfort and mercy lead, not the prohibition');
  assert.ok(hasRef(a, '4:29'), labels(a).join(' '));
});
test('answers are deterministic and bounded', () => {
  const a = E.answer(ctx, 'forgiveness', { limit: 5 }), b = E.answer(ctx, 'forgiveness', { limit: 5 });
  deepEq(labels(a), labels(b)); assert.ok(a.passages.length <= 5);
  for (const p of a.passages) assert.ok(p.b - p.a <= 30);
  const seen = new Set();
  for (const p of a.passages) for (let x = p.a; x <= p.b; x++) { const k = `${p.s}:${x}`; assert.ok(!seen.has(k), 'no overlapping passages'); seen.add(k); }
});

/* ---------- verse of the day ---------- */
test('verseOfDay is deterministic per UTC day, always a curated passage', () => {
  const a = E.verseOfDay(ctx, NOW), b = E.verseOfDay(ctx, NOW + 3 * 60 * 60 * 1000), c = E.verseOfDay(ctx, NOW + E.DAY);
  assert.equal(a.label, b.label);
  assert.ok(E.DAILY.includes(`${a.s}:${a.a}${a.b !== a.a ? '-' + a.b : ''}`));
  const labelsSeen = new Set();
  for (let d = 0; d < 60; d++) labelsSeen.add(E.verseOfDay(ctx, NOW + d * E.DAY).label);
  assert.ok(labelsSeen.size > 20, 'varies across days');
  assert.ok(c.verses.length >= 1);
});

/* ---------- Live AI grounding ---------- */
test('buildLivePrompt carries the rules, every passage verbatim with its address, and the question', () => {
  const a = E.answer(ctx, 'patience', { limit: 3 });
  const p = E.buildLivePrompt(ctx, 'What does the Quran say about patience?', a.passages);
  assert.match(p, /Answer ONLY from these passages/); assert.match(p, /no religious rulings/i);
  for (const pa of a.passages) for (const v of pa.verses) assert.ok(p.includes(`(${pa.name} ${pa.s}:${v.a}) ${v.en}`));
  assert.match(p, /QUESTION: What does the Quran say about patience\?$/);
  const long = E.buildLivePrompt(ctx, 'x'.repeat(2000), []);
  assert.ok(long.split('\n').pop().length <= 'QUESTION: '.length + 500, 'question is truncated');
});
test('verifyReply accepts real quotes and citations and rejects fabricated ones', () => {
  const a = E.answer(ctx, 'patience', { limit: 3 });
  const good = 'The Qur’an says “Seek help in steadfastness and prayer” (Al-Baqara 2:153) and “Every soul will taste of death” (3:185).';
  const g = E.verifyReply(ctx, good, a.passages);
  assert.equal(g.ok, true); deepEq(g.quotes.map((q) => q.verified), [true, true]);
  assert.equal(g.citations.find((c) => c.a === 153).inPassages, true);
  assert.equal(g.citations.find((c) => c.a === 185).inPassages, false);
  const bad = 'It says "patience is the key to every door in paradise" (Al-Baqara 2:153) and also see 2:999.';
  const b = E.verifyReply(ctx, bad, a.passages);
  assert.equal(b.ok, false); assert.equal(b.problems, 2);
  assert.equal(b.quotes[0].verified, false);
  assert.ok(b.citations.some((c) => c.a === 999 && !c.valid));
  // punctuation and case differences inside a real quote are fine; short quotes are not verse claims
  assert.equal(E.verifyReply(ctx, 'He said: "seek help in steadfastness, and prayer".', a.passages).ok, true);
  assert.equal(E.verifyReply(ctx, 'They "say so" often.', []).ok, true);
});

/* ---------- misc ---------- */
test('escapeHTML, refLabel, surahList, toArabicDigits', () => {
  assert.equal(E.escapeHTML('<b a="1">’&'), '&lt;b a=&quot;1&quot;&gt;’&amp;');
  assert.equal(E.refLabel(ctx, 18, 10, 12), 'Al-Kahf 18:10-12'); assert.equal(E.refLabel(ctx, 1, 1), 'Al-Faatiha 1:1');
  const list = E.surahList(ctx); assert.equal(list.length, 114); assert.equal(list[113].ayat, 6); assert.equal(list[17].en, 'The Cave');
  assert.equal(E.toArabicDigits(255), '٢٥٥');
  assert.equal(E.topicList().length, E.TOPICS.length); assert.equal(E.topicById('patience').title, 'Patience (sabr)');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { console.error(`FAIL - ${name}\n  ${e && e.stack || e}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} furqan tests passed`);
if (passed !== tests.length) process.exit(1);

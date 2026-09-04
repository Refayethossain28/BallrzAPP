#!/usr/bin/env node
/**
 * Unit tests for bayan/engine.js — the pure Classical Arabic teaching
 * engine behind Bayan (the vocalized curriculum data and its integrity,
 * seeded quiz builders for letters/signs/vocabulary/conjugation/grammar/
 * reading, the SM-2-style spaced-repetition scheduler, streaks, XP ranks,
 * the course path and vocabulary search).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-bayan-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'bayan', 'engine.js'), 'utf8'), sandbox, { filename: 'bayan/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 8, 4, 12, 0, 0); // 2026-09-04 12:00 UTC
const { MINUTE, HOUR, DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const vocalized = (s) => E.stripTashkil(s) !== s;

/* ---------- text utilities ---------- */
test('stripTashkil removes vowels and tatweel, keeps letters and digits', () => {
  assert.equal(E.stripTashkil('كِتَاب'), 'كتاب');
  assert.equal(E.stripTashkil('مُحَمَّدٌ'), 'محمد');
  assert.equal(E.stripTashkil('بـ'), 'ب', 'tatweel goes');
  assert.equal(E.stripTashkil('٤٢'), '٤٢', 'Arabic-Indic digits survive');
  assert.equal(E.stripTashkil(''), '');
});
test('normalizeAr folds alif variants and alif maqsura', () => {
  assert.equal(E.normalizeAr('أَحَد'), 'احد');
  assert.equal(E.normalizeAr('إِلَى'), 'الي');
  assert.equal(E.normalizeAr('آيَة'), 'اية');
  assert.ok(E.arEq('كِتَابٌ', 'كتاب'));
  assert.ok(!E.arEq('كتاب', 'كاتب'));
});
test('translitFold flattens the scholarly scheme for search', () => {
  assert.equal(E.translitFold('Kitāb'), 'kitab');
  assert.equal(E.translitFold('ṣalāḥ'), 'salah');
  assert.equal(E.translitFold('ʿilm'), 'ilm');
  assert.equal(E.translitFold('Qurʾān'), 'quran');
});
test('escapeHTML neutralizes markup', () => {
  assert.equal(E.escapeHTML('<b a="x">&\''), '&lt;b a=&quot;x&quot;&gt;&amp;&#39;');
});
test('hashStr/rand01/seededShuffle are deterministic; shuffle is a permutation', () => {
  assert.equal(E.hashStr('bayan'), E.hashStr('bayan'));
  assert.notEqual(E.hashStr('a'), E.hashStr('b'));
  const r = E.rand01('seed');
  assert.equal(r, E.rand01('seed'));
  assert.ok(r >= 0 && r < 1);
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  const s1 = E.seededShuffle(arr, 'x'), s2 = E.seededShuffle(arr, 'x');
  deepEq(s1, s2, 'same seed, same order');
  deepEq(s1.slice().sort(), arr, 'nothing lost, nothing invented');
  deepEq(arr, [1, 2, 3, 4, 5, 6, 7, 8], 'input untouched');
  assert.equal(E.pickN(arr, 3, 'y').length, 3);
});

/* ---------- alphabet data integrity ---------- */
test('LETTERS: 29 entries, unique ids and glyphs, complete fields', () => {
  assert.equal(E.LETTERS.length, 29);
  const ids = new Set(), chars = new Set();
  for (const L of E.LETTERS) {
    ids.add(L.id); chars.add(L.ar);
    for (const k of ['id', 'ar', 'name', 'nameEn', 'translit', 'sound', 'isolated', 'initial', 'medial', 'final', 'makhraj']) {
      assert.ok(String(L[k] || '').length, `${L.id}.${k} empty`);
    }
    assert.ok(L.example && L.example.ar && L.example.en && L.example.translit, `${L.id} example incomplete`);
    assert.ok(vocalized(L.example.ar), `${L.id} example "${L.example.ar}" not vocalized`);
    assert.ok(vocalized(L.name), `${L.id} Arabic name not vocalized`);
  }
  assert.equal(ids.size, 29, 'ids unique');
  assert.equal(chars.size, 29, 'glyphs unique');
});
test('LETTERS: the six non-connectors (plus hamza) are exactly right', () => {
  const nonConnectors = E.LETTERS.filter((l) => !l.connects).map((l) => l.ar).sort();
  deepEq(nonConnectors, ['ء', 'ا', 'د', 'ذ', 'ر', 'ز', 'و'].sort());
});
test('LETTERS: exactly the 14 sun letters carry sun=true', () => {
  const sun = E.LETTERS.filter((l) => l.sun).map((l) => l.ar).sort();
  deepEq(sun, ['ت', 'ث', 'د', 'ذ', 'ر', 'ز', 'س', 'ش', 'ص', 'ض', 'ط', 'ظ', 'ل', 'ن'].sort());
});
test('LETTERS: contextual forms behave (connectors change shape, isolates do not)', () => {
  for (const L of E.LETTERS) {
    if (L.ar === 'ء') continue;
    if (L.connects) {
      assert.notEqual(L.initial, L.isolated, `${L.id} initial should differ from isolated`);
      assert.ok(L.medial.length >= 2, `${L.id} medial should carry joins`);
    } else {
      assert.equal(L.initial, L.isolated, `${L.id} never connects onward`);
      assert.equal(L.medial, L.final, `${L.id} medial = final for non-connectors`);
    }
  }
});
test('letterByChar/letterById/similarLetters/letterGroups', () => {
  assert.equal(E.letterByChar('ب').id, 'ba');
  assert.equal(E.letterById('ba').ar, 'ب');
  assert.equal(E.letterByChar('X'), null);
  const sims = E.similarLetters('ب');
  assert.ok(sims.includes('ت') && sims.includes('ث'), 'the dotted family');
  assert.ok(!sims.includes('ب'), 'never itself');
  const groups = E.letterGroups();
  assert.equal(groups.length, 5);
  const count = groups.reduce((n, g) => n + g.letters.length, 0);
  assert.equal(count, 29, 'groups cover the whole alphabet');
});

/* ---------- marks data integrity ---------- */
test('MARKS: full set of signs, vocalized names, examples', () => {
  assert.ok(E.MARKS.length >= 14, `got ${E.MARKS.length}`);
  const ids = E.MARKS.map((m) => m.id);
  for (const want of ['fatha', 'damma', 'kasra', 'sukun', 'shadda', 'ta-marbuta']) {
    assert.ok(ids.includes(want), `missing ${want}`);
  }
  for (const M of E.MARKS) {
    assert.ok(M.display && M.name && M.nameEn && M.makes && M.desc, `${M.id} incomplete`);
    assert.ok(M.example && M.example.ar && M.example.en && M.example.translit, `${M.id} example incomplete`);
  }
});

/* ---------- vocabulary data integrity ---------- */
test('UNITS: thirty themed units, 12–16 words each, all vocalized, no duplicates', () => {
  assert.equal(E.UNITS.length, 30);
  deepEq(E.UNITS.map((u) => u.id), Array.from({ length: 30 }, (_, i) => 'u' + (i + 1)));
  const seen = new Set();
  const POS = new Set(['noun', 'verb', 'adj', 'particle', 'pronoun']);
  for (const u of E.UNITS) {
    assert.ok(u.title && u.titleAr && u.icon && u.intro, `${u.id} header incomplete`);
    assert.ok(u.words.length >= 12 && u.words.length <= 16, `${u.id} has ${u.words.length} words`);
    for (const w of u.words) {
      assert.ok(w.ar && w.translit && w.en, `${u.id} word incomplete: ${JSON.stringify(w)}`);
      assert.ok(vocalized(w.ar), `${u.id} "${w.ar}" not vocalized`);
      assert.ok(POS.has(w.pos), `${u.id} "${w.ar}" bad pos ${w.pos}`);
      const key = E.normalizeAr(w.ar) + '|' + w.en;
      assert.ok(!seen.has(key), `duplicate word ${w.ar} (${w.en})`);
      seen.add(key);
    }
  }
  assert.ok(E.allWords().length >= 380, 'a real vocabulary across all three marḥalas');
});

/* ---------- morphology data integrity ---------- */
test('MORPH: pronouns, suffixes, paradigm, the ten forms, derived nouns', () => {
  assert.equal(E.MORPH.pronouns.length, 12);
  assert.equal(E.MORPH.suffixes.length, 12);
  assert.equal(E.MORPH.paradigm.length, 13);
  for (const r of E.MORPH.paradigm) {
    assert.ok(r.pronoun && r.past && r.present && r.en, `row incomplete: ${JSON.stringify(r)}`);
    assert.ok(r.pronounTranslit && r.pastTranslit && r.presentTranslit, `${r.en} translits incomplete`);
    assert.ok(vocalized(r.past) && vocalized(r.present), `${r.en} forms not vocalized`);
  }
  const pastForms = new Set(E.MORPH.paradigm.map((r) => r.past));
  assert.ok(pastForms.size >= 11, 'past forms nearly all distinct');
  deepEq(E.MORPH.forms.map((f) => f.form), ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']);
  for (const f of E.MORPH.forms) {
    assert.ok(f.wazn && f.meaning && f.example && f.example.ar && f.present, `form ${f.form} incomplete`);
  }
  assert.equal(E.MORPH.derived.length, 4);
});

/* ---------- grammar data integrity ---------- */
test('GRAMMAR: twenty-eight lessons, each teachable and quizzable', () => {
  assert.equal(E.GRAMMAR.length, 28);
  deepEq(E.GRAMMAR.map((g) => g.id), Array.from({ length: 28 }, (_, i) => 'g' + (i + 1)));
  for (const g of E.GRAMMAR) {
    assert.ok(g.title && g.titleAr && g.tagline, `${g.id} header incomplete`);
    assert.ok(g.body.length >= 2, `${g.id} body too thin`);
    assert.ok(g.examples.length >= 4, `${g.id} needs examples`);
    for (const ex of g.examples) {
      assert.ok(ex.ar && ex.translit && ex.en && ex.note, `${g.id} example incomplete`);
      assert.ok(vocalized(ex.ar), `${g.id} example "${ex.ar}" not vocalized`);
    }
    assert.equal(g.quiz.length, 5, `${g.id} quiz should have 5 questions`);
    for (const q of g.quiz) {
      assert.equal(q.options.length, 4, `${g.id} question needs 4 options`);
      assert.equal(new Set(q.options).size, 4, `${g.id} options must be distinct`);
      assert.ok(q.answer >= 0 && q.answer < 4, `${g.id} answer out of range`);
      assert.ok(q.why, `${g.id} missing explanation`);
    }
  }
});

/* ---------- reader data integrity ---------- */
test('TEXTS: the full thirteen-text library, glossed line by line', () => {
  deepEq(E.TEXTS.map((t) => t.id),
    ['fatiha', 'ikhlas', 'proverbs', 'wisdom', 'kursi', 'asr', 'falaq', 'nas', 'hadith',
     'muallaqa', 'mutanabbi', 'shafii', 'kalila']);
  assert.equal(E.textById('fatiha').lines.length, 7);
  assert.equal(E.textById('ikhlas').lines.length, 4);
  assert.ok(E.textById('proverbs').lines.length >= 8);
  assert.ok(E.textById('wisdom').lines.length >= 4);
  assert.ok(E.textById('kursi').lines.length >= 5, 'Āyat al-Kursī split into readable lines');
  assert.equal(E.textById('asr').lines.length, 3);
  assert.equal(E.textById('falaq').lines.length, 5);
  assert.equal(E.textById('nas').lines.length, 6);
  assert.ok(E.textById('hadith').lines.length >= 6);
  assert.ok(E.textById('muallaqa').lines.length >= 3);
  assert.ok(E.textById('mutanabbi').lines.length >= 4);
  assert.ok(E.textById('shafii').lines.length >= 4);
  assert.ok(E.textById('kalila').lines.length >= 4);
  for (const t of E.TEXTS) {
    assert.ok(t.title && t.titleAr && t.source && t.intro, `${t.id} header incomplete`);
    for (const [i, ln] of t.lines.entries()) {
      assert.ok(ln.ar && ln.translit && ln.en && ln.ref, `${t.id}[${i}] incomplete`);
      assert.ok(vocalized(ln.ar), `${t.id}[${i}] not vocalized`);
      const tokens = ln.ar.split(/\s+/);
      assert.equal(ln.words.length, tokens.length, `${t.id}[${i}] gloss/token count mismatch`);
      deepEq(ln.words.map((w) => w.ar), tokens, `${t.id}[${i}] glosses out of order`);
      for (const w of ln.words) assert.ok(w.en, `${t.id}[${i}] token "${w.ar}" unglossed`);
    }
  }
});
test('TEXTS: the Fātiḥa and Ikhlāṣ read like themselves', () => {
  const fatiha = E.normalizeAr(E.textById('fatiha').lines.map((l) => l.ar).join(' '));
  assert.ok(fatiha.includes('بسم الله'), 'opens with the basmala');
  assert.ok(fatiha.includes('الرحمن'), 'ar-Raḥmān present');
  assert.ok(fatiha.includes('العالمين'), 'Lord of the Worlds present');
  const ikhlas = E.normalizeAr(E.textById('ikhlas').lines.map((l) => l.ar).join(' '));
  assert.ok(ikhlas.includes('احد'), 'aḥad present');
});

/* ---------- weak verbs & patterns ---------- */
test('WEAK: nine classes, 13-row paradigms, the famous tricky forms right', () => {
  deepEq(E.WEAK.map((c) => c.id),
    ['hollow-waw', 'hollow-ya', 'hollow-a', 'doubled', 'assimilated',
     'defective-u', 'defective-i', 'defective-a', 'hamzated']);
  for (const c of E.WEAK) {
    assert.ok(c.name && c.nameAr && c.desc && c.model && c.model.ar, `${c.id} header incomplete`);
    assert.equal(c.paradigm.length, 13, `${c.id} needs the full 13-row paradigm`);
    for (const r of c.paradigm) {
      assert.ok(r.pronoun && r.past && r.present && r.en && r.pastTranslit && r.presentTranslit, `${c.id} row incomplete`);
      assert.ok(vocalized(r.past) && vocalized(r.present), `${c.id} ${r.en} not vocalized`);
    }
  }
  // Consonant skeletons of the forms every grammar drills hardest
  // (row order: ana, naḥnu, anta, anti, antumā, antum, antunna, huwa, hiya, humā m, humā f, hum, hunna).
  const skel = (cls, i, f) => E.stripTashkil(E.weakClassById(cls).paradigm[i][f]);
  assert.equal(skel('hollow-waw', 0, 'past'), 'قلت', 'qultu shortens the stem');
  assert.equal(skel('hollow-waw', 7, 'past'), 'قال');
  assert.equal(skel('hollow-ya', 0, 'past'), 'بعت', 'biʿtu');
  assert.equal(skel('hollow-a', 0, 'past'), 'خفت', 'khiftu');
  assert.equal(skel('doubled', 0, 'past'), 'مددت', 'the geminate breaks open');
  assert.equal(skel('defective-u', 8, 'past'), 'دعت', 'daʿat');
  assert.equal(skel('defective-i', 8, 'past'), 'رمت', 'ramat');
  assert.equal(skel('defective-a', 11, 'past'), 'نسوا', 'nasū');
  assert.equal(skel('hamzated', 7, 'present'), 'يأخذ', 'yaʾkhudhu');
});
test('PATTERNS: ten broken-plural moulds, masdars I–X, the quadriliteral', () => {
  const skels = E.PATTERNS.plurals.map((p) => E.stripTashkil(p.pattern));
  deepEq(skels, ['أفعال', 'فعول', 'فعال', 'أفعل', 'فعل', 'فعلاء', 'أفعلاء', 'فواعل', 'مفاعل', 'مفاعيل']);
  for (const p of E.PATTERNS.plurals) {
    assert.ok(p.patternTranslit && p.desc, `${p.pattern} incomplete`);
    assert.equal(p.examples.length, 3, `${p.pattern} needs 3 examples`);
    for (const ex of p.examples) {
      assert.ok(ex.sing && ex.pl && ex.en && ex.singTranslit && ex.plTranslit, `${p.pattern} example incomplete`);
      assert.ok(vocalized(ex.sing) && vocalized(ex.pl), `${p.pattern} example not vocalized`);
    }
  }
  deepEq(E.PATTERNS.masdars.map((m) => m.form), ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']);
  for (const m of E.PATTERNS.masdars) assert.ok(m.patterns && m.example && m.example.ar, `masdar ${m.form} incomplete`);
  assert.ok(E.PATTERNS.quad && E.PATTERNS.quad.model && E.PATTERNS.quad.model.ar, 'quadriliteral present');
});

/* ---------- quiz builders ---------- */
function checkQuiz(qs, n, label) {
  assert.equal(qs.length, n, `${label}: expected ${n} questions, got ${qs.length}`);
  for (const q of qs) {
    assert.equal(q.options.length, 4, `${label}: 4 options`);
    assert.ok(q.answer >= 0 && q.answer < 4, `${label}: answer in range`);
    const keys = q.options.map((o) => o.label + '|' + o.ar);
    assert.equal(new Set(keys).size, 4, `${label}: options distinct (${keys.join(' / ')})`);
    assert.ok(q.why, `${label}: explanation present`);
    assert.ok(q.prompt, `${label}: prompt present`);
  }
}
test('letterQuiz: deterministic, well-formed, distractors lean on look-alikes', () => {
  const qs = E.letterQuiz(E.LETTERS, 'seed-a', 10);
  checkQuiz(qs, 10, 'letterQuiz');
  deepEq(qs, E.letterQuiz(E.LETTERS, 'seed-a', 10), 'same seed, same quiz');
  assert.notEqual(JSON.stringify(qs), JSON.stringify(E.letterQuiz(E.LETTERS, 'seed-b', 10)), 'seeds vary the quiz');
  const group = E.letterGroups()[0].letters;
  checkQuiz(E.letterQuiz(group, 'g', 8), 8, 'letterQuiz on a group');
});
test('markQuiz / vocabQuiz / conjQuiz / formsQuiz invariants', () => {
  checkQuiz(E.markQuiz('m', 8), 8, 'markQuiz');
  const unit = E.unitById('u1');
  const vq = E.vocabQuiz(unit.words, 'v', 10);
  checkQuiz(vq, 10, 'vocabQuiz');
  deepEq(vq, E.vocabQuiz(unit.words, 'v', 10));
  checkQuiz(E.conjQuiz('past', 'c', 8), 8, 'conjQuiz past');
  checkQuiz(E.conjQuiz('present', 'c2', 8), 8, 'conjQuiz present');
  checkQuiz(E.formsQuiz('f', 8), 8, 'formsQuiz');
});
test('conjQuiz: the marked answer really is that pronoun’s form', () => {
  const qs = E.conjQuiz('past', 'check', 13);
  for (const q of qs) {
    const row = E.MORPH.paradigm.find((r) => r.pronoun === q.promptAr && q.prompt.includes('“' + r.en + '”'));
    assert.ok(row, `paradigm row for ${q.promptAr}`);
    assert.equal(q.options[q.answer].ar, row.past, 'answer is the right conjugation');
  }
});
test('weakQuiz: the marked answer really is that pronoun’s form', () => {
  for (const cls of E.WEAK) {
    const qs = E.weakQuiz(cls.id, 'wk:' + cls.id, 8);
    checkQuiz(qs, 8, 'weakQuiz ' + cls.id);
    deepEq(qs, E.weakQuiz(cls.id, 'wk:' + cls.id, 8), 'deterministic');
    for (const q of qs) {
      const tense = q.prompt.includes('present') ? 'present' : 'past';
      const row = cls.paradigm.find((r) => r.pronoun === q.promptAr && q.prompt.includes('“' + r.en + '”'));
      assert.ok(row, `paradigm row for ${q.promptAr}`);
      assert.equal(q.options[q.answer].ar, row[tense], 'answer is the right conjugation');
    }
  }
  deepEq(E.weakQuiz('no-such-class', 'x', 8), []);
});
test('pluralQuiz: singular → its own attested plural, never another’s', () => {
  const qs = E.pluralQuiz('pl:1', 10);
  checkQuiz(qs, 10, 'pluralQuiz');
  deepEq(qs, E.pluralQuiz('pl:1', 10), 'deterministic');
  const byS = {};
  for (const p of E.PATTERNS.plurals) for (const ex of p.examples) byS[ex.sing] = ex.pl;
  for (const q of qs) {
    assert.equal(q.options[q.answer].ar, byS[q.promptAr], `plural of ${q.promptAr}`);
  }
});
test('grammarQuiz: reshuffles options but keeps the truth', () => {
  const g = E.GRAMMAR[0];
  const qs = E.grammarQuiz(g, 's1');
  assert.equal(qs.length, g.quiz.length);
  for (let i = 0; i < qs.length; i++) {
    assert.equal(qs[i].options[qs[i].answer].label, g.quiz[i].options[g.quiz[i].answer], 'correct label preserved');
    deepEq(qs[i].options.map((o) => o.label).slice().sort(), g.quiz[i].options.slice().sort(), 'same option set');
  }
  deepEq(qs, E.grammarQuiz(g, 's1'), 'deterministic');
});
test('readQuiz: asks about the text’s own words, glosses stay honest', () => {
  const t = E.textById('fatiha');
  const qs = E.readQuiz(t, 'r', 6);
  assert.ok(qs.length >= 4, `got ${qs.length}`);
  const pool = new Set();
  for (const ln of t.lines) for (const w of ln.words) pool.add(w.ar);
  for (const q of qs) {
    assert.ok(pool.has(q.promptAr), 'prompt word comes from the text');
    checkQuiz([q], 1, 'readQuiz item');
  }
  deepEq(qs, E.readQuiz(t, 'r', 6));
});
test('vocabQuiz: no two options ever share a gloss or transliteration', () => {
  for (const u of E.UNITS) {
    for (let s = 0; s < 6; s++) {
      for (const q of E.vocabQuiz(u.words, 'fuzz:' + u.id + ':' + s, 12)) {
        const labels = q.options.map((o) => o.label);
        assert.equal(new Set(labels).size, 4, `${u.id} duplicate option: ${labels.join(' / ')}`);
      }
    }
  }
});
test('letterQuiz: sun/moon questions stay within the letters being drilled', () => {
  const subset = E.LETTERS.slice(0, 12); // 7 sun + 5 moon — both sides workable
  for (let s = 0; s < 8; s++) {
    for (const q of E.letterQuiz(subset, 'sm:' + s, 12)) {
      if (q.kind !== 'sunmoon') continue;
      for (const o of q.options) {
        assert.ok(subset.some((L) => L.ar === o.ar), `option ${o.ar} outside the drilled set`);
      }
    }
  }
  const tiny = E.LETTERS.slice(0, 2); // ا ب: no workable sun/moon split
  for (const q of E.letterQuiz(tiny, 'tiny', 10)) assert.notEqual(q.kind, 'sunmoon');
});
test('quizScore: star thresholds at 50/70/90', () => {
  const quiz = Array.from({ length: 10 }, () => ({ answer: 0 }));
  const answersOf = (n) => Array.from({ length: 10 }, (_, i) => (i < n ? 0 : 1));
  assert.equal(E.quizScore(answersOf(10), quiz).stars, 3);
  assert.equal(E.quizScore(answersOf(9), quiz).stars, 3);
  assert.equal(E.quizScore(answersOf(8), quiz).stars, 2);
  assert.equal(E.quizScore(answersOf(7), quiz).stars, 2);
  assert.equal(E.quizScore(answersOf(5), quiz).stars, 1);
  assert.equal(E.quizScore(answersOf(4), quiz).stars, 0);
  assert.equal(E.quizScore([], []).total, 0);
});

/* ---------- spaced repetition ---------- */
test('SRS: a new card is due immediately; "good" walks 1d then ~2.5d', () => {
  let c = E.newCard('w:x', NOW);
  assert.ok(E.isDue(c, NOW));
  c = E.gradeCard(c, 2, NOW);
  assert.equal(c.ivl, DAY);
  assert.equal(c.due, NOW + DAY);
  c = E.gradeCard(c, 2, NOW + DAY);
  assert.equal(c.ivl, Math.round(DAY * 2.5));
  assert.equal(c.reps, 2);
});
test('SRS: "again" resets to 10 minutes, drops ease, counts a lapse', () => {
  let c = E.gradeCard(E.newCard('w:x', NOW), 2, NOW);
  c = E.gradeCard(c, 0, NOW + DAY);
  assert.equal(c.due, NOW + DAY + 10 * MINUTE);
  assert.equal(c.ivl, 0);
  assert.equal(c.lapses, 1);
  assert.ok(c.ease < 2.5);
  const fresh = E.gradeCard(E.newCard('w:y', NOW), 0, NOW);
  assert.equal(fresh.lapses, 0, 'failing a brand-new card is not a lapse');
});
test('SRS: "easy" accelerates, ease stays within [1.3, 3.0], interval caps', () => {
  let c = E.gradeCard(E.newCard('w:x', NOW), 3, NOW);
  assert.equal(c.ivl, 3 * DAY);
  for (let i = 0; i < 30; i++) c = E.gradeCard(c, 3, c.due);
  assert.ok(c.ease <= 3.0);
  assert.ok(c.ivl <= 365 * DAY, 'interval capped at a year');
  let d = E.newCard('w:z', NOW);
  for (let i = 0; i < 30; i++) d = E.gradeCard(d, 0, NOW);
  assert.ok(d.ease >= 1.3, 'ease floor holds');
});
test('SRS: "hard" is gentler than "good"', () => {
  const base = E.gradeCard(E.gradeCard(E.newCard('w:x', NOW), 2, NOW), 2, NOW + DAY);
  const hard = E.gradeCard(base, 1, base.due);
  const good = E.gradeCard(base, 2, base.due);
  assert.ok(hard.ivl < good.ivl);
  assert.ok(hard.ease < base.ease && good.ease === base.ease);
});
test('dueCards sorts by due date; srsStats buckets; nextDueLabel speaks human', () => {
  const cards = {
    a: { id: 'a', due: NOW - HOUR, ivl: 0, reps: 1, lapses: 0, ease: 2.5, last: 0 },
    b: { id: 'b', due: NOW - DAY, ivl: 2 * DAY, reps: 2, lapses: 0, ease: 2.5, last: 0 },
    c: { id: 'c', due: NOW + DAY, ivl: 30 * DAY, reps: 9, lapses: 0, ease: 2.5, last: 0 },
  };
  deepEq(E.dueCards(cards, NOW).map((x) => x.id), ['b', 'a']);
  deepEq(E.dueCards(cards, NOW, 1).map((x) => x.id), ['b']);
  const stats = E.srsStats(cards, NOW);
  deepEq(stats, { total: 3, due: 2, learning: 1, young: 1, mature: 1 });
  assert.equal(E.nextDueLabel(cards, NOW), 'now');
  assert.equal(E.nextDueLabel({ c: cards.c }, NOW), 'in 1d');
  assert.equal(E.nextDueLabel({}, NOW), '');
});

/* ---------- streaks, XP, ranks ---------- */
test('isoDayDiff crosses months and years correctly', () => {
  assert.equal(E.isoDayDiff('2026-09-03', '2026-09-04'), 1);
  assert.equal(E.isoDayDiff('2026-08-31', '2026-09-01'), 1);
  assert.equal(E.isoDayDiff('2026-12-31', '2027-01-01'), 1);
  assert.equal(E.isoDayDiff('2026-09-04', '2026-09-04'), 0);
  assert.equal(E.isoDayDiff('2026-09-01', '2026-09-04'), 3);
});
test('bumpStreak: grows daily, survives same-day repeats, breaks on a gap', () => {
  let s = E.bumpStreak(null, '2026-09-01');
  assert.equal(s.count, 1);
  s = E.bumpStreak(s, '2026-09-01');
  assert.equal(s.count, 1, 'same day is one day');
  s = E.bumpStreak(s, '2026-09-02');
  s = E.bumpStreak(s, '2026-09-03');
  assert.equal(s.count, 3);
  assert.equal(s.best, 3);
  s = E.bumpStreak(s, '2026-09-07');
  assert.equal(s.count, 1, 'gap resets');
  assert.equal(s.best, 3, 'best remembered');
  assert.ok(E.streakAlive({ count: 2, last: '2026-09-03', best: 2 }, '2026-09-04'));
  assert.ok(!E.streakAlive({ count: 2, last: '2026-09-01', best: 2 }, '2026-09-04'));
});
test('bumpStreak: a clock that walks backwards cannot wipe a streak', () => {
  const s = E.bumpStreak({ count: 50, last: '2026-09-05', best: 50 }, '2026-09-04');
  assert.equal(s.count, 50, 'streak survives');
  assert.equal(s.last, '2026-09-05', 'watermark never moves backwards');
  assert.ok(E.streakAlive({ count: 50, last: '2026-09-05', best: 50 }, '2026-09-04'));
});
test('rankFor: the ladder from Mubtadiʾ to Lisān al-ʿArab', () => {
  const first = E.rankFor(0);
  assert.equal(first.name, 'Mubtadiʾ');
  assert.equal(first.next.name, 'Qāriʾ');
  const mid = E.rankFor(200);
  assert.equal(mid.name, 'Qāriʾ');
  assert.ok(mid.progress > 0 && mid.progress < 1);
  const top = E.rankFor(99999);
  assert.equal(top.name, 'Lisān al-ʿArab');
  assert.equal(top.next, null);
  let lastIdx = -1;
  for (const xp of [0, 119, 120, 349, 350, 800, 2000, 5000, 7000, 9500]) {
    const idx = E.RANKS.findIndex((r) => r.name === E.rankFor(xp).name);
    assert.ok(idx >= lastIdx, `rank never regresses (xp=${xp})`);
    lastIdx = idx;
  }
});

/* ---------- the course path ---------- */
test('coursePath: one unbroken road, every stage resolvable, ids unique', () => {
  const path = E.coursePath();
  assert.ok(path.length >= 30, `got ${path.length} stages`);
  assert.equal(path[0].id, 'alpha1');
  assert.equal(path[5].id, 'marks');
  const ids = new Set(path.map((s) => s.id));
  assert.equal(ids.size, path.length, 'stage ids unique');
  assert.ok(ids.has('read-fatiha') && ids.has('sarf-past') && ids.has('sarf-forms'));
  for (const st of path) {
    assert.ok(st.title && st.titleAr && st.icon, `${st.id} header incomplete`);
    if (st.kind === 'vocab') assert.ok(E.unitById(st.ref), `${st.id} unit missing`);
    if (st.kind === 'grammar') assert.ok(E.lessonById(st.ref), `${st.id} lesson missing`);
    if (st.kind === 'read') assert.ok(E.textById(st.ref), `${st.id} text missing`);
  }
  const kinds = {};
  for (const s of path) kinds[s.kind] = (kinds[s.kind] || 0) + 1;
  assert.equal(kinds.vocab, 30, 'all thirty units on the path');
  assert.equal(kinds.grammar, 28, 'all twenty-eight lessons on the path');
  assert.equal(kinds.weak, 9, 'all nine weak-verb classes on the path');
  assert.equal(kinds.read, 13, 'all thirteen texts on the path');
  assert.equal(kinds.plurals, 1);
  assert.equal(path.length, 90, 'the full ninety-stage road');
  for (const st of path.filter((s) => s.kind === 'weak')) {
    assert.ok(E.weakClassById(st.ref), `${st.id} weak class missing`);
  }
});
test('coursePath: three marḥalas in order, every stage claimed by one', () => {
  const path = E.coursePath();
  deepEq(E.SECTIONS.map((s) => s.id), ['foundation', 'intermediate', 'advanced']);
  const order = { foundation: 0, intermediate: 1, advanced: 2 };
  let last = 0;
  const seen = new Set();
  for (const st of path) {
    assert.ok(st.section in order, `${st.id} has no section`);
    assert.ok(order[st.section] >= last, `${st.id} jumps back a marḥala`);
    last = order[st.section];
    seen.add(st.section);
  }
  assert.equal(seen.size, 3, 'all three marḥalas populated');
});
test('unlocking: each stage opens when the previous is starred', () => {
  const path = E.coursePath();
  let p = E.defaultProfile();
  assert.ok(E.isUnlocked(path, p, 0));
  assert.ok(!E.isUnlocked(path, p, 1));
  p = E.recordStage(p, path[0].id, { correct: 8, total: 8, pct: 100, stars: 3 }, '2026-09-04');
  assert.ok(E.isUnlocked(path, p, 1));
  assert.ok(!E.isUnlocked(path, p, 2));
});
test('recordStage: stars only rise, tries count, XP flows once for the clear', () => {
  let p = E.defaultProfile();
  p = E.recordStage(p, 'u1', { correct: 5, total: 10, pct: 50, stars: 1 }, '2026-09-04');
  const xpAfterFirst = p.xp;
  assert.equal(p.stages.u1.stars, 1);
  assert.equal(xpAfterFirst, 5 * E.XP.question + E.XP.stageClear);
  p = E.recordStage(p, 'u1', { correct: 9, total: 10, pct: 90, stars: 3 }, '2026-09-04');
  assert.equal(p.stages.u1.stars, 3);
  assert.equal(p.stages.u1.tries, 2);
  assert.equal(p.xp, xpAfterFirst + 9 * E.XP.question, 'clear bonus not repeated');
  p = E.recordStage(p, 'u1', { correct: 2, total: 10, pct: 20, stars: 0 }, '2026-09-04');
  assert.equal(p.stages.u1.stars, 3, 'a bad day cannot demote you');
  assert.equal(p.streak.count, 1);
});
test('courseProgress counts cleared stages and stars', () => {
  const path = E.coursePath();
  let p = E.defaultProfile();
  p = E.recordStage(p, path[0].id, { correct: 8, total: 8, pct: 100, stars: 3 }, '2026-09-04');
  p = E.recordStage(p, path[1].id, { correct: 6, total: 8, pct: 75, stars: 2 }, '2026-09-04');
  const prog = E.courseProgress(p, path);
  assert.equal(prog.done, 2);
  assert.equal(prog.stars, 5);
  assert.equal(prog.total, path.length);
});

/* ---------- cards & search ---------- */
test('seedCards + cardWord: a cleared unit joins the deck and round-trips', () => {
  const unit = E.unitById('u1');
  let p = E.defaultProfile();
  p = E.seedCards(p, unit.words, NOW);
  const stats = E.srsStats(p.cards, NOW);
  assert.equal(stats.total, unit.words.length);
  assert.equal(stats.due, unit.words.length, 'new cards are due now');
  const first = E.dueCards(p.cards, NOW, 1)[0];
  const word = E.cardWord(first);
  assert.ok(word && word.ar && word.en, 'card maps back to its word');
  const again = E.seedCards(p, unit.words, NOW + DAY);
  assert.equal(E.srsStats(again.cards, NOW + DAY).total, unit.words.length, 'seeding twice never duplicates');
});
test('recordReview: stores the graded card, pays XP, feeds the streak', () => {
  let p = E.defaultProfile();
  const card = E.gradeCard(E.newCard('w:x', NOW), 2, NOW);
  p = E.recordReview(p, card, '2026-09-04');
  assert.equal(p.cards['w:x'].ivl, DAY);
  assert.equal(p.xp, E.XP.review);
  assert.equal(p.reviews, 1);
  assert.equal(p.streak.count, 1);
});
test('searchVocab finds words by English, transliteration and bare Arabic', () => {
  const w = E.UNITS[0].words[0];
  const byEn = E.searchVocab(w.en);
  assert.ok(byEn.length && byEn[0].word.en === w.en, 'exact English hit leads');
  const byTr = E.searchVocab(E.translitFold(w.translit));
  assert.ok(byTr.length, 'folded transliteration hits');
  const byAr = E.searchVocab(E.stripTashkil(w.ar));
  assert.ok(byAr.some((r) => r.word.ar === w.ar), 'bare Arabic hits');
  deepEq(E.searchVocab(''), []);
  deepEq(E.searchVocab('zzzznope'), []);
  // '-' folds to an empty transliteration: it may substring-match hyphenated
  // English glosses ("she-camel"), but must never prefix-flood every word.
  assert.ok(E.searchVocab('-').every((r) => r.score <= 40), 'empty-fold query never scores as a prefix match');
  deepEq(E.searchVocab('ʿ'), [], 'a lone ʿayn sign matches nothing');
});
test('dailyWisdom: stable per day, rotates across days, always classical', () => {
  const a = E.dailyWisdom('2026-09-04');
  deepEq(a, E.dailyWisdom('2026-09-04'));
  assert.ok(a && a.ar && a.en, 'a real line');
  const seen = new Set();
  for (let d = 1; d <= 12; d++) seen.add(E.dailyWisdom('2026-09-' + String(d).padStart(2, '0')).ar);
  assert.ok(seen.size >= 3, 'the wisdom rotates');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nbayan: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

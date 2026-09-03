#!/usr/bin/env node
/**
 * Unit tests for babel/engine.js — the pure universal-translator engine
 * behind Babel (language detection, typo-tolerant any-to-any phrase
 * matching, real-grammar number/time/date spelling in 12 languages,
 * algorithmic romanization of Cyrillic/Greek/Hangul/kana, the reversible
 * signal codecs and the Vessel constructed language).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-babel-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'babel', 'engine.js'), 'utf8');
const sandbox = { module: { exports: {} } };
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(SOURCE, sandbox, { filename: 'babel/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0); // 2026-08-14 12:00 UTC
const { HOUR, DAY } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---------- purity ---------- */

test('engine source never touches the clock, randomness, network or DOM', () => {
  for (const banned of [/Date\.now/, /Math\.random/, /\bfetch\s*\(/, /XMLHttpRequest/, /\bdocument\./, /localStorage/, /setTimeout/]) {
    assert.ok(!banned.test(SOURCE), `engine source matches ${banned}`);
  }
});

test('translate is deterministic: same input + same clock = identical JSON', () => {
  for (const input of ['where is the bathroom', '1996', '14:30', '2026-05-03', 'zzq blorp']) {
    deepEq(E.translate(input, NOW), E.translate(input, NOW), input);
  }
});

test('dailyPhrase: stable within a UTC day, changes across days, never English', () => {
  const a = E.dailyPhrase(NOW);
  deepEq(E.dailyPhrase(NOW + 2 * HOUR), a, 'same UTC day');
  let changed = false;
  for (let d = 1; d <= 5; d++) {
    if (JSON.stringify(E.dailyPhrase(NOW + d * DAY)) !== JSON.stringify(a)) changed = true;
  }
  assert.ok(changed, 'phrase of the day never changes');
  for (let d = 0; d < 40; d++) {
    const p = E.dailyPhrase(NOW + d * DAY);
    assert.ok(E.PHRASES.some((x) => x.id === p.id), `unknown id ${p.id}`);
    assert.notEqual(p.lang, 'en', 'daily language must not be English');
  }
});

/* ---------- primitives ---------- */

test('hashStr: FNV-1a reference values, rand01 stable in [0,1)', () => {
  assert.equal(E.hashStr(''), 0x811c9dc5);
  assert.equal(E.hashStr('a'), 0xe40c292c);
  const r = E.rand01('babel');
  assert.ok(r >= 0 && r < 1, `got ${r}`);
  assert.equal(E.rand01('babel'), r);
});

test('normalize: strips accents and punctuation, keeps native scripts intact', () => {
  assert.equal(E.normalize('¿Dónde ESTÁ el baño?!'), 'donde esta el bano');
  assert.equal(E.normalize('  hello,   world!! '), 'hello world');
  assert.equal(E.normalize('トイレは どこですか'), 'トイレは どこですか');
  assert.equal(E.normalize('길을 잃었어요'), '길을 잃었어요');
  assert.equal(E.normalize('İmdat!'), 'imdat');
});

test('similarity: 1 on equal and on two empties, symmetric, in [0,1]', () => {
  assert.equal(E.similarity('hello', 'hello'), 1);
  assert.equal(E.similarity('', ''), 1);
  const ab = E.similarity('kitten', 'sitting'), ba = E.similarity('sitting', 'kitten');
  assert.equal(ab, ba);
  assert.ok(ab > 0 && ab < 1, `got ${ab}`);
});

test('editDistance counts transpositions as one edit', () => {
  assert.equal(E.editDistance('teh', 'the'), 1);
  assert.equal(E.editDistance('abcd', 'abcd'), 0);
  assert.equal(E.editDistance('', 'abc'), 3);
});

test('escapeHTML escapes the five specials', () => {
  assert.equal(E.escapeHTML('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});

/* ---------- data integrity ---------- */

test('LANGS: exactly 12, unique codes, only Arabic is RTL', () => {
  assert.equal(E.LANGS.length, 12);
  const codes = new Set(E.LANGS.map((l) => l.code));
  assert.equal(codes.size, 12);
  for (const l of E.LANGS) {
    assert.equal(l.dir, l.code === 'ar' ? 'rtl' : 'ltr', l.code);
    assert.ok(l.name && l.native && l.flag && l.script && l.voice, l.code);
  }
});

test('PHRASES: 36 unique ids, every cell filled in all 12 languages', () => {
  assert.equal(E.PHRASES.length, 36);
  const ids = new Set(E.PHRASES.map((p) => p.id));
  assert.equal(ids.size, 36);
  const cats = new Set(E.CATEGORIES.map((c) => c.id));
  for (const p of E.PHRASES) {
    assert.ok(cats.has(p.cat), `${p.id}: bad category ${p.cat}`);
    assert.ok(p.en.trim(), `${p.id}: empty en`);
    for (const l of E.LANGS) {
      if (l.code === 'en') continue;
      assert.ok(p.t[l.code] && p.t[l.code].trim(), `${p.id}: empty ${l.code}`);
    }
    for (const a of p.aliases) assert.ok(E.normalize(a), `${p.id}: alias normalizes to nothing`);
  }
});

test('curated romanization exists exactly for ar/hi/zh and holds no source script', () => {
  for (const p of E.PHRASES) {
    deepEq(Object.keys(p.r).sort(), ['ar', 'hi', 'zh'], p.id);
    for (const [lang, re] of [['ar', /[؀-ۿ]/], ['hi', /[ऀ-ॿ]/], ['zh', /[一-鿿]/]]) {
      assert.ok(!re.test(p.r[lang]), `${p.id}: ${lang} transcription contains source script`);
    }
  }
});

test('Japanese phrases are kana-only so romaji is computable, not guessed', () => {
  for (const p of E.PHRASES) {
    assert.ok(!/[一-鿿]/.test(p.t.ja), `${p.id}: kanji in ja cell "${p.t.ja}"`);
  }
});

test('every category id resolves and Emergency is pinned first', () => {
  assert.equal(E.CATEGORIES[0].id, 'emergency');
  let total = 0;
  for (const c of E.CATEGORIES) {
    const list = E.phrasesByCategory(c.id);
    assert.ok(list.length >= 5, `${c.id}: only ${list.length}`);
    total += list.length;
  }
  assert.equal(total, 36);
  assert.throws(() => E.phrasesByCategory('nope'), /unknown category/);
});

/* ---------- language detection ---------- */

test('detect: one golden sentence per language', () => {
  const goldens = [
    ['where is the bathroom please', 'en'],
    ['¿dónde está el baño?', 'es'],
    ['où sont les toilettes', 'fr'],
    ['wo ist der bahnhof bitte', 'de'],
    ['nerede bir taksi lütfen', 'tr'],
    ['Где вокзал', 'ru'],
    ['Πού είναι η τουαλέτα', 'el'],
    ['أين الحمام', 'ar'],
    ['शौचालय कहाँ है', 'hi'],
    ['火车站在哪里', 'zh'],
    ['トイレは どこですか', 'ja'],
    ['기차역이 어디예요', 'ko'],
  ];
  for (const [text, lang] of goldens) {
    const d = E.detect(text);
    assert.ok(d.best, `${lang}: no best for "${text}"`);
    assert.equal(d.best.lang, lang, `"${text}" detected as ${d.best.lang}`);
    assert.ok(d.best.confidence > 0, `${lang}: zero confidence`);
  }
});

test('detect: kana beats Han for Japanese, Han alone is Mandarin', () => {
  assert.equal(E.detect('駅は どこですか').best.lang, 'ja');
  assert.equal(E.detect('你好世界').best.lang, 'zh');
});

test('detect: empty, digits and gibberish yield best:null, with evidence on hits', () => {
  deepEq(E.detect(''), { best: null, ranked: [], script: null });
  assert.equal(E.detect('12345').best, null);
  const d = E.detect('où sont les toilettes');
  assert.ok(d.ranked[0].evidence.includes('stopword:les'), JSON.stringify(d.ranked[0].evidence));
});

/* ---------- fuzzy phrase matching ---------- */

test('matchPhrase: exact English scores 1', () => {
  const m = E.matchPhrase('where is the bathroom');
  assert.equal(m.id, 'where-bathroom');
  assert.equal(m.score, 1);
  assert.equal(m.sourceLang, 'en');
});

test('matchPhrase: survives typos', () => {
  const m = E.matchPhrase('wher is teh bathrom');
  assert.equal(m.id, 'where-bathroom');
  assert.ok(m.score >= E.MATCH_THRESHOLD, `got ${m.score}`);
});

test('matchPhrase: aliases and shouting punctuation', () => {
  assert.equal(E.matchPhrase('loo').id, 'where-bathroom');
  assert.equal(E.matchPhrase('THANK YOU!!').id, 'thank-you');
  assert.equal(E.matchPhrase('taxi').id, 'taxi-please');
});

test('matchPhrase: any-to-any — French and Spanish inputs land on the same phrase', () => {
  const fr = E.matchPhrase('où sont les toilettes');
  assert.equal(fr.id, 'where-bathroom');
  assert.equal(fr.sourceLang, 'fr');
  const es = E.matchPhrase('¿dónde está el baño?');
  assert.equal(es.id, 'where-bathroom');
  assert.equal(es.sourceLang, 'es');
  const ja = E.matchPhrase('トイレは どこですか');
  assert.equal(ja.id, 'where-bathroom');
  assert.equal(ja.sourceLang, 'ja');
});

test('matchPhrase: gibberish is null; translate turns it into suggestions', () => {
  assert.equal(E.matchPhrase('zzq blorp wex'), null);
  const t = E.translate('zzq blorp wex', NOW);
  assert.equal(t.kind, 'none');
  assert.ok(t.suggestions.length >= 1 && t.suggestions.length <= 3, `${t.suggestions.length}`);
});

test('phraseIn: curated vs computed romanization, RTL flag, throws on junk', () => {
  const ja = E.phraseIn('where-bathroom', 'ja');
  assert.equal(ja.roman, 'toirewa dokodesuka');
  const zh = E.phraseIn('where-bathroom', 'zh');
  assert.equal(zh.roman, 'xǐshǒujiān zài nǎlǐ');
  const ar = E.phraseIn('where-bathroom', 'ar');
  assert.equal(ar.dir, 'rtl');
  assert.equal(E.phraseIn('hello', 'en').roman, null);
  assert.equal(E.phraseIn('hello', 'fr').roman, null);
  assert.ok(E.phraseIn('hello', 'ru').roman.length > 0);
  assert.throws(() => E.phraseIn('nope', 'en'), /unknown phrase/);
  assert.throws(() => E.phraseIn('hello', 'xx'), /unknown lang/);
});

/* ---------- number spelling ---------- */

test('French: vigesimals, et-un, quatre-vingts s-rules', () => {
  const fr = (n) => E.spellNumber(n, 'fr').text;
  assert.equal(fr(21), 'vingt et un');
  assert.equal(fr(71), 'soixante et onze');
  assert.equal(fr(80), 'quatre-vingts');
  assert.equal(fr(81), 'quatre-vingt-un');
  assert.equal(fr(91), 'quatre-vingt-onze');
  assert.equal(fr(99), 'quatre-vingt-dix-neuf');
  assert.equal(fr(100), 'cent');
  assert.equal(fr(200), 'deux cents');
  assert.equal(fr(201), 'deux cent un');
  assert.equal(fr(1996), 'mille neuf cent quatre-vingt-seize');
  assert.equal(fr(80000), 'quatre-vingt mille');
  assert.equal(fr(1000000), 'un million');
  assert.equal(fr(2000000), 'deux millions');
});

test('German: swapped compounds written solid, eine Million apart', () => {
  const de = (n) => E.spellNumber(n, 'de').text;
  assert.equal(de(21), 'einundzwanzig');
  assert.equal(de(16), 'sechzehn');
  assert.equal(de(30), 'dreißig');
  assert.equal(de(101), 'einhunderteins');
  assert.equal(de(1996), 'eintausendneunhundertsechsundneunzig');
  assert.equal(de(1000000), 'eine Million');
  assert.equal(de(2000001), 'zwei Millionen eins');
});

test('Spanish: veinti-fusion, cien vs ciento, apocope before mil/millones', () => {
  const es = (n) => E.spellNumber(n, 'es').text;
  assert.equal(es(21), 'veintiuno');
  assert.equal(es(22), 'veintidós');
  assert.equal(es(100), 'cien');
  assert.equal(es(101), 'ciento uno');
  assert.equal(es(500), 'quinientos');
  assert.equal(es(1996), 'mil novecientos noventa y seis');
  assert.equal(es(21000), 'veintiún mil');
  assert.equal(es(1000000), 'un millón');
});

test('English and Turkish', () => {
  assert.equal(E.spellNumber(0, 'en').text, 'zero');
  assert.equal(E.spellNumber(1996, 'en').text, 'one thousand nine hundred and ninety-six');
  assert.equal(E.spellNumber(1005, 'en').text, 'one thousand and five');
  assert.equal(E.spellNumber(21, 'tr').text, 'yirmi bir');
  assert.equal(E.spellNumber(1996, 'tr').text, 'bin dokuz yüz doksan altı');
  assert.equal(E.spellNumber(1000000, 'tr').text, 'bir milyon');
});

test('Russian: тысяча agreement by last digit, feminine multipliers', () => {
  const ru = (n) => E.spellNumber(n, 'ru').text;
  assert.equal(ru(1000), 'тысяча');
  assert.equal(ru(2000), 'две тысячи');
  assert.equal(ru(5000), 'пять тысяч');
  assert.equal(ru(21000), 'двадцать одна тысяча');
  assert.equal(ru(12000), 'двенадцать тысяч');
  assert.equal(ru(1996), 'тысяча девятьсот девяносто шесть');
  assert.equal(ru(1000000), 'один миллион');
  assert.equal(ru(2000000), 'два миллиона');
  assert.equal(E.spellNumber(1996, 'ru').roman, 'tysyacha devyatsot devyanosto shest');
});

test('Greek: εκατόν before a remainder, feminine χιλιάδες', () => {
  const el = (n) => E.spellNumber(n, 'el').text;
  assert.equal(el(100), 'εκατό');
  assert.equal(el(101), 'εκατόν ένα');
  assert.equal(el(1000), 'χίλια');
  assert.equal(el(2000), 'δύο χιλιάδες');
  assert.equal(el(3000), 'τρεις χιλιάδες');
  assert.equal(el(4000), 'τέσσερις χιλιάδες');
  assert.equal(el(1996), 'χίλια εννιακόσια ενενήντα έξι');
});

test('Arabic: dual forms, آلاف for 3-10, wa-joins in the reading', () => {
  assert.equal(E.spellNumber(21, 'ar').text, 'واحد وعشرون');
  assert.equal(E.spellNumber(200, 'ar').text, 'مئتان');
  assert.equal(E.spellNumber(2000, 'ar').text, 'ألفان');
  assert.equal(E.spellNumber(3000, 'ar').text, 'ثلاثة آلاف');
  assert.equal(E.spellNumber(1996, 'ar').roman, 'alf wa-tis’umi’a wa-sitta wa-tis’un');
});

test('Hindi: the irregular 0-99 table plus lakh/crore grouping', () => {
  assert.equal(E.spellNumber(19, 'hi').text, 'उन्नीस');
  assert.equal(E.spellNumber(71, 'hi').text, 'इकहत्तर');
  assert.equal(E.spellNumber(100, 'hi').text, 'एक सौ');
  assert.equal(E.spellNumber(100000, 'hi').text, 'एक लाख');
  assert.equal(E.spellNumber(10000000, 'hi').text, 'एक करोड़');
  deepEq(E.spellNumber(105, 'hi'), { text: 'एक सौ पाँच', roman: 'ek sau paanch' });
});

test('Chinese: 零-insertion, bare 十 for teens, myriad grouping', () => {
  const zh = (n) => E.spellNumber(n, 'zh').text;
  assert.equal(zh(10), '十');
  assert.equal(zh(14), '十四');
  assert.equal(zh(105), '一百零五');
  assert.equal(zh(110), '一百一十');
  assert.equal(zh(10005), '一万零五');
  assert.equal(zh(100000000), '一亿');
  assert.equal(zh(1996), '一千九百九十六');
  assert.equal(E.spellNumber(105, 'zh').roman, 'yī bǎi líng wǔ');
});

test('Japanese: rendaku irregulars and myriad grouping with readings', () => {
  deepEq(E.spellNumber(600, 'ja'), { text: '六百', roman: 'roppyaku' });
  deepEq(E.spellNumber(800, 'ja'), { text: '八百', roman: 'happyaku' });
  deepEq(E.spellNumber(3000, 'ja'), { text: '三千', roman: 'sanzen' });
  deepEq(E.spellNumber(10000, 'ja'), { text: '一万', roman: 'ichiman' });
  deepEq(E.spellNumber(3600, 'ja'), { text: '三千六百', roman: 'sanzen roppyaku' });
  deepEq(E.spellNumber(100000000, 'ja'), { text: '一億', roman: 'ichioku' });
});

test('Korean: Sino numerals, 만 without 일, romanization computed from Hangul', () => {
  deepEq(E.spellNumber(10000, 'ko'), { text: '만', roman: 'man' });
  deepEq(E.spellNumber(25000, 'ko'), { text: '이만 오천', roman: 'iman ocheon' });
  deepEq(E.spellNumber(100000000, 'ko'), { text: '일억', roman: 'ireok' });
});

test('spellNumber: domain edges — null out of range, throws on unknown lang', () => {
  for (const bad of [1.5, -1, 1e9, NaN, '5']) {
    assert.equal(E.spellNumber(bad, 'en'), null, String(bad));
  }
  assert.throws(() => E.spellNumber(5, 'xx'), /unknown lang/);
  for (const l of E.LANGS) {
    assert.ok(E.spellNumber(0, l.code).text, `${l.code}: empty zero`);
    assert.ok(E.spellNumber(999999999, l.code).text, `${l.code}: empty max`);
  }
});

test('property: 60 seeded numbers spell non-empty in all 12 languages, roman iff non-Latin', () => {
  for (let k = 0; k < 60; k++) {
    const n = E.hashStr('n' + k) % 1000000000;
    for (const l of E.LANGS) {
      const s = E.spellNumber(n, l.code);
      assert.ok(s && s.text, `${l.code} ${n}: empty`);
      if (l.script === 'latin') assert.equal(s.roman, null, `${l.code} ${n}`);
      else assert.ok(s.roman && s.roman.length > 0, `${l.code} ${n}: no roman`);
    }
  }
});

/* ---------- times and dates ---------- */

test('spellTime goldens and range errors', () => {
  assert.equal(E.spellTime(14, 30, 'fr').text, 'il est quatorze heures trente');
  assert.equal(E.spellTime(14, 30, 'de').text, 'vierzehn Uhr dreißig');
  assert.equal(E.spellTime(9, 0, 'en').text, "nine o'clock");
  assert.equal(E.spellTime(9, 5, 'en').text, 'nine oh five');
  deepEq(E.spellTime(14, 30, 'ja'), { text: '十四時三十分', roman: 'juu yo ji sanjuppun' });
  assert.equal(E.spellTime(14, 30, 'ko').text, '열네 시 삼십 분');
  assert.equal(E.spellTime(1, 5, 'es').text, 'la una y cinco');
  assert.equal(E.spellTime(14, 0, 'ru').text, 'четырнадцать часов');
  // sandbox errors carry the vm realm's prototypes — assert by name
  assert.throws(() => E.spellTime(24, 0, 'en'), (e) => e.name === 'RangeError');
  assert.throws(() => E.spellTime(0, 60, 'en'), (e) => e.name === 'RangeError');
});

test('spellDate goldens, le premier, leap-year validation', () => {
  assert.equal(E.spellDate(2026, 5, 3, 'en').text, 'May 3, 2026');
  assert.equal(E.spellDate(2026, 5, 3, 'fr').text, 'le 3 mai 2026');
  assert.equal(E.spellDate(2026, 5, 1, 'fr').text, 'le premier mai 2026');
  assert.equal(E.spellDate(2026, 5, 3, 'de').text, '3. Mai 2026');
  assert.equal(E.spellDate(2026, 5, 3, 'ru').text, '3 мая 2026 г.');
  assert.equal(E.spellDate(2026, 5, 3, 'ja').text, '2026年5月3日');
  assert.equal(E.spellDate(2026, 5, 3, 'ko').text, '2026년 5월 3일');
  assert.ok(E.spellDate(2024, 2, 29, 'en').text, 'real leap day rejected');
  assert.throws(() => E.spellDate(2023, 2, 29, 'en'), (e) => e.name === 'RangeError');
  assert.throws(() => E.spellDate(2026, 4, 31, 'en'), (e) => e.name === 'RangeError');
});

test('parseInput routes numbers, times, dates and everything else', () => {
  deepEq(E.parseInput('1996'), { kind: 'number', n: 1996 });
  deepEq(E.parseInput('1,000,000'), { kind: 'number', n: 1000000 });
  deepEq(E.parseInput('14:30'), { kind: 'time', h: 14, m: 30 });
  deepEq(E.parseInput('2026-05-03'), { kind: 'date', y: 2026, m: 5, d: 3 });
  deepEq(E.parseInput('hello'), { kind: 'text' });
  deepEq(E.parseInput('25:00'), { kind: 'text' });
  deepEq(E.parseInput('2026-13-01'), { kind: 'text' });
  deepEq(E.parseInput('1234567890'), { kind: 'text' });
});

/* ---------- romanization ---------- */

test('romanize: Cyrillic, Greek, Hangul arithmetic, Hepburn kana', () => {
  assert.equal(E.romanize('Москва').roman, 'Moskva');
  assert.equal(E.romanize('Αθήνα').roman, 'Athina');
  assert.equal(E.romanize('한글').roman, 'hangeul');
  assert.equal(E.romanize('こんにちは').roman, 'konnichiwa');
  assert.equal(E.romanize('きっぷ').roman, 'kippu');
  assert.equal(E.romanize('まっちゃ').roman, 'matcha');
  assert.equal(E.romanize('トーキョー').roman, 'tookyoo');
  assert.equal(E.romanize('きょうと').roman, 'kyouto');
});

test('romanize: Latin is idempotent; kanji passes through and lowers coverage', () => {
  const latin = E.romanize('hello');
  assert.equal(latin.roman, 'hello');
  assert.equal(latin.coverage, 1);
  assert.equal(E.romanize('トイレ').coverage, 1);
  const mixed = E.romanize('東京です');
  assert.ok(mixed.coverage < 1, `got ${mixed.coverage}`);
  assert.ok(mixed.roman.indexOf('東京') === 0, mixed.roman);
});

/* ---------- signal codecs ---------- */

test('morse: SOS golden and word separators', () => {
  assert.equal(E.encode('SOS', 'morse'), '... --- ...');
  assert.equal(E.decode('... --- ...', 'morse'), 'SOS');
  assert.equal(E.encode('hi yo', 'morse'), '.... .. / -.-- ---');
});

test('nato: word table both ways (no initial-collision decoding)', () => {
  assert.equal(E.encode('sos', 'nato'), 'Sierra Oscar Sierra');
  assert.equal(E.decode('Sierra Oscar Sierra', 'nato'), 'SOS');
  assert.equal(E.decode('three two', 'nato'), '32');
});

test('braille: cells stay in the U+2800 block; digits need the number sign', () => {
  const cells = E.encode('abc 123', 'braille');
  for (const c of cells) {
    assert.ok(c === ' ' || (c.charCodeAt(0) >= 0x2800 && c.charCodeAt(0) <= 0x28ff), c);
  }
  assert.equal(E.decode(E.encode('1a x9', 'braille'), 'braille'), '1a x9');
});

test('futhark: th and ng are single runes; c/q/v/x/y fold sensibly', () => {
  assert.equal(E.encode('th', 'futhark'), 'ᚦ');
  assert.equal(E.decode('ᚦ', 'futhark'), 'th');
  assert.equal(E.encode('thing', 'futhark'), 'ᚦᛁᛜ');
  assert.equal(E.canonical('quixotic vibes', 'futhark'), 'kuiksotik wibes');
});

test('THE LAW: decode(encode(x, c), c) === canonical(x, c) for every codec', () => {
  const corpus = ['SOS', 'Hello, World!', 'the quick brown fox 123', 'Çå fée', 'MiXeD CaSe',
    'digits 0987654321', 'a1b2 c3', '  spaced   out  ', 'emoji 🐟 survives?', '', 'thing thong', 'x y z q'];
  for (const codec of E.CODECS) {
    for (const x of corpus) {
      const want = E.canonical(x, codec.id);
      const got = E.decode(E.encode(x, codec.id), codec.id);
      assert.equal(got, want, `${codec.id}: "${x}" → "${got}" ≠ "${want}"`);
    }
  }
  assert.throws(() => E.encode('x', 'nope'), /unknown codec/);
});

/* ---------- Vessel ---------- */

test('vessel: the codebook is prefix-free (greedy decode is unambiguous)', () => {
  const words = Object.values(E.VESSEL).map(String);
  assert.equal(new Set(words).size, words.length, 'duplicate codewords');
  for (const a of words) {
    for (const b of words) {
      if (a !== b) assert.ok(!b.startsWith(a), `"${a}" is a prefix of "${b}"`);
    }
  }
});

test('vessel: exact sample and non-identity', () => {
  assert.equal(E.vesselEncode('sos'), 'lothulo');
  assert.notEqual(E.vesselEncode('hello'), 'hello');
});

test('vessel: STRICT round trip on nasty fixtures and 50 seeded strings', () => {
  const fixtures = ['Hello, World! 42', 'a-b', '--', "don't", "'A", 'trailing space ', '  double',
    '日本語 passthrough', '', "-'-", "it's-a-'quote'", 'ALL CAPS AND 0'];
  for (const s of fixtures) {
    assert.equal(E.vesselDecode(E.vesselEncode(s)), s, JSON.stringify(s));
  }
  const alphabet = "abcXYZ 019-'é日?";
  for (let k = 0; k < 50; k++) {
    let s = '';
    const len = E.hashStr('len' + k) % 24;
    for (let i = 0; i < len; i++) s += alphabet[E.hashStr(k + ':' + i) % alphabet.length];
    assert.equal(E.vesselDecode(E.vesselEncode(s)), s, JSON.stringify(s));
  }
});

/* ---------- orchestration ---------- */

test('translate("1996"): 12 cards in LANGS order, roman exactly on non-Latin', () => {
  const t = E.translate('1996', NOW);
  assert.equal(t.kind, 'number');
  assert.equal(t.n, 1996);
  deepEq(t.results.map((r) => r.lang), E.LANGS.map((l) => l.code));
  for (const r of t.results) {
    const script = E.LANGS.find((l) => l.code === r.lang).script;
    if (script === 'latin') assert.equal(r.roman, null, r.lang);
    else assert.ok(r.roman, r.lang);
  }
  assert.ok(t.signal.morse.length > 0 && t.signal.nato.length > 0);
  assert.ok(t.vessel.text.length > 0);
});

test('translate phrase: match, detection, cards, signals of the English text', () => {
  const t = E.translate('où sont les toilettes', NOW);
  assert.equal(t.kind, 'phrase');
  assert.equal(t.match.id, 'where-bathroom');
  assert.equal(t.match.sourceLang, 'fr');
  assert.equal(t.detected.best.lang, 'fr');
  assert.equal(t.results.length, 12);
  const ar = t.results.find((r) => r.lang === 'ar');
  assert.equal(ar.dir, 'rtl');
  assert.equal(t.signal.morse, E.encode('Where is the bathroom?', 'morse'));
  assert.equal(t.vessel.text, E.vesselEncode('Where is the bathroom?'));
});

test('translate: time and date kinds render all 12 cards', () => {
  const time = E.translate('14:30', NOW);
  assert.equal(time.kind, 'time');
  assert.equal(time.results.length, 12);
  const date = E.translate('2026-05-03', NOW);
  assert.equal(date.kind, 'date');
  assert.equal(date.results.find((r) => r.lang === 'fr').text, 'le 3 mai 2026');
});

test('translate: never throws on weird input', () => {
  for (const input of ['trädgård zzz', '🐟🐟🐟', '   ', '..--..', '‏', 'ó', '999999999999999']) {
    const t = E.translate(input, NOW);
    assert.ok(t.kind, JSON.stringify(input));
  }
});

/* ---------- review regressions ---------- */

test('Chinese myriad boundaries: 零 gaps, no leading 一十', () => {
  assert.equal(E.spellNumber(100005000, 'zh').text, '一亿零五千');
  assert.equal(E.spellNumber(10001000, 'zh').text, '一千万零一千');
  assert.equal(E.spellNumber(20003000, 'zh').text, '二千万零三千');
  assert.equal(E.spellNumber(100000, 'zh').text, '十万');
  assert.equal(E.spellNumber(110000, 'zh').text, '十一万');
  assert.equal(E.spellNumber(12345678, 'zh').text, '一千二百三十四万五千六百七十八');
});

test('Japanese 一千万 and Korean 일억 일만', () => {
  deepEq(E.spellNumber(10000000, 'ja'), { text: '一千万', roman: 'issen man' });
  deepEq(E.spellNumber(15000000, 'ja'), { text: '一千五百万', roman: 'issen gohyaku man' });
  deepEq(E.spellNumber(100010000, 'ko'), { text: '일억 일만', roman: 'ireok ilman' });
});

test('Greek feminine agreement before χιλιάδες, with accents kept', () => {
  assert.equal(E.spellNumber(200000, 'el').text, 'διακόσιες χιλιάδες');
  assert.equal(E.spellNumber(13000, 'el').text, 'δεκατρείς χιλιάδες');
  assert.equal(E.spellNumber(14000, 'el').text, 'δεκατέσσερις χιλιάδες');
});

test('romanize: й/ё survive accent-stripping; Greek af/ef and medial mp; silent ㅎ', () => {
  assert.equal(E.romanize('Здравствуйте').roman, 'Zdravstvuyte');
  assert.equal(E.romanize('ёлка').roman, 'yolka');
  assert.equal(E.romanize('Ευχαριστώ').roman, 'Efcharisto');
  assert.equal(E.romanize('Ευθεία').roman, 'Eftheia');
  assert.equal(E.romanize('αυτοκίνητο').roman, 'aftokinito');
  assert.equal(E.romanize('Μπορείτε').roman, 'Boreite');
  assert.equal(E.romanize('λάμπα').roman, 'lampa');
  assert.equal(E.romanize('좋은').roman, 'joeun');
});

test('romanize: particle は before punctuation and ellipsis', () => {
  assert.equal(E.romanize('こんにちは!').roman, 'konnichiwa!');
  assert.ok(E.phraseIn('my-name-is', 'ja').roman.indexOf('namaewa') !== -1);
  assert.equal(E.romanize('はい').roman, 'hai');
});

test('clock grammar: 两点, 零-minutes, feminine hours, ноль, 零時, geminated 分', () => {
  deepEq(E.spellTime(2, 0, 'zh'), { text: '两点', roman: 'liǎng diǎn' });
  assert.equal(E.spellTime(14, 5, 'zh').text, '十四点零五分');
  assert.equal(E.spellTime(21, 0, 'es').text, 'las veintiuna en punto');
  assert.equal(E.spellTime(0, 5, 'fr').text, 'il est zéro heure cinq');
  assert.equal(E.spellTime(14, 5, 'ru').text, 'четырнадцать ноль пять');
  assert.equal(E.spellTime(3, 0, 'el').text, 'τρεις η ώρα');
  assert.equal(E.spellTime(1, 0, 'el').text, 'μία η ώρα');
  deepEq(E.spellTime(0, 30, 'ja'), { text: '零時三十分', roman: 'rei ji sanjuppun' });
  assert.equal(E.spellTime(9, 0, 'ja').roman, 'ku ji');
  assert.equal(E.spellTime(6, 1, 'ja').roman, 'roku ji ippun');
  assert.ok(E.spellTime(14, 30, 'ar').text.indexOf('الثانية') !== -1, E.spellTime(14, 30, 'ar').text);
  assert.ok(E.spellTime(14, 30, 'ar').roman.indexOf('masa’an') !== -1);
});

test('detect: uppercase signature diacritics still score', () => {
  assert.equal(E.detect('NEREDE BİR TAKSİ LÜTFEN').best.lang, 'tr');
  assert.equal(E.detect('À bientôt les amis').best.lang, 'fr');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nbabel: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

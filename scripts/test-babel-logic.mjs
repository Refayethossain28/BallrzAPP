#!/usr/bin/env node
/**
 * Unit tests for babel/engine.js — the pure universal-translator engine
 * behind Babel (language detection, typo-tolerant any-to-any phrase
 * matching, real-grammar number/time/date spelling in 36 languages,
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

test('LANGS: exactly 36, unique codes, RTL exactly for ar/fa/ur/he', () => {
  assert.equal(E.LANGS.length, 36);
  const codes = new Set(E.LANGS.map((l) => l.code));
  assert.equal(codes.size, 36);
  const rtl = new Set(['ar', 'fa', 'ur', 'he']);
  for (const l of E.LANGS) {
    assert.equal(l.dir, rtl.has(l.code) ? 'rtl' : 'ltr', l.code);
    assert.ok(l.name && l.native && l.flag && l.script && l.voice, l.code);
  }
});

test('PHRASES: 40 unique ids, every cell filled in every language', () => {
  assert.equal(E.PHRASES.length, 40);
  const ids = new Set(E.PHRASES.map((p) => p.id));
  assert.equal(ids.size, 40);
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

test('curated romanization exists exactly for the CURATED_R languages', () => {
  const expected = [...E.CURATED_R].sort();
  for (const p of E.PHRASES) {
    deepEq(Object.keys(p.r).sort(), expected, p.id);
    for (const [lang, re] of [['ar', /[؀-ۿ]/], ['hi', /[ऀ-ॿ]/], ['zh', /[一-鿿]/], ['th', /[฀-๿]/], ['he', /[֐-׿]/], ['bn', /[ঀ-৿]/], ['ta', /[஀-௿]/]]) {
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
  assert.equal(total, 40);
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

test('translate("1996"): one card per language in LANGS order, roman exactly on non-Latin', () => {
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
  assert.equal(t.results.length, 36);
  const ar = t.results.find((r) => r.lang === 'ar');
  assert.equal(ar.dir, 'rtl');
  assert.equal(t.signal.morse, E.encode('Where is the bathroom?', 'morse'));
  assert.equal(t.vessel.text, E.vesselEncode('Where is the bathroom?'));
});

test('translate: time and date kinds render all 12 cards', () => {
  const time = E.translate('14:30', NOW);
  assert.equal(time.kind, 'time');
  assert.equal(time.results.length, 36);
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

/* ---------- the 24 extended languages (verified pack goldens) ---------- */

const GX = {"pt": {"n": {"0": ["zero", 0], "1": ["um", 0], "2": ["dois", 0], "5": ["cinco", 0], "10": ["dez", 0], "11": ["onze", 0], "15": ["quinze", 0], "16": ["dezesseis", 0], "20": ["vinte", 0], "21": ["vinte e um", 0], "25": ["vinte e cinco", 0], "30": ["trinta", 0], "40": ["quarenta", 0], "100": ["cem", 0], "101": ["cento e um", 0], "105": ["cento e cinco", 0], "110": ["cento e dez", 0], "200": ["duzentos", 0], "500": ["quinhentos", 0], "1000": ["mil", 0], "1996": ["mil novecentos e noventa e seis", 0], "2000": ["dois mil", 0], "5000": ["cinco mil", 0], "21000": ["vinte e um mil", 0], "100000": ["cem mil", 0], "1000000": ["um milhão", 0], "2000000": ["dois milhões", 0], "999999999": ["novecentos e noventa e nove milhões novecentos e noventa e nove mil novecentos e noventa e nove", 0]}, "t": {"14:30": ["quatorze horas e trinta", 0], "9:00": ["nove horas em ponto", 0], "1:05": ["uma hora e cinco", 0]}, "d": ["3 de maio de 2026", 0], "s": "Onde fica o banheiro? Não entendo"}, "it": {"n": {"0": ["zero", 0], "1": ["uno", 0], "2": ["due", 0], "5": ["cinque", 0], "10": ["dieci", 0], "11": ["undici", 0], "15": ["quindici", 0], "16": ["sedici", 0], "20": ["venti", 0], "21": ["ventuno", 0], "25": ["venticinque", 0], "30": ["trenta", 0], "40": ["quaranta", 0], "100": ["cento", 0], "101": ["centouno", 0], "105": ["centocinque", 0], "110": ["centodieci", 0], "200": ["duecento", 0], "500": ["cinquecento", 0], "1000": ["mille", 0], "1996": ["millenovecentonovantasei", 0], "2000": ["duemila", 0], "5000": ["cinquemila", 0], "21000": ["ventunmila", 0], "100000": ["centomila", 0], "1000000": ["un milione", 0], "2000000": ["due milioni", 0], "999999999": ["novecentonovantanove milioni novecentonovantanovemilanovecentonovantanove", 0]}, "t": {"14:30": ["sono le quattordici e trenta", 0], "9:00": ["sono le nove", 0], "1:05": ["è l'una e cinque", 0]}, "d": ["il 3 maggio 2026", 0], "s": "Scusi, dov'è la stazione?"}, "nl": {"n": {"0": ["nul", 0], "1": ["één", 0], "2": ["twee", 0], "5": ["vijf", 0], "10": ["tien", 0], "11": ["elf", 0], "15": ["vijftien", 0], "16": ["zestien", 0], "20": ["twintig", 0], "21": ["eenentwintig", 0], "25": ["vijfentwintig", 0], "30": ["dertig", 0], "40": ["veertig", 0], "100": ["honderd", 0], "101": ["honderdeen", 0], "105": ["honderdvijf", 0], "110": ["honderdtien", 0], "200": ["tweehonderd", 0], "500": ["vijfhonderd", 0], "1000": ["duizend", 0], "1996": ["duizend negenhonderdzesennegentig", 0], "2000": ["tweeduizend", 0], "5000": ["vijfduizend", 0], "21000": ["eenentwintigduizend", 0], "100000": ["honderdduizend", 0], "1000000": ["een miljoen", 0], "2000000": ["twee miljoen", 0], "999999999": ["negenhonderdnegenennegentig miljoen negenhonderdnegenennegentigduizend negenhonderdnegenennegentig", 0]}, "t": {"14:30": ["veertien uur dertig", 0], "9:00": ["negen uur", 0], "1:05": ["één uur vijf", 0]}, "d": ["3 mei 2026", 0], "s": "Waar is het station, alstublieft?"}, "pl": {"n": {"0": ["zero", 0], "1": ["jeden", 0], "2": ["dwa", 0], "5": ["pięć", 0], "10": ["dziesięć", 0], "11": ["jedenaście", 0], "15": ["piętnaście", 0], "16": ["szesnaście", 0], "20": ["dwadzieścia", 0], "21": ["dwadzieścia jeden", 0], "25": ["dwadzieścia pięć", 0], "30": ["trzydzieści", 0], "40": ["czterdzieści", 0], "100": ["sto", 0], "101": ["sto jeden", 0], "105": ["sto pięć", 0], "110": ["sto dziesięć", 0], "200": ["dwieście", 0], "500": ["pięćset", 0], "1000": ["tysiąc", 0], "1996": ["tysiąc dziewięćset dziewięćdziesiąt sześć", 0], "2000": ["dwa tysiące", 0], "5000": ["pięć tysięcy", 0], "21000": ["dwadzieścia jeden tysięcy", 0], "100000": ["sto tysięcy", 0], "1000000": ["milion", 0], "2000000": ["dwa miliony", 0], "999999999": ["dziewięćset dziewięćdziesiąt dziewięć milionów dziewięćset dziewięćdziesiąt dziewięć tysięcy dziewięćset dziewięćdziesiąt dziewięć", 0]}, "t": {"14:30": ["czternasta trzydzieści", 0], "9:00": ["dziewiąta", 0], "1:05": ["pierwsza zero pięć", 0]}, "d": ["3 maja 2026 r.", 0], "s": "Przepraszam, gdzie jest dworzec kolejowy?"}, "uk": {"n": {"0": ["нуль", "nul"], "1": ["один", "odyn"], "2": ["два", "dva"], "5": ["п’ять", "p’yat"], "10": ["десять", "desyat"], "11": ["одинадцять", "odynadtsyat"], "15": ["п’ятнадцять", "p’yatnadtsyat"], "16": ["шістнадцять", "shistnadtsyat"], "20": ["двадцять", "dvadtsyat"], "21": ["двадцять один", "dvadtsyat odyn"], "25": ["двадцять п’ять", "dvadtsyat p’yat"], "30": ["тридцять", "trydtsyat"], "40": ["сорок", "sorok"], "100": ["сто", "sto"], "101": ["сто один", "sto odyn"], "105": ["сто п’ять", "sto p’yat"], "110": ["сто десять", "sto desyat"], "200": ["двісті", "dvisti"], "500": ["п’ятсот", "p’yatsot"], "1000": ["тисяча", "tysyacha"], "1996": ["тисяча дев’ятсот дев’яносто шість", "tysyacha dev’yatsot dev’yanosto shist"], "2000": ["дві тисячі", "dvi tysyachi"], "5000": ["п’ять тисяч", "p’yat tysyach"], "21000": ["двадцять одна тисяча", "dvadtsyat odna tysyacha"], "100000": ["сто тисяч", "sto tysyach"], "1000000": ["один мільйон", "odyn milyon"], "2000000": ["два мільйони", "dva milyony"], "999999999": ["дев’ятсот дев’яносто дев’ять мільйонів дев’ятсот дев’яносто дев’ять тисяч дев’ятсот дев’яносто дев’ять", "dev’yatsot dev’yanosto dev’yat milyoniv dev’yatsot dev’yanosto dev’yat tysyach dev’yatsot dev’yanosto dev’yat"]}, "t": {"14:30": ["чотирнадцять тридцять", "chotyrnadtsyat trydtsyat"], "9:00": ["дев’ять годин", "dev’yat hodyn"], "1:05": ["один нуль п’ять", "odyn nul p’yat"]}, "d": ["3 травня 2026 р.", "3 travnya 2026 r."], "s": "Вибачте, де залізничний вокзал?"}, "cs": {"n": {"0": ["nula", 0], "1": ["jedna", 0], "2": ["dva", 0], "5": ["pět", 0], "10": ["deset", 0], "11": ["jedenáct", 0], "15": ["patnáct", 0], "16": ["šestnáct", 0], "20": ["dvacet", 0], "21": ["dvacet jedna", 0], "25": ["dvacet pět", 0], "30": ["třicet", 0], "40": ["čtyřicet", 0], "100": ["sto", 0], "101": ["sto jedna", 0], "105": ["sto pět", 0], "110": ["sto deset", 0], "200": ["dvě stě", 0], "500": ["pět set", 0], "1000": ["tisíc", 0], "1996": ["tisíc devět set devadesát šest", 0], "2000": ["dva tisíce", 0], "5000": ["pět tisíc", 0], "21000": ["dvacet jedna tisíc", 0], "100000": ["sto tisíc", 0], "1000000": ["milion", 0], "2000000": ["dva miliony", 0], "999999999": ["devět set devadesát devět milionů devět set devadesát devět tisíc devět set devadesát devět", 0]}, "t": {"14:30": ["čtrnáct třicet", 0], "9:00": ["devět hodin", 0], "1:05": ["jedna nula pět", 0]}, "d": ["3. května 2026", 0], "s": "Kde je vlakové nádraží, prosím?"}, "ro": {"n": {"0": ["zero", 0], "1": ["unu", 0], "2": ["doi", 0], "5": ["cinci", 0], "10": ["zece", 0], "11": ["unsprezece", 0], "15": ["cincisprezece", 0], "16": ["șaisprezece", 0], "20": ["douăzeci", 0], "21": ["douăzeci și unu", 0], "25": ["douăzeci și cinci", 0], "30": ["treizeci", 0], "40": ["patruzeci", 0], "100": ["o sută", 0], "101": ["o sută unu", 0], "105": ["o sută cinci", 0], "110": ["o sută zece", 0], "200": ["două sute", 0], "500": ["cinci sute", 0], "1000": ["o mie", 0], "1996": ["o mie nouă sute nouăzeci și șase", 0], "2000": ["două mii", 0], "5000": ["cinci mii", 0], "21000": ["douăzeci și una de mii", 0], "100000": ["o sută de mii", 0], "1000000": ["un milion", 0], "2000000": ["două milioane", 0], "999999999": ["nouă sute nouăzeci și nouă de milioane nouă sute nouăzeci și nouă de mii nouă sute nouăzeci și nouă", 0]}, "t": {"14:30": ["este ora paisprezece și treizeci de minute", 0], "9:00": ["este ora nouă", 0], "1:05": ["este ora unu și cinci minute", 0]}, "d": ["3 mai 2026", 0], "s": "Unde este gara, vă rog?"}, "sv": {"n": {"0": ["noll", 0], "1": ["ett", 0], "2": ["två", 0], "5": ["fem", 0], "10": ["tio", 0], "11": ["elva", 0], "15": ["femton", 0], "16": ["sexton", 0], "20": ["tjugo", 0], "21": ["tjugoett", 0], "25": ["tjugofem", 0], "30": ["trettio", 0], "40": ["fyrtio", 0], "100": ["hundra", 0], "101": ["hundraett", 0], "105": ["hundrafem", 0], "110": ["hundratio", 0], "200": ["tvåhundra", 0], "500": ["femhundra", 0], "1000": ["tusen", 0], "1996": ["tusenniohundranittiosex", 0], "2000": ["tvåtusen", 0], "5000": ["femtusen", 0], "21000": ["tjugoettusen", 0], "100000": ["hundratusen", 0], "1000000": ["en miljon", 0], "2000000": ["två miljoner", 0], "999999999": ["niohundranittionio miljoner niohundranittioniotusenniohundranittionio", 0]}, "t": {"14:30": ["klockan fjorton trettio", 0], "9:00": ["klockan nio", 0], "1:05": ["klockan ett noll fem", 0]}, "d": ["den 3 maj 2026", 0], "s": "Ursäkta, var ligger tågstationen?"}, "hu": {"n": {"0": ["nulla", 0], "1": ["egy", 0], "2": ["kettő", 0], "5": ["öt", 0], "10": ["tíz", 0], "11": ["tizenegy", 0], "15": ["tizenöt", 0], "16": ["tizenhat", 0], "20": ["húsz", 0], "21": ["huszonegy", 0], "25": ["huszonöt", 0], "30": ["harminc", 0], "40": ["negyven", 0], "100": ["száz", 0], "101": ["százegy", 0], "105": ["százöt", 0], "110": ["száztíz", 0], "200": ["kétszáz", 0], "500": ["ötszáz", 0], "1000": ["ezer", 0], "1996": ["ezerkilencszázkilencvenhat", 0], "2000": ["kétezer", 0], "5000": ["ötezer", 0], "21000": ["huszonegyezer", 0], "100000": ["százezer", 0], "1000000": ["egymillió", 0], "2000000": ["kétmillió", 0], "999999999": ["kilencszázkilencvenkilencmillió-kilencszázkilencvenkilencezer-kilencszázkilencvenkilenc", 0]}, "t": {"14:30": ["tizennégy óra harminc perc", 0], "9:00": ["kilenc óra", 0], "1:05": ["egy óra öt perc", 0]}, "d": ["2026. május 3.", 0], "s": "Elnézést, hol van a repülőtér?"}, "id": {"n": {"0": ["nol", 0], "1": ["satu", 0], "2": ["dua", 0], "5": ["lima", 0], "10": ["sepuluh", 0], "11": ["sebelas", 0], "15": ["lima belas", 0], "16": ["enam belas", 0], "20": ["dua puluh", 0], "21": ["dua puluh satu", 0], "25": ["dua puluh lima", 0], "30": ["tiga puluh", 0], "40": ["empat puluh", 0], "100": ["seratus", 0], "101": ["seratus satu", 0], "105": ["seratus lima", 0], "110": ["seratus sepuluh", 0], "200": ["dua ratus", 0], "500": ["lima ratus", 0], "1000": ["seribu", 0], "1996": ["seribu sembilan ratus sembilan puluh enam", 0], "2000": ["dua ribu", 0], "5000": ["lima ribu", 0], "21000": ["dua puluh satu ribu", 0], "100000": ["seratus ribu", 0], "1000000": ["satu juta", 0], "2000000": ["dua juta", 0], "999999999": ["sembilan ratus sembilan puluh sembilan juta sembilan ratus sembilan puluh sembilan ribu sembilan ratus sembilan puluh sembilan", 0]}, "t": {"14:30": ["pukul empat belas lewat tiga puluh menit", 0], "9:00": ["pukul sembilan", 0], "1:05": ["pukul satu lewat lima menit", 0]}, "d": ["3 Mei 2026", 0], "s": "Permisi, di mana stasiun kereta?"}, "vi": {"n": {"0": ["không", 0], "1": ["một", 0], "2": ["hai", 0], "5": ["năm", 0], "10": ["mười", 0], "11": ["mười một", 0], "15": ["mười lăm", 0], "16": ["mười sáu", 0], "20": ["hai mươi", 0], "21": ["hai mươi mốt", 0], "25": ["hai mươi lăm", 0], "30": ["ba mươi", 0], "40": ["bốn mươi", 0], "100": ["một trăm", 0], "101": ["một trăm linh một", 0], "105": ["một trăm linh năm", 0], "110": ["một trăm mười", 0], "200": ["hai trăm", 0], "500": ["năm trăm", 0], "1000": ["một nghìn", 0], "1996": ["một nghìn chín trăm chín mươi sáu", 0], "2000": ["hai nghìn", 0], "5000": ["năm nghìn", 0], "21000": ["hai mươi mốt nghìn", 0], "100000": ["một trăm nghìn", 0], "1000000": ["một triệu", 0], "2000000": ["hai triệu", 0], "999999999": ["chín trăm chín mươi chín triệu chín trăm chín mươi chín nghìn chín trăm chín mươi chín", 0]}, "t": {"14:30": ["mười bốn giờ ba mươi phút", 0], "9:00": ["chín giờ", 0], "1:05": ["một giờ năm phút", 0]}, "d": ["ngày 3 tháng 5 năm 2026", 0], "s": "Xin hỏi, ga tàu ở đâu?"}, "th": {"n": {"0": ["ศูนย์", "sun"], "1": ["หนึ่ง", "nueng"], "2": ["สอง", "song"], "5": ["ห้า", "ha"], "10": ["สิบ", "sip"], "11": ["สิบเอ็ด", "sip et"], "15": ["สิบห้า", "sip ha"], "16": ["สิบหก", "sip hok"], "20": ["ยี่สิบ", "yi sip"], "21": ["ยี่สิบเอ็ด", "yi sip et"], "25": ["ยี่สิบห้า", "yi sip ha"], "30": ["สามสิบ", "sam sip"], "40": ["สี่สิบ", "si sip"], "100": ["หนึ่งร้อย", "nueng roi"], "101": ["หนึ่งร้อยเอ็ด", "nueng roi et"], "105": ["หนึ่งร้อยห้า", "nueng roi ha"], "110": ["หนึ่งร้อยสิบ", "nueng roi sip"], "200": ["สองร้อย", "song roi"], "500": ["ห้าร้อย", "ha roi"], "1000": ["หนึ่งพัน", "nueng phan"], "1996": ["หนึ่งพันเก้าร้อยเก้าสิบหก", "nueng phan kao roi kao sip hok"], "2000": ["สองพัน", "song phan"], "5000": ["ห้าพัน", "ha phan"], "21000": ["สองหมื่นหนึ่งพัน", "song muen nueng phan"], "100000": ["หนึ่งแสน", "nueng saen"], "1000000": ["หนึ่งล้าน", "nueng lan"], "2000000": ["สองล้าน", "song lan"], "999999999": ["เก้าร้อยเก้าสิบเก้าล้านเก้าแสนเก้าหมื่นเก้าพันเก้าร้อยเก้าสิบเก้า", "kao roi kao sip kao lan kao saen kao muen kao phan kao roi kao sip kao"]}, "t": {"14:30": ["สิบสี่นาฬิกาสามสิบนาที", "sip si nalika sam sip nathi"], "9:00": ["เก้านาฬิกา", "kao nalika"], "1:05": ["หนึ่งนาฬิกาห้านาที", "nueng nalika ha nathi"]}, "d": ["3 พฤษภาคม ค.ศ. 2026", "3 phruetsaphakhom kho so 2026"], "s": "สถานีรถไฟอยู่ที่ไหน"}, "fil": {"n": {"0": ["sero", 0], "1": ["isa", 0], "2": ["dalawa", 0], "5": ["lima", 0], "10": ["sampu", 0], "11": ["labing-isa", 0], "15": ["labinlima", 0], "16": ["labing-anim", 0], "20": ["dalawampu", 0], "21": ["dalawampu’t isa", 0], "25": ["dalawampu’t lima", 0], "30": ["tatlumpu", 0], "40": ["apatnapu", 0], "100": ["isang daan", 0], "101": ["isang daan at isa", 0], "105": ["isang daan at lima", 0], "110": ["isang daan at sampu", 0], "200": ["dalawang daan", 0], "500": ["limang daan", 0], "1000": ["isang libo", 0], "1996": ["isang libo siyam na raan at siyamnapu’t anim", 0], "2000": ["dalawang libo", 0], "5000": ["limang libo", 0], "21000": ["dalawampu’t isang libo", 0], "100000": ["isang daang libo", 0], "1000000": ["isang milyon", 0], "2000000": ["dalawang milyon", 0], "999999999": ["siyam na raan at siyamnapu’t siyam na milyon siyam na raan at siyamnapu’t siyam na libo siyam na raan at siyamnapu’t siyam", 0]}, "t": {"14:30": ["alas-dos y medya ng hapon", 0], "9:00": ["alas-nuwebe ng umaga", 0], "1:05": ["ala-una singko ng umaga", 0]}, "d": ["ika-3 ng Mayo, 2026", 0], "s": "Nasaan po ang istasyon ng tren?"}, "fa": {"n": {"0": ["صفر", "sefr"], "1": ["یک", "yek"], "2": ["دو", "do"], "5": ["پنج", "panj"], "10": ["ده", "dah"], "11": ["یازده", "yazdah"], "15": ["پانزده", "panzdah"], "16": ["شانزده", "shanzdah"], "20": ["بیست", "bist"], "21": ["بیست و یک", "bist o yek"], "25": ["بیست و پنج", "bist o panj"], "30": ["سی", "si"], "40": ["چهل", "chehel"], "100": ["صد", "sad"], "101": ["صد و یک", "sad o yek"], "105": ["صد و پنج", "sad o panj"], "110": ["صد و ده", "sad o dah"], "200": ["دویست", "devist"], "500": ["پانصد", "pansad"], "1000": ["هزار", "hezar"], "1996": ["هزار و نهصد و نود و شش", "hezar o nohsad o navad o shesh"], "2000": ["دو هزار", "do hezar"], "5000": ["پنج هزار", "panj hezar"], "21000": ["بیست و یک هزار", "bist o yek hezar"], "100000": ["صد هزار", "sad hezar"], "1000000": ["یک میلیون", "yek milyun"], "2000000": ["دو میلیون", "do milyun"], "999999999": ["نهصد و نود و نه میلیون و نهصد و نود و نه هزار و نهصد و نود و نه", "nohsad o navad o noh milyun o nohsad o navad o noh hezar o nohsad o navad o noh"]}, "t": {"14:30": ["ساعت چهارده و سی دقیقه", "sa’at-e chahardah o si daghighe"], "9:00": ["ساعت نه", "sa’at-e noh"], "1:05": ["ساعت یک و پنج دقیقه", "sa’at-e yek o panj daghighe"]}, "d": ["3 مه 2026", "3 me 2026"], "s": "ایستگاه قطار کجاست؟"}, "he": {"n": {"0": ["אפס", "efes"], "1": ["אחת", "achat"], "2": ["שתיים", "shtayim"], "5": ["חמש", "chamesh"], "10": ["עשר", "eser"], "11": ["אחת עשרה", "achat esre"], "15": ["חמש עשרה", "chamesh esre"], "16": ["שש עשרה", "shesh esre"], "20": ["עשרים", "esrim"], "21": ["עשרים ואחת", "esrim ve-achat"], "25": ["עשרים וחמש", "esrim ve-chamesh"], "30": ["שלושים", "shloshim"], "40": ["ארבעים", "arba'im"], "100": ["מאה", "me'a"], "101": ["מאה ואחת", "me'a ve-achat"], "105": ["מאה וחמש", "me'a ve-chamesh"], "110": ["מאה ועשר", "me'a ve-eser"], "200": ["מאתיים", "matayim"], "500": ["חמש מאות", "chamesh me'ot"], "1000": ["אלף", "elef"], "1996": ["אלף תשע מאות תשעים ושש", "elef tsha me'ot tish'im ve-shesh"], "2000": ["אלפיים", "alpayim"], "5000": ["חמשת אלפים", "chameshet alafim"], "21000": ["עשרים ואחד אלף", "esrim ve-echad elef"], "100000": ["מאה אלף", "me'a elef"], "1000000": ["מיליון", "milyon"], "2000000": ["שני מיליון", "shnei milyon"], "999999999": ["תשע מאות תשעים ותשעה מיליון תשע מאות תשעים ותשעה אלף תשע מאות תשעים ותשע", "tsha me'ot tish'im ve-tish'a milyon tsha me'ot tish'im ve-tish'a elef tsha me'ot tish'im ve-tesha"]}, "t": {"14:30": ["השעה ארבע עשרה ושלושים", "ha-sha'a arba esre ve-shloshim"], "9:00": ["השעה תשע", "ha-sha'a tesha"], "1:05": ["השעה אחת וחמש דקות", "ha-sha'a achat ve-chamesh dakot"]}, "d": ["3 במאי 2026", "3 be-mai 2026"], "s": "סליחה, איפה תחנת הרכבת?"}, "bn": {"n": {"0": ["শূন্য", "shunno"], "1": ["এক", "ek"], "2": ["দুই", "dui"], "5": ["পাঁচ", "pach"], "10": ["দশ", "dosh"], "11": ["এগারো", "egaro"], "15": ["পনেরো", "ponero"], "16": ["ষোলো", "sholo"], "20": ["বিশ", "bish"], "21": ["একুশ", "ekush"], "25": ["পঁচিশ", "pochish"], "30": ["ত্রিশ", "trish"], "40": ["চল্লিশ", "chollish"], "100": ["একশ", "eksho"], "101": ["একশ এক", "eksho ek"], "105": ["একশ পাঁচ", "eksho pach"], "110": ["একশ দশ", "eksho dosh"], "200": ["দুইশ", "duisho"], "500": ["পাঁচশ", "pachsho"], "1000": ["এক হাজার", "ek hajar"], "1996": ["এক হাজার নয়শ ছিয়ানব্বই", "ek hajar noysho chhiyanobboi"], "2000": ["দুই হাজার", "dui hajar"], "5000": ["পাঁচ হাজার", "pach hajar"], "21000": ["একুশ হাজার", "ekush hajar"], "100000": ["এক লাখ", "ek lakh"], "1000000": ["দশ লাখ", "dosh lakh"], "2000000": ["বিশ লাখ", "bish lakh"], "999999999": ["নিরানব্বই কোটি নিরানব্বই লাখ নিরানব্বই হাজার নয়শ নিরানব্বই", "niranobboi koti niranobboi lakh niranobboi hajar noysho niranobboi"]}, "t": {"14:30": ["চৌদ্দটা বেজে ত্রিশ মিনিট", "chouddota beje trish minit"], "9:00": ["নয়টা বাজে", "noyta baje"], "1:05": ["একটা বেজে পাঁচ মিনিট", "ekta beje pach minit"]}, "d": ["৩ মে ২০২৬", "3 me 2026"], "s": "রেল স্টেশন কোথায়?"}, "ur": {"n": {"0": ["صفر", "sifar"], "1": ["ایک", "ek"], "2": ["دو", "do"], "5": ["پانچ", "paanch"], "10": ["دس", "das"], "11": ["گیارہ", "gyaarah"], "15": ["پندرہ", "pandrah"], "16": ["سولہ", "solah"], "20": ["بیس", "bees"], "21": ["اکیس", "ikkees"], "25": ["پچیس", "pachchees"], "30": ["تیس", "tees"], "40": ["چالیس", "chaalees"], "100": ["ایک سو", "ek sau"], "101": ["ایک سو ایک", "ek sau ek"], "105": ["ایک سو پانچ", "ek sau paanch"], "110": ["ایک سو دس", "ek sau das"], "200": ["دو سو", "do sau"], "500": ["پانچ سو", "paanch sau"], "1000": ["ایک ہزار", "ek hazaar"], "1996": ["ایک ہزار نو سو چھیانوے", "ek hazaar nau sau chhiyaanwe"], "2000": ["دو ہزار", "do hazaar"], "5000": ["پانچ ہزار", "paanch hazaar"], "21000": ["اکیس ہزار", "ikkees hazaar"], "100000": ["ایک لاکھ", "ek laakh"], "1000000": ["دس لاکھ", "das laakh"], "2000000": ["بیس لاکھ", "bees laakh"], "999999999": ["ننانوے کروڑ ننانوے لاکھ ننانوے ہزار نو سو ننانوے", "ninnaanwe crore ninnaanwe laakh ninnaanwe hazaar nau sau ninnaanwe"]}, "t": {"14:30": ["چودہ بج کر تیس منٹ", "chaudah baj kar tees minute"], "9:00": ["نو بجے", "nau baje"], "1:05": ["ایک بج کر پانچ منٹ", "ek baj kar paanch minute"]}, "d": ["3 مئی 2026", "3 mai 2026"], "s": "ریلوے اسٹیشن کہاں ہے؟"}, "pa": {"n": {"0": ["ਸਿਫ਼ਰ", "sifar"], "1": ["ਇੱਕ", "ikk"], "2": ["ਦੋ", "do"], "5": ["ਪੰਜ", "panj"], "10": ["ਦਸ", "das"], "11": ["ਗਿਆਰਾਂ", "giaaraan"], "15": ["ਪੰਦਰਾਂ", "pandraan"], "16": ["ਸੋਲਾਂ", "solaan"], "20": ["ਵੀਹ", "veeh"], "21": ["ਇੱਕੀ", "ikki"], "25": ["ਪੱਚੀ", "pachchi"], "30": ["ਤੀਹ", "teeh"], "40": ["ਚਾਲੀ", "chaali"], "100": ["ਇੱਕ ਸੌ", "ikk sau"], "101": ["ਇੱਕ ਸੌ ਇੱਕ", "ikk sau ikk"], "105": ["ਇੱਕ ਸੌ ਪੰਜ", "ikk sau panj"], "110": ["ਇੱਕ ਸੌ ਦਸ", "ikk sau das"], "200": ["ਦੋ ਸੌ", "do sau"], "500": ["ਪੰਜ ਸੌ", "panj sau"], "1000": ["ਇੱਕ ਹਜ਼ਾਰ", "ikk hazaar"], "1996": ["ਇੱਕ ਹਜ਼ਾਰ ਨੌਂ ਸੌ ਛਿਆਨਵੇਂ", "ikk hazaar naun sau chhiaanven"], "2000": ["ਦੋ ਹਜ਼ਾਰ", "do hazaar"], "5000": ["ਪੰਜ ਹਜ਼ਾਰ", "panj hazaar"], "21000": ["ਇੱਕੀ ਹਜ਼ਾਰ", "ikki hazaar"], "100000": ["ਇੱਕ ਲੱਖ", "ikk lakkh"], "1000000": ["ਦਸ ਲੱਖ", "das lakkh"], "2000000": ["ਵੀਹ ਲੱਖ", "veeh lakkh"], "999999999": ["ਨੜਿੰਨਵੇਂ ਕਰੋੜ ਨੜਿੰਨਵੇਂ ਲੱਖ ਨੜਿੰਨਵੇਂ ਹਜ਼ਾਰ ਨੌਂ ਸੌ ਨੜਿੰਨਵੇਂ", "narhinnven karor narhinnven lakkh narhinnven hazaar naun sau narhinnven"]}, "t": {"14:30": ["ਚੌਦਾਂ ਵੱਜ ਕੇ ਤੀਹ ਮਿੰਟ", "chaudaan vaj ke teeh mint"], "9:00": ["ਨੌਂ ਵਜੇ", "naun vaje"], "1:05": ["ਇੱਕ ਵੱਜ ਕੇ ਪੰਜ ਮਿੰਟ", "ikk vaj ke panj mint"]}, "d": ["3 ਮਈ 2026", "3 mai 2026"], "s": "ਰੇਲਵੇ ਸਟੇਸ਼ਨ ਕਿੱਥੇ ਹੈ?"}, "mr": {"n": {"0": ["शून्य", "shunya"], "1": ["एक", "ek"], "2": ["दोन", "don"], "5": ["पाच", "paach"], "10": ["दहा", "dahaa"], "11": ["अकरा", "akraa"], "15": ["पंधरा", "pandhraa"], "16": ["सोळा", "solaa"], "20": ["वीस", "vees"], "21": ["एकवीस", "ekvees"], "25": ["पंचवीस", "panchvees"], "30": ["तीस", "tees"], "40": ["चाळीस", "chaalees"], "100": ["शंभर", "shambhar"], "101": ["एकशे एक", "ekshe ek"], "105": ["एकशे पाच", "ekshe paach"], "110": ["एकशे दहा", "ekshe dahaa"], "200": ["दोनशे", "donshe"], "500": ["पाचशे", "paachshe"], "1000": ["एक हजार", "ek hajaar"], "1996": ["एक हजार नऊशे शहाण्णव", "ek hajaar naushe shahaannav"], "2000": ["दोन हजार", "don hajaar"], "5000": ["पाच हजार", "paach hajaar"], "21000": ["एकवीस हजार", "ekvees hajaar"], "100000": ["एक लाख", "ek laakh"], "1000000": ["दहा लाख", "dahaa laakh"], "2000000": ["वीस लाख", "vees laakh"], "999999999": ["नव्व्याण्णव कोटी नव्व्याण्णव लाख नव्व्याण्णव हजार नऊशे नव्व्याण्णव", "navvyaannav koti navvyaannav laakh navvyaannav hajaar naushe navvyaannav"]}, "t": {"14:30": ["चौदा वाजून तीस मिनिटे", "chaudaa vajun tees minite"], "9:00": ["नऊ वाजले", "nau vajle"], "1:05": ["एक वाजून पाच मिनिटे", "ek vajun paach minite"]}, "d": ["3 मे 2026", "3 me 2026"], "s": "रेल्वे स्टेशन कुठे आहे?"}, "ta": {"n": {"0": ["பூஜ்ஜியம்", "poojjiyam"], "1": ["ஒன்று", "ondru"], "2": ["இரண்டு", "irandu"], "5": ["ஐந்து", "aindhu"], "10": ["பத்து", "paththu"], "11": ["பதினொன்று", "padhinondru"], "15": ["பதினைந்து", "padhinaindhu"], "16": ["பதினாறு", "padhinaaru"], "20": ["இருபது", "irubadhu"], "21": ["இருபத்து ஒன்று", "irubaththu ondru"], "25": ["இருபத்து ஐந்து", "irubaththu aindhu"], "30": ["முப்பது", "muppadhu"], "40": ["நாற்பது", "naarpadhu"], "100": ["நூறு", "nooru"], "101": ["நூற்று ஒன்று", "nootru ondru"], "105": ["நூற்று ஐந்து", "nootru aindhu"], "110": ["நூற்று பத்து", "nootru paththu"], "200": ["இருநூறு", "irunooru"], "500": ["ஐந்நூறு", "ainnooru"], "1000": ["ஆயிரம்", "aayiram"], "1996": ["ஆயிரத்து தொள்ளாயிரத்து தொண்ணூற்று ஆறு", "aayiraththu thollaayiraththu thonnootru aaru"], "2000": ["இரண்டாயிரம்", "irandaayiram"], "5000": ["ஐந்தாயிரம்", "aindhaayiram"], "21000": ["இருபத்து ஓராயிரம்", "irubaththu oraayiram"], "100000": ["ஒரு லட்சம்", "oru latcham"], "1000000": ["பத்து லட்சம்", "paththu latcham"], "2000000": ["இருபது லட்சம்", "irubadhu latcham"], "999999999": ["தொண்ணூற்று ஒன்பது கோடியே தொண்ணூற்று ஒன்பது லட்சத்து தொண்ணூற்று ஒன்பதாயிரத்து தொள்ளாயிரத்து தொண்ணூற்று ஒன்பது", "thonnootru onbadhu kodiye thonnootru onbadhu latchaththu thonnootru onbadhaayiraththu thollaayiraththu thonnootru onbadhu"]}, "t": {"14:30": ["பதினான்கு மணி முப்பது நிமிடம்", "padhinaangu mani muppadhu nimidam"], "9:00": ["ஒன்பது மணி", "onbadhu mani"], "1:05": ["ஒரு மணி ஐந்து நிமிடம்", "oru mani aindhu nimidam"]}, "d": ["3 மே 2026", "3 me 2026"], "s": "ரயில் நிலையம் எங்கே இருக்கிறது?"}, "te": {"n": {"0": ["సున్నా", "sunnaa"], "1": ["ఒకటి", "okati"], "2": ["రెండు", "rendu"], "5": ["ఐదు", "aidu"], "10": ["పది", "padi"], "11": ["పదకొండు", "padakondu"], "15": ["పదిహేను", "padihenu"], "16": ["పదహారు", "padahaaru"], "20": ["ఇరవై", "iravai"], "21": ["ఇరవై ఒకటి", "iravai okati"], "25": ["ఇరవై ఐదు", "iravai aidu"], "30": ["ముప్పై", "muppai"], "40": ["నలభై", "nalabhai"], "100": ["వంద", "vanda"], "101": ["నూట ఒకటి", "noota okati"], "105": ["నూట ఐదు", "noota aidu"], "110": ["నూట పది", "noota padi"], "200": ["రెండు వందలు", "rendu vandalu"], "500": ["ఐదు వందలు", "aidu vandalu"], "1000": ["వెయ్యి", "veyyi"], "1996": ["వెయ్యి తొమ్మిది వందల తొంభై ఆరు", "veyyi tommidi vandala tombhai aaru"], "2000": ["రెండు వేలు", "rendu velu"], "5000": ["ఐదు వేలు", "aidu velu"], "21000": ["ఇరవై ఒక్క వేలు", "iravai okka velu"], "100000": ["లక్ష", "laksha"], "1000000": ["పది లక్షలు", "padi lakshalu"], "2000000": ["ఇరవై లక్షలు", "iravai lakshalu"], "999999999": ["తొంభై తొమ్మిది కోట్ల తొంభై తొమ్మిది లక్షల తొంభై తొమ్మిది వేల తొమ్మిది వందల తొంభై తొమ్మిది", "tombhai tommidi kotla tombhai tommidi lakshala tombhai tommidi vela tommidi vandala tombhai tommidi"]}, "t": {"14:30": ["పద్నాలుగు గంటల ముప్పై నిమిషాలు", "padnaalugu gantala muppai nimishaalu"], "9:00": ["తొమ్మిది గంటలు", "tommidi gantalu"], "1:05": ["ఒంటి గంట ఐదు నిమిషాలు", "onti ganta aidu nimishaalu"]}, "d": ["3 మే, 2026", "3 may, 2026"], "s": "రైల్వే స్టేషన్ ఎక్కడ ఉంది?"}, "sw": {"n": {"0": ["sifuri", 0], "1": ["moja", 0], "2": ["mbili", 0], "5": ["tano", 0], "10": ["kumi", 0], "11": ["kumi na moja", 0], "15": ["kumi na tano", 0], "16": ["kumi na sita", 0], "20": ["ishirini", 0], "21": ["ishirini na moja", 0], "25": ["ishirini na tano", 0], "30": ["thelathini", 0], "40": ["arobaini", 0], "100": ["mia moja", 0], "101": ["mia moja na moja", 0], "105": ["mia moja na tano", 0], "110": ["mia moja na kumi", 0], "200": ["mia mbili", 0], "500": ["mia tano", 0], "1000": ["elfu moja", 0], "1996": ["elfu moja mia tisa tisini na sita", 0], "2000": ["elfu mbili", 0], "5000": ["elfu tano", 0], "21000": ["elfu ishirini na moja", 0], "100000": ["elfu mia moja", 0], "1000000": ["milioni moja", 0], "2000000": ["milioni mbili", 0], "999999999": ["milioni mia tisa tisini na tisa elfu mia tisa tisini na tisa mia tisa tisini na tisa", 0]}, "t": {"14:30": ["saa nane na nusu mchana", 0], "9:00": ["saa tatu kamili asubuhi", 0], "1:05": ["saa saba na dakika tano usiku", 0]}, "d": ["tarehe 3 Mei 2026", 0], "s": "Stesheni ya treni iko wapi?"}, "am": {"n": {"0": ["ዜሮ", "zero"], "1": ["አንድ", "and"], "2": ["ሁለት", "hulet"], "5": ["አምስት", "amist"], "10": ["አስር", "asir"], "11": ["አስራ አንድ", "asra and"], "15": ["አስራ አምስት", "asra amist"], "16": ["አስራ ስድስት", "asra sidist"], "20": ["ሃያ", "haya"], "21": ["ሃያ አንድ", "haya and"], "25": ["ሃያ አምስት", "haya amist"], "30": ["ሰላሳ", "selasa"], "40": ["አርባ", "arba"], "100": ["መቶ", "meto"], "101": ["መቶ አንድ", "meto and"], "105": ["መቶ አምስት", "meto amist"], "110": ["መቶ አስር", "meto asir"], "200": ["ሁለት መቶ", "hulet meto"], "500": ["አምስት መቶ", "amist meto"], "1000": ["ሺህ", "shih"], "1996": ["ሺህ ዘጠኝ መቶ ዘጠና ስድስት", "shih zetegn meto zetena sidist"], "2000": ["ሁለት ሺህ", "hulet shih"], "5000": ["አምስት ሺህ", "amist shih"], "21000": ["ሃያ አንድ ሺህ", "haya and shih"], "100000": ["መቶ ሺህ", "meto shih"], "1000000": ["አንድ ሚሊዮን", "and miliyon"], "2000000": ["ሁለት ሚሊዮን", "hulet miliyon"], "999999999": ["ዘጠኝ መቶ ዘጠና ዘጠኝ ሚሊዮን ዘጠኝ መቶ ዘጠና ዘጠኝ ሺህ ዘጠኝ መቶ ዘጠና ዘጠኝ", "zetegn meto zetena zetegn miliyon zetegn meto zetena zetegn shih zetegn meto zetena zetegn"]}, "t": {"14:30": ["አስራ አራት ሰዓት ከሰላሳ ደቂቃ", "asra arat se’at ke-selasa dekika"], "9:00": ["ዘጠኝ ሰዓት", "zetegn se’at"], "1:05": ["አንድ ሰዓት ከአምስት ደቂቃ", "and se’at ke-amist dekika"]}, "d": ["ሜይ 3 ቀን 2026", "mey 3 ken 2026"], "s": "የባቡር ጣቢያ የት ነው?"}, "ka": {"n": {"0": ["ნული", "nuli"], "1": ["ერთი", "erti"], "2": ["ორი", "ori"], "5": ["ხუთი", "khuti"], "10": ["ათი", "ati"], "11": ["თერთმეტი", "tertmeti"], "15": ["თხუთმეტი", "tkhutmeti"], "16": ["თექვსმეტი", "tekvsmeti"], "20": ["ოცი", "otsi"], "21": ["ოცდაერთი", "otsdaerti"], "25": ["ოცდახუთი", "otsdakhuti"], "30": ["ოცდაათი", "otsdaati"], "40": ["ორმოცი", "ormotsi"], "100": ["ასი", "asi"], "101": ["ას ერთი", "as erti"], "105": ["ას ხუთი", "as khuti"], "110": ["ას ათი", "as ati"], "200": ["ორასი", "orasi"], "500": ["ხუთასი", "khutasi"], "1000": ["ათასი", "atasi"], "1996": ["ათას ცხრაას ოთხმოცდათექვსმეტი", "atas tskhraas otkhmotsdatekvsmeti"], "2000": ["ორი ათასი", "ori atasi"], "5000": ["ხუთი ათასი", "khuti atasi"], "21000": ["ოცდაერთი ათასი", "otsdaerti atasi"], "100000": ["ასი ათასი", "asi atasi"], "1000000": ["მილიონი", "milioni"], "2000000": ["ორი მილიონი", "ori milioni"], "999999999": ["ცხრაას ოთხმოცდაცხრამეტი მილიონ ცხრაას ოთხმოცდაცხრამეტი ათას ცხრაას ოთხმოცდაცხრამეტი", "tskhraas otkhmotsdatskhrameti milion tskhraas otkhmotsdatskhrameti atas tskhraas otkhmotsdatskhrameti"]}, "t": {"14:30": ["თოთხმეტი საათი და ოცდაათი წუთი", "totkhmeti saati da otsdaati tsuti"], "9:00": ["ცხრა საათი", "tskhra saati"], "1:05": ["ერთი საათი და ხუთი წუთი", "erti saati da khuti tsuti"]}, "d": ["2026 წლის 3 მაისი", "2026 tslis 3 maisi"], "s": "სად არის რკინიგზის სადგური?"}};

test('extended languages: every verified number golden, roman iff non-Latin', () => {
  for (const [lang, g] of Object.entries(GX)) {
    for (const [k, want] of Object.entries(g.n)) {
      const got = E.spellNumber(Number(k), lang);
      assert.ok(got, `${lang} ${k}: null`);
      assert.equal(got.text, want[0], `${lang} ${k}: got "${got.text}"`);
      assert.equal(got.roman ?? 0, want[1] || 0, `${lang} ${k} roman: got "${got.roman}"`);
    }
  }
});

test('extended languages: verified clock and date goldens', () => {
  for (const [lang, g] of Object.entries(GX)) {
    for (const [k, want] of Object.entries(g.t)) {
      const [h, m] = k.split(':').map(Number);
      const got = E.spellTime(h, m, lang);
      assert.equal(got.text, want[0], `${lang} ${k}: got "${got.text}"`);
      assert.equal(got.roman ?? 0, want[1] || 0, `${lang} ${k} roman: got "${got.roman}"`);
    }
    const d = E.spellDate(2026, 5, 3, lang);
    assert.equal(d.text, g.d[0], `${lang} date: got "${d.text}"`);
    assert.equal(d.roman ?? 0, g.d[1] || 0, `${lang} date roman: got "${d.roman}"`);
  }
});

test('extended languages: every golden sentence detects as its own language', () => {
  for (const [lang, g] of Object.entries(GX)) {
    const det = E.detect(g.s);
    assert.ok(det.best, `${lang}: no best for "${g.s}"`);
    assert.equal(det.best.lang, lang, `"${g.s}" detected as ${det.best.lang}`);
  }
});

test('extended languages: shared scripts split correctly', () => {
  assert.equal(E.detect('До зустрічі, дякую').best.lang, 'uk');
  assert.equal(E.detect('Помогите пожалуйста').best.lang, 'ru');
  assert.equal(E.detect('این چیست').best.lang, 'fa');
  assert.equal(E.detect('یہ کیا ہے').best.lang, 'ur');
  assert.equal(E.detect('مرحبا كيف الحال').best.lang, 'ar');
  assert.equal(E.detect('हे किती छान आहे').best.lang, 'mr');
  assert.equal(E.detect('यह बहुत अच्छा है').best.lang, 'hi');
});

test('extended languages: every phrase cell renders with the roman invariant', () => {
  for (const l of E.LANGS) {
    for (const p of E.PHRASES) {
      const cell = E.phraseIn(p.id, l.code);
      assert.ok(cell.text && cell.text.trim(), `${l.code} ${p.id}: empty`);
      if (l.script === 'latin') assert.equal(cell.roman, null, `${l.code} ${p.id}`);
      else assert.ok(cell.roman, `${l.code} ${p.id}: no roman`);
    }
  }
});

test('36-language review regressions: composer edges', () => {
  assert.equal(E.spellNumber(103, 'it').text, 'centotré');
  assert.equal(E.spellNumber(1003, 'it').text, 'milletré');
  assert.equal(E.spellNumber(23003, 'it').text, 'ventitremilatré');
  assert.equal(E.spellNumber(103000, 'it').text, 'centotremila');
  assert.equal(E.spellNumber(2500000, 'pt').text, 'dois milhões e quinhentos mil');
  assert.equal(E.spellNumber(1020000, 'pt').text, 'um milhão e vinte mil');
  assert.equal(E.spellNumber(2340000, 'pt').text, 'dois milhões trezentos e quarenta mil');
  deepEq(E.spellNumber(12000, 'he'), { text: 'שנים עשר אלף', roman: 'shneim asar elef' });
  deepEq(E.spellTime(21, 0, 'ta'), { text: 'இருபத்து ஒரு மணி', roman: 'irubaththu oru mani' });
  deepEq(E.spellTime(11, 0, 'ta'), { text: 'பதினொரு மணி', roman: 'padhinoru mani' });
});

test('detection: honest nulls on ties and weak evidence, refined shared scripts', () => {
  assert.equal(E.detect('de la gare').best, null);
  assert.equal(E.detect('van').best, null);
  assert.equal(E.detect('Guten Morgen bitte').best.lang, 'de');
  assert.equal(E.detect('God kväll').best.lang, 'sv');
  assert.equal(E.detect('Дякую').best.lang, 'uk');
  assert.equal(E.detect('Спасибо большое').best.lang, 'ru');
  assert.equal(E.detect('سلام').best.lang, 'fa');
  assert.equal(E.detect('مرحبا كيف الحال').best.lang, 'ar');
  assert.equal(E.detect('شکریہ آپ کا').best.lang, 'ur');
  assert.equal(E.detect('सर्व काही ठीक आहे').best.lang, 'mr');
  assert.equal(E.detect('यह बहुत अच्छा है').best.lang, 'hi');
});

test('detection floor: the wall recognises its own phrases', () => {
  let right = 0, wrongConfident = 0, total = 0;
  for (const l of E.LANGS) {
    for (const p of E.PHRASES) {
      const text = l.code === 'en' ? p.en : p.t[l.code];
      const d = E.detect(text);
      total++;
      if (d.best && d.best.lang === l.code) right++;
      else if (d.best && d.best.confidence > 0.3) wrongConfident++;
    }
  }
  assert.equal(total, 1440);
  assert.ok(right >= 950, `only ${right}/1440 self-detected`);
  assert.ok(wrongConfident <= 40, `${wrongConfident} confidently wrong`);
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

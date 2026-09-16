#!/usr/bin/env node
/**
 * Unit tests for maryam/engine.js — the pure maths-tutoring engine behind
 * Maryam's site (the daily-edition cover date and issue number, the
 * date-seeded puzzle and fact, forgiving answer checking, the sixty-second
 * sprint with modes/levels/points/ranks, the GCSE-season countdown, the
 * self-writing enquiry letter with proofreader validation and mailto
 * composition, and the deterministic glyph confetti).
 * Loaded in a vm sandbox (repo is type:module).
 * Run: node scripts/test-maryam-logic.mjs
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
vm.runInContext(readFileSync(join(ROOT, 'maryam', 'engine.js'), 'utf8'), sandbox, { filename: 'maryam/engine.js' });
const E = sandbox.module.exports;

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0); // 2026-09-16 12:00 UTC, a Wednesday
const { DAY, HOUR, MINUTE, SECOND } = E;

let passed = 0; const tests = []; const test = (n, f) => tests.push([n, f]);
// vm-sandbox values carry the sandbox's prototypes; compare cross-realm by shape.
const deepEq = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);

/* ---------- hashing & seeded randomness ---------- */
test('hashStr/rand01/randInt are stable, spread, and in range', () => {
  assert.equal(E.hashStr('maryam'), E.hashStr('maryam'));
  assert.notEqual(E.hashStr('a'), E.hashStr('b'));
  const r = E.rand01('seed-x');
  assert.equal(r, E.rand01('seed-x'));
  assert.ok(r >= 0 && r < 1);
  for (let i = 0; i < 200; i++) {
    const v = E.randInt('s' + i, 3, 7);
    assert.ok(v >= 3 && v <= 7, `randInt out of range: ${v}`);
  }
  const hits = new Set();
  for (let i = 0; i < 200; i++) hits.add(E.randInt('t' + i, 1, 4));
  assert.equal(hits.size, 4, 'randInt reaches every value in a small range');
});

/* ---------- text safety & formatters ---------- */
test('escapeHTML neutralises markup', () => {
  assert.equal(E.escapeHTML('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  assert.equal(E.escapeHTML(null), '');
});
test('plural and isoDate', () => {
  assert.equal(E.plural(1, 'day'), 'day');
  assert.equal(E.plural(2, 'day'), 'days');
  assert.equal(E.plural(2, 'try', 'tries'), 'tries');
  assert.equal(E.isoDate(NOW), '2026-09-16');
  assert.equal(E.isoDate(Date.UTC(2027, 0, 5)), '2027-01-05');
});

/* ---------- the daily edition ---------- */
test('issueNumber: day of the year, both ends and a leap year', () => {
  assert.equal(E.issueNumber(Date.UTC(2026, 0, 1, 10)), 1);
  assert.equal(E.issueNumber(Date.UTC(2026, 11, 31, 10)), 365);
  assert.equal(E.issueNumber(Date.UTC(2028, 11, 31, 10)), 366, '2028 is a leap year');
  assert.equal(E.issueNumber(NOW), 259, '16 Sept 2026 is day 259');
});
test('coverDate: UK-style date line with weekday, day, month', () => {
  const c = E.coverDate(NOW);
  assert.equal(c.dayNumber, 16);
  assert.equal(c.weekday, 'Wednesday');
  assert.equal(c.monthName, 'September');
  assert.equal(c.year, 2026);
  assert.equal(c.dateLine, 'Wednesday 16 September');
  assert.equal(c.iso, '2026-09-16');
  assert.equal(E.coverDate(Date.UTC(2027, 0, 1)).dateLine, 'Friday 1 January');
});

/* ---------- stages ---------- */
test('STAGES: the journey to GCSE, each stop complete', () => {
  deepEq(E.STAGES.map((s) => s.key), ['ks2', 'ks3', 'gcse']);
  for (const s of E.STAGES) {
    assert.ok(s.label && s.years, s.key);
    assert.ok(s.topics.length >= 5, `${s.key} lists its topics`);
  }
  assert.ok(/Foundation & Higher/.test(E.stageByKey('gcse').years), 'both tiers named');
  assert.equal(E.stageByKey('nope'), null);
});
test('yearToStage maps every year group to its stage', () => {
  assert.equal(E.yearToStage('Year 3').key, 'ks2');
  assert.equal(E.yearToStage('Year 6').key, 'ks2');
  assert.equal(E.yearToStage('Year 7').key, 'ks3');
  assert.equal(E.yearToStage('Year 9').key, 'ks3');
  assert.equal(E.yearToStage('Year 10').key, 'gcse');
  assert.equal(E.yearToStage('Year 11').key, 'gcse');
  assert.equal(E.yearToStage('notsure'), null);
  assert.equal(E.yearToStage('Year 13'), null);
  assert.equal(E.yearToStage(''), null);
});

/* ---------- daily fact ---------- */
test('factOfDay: stable per date, rotates across dates, always from the list', () => {
  const a = E.factOfDay('2026-09-16');
  deepEq(a, E.factOfDay('2026-09-16'));
  assert.ok(E.FACTS.includes(a.fact));
  const seen = new Set();
  for (let d = 1; d <= 28; d++) seen.add(E.factOfDay('2026-09-' + String(d).padStart(2, '0')).fact);
  assert.ok(seen.size >= 5, 'facts rotate across a month');
});

/* ---------- the daily puzzle ---------- */
test('dailyPuzzle: deterministic for a date and rotates topics across dates', () => {
  const p = E.dailyPuzzle('2026-09-16');
  deepEq(p, E.dailyPuzzle('2026-09-16'));
  const topics = new Set();
  for (let d = 0; d < 30; d++) topics.add(E.dailyPuzzle(E.isoDate(NOW + d * DAY)).topic);
  assert.ok(topics.size >= 4, `puzzle variety across a month: got ${[...topics].join(', ')}`);
});
test('dailyPuzzle: 400 days of puzzles are well-formed with whole-number answers', () => {
  for (let d = 0; d < 400; d++) {
    const p = E.dailyPuzzle(E.isoDate(NOW + d * DAY));
    assert.ok(p.question.length > 10, 'question reads like a sentence');
    assert.ok(p.hint.length > 5, 'every puzzle ships a hint');
    assert.ok(p.explain.length > 5, 'every puzzle can explain itself');
    assert.ok(Number.isInteger(p.answer), `whole-number answer, got ${p.answer} (${p.question})`);
    assert.ok(p.emoji && p.topic, 'topic and emoji present');
  }
});
test('dailyPuzzle: each maker is mathematically honest (recomputed from its own question)', () => {
  for (let d = 0; d < 400; d++) {
    const p = E.dailyPuzzle(E.isoDate(NOW + d * DAY));
    const nums = (p.question.match(/-?\d+(\.\d+)?/g) || []).map(Number);
    if (p.topic === 'Algebra') {
      // "multiply by a, add b, get r" → answer = (r - b) / a
      const [a, b, r] = nums;
      assert.equal(p.answer, (r - b) / a, p.question);
    } else if (p.topic === 'Sequences') {
      const [t1, t2, t3, t4] = nums;
      assert.equal(t2 - t1, t4 - t3, 'arithmetic sequence');
      assert.equal(p.answer, t4 + (t2 - t1), p.question);
    } else if (p.topic === 'Fractions') {
      const [num, den, whole] = nums;
      assert.equal(p.answer, (whole / den) * num, p.question);
    } else if (p.topic === 'Percentages') {
      const [base, pct] = nums;
      assert.equal(p.answer, base - (base * pct) / 100, p.question);
    } else if (p.topic === 'Geometry') {
      const [a, b] = nums;
      assert.equal(p.answer, 180 - a - b, p.question);
    } else if (p.topic === 'Statistics') {
      assert.equal(p.answer, nums.reduce((x, y) => x + y, 0) / nums.length, p.question);
    } else if (p.topic === 'Area') {
      const [w, h] = nums;
      assert.equal(p.answer, w * h, p.question);
    } else if (p.topic === 'Primes') {
      assert.ok(E.isPrime(p.answer), `answer is prime: ${p.answer}`);
      for (const n of nums) if (n !== p.answer) assert.ok(!E.isPrime(n), `distractor ${n} is not prime (${p.question})`);
      assert.equal(nums.length, 4, 'four candidates offered');
    } else {
      assert.fail('unknown topic ' + p.topic);
    }
  }
});
test('checkAnswer forgives formatting but not wrong answers', () => {
  assert.ok(E.checkAnswer(12, '12'));
  assert.ok(E.checkAnswer(12, '  12 '));
  assert.ok(E.checkAnswer(12, '12.0'));
  assert.ok(E.checkAnswer(12, '£12'));
  assert.ok(E.checkAnswer(75, '75°'));
  assert.ok(E.checkAnswer(1200, '1,200'));
  assert.ok(E.checkAnswer(-9, '-9'));
  assert.ok(!E.checkAnswer(12, '13'));
  assert.ok(!E.checkAnswer(12, ''));
  assert.ok(!E.checkAnswer(12, 'twelve'));
  assert.ok(!E.checkAnswer(12, null));
  assert.ok(!E.checkAnswer(12, '1 2 3abc'));
});

/* ---------- the sprint ---------- */
test('sprintLevelFor climbs with the streak', () => {
  deepEq([0, 3, 4, 7, 8, 11, 12, 40].map(E.sprintLevelFor), [1, 1, 2, 2, 3, 3, 4, 4]);
});
test('sprintLevelForMode: gentle caps, classic climbs, spicy floors', () => {
  deepEq([0, 5, 9, 15].map((s) => E.sprintLevelForMode('gentle', s)), [1, 2, 2, 2]);
  deepEq([0, 5, 9, 15].map((s) => E.sprintLevelForMode('classic', s)), [1, 2, 3, 4]);
  deepEq([0, 5, 9, 15].map((s) => E.sprintLevelForMode('spicy', s)), [3, 3, 3, 4]);
  deepEq(E.SPRINT_MODES.map((m) => m.key), ['gentle', 'classic', 'spicy']);
  for (const m of E.SPRINT_MODES) assert.ok(m.label && m.hint, m.key);
});
test('sprintQuestion: deterministic, and every level answer recomputes from its question text', () => {
  deepEq(E.sprintQuestion(1, 'abc'), E.sprintQuestion(1, 'abc'));
  for (let lvl = 1; lvl <= 4; lvl++) {
    for (let i = 0; i < 300; i++) {
      const { question, answer, level } = E.sprintQuestion(lvl, 'seed' + i);
      assert.equal(level, lvl);
      assert.ok(Number.isInteger(answer), `integer answer at L${lvl}: ${question}`);
      const nums = (question.match(/-?\d+/g) || []).map(Number);
      if (/×/.test(question)) assert.equal(answer, nums[0] * nums[1], question);
      else if (/÷/.test(question)) assert.equal(answer, nums[0] / nums[1], question);
      else if (/x/.test(question)) {
        // "ax + b = c.  x = ?"
        const [a, b, c] = nums;
        assert.equal(answer, (c - b) / a, question);
      } else if (/²/.test(question)) assert.equal(answer, nums[0] * nums[0], question);
      else if (/√/.test(question)) assert.equal(answer * answer, nums[0], question);
      else if (/%/.test(question)) assert.equal(answer, (nums[0] / 100) * nums[1], question);
      else if (/\//.test(question)) assert.equal(answer, nums[2] / nums[1] * nums[0], question);
      else if (/−/.test(question)) assert.equal(answer, nums[0] - nums[1], question);
      else if (/\+/.test(question)) assert.equal(answer, nums[0] + nums[1], question);
      else assert.fail('unrecognised question shape: ' + question);
    }
  }
});
test('sprint questions vary across seeds', () => {
  const qs = new Set();
  for (let i = 0; i < 60; i++) qs.add(E.sprintQuestion(1, 'v' + i).question);
  assert.ok(qs.size > 30, `variety: ${qs.size}/60 unique`);
});
test('sprintPoints follows the level multiplier', () => {
  assert.equal(E.sprintPoints(0), 10);
  assert.equal(E.sprintPoints(4), 20);
  assert.equal(E.sprintPoints(8), 30);
  assert.equal(E.sprintPoints(12), 40);
});
test('sprintRank: thresholds, next-rank gap, top rank has no next', () => {
  assert.equal(E.sprintRank(0).name, 'Warming Up');
  assert.equal(E.sprintRank(59).next.name, 'Number Ninja');
  assert.equal(E.sprintRank(59).next.needed, 1);
  assert.equal(E.sprintRank(60).name, 'Number Ninja');
  assert.equal(E.sprintRank(500).name, 'Prime Legend');
  assert.equal(E.sprintRank(9999).next, null);
  let last = -1;
  for (const s of [0, 59, 60, 149, 150, 299, 300, 499, 500, 1000]) {
    const idx = E.RANKS.findIndex((r) => r.name === E.sprintRank(s).name);
    assert.ok(idx >= last, `rank never regresses (score=${s})`);
    last = idx;
  }
});

/* ---------- the countdown ---------- */
test('defaultExamStart: aims at mid-May, rolls over after the season', () => {
  assert.equal(E.defaultExamStart(NOW), Date.UTC(2027, 4, 12, 9, 0, 0), 'Sept 2026 → May 2027');
  assert.equal(E.defaultExamStart(Date.UTC(2027, 0, 10)), Date.UTC(2027, 4, 12, 9, 0, 0));
  assert.equal(E.defaultExamStart(Date.UTC(2027, 4, 20)), Date.UTC(2027, 4, 12, 9, 0, 0), 'mid-season stays put');
  assert.equal(E.defaultExamStart(Date.UTC(2027, 6, 1)), Date.UTC(2028, 4, 12, 9, 0, 0), 'after season, next year');
});
test('countdown: exact figures, never negative, underway after the target', () => {
  const target = E.defaultExamStart(NOW);
  const c = E.countdown(NOW, target);
  assert.equal(c.phase, 'counting');
  const left = target - NOW;
  assert.equal(c.days, Math.floor(left / DAY));
  assert.equal(c.days * DAY + c.hours * HOUR + c.minutes * MINUTE + c.seconds * SECOND,
    Math.floor(left / SECOND) * SECOND, 'figures decompose the remaining time exactly');
  const oneSec = E.countdown(target - 1000, target);
  deepEq([oneSec.days, oneSec.hours, oneSec.minutes, oneSec.seconds], [0, 0, 0, 1]);
  const past = E.countdown(target + 1, target);
  assert.equal(past.phase, 'underway');
  deepEq([past.days, past.hours, past.minutes, past.seconds], [0, 0, 0, 0], 'never negative');
  assert.equal(E.countdown(NOW, NaN).phase, 'underway', 'junk target degrades gracefully');
});

/* ---------- the enquiry letter ---------- */
const GOOD = { name: '  Rafa ', year: 'Year 10', mode: 'inperson', message: 'Aiming for a 7, wobbly on algebra.' };
test('validateEnquiry: good input passes with no notes and cleaned fields', () => {
  const v = E.validateEnquiry(GOOD);
  assert.equal(v.ok, true);
  deepEq(v.notes, {});
  assert.equal(v.cleaned.name, 'Rafa');
  assert.equal(v.cleaned.mode, 'inperson');
});
test('validateEnquiry: notsure year is fine; missing fields each get a kindly note', () => {
  assert.equal(E.validateEnquiry({ ...GOOD, year: 'notsure' }).ok, true);
  const v = E.validateEnquiry({ name: '', year: 'Year 99', mode: 'teleport', message: '' });
  assert.equal(v.ok, false);
  assert.ok(v.notes.name.includes('Pencil in your name'), v.notes.name);
  assert.ok(v.notes.year.includes('perfectly good answer'), v.notes.year);
  assert.ok(v.notes.message.includes('helps me reply properly'), v.notes.message);
  assert.equal(v.cleaned.mode, 'notsure', 'unknown mode falls back to the default');
  assert.equal(E.validateEnquiry({ ...GOOD, name: 'x'.repeat(61) }).ok, false);
  assert.equal(E.validateEnquiry({ ...GOOD, message: 'x'.repeat(601) }).ok, false);
  assert.equal(E.validateEnquiry({}).ok, false);
});
test('draftLetter: complete fields → no gaps; empty fields → marked gaps', () => {
  const full = E.draftLetter(GOOD);
  deepEq(full.gaps, []);
  assert.ok(full.text.includes('My name is Rafa.'));
  assert.ok(full.text.includes('my child in Year 10'));
  assert.ok(full.text.includes('in person if possible'));
  assert.ok(full.text.includes('Aiming for a 7'));
  assert.ok(full.text.endsWith('Speak soon,\nRafa'));
  const blank = E.draftLetter({});
  deepEq(blank.gaps, ['name', 'year', 'message']);
  assert.ok(blank.text.includes(E.GAP));
  assert.ok(blank.text.includes('in person or online'), 'default mode reads naturally');
});
test('composeEnquiry: subject names year+stage+format; mailto is fully encoded', () => {
  const m = E.composeEnquiry(GOOD, 'hello@example.com');
  assert.equal(m.subject, 'Maths tutoring enquiry — Year 10 (GCSE), in person');
  assert.ok(m.body.includes('My name is Rafa.'));
  assert.ok(m.mailto.startsWith('mailto:hello@example.com?subject='));
  assert.ok(!/[ \n’]/.test(m.mailto), 'mailto fully percent-encoded');
  assert.equal(decodeURIComponent(m.mailto.split('&body=')[1]), m.body);
  const tbc = E.composeEnquiry({ ...GOOD, year: 'notsure', mode: 'notsure' }, 'hello@example.com');
  assert.equal(tbc.subject, 'Maths tutoring enquiry — year group TBC, format TBC');
});

/* ---------- confetti ---------- */
test('confettiBurst: deterministic operator glyphs with plausible physics', () => {
  deepEq(E.confettiBurst('win', 24), E.confettiBurst('win', 24));
  const burst = E.confettiBurst('win', 40);
  assert.equal(burst.length, 40);
  for (const p of burst) {
    assert.ok(p.vy < 0.5, 'launches upward-ish');
    assert.ok(p.size >= 10 && p.size <= 22);
    assert.equal(p.glyph, E.GLYPHS[p.glyphIndex], 'glyph matches its index');
  }
  const glyphs = new Set(burst.map((p) => p.glyph));
  assert.ok(glyphs.size >= 3, 'a mixed handful of + × ÷ =');
  assert.equal(E.confettiBurst('x').length, 24, 'default count');
});

/* ---------- run ---------- */
for (const [name, fn] of tests) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\nmaryam: ${passed}/${tests.length} passed`);
if (passed !== tests.length) process.exit(1);

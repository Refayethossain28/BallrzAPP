/* Maryam — the pure maths-tutoring engine.
 * =====================================================================
 * Maryam's site is a one-page home for her tutoring business: maths up
 * to GCSE, taught in person around South West London and online
 * anywhere. Every rule that makes the page feel alive — the daily
 * puzzle that changes with the date, the quick-fire sprint game and its
 * ranks, the countdown to GCSE exam season, the enquiry form's
 * validation and the mailto it composes, even the confetti physics —
 * lives HERE as pure, deterministic, clock-injected functions with zero
 * DOM and zero I/O, unit-tested in scripts/test-maryam-logic.mjs and
 * rendered by index.html.
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

  // Deterministic integer in [lo, hi] inclusive.
  function randInt(seed, lo, hi) {
    return lo + Math.floor(rand01(seed) * (hi - lo + 1));
  }

  function pickSeeded(seed, list) {
    return list[Math.floor(rand01(seed) * list.length)];
  }

  /* ---------------- text safety & tiny formatters ---------------- */

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function plural(n, one, many) {
    return n === 1 ? one : (many || one + 's');
  }

  // UTC calendar date of a timestamp as 'YYYY-MM-DD' — the seed for
  // everything that changes once a day.
  function isoDate(utcMs) {
    var d = new Date(utcMs);
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  /* ---------------- what Maryam teaches ---------------- */
  // The three stops on the journey to GCSE. The form and the topic cards
  // both render from this one list.
  var STAGES = [
    {
      key: 'ks2', label: 'Key Stage 2', years: 'Years 3–6', emoji: '🧮',
      headline: 'Where number confidence begins',
      blurb: 'Times tables that stick, fractions that finally make sense, and the quiet superpower of not being scared of maths.',
      topics: ['Times tables', 'Fractions & decimals', 'Mental arithmetic', 'Shape & measure', 'Word problems', 'SATs confidence']
    },
    {
      key: 'ks3', label: 'Key Stage 3', years: 'Years 7–9', emoji: '📐',
      headline: 'The bridge years that matter most',
      blurb: 'Algebra arrives, letters join the numbers, and good habits now make GCSE feel easy later.',
      topics: ['Algebra basics', 'Ratio & proportion', 'Angles & geometry', 'Percentages', 'Probability', 'Graphs & sequences']
    },
    {
      key: 'gcse', label: 'GCSE', years: 'Years 10–11 · Foundation & Higher', emoji: '🎓',
      headline: 'Exam technique meets real understanding',
      blurb: 'Past papers, mark-scheme thinking and topic-by-topic gap fixing — for both Foundation and Higher tiers.',
      topics: ['Number', 'Algebra', 'Ratio & proportion', 'Geometry & measures', 'Probability', 'Statistics']
    }
  ];

  function stageByKey(key) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].key === key) return STAGES[i];
    return null;
  }

  /* ---------------- one true maths fact a day ---------------- */
  var FACTS = [
    '111,111,111 × 111,111,111 = 12,345,678,987,654,321.',
    'Zero is an even number.',
    '2 is the only even prime number.',
    'A pizza with radius z and thickness a has volume pi·z·z·a.',
    'There are 43,252,003,274,489,856,000 ways to scramble a Rubik’s cube.',
    'Shuffle a pack of cards properly and that exact order has almost certainly never existed before in history.',
    'A googol is 1 followed by 100 zeros — more than there are atoms in the observable universe.',
    'Every odd number, written out in English, contains the letter “e”.',
    '37 has a party trick: 37 × 3 = 111, 37 × 6 = 222, 37 × 9 = 333.',
    '1089 × 9 = 9801 — the whole number flips around.',
    'A million seconds is about 11½ days. A billion seconds is over 31 years.',
    'Sunflower seeds and pinecones grow in Fibonacci spirals.',
    'The equals sign was invented in 1557 by a Welsh mathematician who was tired of writing “is equal to”.'
  ];

  function factOfDay(iso) {
    var idx = hashStr('maryam-fact:' + String(iso)) % FACTS.length;
    return { date: String(iso), fact: FACTS[idx], index: idx };
  }

  /* ---------------- the daily puzzle ---------------- */
  // One fresh puzzle a day, generated (not hand-picked) so no two days in
  // a row feel the same, and always with a whole-number answer. Same date
  // in = same puzzle out, which is what makes it testable.

  var PUZZLE_MAKERS = [
    function thinkOfANumber(seed) {
      var n = randInt(seed + ':n', 3, 12);
      var a = randInt(seed + ':a', 2, 6);
      var b = randInt(seed + ':b', 1, 19);
      return {
        topic: 'Algebra', emoji: '🤔',
        question: 'I’m thinking of a number. Multiply it by ' + a + ', add ' + b +
                  ', and you get ' + (n * a + b) + '. What’s my number?',
        answer: n,
        hint: 'Work backwards — undo the “add ' + b + '” first, then undo the “multiply by ' + a + '”.'
      };
    },
    function nextInSequence(seed) {
      var start = randInt(seed + ':s', 1, 15);
      var step = randInt(seed + ':d', 3, 11);
      var terms = [start, start + step, start + 2 * step, start + 3 * step];
      return {
        topic: 'Sequences', emoji: '🪜',
        question: 'What comes next: ' + terms.join(', ') + ', … ?',
        answer: start + 4 * step,
        hint: 'How big is the jump between each pair of neighbours?'
      };
    },
    function fractionOf(seed) {
      var dens = [2, 3, 4, 5, 8];
      var den = dens[randInt(seed + ':den', 0, dens.length - 1)];
      var num = randInt(seed + ':num', 1, den - 1);
      var unit = randInt(seed + ':u', 2, 12);
      var whole = den * unit;
      return {
        topic: 'Fractions', emoji: '🍕',
        question: 'What is ' + num + '/' + den + ' of ' + whole + '?',
        answer: num * unit,
        hint: 'Divide by the bottom, times by the top.'
      };
    },
    function saleDiscount(seed) {
      var pcts = [10, 20, 25, 50];
      var pct = pcts[randInt(seed + ':p', 0, pcts.length - 1)];
      // a multiple of 20 keeps the discounted price whole for every pct above
      var base = randInt(seed + ':b', 2, 15) * 20;
      return {
        topic: 'Percentages', emoji: '🏷️',
        question: 'A £' + base + ' pair of trainers is ' + pct + '% off in the sale. What do they cost now, in pounds?',
        answer: base - base * pct / 100,
        hint: 'Find ' + pct + '% of £' + base + ' first, then take it away.'
      };
    },
    function missingAngle(seed) {
      var a = randInt(seed + ':a', 25, 80);
      var b = randInt(seed + ':b', 25, 80);
      return {
        topic: 'Geometry', emoji: '📐',
        question: 'Two angles of a triangle are ' + a + '° and ' + b + '°. How many degrees is the third?',
        answer: 180 - a - b,
        hint: 'The three angles of any triangle add up to 180°.'
      };
    },
    function findTheMean(seed) {
      var m = randInt(seed + ':m', 4, 12);
      var d1 = randInt(seed + ':d1', 1, 3);
      var d2 = randInt(seed + ':d2', 1, 3);
      var scores = [m - d1, m + d1 + d2, m - d2, m];
      return {
        topic: 'Statistics', emoji: '📊',
        question: 'Four quiz scores: ' + scores.join(', ') + '. What’s the mean?',
        answer: m,
        hint: 'Add them all up, then share equally between the four.'
      };
    },
    function areaOfRectangle(seed) {
      var w = randInt(seed + ':w', 3, 12);
      var h = randInt(seed + ':h', 3, 12);
      return {
        topic: 'Area', emoji: '⬜',
        question: 'A rectangle is ' + w + ' cm wide and ' + h + ' cm tall. What’s its area in cm²?',
        answer: w * h,
        hint: 'Area of a rectangle = width × height.'
      };
    },
    function spotThePrime(seed) {
      var primes = [23, 29, 31, 37, 41, 43, 47, 53];
      var p = primes[randInt(seed + ':p', 0, primes.length - 1)];
      var others = [];
      var k = 0;
      while (others.length < 3) {
        var c = 21 + 2 * randInt(seed + ':c' + (k++), 0, 17); // odd 21..55
        if (c !== p && !isPrime(c) && others.indexOf(c) === -1) others.push(c);
      }
      var line = others.slice(0, 1).concat([p]).concat(others.slice(1));
      return {
        topic: 'Primes', emoji: '🕵️',
        question: 'Only one of these is prime: ' + line.join(', ') + '. Which one?',
        answer: p,
        hint: 'A prime has exactly two factors — itself and 1. Try dividing each by 3 and 7.'
      };
    }
  ];

  function isPrime(n) {
    if (n < 2) return false;
    for (var i = 2; i * i <= n; i++) if (n % i === 0) return false;
    return true;
  }

  function dailyPuzzle(iso) {
    var seed = 'maryam-puzzle:' + String(iso);
    var idx = hashStr(seed) % PUZZLE_MAKERS.length;
    var p = PUZZLE_MAKERS[idx](seed);
    return { date: String(iso), index: idx, topic: p.topic, emoji: p.emoji,
             question: p.question, answer: p.answer, hint: p.hint };
  }

  // Forgiving marking: "12", " 12 ", "12.0", "£12" and "12°" all count.
  function checkAnswer(expected, guess) {
    var g = String(guess == null ? '' : guess).trim().replace(/[£$°,\s]/g, '');
    if (!g || !/^-?\d+(\.\d+)?$/.test(g)) return false;
    return Math.abs(parseFloat(g) - expected) < 1e-9;
  }

  /* ---------------- the sprint: sixty seconds of quick-fire maths ---------------- */
  // Questions get harder as the streak grows. Every question is generated
  // from (level, seed) so a round can be replayed move-for-move in tests,
  // and every answer is a whole number so typing stays fast on a phone.

  function sprintLevelFor(streak) {
    if (streak < 4) return 1;
    if (streak < 8) return 2;
    if (streak < 12) return 3;
    return 4;
  }

  function sprintQuestion(level, seed) {
    var s = 'maryam-sprint:' + level + ':' + String(seed);
    var q, a;
    if (level <= 1) {
      var x = randInt(s + ':x', 2, 12), y = randInt(s + ':y', 2, 12);
      q = x + ' × ' + y; a = x * y;
    } else if (level === 2) {
      if (rand01(s + ':t') < 0.5) {
        var f = randInt(s + ':f', 3, 12), g2 = randInt(s + ':g', 3, 12);
        q = (f * g2) + ' ÷ ' + f; a = g2;
      } else {
        var m2 = randInt(s + ':m', 13, 89), n2 = randInt(s + ':n', 12, 78);
        q = m2 + ' + ' + n2; a = m2 + n2;
      }
    } else if (level === 3) {
      var pick = rand01(s + ':t');
      if (pick < 0.34) {
        var sq = randInt(s + ':sq', 4, 15);
        q = sq + '²'; a = sq * sq;
      } else if (pick < 0.67) {
        var pcts = [10, 25, 50, 75];
        var pc = pcts[randInt(s + ':pc', 0, 3)];
        var amt = randInt(s + ':amt', 2, 12) * 20;
        q = pc + '% of ' + amt; a = amt * pc / 100;
      } else {
        var den = [2, 3, 4, 5][randInt(s + ':den', 0, 3)];
        var u = randInt(s + ':u', 3, 12);
        q = '1/' + den + ' of ' + (den * u); a = u;
      }
    } else {
      var pick4 = rand01(s + ':t');
      if (pick4 < 0.34) {
        var p2 = randInt(s + ':p', 3, 29), q2 = randInt(s + ':q', p2 + 1, p2 + 40);
        q = p2 + ' − ' + q2; a = p2 - q2;
      } else if (pick4 < 0.67) {
        var xx = randInt(s + ':xx', 2, 12), aa = randInt(s + ':aa', 2, 6), bb = randInt(s + ':bb', 1, 15);
        q = aa + 'x + ' + bb + ' = ' + (aa * xx + bb) + '.  x = ?'; a = xx;
      } else {
        var r = randInt(s + ':r', 5, 20);
        q = '√' + (r * r); a = r;
      }
    }
    return { level: level, question: q, answer: a };
  }

  // Correct answers are worth more the longer the streak: 10 points, then
  // ×2 from a streak of 4, ×3 from 8, ×4 from 12.
  function sprintPoints(streak) {
    return 10 * sprintLevelFor(streak);
  }

  var RANKS = [
    { min: 0,   name: 'Warming Up',        emoji: '🌱', hint: 'Every mathematician starts somewhere.' },
    { min: 60,  name: 'Number Ninja',      emoji: '🥷', hint: 'Quick hands, quicker times tables.' },
    { min: 150, name: 'Times-Table Titan', emoji: '💪', hint: 'The 7s and 8s hold no fear for you.' },
    { min: 300, name: 'Algebrainiac',      emoji: '🧠', hint: 'You solve for x before x knows it’s lost.' },
    { min: 500, name: 'Prime Legend',      emoji: '👑', hint: 'Indivisible. Unstoppable. Show Maryam this score.' }
  ];

  function sprintRank(score) {
    var n = Math.max(0, score | 0);
    var cur = RANKS[0], next = null;
    for (var i = 0; i < RANKS.length; i++) {
      if (n >= RANKS[i].min) cur = RANKS[i];
      else { next = RANKS[i]; break; }
    }
    return { name: cur.name, emoji: cur.emoji, hint: cur.hint, min: cur.min,
             next: next ? { name: next.name, min: next.min, needed: next.min - n } : null };
  }

  /* ---------------- the road to GCSE season ---------------- */
  // GCSE maths papers land in mid-May to mid-June each year. The countdown
  // aims at mid-May; during the season itself it switches to cheering.
  var SEASON_MONTH = 4;   // May (0-indexed)
  var SEASON_DAY = 12;    // papers typically begin around here
  var SEASON_LENGTH_DAYS = 35;

  function examCountdown(now) {
    var y = new Date(now).getUTCFullYear();
    var start = Date.UTC(y, SEASON_MONTH, SEASON_DAY);
    if (now >= start + SEASON_LENGTH_DAYS * DAY) {
      y += 1;
      start = Date.UTC(y, SEASON_MONTH, SEASON_DAY);
    }
    if (now >= start) {
      return { days: 0, weeks: 0, examYear: y, inSeason: true,
               label: 'GCSE season ' + y + ' is here — deep breaths, you’ve got this.' };
    }
    var days = Math.ceil((start - now) / DAY);
    return {
      days: days, weeks: Math.floor(days / 7), examYear: y, inSeason: false,
      label: days + ' ' + plural(days, 'day') + ' until GCSE maths season ' + y
    };
  }

  /* ---------------- the enquiry form ---------------- */
  // Pure validation and a composed mailto: the page owns nothing but the
  // click. Contact details live in index.html's CONFIG, passed in here.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var MAX_NAME = 60, MAX_MESSAGE = 600;
  var MODES = ['inperson', 'online', 'either'];
  var MODE_LABELS = { inperson: 'In person (SW London)', online: 'Online', either: 'Either works' };

  function validateEnquiry(e) {
    e = e || {};
    var errors = [];
    var name = String(e.name == null ? '' : e.name).trim();
    var email = String(e.email == null ? '' : e.email).trim();
    var stage = String(e.stage == null ? '' : e.stage);
    var mode = String(e.mode == null ? '' : e.mode);
    var message = String(e.message == null ? '' : e.message).trim();
    if (!name) errors.push('Add your name so Maryam knows who to reply to.');
    else if (name.length > MAX_NAME) errors.push('Name: ' + MAX_NAME + ' characters max.');
    if (!EMAIL_RE.test(email)) errors.push('That email doesn’t look right.');
    if (!stageByKey(stage) && stage !== 'notsure') errors.push('Pick a stage — or “not sure yet” is fine too.');
    if (MODES.indexOf(mode) === -1) errors.push('Choose in person, online, or either.');
    if (message.length > MAX_MESSAGE) errors.push('Message: ' + MAX_MESSAGE + ' characters max (' + message.length + ' now).');
    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, name: name, email: email, stage: stage, mode: mode, message: message };
  }

  function composeEnquiry(v, toEmail) {
    var stage = stageByKey(v.stage);
    var stageLabel = stage ? stage.label + ' (' + stage.years + ')' : 'Not sure yet';
    var subject = 'Maths tutoring enquiry — ' + (stage ? stage.label : 'general');
    var lines = [
      'Hi Maryam,',
      '',
      'I’d love to ask about maths tutoring.',
      '',
      'Name: ' + v.name,
      'Email: ' + v.email,
      'Stage: ' + stageLabel,
      'Lessons: ' + (MODE_LABELS[v.mode] || v.mode)
    ];
    if (v.message) lines.push('', v.message);
    lines.push('', 'Thanks!');
    var body = lines.join('\n');
    return {
      subject: subject,
      body: body,
      mailto: 'mailto:' + String(toEmail || '') +
              '?subject=' + encodeURIComponent(subject) +
              '&body=' + encodeURIComponent(body)
    };
  }

  /* ---------------- confetti, deterministically ---------------- */
  // The page just draws these; physics parameters come from here so even
  // the celebration is testable. Angles in radians, speeds in px/frame.
  function confettiBurst(seed, n) {
    n = n || 24;
    var out = [];
    for (var i = 0; i < n; i++) {
      var s = 'maryam-confetti:' + String(seed) + ':' + i;
      var angle = -Math.PI / 2 + (rand01(s + ':a') - 0.5) * Math.PI * 0.9;
      var speed = 4 + rand01(s + ':v') * 7;
      out.push({
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        hue: Math.floor(rand01(s + ':h') * 360),
        size: 4 + rand01(s + ':s') * 6,
        spin: (rand01(s + ':r') - 0.5) * 0.6,
        drift: (rand01(s + ':d') - 0.5) * 0.4
      });
    }
    return out;
  }

  /* ---------------- exports ---------------- */
  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    STAGES: STAGES, FACTS: FACTS, RANKS: RANKS,
    MAX_NAME: MAX_NAME, MAX_MESSAGE: MAX_MESSAGE, MODES: MODES, MODE_LABELS: MODE_LABELS,
    hashStr: hashStr, rand01: rand01, randInt: randInt, pickSeeded: pickSeeded,
    escapeHTML: escapeHTML, plural: plural, isoDate: isoDate,
    stageByKey: stageByKey, factOfDay: factOfDay,
    dailyPuzzle: dailyPuzzle, checkAnswer: checkAnswer, isPrime: isPrime,
    sprintLevelFor: sprintLevelFor, sprintQuestion: sprintQuestion,
    sprintPoints: sprintPoints, sprintRank: sprintRank,
    examCountdown: examCountdown,
    validateEnquiry: validateEnquiry, composeEnquiry: composeEnquiry,
    confettiBurst: confettiBurst
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.MaryamEngine = E;
})(typeof self !== 'undefined' ? self : this);

/* Maryam — the pure maths-tutoring engine.
 * =====================================================================
 * Maryam's site is a one-page home for her tutoring business: maths up
 * to GCSE, taught in person around South West London and online
 * anywhere. Every rule that makes the page feel alive — the daily
 * "edition" cover date, the puzzle that changes at midnight, the
 * sixty-second sprint and its ranks, the countdown to GCSE exam season,
 * the enquiry letter that writes itself and the mailto it becomes, even
 * the glyph-confetti physics — lives HERE as pure, deterministic,
 * clock-injected functions with zero DOM and zero I/O, unit-tested in
 * scripts/test-maryam-logic.mjs and rendered by index.html.
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

  /* ---------------- the daily edition: cover date & issue number ---------------- */
  // The site is literally a daily paper: the issue number is the day of
  // the year, the cover numeral is the day of the month.
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

  function issueNumber(utcMs) {
    var d = new Date(utcMs);
    var start = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.floor((utcMs - start) / DAY) + 1;
  }

  function coverDate(utcMs) {
    var d = new Date(utcMs);
    var dayNumber = d.getUTCDate();
    var weekday = WEEKDAYS[d.getUTCDay()];
    var monthName = MONTHS[d.getUTCMonth()];
    return {
      dayNumber: dayNumber,
      weekday: weekday,
      monthName: monthName,
      year: d.getUTCFullYear(),
      dateLine: weekday + ' ' + dayNumber + ' ' + monthName,
      iso: isoDate(utcMs)
    };
  }

  /* ---------------- what Maryam teaches ---------------- */
  // The three stops on the journey to GCSE. The cards and the enquiry
  // letter's year-group mapping both lean on this one list.
  var STAGES = [
    {
      key: 'ks2', label: 'KS2', years: 'Years 3–6',
      topics: ['Times tables', 'Fractions & decimals', 'Mental arithmetic', 'Shape & measure', 'Word problems', 'SATs confidence']
    },
    {
      key: 'ks3', label: 'KS3', years: 'Years 7–9',
      topics: ['Algebra basics', 'Ratio & proportion', 'Angles & geometry', 'Percentages', 'Probability', 'Graphs & sequences']
    },
    {
      key: 'gcse', label: 'GCSE', years: 'Years 10–11 · Foundation & Higher',
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
  // in = same puzzle out — which is what lets the page show yesterday's
  // answer with no storage at all.

  var PUZZLE_MAKERS = [
    function thinkOfANumber(seed) {
      var n = randInt(seed + ':n', 3, 12);
      var a = randInt(seed + ':a', 2, 6);
      var b = randInt(seed + ':b', 1, 19);
      var r = n * a + b;
      return {
        topic: 'Algebra', emoji: '🤔',
        question: 'I’m thinking of a number. Multiply it by ' + a + ', add ' + b +
                  ', and you get ' + r + '. What’s my number?',
        answer: n,
        hint: 'Work backwards — undo the “add ' + b + '” first, then undo the “multiply by ' + a + '”.',
        explain: 'Backwards it goes: ' + r + ' − ' + b + ' = ' + (r - b) + ', and ' + (r - b) + ' ÷ ' + a + ' = ' + n + '.'
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
        hint: 'How big is the jump between each pair of neighbours?',
        explain: 'Each jump is +' + step + ', so after ' + terms[3] + ' comes ' + (start + 4 * step) + '.'
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
        hint: 'Divide by the bottom, times by the top.',
        explain: whole + ' ÷ ' + den + ' = ' + unit + ', and ' + unit + ' × ' + num + ' = ' + (num * unit) + '.'
      };
    },
    function saleDiscount(seed) {
      var pcts = [10, 20, 25, 50];
      var pct = pcts[randInt(seed + ':p', 0, pcts.length - 1)];
      // a multiple of 20 keeps the discounted price whole for every pct above
      var base = randInt(seed + ':b', 2, 15) * 20;
      var off = base * pct / 100;
      return {
        topic: 'Percentages', emoji: '🏷️',
        question: 'A £' + base + ' pair of trainers is ' + pct + '% off in the sale. What do they cost now, in pounds?',
        answer: base - off,
        hint: 'Find ' + pct + '% of £' + base + ' first, then take it away.',
        explain: pct + '% of £' + base + ' is £' + off + ', and £' + base + ' − £' + off + ' = £' + (base - off) + '.'
      };
    },
    function missingAngle(seed) {
      var a = randInt(seed + ':a', 25, 80);
      var b = randInt(seed + ':b', 25, 80);
      return {
        topic: 'Geometry', emoji: '📐',
        question: 'Two angles of a triangle are ' + a + '° and ' + b + '°. How many degrees is the third?',
        answer: 180 - a - b,
        hint: 'The three angles of any triangle add up to 180°.',
        explain: 'Angles in a triangle add to 180°, and 180 − ' + a + ' − ' + b + ' = ' + (180 - a - b) + '.'
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
        hint: 'Add them all up, then share equally between the four.',
        explain: 'They add up to ' + 4 * m + ', and ' + 4 * m + ' ÷ 4 = ' + m + '.'
      };
    },
    function areaOfRectangle(seed) {
      var w = randInt(seed + ':w', 3, 12);
      var h = randInt(seed + ':h', 3, 12);
      return {
        topic: 'Area', emoji: '⬜',
        question: 'A rectangle is ' + w + ' cm wide and ' + h + ' cm tall. What’s its area in cm²?',
        answer: w * h,
        hint: 'Area of a rectangle = width × height.',
        explain: 'Width × height: ' + w + ' × ' + h + ' = ' + (w * h) + ' cm².'
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
        hint: 'A prime has exactly two factors — itself and 1. Try dividing each by 3, 5 and 7.',
        explain: p + ' has no factors besides 1 and itself — every other number in the line divides by 3, 5 or 7.'
      };
    },
    function numberChain(seed) {
      var n = randInt(seed + ':n', 3, 30);
      var a = randInt(seed + ':a', 2, 15);
      return {
        topic: 'Chains', emoji: '⛓️',
        question: 'Start with ' + n + '. Double it, then add ' + a + '. What do you get?',
        answer: 2 * n + a,
        hint: 'One step at a time: double first, then add.',
        explain: 'Double ' + n + ' is ' + 2 * n + ', and ' + 2 * n + ' + ' + a + ' = ' + (2 * n + a) + '.'
      };
    },
    function moneyChange(seed) {
      var note = pickSeeded(seed + ':note', [10, 20]);
      var cost = randInt(seed + ':c', 1, note - 1);
      return {
        topic: 'Money', emoji: '💷',
        question: 'You pay for a £' + cost + ' comic with a £' + note + ' note. How much change do you get, in pounds?',
        answer: note - cost,
        hint: 'Count up from £' + cost + ' to £' + note + '.',
        explain: '£' + note + ' − £' + cost + ' = £' + (note - cost) + ' change.'
      };
    },
    function moneyCoins(seed) {
      var coin = pickSeeded(seed + ':coin', [2, 5, 10, 20, 50]);
      var pounds = randInt(seed + ':t', 1, 9);
      return {
        topic: 'Money', emoji: '🪙',
        question: 'How many ' + coin + 'p coins make £' + pounds + '?',
        answer: pounds * 100 / coin,
        hint: '£1 is 100p — how many ' + coin + 'p coins make 100p?',
        explain: '£' + pounds + ' is ' + pounds * 100 + 'p, and ' + pounds * 100 + ' ÷ ' + coin + ' = ' + (pounds * 100 / coin) + '.'
      };
    },
    function perimeterOfRectangle(seed) {
      var w = randInt(seed + ':w', 3, 15);
      var h = randInt(seed + ':h', 2, 12);
      return {
        topic: 'Perimeter', emoji: '🖼️',
        question: 'A rectangle is ' + w + ' cm wide and ' + h + ' cm tall. What is its perimeter in cm?',
        answer: 2 * (w + h),
        hint: 'The perimeter goes all the way round — two widths and two heights.',
        explain: w + ' + ' + h + ' + ' + w + ' + ' + h + ' = ' + 2 * (w + h) + ' cm all the way round.'
      };
    },
    function sequenceDown(seed) {
      var step = randInt(seed + ':d', 3, 9);
      var start = 4 * step + 1 + randInt(seed + ':s', 0, 40);
      var terms = [start, start - step, start - 2 * step, start - 3 * step];
      return {
        topic: 'Sequences', emoji: '🪜',
        question: 'What comes next: ' + terms.join(', ') + ', … ?',
        answer: start - 4 * step,
        hint: 'The numbers are falling — by how much each time?',
        explain: 'Each step is −' + step + ', so after ' + terms[3] + ' comes ' + (start - 4 * step) + '.'
      };
    },
    function doublingPattern(seed) {
      var r = pickSeeded(seed + ':r', [2, 3]);
      var start = randInt(seed + ':s', 1, 5);
      var terms = [start, start * r, start * r * r, start * r * r * r];
      return {
        topic: 'Patterns', emoji: '🌱',
        question: 'What comes next: ' + terms.join(', ') + ', … ?',
        answer: terms[3] * r,
        hint: 'It isn’t adding this time — each number is multiplied by the same thing.',
        explain: 'Each term is ×' + r + ', so after ' + terms[3] + ' comes ' + terms[3] * r + '.'
      };
    },
    function nthSquare(seed) {
      var n = randInt(seed + ':n', 3, 12);
      var ord = n === 3 ? '3rd' : n + 'th';
      return {
        topic: 'Square numbers', emoji: '🔲',
        question: 'What is the ' + ord + ' square number?',
        answer: n * n,
        hint: 'A square number is a number times itself.',
        explain: n + ' × ' + n + ' = ' + n * n + '.'
      };
    },
    function smallCube(seed) {
      var c = randInt(seed + ':c', 2, 6);
      return {
        topic: 'Cubes', emoji: '🧊',
        question: 'What is ' + c + ' cubed?',
        answer: c * c * c,
        hint: 'Cubed means times itself, then times itself again.',
        explain: c + ' × ' + c + ' × ' + c + ' = ' + c * c * c + '.'
      };
    },
    function straightLineAngle(seed) {
      var a = randInt(seed + ':a', 25, 155);
      return {
        topic: 'Angles', emoji: '📏',
        question: 'Two angles sit together on a straight line. One is ' + a + '°. How big is the other?',
        answer: 180 - a,
        hint: 'Angles on a straight line add up to 180°.',
        explain: '180 − ' + a + ' = ' + (180 - a) + '°.'
      };
    },
    function nthMultiple(seed) {
      var k = randInt(seed + ':k', 3, 9);
      var m = randInt(seed + ':m', 4, 12);
      var ord = k === 3 ? '3rd' : k + 'th';
      return {
        topic: 'Multiples', emoji: '🎯',
        question: 'What is the ' + ord + ' multiple of ' + m + '?',
        answer: k * m,
        hint: 'Count up in ' + m + 's, ' + k + ' times.',
        explain: k + ' × ' + m + ' = ' + k * m + '.'
      };
    },
    function countFactors(seed) {
      var n = pickSeeded(seed + ':n', [12, 16, 18, 20, 24, 28, 30, 36]);
      var count = 0;
      for (var i = 1; i <= n; i++) if (n % i === 0) count++;
      return {
        topic: 'Factors', emoji: '🧩',
        question: 'How many factors does ' + n + ' have?',
        answer: count,
        hint: 'Hunt in pairs: 1 and ' + n + ', 2 and ' + (n / 2) + '…',
        explain: 'The factors of ' + n + ' pair up neatly — there are ' + count + ' of them, counting 1 and ' + n + ' itself.'
      };
    },
    function temperatureDrop(seed) {
      var a = randInt(seed + ':a', 1, 8);
      var b = randInt(seed + ':b', a + 2, a + 15);
      return {
        topic: 'Negative numbers', emoji: '🥶',
        question: 'The temperature is ' + a + '° and it drops by ' + b + '°. What is it now, in degrees?',
        answer: a - b,
        hint: 'It falls straight past zero — keep counting down.',
        explain: a + ' − ' + b + ' = ' + (a - b) + '°. Brrr.'
      };
    },
    function orderOfOperations(seed) {
      var a = randInt(seed + ':a', 2, 12);
      var b = randInt(seed + ':b', 2, 9);
      var c = randInt(seed + ':c', 2, 9);
      return {
        topic: 'Order of operations', emoji: '🚦',
        question: 'What is ' + a + ' + ' + b + ' × ' + c + '?',
        answer: a + b * c,
        hint: 'Multiplication goes first — no matter where it sits.',
        explain: b + ' × ' + c + ' = ' + b * c + ' first, then ' + a + ' + ' + b * c + ' = ' + (a + b * c) + '.'
      };
    },
    function roundToTen(seed) {
      var n = randInt(seed + ':n', 101, 989);
      return {
        topic: 'Rounding', emoji: '🎢',
        question: 'Round ' + n + ' to the nearest 10.',
        answer: Math.round(n / 10) * 10,
        hint: 'Look at the ones digit — 5 or more rounds up.',
        explain: 'The ones digit is ' + (n % 10) + ', so ' + n + ' rounds to ' + Math.round(n / 10) * 10 + '.'
      };
    },
    function placeValue(seed) {
      var n = randInt(seed + ':n', 1000, 9999);
      return {
        topic: 'Place value', emoji: '🏛️',
        question: 'In the number ' + n + ', which digit is in the tens place?',
        answer: Math.floor(n / 10) % 10,
        hint: 'Ones on the right, then tens just to their left.',
        explain: 'Reading from the right: ones, then tens — the tens digit of ' + n + ' is ' + (Math.floor(n / 10) % 10) + '.'
      };
    },
    function missingAddend(seed) {
      var a = randInt(seed + ':a', 12, 78);
      var c = a + randInt(seed + ':d', 5, 60);
      return {
        topic: 'Missing number', emoji: '🔍',
        question: 'What number added to ' + a + ' makes ' + c + '?',
        answer: c - a,
        hint: 'Take ' + a + ' away from ' + c + '.',
        explain: c + ' − ' + a + ' = ' + (c - a) + '.'
      };
    },
    function missingFactor(seed) {
      var a = randInt(seed + ':a', 3, 12);
      var b = randInt(seed + ':b', 3, 12);
      return {
        topic: 'Missing number', emoji: '🔍',
        question: 'What number times ' + a + ' makes ' + a * b + '?',
        answer: b,
        hint: 'Divide ' + a * b + ' by ' + a + '.',
        explain: a * b + ' ÷ ' + a + ' = ' + b + '.'
      };
    },
    function timeUnits(seed) {
      if (rand01(seed + ':t') < 0.5) {
        var w = randInt(seed + ':w', 2, 9);
        return {
          topic: 'Time', emoji: '📅',
          question: 'How many days are there in ' + w + ' weeks?',
          answer: 7 * w,
          hint: 'A week is 7 days.',
          explain: w + ' × 7 = ' + 7 * w + ' days.'
        };
      }
      var h = randInt(seed + ':h', 2, 9);
      return {
        topic: 'Time', emoji: '⏰',
        question: 'How many minutes are there in ' + h + ' hours?',
        answer: 60 * h,
        hint: 'An hour is 60 minutes.',
        explain: h + ' × 60 = ' + 60 * h + ' minutes.'
      };
    },
    function shareEqually(seed) {
      var d = randInt(seed + ':d', 3, 8);
      var each = randInt(seed + ':e', 3, 12);
      return {
        topic: 'Division', emoji: '🍓',
        question: d + ' children share ' + d * each + ' strawberries equally. How many does each child get?',
        answer: each,
        hint: 'Share them out one at a time — or divide.',
        explain: d * each + ' ÷ ' + d + ' = ' + each + ' each.'
      };
    },
    function doubleIt(seed) {
      var n = randInt(seed + ':n', 13, 98);
      return {
        topic: 'Doubling', emoji: '👯',
        question: 'What is double ' + n + '?',
        answer: 2 * n,
        hint: 'Double the tens, double the ones, put them back together.',
        explain: 'Double ' + Math.floor(n / 10) * 10 + ' is ' + Math.floor(n / 10) * 20 +
          ' and double ' + (n % 10) + ' is ' + (n % 10) * 2 + ' — together, ' + 2 * n + '.'
      };
    },
    function halveIt(seed) {
      var n = 2 * randInt(seed + ':n', 12, 99);
      return {
        topic: 'Halving', emoji: '🔪',
        question: 'What is half of ' + n + '?',
        answer: n / 2,
        hint: 'Split it into two equal pieces.',
        explain: n + ' ÷ 2 = ' + n / 2 + '.'
      };
    },
    function ratioShare(seed) {
      var pair = pickSeeded(seed + ':p', [[1, 2], [1, 3], [2, 3], [1, 4], [3, 4], [2, 5]]);
      var a = pair[0], b = pair[1];
      var u = randInt(seed + ':u', 2, 9);
      var s = (a + b) * u;
      return {
        topic: 'Ratio', emoji: '⚖️',
        question: 'Share ' + s + ' sweets between two friends in the ratio ' + a + ' : ' + b + '. How many does the friend with more get?',
        answer: b * u,
        hint: 'The ratio has ' + (a + b) + ' parts in total — how big is one part?',
        explain: s + ' ÷ ' + (a + b) + ' = ' + u + ' per part, and ' + b + ' parts is ' + b * u + '.'
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
             question: p.question, answer: p.answer, hint: p.hint, explain: p.explain };
  }

  // Forgiving marking: "12", " 12 ", "12.0", "£12" and "12°" all count.
  function checkAnswer(expected, guess) {
    var g = String(guess == null ? '' : guess).trim().replace(/[£$°,\s]/g, '');
    if (!g || !/^-?\d+(\.\d+)?$/.test(g)) return false;
    return Math.abs(parseFloat(g) - expected) < 1e-9;
  }

  /* ---------------- the sprint: sixty seconds of quick-fire maths ---------------- */
  // Questions climb in difficulty with the streak, shaped by the chosen
  // mode. Every question is generated from (level, seed) so a round can
  // be replayed move-for-move in tests, and every answer is a whole
  // number so typing stays fast on a phone.

  function sprintLevelFor(streak) {
    if (streak < 4) return 1;
    if (streak < 8) return 2;
    if (streak < 12) return 3;
    return 4;
  }

  // The three chips above the game. gentle stays in tables territory,
  // classic climbs the whole ladder, spicy starts hot and gets hotter.
  var SPRINT_MODES = [
    { key: 'gentle',  label: 'Gently does it', hint: 'Times tables, adding and sharing — stays easy' },
    { key: 'classic', label: 'The full ladder', hint: 'Starts easy, climbs as you streak' },
    { key: 'spicy',   label: 'Straight to spicy', hint: 'Squares, fractions and a little algebra' }
  ];

  function sprintLevelForMode(mode, streak) {
    var base = sprintLevelFor(streak);
    if (mode === 'gentle') return Math.min(base, 2);
    if (mode === 'spicy') return Math.max(base, 3);
    return base;
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
  // GCSE maths papers land in mid-May to mid-June each year. The page's
  // CONFIG can pin the exact first-exam date; when it doesn't,
  // defaultExamStart aims at the season and rolls over once it has passed.
  var SEASON_MONTH = 4;   // May (0-indexed)
  var SEASON_DAY = 12;    // papers typically begin around here
  var SEASON_LENGTH_DAYS = 35;

  function defaultExamStart(now) {
    var y = new Date(now).getUTCFullYear();
    var start = Date.UTC(y, SEASON_MONTH, SEASON_DAY, 9, 0, 0);
    if (now >= start + SEASON_LENGTH_DAYS * DAY) start = Date.UTC(y + 1, SEASON_MONTH, SEASON_DAY, 9, 0, 0);
    return start;
  }

  // Days/hours/minutes/seconds until a target moment. Never negative:
  // once the target passes, phase flips to 'underway' and the figures
  // freeze at zero for the page to swap in its good-luck copy.
  function countdown(now, target) {
    var left = target - now;
    if (!(isFinite(left)) || left <= 0) {
      return { phase: 'underway', days: 0, hours: 0, minutes: 0, seconds: 0 };
    }
    return {
      phase: 'counting',
      days: Math.floor(left / DAY),
      hours: Math.floor((left % DAY) / HOUR),
      minutes: Math.floor((left % HOUR) / MINUTE),
      seconds: Math.floor((left % MINUTE) / SECOND)
    };
  }

  /* ---------------- the enquiry letter ---------------- */
  // The form has no email field: sending opens the parent's own mail app,
  // so the message arrives from their real address. Pure validation and
  // letter composition here; Maryam's address comes from index.html's
  // CONFIG, passed in.
  var MAX_NAME = 60, MAX_MESSAGE = 600;
  var YEARS = ['Year 3', 'Year 4', 'Year 5', 'Year 6', 'Year 7', 'Year 8',
               'Year 9', 'Year 10', 'Year 11', 'notsure'];
  var MODES = ['inperson', 'online', 'notsure'];
  var MODE_PHRASES = {
    inperson: 'in person',
    online: 'online',
    notsure: 'format TBC'
  };
  // Full sentence endings for the letter — the parent's voice, so no whimsy.
  var MODE_SENTENCES = {
    inperson: 'in person if possible',
    online: 'online if possible',
    notsure: 'in person or online — whichever works best'
  };
  var MODE_LABELS = {
    inperson: 'In person — South West London',
    online: 'Online',
    notsure: 'Not sure yet'
  };

  // 'Year 3'..'Year 6' → ks2, 7–9 → ks3, 10–11 → gcse.
  function yearToStage(year) {
    var m = /^Year (\d+)$/.exec(String(year || ''));
    if (!m) return null;
    var n = +m[1];
    if (n >= 3 && n <= 6) return stageByKey('ks2');
    if (n >= 7 && n <= 9) return stageByKey('ks3');
    if (n >= 10 && n <= 11) return stageByKey('gcse');
    return null;
  }

  function cleanEnquiry(e) {
    e = e || {};
    return {
      name: String(e.name == null ? '' : e.name).trim(),
      year: String(e.year == null ? '' : e.year),
      mode: MODES.indexOf(e.mode) !== -1 ? e.mode : 'notsure',
      message: String(e.message == null ? '' : e.message).trim()
    };
  }

  // Proofreader's marks: one kindly margin note per field that needs one.
  function validateEnquiry(e) {
    var v = cleanEnquiry(e);
    var notes = {};
    if (!v.name) notes.name = 'Pencil in your name, so I know who’s writing.';
    else if (v.name.length > MAX_NAME) notes.name = 'A shorter name, please — ' + MAX_NAME + ' characters is plenty.';
    if (YEARS.indexOf(v.year) === -1) notes.year = 'Which year group? “Not sure” is a perfectly good answer.';
    if (!v.message) notes.message = 'A line or two about your child helps me reply properly.';
    else if (v.message.length > MAX_MESSAGE) notes.message = 'Keep it under ' + MAX_MESSAGE + ' characters (' + v.message.length + ' now).';
    var ok = true;
    for (var k in notes) { ok = false; break; }
    return { ok: ok, notes: notes, cleaned: v };
  }

  // The live letter: real values where the parent has written them,
  // marked gaps where they haven't. The page draws gaps as marigold
  // blanks; the same text (gap-free) becomes the email body.
  var GAP = '____';

  function draftLetter(e) {
    var v = cleanEnquiry(e);
    var gaps = [];
    var name = v.name;
    if (!name) { name = GAP; gaps.push('name'); }
    var year = v.year;
    if (YEARS.indexOf(year) === -1) { year = GAP; gaps.push('year'); }
    else if (year === 'notsure') year = 'a year group I’m not sure of yet';
    var message = v.message;
    if (!message) { message = GAP; gaps.push('message'); }
    var text = 'Dear Maryam,\n\n' +
      'My name is ' + name + '. I’m looking for maths help for my child in ' + year +
      ' — ' + MODE_SENTENCES[v.mode] + '.\n\n' +
      'Here’s what’s going on: ' + message + '\n\n' +
      'Speak soon,\n' + name;
    return { text: text, gaps: gaps };
  }

  function composeEnquiry(e, toEmail) {
    var v = cleanEnquiry(e);
    var stage = yearToStage(v.year);
    var yearBit = v.year === 'notsure' || YEARS.indexOf(v.year) === -1
      ? 'year group TBC'
      : v.year + (stage ? ' (' + stage.label + ')' : '');
    var subject = 'Maths tutoring enquiry — ' + yearBit + ', ' +
      (v.mode === 'notsure' ? 'format TBC' : MODE_PHRASES[v.mode]);
    var body = draftLetter(v).text;
    return {
      subject: subject,
      body: body,
      mailto: 'mailto:' + String(toEmail || '') +
              '?subject=' + encodeURIComponent(subject) +
              '&body=' + encodeURIComponent(body)
    };
  }

  /* ---------------- confetti, deterministically ---------------- */
  // Operator glyphs raining in ink and cream. The page just paints these;
  // physics parameters come from here so even the celebration is
  // testable. Angles in radians, speeds in px/frame.
  var GLYPHS = ['+', '×', '÷', '='];

  function confettiBurst(seed, n) {
    n = n || 24;
    var out = [];
    for (var i = 0; i < n; i++) {
      var s = 'maryam-confetti:' + String(seed) + ':' + i;
      var angle = -Math.PI / 2 + (rand01(s + ':a') - 0.5) * Math.PI * 0.9;
      var speed = 4 + rand01(s + ':v') * 7;
      var gi = Math.floor(rand01(s + ':g') * GLYPHS.length);
      out.push({
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        glyphIndex: gi,
        glyph: GLYPHS[gi],
        size: 10 + rand01(s + ':s') * 12,
        spin: (rand01(s + ':r') - 0.5) * 0.6,
        drift: (rand01(s + ':d') - 0.5) * 0.4
      });
    }
    return out;
  }

  /* ---------------- exports ---------------- */
  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    STAGES: STAGES, FACTS: FACTS, RANKS: RANKS, GLYPHS: GLYPHS,
    SPRINT_MODES: SPRINT_MODES, YEARS: YEARS, MODES: MODES,
    MODE_LABELS: MODE_LABELS, MODE_PHRASES: MODE_PHRASES, MODE_SENTENCES: MODE_SENTENCES,
    MAX_NAME: MAX_NAME, MAX_MESSAGE: MAX_MESSAGE, GAP: GAP,
    hashStr: hashStr, rand01: rand01, randInt: randInt, pickSeeded: pickSeeded,
    escapeHTML: escapeHTML, plural: plural, isoDate: isoDate,
    issueNumber: issueNumber, coverDate: coverDate,
    stageByKey: stageByKey, factOfDay: factOfDay,
    dailyPuzzle: dailyPuzzle, checkAnswer: checkAnswer, isPrime: isPrime,
    sprintLevelFor: sprintLevelFor, sprintLevelForMode: sprintLevelForMode,
    sprintQuestion: sprintQuestion, sprintPoints: sprintPoints, sprintRank: sprintRank,
    defaultExamStart: defaultExamStart, countdown: countdown,
    yearToStage: yearToStage, validateEnquiry: validateEnquiry,
    draftLetter: draftLetter, composeEnquiry: composeEnquiry,
    confettiBurst: confettiBurst
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.MaryamEngine = E;
})(typeof self !== 'undefined' ? self : this);

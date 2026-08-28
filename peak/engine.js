/* Peak — the pure human-performance engine.
 * =====================================================================
 * Peak is the answer to "design the ultimate app": the app whose job is
 * to upgrade its user. Three pillars — MOVE (train), FUEL (eat), REST
 * (sleep) — collapse into one honest daily Peak score. Every rule lives
 * HERE as pure, deterministic, clock-injected functions with zero DOM
 * and zero I/O: metabolism math (Mifflin-St Jeor BMR → TDEE → goal
 * calories → macro targets), strength science (Epley 1RM, double
 * progression, barbell plate math), a deterministic workout-split
 * generator, sleep-cycle bedtime math, and the score/streak/level loop.
 * Unit-tested in scripts/test-peak-logic.mjs, rendered by index.html.
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

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round1(v) { return Math.round(v * 10) / 10; }

  /* ---------------- the day (clock-injected, timezone-aware) ---------------- */
  // Every daily rule keys off a local calendar date. `now` is epoch ms,
  // `tzMin` is minutes east of UTC (the UI passes -new Date().getTimezoneOffset()).

  function dayKey(now, tzMin) {
    var d = new Date(now + (tzMin || 0) * MINUTE);
    var m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  function prevDayKey(key) {
    var p = String(key).split('-');
    var t = Date.UTC(+p[0], +p[1] - 1, +p[2]) - DAY;
    return dayKey(t, 0);
  }

  /* ---------------- profile & metabolism ---------------- */

  var ACTIVITY = {
    sedentary: { mult: 1.2,   label: 'Desk-bound' },
    light:     { mult: 1.375, label: 'Light (1–3 sessions/wk)' },
    moderate:  { mult: 1.55,  label: 'Moderate (3–5 sessions/wk)' },
    active:    { mult: 1.725, label: 'Active (6–7 sessions/wk)' },
    athlete:   { mult: 1.9,   label: 'Athlete (2-a-days)' }
  };
  var GOALS = {
    cut:      { pct: -0.20, proteinPerKg: 2.0, label: 'Lose fat' },
    maintain: { pct: 0,     proteinPerKg: 1.6, label: 'Maintain' },
    build:    { pct: 0.10,  proteinPerKg: 1.8, label: 'Build muscle' }
  };

  function validateProfile(p) {
    p = p || {};
    var errors = [];
    var sex = p.sex === 'female' ? 'female' : p.sex === 'male' ? 'male' : null;
    var age = Math.round(Number(p.age)), cm = Number(p.heightCm), kg = Number(p.weightKg);
    if (!sex) errors.push('Pick a body type — it sets the metabolism formula.');
    if (!isFinite(age) || age < 13 || age > 100) errors.push('Age: 13–100.');
    if (!isFinite(cm) || cm < 120 || cm > 230) errors.push('Height: 120–230 cm.');
    if (!isFinite(kg) || kg < 30 || kg > 300) errors.push('Weight: 30–300 kg.');
    if (!ACTIVITY[p.activity]) errors.push('Pick an activity level.');
    if (!GOALS[p.goal]) errors.push('Pick a goal.');
    if (errors.length) return { ok: false, errors: errors };
    return { ok: true, sex: sex, age: age, heightCm: cm, weightKg: kg, activity: p.activity, goal: p.goal };
  }

  // Mifflin-St Jeor — the clinically preferred resting-energy formula.
  function bmr(profile) {
    var base = 10 * profile.weightKg + 6.25 * profile.heightCm - 5 * profile.age;
    return Math.round(base + (profile.sex === 'male' ? 5 : -161));
  }

  function tdee(profile) {
    return Math.round(bmr(profile) * ACTIVITY[profile.activity].mult);
  }

  // Goal calories, clamped so a cut can never go dangerously low.
  function calorieTarget(profile) {
    var t = tdee(profile) * (1 + GOALS[profile.goal].pct);
    var floor = profile.sex === 'male' ? 1500 : 1200;
    return Math.max(floor, Math.round(t));
  }

  // Protein by g/kg (goal-dependent), fat at 25% of calories, carbs fill the rest.
  function macroTargets(profile) {
    var kcal = calorieTarget(profile);
    var protein = Math.round(GOALS[profile.goal].proteinPerKg * profile.weightKg);
    var fat = Math.round(kcal * 0.25 / 9);
    var carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));
    return { kcal: kcal, protein: protein, fat: fat, carbs: carbs };
  }

  // 35 ml per kg, rounded to the nearest 100 ml, kept in a sane band.
  function hydrationTarget(profile) {
    return clamp(Math.round(profile.weightKg * 35 / 100) * 100, 1500, 4000);
  }

  /* ---------------- strength: 1RM, progression, plate math ---------------- */

  // Epley estimate; at 1 rep the lift IS the max. Reps clamped to the
  // range where rep-max formulas mean anything.
  function oneRepMax(weightKg, reps) {
    var w = Number(weightKg), r = Math.round(Number(reps));
    if (!isFinite(w) || w <= 0 || !isFinite(r) || r < 1) return 0;
    r = Math.min(r, 12);
    if (r === 1) return round1(w);
    return round1(w * (1 + r / 30));
  }

  // What loads each training % maps to — the strength-programming table.
  function trainingLoads(orm) {
    return [95, 90, 85, 80, 75, 70, 65, 60].map(function (pct) {
      return { pct: pct, kg: round1(orm * pct / 100) };
    });
  }

  // Greedy per-side barbell loading. Returns the closest achievable load
  // at or below target, and the plates for ONE side.
  var DEFAULT_PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];
  function plateMath(targetKg, barKg, plates) {
    var bar = isFinite(Number(barKg)) && Number(barKg) > 0 ? Number(barKg) : 20;
    var avail = (plates && plates.length ? plates.slice() : DEFAULT_PLATES.slice())
      .map(Number).filter(function (p) { return isFinite(p) && p > 0; })
      .sort(function (a, b) { return b - a; });
    var target = Number(targetKg);
    if (!isFinite(target) || target < bar) return { ok: false, reason: 'Target is below the bar (' + bar + ' kg).' };
    var perSide = (target - bar) / 2;
    var side = [], remaining = perSide;
    for (var i = 0; i < avail.length; i++) {
      while (remaining >= avail[i] - 1e-9) { side.push(avail[i]); remaining = Math.round((remaining - avail[i]) * 1000) / 1000; }
    }
    var achieved = round1(bar + 2 * side.reduce(function (a, b) { return a + b; }, 0));
    return { ok: true, barKg: bar, perSide: side, achievedKg: achieved, shortKg: round1(target - achieved) };
  }

  // Double progression — the simplest overload rule that actually works.
  // Sets live in an 8–12 rep window: every set at the top → weight up
  // 2.5 kg, reps reset; any set under the bottom → deload 10%; otherwise
  // same weight, chase reps.
  var REP_LOW = 8, REP_HIGH = 12, STEP_KG = 2.5;
  function nextSession(last) {
    last = last || {};
    var w = Number(last.weightKg), reps = (last.reps || []).map(Number);
    if (!isFinite(w) || w <= 0 || !reps.length) {
      return { weightKg: 20, targetReps: REP_LOW, note: 'First session — start light, learn the movement.' };
    }
    var allTop = reps.every(function (r) { return r >= REP_HIGH; });
    var anyFail = reps.some(function (r) { return r < REP_LOW; });
    if (allTop) return { weightKg: round1(w + STEP_KG), targetReps: REP_LOW, note: 'Every set hit ' + REP_HIGH + ' — load goes up.' };
    if (anyFail) return { weightKg: round1(Math.max(20, w * 0.9)), targetReps: REP_LOW, note: 'A set fell under ' + REP_LOW + ' — deload 10% and rebuild.' };
    var best = Math.max.apply(null, reps);
    return { weightKg: w, targetReps: Math.min(REP_HIGH, best + 1), note: 'Same load — add a rep.' };
  }

  /* ---------------- the workout generator ---------------- */
  // A deterministic split for any (days/week, equipment) pair: same seed,
  // same plan — so tests can pin it and users can trust it not to churn.

  var EXERCISES = [
    { name: 'Squat',              group: 'legs',  equip: ['gym'] },
    { name: 'Goblet squat',       group: 'legs',  equip: ['dumbbells'] },
    { name: 'Split squat',        group: 'legs',  equip: ['dumbbells', 'bodyweight'] },
    { name: 'Romanian deadlift',  group: 'legs',  equip: ['gym', 'dumbbells'] },
    { name: 'Glute bridge',       group: 'legs',  equip: ['bodyweight'] },
    { name: 'Bench press',        group: 'push',  equip: ['gym'] },
    { name: 'DB bench press',     group: 'push',  equip: ['dumbbells'] },
    { name: 'Push-up',            group: 'push',  equip: ['bodyweight'] },
    { name: 'Overhead press',     group: 'push',  equip: ['gym', 'dumbbells'] },
    { name: 'Pike push-up',       group: 'push',  equip: ['bodyweight'] },
    { name: 'Deadlift',           group: 'pull',  equip: ['gym'] },
    { name: 'Barbell row',        group: 'pull',  equip: ['gym'] },
    { name: 'DB row',             group: 'pull',  equip: ['dumbbells'] },
    { name: 'Pull-up',            group: 'pull',  equip: ['gym', 'bodyweight'] },
    { name: 'Inverted row',       group: 'pull',  equip: ['bodyweight'] },
    { name: 'Plank',              group: 'core',  equip: ['gym', 'dumbbells', 'bodyweight'] },
    { name: 'Hanging leg raise',  group: 'core',  equip: ['gym'] },
    { name: 'Dead bug',           group: 'core',  equip: ['dumbbells', 'bodyweight'] }
  ];

  var SPLITS = {
    2: [['full'], ['full']],
    3: [['full'], ['full'], ['full']],
    4: [['upper'], ['lower'], ['upper'], ['lower']],
    5: [['push'], ['pull'], ['legs'], ['upper'], ['lower']],
    6: [['push'], ['pull'], ['legs'], ['push'], ['pull'], ['legs']]
  };
  var DAY_GROUPS = {
    full: ['legs', 'push', 'pull', 'core'],
    upper: ['push', 'pull', 'push', 'core'],
    lower: ['legs', 'legs', 'core'],
    push: ['push', 'push', 'core'],
    pull: ['pull', 'pull', 'core'],
    legs: ['legs', 'legs', 'core']
  };

  function pickExercise(group, equipment, seed, used) {
    var pool = EXERCISES.filter(function (e) {
      return e.group === group && e.equip.indexOf(equipment) !== -1 && used.indexOf(e.name) === -1;
    });
    if (!pool.length) {
      pool = EXERCISES.filter(function (e) { return e.group === group && e.equip.indexOf(equipment) !== -1; });
    }
    if (!pool.length) return null;
    return pool[Math.floor(rand01(seed) * pool.length)];
  }

  function workoutPlan(daysPerWeek, equipment, seed) {
    var days = SPLITS[clamp(Math.round(Number(daysPerWeek) || 3), 2, 6)] || SPLITS[3];
    equipment = ['gym', 'dumbbells', 'bodyweight'].indexOf(equipment) !== -1 ? equipment : 'bodyweight';
    seed = String(seed == null ? 'peak' : seed);
    return days.map(function (kindArr, di) {
      var kind = kindArr[0];
      var used = [];
      var exercises = DAY_GROUPS[kind].map(function (group, gi) {
        var ex = pickExercise(group, equipment, seed + ':' + di + ':' + gi + ':' + group, used);
        if (ex) used.push(ex.name);
        return ex && { name: ex.name, group: ex.group, sets: group === 'core' ? 3 : 3, reps: group === 'core' ? '30–60s' : REP_LOW + '–' + REP_HIGH };
      }).filter(Boolean);
      return { day: di + 1, kind: kind, exercises: exercises };
    });
  }

  /* ---------------- fuel: the food log ---------------- */

  var FOODS = [
    { name: 'Chicken breast (100g)', kcal: 165, protein: 31, carbs: 0,  fat: 3.6 },
    { name: 'Salmon fillet (100g)',  kcal: 208, protein: 20, carbs: 0,  fat: 13 },
    { name: 'Eggs (2 large)',        kcal: 156, protein: 13, carbs: 1,  fat: 11 },
    { name: 'Greek yogurt (170g)',   kcal: 100, protein: 17, carbs: 6,  fat: 0.7 },
    { name: 'Rice, cooked (200g)',   kcal: 260, protein: 5,  carbs: 56, fat: 0.6 },
    { name: 'Oats (50g dry)',        kcal: 190, protein: 6.5, carbs: 33, fat: 3.5 },
    { name: 'Banana',                kcal: 105, protein: 1.3, carbs: 27, fat: 0.4 },
    { name: 'Apple',                 kcal: 95,  protein: 0.5, carbs: 25, fat: 0.3 },
    { name: 'Whey scoop (30g)',      kcal: 120, protein: 24, carbs: 3,  fat: 1.5 },
    { name: 'Peanut butter (32g)',   kcal: 190, protein: 8,  carbs: 7,  fat: 16 },
    { name: 'Wholemeal bread (2 sl)', kcal: 180, protein: 8, carbs: 30, fat: 2.5 },
    { name: 'Avocado (half)',        kcal: 120, protein: 1.5, carbs: 6, fat: 11 },
    { name: 'Lentils, cooked (200g)', kcal: 230, protein: 18, carbs: 40, fat: 0.8 },
    { name: 'Olive oil (1 tbsp)',    kcal: 119, protein: 0,  carbs: 0,  fat: 13.5 },
    { name: 'Mixed salad bowl',      kcal: 60,  protein: 2,  carbs: 8,  fat: 2 },
    { name: 'Beef mince 5% (125g)',  kcal: 170, protein: 26, carbs: 0,  fat: 6.5 },
    { name: 'Pasta, cooked (200g)',  kcal: 310, protein: 11, carbs: 62, fat: 1.8 },
    { name: 'Milk (250ml)',          kcal: 122, protein: 8,  carbs: 12, fat: 4.8 },
    { name: 'Almonds (28g)',         kcal: 164, protein: 6,  carbs: 6,  fat: 14 },
    { name: 'Dark chocolate (25g)',  kcal: 150, protein: 1.9, carbs: 11, fat: 11 }
  ];

  function searchFoods(query) {
    var q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return FOODS.slice(0, 8);
    return FOODS.filter(function (f) { return f.name.toLowerCase().indexOf(q) !== -1; });
  }

  function logTotals(entries) {
    var t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    (entries || []).forEach(function (e) {
      t.kcal += Number(e.kcal) || 0;
      t.protein += Number(e.protein) || 0;
      t.carbs += Number(e.carbs) || 0;
      t.fat += Number(e.fat) || 0;
    });
    return { kcal: Math.round(t.kcal), protein: round1(t.protein), carbs: round1(t.carbs), fat: round1(t.fat) };
  }

  function fuelState(totals, targets) {
    var kcal = totals.kcal || 0;
    return {
      remainingKcal: Math.round(targets.kcal - kcal),
      pctKcal: clamp(Math.round(kcal / targets.kcal * 100), 0, 999),
      pctProtein: clamp(Math.round((totals.protein || 0) / targets.protein * 100), 0, 999),
      over: kcal > targets.kcal
    };
  }

  /* ---------------- rest: sleep cycles & bedtime math ---------------- */

  var CYCLE_MIN = 90, FALL_ASLEEP_MIN = 15;

  function sleepStats(bedTs, wakeTs) {
    var ms = wakeTs - bedTs;
    if (!isFinite(ms) || ms <= 0 || ms > 24 * HOUR) return { ok: false, reason: 'Those times don’t make a night.' };
    var asleepMin = Math.max(0, ms / MINUTE - FALL_ASLEEP_MIN);
    var hours = round1(asleepMin / 60);
    var cycles = Math.floor(asleepMin / CYCLE_MIN);
    var label = hours >= 7 && hours <= 9 ? 'In the 7–9h zone' : hours < 7 ? 'Short night' : 'Long night';
    return { ok: true, hours: hours, cycles: cycles, label: label };
  }

  // Count back whole 90-minute cycles (+15 min to fall asleep) from the
  // alarm: waking between cycles is what makes a morning feel human.
  function bedtimesFor(wakeTs) {
    return [6, 5, 4].map(function (cycles) {
      var ts = wakeTs - cycles * CYCLE_MIN * MINUTE - FALL_ASLEEP_MIN * MINUTE;
      return { cycles: cycles, hours: round1(cycles * CYCLE_MIN / 60), ts: ts };
    });
  }

  function sleepDebt(nightHours, targetH) {
    var target = isFinite(Number(targetH)) && Number(targetH) > 0 ? Number(targetH) : 8;
    var debt = 0;
    (nightHours || []).forEach(function (h) { debt += Math.max(0, target - (Number(h) || 0)); });
    return round1(debt);
  }

  /* ---------------- the Peak score: one honest number per day ---------------- */
  // MOVE 40 (training done, or partial via steps) + FUEL 30 (calories in
  // the band + protein hit) + REST 30 (hours vs the 7–9h zone). Water is
  // a 5-point bonus but the score caps at 100 — an elite day is 100, not 105.

  function peakScore(day) {
    day = day || {};
    var move = day.trained ? 40 : clamp(Math.round((Number(day.steps) || 0) / (Number(day.stepTarget) || 8000) * 25), 0, 25);

    var fuel = 0;
    var t = day.fuelTargets;
    if (t && t.kcal > 0) {
      var kcal = Number(day.kcal) || 0;
      var dev = Math.abs(kcal - t.kcal) / t.kcal;          // distance from target
      if (kcal > 0) fuel += dev <= 0.05 ? 18 : dev <= 0.15 ? 12 : dev <= 0.30 ? 6 : 0;
      var prot = Number(day.protein) || 0;
      fuel += clamp(Math.round(prot / t.protein * 12), 0, 12);
    }

    var rest = 0;
    var h = Number(day.sleepHours) || 0;
    if (h > 0) {
      if (h >= 7 && h <= 9) rest = 30;
      else if (h >= 6 && h < 7) rest = 20;
      else if (h > 9 && h <= 10) rest = 22;
      else if (h >= 5) rest = 10;
      else rest = 4;
    }

    var water = (Number(day.waterMl) || 0) >= (Number(day.waterTarget) || 2000) ? 5 : 0;
    var total = clamp(move + fuel + rest + water, 0, 100);
    return { total: total, move: move, fuel: fuel, rest: rest, waterBonus: water };
  }

  function scoreLabel(total) {
    if (total >= 85) return 'Peak day';
    if (total >= 60) return 'Solid day';
    if (total >= 35) return 'Building';
    return 'Rest & reset';
  }

  /* ---------------- streaks, XP, levels ---------------- */

  // A streak day is any day scoring ≥ 60. Walk back from today (today
  // itself counts only once it crosses the bar — an unfinished today
  // doesn't break the chain).
  function streak(scoresByDay, todayKey) {
    var n = 0, key = todayKey;
    if ((scoresByDay[key] || 0) >= 60) { n++; }
    key = prevDayKey(key);
    while ((scoresByDay[key] || 0) >= 60) { n++; key = prevDayKey(key); }
    return n;
  }

  function xpForScore(total) { return Math.round(total); }

  // Level curve: level n needs 250·n(n−1)/2 total XP — early levels land
  // fast, later ones are earned.
  function levelFor(xp) {
    xp = Math.max(0, Number(xp) || 0);
    var level = 1;
    while (250 * (level * (level + 1)) / 2 <= xp) level++;
    var floor = 250 * ((level - 1) * level) / 2;
    var next = 250 * (level * (level + 1)) / 2;
    return { level: level, into: xp - floor, need: next - floor };
  }

  var LEVEL_NAMES = ['Rookie', 'Mover', 'Regular', 'Grinder', 'Athlete', 'Machine', 'Elite', 'Apex', 'Summit', 'Peak'];
  function levelName(level) { return LEVEL_NAMES[clamp(level - 1, 0, LEVEL_NAMES.length - 1)]; }

  /* ---------------- the daily push ---------------- */

  var PROMPTS = [
    'The body keeps the score — give it something to count.',
    'You don’t need a perfect day. You need a scored one.',
    'Protein first. Everything else negotiates.',
    'The bar doesn’t care how you feel. Lift it anyway.',
    'Sleep is training. Tonight is a session.',
    'Two litres before 2pm.',
    'A 20-minute walk beats a 0-minute plan.',
    'Streaks are built on your worst days, not your best.',
    'Add one rep. That’s the whole job today.',
    'Future you is watching. Make it a highlight.'
  ];

  function dailyPrompt(dateKey) {
    var i = hashStr('peak:' + dateKey) % PROMPTS.length;
    return { prompt: PROMPTS[i], index: i };
  }

  /* ---------------- formatters ---------------- */

  function fmtKg(kg) { return (Math.round(kg * 10) / 10) + ' kg'; }
  function fmtClock(ts, tzMin) {
    var d = new Date(ts + (tzMin || 0) * MINUTE);
    var h = d.getUTCHours(), m = d.getUTCMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* ---------------- export ---------------- */

  var api = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    hashStr: hashStr, rand01: rand01, clamp: clamp, round1: round1,
    dayKey: dayKey, prevDayKey: prevDayKey,
    ACTIVITY: ACTIVITY, GOALS: GOALS,
    validateProfile: validateProfile, bmr: bmr, tdee: tdee,
    calorieTarget: calorieTarget, macroTargets: macroTargets, hydrationTarget: hydrationTarget,
    oneRepMax: oneRepMax, trainingLoads: trainingLoads,
    DEFAULT_PLATES: DEFAULT_PLATES, plateMath: plateMath,
    REP_LOW: REP_LOW, REP_HIGH: REP_HIGH, STEP_KG: STEP_KG, nextSession: nextSession,
    EXERCISES: EXERCISES, workoutPlan: workoutPlan,
    FOODS: FOODS, searchFoods: searchFoods, logTotals: logTotals, fuelState: fuelState,
    CYCLE_MIN: CYCLE_MIN, FALL_ASLEEP_MIN: FALL_ASLEEP_MIN,
    sleepStats: sleepStats, bedtimesFor: bedtimesFor, sleepDebt: sleepDebt,
    peakScore: peakScore, scoreLabel: scoreLabel,
    streak: streak, xpForScore: xpForScore, levelFor: levelFor, levelName: levelName,
    PROMPTS: PROMPTS, dailyPrompt: dailyPrompt,
    fmtKg: fmtKg, fmtClock: fmtClock
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PeakEngine = api;
})(typeof self !== 'undefined' ? self : this);

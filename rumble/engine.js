/* Rumble — the pure one-on-one fighting engine.
 * =====================================================================
 * Rumble is a classic arcade head-to-head fighter built from scratch:
 * eight original fighters, best-of-three rounds under a 99-second clock,
 * walking, jumping, crouching, four normal attacks, blocking with chip
 * damage, motion-input specials (quarter-circles and a rising strike),
 * projectiles that travel and clash, a surge meter, knockdowns, and a
 * deterministic CPU opponent with four difficulty levels plus an arcade
 * ladder. Every rule lives HERE as pure, deterministic functions with
 * zero DOM and zero I/O: the match advances one fixed 60 Hz tick at a
 * time via step(), randomness is seeded (FNV-1a), and nothing reads a
 * real clock — unit-tested in scripts/test-rumble-logic.mjs, rendered
 * by index.html.
 *
 * All characters, names, moves and stages are original creations.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

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

  /* ---------------- arena constants (one fixed screen, like the classics) ---------------- */

  var TICKS = 60;                  // engine ticks per second
  var STAGE_W = 960;               // logical arena width
  var WALL_L = 46, WALL_R = STAGE_W - 46;
  var FLOOR_Y = 470;               // logical y of the floor line (for renderers)
  var BODY_W = 52;                 // torso push-box width
  var STAND_H = 158, CROUCH_H = 102;
  var GRAV = 0.7, JUMP_VY = 13;    // vy is +up; apex ≈ 120 px, airtime ≈ 37 ticks
  var MAX_HP = 100;
  var ROUND_SECONDS = 99;
  var ROUNDS_TO_WIN = 2;
  var METER_MAX = 100, SURGE_COST = 100;
  var SHOT_Y = 86, SHOT_HW = 20, SHOT_HH = 12;  // low enough that a timed jump clears it
  var INTRO_T = 110, KO_T = 80, ROUNDOVER_T = 130;
  var MOTION_WINDOW = 26;          // whole motion inside this many ticks
  var MOTION_LINK = 12;            // button within this many ticks of last direction
  var BUF_MAX = 24;

  /* ---------------- the roster: eight original fighters ----------------
   * spd    walk px/tick        pow   damage multiplier
   * reach  hitbox-length mult  Every fighter has three specials:
   *   a = quarter-circle-forward + punch  (their signature — a projectile
   *       for most, a closing lunge for the two close-range fighters)
   *   b = forward, down, down-forward + punch (rising anti-air strike)
   *   c = quarter-circle-back + kick (a sweeping dash, knocks down)
   * With a full surge meter, a + heavy punch spends it on the surge
   * version: shots get heavier, faster and beat normal projectiles;
   * lunges close further, hit harder and always knock down.
   */
  var ROSTER = [
    { id: 'volt', name: 'Volt', home: 'Neon Depot', tag: 'The live-wire line engineer.',
      spd: 3.4, pow: 1.0, reach: 1.0, look: 'goggles', build: { w: 1.0, h: 1.0 },
      colors: { gear: '#19c8b4', trim: '#ffd94d', skin: '#c98d5a', hair: '#20242c' },
      specials: { a: { kind: 'shot', name: 'Arc Bolt', dmg: 12, vel: 6 },
                  b: { name: 'Coil Rise', dmg: 14 },
                  c: { name: 'Live Wire', dmg: 12 } },
      quote: 'Stay grounded. I never do.' },
    { id: 'sable', name: 'Sable', home: 'Harbour Deck', tag: 'A fencer with nothing left to prove.',
      spd: 3.7, pow: 0.9, reach: 1.3, look: 'plume', build: { w: 0.88, h: 1.06 },
      colors: { gear: '#3a3f4b', trim: '#d94a5e', skin: '#e8b48c', hair: '#cfd4dd' },
      specials: { a: { kind: 'lunge', name: 'Lance Dart', dmg: 15, dist: 150 },
                  b: { name: 'Pirouette Rise', dmg: 13 },
                  c: { name: 'Ribbon Sweep', dmg: 11 } },
      quote: 'Reach decides. I brought more.' },
    { id: 'brick', name: 'Brick', home: 'Iron Yard', tag: 'Demolition, one handshake at a time.',
      spd: 2.6, pow: 1.25, reach: 0.9, look: 'hardhat', build: { w: 1.32, h: 1.02 },
      colors: { gear: '#e07b2a', trim: '#8a5a33', skin: '#a56a3f', hair: '#3a2c20' },
      specials: { a: { kind: 'lunge', name: 'Girder Grip', dmg: 20, dist: 120, kd: true },
                  b: { name: 'Piston Rise', dmg: 16 },
                  c: { name: 'Rubble Roll', dmg: 14 } },
      quote: 'Walls come down. So will you.' },
    { id: 'mirage', name: 'Mirage', home: 'Dune Gate', tag: 'The acrobat the desert dreamed up.',
      spd: 4.1, pow: 0.85, reach: 0.95, look: 'hood', build: { w: 0.84, h: 0.97 },
      colors: { gear: '#8f6bd9', trim: '#e8c86a', skin: '#b07a4e', hair: '#2c2036' },
      specials: { a: { kind: 'shot', name: 'Sand Veil', dmg: 10, vel: 4.5 },
                  b: { name: 'Sirocco Rise', dmg: 12 },
                  c: { name: 'Phantom Flip', dmg: 12 } },
      quote: 'You fought the heat haze. It won.' },
    { id: 'boreal', name: 'Boreal', home: 'Frost Quay', tag: 'Harbour wrestler of the frozen north.',
      spd: 2.8, pow: 1.2, reach: 1.0, look: 'scarf', build: { w: 1.2, h: 1.0 },
      colors: { gear: '#7fc4e8', trim: '#f2f6fa', skin: '#e8c9a8', hair: '#e3ba6f' },
      specials: { a: { kind: 'shot', name: 'Floe Shard', dmg: 13, vel: 5 },
                  b: { name: 'Glacier Rise', dmg: 15 },
                  c: { name: 'Avalanche Heel', dmg: 14 } },
      quote: 'The cold negotiates for me.' },
    { id: 'ember', name: 'Ember', home: 'Carnival Court', tag: 'Dancer first. That’s the trick.',
      spd: 3.6, pow: 1.0, reach: 1.0, look: 'braid', build: { w: 0.9, h: 1.0 },
      colors: { gear: '#e04a3a', trim: '#ffb84d', skin: '#8a5a3a', hair: '#1e1a18' },
      specials: { a: { kind: 'shot', name: 'Cinder Dart', dmg: 11, vel: 6.5 },
                  b: { name: 'Flare Rise', dmg: 13 },
                  c: { name: 'Blaze Wheel', dmg: 15 } },
      quote: 'Every step was the setup.' },
    { id: 'gale', name: 'Gale', home: 'Sky Terrace', tag: 'Rooftop kickboxing’s favourite forecast.',
      spd: 3.5, pow: 1.05, reach: 1.05, look: 'visor', build: { w: 1.02, h: 1.03 },
      colors: { gear: '#3fae6f', trim: '#eef4ee', skin: '#d9a06a', hair: '#4a3620' },
      specials: { a: { kind: 'shot', name: 'Jetstream', dmg: 11, vel: 7 },
                  b: { name: 'Updraft Rise', dmg: 14 },
                  c: { name: 'Cyclone Heel', dmg: 13 } },
      quote: 'Forecast said you’d lose.' },
    { id: 'onyx', name: 'Onyx', home: 'Onyx Hall', tag: 'The reigning crown of the circuit.',
      spd: 3.3, pow: 1.15, reach: 1.1, look: 'crown', build: { w: 1.08, h: 1.05 },
      colors: { gear: '#23252e', trim: '#e8b34c', skin: '#7a4a2e', hair: '#101014' },
      specials: { a: { kind: 'shot', name: 'Dusk Bolt', dmg: 13, vel: 6.5 },
                  b: { name: 'Obsidian Rise', dmg: 15 },
                  c: { name: 'Eclipse Heel', dmg: 14 } },
      quote: 'The crown stays where it is.' },
  ];

  function charById(id) {
    for (var i = 0; i < ROSTER.length; i++) if (ROSTER[i].id === id) return ROSTER[i];
    return null;
  }

  /* ---------------- normal attacks (frame data in ticks) ----------------
   * range = hitbox in front of the attacker, x from the body centre,
   * y measured up from the fighter's feet. hits: 'mid' blocks either way,
   * 'low' must be crouch-blocked, 'high' (jump-ins) must be stand-blocked.
   */
  var ATTACKS = {
    lp:  { name: 'Jab',        dmg: 5,  startup: 3, active: 3, recover: 7,  stun: 12, bstun: 8,  push: 9,  hits: 'mid', range: { x0: 18, x1: 80,  y0: 96,  y1: 140 } },
    hp:  { name: 'Straight',   dmg: 9,  startup: 7, active: 4, recover: 14, stun: 18, bstun: 12, push: 15, hits: 'mid', range: { x0: 20, x1: 94,  y0: 92,  y1: 144 } },
    lk:  { name: 'Snap Kick',  dmg: 6,  startup: 5, active: 4, recover: 9,  stun: 13, bstun: 9,  push: 11, hits: 'mid', range: { x0: 22, x1: 96,  y0: 34,  y1: 86 } },
    hk:  { name: 'Roundhouse', dmg: 10, startup: 9, active: 5, recover: 16, stun: 20, bstun: 13, push: 17, hits: 'mid', range: { x0: 24, x1: 106, y0: 62,  y1: 126 } },
    clp: { name: 'Low Jab',    dmg: 4,  startup: 3, active: 3, recover: 7,  stun: 11, bstun: 8,  push: 8,  hits: 'mid', range: { x0: 18, x1: 76,  y0: 52,  y1: 92 } },
    chp: { name: 'Uprocket',   dmg: 9,  startup: 6, active: 5, recover: 15, stun: 18, bstun: 12, push: 12, hits: 'mid', range: { x0: 10, x1: 62,  y0: 96,  y1: 190 } },
    clk: { name: 'Ankle Kick', dmg: 5,  startup: 4, active: 4, recover: 9,  stun: 12, bstun: 9,  push: 9,  hits: 'low', range: { x0: 22, x1: 92,  y0: 0,   y1: 34 } },
    chk: { name: 'Sweep',      dmg: 9,  startup: 8, active: 5, recover: 18, stun: 24, bstun: 14, push: 13, hits: 'low', range: { x0: 24, x1: 108, y0: 0,   y1: 30 }, kd: true },
    jp:  { name: 'Air Jab',    dmg: 7,  startup: 4, active: 12, recover: 4, stun: 16, bstun: 11, push: 10, hits: 'high', range: { x0: 10, x1: 74,  y0: -34, y1: 40 } },
    jk:  { name: 'Air Heel',   dmg: 8,  startup: 5, active: 12, recover: 4, stun: 18, bstun: 12, push: 12, hits: 'high', range: { x0: 12, x1: 86,  y0: -44, y1: 30 } },
  };

  /* special frame data (shared timing; damage/speed comes from the roster) */
  var SPECIAL = {
    a: { startup: 10, recover: 16 },                    // shot: spawns at end of startup
    lunge: { startup: 8, travel: 10, recover: 14 },     // closes dist over travel ticks
    b: { startup: 4, land: 14, vy: 11 },                // rising strike, active while ascending
    c: { startup: 8, travel: 12, recover: 12, dash: 5 },// sweeping dash, knocks down
  };

  /* ---------------- geometry ---------------- */

  function rectsOverlap(a, b) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  }

  // A fighter's hurt box, in arena coords (y up from the floor).
  function hurtBox(f) {
    var h = (f.phase === 'crouch' || f.crouching) ? CROUCH_H : STAND_H;
    if (f.phase === 'knockdown' || f.phase === 'getup' || f.phase === 'ko') h = 56;
    return { x0: f.x - BODY_W / 2, x1: f.x + BODY_W / 2, y0: f.y, y1: f.y + h };
  }

  // An attack's hit box for attacker f, in arena coords.
  function hitBoxFor(f, range, reach) {
    var x0 = range.x0, x1 = range.x1 * (reach || 1);
    var a = f.facing > 0
      ? { x0: f.x + x0, x1: f.x + x1 }
      : { x0: f.x - x1, x1: f.x - x0 };
    return { x0: a.x0, x1: a.x1, y0: f.y + range.y0, y1: f.y + range.y1 };
  }

  /* ---------------- motion input detection ----------------
   * Directions are numpad notation in WORLD space (6 = toward the right
   * wall). Patterns are written facing-right and mirrored when the
   * fighter faces left. Matching is a subsequence scan over the recent
   * buffer: intermediate directions are allowed, the whole motion must
   * fit in MOTION_WINDOW ticks and the last direction must be within
   * MOTION_LINK ticks of the button press.
   */
  var MOTIONS = {
    qcf: [2, 3, 6],   // down, down-forward, forward
    dp:  [6, 2, 3],   // forward, down, down-forward
    qcb: [2, 1, 4],   // down, down-back, back
  };

  function dirFrom(inp) {
    var x = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
    var v = (inp.u ? 1 : 0) - (inp.d ? 1 : 0);
    return 5 + x + 3 * v;
  }

  function mirrorDir(d) {
    var map = { 1: 3, 3: 1, 4: 6, 6: 4, 7: 9, 9: 7 };
    return map[d] || d;
  }

  // Returns the tick of the motion's final direction, or -1 when the
  // buffer doesn't contain the motion. When two motions both match (a
  // walk-forward quarter-circle also spells out the rising pattern), the
  // caller compares these ticks: the motion completed LATER is the one
  // the player actually performed.
  function motionLastT(buf, pattern, nowTick, facing) {
    var want = [];
    for (var i = 0; i < pattern.length; i++) {
      want.push(facing > 0 ? pattern[i] : mirrorDir(pattern[i]));
    }
    var p = 0, lastT = -1, firstT = -1;
    for (var j = 0; j < buf.length && p < want.length; j++) {
      var e = buf[j];
      if (nowTick - e.t > MOTION_WINDOW) continue;
      if (e.d === want[p]) {
        if (p === 0) firstT = e.t;
        lastT = e.t;
        p++;
      }
    }
    if (p === want.length && nowTick - lastT <= MOTION_LINK && lastT - firstT <= MOTION_WINDOW) return lastT;
    return -1;
  }

  function detectMotion(buf, pattern, nowTick, facing) {
    return motionLastT(buf, pattern, nowTick, facing) >= 0;
  }

  /* ---------------- match construction ---------------- */

  function makeFighter(charId, x, facing) {
    return {
      id: charId, x: x, y: 0, vy: 0, vx: 0, facing: facing,
      hp: MAX_HP, meter: 0,
      phase: 'idle', t: 0, move: null, hitDone: false,
      crouching: false, surge: false,
      buf: [], lastDir: 5,
      prev: { lp: false, hp: false, lk: false, hk: false },
    };
  }

  function createMatch(opts) {
    opts = opts || {};
    var p1 = charById(opts.p1) ? opts.p1 : ROSTER[0].id;
    var p2 = charById(opts.p2) ? opts.p2 : ROSTER[1].id;
    return {
      v: 1,
      seed: String(opts.seed == null ? 'rumble' : opts.seed),
      mode: opts.mode || 'versus',        // 'versus' | 'cpu' | 'practice'
      level: Math.max(1, Math.min(4, opts.level | 0 || 2)),
      stage: opts.stage || charById(p2).home,
      tick: 0,
      phase: 'intro', phaseT: INTRO_T,
      round: 1, wins: [0, 0],
      time: ROUND_SECONDS * TICKS,
      winner: -1, roundWinner: -1, koWinner: -1,
      shots: [], events: [],
      f: [makeFighter(p1, 300, 1), makeFighter(p2, 660, -1)],
    };
  }

  function resetRound(m) {
    for (var i = 0; i < 2; i++) {
      var f = m.f[i];
      f.x = i === 0 ? 300 : 660; f.y = 0; f.vy = 0; f.vx = 0;
      f.facing = i === 0 ? 1 : -1;
      f.hp = MAX_HP;
      f.phase = 'idle'; f.t = 0; f.move = null; f.hitDone = false;
      f.crouching = false; f.surge = false;
      f.buf = []; f.lastDir = 5;
    }
    m.shots = [];
    m.time = ROUND_SECONDS * TICKS;
    m.roundWinner = -1;
  }

  function healthPct(f) { return Math.max(0, f.hp) / MAX_HP; }
  function timerSeconds(m) { return Math.ceil(Math.max(0, m.time) / TICKS); }

  /* ---------------- combat resolution ---------------- */

  function emit(m, type, data) {
    var e = { type: type, tick: m.tick };
    if (data) for (var k in data) e[k] = data[k];
    m.events.push(e);
  }

  function meterGain(f, amount) {
    f.meter = Math.min(METER_MAX, f.meter + amount);
  }

  // Is the defender in a state and holding a direction that blocks this hit?
  function canBlock(def, atk, hits, inp) {
    if (def.y > 0) return false;
    var ph = def.phase;
    if (ph !== 'idle' && ph !== 'walk' && ph !== 'crouch' && ph !== 'blockstun') return false;
    var away = def.x < atk.x ? -1 : 1;
    var x = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
    if (x !== away) return false;
    var crouched = ph === 'crouch' || (ph === 'blockstun' && def.crouching) || inp.d;
    if (hits === 'low' && !crouched) return false;
    if (hits === 'high' && crouched) return false;
    return true;
  }

  // hit = { dmg, stun, push, kd, hits ('mid'|'low'|'high'), chips (bool) }
  function applyHit(m, ai, di, hit, inp) {
    var atk = m.f[ai], def = m.f[di];
    var away = def.x < atk.x ? -1 : 1;
    if (canBlock(def, atk, hit.hits, inp)) {
      var chipDmg = hit.chips ? Math.ceil(hit.dmg / 4) : 0;
      def.hp -= chipDmg;
      def.crouching = def.phase === 'crouch' || !!inp.d;
      def.phase = 'blockstun'; def.t = 0; def.move = null;
      def.stun = Math.max(8, Math.round(hit.stun * 0.7));
      def.vx = away * hit.push / 5;
      meterGain(def, 3); meterGain(atk, 4);
      emit(m, 'block', { p: di, chip: chipDmg });
      return 'block';
    }
    def.hp -= hit.dmg;
    meterGain(atk, hit.dmg); meterGain(def, Math.ceil(hit.dmg / 2));
    def.move = null; def.crouching = false;
    if (def.y > 0 || hit.kd) {
      def.phase = 'knockdown'; def.t = 0;
      def.y = Math.max(def.y, 1); def.vy = 6; def.vx = away * 3;
    } else {
      def.phase = 'hitstun'; def.t = 0;
      def.stun = hit.stun;
      def.vx = away * hit.push / 4;
    }
    emit(m, 'hit', { p: di, dmg: hit.dmg, kd: !!hit.kd });
    return 'hit';
  }

  // Where a normal attack's damage comes from: base scaled by the fighter.
  function scaledDmg(ch, base) { return Math.max(1, Math.round(base * ch.pow)); }

  /* ---------------- one fighter's tick ---------------- */

  function startAttack(f, key) {
    f.phase = 'attack'; f.move = key; f.t = 0; f.hitDone = false;
  }

  function startSpecial(m, i, slot, surge) {
    var f = m.f[i];
    f.phase = 'special'; f.move = slot; f.t = 0; f.hitDone = false; f.surge = !!surge;
    if (surge) { f.meter = 0; emit(m, 'surge', { p: i }); }
    var ch = charById(f.id);
    emit(m, 'special', { p: i, slot: slot, name: ch.specials[slot].name });
    if (slot === 'b') { f.vy = SPECIAL.b.vy; f.y = 0.01; }
  }

  function edge(inp, prevHeld, key) { return !!inp[key] && !prevHeld[key]; }

  function fighterTick(m, i, inp) {
    var f = m.f[i], o = m.f[1 - i];
    var ch = charById(f.id);
    var fighting = m.phase === 'fight';

    // --- input buffer for motions (world-space numpad dirs, edges only).
    // The still-held direction stays fresh: a long crouch (blocking low)
    // rolled into down-forward, forward must still read as the motion.
    var d = dirFrom(inp);
    if (d !== f.lastDir) {
      f.buf.push({ t: m.tick, d: d });
      if (f.buf.length > BUF_MAX) f.buf.shift();
      f.lastDir = d;
    } else if (f.buf.length) {
      f.buf[f.buf.length - 1].t = m.tick;
    }

    var press = {
      lp: edge(inp, f.prev, 'lp'), hp: edge(inp, f.prev, 'hp'),
      lk: edge(inp, f.prev, 'lk'), hk: edge(inp, f.prev, 'hk'),
    };
    f.prev = { lp: !!inp.lp, hp: !!inp.hp, lk: !!inp.lk, hk: !!inp.hk };

    // --- vertical physics (jump arcs, knockdown arcs, rising strikes)
    if (f.y > 0 || f.vy !== 0) {
      f.y += f.vy; f.vy -= GRAV;
      f.x += f.vx;
      if (f.y <= 0) {
        f.y = 0; f.vy = 0;
        if (f.phase === 'jump' || f.phase === 'air-attack') { f.phase = 'idle'; f.t = 0; f.move = null; f.vx = 0; }
        else if (f.phase === 'special' && f.move === 'b') { f.phase = 'recover'; f.t = 0; f.stun = SPECIAL.b.land; f.vx = 0; }
        else if (f.phase === 'knockdown') { f.vx = 0; }
      }
    } else if (f.vx !== 0) {
      // ground knockback/pushback decays
      f.x += f.vx;
      f.vx *= 0.8;
      if (Math.abs(f.vx) < 0.2) f.vx = 0;
    }

    f.x = Math.max(WALL_L, Math.min(WALL_R, f.x));
    f.t++;

    // --- non-actionable phases run their timers
    if (f.phase === 'hitstun' || f.phase === 'blockstun') {
      if (f.t >= f.stun) { f.phase = f.crouching ? 'crouch' : 'idle'; f.t = 0; f.crouching = false; }
      return;
    }
    if (f.phase === 'recover') {
      if (f.t >= f.stun) { f.phase = 'idle'; f.t = 0; }
      return;
    }
    if (f.phase === 'knockdown') {
      if (f.y <= 0 && f.t >= 42) { f.phase = 'getup'; f.t = 0; }
      return;
    }
    if (f.phase === 'getup') {
      if (f.t >= 14) { f.phase = 'idle'; f.t = 0; }
      return;
    }
    if (f.phase === 'ko' || f.phase === 'win') return;

    // --- attacks and specials play out
    if (f.phase === 'attack') {
      var a = ATTACKS[f.move];
      if (f.t >= a.startup + a.active + a.recover) { f.phase = f.move[0] === 'c' ? 'crouch' : 'idle'; f.t = 0; f.move = null; }
      return;
    }
    if (f.phase === 'air-attack') return; // resolved by physics/landing
    if (f.phase === 'special') {
      var sp = ch.specials[f.move];
      if (f.move === 'a') {
        if (sp.kind === 'shot') {
          if (f.t === SPECIAL.a.startup && fighting) {
            var vel = (f.surge ? sp.vel + 2 : sp.vel) * f.facing;
            m.shots.push({ x: f.x + f.facing * 46, y: SHOT_Y, vx: vel, owner: i,
                           dmg: f.surge ? Math.round(sp.dmg * 1.8) : sp.dmg,
                           power: f.surge ? 2 : 1, name: sp.name });
            emit(m, 'shot', { p: i, name: sp.name, surge: f.surge });
          }
          if (f.t >= SPECIAL.a.startup + SPECIAL.a.recover) { f.phase = 'idle'; f.t = 0; f.move = null; }
        } else { // lunge — a surge lunge closes further
          var L = SPECIAL.lunge;
          var dist = f.surge ? sp.dist + 50 : sp.dist;
          if (f.t > L.startup && f.t <= L.startup + L.travel) f.x += (dist / L.travel) * f.facing;
          f.x = Math.max(WALL_L, Math.min(WALL_R, f.x));
          if (f.t >= L.startup + L.travel + L.recover) { f.phase = 'idle'; f.t = 0; f.move = null; }
        }
      } else if (f.move === 'b') {
        // airborne — landing handled in physics above
      } else if (f.move === 'c') {
        var C = SPECIAL.c;
        if (f.t > C.startup && f.t <= C.startup + C.travel) f.x += C.dash * f.facing;
        f.x = Math.max(WALL_L, Math.min(WALL_R, f.x));
        if (f.t >= C.startup + C.travel + C.recover) { f.phase = 'idle'; f.t = 0; f.move = null; }
      }
      return;
    }
    if (f.phase === 'jump') {
      // one air attack per jump
      if (fighting && f.move == null && (press.lp || press.hp || press.lk || press.hk)) {
        f.move = (press.lp || press.hp) ? 'jp' : 'jk';
        f.phase = 'air-attack'; f.hitDone = false; f.atkT = 0;
      }
      return;
    }

    // --- grounded, actionable: face the opponent
    f.facing = f.x <= o.x ? 1 : -1;

    if (!fighting) { f.phase = 'idle'; return; }

    // specials first (they eat the button press). Both patterns can match
    // at once — walking forward before a quarter-circle also spells the
    // rising motion — so the motion that COMPLETED later wins.
    if (press.lp || press.hp) {
      var dpT = motionLastT(f.buf, MOTIONS.dp, m.tick, f.facing);
      var qcfT = motionLastT(f.buf, MOTIONS.qcf, m.tick, f.facing);
      if (dpT >= 0 && dpT > qcfT) { startSpecial(m, i, 'b'); return; }
      if (qcfT >= 0) {
        startSpecial(m, i, 'a', press.hp && f.meter >= SURGE_COST);
        return;
      }
    }
    if ((press.lk || press.hk) && detectMotion(f.buf, MOTIONS.qcb, m.tick, f.facing)) {
      startSpecial(m, i, 'c'); return;
    }

    // normals
    if (press.lp || press.hp || press.lk || press.hk) {
      var low = !!inp.d;
      var key = press.lp ? (low ? 'clp' : 'lp')
              : press.hp ? (low ? 'chp' : 'hp')
              : press.lk ? (low ? 'clk' : 'lk')
              : (low ? 'chk' : 'hk');
      startAttack(f, key);
      return;
    }

    // movement
    if (inp.u && f.y === 0) {
      f.phase = 'jump'; f.move = null; f.t = 0;
      f.vy = JUMP_VY; f.y = 0.01;
      f.vx = ((inp.r ? 1 : 0) - (inp.l ? 1 : 0)) * ch.spd * 1.15;
      return;
    }
    if (inp.d) { f.phase = 'crouch'; f.crouching = true; return; }
    f.crouching = false;
    var mx = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
    if (mx !== 0) {
      var fwd = mx === f.facing;
      f.x += mx * ch.spd * (fwd ? 1 : 0.82);
      f.x = Math.max(WALL_L, Math.min(WALL_R, f.x));
      f.phase = 'walk';
    } else {
      f.phase = 'idle';
    }
  }

  /* ---------------- resolving hits between the two fighters ---------------- */

  function activeHit(f, ch) {
    if (f.phase === 'attack') {
      var a = ATTACKS[f.move];
      if (f.t > a.startup && f.t <= a.startup + a.active && !f.hitDone) {
        return { box: hitBoxFor(f, a.range, ch.reach), dmg: scaledDmg(ch, a.dmg),
                 stun: a.stun, push: a.push, kd: !!a.kd, hits: a.hits, chips: false };
      }
    }
    if (f.phase === 'air-attack' && f.move) {
      var aa = ATTACKS[f.move];
      if (f.atkT > aa.startup && f.atkT <= aa.startup + aa.active && !f.hitDone && f.y > 0) {
        return { box: hitBoxFor(f, aa.range, ch.reach), dmg: scaledDmg(ch, aa.dmg),
                 stun: aa.stun, push: aa.push, kd: false, hits: 'high', chips: false };
      }
    }
    if (f.phase === 'special' && !f.hitDone) {
      var sp = ch.specials[f.move];
      if (f.move === 'a' && sp.kind === 'lunge') {
        var L = SPECIAL.lunge;
        if (f.t > L.startup && f.t <= L.startup + L.travel) {
          return { box: hitBoxFor(f, { x0: 14, x1: 88, y0: 60, y1: 150 }, ch.reach),
                   dmg: f.surge ? Math.round(sp.dmg * 1.5) : sp.dmg,
                   stun: 24, push: 22, kd: !!sp.kd || f.surge, hits: 'mid', chips: true };
        }
      }
      if (f.move === 'b' && f.t > SPECIAL.b.startup && f.vy > 2) {
        return { box: hitBoxFor(f, { x0: -6, x1: 66, y0: 60, y1: 200 }, 1),
                 dmg: sp.dmg, stun: 22, push: 14, kd: true, hits: 'mid', chips: true };
      }
      if (f.move === 'c') {
        var C = SPECIAL.c;
        if (f.t > C.startup && f.t <= C.startup + C.travel) {
          return { box: hitBoxFor(f, { x0: 12, x1: 92, y0: 0, y1: 84 }, ch.reach),
                   dmg: sp.dmg, stun: 24, push: 18, kd: true, hits: 'low', chips: true };
        }
      }
    }
    return null;
  }

  function resolveCombat(m, in1, in2) {
    var inputs = [in1, in2];
    // Gather both melee hits against the PRE-hit state, then apply both —
    // otherwise whichever player is processed first wins every trade.
    var pend = [null, null];
    for (var i = 0; i < 2; i++) {
      var f = m.f[i], o = m.f[1 - i], ch = charById(f.id);
      if (f.phase === 'air-attack') f.atkT = (f.atkT || 0) + 1;
      if (o.phase === 'knockdown' || o.phase === 'getup' || o.phase === 'ko') continue;
      var hit = activeHit(f, ch);
      if (hit && rectsOverlap(hit.box, hurtBox(o))) pend[i] = hit;
    }
    for (var p = 0; p < 2; p++) {
      if (pend[p]) {
        m.f[p].hitDone = true;
        applyHit(m, p, 1 - p, pend[p], inputs[1 - p]);
      }
    }

    // projectiles
    var alive = [];
    for (var s = 0; s < m.shots.length; s++) {
      var sh = m.shots[s];
      sh.x += sh.vx;
      var box = { x0: sh.x - SHOT_HW, x1: sh.x + SHOT_HW, y0: sh.y - SHOT_HH, y1: sh.y + SHOT_HH };
      var target = m.f[1 - sh.owner];
      var dead = false;
      // clash with opposing shots
      for (var s2 = 0; s2 < m.shots.length; s2++) {
        var other = m.shots[s2];
        if (other === sh || other.owner === sh.owner || other.dead) continue;
        var obox = { x0: other.x - SHOT_HW, x1: other.x + SHOT_HW, y0: other.y - SHOT_HH, y1: other.y + SHOT_HH };
        if (rectsOverlap(box, obox)) {
          var min = Math.min(sh.power, other.power);
          sh.power -= min; other.power -= min;
          if (sh.power <= 0) { sh.dead = true; dead = true; }
          if (other.power <= 0) other.dead = true;
          emit(m, 'clash', { x: (sh.x + other.x) / 2 });
        }
      }
      if (!dead && !sh.dead &&
          target.phase !== 'knockdown' && target.phase !== 'getup' && target.phase !== 'ko' &&
          rectsOverlap(box, hurtBox(target))) {
        applyHit(m, sh.owner, 1 - sh.owner,
                 { dmg: sh.dmg, stun: 20, push: 14, kd: false, hits: 'mid', chips: true },
                 inputs[1 - sh.owner]);
        dead = true;
      }
      if (!dead && !sh.dead && sh.x > -60 && sh.x < STAGE_W + 60) alive.push(sh);
    }
    // a later-indexed shot's clash can kill an earlier one already kept
    var kept = [];
    for (var k = 0; k < alive.length; k++) if (!alive[k].dead) kept.push(alive[k]);
    m.shots = kept;
  }

  /* ---------------- body push (fighters can't stand inside each other) ---------------- */

  function bodyPush(m) {
    var a = m.f[0], b = m.f[1];
    if (a.y > 40 || b.y > 40) return;
    if (a.phase === 'knockdown' || b.phase === 'knockdown' || a.phase === 'ko' || b.phase === 'ko') return;
    var dx = b.x - a.x;
    var overlap = BODY_W - Math.abs(dx);
    if (overlap > 0) {
      var dir = dx === 0 ? (a.facing || 1) : (dx > 0 ? 1 : -1);
      a.x -= dir * overlap / 2; b.x += dir * overlap / 2;
      a.x = Math.max(WALL_L, Math.min(WALL_R, a.x));
      b.x = Math.max(WALL_L, Math.min(WALL_R, b.x));
      // in the corner one side can't give ground — shove the other
      if (b.x - a.x < BODY_W) {
        if (a.x <= WALL_L + 0.5) b.x = Math.min(WALL_R, a.x + BODY_W);
        else if (b.x >= WALL_R - 0.5) a.x = Math.max(WALL_L, b.x - BODY_W);
      }
    }
  }

  /* ---------------- round / match flow ---------------- */

  function endRound(m, winnerIdx) {
    m.roundWinner = winnerIdx; // -1 = draw
    if (winnerIdx === 0 || winnerIdx === 1) {
      m.wins[winnerIdx]++;
      m.f[winnerIdx].phase = m.f[winnerIdx].y === 0 ? 'win' : m.f[winnerIdx].phase;
    }
    m.phase = 'roundover'; m.phaseT = ROUNDOVER_T;
    emit(m, 'roundover', { winner: winnerIdx, round: m.round });
  }

  function decideTimeout(m) {
    if (m.f[0].hp > m.f[1].hp) return 0;
    if (m.f[1].hp > m.f[0].hp) return 1;
    return -1;
  }

  function step(m, in1, in2) {
    in1 = in1 || {}; in2 = in2 || {};
    m.tick++;
    m.events = [];

    if (m.phase === 'intro') {
      m.phaseT--;
      if (m.phaseT <= 0) { m.phase = 'fight'; emit(m, 'fight', { round: m.round }); }
      return m;
    }

    if (m.phase === 'roundover') {
      // let physics settle bodies to the floor during the pause
      fighterTick(m, 0, {}); fighterTick(m, 1, {});
      m.phaseT--;
      if (m.phaseT <= 0) {
        if (m.wins[0] >= ROUNDS_TO_WIN || m.wins[1] >= ROUNDS_TO_WIN) {
          m.phase = 'matchover';
          m.winner = m.wins[0] >= ROUNDS_TO_WIN ? 0 : 1;
          emit(m, 'matchover', { winner: m.winner });
        } else {
          m.round++;
          resetRound(m);
          m.phase = 'intro'; m.phaseT = INTRO_T;
          emit(m, 'round', { round: m.round });
        }
      }
      return m;
    }

    if (m.phase === 'matchover') return m;

    if (m.phase === 'ko') {
      fighterTick(m, 0, {}); fighterTick(m, 1, {});
      m.phaseT--;
      if (m.phaseT <= 0) endRound(m, m.koWinner);
      return m;
    }

    // --- fight ---
    fighterTick(m, 0, in1);
    fighterTick(m, 1, in2);
    resolveCombat(m, in1, in2);
    bodyPush(m);

    // KO check
    var k0 = m.f[0].hp <= 0, k1 = m.f[1].hp <= 0;
    if (k0 || k1) {
      if (k0) { m.f[0].phase = 'ko'; m.f[0].move = null; }
      if (k1) { m.f[1].phase = 'ko'; m.f[1].move = null; }
      m.phase = 'ko'; m.phaseT = KO_T;
      m.koWinner = k0 && k1 ? -1 : (k0 ? 1 : 0); // double KO = draw round
      emit(m, 'ko', { winner: m.koWinner, double: k0 && k1 });
      return m;
    }

    // clock
    if (m.mode !== 'practice') {
      m.time--;
      if (m.time <= 0) {
        var w = decideTimeout(m);
        emit(m, 'timeup', { winner: w });
        endRound(m, w);
      }
    }
    return m;
  }

  /* ---------------- the CPU opponent ----------------
   * Pure function of the match state: plans switch every few ticks
   * (faster at higher levels), chosen by seeded hash — the same match
   * always plays out the same way. Levels 1–4.
   */
  function cpuInputs(m, idx) {
    var f = m.f[idx], o = m.f[1 - idx];
    var ch = charById(f.id);
    var lvl = m.level;
    if (m.phase !== 'fight') return {};
    var toward = o.x > f.x ? 1 : -1;
    var dist = Math.abs(o.x - f.x);
    var planLen = 26 - lvl * 4;                       // 22 / 18 / 14 / 10 ticks
    var planId = Math.floor(m.tick / planLen);
    var t0 = planId * planLen;
    var r = rand01(m.seed + ':' + idx + ':' + planId);
    var inp = {};

    // incoming projectile: jump it or block it
    var threat = null;
    for (var s2 = 0; s2 < m.shots.length; s2++) {
      var sh2 = m.shots[s2];
      if (sh2.owner === idx) continue;
      var closing = (sh2.vx > 0 && sh2.x < f.x) || (sh2.vx < 0 && sh2.x > f.x);
      if (closing && Math.abs(sh2.x - f.x) < 150) threat = sh2;
    }
    if (threat && r < 0.25 * lvl) {
      if (r < 0.1 * lvl) { inp.u = true; inp.r = toward > 0; inp.l = toward < 0; } // jump in over it
      else { inp.l = toward > 0; inp.r = toward < 0; }                             // hold back and block
      return inp;
    }

    // opponent airborne and close: try the rising strike (motion performer)
    if (o.y > 40 && dist < 130 && r < 0.2 * lvl) {
      return motionStep(m.tick - t0, 'dp', toward, 'hp');
    }

    // opponent attacking nearby: block (more reliably at high level)
    if ((o.phase === 'attack' || o.phase === 'special') && dist < 170 && r < 0.18 * lvl) {
      inp.l = toward > 0; inp.r = toward < 0;
      if (rand01(m.seed + ':lo:' + planId) < 0.5) inp.d = true;
      return inp;
    }

    if (dist > 320) {
      // far: zoners shoot, everyone else closes in
      var shoots = charById(f.id).specials.a.kind === 'shot';
      if (shoots && r < 0.32 + 0.06 * lvl && m.shots.length === 0) {
        return motionStep(m.tick - t0, 'qcf', toward, f.meter >= SURGE_COST && lvl >= 3 ? 'hp' : 'lp');
      }
      inp[toward > 0 ? 'r' : 'l'] = true;
      if (r > 0.85) inp.u = true; // occasional jump-in
      return inp;
    }

    if (dist > 150) {
      // mid range: approach, poke, or sweep-dash in
      if (r < 0.14 * lvl) return motionStep(m.tick - t0, 'qcb', toward, 'lk');
      inp[toward > 0 ? 'r' : 'l'] = true;
      if (r > 0.6 && dist < 220) { inp.hk = m.tick % planLen === 4; }
      return inp;
    }

    // close: walk into true poke range, then mix normals, sweeps and lunges
    var pick = Math.floor(r * 6);
    var pressT = m.tick % planLen;
    if (pick === 4 && charById(f.id).specials.a.kind === 'lunge') {
      return motionStep(m.tick - t0, 'qcf', toward, 'hp');
    }
    if (pick === 5) { // step back / block posture
      inp.l = toward > 0; inp.r = toward < 0;
      return inp;
    }
    if (dist > 100) { inp[toward > 0 ? 'r' : 'l'] = true; return inp; }
    if (pick === 0) inp.lp = pressT === 2;
    else if (pick === 1) inp.hp = pressT === 2;
    else if (pick === 2) { inp.d = true; inp.lk = pressT === 3; }
    else { inp.d = true; inp.hk = pressT === 3; } // sweep
    return inp;
  }

  // Emits one tick of a motion sequence: dirs then the button.
  function motionStep(tt, motion, toward, btn) {
    var seq = MOTIONS[motion];
    var inp = {};
    var stepIdx = Math.floor(tt / 2); // hold each direction 2 ticks
    if (stepIdx < seq.length) {
      var d = seq[stepIdx];
      if (toward < 0) d = mirrorDir(d);
      if (d === 1 || d === 2 || d === 3) inp.d = true;
      if (d === 3 || d === 6 || d === 9) inp.r = true;
      if (d === 1 || d === 4 || d === 7) inp.l = true;
      if (d === 7 || d === 8 || d === 9) inp.u = true;
    } else if (stepIdx === seq.length) {
      inp[btn] = true;
    }
    return inp;
  }

  /* ---------------- the arcade ladder ---------------- */

  // Deterministic opponent order: everyone else shuffled by seed, the
  // reigning champion (Onyx) always waiting at the end.
  function ladderFor(charId, seed) {
    var rest = [], boss = 'onyx';
    for (var i = 0; i < ROSTER.length; i++) {
      var id = ROSTER[i].id;
      if (id !== charId && id !== boss) rest.push(id);
    }
    rest.sort(function (a, b) {
      return rand01(seed + ':' + a) - rand01(seed + ':' + b) || (a < b ? -1 : 1);
    });
    if (charId !== boss) rest.push(boss);
    return rest;
  }

  function ladderLevel(fightIdx, total) {
    if (fightIdx >= total - 1) return 4;         // the champion fights hardest
    return Math.min(3, 1 + Math.floor(fightIdx / 2));
  }

  /* ---------------- exports ---------------- */

  var api = {
    // constants
    TICKS: TICKS, STAGE_W: STAGE_W, FLOOR_Y: FLOOR_Y, WALL_L: WALL_L, WALL_R: WALL_R,
    BODY_W: BODY_W, STAND_H: STAND_H, CROUCH_H: CROUCH_H,
    MAX_HP: MAX_HP, ROUND_SECONDS: ROUND_SECONDS, ROUNDS_TO_WIN: ROUNDS_TO_WIN,
    METER_MAX: METER_MAX, SURGE_COST: SURGE_COST,
    GRAV: GRAV, JUMP_VY: JUMP_VY,
    // data
    ROSTER: ROSTER, ATTACKS: ATTACKS, MOTIONS: MOTIONS, SPECIAL: SPECIAL,
    // helpers
    hashStr: hashStr, rand01: rand01, rectsOverlap: rectsOverlap,
    charById: charById, hurtBox: hurtBox, hitBoxFor: hitBoxFor,
    dirFrom: dirFrom, mirrorDir: mirrorDir, detectMotion: detectMotion,
    healthPct: healthPct, timerSeconds: timerSeconds, decideTimeout: decideTimeout,
    scaledDmg: scaledDmg,
    // match
    createMatch: createMatch, step: step, cpuInputs: cpuInputs,
    ladderFor: ladderFor, ladderLevel: ladderLevel,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RumbleEngine = api;
})(typeof self !== 'undefined' ? self : this);

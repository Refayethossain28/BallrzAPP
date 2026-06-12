/* ============================================================================
 * DAYTONA USA — procedural music engine (WebAudio, no assets)
 * An upbeat arcade-rock loop synthesised in real time: kick/snare/hat drums,
 * a bouncing bass, sustained chord pads and an arpeggiated lead, over a classic
 * I–V–vi–IV progression. Two intensities — "race" (full kit + lead) and "menu"
 * (mellow). Exposed as window.GameMusic so both the 2D (script) and 3D (module)
 * builds can share it.
 * ========================================================================== */
(function () {
  'use strict';

  const A4 = 440;
  const m2f = m => A4 * Math.pow(2, (m - 69) / 12);   // MIDI note -> frequency

  // I–V–vi–IV in A major, one chord per bar. Each chord = [root, third, fifth] MIDI.
  const PROG = [
    { root: 45, tri: [45, 49, 52] },   // A
    { root: 40, tri: [40, 44, 47] },   // E
    { root: 42, tri: [42, 45, 49] },   // F#m
    { root: 38, tri: [38, 42, 45] },   // D
  ];
  // arpeggio pattern (indices into an extended chord) per eighth note
  const ARP = [0, 1, 2, 3, 2, 3, 1, 2];
  // bass groove per eighth (semitone offset from chord root)
  const BASS = [0, 0, 12, 0, 7, 0, 12, 5];

  const M = {
    ctx: null, master: null, noiseBuf: null,
    on: false, muted: false, mode: 'menu', ducked: false,
    bpm: 132, eighth: 0, step: 0, nextTime: 0, timer: null,
  };

  M.init = function (ctx) {
    if (M.ctx) return;
    M.ctx = ctx;
    M.master = ctx.createGain();
    M.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    M.master.connect(comp).connect(ctx.destination);
    M.eighth = (60 / M.bpm) / 2;
    // one-shot white-noise buffer for drums
    const n = ctx.sampleRate * 0.4;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    M.noiseBuf = buf;
  };

  function targetVol() {
    if (M.muted || !M.on) return 0;
    let v = M.mode === 'race' ? 0.42 : 0.26;
    if (M.ducked) v *= 0.35;
    return v;
  }
  function fade() {
    if (!M.master) return;
    M.master.gain.setTargetAtTime(targetVol(), M.ctx.currentTime, 0.4);
  }

  // ---- voices -------------------------------------------------------------
  function tone(type, freq, t, dur, vol, opts) {
    opts = opts || {};
    const o = M.ctx.createOscillator(), g = M.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    if (opts.detune) o.detune.value = opts.detune;
    const atk = opts.atk || 0.008, rel = opts.rel || 0.08;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + atk);
    g.gain.setValueAtTime(vol, t + Math.max(atk, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = g;
    if (opts.filter) {
      const f = M.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = opts.filter;
      o.connect(f).connect(g);
    } else o.connect(g);
    node.connect(M.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function kick(t) {
    const o = M.ctx.createOscillator(), g = M.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(M.master); o.start(t); o.stop(t + 0.24);
  }
  function noise(t, dur, vol, hp) {
    const s = M.ctx.createBufferSource(); s.buffer = M.noiseBuf;
    const g = M.ctx.createGain(), f = M.ctx.createBiquadFilter();
    f.type = hp ? 'highpass' : 'bandpass'; f.frequency.value = hp || 1800;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(M.master); s.start(t); s.stop(t + dur + 0.02);
  }

  // ---- sequencer ----------------------------------------------------------
  function scheduleStep(step, t) {
    const e = step % 8;                  // eighth within the bar
    const bar = Math.floor(step / 8) % 4;
    const chord = PROG[bar];
    const race = M.mode === 'race';

    // drums
    if (e === 0 || e === 4 || (race && e === 7)) kick(t);
    if (e === 2 || e === 6) noise(t, 0.18, race ? 0.5 : 0.32, 0);      // snare
    if (race || e % 2 === 0) noise(t, 0.04, race ? 0.18 : 0.12, 9000); // hat

    // bass (sawtooth, low)
    const bf = m2f(chord.root - 12 + BASS[e]);
    tone('sawtooth', bf, t, M.eighth * 0.9, race ? 0.34 : 0.24, { filter: 700, rel: 0.05 });

    // chord pad once per bar (soft, sustained)
    if (e === 0) {
      for (const note of chord.tri) {
        tone('triangle', m2f(note), t, M.eighth * 8 * 0.96, 0.10, { atk: 0.06, rel: 0.4 });
        tone('sawtooth', m2f(note), t, M.eighth * 8 * 0.96, 0.03, { atk: 0.08, rel: 0.4, detune: 8, filter: 1600 });
      }
    }

    // arpeggiated lead (race only)
    if (race) {
      const ext = [chord.tri[0] + 12, chord.tri[1] + 12, chord.tri[2] + 12, chord.tri[0] + 24];
      const note = ext[ARP[e]];
      tone('square', m2f(note), t, M.eighth * 0.7, 0.12, { atk: 0.005, rel: 0.06, filter: 4000 });
    }
  }
  function loop() {
    const ahead = M.ctx.currentTime + 0.12;
    while (M.nextTime < ahead) {
      scheduleStep(M.step, M.nextTime);
      M.nextTime += M.eighth;
      M.step = (M.step + 1) % 32;       // 4 bars × 8 eighths
    }
    M.timer = setTimeout(loop, 25);
  }

  // ---- public API ---------------------------------------------------------
  M.start = function () {
    if (!M.ctx) return;
    if (M.ctx.state === 'suspended') M.ctx.resume();
    M.on = true;
    if (!M.timer) { M.nextTime = M.ctx.currentTime + 0.06; M.step = 0; loop(); }
    fade();
  };
  M.setMode = function (mode) { M.mode = mode; fade(); };
  M.duck = function (on) { M.ducked = on; fade(); };
  M.stop = function () { M.on = false; fade(); };
  M.toggleMute = function () { M.muted = !M.muted; fade(); return M.muted; };
  M.isMuted = function () { return M.muted; };

  window.GameMusic = M;
})();

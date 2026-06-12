/* ============================================================================
 * DAYTONA USA — procedural DANCE music engine (WebAudio, no assets)
 * A four-on-the-floor house/EDM track synthesised in real time: punchy kick,
 * claps, open/closed hats, a pumping (sidechained) sawtooth bass, detuned
 * "supersaw" chord stabs, a plucky arpeggio lead and a soft pad — over an
 * A-minor i–VI–III–VII progression with a feedback-delay send for space.
 * Two intensities — "race" (full) and "menu" (mellow). window.GameMusic.
 * ========================================================================== */
(function () {
  'use strict';

  const A4 = 440;
  const m2f = m => A4 * Math.pow(2, (m - 69) / 12);

  // i–VI–III–VII in A minor, one chord per bar. triad MIDI (one octave region).
  const PROG = [
    { root: 45, tri: [57, 60, 64] },  // Am
    { root: 41, tri: [53, 57, 60] },  // F
    { root: 48, tri: [60, 64, 67] },  // C
    { root: 43, tri: [55, 59, 62] },  // G
  ];
  // 16-step (one bar) patterns
  const KICK  = [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0];   // four-on-the-floor
  const CLAP  = [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0];   // beats 2 & 4
  const OHAT  = [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0];   // offbeat open hats
  const BASS  = [1,0,1,1, 0,1,1,0, 1,0,1,1, 0,1,1,0];   // syncopated bass
  const STAB  = [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,1];   // offbeat chord stabs
  const ARP   = [0,1,2,1, 3,2,1,2, 0,1,2,3, 4,3,2,1];   // arpeggio indices

  const M = {
    ctx:null, master:null, bus:null, delay:null, delayGain:null, noiseBuf:null,
    comp:null, on:false, muted:false, mode:'menu', ducked:false,
    bpm:126, step:0, nextTime:0, timer:null, sixteenth:0,
  };

  M.init = function (ctx) {
    if (M.ctx) return;
    M.ctx = ctx;
    M.sixteenth = (60 / M.bpm) / 4;
    // master -> compressor -> out
    M.master = ctx.createGain(); M.master.gain.value = 0;
    M.comp = ctx.createDynamicsCompressor();
    M.comp.threshold.value = -10; M.comp.ratio.value = 6; M.comp.release.value = 0.25;
    M.master.connect(M.comp).connect(ctx.destination);
    // sidechained bus (everything melodic pumps on the kick); kick goes direct
    M.bus = ctx.createGain(); M.bus.gain.value = 1; M.bus.connect(M.master);
    // feedback delay send for stabs / lead
    M.delay = ctx.createDelay(1.0);
    M.delay.delayTime.value = (60 / M.bpm) * 0.75;   // dotted-eighth
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    M.delayGain = ctx.createGain(); M.delayGain.gain.value = 0.5;
    M.delay.connect(fb).connect(M.delay);
    M.delay.connect(M.delayGain).connect(M.bus);
    // noise buffer for drums
    const n = ctx.sampleRate * 0.5;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    M.noiseBuf = buf;
  };

  function targetVol() {
    if (M.muted || !M.on) return 0;
    let v = M.mode === 'race' ? 0.5 : 0.3;
    if (M.ducked) v *= 0.35;
    return v;
  }
  function fade(){ if (M.master) M.master.gain.setTargetAtTime(targetVol(), M.ctx.currentTime, 0.4); }

  // ---- voices --------------------------------------------------------------
  function env(g, t, atk, dur, rel, peak) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + atk);
    g.gain.setValueAtTime(peak, t + Math.max(atk, dur - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  function kick(t) {
    const o = M.ctx.createOscillator(), g = M.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(165, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.11);
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    o.connect(g).connect(M.master); o.start(t); o.stop(t + 0.28);
    // click transient
    const c = M.ctx.createOscillator(), cg = M.ctx.createGain();
    c.type = 'square'; c.frequency.value = 1200;
    cg.gain.setValueAtTime(0.25, t); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
    c.connect(cg).connect(M.master); c.start(t); c.stop(t + 0.03);
    // sidechain pump on the melodic bus
    M.bus.gain.cancelScheduledValues(t);
    M.bus.gain.setValueAtTime(0.32, t + 0.001);
    M.bus.gain.linearRampToValueAtTime(1.0, t + M.sixteenth * 2.6);
  }
  function noise(t, dur, vol, type, freq, dest) {
    const s = M.ctx.createBufferSource(); s.buffer = M.noiseBuf;
    const g = M.ctx.createGain(), f = M.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; if (type === 'bandpass') f.Q.value = 1.2;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(dest || M.bus); s.start(t); s.stop(t + dur + 0.02);
  }
  function clap(t) {
    for (const d of [0, 0.012, 0.024]) noise(t + d, 0.13, 0.5, 'bandpass', 1600, M.bus);
  }
  function saw(freq, t, dur, vol, cutoff, dest, detune) {
    const o = M.ctx.createOscillator(), g = M.ctx.createGain(), f = M.ctx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.value = freq; if (detune) o.detune.value = detune;
    f.type = 'lowpass'; f.frequency.value = cutoff;
    env(g, t, 0.006, dur, dur * 0.4, vol);
    o.connect(f).connect(g).connect(dest || M.bus); o.start(t); o.stop(t + dur + 0.02);
  }
  function supersaw(freq, t, dur, vol, cutoff, dest) {  // 3 detuned saws
    for (const dt of [-12, 0, 12]) saw(freq, t, dur, vol / 3, cutoff, dest, dt);
  }
  function pluck(freq, t, dur, vol, dest) {
    const o = M.ctx.createOscillator(), g = M.ctx.createGain(), f = M.ctx.createBiquadFilter();
    o.type = 'square'; o.frequency.value = freq;
    f.type = 'lowpass'; f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(800, t + dur);
    env(g, t, 0.004, dur, dur * 0.6, vol);
    o.connect(f).connect(g).connect(dest || M.bus); o.start(t); o.stop(t + dur + 0.02);
  }

  // ---- sequencer -----------------------------------------------------------
  function scheduleStep(step, t) {
    const e = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const chord = PROG[bar];
    const race = M.mode === 'race';
    const sixteenth = M.sixteenth;

    if (KICK[e]) kick(t);
    if (race && CLAP[e]) clap(t);
    else if (CLAP[e]) clap(t);
    // hats
    if (e % 2 === 1) noise(t, 0.03, race ? 0.16 : 0.10, 'highpass', 9000, M.bus); // closed
    if (OHAT[e]) noise(t, 0.12, race ? 0.14 : 0.09, 'highpass', 8000, M.bus);     // open

    // bass (ducked via bus): sub root + a brighter saw an octave up for groove
    if (BASS[e]) {
      const hop = (e % 4 === 2) ? 12 : 0;     // little octave hops on the off-16ths
      saw(m2f(chord.root - 12), t, sixteenth * 1.1, race ? 0.30 : 0.20, 480, M.bus);
      saw(m2f(chord.root + hop), t, sixteenth * 1.0, race ? 0.16 : 0.11, 900, M.bus);
    }

    // chord stabs (supersaw, with delay send) on offbeats
    if (STAB[e]) {
      for (const note of chord.tri) {
        supersaw(m2f(note + 12), t, sixteenth * 1.6, race ? 0.10 : 0.07, 2600, M.bus);
        if (race) supersaw(m2f(note + 12), t, sixteenth * 1.6, 0.04, 2600, M.delay);
      }
    }

    // pad once every 2 bars (soft, sustained)
    if (e === 0 && bar % 2 === 0) {
      for (const note of chord.tri)
        saw(m2f(note), t, sixteenth * 16 * 2 * 0.95, 0.05, 1400, M.bus, 6);
    }

    // arpeggio lead (race only), 16ths through the delay
    if (race) {
      const ext = [chord.tri[0], chord.tri[1], chord.tri[2], chord.tri[0] + 12, chord.tri[1] + 12];
      const note = ext[ARP[e] % ext.length];
      pluck(m2f(note + 12), t, sixteenth * 0.9, 0.12, M.delay);
      pluck(m2f(note + 12), t, sixteenth * 0.9, 0.10, M.bus);
    }
  }
  function loop() {
    const ahead = M.ctx.currentTime + 0.12;
    while (M.nextTime < ahead) {
      scheduleStep(M.step, M.nextTime);
      M.nextTime += M.sixteenth;
      M.step = (M.step + 1) % 64;       // 4 bars × 16 steps
    }
    M.timer = setTimeout(loop, 25);
  }

  // ---- public API ----------------------------------------------------------
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

/* ============================================================================
 * DAYTONA USA — Web Arcade Edition
 * A pseudo-3D (segment-projection) arcade racer faithfully recreating the look
 * of SEGA's Daytona USA (1993) — the "Three-Seven Speedway" Beginner course:
 * the blue/red Hornet (#41) "Gallop" stock car, an Alpine canyon, guardrails,
 * pines, the slot-machine 777 gantry, a rainbow rev gauge, a checkpoint timer,
 * a 40-car field and the TRAFFIC minimap.
 *
 * Single-file engine, no dependencies. The road is a list of "segments" stacked
 * into the distance; each is projected world->screen with a perspective camera
 * and drawn back-to-front. Curves come from a per-segment horizontal force,
 * hills from per-segment world Y. Cars and props ride the same track.
 * ========================================================================== */
'use strict';

(function () {

// ---------------------------------------------------------------------------
// Canvas + constants
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

let WIDTH = canvas.width;
let HEIGHT = canvas.height;

const SEG_LEN      = 200;
const RUMBLE_LEN   = 3;
const ROAD_WIDTH   = 2000;
const LANES        = 3;
const DRAW_DIST    = 300;
const FOV          = 100;
const CAMERA_HEIGHT= 1000;
const FPS          = 60;
const STEP         = 1 / FPS;

const CENTRIFUGAL  = 0.32;
const OFFROAD_DECEL= 0.55;
const FIELD        = 40;       // 40-car field, like the arcade
const OPPONENTS    = FIELD - 1;

const cameraDepth = 1 / Math.tan((FOV / 2) * Math.PI / 180);

// Difficulty presets — name, top speed, curve multiplier, AI pace, laps, timer
const DIFFS = [
  { name:'THREE-SEVEN SPEEDWAY',  laps: 8, maxSpeed: 12000, curveMul: 0.7, aiSpeed: 0.80, startTime: 50, lapBonus: 26 },
  { name:'DINOSAUR CANYON',       laps: 4, maxSpeed: 13500, curveMul: 1.05, aiSpeed: 0.90, startTime: 60, lapBonus: 34 },
  { name:'SEA-SIDE STREET GALAXY',laps: 8, maxSpeed: 15000, curveMul: 1.35, aiSpeed: 0.98, startTime: 70, lapBonus: 30 },
];

// Road colours — Daytona's grey asphalt with white kerbs, alpine green verges
const COLORS = {
  LIGHT: { road:'#8a8d92', grass:'#3a7d44', rumble:'#e9e9ee', lane:'#e9e9ee', wall:'#9aa0a6' },
  DARK:  { road:'#7f8389', grass:'#347a3f', rumble:'#c23a32', lane:'#7f8389', wall:'#8b9197' },
  START: { road:'#cfd2d6', grass:'#3a7d44', rumble:'#cfd2d6', lane:'#cfd2d6', wall:'#9aa0a6' },
  FINISH:{ road:'#2a2d31', grass:'#3a7d44', rumble:'#2a2d31', lane:'#2a2d31', wall:'#9aa0a6' },
};

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const G = {
  state: 'menu',
  diff: 0,
  segments: [],
  trackLength: 0,
  position: 0,
  playerX: 0,
  speed: 0,
  maxSpeed: 12000,
  curveMul: 0.7,
  aiSpeedMul: 0.80,
  totalLaps: 8,
  lap: 1,
  lapTime: 0,
  lastLapTime: 0,
  bestLapTime: Infinity,
  totalTime: 0,
  timeLeft: 50,
  lapBonus: 26,
  cars: [],
  place: FIELD,
  countdown: 0,
  bannerTimer: 0,
  shake: 0,
  skid: 0,
  reversedLine: false,
  mapPts: [],
  mapBox: { minX:0, minY:0, w:1, h:1 },
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = { left:false, right:false, gas:false, brake:false, reverse:false };

function bindKey(code, down) {
  switch (code) {
    case 'ArrowLeft': case 'KeyA': keys.left = down; break;
    case 'ArrowRight': case 'KeyD': keys.right = down; break;
    case 'ArrowUp': case 'KeyW': keys.gas = down; break;
    case 'ArrowDown': case 'KeyS': keys.reverse = down; break;
    case 'Space': keys.brake = down; break;
  }
}
window.addEventListener('keydown', e => {
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyP' || e.code === 'Escape') { if (!e.repeat) togglePause(); return; }
  if (e.code === 'KeyM') { if (!e.repeat && window.GameMusic) window.GameMusic.toggleMute(); return; }
  bindKey(e.code, true);
  if (G.state === 'menu' && (e.code === 'Enter' || e.code === 'Space')) startRace();
});
window.addEventListener('keyup', e => bindKey(e.code, false));

function bindTouch(id, key) {
  const el = document.getElementById(id);
  const set = v => e => { e.preventDefault(); keys[key] = v; };
  el.addEventListener('touchstart', set(true), {passive:false});
  el.addEventListener('touchend', set(false), {passive:false});
  el.addEventListener('touchcancel', set(false), {passive:false});
}
bindTouch('tleft','left'); bindTouch('tright','right');
bindTouch('tgas','gas'); bindTouch('tbrake','brake');
if ('ontouchstart' in window) document.getElementById('touch').style.display = 'block';

// ---------------------------------------------------------------------------
// Track building
// ---------------------------------------------------------------------------
function lastY() { return G.segments.length === 0 ? 0 : G.segments[G.segments.length-1].p2.world.y; }

function addSegment(curve, y) {
  const n = G.segments.length;
  G.segments.push({
    index: n, curve,
    p1: { world:{ y: lastY(), z: n*SEG_LEN }, camera:{}, screen:{} },
    p2: { world:{ y: y,       z:(n+1)*SEG_LEN }, camera:{}, screen:{} },
    sprites: [],
    color: Math.floor(n / RUMBLE_LEN) % 2 ? COLORS.DARK : COLORS.LIGHT,
  });
}
function easeIn(a,b,p){ return a + (b-a)*Math.pow(p,2); }
function easeInOut(a,b,p){ return a + (b-a)*((-Math.cos(p*Math.PI)/2)+0.5); }

function addRoad(enter, hold, leave, curve, y) {
  const startY = lastY();
  const endY = startY + y * SEG_LEN;
  const total = enter + hold + leave;
  for (let i=0;i<enter;i++) addSegment(easeIn(0,curve,i/enter),    easeInOut(startY,endY,i/total));
  for (let i=0;i<hold;i++)  addSegment(curve,                      easeInOut(startY,endY,(enter+i)/total));
  for (let i=0;i<leave;i++) addSegment(easeInOut(curve,0,i/leave), easeInOut(startY,endY,(enter+hold+i)/total));
}

const RD = {
  LEN:  { SHORT:25, MEDIUM:50, LONG:100 },
  CURVE:{ EASY:2, MEDIUM:4, HARD:6 },
  HILL: { LOW:20, MEDIUM:40, HIGH:60 },
};

function straight(n){ n=n||RD.LEN.MEDIUM; addRoad(n,n,n,0,0); }
function hill(n,h){ addRoad(n,n,n,0,h); }
function curve(n,c,h){ addRoad(n,n,n,c,h||0); }
function sCurves(c){
  addRoad(RD.LEN.MEDIUM,RD.LEN.MEDIUM,RD.LEN.MEDIUM,-RD.CURVE.EASY*c, RD.HILL.LOW);
  addRoad(RD.LEN.MEDIUM,RD.LEN.MEDIUM,RD.LEN.MEDIUM, RD.CURVE.MEDIUM*c,RD.HILL.MEDIUM);
  addRoad(RD.LEN.MEDIUM,RD.LEN.MEDIUM,RD.LEN.MEDIUM, RD.CURVE.EASY*c, -RD.HILL.LOW);
  addRoad(RD.LEN.MEDIUM,RD.LEN.MEDIUM,RD.LEN.MEDIUM,-RD.CURVE.EASY*c, RD.HILL.MEDIUM);
  addRoad(RD.LEN.MEDIUM,RD.LEN.MEDIUM,RD.LEN.MEDIUM,-RD.CURVE.MEDIUM*c,-RD.HILL.MEDIUM);
}
function addSprite(seg, name, offset) { G.segments[seg].sprites.push({ name, offset }); }

function buildTrack() {
  G.segments = [];
  const c = G.curveMul;
  straight(RD.LEN.SHORT);
  straight(RD.LEN.LONG);
  curve(RD.LEN.MEDIUM, RD.CURVE.MEDIUM*c, RD.HILL.LOW);
  straight(RD.LEN.SHORT);
  curve(RD.LEN.LONG, RD.CURVE.HARD*c, 0);
  hill(RD.LEN.MEDIUM, RD.HILL.HIGH);
  sCurves(c);
  curve(RD.LEN.MEDIUM, -RD.CURVE.MEDIUM*c, RD.HILL.LOW);
  straight(RD.LEN.MEDIUM);
  curve(RD.LEN.LONG, -RD.CURVE.HARD*c, RD.HILL.MEDIUM);
  hill(RD.LEN.MEDIUM, -RD.HILL.MEDIUM);
  sCurves(c);
  curve(RD.LEN.MEDIUM, RD.CURVE.EASY*c, -RD.HILL.LOW);
  straight(RD.LEN.SHORT);
  curve(RD.LEN.LONG, RD.CURVE.HARD*c, RD.HILL.LOW);
  hill(RD.LEN.MEDIUM, RD.HILL.MEDIUM);
  straight(RD.LEN.MEDIUM);
  curve(RD.LEN.LONG, RD.CURVE.MEDIUM*c, 0);
  straight(RD.LEN.LONG);

  // Roadside dressing: continuous guardrails + pines + occasional cliffs/signs
  for (let n = 4; n < G.segments.length; n++) {
    // guardrails hug both sides every couple of segments
    if (n % 2 === 0) { addSprite(n, 'rail', -1.15); addSprite(n, 'rail', 1.15); }
    // pines and cliffs further out, alternating, with gaps
    if (n % 7 === 0) addSprite(n, Math.random()<0.5?'pine':'cliff', -(1.7 + Math.random()*1.6));
    if (n % 7 === 3) addSprite(n, Math.random()<0.5?'pine':'cliff',  (1.7 + Math.random()*1.6));
    if (n % 23 === 0) addSprite(n, 'sign', (Math.random()<0.5?-1:1)*1.5);
  }
  // start/finish line + 777 gantry
  for (let i=0;i<RUMBLE_LEN;i++) { G.segments[i].color = COLORS.START; G.segments[G.segments.length-1-i].color = COLORS.FINISH; }
  addSprite(3, 'gantry', 0);

  G.trackLength = G.segments.length * SEG_LEN;
  buildMinimap();
}

// Integrate segment headings into a 2D loop for the TRAFFIC minimap
function buildMinimap() {
  let x=0, y=0, heading=0;
  let minX=1e9, minY=1e9, maxX=-1e9, maxY=-1e9;
  G.mapPts = [];
  for (const seg of G.segments) {
    heading += seg.curve * 0.0009;
    x += Math.sin(heading);
    y += Math.cos(heading);
    G.mapPts.push({x,y});
    if (x<minX)minX=x; if (x>maxX)maxX=x; if (y<minY)minY=y; if (y>maxY)maxY=y;
  }
  G.mapBox = { minX, minY, w: Math.max(1,maxX-minX), h: Math.max(1,maxY-minY) };
}

function findSegment(z) { return G.segments[Math.floor(z / SEG_LEN) % G.segments.length]; }

// ---------------------------------------------------------------------------
// Opponent cars — 39 rivals spread across the whole track in varied liveries
// ---------------------------------------------------------------------------
const LIVERIES = ['#e23b3b','#2f6cff','#22c55e','#f59e0b','#a855f7','#06b6d4',
                  '#ec4899','#facc15','#fb7185','#4ade80','#38bdf8','#fb923c','#ffffff'];
// Lay the 40-car field out as a staggered starting grid AHEAD of the player,
// so you start near the back (like the arcade's "33/40") and chase them down.
function resetCars() {
  G.cars = [];
  // four grid columns that deliberately leave a clear centre channel so the
  // player (starting at offset 0) isn't rammed off the line by a car ahead
  const laneX = [-0.75, 0.75, -0.4, 0.4];
  for (let i=0;i<OPPONENTS;i++) {
    const row = Math.floor(i / 4);               // 4 cars per row
    // stagger the pack up the road ahead so it sits at a clear racing distance
    // (player starts at the back and chases) without filling the windshield
    const z = ((10 + row * 2.4) * SEG_LEN) % G.trackLength;
    const lane = i % 4;
    G.cars.push({
      offset: laneX[lane],
      targetLane: laneX[lane],
      z,
      // each rival has its own pace; cars further up the grid are a touch quicker
      basePace: (0.80 + Math.random()*0.20) * G.aiSpeedMul,
      speed: 0,
      color: LIVERIES[i % LIVERIES.length],
      lap: 1, progress: 0,
      jitter: Math.random()*Math.PI*2,            // phase for small lane wandering
    });
  }
}

function updateCars(dt) {
  for (const car of G.cars) {
    const seg = findSegment(car.z);

    // --- desired pace: brake for sharp curves, rubber-band toward the player ---
    const look = G.segments[(seg.index + 8) % G.segments.length];
    let pace = car.basePace;
    if (Math.abs(look.curve) > 4) pace *= 0.82;       // ease off for hard bends
    else if (Math.abs(look.curve) > 2) pace *= 0.92;
    const gap = loopDelta(car.z, G.position) / G.trackLength;   // + = ahead of player
    if (gap > 0.04) pace *= 0.94;                     // leaders wait up a little
    else if (gap < -0.04) pace *= 1.06;               // backmarkers push on
    const targetSpeed = G.maxSpeed * Math.max(0.45, Math.min(1.02, pace));
    car.speed = approach(car.speed, targetSpeed, (G.maxSpeed/3) * dt);

    // --- choose a lane: hug the inside of the coming curve, else hold lane ---
    if (look.curve > 2)      car.targetLane = -0.62;
    else if (look.curve < -2) car.targetLane = 0.62;

    // --- avoidance: dodge the player and other rivals just ahead ---
    let dodge = 0;
    const dzP = loopDelta(car.z, G.position);
    if (dzP > 0 && dzP < SEG_LEN*5 && Math.abs(car.offset - G.playerX) < 0.7)
      dodge += car.offset >= G.playerX ? 1 : -1;
    for (const other of G.cars) {
      if (other === car) continue;
      const dz = loopDelta(other.z, car.z);
      if (dz > 0 && dz < SEG_LEN*4 && Math.abs(other.offset - car.offset) < 0.6) {
        dodge += car.offset >= other.offset ? 1 : -1;
        car.speed = Math.min(car.speed, other.speed); // tuck in behind, no clipping
      }
    }
    let desired = car.targetLane + dodge * 0.7 + Math.sin(car.jitter + car.z*0.0003)*0.06;
    desired = Math.max(-0.95, Math.min(0.95, desired));
    car.offset = approach(car.offset, desired, dt * 1.6);

    // --- advance ---
    car.z += car.speed * dt;
    if (car.z >= G.trackLength) { car.z -= G.trackLength; car.lap++; }
    car.progress = car.lap * G.trackLength + car.z;
  }
}
function approach(v, target, amt){ return v > target ? Math.max(target, v-amt) : Math.min(target, v+amt); }
function loopDelta(a, b) {
  let d = a - b;
  while (d >  G.trackLength/2) d -= G.trackLength;
  while (d < -G.trackLength/2) d += G.trackLength;
  return d;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
let AC=null, engineOsc=null, engineGain=null, engineFilter=null;
function initAudio() {
  if (AC) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    engineOsc = AC.createOscillator(); engineOsc.type = 'sawtooth';
    engineFilter = AC.createBiquadFilter(); engineFilter.type = 'lowpass'; engineFilter.frequency.value = 800;
    engineGain = AC.createGain(); engineGain.gain.value = 0;
    engineOsc.connect(engineFilter).connect(engineGain).connect(AC.destination);
    engineOsc.start();
    if (window.GameMusic) window.GameMusic.init(AC);
  } catch (e) { AC = null; }
}
function updateEngine() {
  if (!AC) return;
  const r = Math.abs(G.speed) / G.maxSpeed;
  engineOsc.frequency.setTargetAtTime(60 + r*220 + (G.skid>0?40:0), AC.currentTime, 0.05);
  engineFilter.frequency.setTargetAtTime(500 + r*2500, AC.currentTime, 0.05);
  engineGain.gain.setTargetAtTime(G.state==='racing' ? 0.04 + r*0.10 : 0, AC.currentTime, 0.1);
}
function beep(freq, dur, type, vol) {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type||'square'; o.frequency.value = freq; g.gain.value = vol||0.15;
  g.gain.setTargetAtTime(0.0001, AC.currentTime + dur*0.5, dur*0.3);
  o.connect(g).connect(AC.destination); o.start(); o.stop(AC.currentTime + dur);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
function update(dt) {
  if (G.state === 'countdown') {
    G.countdown -= dt;
    const n = Math.ceil(G.countdown);
    const el = document.getElementById('countdown');
    if (G.countdown <= 0) { G.state='racing'; el.classList.add('hidden'); beep(880,0.4,'square',0.2); }
    else { el.textContent = n; if (el.dataset.last != n){ el.dataset.last=n; beep(440,0.15,'square',0.15);} }
    return;
  }
  if (G.state !== 'racing') return;

  const playerSeg = findSegment(G.position + CAMERA_HEIGHT);
  const speedPercent = G.speed / G.maxSpeed;

  const dx = dt * 2 * speedPercent;
  if (keys.left)  G.playerX -= dx;
  if (keys.right) G.playerX += dx;
  G.playerX -= dx * speedPercent * playerSeg.curve * CENTRIFUGAL;

  const accel = G.maxSpeed / 4.5;
  const brake = -G.maxSpeed / 2.2;
  const decel = -G.maxSpeed / 5.5;
  if (keys.gas && !keys.reverse) G.speed += accel * dt;
  else if (keys.reverse) G.speed += brake * dt;
  else G.speed = approach(G.speed, 0, -decel * dt);
  if (keys.brake) G.speed = approach(G.speed, 0, -brake * dt);

  G.skid = Math.max(0, G.skid - dt);
  if ((G.playerX < -1 || G.playerX > 1) && G.speed > G.maxSpeed*0.2) {
    G.speed += decel * dt * 2;
    G.speed *= 1 - OFFROAD_DECEL * dt;
    G.shake = 6;
    if (Math.random()<0.1) beep(120,0.05,'sawtooth',0.05);
  }
  if (G.speed > 0) {
    for (const car of G.cars) {
      const d = loopDelta(car.z, G.position);
      if (d > 0 && d < SEG_LEN*1.4 && Math.abs(G.playerX - car.offset) < 0.9) {
        G.speed = car.speed * 0.85;
        // nudge to the open side, but gently and clamped so a near head-on
        // tap bumps you aside rather than catapulting you off the track
        const side = (G.playerX >= car.offset) ? 1 : -1;
        G.playerX = Math.max(-1.0, Math.min(1.0, G.playerX + side * 0.18));
        G.shake = 10; G.skid = 0.3; beep(90,0.12,'sawtooth',0.18);
      }
    }
  }
  G.speed = Math.max(-G.maxSpeed*0.25, Math.min(G.speed, G.maxSpeed));
  if (Math.abs(G.playerX) > 0.7 && Math.abs(playerSeg.curve) > 2 && G.speed > G.maxSpeed*0.6)
    G.skid = Math.max(G.skid, 0.2);

  G.position += G.speed * dt;
  while (G.position >= G.trackLength) {
    G.position -= G.trackLength;
    if (G.reversedLine) { G.reversedLine = false; G.lap++; }
    else onLapComplete();
  }
  while (G.position < 0) { G.position += G.trackLength; G.lap--; G.reversedLine = true; }
  G.playerX = Math.max(-2.2, Math.min(2.2, G.playerX));

  G.lapTime += dt; G.totalTime += dt;
  G.timeLeft -= dt;
  if (G.timeLeft <= 0) { G.timeLeft = 0; timeUp(); return; }
  G.shake = Math.max(0, G.shake - dt*30);

  updateCars(dt);
  const myProg = G.lap * G.trackLength + G.position;
  let ahead = 0;
  for (const car of G.cars) if (car.progress > myProg) ahead++;
  G.place = ahead + 1;
}

function onLapComplete() {
  G.lastLapTime = G.lapTime;
  if (G.lapTime < G.bestLapTime) { G.bestLapTime = G.lapTime; flashBanner('FAST LAP!'); beep(1046,0.4,'square',0.18); }
  G.lapTime = 0;
  G.lap++;
  G.timeLeft += G.lapBonus;                       // checkpoint extends the clock
  flashBanner('CHECKPOINT +' + G.lapBonus);
  if (G.lap > G.totalLaps) { finishRace(true); return; }
  beep(660,0.25,'square',0.15);
}

function timeUp() { flashBanner('TIME UP'); finishRace(false); }

function finishRace(completed) {
  G.state = 'finished';
  if (window.GameMusic) window.GameMusic.setMode('menu');
  const place = G.place;
  const ord = (place) + (['th','st','nd','rd'][(place%100>>3^1)&&place%10] || 'th');
  const win = completed && place === 1;
  const el = document.getElementById('overlay');
  el.innerHTML = `
    <h1 class="title">${win ? 'YOU <span class="red">WIN!</span>' : (completed ? 'FINISH' : 'TIME <span class="red">UP</span>')}</h1>
    <div class="subtitle ${win?'flash':''}">${win ? 'DAYTONA!  CHAMPION!' : (completed ? 'GOOD RACE — TRY AGAIN' : 'OUT OF TIME — TRY AGAIN')}</div>
    <div class="menu-card">
      <h2>RESULTS</h2>
      <div class="keys" style="grid-template-columns:auto 1fr;">
        <b>POSITION</b><span>${ord} of ${FIELD}</span>
        <b>LAPS</b><span>${Math.min(G.lap, G.totalLaps)} / ${G.totalLaps}</span>
        <b>TOTAL TIME</b><span>${fmtArcade(G.totalTime)}</span>
        <b>BEST LAP</b><span>${G.bestLapTime===Infinity?'--':fmtArcade(G.bestLapTime)}</span>
      </div>
      <button class="btn" id="againBtn">RACE AGAIN ▶</button>
    </div>
    <div class="credit">A homage to SEGA's Daytona USA (1993). Fan-made, non-commercial.</div>`;
  el.classList.remove('hidden');
  document.getElementById('againBtn').onclick = () => showMenu();
  beep(win?1318:220, 0.6, 'square', 0.2);
}

function flashBanner(text) {
  const b = document.getElementById('banner');
  b.textContent = text; b.classList.remove('hidden'); G.bannerTimer = 1.4;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function project(p, camX, camY, camZ) {
  p.camera.x = (p.world.x || 0) - camX;
  p.camera.y = (p.world.y || 0) - camY;
  p.camera.z = (p.world.z || 0) - camZ;
  const scale = cameraDepth / p.camera.z;
  p.screen.scale = scale;
  p.screen.x = Math.round((WIDTH/2) + (scale * p.camera.x * WIDTH/2));
  p.screen.y = Math.round((HEIGHT/2) - (scale * p.camera.y * HEIGHT/2));
  p.screen.w = Math.round(scale * ROAD_WIDTH * WIDTH/2);
}
function polygon(x1,y1,x2,y2,x3,y3,x4,y4,color){
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.lineTo(x3,y3); ctx.lineTo(x4,y4);
  ctx.closePath(); ctx.fill();
}

function drawBackground(baseSeg, playerX) {
  // Alpine sky
  const sky = ctx.createLinearGradient(0,0,0,HEIGHT*0.55);
  sky.addColorStop(0, '#1b62c9'); sky.addColorStop(1, '#86c5ff');
  ctx.fillStyle = sky; ctx.fillRect(0,0,WIDTH,HEIGHT);
  const horizon = HEIGHT*0.46;
  // Snow-capped mountains, parallax with curve + steering
  const off = -(G.position*0.0010 + playerX*30);
  for (let layer=0; layer<2; layer++) {
    const amp = layer===0 ? 150 : 95;
    const baseY = horizon - layer*8;
    ctx.fillStyle = layer===0 ? '#5c6f86' : '#7d90a8';
    ctx.beginPath(); ctx.moveTo(-50, baseY+60);
    const span = 200 + layer*60;
    for (let x=-50; x<=WIDTH+span; x+=span) {
      const px = x + ((off*(layer+1)) % span);
      const h = amp * (0.55 + 0.45*Math.abs(Math.sin((x+layer*99)*0.6)));
      ctx.lineTo(px - span/2, baseY - h);
      ctx.lineTo(px, baseY + 30);
    }
    ctx.lineTo(WIDTH+span, baseY+60); ctx.closePath(); ctx.fill();
    // snow caps on the front range
    if (layer===0) {
      ctx.fillStyle = '#eef3f7';
      for (let x=-50; x<=WIDTH+span; x+=span) {
        const px = x + ((off*(layer+1)) % span);
        const h = amp * (0.55 + 0.45*Math.abs(Math.sin((x+layer*99)*0.6)));
        ctx.beginPath();
        ctx.moveTo(px - span/2, baseY - h);
        ctx.lineTo(px - span/2 + 26, baseY - h + 34);
        ctx.lineTo(px - span/2 - 24, baseY - h + 34);
        ctx.closePath(); ctx.fill();
      }
    }
  }
  // green tree-line band feeding into the verges
  ctx.fillStyle = '#2f6b39'; ctx.fillRect(0, horizon, WIDTH, HEIGHT*0.06);
  void baseSeg;
}

function render() {
  ctx.clearRect(0,0,WIDTH,HEIGHT);
  const baseSegment = findSegment(G.position);
  const basePercent = (G.position % SEG_LEN) / SEG_LEN;
  const playerSeg = findSegment(G.position + CAMERA_HEIGHT);
  const playerPercent = ((G.position+CAMERA_HEIGHT) % SEG_LEN)/SEG_LEN;
  const playerY = playerSeg.p1.world.y + (playerSeg.p2.world.y-playerSeg.p1.world.y)*playerPercent;

  let sx=0, sy=0;
  if (G.shake>0){ sx=(Math.random()-0.5)*G.shake; sy=(Math.random()-0.5)*G.shake; }
  ctx.save(); ctx.translate(sx, sy);
  drawBackground(baseSegment, G.playerX);

  let x=0, dx=-(baseSegment.curve*basePercent), maxY=HEIGHT;
  const cameraX = G.playerX * ROAD_WIDTH;
  const cameraZ = G.position - (G.position % 1);
  const cameraY = CAMERA_HEIGHT + playerY;

  const renderSegs = [];
  for (let n=0; n<DRAW_DIST; n++) {
    const seg = G.segments[(baseSegment.index + n) % G.segments.length];
    seg.looped = seg.index < baseSegment.index;
    seg.clip = maxY;
    const offZ = seg.looped ? G.trackLength : 0;
    project(seg.p1, cameraX - x,      cameraY, cameraZ - offZ);
    project(seg.p2, cameraX - x - dx, cameraY, cameraZ - offZ);
    x += dx; dx += seg.curve;
    if (seg.p1.camera.z <= cameraDepth || seg.p2.screen.y >= seg.p1.screen.y || seg.p2.screen.y >= maxY) continue;
    drawSegment(seg);
    maxY = seg.p2.screen.y;
    renderSegs.push(seg);
  }
  for (let i=renderSegs.length-1; i>=0; i--) {
    const seg = renderSegs[i];
    for (const sp of seg.sprites) drawSprite(seg, sp);
    for (const car of G.cars) if (findSegment(car.z).index === seg.index) drawCar(seg, car);
  }
  drawPlayerCar();
  ctx.restore();

  if (G.bannerTimer>0){ G.bannerTimer-=STEP; if (G.bannerTimer<=0) document.getElementById('banner').classList.add('hidden'); }
  drawArcadeHUD();
  drawTextHUD();
}

function drawSegment(seg) {
  const p1=seg.p1.screen, p2=seg.p2.screen, col=seg.color;
  ctx.fillStyle = col.grass; ctx.fillRect(0, p2.y, WIDTH, p1.y - p2.y);
  const r1=p1.w/5, r2=p2.w/5;
  polygon(p1.x-p1.w-r1,p1.y, p1.x-p1.w,p1.y, p2.x-p2.w,p2.y, p2.x-p2.w-r2,p2.y, col.rumble);
  polygon(p1.x+p1.w+r1,p1.y, p1.x+p1.w,p1.y, p2.x+p2.w,p2.y, p2.x+p2.w+r2,p2.y, col.rumble);
  polygon(p1.x-p1.w,p1.y, p1.x+p1.w,p1.y, p2.x+p2.w,p2.y, p2.x-p2.w,p2.y, col.road);
  if (col!==COLORS.START && col!==COLORS.FINISH) {
    // dashed centre + solid lane edges (only on lighter segments for the dash gap)
    const l1=p1.w/26, l2=p2.w/26;
    for (let lane=1; lane<LANES; lane++){
      const lx1 = p1.x - p1.w + (2*p1.w/LANES)*lane;
      const lx2 = p2.x - p2.w + (2*p2.w/LANES)*lane;
      if (lane===2 || col===COLORS.LIGHT)
        polygon(lx1-l1,p1.y, lx1+l1,p1.y, lx2+l2,p2.y, lx2-l2,p2.y, col.lane);
    }
  } else {
    drawChecker(p1, p2);
  }
}
function drawChecker(p1, p2) {
  const cols=10;
  for (let i=0;i<cols;i++){
    if (i%2===0) continue;
    const a1=p1.x-p1.w+(2*p1.w/cols)*i, b1=p1.x-p1.w+(2*p1.w/cols)*(i+1);
    const a2=p2.x-p2.w+(2*p2.w/cols)*i, b2=p2.x-p2.w+(2*p2.w/cols)*(i+1);
    polygon(a1,p1.y,b1,p1.y,b2,p2.y,a2,p2.y,'#1c1c1c');
  }
}

function drawSprite(seg, sp) {
  const p = seg.p1.screen;
  if (p.scale<=0 || p.w<=0) return;
  const w = p.w * 0.5;                 // size relative to the projected road width
  if (w < 2) return;
  const sx = p.x + (sp.offset * p.w);  // offset measured in road-half-widths
  drawProp(sp.name, sx, p.y, w, w);
}

function drawProp(name, x, y, w, h) {
  ctx.save();
  switch(name) {
    case 'rail': {                                  // metal guardrail post + beam
      const dir = x < WIDTH/2 ? 1 : -1;
      ctx.fillStyle = '#7c8893'; ctx.fillRect(x-w*0.03, y-h*0.55, w*0.06, h*0.55);
      ctx.fillStyle = '#c3ccd4'; ctx.fillRect(x - (dir>0?0:w*0.5), y-h*0.5, w*0.5, h*0.16);
      ctx.fillStyle = '#8a96a0'; ctx.fillRect(x - (dir>0?0:w*0.5), y-h*0.34, w*0.5, h*0.05);
      break;
    }
    case 'pine': {                                  // alpine conifer
      ctx.fillStyle = '#5b4226'; ctx.fillRect(x-w*0.05, y-h*0.5, w*0.1, h*0.5);
      ctx.fillStyle = '#1f6b2e';
      for (let t=0;t<3;t++){
        const ty = y - h*0.5 - t*h*0.45;
        const tw = w*(0.8 - t*0.18);
        ctx.beginPath(); ctx.moveTo(x, ty - h*0.7);
        ctx.lineTo(x+tw, ty); ctx.lineTo(x-tw, ty); ctx.closePath(); ctx.fill();
      }
      // a touch of snow
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.moveTo(x, y-h*1.65); ctx.lineTo(x+w*0.18,y-h*1.45); ctx.lineTo(x-w*0.18,y-h*1.45); ctx.closePath(); ctx.fill();
      break;
    }
    case 'cliff': {                                 // grey rocky canyon wall chunk
      ctx.fillStyle = '#9aa0a6';
      ctx.beginPath();
      ctx.moveTo(x-w*0.9, y);
      ctx.lineTo(x-w*0.6, y-h*1.6);
      ctx.lineTo(x-w*0.1, y-h*1.2);
      ctx.lineTo(x+w*0.4, y-h*1.9);
      ctx.lineTo(x+w*0.9, y-h*0.9);
      ctx.lineTo(x+w*0.8, y);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#7d848b';
      ctx.beginPath(); ctx.moveTo(x+w*0.4,y-h*1.9); ctx.lineTo(x+w*0.9,y-h*0.9); ctx.lineTo(x+w*0.55,y-h*0.8); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#eef3f7';                    // snow on top
      ctx.beginPath(); ctx.moveTo(x+w*0.4,y-h*1.9); ctx.lineTo(x+w*0.55,y-h*1.6); ctx.lineTo(x+w*0.2,y-h*1.5); ctx.closePath(); ctx.fill();
      break;
    }
    case 'sign': {
      ctx.fillStyle = '#444'; ctx.fillRect(x-w*0.04, y-h*0.9, w*0.08, h*0.9);
      ctx.fillStyle = '#ffd400';
      ctx.beginPath(); ctx.moveTo(x,y-h*1.4); ctx.lineTo(x+w*0.4,y-h*1.0); ctx.lineTo(x,y-h*0.6); ctx.lineTo(x-w*0.4,y-h*1.0); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#222'; ctx.fillRect(x-w*0.16, y-h*1.08, w*0.32, h*0.12);
      break;
    }
    case 'gantry': {                                // the 777 slot-machine start gantry
      const gw = w*2.4;
      ctx.strokeStyle = '#b9c0c7'; ctx.lineWidth = Math.max(2,w*0.14);
      ctx.beginPath();
      ctx.moveTo(x-gw, y); ctx.lineTo(x-gw, y-h*3.0);
      ctx.lineTo(x+gw, y-h*3.0); ctx.lineTo(x+gw, y); ctx.stroke();
      // red banner
      ctx.fillStyle = '#c1272d'; ctx.fillRect(x-gw, y-h*3.5, gw*2, h*0.7);
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(7,w*0.5)}px Arial`;
      ctx.textAlign='center'; ctx.fillText('DAYTONA  USA', x, y-h*3.05);
      // slot 7-7-7 box
      const bw = w*1.6, bh = h*0.9;
      ctx.fillStyle = '#1a1a1a'; ctx.fillRect(x-bw/2, y-h*2.7, bw, bh);
      ctx.fillStyle = '#ffd400'; ctx.font = `bold ${Math.max(8,bh*0.7)}px Arial`;
      ctx.fillText('7  7  7', x, y-h*2.7+bh*0.72);
      break;
    }
  }
  ctx.restore();
}

// Opponent cars (compact stock-car silhouette in their livery)
function drawCar(seg, car) {
  const p = seg.p1.screen;
  if (p.scale<=0 || p.w<=0) return;
  const w = p.w * 0.40;                 // size relative to the projected road width
  if (w < 4) return;
  const x = p.x + (car.offset * p.w);   // offset measured in road-half-widths
  drawStockCar(x, p.y, w, w*0.62, car.color, null);
}

function drawStockCar(x, y, w, h, color, livery) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.ellipse(x, y, w*0.62, h*0.16, 0, 0, Math.PI*2); ctx.fill();
  // white rear bumper
  ctx.fillStyle = '#e8e8ec'; roundRect(x-w*0.52, y-h*0.16, w*1.04, h*0.22, w*0.05);
  // body
  ctx.fillStyle = color; roundRect(x-w*0.5, y-h*0.95, w, h*0.86, w*0.10);
  // wheels
  ctx.fillStyle = '#111'; ctx.fillRect(x-w*0.58, y-h*0.6, w*0.12, h*0.46); ctx.fillRect(x+w*0.46, y-h*0.6, w*0.12, h*0.46);
  if (livery === 'hornet') {
    // Hornet: blue lower, red mid stripe (HORNET), blue roof (Gallop), roll cage
    ctx.fillStyle = '#1f54c8'; roundRect(x-w*0.5, y-h*0.55, w, h*0.46, w*0.08);     // lower blue
    ctx.fillStyle = '#d6262b'; ctx.fillRect(x-w*0.5, y-h*0.62, w, h*0.16);          // red mid
    ctx.fillStyle = '#2056cf'; roundRect(x-w*0.40, y-h*1.18, w*0.80, h*0.56, w*0.08); // roof blue
    ctx.fillStyle = '#d6262b'; ctx.fillRect(x-w*0.46, y-h*1.18, w*0.06, h*0.56);    // red rails
    ctx.fillStyle = '#d6262b'; ctx.fillRect(x+w*0.40, y-h*1.18, w*0.06, h*0.56);
    // rear window + roll-cage bars
    ctx.fillStyle = '#101b2e'; roundRect(x-w*0.30, y-h*1.10, w*0.60, h*0.40, w*0.05);
    ctx.strokeStyle = '#9fb2cf'; ctx.lineWidth = Math.max(1,w*0.035);
    for (let b=0;b<4;b++){ const bx = x-w*0.24 + b*(w*0.48/3); ctx.beginPath(); ctx.moveTo(bx,y-h*1.08); ctx.lineTo(bx,y-h*0.72); ctx.stroke(); }
    if (w > 26) {
      ctx.fillStyle = '#ffd400'; ctx.font = `italic bold ${w*0.22}px Georgia`; ctx.textAlign='center';
      ctx.fillText('Gallop', x, y-h*1.22);
      ctx.fillStyle = '#ffe44d'; ctx.font = `bold ${w*0.18}px Arial`;
      ctx.fillText('HORNET', x, y-h*0.50);
      ctx.fillStyle = '#fff'; ctx.font = `bold ${w*0.26}px Arial`;
      ctx.fillText('41', x, y-h*0.86);
    }
  } else {
    // generic rival: tinted roof + windshield + a number
    ctx.fillStyle = shade(color,-34); roundRect(x-w*0.34, y-h*1.16, w*0.68, h*0.5, w*0.08);
    ctx.fillStyle = '#16263f'; roundRect(x-w*0.27, y-h*1.10, w*0.54, h*0.34, w*0.05);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = Math.max(1,w*0.03);
    for (let b=0;b<3;b++){ const bx=x-w*0.18+b*(w*0.36/2); ctx.beginPath(); ctx.moveTo(bx,y-h*1.08); ctx.lineTo(bx,y-h*0.78); ctx.stroke(); }
  }
  ctx.restore();
}

function shade(hex, amt) {
  let c = hex.replace('#',''); if (c.length===3) c=c.split('').map(s=>s+s).join('');
  const r=Math.max(0,Math.min(255,parseInt(c.substr(0,2),16)+amt));
  const g=Math.max(0,Math.min(255,parseInt(c.substr(2,2),16)+amt));
  const b=Math.max(0,Math.min(255,parseInt(c.substr(4,2),16)+amt));
  return `rgb(${r},${g},${b})`;
}
function roundRect(x,y,w,h,r){
  ctx.beginPath(); ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath(); ctx.fill();
}

function drawPlayerCar() {
  const cx=WIDTH/2, cy=HEIGHT-HEIGHT*0.12, w=WIDTH*0.20, h=w*0.62;
  const bounce = Math.sin(G.position*0.02) * (Math.abs(G.speed)/G.maxSpeed) * 3;
  const lean = (keys.left?-1:0) + (keys.right?1:0);
  ctx.save(); ctx.translate(cx + lean*8, cy + bounce);
  if (G.skid>0) for (let i=0;i<5;i++){
    ctx.fillStyle = `rgba(225,225,225,${0.25*Math.random()})`;
    ctx.beginPath(); ctx.arc(-w*0.35+Math.random()*w*0.7, h*0.2+Math.random()*12, 9+Math.random()*12, 0, Math.PI*2); ctx.fill();
  }
  drawStockCar(0, 0, w, h, '#1f54c8', 'hornet');
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Arcade HUD drawn on the canvas: rainbow rev gauge + TRAFFIC minimap
// ---------------------------------------------------------------------------
function drawArcadeHUD() {
  // --- Rev gauge, top-centre ---
  const gx=WIDTH/2, gy=HEIGHT*0.275, gr=Math.min(WIDTH,HEIGHT)*0.10;
  const a0=Math.PI*1.18, a1=Math.PI*1.82;     // convex-up "rainbow" arc across the top
  ctx.save();
  ctx.lineWidth = Math.max(5, gr*0.16); ctx.lineCap='round';
  const ticks=10;
  for (let i=0;i<ticks;i++){
    const t0=i/ticks, t1=(i+1)/ticks;
    ctx.strokeStyle = `hsl(${(1-t0)*230}, 90%, 55%)`;   // blue->red rainbow
    ctx.beginPath(); ctx.arc(gx, gy, gr, lerp(a0,a1,t0), lerp(a0,a1,t1)); ctx.stroke();
  }
  // tick numbers 0..10 above the arc
  ctx.fillStyle='#fff'; ctx.font=`bold ${Math.max(7,gr*0.18)}px Arial`; ctx.textAlign='center'; ctx.textBaseline='middle';
  for (let i=0;i<=ticks;i++){
    const a=lerp(a0,a1,i/ticks), rr=gr+gr*0.28;
    ctx.fillText(i, gx+Math.cos(a)*rr, gy+Math.sin(a)*rr);
  }
  // needle pivoting from the gauge centre
  const rev = Math.min(1, Math.abs(G.speed)/G.maxSpeed);
  const na = lerp(a0,a1,rev);
  ctx.strokeStyle='#ffd400'; ctx.lineWidth=Math.max(2,gr*0.07); ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(gx,gy); ctx.lineTo(gx+Math.cos(na)*gr*0.92, gy+Math.sin(na)*gr*0.92); ctx.stroke();
  ctx.fillStyle='#ffd400'; ctx.beginPath(); ctx.arc(gx,gy,gr*0.11,0,Math.PI*2); ctx.fill();
  // speed % just below the pivot (green, like the screenshot)
  ctx.fillStyle='#2bd451'; ctx.font=`bold ${Math.max(12,gr*0.40)}px Arial`; ctx.textBaseline='alphabetic';
  ctx.fillText(Math.round(rev*100)+'%', gx, gy+gr*0.62);
  ctx.restore();

  // --- TRAFFIC minimap, right side ---
  drawMinimap();
}

function drawMinimap() {
  if (!G.mapPts.length) return;
  const size = Math.min(WIDTH,HEIGHT)*0.18;
  const pad = WIDTH*0.012;
  const bx = WIDTH - size - pad, by = HEIGHT*0.30;
  const box = G.mapBox;
  const sc = (size*0.82) / Math.max(box.w, box.h);
  const ox = bx + size/2 - (box.minX + box.w/2)*sc;
  const oy = by + size/2 - (box.minY + box.h/2)*sc;
  ctx.save();
  // frame
  ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=2;
  roundRectStroke(bx, by, size, size, 8);
  // track loop
  ctx.strokeStyle='#cfd6dd'; ctx.lineWidth=Math.max(2,size*0.03);
  ctx.beginPath();
  for (let i=0;i<G.mapPts.length;i+=2){
    const p=G.mapPts[i]; const X=ox+p.x*sc, Y=oy+p.y*sc;
    if (i===0) ctx.moveTo(X,Y); else ctx.lineTo(X,Y);
  }
  ctx.closePath(); ctx.stroke();
  // rivals (small) — only the nearest dozen to keep it readable
  const mi = Math.floor(G.position/SEG_LEN);
  for (const car of G.cars){
    if (Math.abs(loopDelta(car.z, G.position)) > G.trackLength*0.35) continue;
    const idx = Math.floor(car.z/SEG_LEN) % G.mapPts.length;
    const p = G.mapPts[idx]; if (!p) continue;
    ctx.fillStyle = '#ff7fc4'; ctx.fillRect(ox+p.x*sc-2, oy+p.y*sc-2, 4, 4);
  }
  // player (red, larger)
  const pp = G.mapPts[mi % G.mapPts.length];
  if (pp){ ctx.fillStyle='#ff2a2a'; ctx.fillRect(ox+pp.x*sc-3, oy+pp.y*sc-3, 6, 6); }
  ctx.restore();
  // label
  ctx.fillStyle='#fff'; ctx.font=`bold ${Math.max(9,size*0.10)}px Arial`; ctx.textAlign='center';
  ctx.fillText('TRAFFIC', bx+size/2, by+size+size*0.13);
}
function roundRectStroke(x,y,w,h,r){
  ctx.beginPath(); ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath(); ctx.stroke();
}
function lerp(a,b,t){ return a+(b-a)*t; }

// ---------------------------------------------------------------------------
// Text HUD (DOM)
// ---------------------------------------------------------------------------
function fmtArcade(t) {                       // 0'10"68  (min ' sec " hundredths)
  if (!isFinite(t)) return `--'--"--`;
  const m=Math.floor(t/60), s=Math.floor(t%60), cs=Math.floor((t*100)%100);
  return `${m}'${String(s).padStart(2,'0')}"${String(cs).padStart(2,'0')}`;
}
function drawTextHUD() {
  document.getElementById('lapNum').textContent = Math.max(1, Math.min(G.lap, G.totalLaps));
  document.getElementById('lapTotal').textContent = G.totalLaps;
  document.getElementById('lapTimeVal').textContent = fmtArcade(G.lapTime);
  document.getElementById('timerVal').textContent = Math.ceil(G.timeLeft);
  document.getElementById('timerVal').style.color = G.timeLeft < 8 ? '#ff3b3b' : '#ffd400';
  document.getElementById('posNum').textContent = G.place;
  document.getElementById('posTotal').textContent = FIELD;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
function menuHTML() {
  return `
    <h1 class="title">DAYTONA <span class="red">USA</span></h1>
    <div class="subtitle">WEB ARCADE EDITION</div>
    <div class="menu-card">
      <h2>SELECT COURSE</h2>
      <div class="diff">
        <button class="btn ghost ${G.diff===0?'sel':''}" data-diff="0">BEGINNER</button>
        <button class="btn ghost ${G.diff===1?'sel':''}" data-diff="1">ADVANCED</button>
        <button class="btn ghost ${G.diff===2?'sel':''}" data-diff="2">EXPERT</button>
      </div>
      <div class="keys">
        <b>↑ / W</b><span>Accelerate</span>
        <b>↓ / S</b><span>Reverse</span>
        <b>← → / A D</b><span>Steer</span>
        <b>SPACE</b><span>Brake / Handbrake</span>
        <b>M</b><span>Mute music</span>
        <b>P / ESC</b><span>Pause</span>
      </div>
      <button class="btn" id="startBtn">START ENGINE ▶</button>
    </div>
    <div class="credit">A homage to SEGA's Daytona USA (1993). Fan-made, non-commercial. •
      <a href="3d/index.html" style="color:#9fe">Try the 3D polygon version ▶</a></div>`;
}
function showMenu() {
  G.state='menu';
  if (window.GameMusic) { window.GameMusic.setMode('menu'); window.GameMusic.duck(false); }
  const el=document.getElementById('overlay');
  el.innerHTML = menuHTML(); el.classList.remove('hidden'); wireMenu();
}
function wireMenu() {
  document.querySelectorAll('[data-diff]').forEach(b=>{
    b.onclick = () => {
      G.diff = parseInt(b.dataset.diff,10);
      document.querySelectorAll('[data-diff]').forEach(x=>x.classList.remove('sel'));
      b.classList.add('sel'); beep(520,0.08,'square',0.1);
    };
  });
  const s=document.getElementById('startBtn'); if (s) s.onclick = startRace;
}

function startRace() {
  initAudio(); if (AC && AC.state==='suspended') AC.resume();
  if (window.GameMusic) { window.GameMusic.start(); window.GameMusic.setMode('race'); window.GameMusic.duck(false); }
  const d = DIFFS[G.diff];
  G.maxSpeed=d.maxSpeed; G.curveMul=d.curveMul; G.aiSpeedMul=d.aiSpeed;
  G.totalLaps=d.laps; G.timeLeft=d.startTime; G.lapBonus=d.lapBonus;
  document.getElementById('trackName').textContent = d.name;

  buildTrack(); resetCars();
  G.position=0; G.playerX=0; G.speed=0;
  G.lap=1; G.lapTime=0; G.lastLapTime=0; G.bestLapTime=Infinity;
  G.totalTime=0; G.place=FIELD; G.shake=0; G.skid=0; G.reversedLine=false;

  document.getElementById('overlay').classList.add('hidden');
  const cd=document.getElementById('countdown');
  cd.classList.remove('hidden'); cd.textContent='3'; cd.dataset.last='3';
  G.countdown=3.0; G.state='countdown'; beep(440,0.15,'square',0.15);
}

function togglePause() {
  if (G.state==='racing') {
    G.state='paused';
    if (window.GameMusic) window.GameMusic.duck(true);
    const el=document.getElementById('overlay');
    el.innerHTML = `
      <h1 class="title">PAUSED</h1>
      <div class="menu-card">
        <button class="btn" id="resumeBtn">RESUME ▶</button>
        <div style="height:10px"></div>
        <button class="btn ghost" id="quitBtn">QUIT TO MENU</button>
      </div>`;
    el.classList.remove('hidden');
    document.getElementById('resumeBtn').onclick = () => { el.classList.add('hidden'); G.state='racing'; if (window.GameMusic) window.GameMusic.duck(false); };
    document.getElementById('quitBtn').onclick = () => showMenu();
  } else if (G.state==='paused') {
    document.getElementById('overlay').classList.add('hidden'); G.state='racing';
    if (window.GameMusic) window.GameMusic.duck(false);
  }
}

// ---------------------------------------------------------------------------
// Main loop (fixed timestep)
// ---------------------------------------------------------------------------
let last=performance.now(), acc=0;
function frame(now) {
  let dt=(now-last)/1000; if (dt>0.1) dt=0.1; last=now; acc+=dt;
  while (acc>=STEP){ update(STEP); acc-=STEP; }
  updateEngine(); render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Responsive canvas
// ---------------------------------------------------------------------------
function resize() {
  const ratio=16/10;
  let w=window.innerWidth, h=window.innerHeight;
  if (w/h>ratio) w=h*ratio; else h=w/ratio;
  WIDTH = canvas.width = Math.min(1280, Math.round(w*window.devicePixelRatio*0.6));
  HEIGHT = canvas.height = Math.round(WIDTH/ratio);
  canvas.style.width=w+'px'; canvas.style.height=h+'px';
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
resize(); buildTrack(); wireMenu();
requestAnimationFrame(frame);

})();

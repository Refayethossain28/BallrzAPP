/* ============================================================================
 * DAYTONA USA — Web Arcade Edition
 * A pseudo-3D (segment projection) arcade racer in the spirit of SEGA's
 * Daytona USA (1993). Single-file engine, no dependencies.
 *
 * Technique: the road is a list of "segments" stacked into the distance.
 * Each segment is projected from world space to screen space using a simple
 * perspective camera, then drawn back-to-front. Curves and hills are produced
 * by giving segments a horizontal "curve" force and a vertical world Y.
 * Opponent cars and roadside sprites ride along the same track.
 * ========================================================================== */
'use strict';

(function () {

// ---------------------------------------------------------------------------
// Canvas + constants
// ---------------------------------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

let WIDTH = canvas.width;     // internal render resolution
let HEIGHT = canvas.height;

const SEG_LEN      = 200;     // length of a single road segment (world units)
const RUMBLE_LEN   = 3;       // segments per rumble-strip stripe
const ROAD_WIDTH   = 2000;    // half-width of the road
const LANES        = 3;
const DRAW_DIST    = 300;     // how many segments to render ahead
const FOV          = 100;     // camera field of view (degrees)
const CAMERA_HEIGHT= 1000;    // camera height above the road
const FPS          = 60;
const STEP         = 1 / FPS;

const CENTRIFUGAL  = 0.32;    // how hard curves push the car outward
const OFFROAD_DECEL= 0.55;    // grass slows you down
const TOTAL_LAPS   = 3;
const OPPONENTS    = 5;       // rival cars

const cameraDepth = 1 / Math.tan((FOV / 2) * Math.PI / 180);

// Difficulty presets
const DIFFS = [
  { name:'BEGINNER', maxSpeed: 11000, curveMul: 0.7, aiSpeed: 0.78 },
  { name:'ADVANCED', maxSpeed: 13000, curveMul: 1.0, aiSpeed: 0.88 },
  { name:'EXPERT',   maxSpeed: 15000, curveMul: 1.35, aiSpeed: 0.97 },
];

// Colours per "theme" alternation (light / dark segments)
const COLORS = {
  LIGHT: { road:'#6b6b6b', grass:'#10aa3c', rumble:'#ffffff', lane:'#cfcfcf' },
  DARK:  { road:'#666566', grass:'#0e9c36', rumble:'#bf2a2a', lane:'#666566' },
  START: { road:'#dddddd', grass:'#10aa3c', rumble:'#dddddd', lane:'#dddddd' },
  FINISH:{ road:'#222222', grass:'#10aa3c', rumble:'#222222', lane:'#222222' },
};

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const G = {
  state: 'menu',            // menu | countdown | racing | paused | finished
  diff: 1,
  segments: [],
  trackLength: 0,
  position: 0,              // camera Z along track
  playerX: 0,              // -1..1 player offset from centre
  speed: 0,
  maxSpeed: 13000,
  curveMul: 1.0,
  aiSpeedMul: 0.88,
  lap: 1,
  lapTime: 0,
  lastLapTime: 0,
  bestLapTime: Infinity,
  totalTime: 0,
  cars: [],                // opponents
  place: 1,
  countdown: 0,
  finishTimer: 0,
  bannerTimer: 0,
  shake: 0,
  skid: 0,
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
  if (e.code === 'KeyP' || e.code === 'Escape') { if (down(e)) togglePause(); return; }
  bindKey(e.code, true);
  if (G.state === 'menu' && (e.code === 'Enter' || e.code === 'Space')) startRace();
});
window.addEventListener('keyup', e => bindKey(e.code, false));
function down(e){ return !e.repeat; }

// Touch controls
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
    index: n,
    curve,
    p1: { world:{ y: lastY(), z: n*SEG_LEN }, camera:{}, screen:{} },
    p2: { world:{ y: y,       z:(n+1)*SEG_LEN }, camera:{}, screen:{} },
    cars: [],
    sprites: [],
    color: Math.floor(n / RUMBLE_LEN) % 2 ? COLORS.DARK : COLORS.LIGHT,
  });
}

// easing helpers
function easeIn(a,b,p){ return a + (b-a)*Math.pow(p,2); }
function easeInOut(a,b,p){ return a + (b-a)*((-Math.cos(p*Math.PI)/2)+0.5); }

function addRoad(enter, hold, leave, curve, y) {
  const startY = lastY();
  const endY = startY + y * SEG_LEN;
  const total = enter + hold + leave;
  for (let i=0;i<enter;i++) addSegment(easeIn(0,curve,i/enter),      easeInOut(startY,endY,i/total));
  for (let i=0;i<hold;i++)  addSegment(curve,                        easeInOut(startY,endY,(enter+i)/total));
  for (let i=0;i<leave;i++) addSegment(easeInOut(curve,0,i/leave),   easeInOut(startY,endY,(enter+hold+i)/total));
}

const ROAD = {
  LEN:  { NONE:0, SHORT:25, MEDIUM:50, LONG:100 },
  CURVE:{ NONE:0, EASY:2, MEDIUM:4, HARD:6 },
  HILL: { NONE:0, LOW:20, MEDIUM:40, HIGH:60 },
};

function addStraight(n){ n=n||ROAD.LEN.MEDIUM; addRoad(n,n,n,0,0); }
function addHill(n,h){ n=n||ROAD.LEN.MEDIUM; h=h||ROAD.HILL.MEDIUM; addRoad(n,n,n,0,h); }
function addCurve(n,c,h){ n=n||ROAD.LEN.MEDIUM; c=c||ROAD.CURVE.MEDIUM; h=h||ROAD.HILL.NONE; addRoad(n,n,n,c,h); }
function addSCurves(){
  addRoad(ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM,-ROAD.CURVE.EASY,ROAD.HILL.NONE);
  addRoad(ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM, ROAD.CURVE.MEDIUM,ROAD.HILL.MEDIUM);
  addRoad(ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM, ROAD.CURVE.EASY,-ROAD.HILL.LOW);
  addRoad(ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM,-ROAD.CURVE.EASY,ROAD.HILL.MEDIUM);
  addRoad(ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM,ROAD.LEN.MEDIUM,-ROAD.CURVE.MEDIUM,-ROAD.HILL.MEDIUM);
}

const SPRITES = ['palm','billboard','grandstand','sign','tree','arch'];
function addSprite(seg, name, offset) {
  G.segments[seg].sprites.push({ name, offset });
}

function buildTrack() {
  G.segments = [];
  const c = G.curveMul;
  // Start / pit straight
  addStraight(ROAD.LEN.SHORT);
  addStraight(ROAD.LEN.LONG);
  // Banked oval-ish opening (Daytona's signature) + infield twists
  addCurve(ROAD.LEN.MEDIUM, ROAD.CURVE.MEDIUM*c, ROAD.HILL.LOW);
  addStraight(ROAD.LEN.SHORT);
  addCurve(ROAD.LEN.LONG, ROAD.CURVE.HARD*c, ROAD.HILL.NONE);
  addHill(ROAD.LEN.MEDIUM, ROAD.HILL.HIGH);
  addSCurves();
  addCurve(ROAD.LEN.MEDIUM, -ROAD.CURVE.MEDIUM*c, ROAD.HILL.LOW);
  addStraight(ROAD.LEN.MEDIUM);
  addCurve(ROAD.LEN.LONG, -ROAD.CURVE.HARD*c, ROAD.HILL.MEDIUM);
  addHill(ROAD.LEN.MEDIUM, -ROAD.HILL.MEDIUM);
  addSCurves();
  addCurve(ROAD.LEN.MEDIUM, ROAD.CURVE.EASY*c, -ROAD.HILL.LOW);
  addStraight(ROAD.LEN.SHORT);
  addCurve(ROAD.LEN.LONG, ROAD.CURVE.HARD*c, ROAD.HILL.LOW);
  addHill(ROAD.LEN.MEDIUM, ROAD.HILL.MEDIUM);
  addStraight(ROAD.LEN.MEDIUM);
  // Final banked sweep back to the line
  addCurve(ROAD.LEN.LONG, ROAD.CURVE.MEDIUM*c, ROAD.HILL.NONE);
  addStraight(ROAD.LEN.LONG);

  // Decorate roadside
  for (let n = 20; n < G.segments.length; n += 0) {
    const gap = 8 + Math.floor(Math.random()*14);
    n += gap;
    if (n >= G.segments.length) break;
    const side = Math.random() < 0.5 ? -1 : 1;
    const name = SPRITES[Math.floor(Math.random()*SPRITES.length)];
    const off = side * (1.1 + Math.random()*1.8);
    addSprite(n, name, off);
  }
  // Start/finish markers
  for (let i=0;i<RUMBLE_LEN;i++) G.segments[i].color = COLORS.START;
  for (let i=0;i<RUMBLE_LEN;i++) G.segments[G.segments.length-1-i].color = COLORS.FINISH;
  addSprite(2, 'arch', 0); // start gantry

  G.trackLength = G.segments.length * SEG_LEN;
}

function findSegment(z) {
  return G.segments[Math.floor(z / SEG_LEN) % G.segments.length];
}

// ---------------------------------------------------------------------------
// Opponent cars
// ---------------------------------------------------------------------------
const CAR_COLORS = ['#e23b3b','#2f6cff','#22c55e','#f59e0b','#a855f7','#06b6d4','#ec4899'];
function resetCars() {
  G.cars = [];
  for (let i=0;i<OPPONENTS;i++) {
    const z = Math.floor(Math.random()* (G.segments.length)) * SEG_LEN;
    const car = {
      offset: (Math.random()*1.6 - 0.8),
      z,
      speed: G.maxSpeed * (0.55 + Math.random()*0.30) * G.aiSpeedMul,
      color: CAR_COLORS[i % CAR_COLORS.length],
      lap: 1,
      progress: 0,
      w: 0.9,
    };
    G.cars.push(car);
  }
}

function updateCars(dt, playerSeg) {
  for (const car of G.cars) {
    const seg = findSegment(car.z);
    // simple AI: steer away from upcoming curve + dodge player
    const look = G.segments[(seg.index + 6) % G.segments.length];
    let dir = 0;
    if (look.curve > 1) dir = -0.4; else if (look.curve < -1) dir = 0.4;
    // avoid the player if close & overlapping
    const dz = playerSeg ? loopDelta(car.z, G.position) : 999999;
    if (Math.abs(dz) < SEG_LEN*4 && Math.abs(car.offset - G.playerX) < 1.0) {
      dir += (car.offset > G.playerX ? 0.5 : -0.5);
    }
    car.offset += dir * dt * 1.2;
    car.offset = Math.max(-1.9, Math.min(1.9, car.offset));

    const prevZ = car.z;
    car.z += car.speed * dt;
    if (car.z >= G.trackLength) { car.z -= G.trackLength; car.lap++; }
    car.progress = car.lap * G.trackLength + car.z;
    void prevZ;
  }
}

function loopDelta(a, b) {
  let d = a - b;
  while (d >  G.trackLength/2) d -= G.trackLength;
  while (d < -G.trackLength/2) d += G.trackLength;
  return d;
}

// ---------------------------------------------------------------------------
// Audio (procedural engine + simple SFX via WebAudio)
// ---------------------------------------------------------------------------
let AC = null, engineOsc = null, engineGain = null, engineFilter = null;
function initAudio() {
  if (AC) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    engineOsc = AC.createOscillator();
    engineOsc.type = 'sawtooth';
    engineFilter = AC.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 800;
    engineGain = AC.createGain();
    engineGain.gain.value = 0.0;
    engineOsc.connect(engineFilter).connect(engineGain).connect(AC.destination);
    engineOsc.start();
  } catch (e) { AC = null; }
}
function updateEngine() {
  if (!AC) return;
  const r = G.speed / G.maxSpeed;
  const rpm = 60 + r * 220 + (G.skid>0?40:0);
  engineOsc.frequency.setTargetAtTime(rpm, AC.currentTime, 0.05);
  engineFilter.frequency.setTargetAtTime(500 + r*2500, AC.currentTime, 0.05);
  const vol = (G.state==='racing') ? (0.04 + r*0.10) : 0.0;
  engineGain.gain.setTargetAtTime(vol, AC.currentTime, 0.1);
}
function beep(freq, dur, type, vol) {
  if (!AC) return;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'square'; o.frequency.value = freq;
  g.gain.value = vol || 0.15;
  g.gain.setTargetAtTime(0.0001, AC.currentTime + dur*0.5, dur*0.3);
  o.connect(g).connect(AC.destination);
  o.start(); o.stop(AC.currentTime + dur);
}

// ---------------------------------------------------------------------------
// Update loop
// ---------------------------------------------------------------------------
function update(dt) {
  if (G.state === 'countdown') {
    G.countdown -= dt;
    const n = Math.ceil(G.countdown);
    const el = document.getElementById('countdown');
    if (G.countdown <= 0) { G.state = 'racing'; el.classList.add('hidden'); beep(880,0.4,'square',0.2); }
    else { el.textContent = n; if (el.dataset.last != n){ el.dataset.last = n; beep(440,0.15,'square',0.15);} }
    return;
  }
  if (G.state !== 'racing') return;

  const startN = Math.floor(G.position / SEG_LEN);
  const playerSeg = findSegment(G.position + CAMERA_HEIGHT);
  const speedPercent = G.speed / G.maxSpeed;

  // --- Steering ---
  const dx = dt * 2 * speedPercent;     // steer responsiveness scales with speed
  if (keys.left)  G.playerX -= dx;
  if (keys.right) G.playerX += dx;
  // centrifugal force on curves
  G.playerX -= dx * speedPercent * playerSeg.curve * CENTRIFUGAL;

  // --- Throttle / brake ---
  const accel = G.maxSpeed / 4.5;
  const brake = -G.maxSpeed / 2.2;
  const decel = -G.maxSpeed / 5.5;
  if (keys.gas && !keys.reverse) G.speed += accel * dt;
  else if (keys.reverse) G.speed += brake * dt;
  else G.speed += decel * dt;
  if (keys.brake) G.speed += brake * dt;

  // --- Off-road & collisions ---
  G.skid = Math.max(0, G.skid - dt);
  if ((G.playerX < -1 || G.playerX > 1) && G.speed > G.maxSpeed*0.2) {
    G.speed += decel * dt * 2;
    G.speed *= 1 - OFFROAD_DECEL * dt; // grass drag
    G.shake = 6;
    if (Math.random()<0.1) beep(120,0.05,'sawtooth',0.05);
  }
  // collide with opponents
  if (G.speed > 0) {
    for (const car of G.cars) {
      const d = loopDelta(car.z, G.position);
      if (d > 0 && d < SEG_LEN*1.4 && Math.abs(G.playerX - car.offset) < 0.9) {
        G.speed = car.speed * 0.85;
        G.playerX += (G.playerX > car.offset ? 0.4 : -0.4);
        G.shake = 12; G.skid = 0.4;
        beep(90,0.12,'sawtooth',0.18);
      }
    }
  }

  G.speed = Math.max(-G.maxSpeed*0.25, Math.min(G.speed, G.maxSpeed));
  if (Math.abs(G.playerX) > 0.7 && Math.abs(playerSeg.curve) > 2 && G.speed > G.maxSpeed*0.6)
    G.skid = Math.max(G.skid, 0.2);

  // --- Advance position ---
  G.position += G.speed * dt;
  while (G.position >= G.trackLength) {
    G.position -= G.trackLength;
    onLapComplete();
  }
  while (G.position < 0) G.position += G.trackLength;
  G.playerX = Math.max(-2.2, Math.min(2.2, G.playerX));

  // --- Timers ---
  G.lapTime += dt;
  G.totalTime += dt;
  G.shake = Math.max(0, G.shake - dt*30);

  // --- Opponents & standings ---
  updateCars(dt, playerSeg);
  computePlace();
  void startN;
}

function onLapComplete() {
  G.lastLapTime = G.lapTime;
  if (G.lapTime < G.bestLapTime) { G.bestLapTime = G.lapTime; flashBanner('FAST LAP!'); beep(1046,0.4,'square',0.18); }
  G.lapTime = 0;
  G.lap++;
  if (G.lap > TOTAL_LAPS) { finishRace(); return; }
  flashBanner('LAP ' + G.lap);
  beep(660,0.25,'square',0.15);
}

function computePlace() {
  const myProg = G.lap * G.trackLength + G.position;
  let ahead = 0;
  for (const car of G.cars) if (car.progress > myProg) ahead++;
  G.place = ahead + 1;
}

function finishRace() {
  G.state = 'finished';
  G.lap = TOTAL_LAPS;
  const el = document.getElementById('overlay');
  const place = G.place;
  const ord = ['1ST','2ND','3RD','4TH','5TH','6TH'][place-1] || place+'TH';
  const win = place === 1;
  el.innerHTML = `
    <h1 class="title">${win ? 'YOU <span class="red">WIN!</span>' : 'FINISH'}</h1>
    <div class="subtitle ${win?'flash':''}">${win ? 'DAYTONA!  CHAMPION!' : 'GOOD RACE — TRY AGAIN'}</div>
    <div class="menu-card">
      <h2>FINAL RESULTS</h2>
      <div class="keys" style="grid-template-columns:auto 1fr;">
        <b>PLACE</b><span>${ord} of ${OPPONENTS+1}</span>
        <b>TOTAL</b><span>${fmtTime(G.totalTime)}</span>
        <b>BEST LAP</b><span>${G.bestLapTime===Infinity?'--':fmtTime(G.bestLapTime)}</span>
      </div>
      <button class="btn" id="againBtn">RACE AGAIN ▶</button>
    </div>
    <div class="credit">A homage to SEGA's Daytona USA (1993). Fan-made, non-commercial.</div>`;
  el.classList.remove('hidden');
  document.getElementById('againBtn').onclick = () => showMenu();
  beep(win?1318:220,0.6,'square',0.2);
}

function flashBanner(text) {
  const b = document.getElementById('banner');
  b.textContent = text;
  b.classList.remove('hidden');
  G.bannerTimer = 1.4;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function project(p, camX, camY, camZ, camDepth, w, h, roadW) {
  p.camera.x = (p.world.x || 0) - camX;
  p.camera.y = (p.world.y || 0) - camY;
  p.camera.z = (p.world.z || 0) - camZ;
  const scale = camDepth / p.camera.z;
  p.screen.scale = scale;
  p.screen.x = Math.round((w/2) + (scale * p.camera.x * w/2));
  p.screen.y = Math.round((h/2) - (scale * p.camera.y * h/2));
  p.screen.w = Math.round(scale * roadW * w/2);
}

function polygon(x1,y1,x2,y2,x3,y3,x4,y4,color){
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.lineTo(x3,y3); ctx.lineTo(x4,y4);
  ctx.closePath(); ctx.fill();
}

function drawBackground(baseSeg, playerX) {
  // Sky gradient
  const sky = ctx.createLinearGradient(0,0,0,HEIGHT*0.6);
  sky.addColorStop(0, '#1d6bd6');
  sky.addColorStop(1, '#7fc4ff');
  ctx.fillStyle = sky;
  ctx.fillRect(0,0,WIDTH,HEIGHT);
  // Sun
  ctx.save();
  ctx.fillStyle = 'rgba(255,250,210,0.9)';
  ctx.beginPath();
  ctx.arc(WIDTH*0.5 - baseSeg.curve*4, HEIGHT*0.30, 70, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();
  // Distant mountains parallax
  const off = -(G.position*0.0008 + playerX*40) % WIDTH;
  ctx.fillStyle = '#2a7d4f';
  for (let r=0;r<2;r++){
    const base = off + r*WIDTH;
    ctx.beginPath();
    ctx.moveTo(base-50, HEIGHT*0.45);
    for (let x=-50;x<=WIDTH+50;x+=120){
      const hh = 60 + ((Math.sin((x+base)*0.01)+1)*45);
      ctx.lineTo(base+x, HEIGHT*0.45 - hh);
      ctx.lineTo(base+x+60, HEIGHT*0.45 - hh*0.5);
    }
    ctx.lineTo(base+WIDTH+50, HEIGHT*0.45);
    ctx.closePath(); ctx.fill();
  }
}

function render() {
  ctx.clearRect(0,0,WIDTH,HEIGHT);

  const baseSegment = findSegment(G.position);
  const basePercent = (G.position % SEG_LEN) / SEG_LEN;
  const playerSeg = findSegment(G.position + CAMERA_HEIGHT);
  const playerPercent = ((G.position+CAMERA_HEIGHT) % SEG_LEN)/SEG_LEN;
  const playerY = (playerSeg.p1.world.y + (playerSeg.p2.world.y-playerSeg.p1.world.y)*playerPercent);

  // screen shake
  let sx = 0, sy = 0;
  if (G.shake > 0) { sx = (Math.random()-0.5)*G.shake; sy=(Math.random()-0.5)*G.shake; }
  ctx.save();
  ctx.translate(sx, sy);

  drawBackground(baseSegment, G.playerX);

  let x = 0;
  let dx = -(baseSegment.curve * basePercent);
  let maxY = HEIGHT;
  const cameraX = G.playerX * ROAD_WIDTH;
  const cameraZ = G.position - (G.position % 1);
  const cameraY = CAMERA_HEIGHT + playerY;

  const renderSegs = [];
  for (let n=0; n<DRAW_DIST; n++) {
    const seg = G.segments[(baseSegment.index + n) % G.segments.length];
    seg.looped = seg.index < baseSegment.index;
    seg.clip = maxY;

    const offZ = seg.looped ? G.trackLength : 0;
    project(seg.p1, cameraX - x,        cameraY, cameraZ - offZ, cameraDepth, WIDTH, HEIGHT, ROAD_WIDTH);
    project(seg.p2, cameraX - x - dx,   cameraY, cameraZ - offZ, cameraDepth, WIDTH, HEIGHT, ROAD_WIDTH);

    x += dx;
    dx += seg.curve;

    if (seg.p1.camera.z <= cameraDepth || seg.p2.screen.y >= seg.p1.screen.y || seg.p2.screen.y >= maxY) continue;

    drawSegment(seg);
    maxY = seg.p2.screen.y;
    renderSegs.push(seg);
  }

  // Sprites & cars: back to front
  for (let i = renderSegs.length-1; i>=0; i--) {
    const seg = renderSegs[i];
    for (const sp of seg.sprites) drawSprite(seg, sp);
    for (const car of G.cars) {
      const cseg = findSegment(car.z);
      if (cseg.index === seg.index) drawCar(seg, car);
    }
  }

  drawPlayerCar();
  ctx.restore();

  if (G.bannerTimer > 0) { G.bannerTimer -= STEP; if (G.bannerTimer<=0) document.getElementById('banner').classList.add('hidden'); }
  drawHUD();
}

function drawSegment(seg) {
  const p1 = seg.p1.screen, p2 = seg.p2.screen, col = seg.color;
  // grass
  ctx.fillStyle = col.grass;
  ctx.fillRect(0, p2.y, WIDTH, p1.y - p2.y);
  // rumble strips
  const r1 = p1.w/6, r2 = p2.w/6;
  polygon(p1.x-p1.w-r1, p1.y, p1.x-p1.w, p1.y, p2.x-p2.w, p2.y, p2.x-p2.w-r2, p2.y, col.rumble);
  polygon(p1.x+p1.w+r1, p1.y, p1.x+p1.w, p1.y, p2.x+p2.w, p2.y, p2.x+p2.w+r2, p2.y, col.rumble);
  // road
  polygon(p1.x-p1.w, p1.y, p1.x+p1.w, p1.y, p2.x+p2.w, p2.y, p2.x-p2.w, p2.y, col.road);
  // lane lines
  if (col !== COLORS.START && col !== COLORS.FINISH) {
    const l1 = p1.w/24, l2 = p2.w/24;
    for (let lane=1; lane<LANES; lane++){
      const lx1 = p1.x - p1.w + (2*p1.w/LANES)*lane;
      const lx2 = p2.x - p2.w + (2*p2.w/LANES)*lane;
      polygon(lx1-l1, p1.y, lx1+l1, p1.y, lx2+l2, p2.y, lx2-l2, p2.y, col.lane);
    }
  } else {
    // checkered start/finish
    drawChecker(p1, p2);
  }
}

function drawChecker(p1, p2) {
  const cols = 8;
  for (let i=0;i<cols;i++){
    if (i%2===0) continue;
    const a1 = p1.x - p1.w + (2*p1.w/cols)*i;
    const b1 = p1.x - p1.w + (2*p1.w/cols)*(i+1);
    const a2 = p2.x - p2.w + (2*p2.w/cols)*i;
    const b2 = p2.x - p2.w + (2*p2.w/cols)*(i+1);
    polygon(a1,p1.y,b1,p1.y,b2,p2.y,a2,p2.y,'#fff');
  }
}

function drawSprite(seg, sp) {
  const p = seg.p1.screen;
  if (p.scale <= 0) return;
  const destW = p.scale * 2500 * WIDTH/2 * 0.0009;
  const destH = destW;
  if (destW < 2) return;
  const sx = p.x + (p.scale * sp.offset * ROAD_WIDTH * WIDTH/2);
  const sy = p.y;
  drawProp(sp.name, sx, sy, destW, destH, seg.clip);
}

function drawProp(name, x, y, w, h, clip) {
  ctx.save();
  switch(name) {
    case 'palm': {
      ctx.fillStyle = '#6b4a2b';
      ctx.fillRect(x-w*0.04, y-h*1.6, w*0.08, h*1.6);
      ctx.fillStyle = '#1f9c3a';
      for (let a=0;a<6;a++){
        const ang = (a/6)*Math.PI*2;
        ctx.beginPath();
        ctx.moveTo(x, y-h*1.6);
        ctx.quadraticCurveTo(x+Math.cos(ang)*w*0.5, y-h*1.6-Math.sin(ang)*h*0.3,
                             x+Math.cos(ang)*w*0.7, y-h*1.6-Math.sin(ang)*h*0.1+h*0.2);
        ctx.lineWidth = Math.max(1,w*0.05); ctx.strokeStyle='#1f9c3a'; ctx.stroke();
      }
      break;
    }
    case 'tree': {
      ctx.fillStyle = '#6b4a2b'; ctx.fillRect(x-w*0.05, y-h, w*0.1, h);
      ctx.fillStyle = '#198a32';
      ctx.beginPath(); ctx.arc(x, y-h*1.1, w*0.45, 0, Math.PI*2); ctx.fill();
      break;
    }
    case 'billboard': {
      ctx.fillStyle = '#222'; ctx.fillRect(x-w*0.06, y-h*1.4, w*0.12, h*1.4);
      const grd = ctx.createLinearGradient(x-w*0.7,0,x+w*0.7,0);
      grd.addColorStop(0,'#ff3b3b'); grd.addColorStop(1,'#1f6dff');
      ctx.fillStyle = grd; ctx.fillRect(x-w*0.7, y-h*2.2, w*1.4, h*0.85);
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(6,w*0.28)}px Trebuchet MS`;
      ctx.textAlign='center'; ctx.fillText('DAYTONA', x, y-h*1.7);
      break;
    }
    case 'grandstand': {
      ctx.fillStyle = '#9aa3b2'; ctx.fillRect(x-w*0.9, y-h*1.6, w*1.8, h*1.6);
      ctx.fillStyle = '#5b6577';
      for (let r=0;r<5;r++) ctx.fillRect(x-w*0.9, y-h*1.6+r*h*0.3, w*1.8, h*0.12);
      // crowd dots
      for (let c=0;c<24;c++){
        ctx.fillStyle = `hsl(${Math.random()*360},70%,60%)`;
        ctx.fillRect(x-w*0.85+Math.random()*w*1.7, y-h*1.5+Math.random()*h*1.3, w*0.05, w*0.05);
      }
      break;
    }
    case 'arch': {
      ctx.strokeStyle = '#cfcfcf'; ctx.lineWidth = Math.max(2,w*0.12);
      ctx.beginPath();
      ctx.moveTo(x-w*1.6, y); ctx.lineTo(x-w*1.6, y-h*2.4);
      ctx.lineTo(x+w*1.6, y-h*2.4); ctx.lineTo(x+w*1.6, y);
      ctx.stroke();
      ctx.fillStyle = '#ff3b3b'; ctx.fillRect(x-w*1.6, y-h*2.7, w*3.2, h*0.5);
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(7,w*0.4)}px Trebuchet MS`;
      ctx.textAlign='center'; ctx.fillText('START / FINISH', x, y-h*2.35);
      break;
    }
    case 'sign': default: {
      ctx.fillStyle = '#444'; ctx.fillRect(x-w*0.04, y-h, w*0.08, h);
      ctx.fillStyle = G.curveMul ? '#ffd400' : '#ffd400';
      ctx.beginPath();
      ctx.moveTo(x, y-h*1.5); ctx.lineTo(x+w*0.4, y-h*1.1);
      ctx.lineTo(x, y-h*0.7); ctx.lineTo(x-w*0.4, y-h*1.1); ctx.closePath(); ctx.fill();
      break;
    }
  }
  ctx.restore();
  void clip;
}

function drawCar(seg, car) {
  const p = seg.p1.screen;
  if (p.scale <= 0) return;
  const w = p.scale * 1700 * WIDTH/2 * 0.0011;
  const h = w * 0.6;
  if (w < 3) return;
  const x = p.x + (p.scale * car.offset * ROAD_WIDTH * WIDTH/2);
  const y = p.y;
  drawCarSprite(x, y, w, h, car.color, false);
}

function drawCarSprite(x, y, w, h, color, isPlayer) {
  ctx.save();
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(x, y, w*0.6, h*0.18, 0, 0, Math.PI*2); ctx.fill();
  // body
  ctx.fillStyle = color;
  roundRect(x-w*0.5, y-h*0.95, w, h*0.9, w*0.12);
  // roof / cockpit
  ctx.fillStyle = shade(color, -30);
  roundRect(x-w*0.32, y-h*1.25, w*0.64, h*0.5, w*0.1);
  // windshield
  ctx.fillStyle = '#1a2a44';
  roundRect(x-w*0.26, y-h*1.18, w*0.52, h*0.32, w*0.06);
  // wheels
  ctx.fillStyle = '#111';
  ctx.fillRect(x-w*0.56, y-h*0.7, w*0.12, h*0.5);
  ctx.fillRect(x+w*0.44, y-h*0.7, w*0.12, h*0.5);
  // racing number on player
  if (isPlayer) {
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(8,w*0.3)}px Trebuchet MS`;
    ctx.textAlign = 'center';
    ctx.fillText('41', x, y-h*0.35);
  }
  ctx.restore();
}

function shade(hex, amt) {
  let c = hex.replace('#','');
  if (c.length===3) c = c.split('').map(s=>s+s).join('');
  let r = Math.max(0,Math.min(255, parseInt(c.substr(0,2),16)+amt));
  let g = Math.max(0,Math.min(255, parseInt(c.substr(2,2),16)+amt));
  let b = Math.max(0,Math.min(255, parseInt(c.substr(4,2),16)+amt));
  return `rgb(${r},${g},${b})`;
}
function roundRect(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath(); ctx.fill();
}

function drawPlayerCar() {
  const cx = WIDTH/2;
  const cy = HEIGHT - 70;
  const w = WIDTH * 0.16;
  const h = w * 0.62;
  // bounce + lean
  const bounce = Math.sin(G.position*0.02) * (G.speed/G.maxSpeed) * 3;
  const lean = (keys.left?-1:0) + (keys.right?1:0);
  ctx.save();
  ctx.translate(cx + lean*8, cy + bounce);
  // skid smoke
  if (G.skid > 0) {
    for (let i=0;i<4;i++){
      ctx.fillStyle = `rgba(220,220,220,${0.25*Math.random()})`;
      ctx.beginPath();
      ctx.arc(-w*0.3 + Math.random()*w*0.6, h*0.2 + Math.random()*10, 8+Math.random()*10, 0, Math.PI*2);
      ctx.fill();
    }
  }
  drawCarSprite(0, 0, w, h, '#ff3b3b', true);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function fmtTime(t) {
  if (!isFinite(t)) return '--:--.--';
  const m = Math.floor(t/60);
  const s = Math.floor(t%60);
  const cs = Math.floor((t*100)%100);
  return `${m}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}
function drawHUD() {
  document.getElementById('speedVal').textContent = Math.round(Math.abs(G.speed)/40);
  const gear = Math.min(6, 1 + Math.floor((G.speed/G.maxSpeed)*5.99));
  document.getElementById('gearVal').textContent = 'GEAR ' + (G.speed<0?'R':gear);
  document.getElementById('lapNum').textContent = Math.min(G.lap, TOTAL_LAPS);
  document.getElementById('lapTotal').textContent = TOTAL_LAPS;
  document.getElementById('curTime').textContent = fmtTime(G.lapTime);
  document.getElementById('bestTime').textContent = G.bestLapTime===Infinity?'--:--.--':fmtTime(G.bestLapTime);
  document.getElementById('lastTime').textContent = G.lastLapTime?fmtTime(G.lastLapTime):'--:--.--';
  document.getElementById('posNum').textContent = G.place;
  document.getElementById('posTotal').textContent = OPPONENTS+1;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
function showMenu() {
  G.state = 'menu';
  const el = document.getElementById('overlay');
  el.innerHTML = `
    <h1 class="title">DAYTONA <span class="red">USA</span></h1>
    <div class="subtitle">WEB ARCADE EDITION</div>
    <div class="menu-card">
      <h2>CHOOSE YOUR COURSE DIFFICULTY</h2>
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
        <b>P / ESC</b><span>Pause</span>
      </div>
      <button class="btn" id="startBtn">START ENGINE ▶</button>
    </div>
    <div class="credit">A homage to SEGA's Daytona USA (1993). Fan-made, non-commercial.</div>`;
  el.classList.remove('hidden');
  wireMenu();
}

function wireMenu() {
  document.querySelectorAll('[data-diff]').forEach(b => {
    b.onclick = () => {
      G.diff = parseInt(b.dataset.diff,10);
      document.querySelectorAll('[data-diff]').forEach(x=>x.classList.remove('sel'));
      b.classList.add('sel');
      beep(520,0.08,'square',0.1);
    };
  });
  const start = document.getElementById('startBtn');
  if (start) start.onclick = startRace;
}

function startRace() {
  initAudio();
  if (AC && AC.state === 'suspended') AC.resume();
  const d = DIFFS[G.diff];
  G.maxSpeed = d.maxSpeed; G.curveMul = d.curveMul; G.aiSpeedMul = d.aiSpeed;
  document.getElementById('trackName').textContent =
    ['SUNNY BEACH (BEGINNER)','THREE-SEVEN SPEEDWAY (ADVANCED)','DINOSAUR CANYON (EXPERT)'][G.diff];

  buildTrack();
  resetCars();
  G.position = 0; G.playerX = 0; G.speed = 0;
  G.lap = 1; G.lapTime = 0; G.lastLapTime = 0; G.bestLapTime = Infinity;
  G.totalTime = 0; G.place = OPPONENTS+1; G.shake = 0; G.skid = 0;

  document.getElementById('overlay').classList.add('hidden');
  const cd = document.getElementById('countdown');
  cd.classList.remove('hidden'); cd.textContent = '3'; cd.dataset.last='3';
  G.countdown = 3.0;
  G.state = 'countdown';
  beep(440,0.15,'square',0.15);
}

function togglePause() {
  if (G.state === 'racing') {
    G.state = 'paused';
    const el = document.getElementById('overlay');
    el.innerHTML = `
      <h1 class="title">PAUSED</h1>
      <div class="menu-card">
        <button class="btn" id="resumeBtn">RESUME ▶</button>
        <div style="height:10px"></div>
        <button class="btn ghost" id="quitBtn">QUIT TO MENU</button>
      </div>`;
    el.classList.remove('hidden');
    document.getElementById('resumeBtn').onclick = () => { el.classList.add('hidden'); G.state='racing'; };
    document.getElementById('quitBtn').onclick = () => showMenu();
  } else if (G.state === 'paused') {
    document.getElementById('overlay').classList.add('hidden');
    G.state = 'racing';
  }
}

// ---------------------------------------------------------------------------
// Main loop (fixed timestep)
// ---------------------------------------------------------------------------
let last = performance.now();
let acc = 0;
function frame(now) {
  let dt = (now - last) / 1000;
  if (dt > 0.1) dt = 0.1;
  last = now;
  acc += dt;
  while (acc >= STEP) { update(STEP); acc -= STEP; }
  updateEngine();
  render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Responsive canvas
// ---------------------------------------------------------------------------
function resize() {
  const ratio = 16/10;
  let w = window.innerWidth, h = window.innerHeight;
  if (w/h > ratio) w = h*ratio; else h = w/ratio;
  // keep internal resolution crisp but capped
  WIDTH = canvas.width = Math.min(1280, Math.round(w*window.devicePixelRatio*0.6));
  HEIGHT = canvas.height = Math.round(WIDTH/ratio);
  canvas.style.width = w+'px';
  canvas.style.height = h+'px';
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
resize();
buildTrack();   // so the menu has a faint track to render behind if desired
wireMenu();
requestAnimationFrame(frame);

})();

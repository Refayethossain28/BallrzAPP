// ============================================================================
//  DAYTONA USA — 3D Polygon Edition  (clean rewrite)
//  Architecture goals (hard requirements):
//   1. Forward rendering ONLY — no post-processing/bloom. Never a black screen.
//   2. On-rail arcade car: position is (dist along spline, lateral offset). The
//      car can never get stuck, wedge, or leave the world.
//   3. Chase camera derived from the track frame, finiteness-guarded — always sane.
//   4. Closed-loop track; banking flattened at start/finish.
//   5. Landmarks grounded with ONE helper that matches the verge surface.
//   6. Mobile draw-call budget so the scene always renders on iOS Safari.
// ============================================================================
import * as THREE from 'three';

const BUILD = 'BUILD R51 — WebGPU paint + bloom emissive';

// ----------------------------------------------------------------------------
//  Data (carried over from the previous version)
// ----------------------------------------------------------------------------
const LONDON_LAYOUT = [
  [0,0,-180],[105,0,-180],[210,0,-180],
  [272,0,-95],[292,0,0],[272,0,95],
  [210,0,180],[105,0,180],[-105,0,180],[-210,0,180],
  [-272,0,95],[-292,0,0],[-272,0,-95],
  [-210,0,-180],
];
const DUBAI_LAYOUT = [
  [0,0,-205],[125,0,-205],[250,0,-205],
  [330,0,-105],[352,0,0],[330,0,105],
  [250,0,205],[83,0,205],[-83,0,205],[-250,0,205],
  [-330,0,105],[-352,0,0],[-330,0,-105],
  [-250,0,-205],
];
const CANYON_LAYOUT = [
  [0,0,-230],[150,0,-250],[290,0,-170],[340,0,-40],
  [300,0,90],[200,0,170],[70,0,150],[-40,0,210],
  [-180,0,250],[-310,0,150],[-350,0,0],[-300,0,-140],[-170,0,-250],
];
const CIRCUITS = [
  { name:'DAYTONA', laps:8, maxSpeed:118, curveMul:0.85, aiSpeed:0.74, startTime:60, lapBonus:26, seed:1,  theme:0 },
  { name:'LONDON',  laps:6, maxSpeed:120, curveMul:1.0,  aiSpeed:0.78, startTime:62, lapBonus:30, seed:11, theme:3, layout:LONDON_LAYOUT },
  { name:'DUBAI',   laps:6, maxSpeed:132, curveMul:1.0,  aiSpeed:0.82, startTime:66, lapBonus:30, seed:23, theme:4, layout:DUBAI_LAYOUT },
  { name:'CANYON',  laps:6, maxSpeed:128, curveMul:1.05, aiSpeed:0.80, startTime:64, lapBonus:30, seed:37, theme:1, layout:CANYON_LAYOUT },
];
const THEMES = [
  { asphalt:0x83878d, grass:0x4a9c54, grass2:0x3f8f49, mountain:0x8a9099, snow:true,
    prop:'pine', skyline:'mountain', landmark:'usa', buildings:false,
    skyTop:'#1f6fd6', skyMid:'#5aa6f0', skyHorizon:'#dff0ff', fog:0xbfe2ff },
  // [1] CANYON — warm desert sunset, red-rock mountains, palms
  { asphalt:0x8a7d72, grass:0xcaa46a, grass2:0xb8945c, mountain:0xb5683f, snow:false,
    prop:'palm', skyline:'mountain', landmark:'usa', buildings:false,
    skyTop:'#c4521f', skyMid:'#e89a4f', skyHorizon:'#f6cf95', fog:0xe6bd84 },
  {},
  { asphalt:0x6f7378, grass:0x4f7d46, grass2:0x447439, mountain:0x9aa6b2, snow:false,
    prop:'tree', skyline:'city', landmark:'london', buildings:true, overcast:true,
    skyTop:'#5f6c7b', skyMid:'#7c8b99', skyHorizon:'#97a4ae', fog:0x9aa6b0 },
  { asphalt:0x8a8e94, grass:0xcdb47e, grass2:0xbfa666, mountain:0xd8c79a, snow:false,
    prop:'palm', skyline:'city', landmark:'dubai', buildings:true,
    skyTop:'#1670c4', skyMid:'#5aa8e4', skyHorizon:'#d8c088', fog:0xd2bd8a },
];
const VEHICLES = [
  { name:'HORNET', kind:'stock', color:0xd6262b,
    livery:{ body:0xd6262b, hood:0x1f5fd6, roof:0x1f5fd6, num:41, sponsor:'HORNET' },
    speedMul:1.00, accelMul:0.98, steerMul:0.96, gripMul:1.0, brakeMul:0.96, rollMul:1.05,
    desc:'The classic blue & red stock car — balanced and iconic.' },
  { name:'PHANTOM', kind:'stock', color:0x14181c,
    livery:{ body:0x14181c, hood:0xe23b3b, roof:0xe23b3b, num:7, sponsor:'PHANTOM' },
    speedMul:1.12, accelMul:1.16, steerMul:1.2, gripMul:1.18, brakeMul:1.12, rollMul:0.85,
    desc:'A darker, faster machine — sharp steering and strong grip.' },
  { name:'VOLT', kind:'stock', color:0x06b6d4,
    livery:{ body:0x06b6d4, hood:0x0a3d4a, roof:0xffffff, num:21, sponsor:'VOLT' },
    speedMul:1.06, accelMul:1.30, steerMul:1.14, gripMul:1.10, brakeMul:1.18, rollMul:0.95,
    desc:'Electric launch — explosive acceleration and braking.' },
  { name:'TITAN', kind:'stock', color:0xf59e0b,
    livery:{ body:0xf59e0b, hood:0x1a1a1a, roof:0x1a1a1a, num:55, sponsor:'TITAN' },
    speedMul:1.20, accelMul:0.92, steerMul:0.84, gripMul:0.92, brakeMul:0.9, rollMul:1.2,
    desc:'A heavy muscle bruiser — huge top speed, lazy in the bends.' },
  { name:'SABRE', kind:'stock', color:0x9333ea,
    livery:{ body:0x9333ea, hood:0xfacc15, roof:0xfacc15, num:88, sponsor:'SABRE' },
    speedMul:1.14, accelMul:1.12, steerMul:1.1, gripMul:1.14, brakeMul:1.08, rollMul:0.92,
    desc:'A sleek GT all-rounder — quick everywhere, no weakness.' },
];
// stock-car liveries for the AI field (varied colours + race numbers)
const RIVAL_LIVERIES = [
  { body:0xffffff, hood:0xd6262b, roof:0xd6262b, num:18, sponsor:'PAGODA' },
  { body:0x0b6b2f, hood:0x22c55e, roof:0xffffff, num:5,  sponsor:'GECKO'  },
  { body:0x1a1a1a, hood:0xf59e0b, roof:0xf59e0b, num:22, sponsor:'BLAZE'  },
  { body:0xffffff, hood:0x2f6cff, roof:0x2f6cff, num:9,  sponsor:'WAVE'   },
  { body:0x2a0f3a, hood:0xa855f7, roof:0xffffff, num:3,  sponsor:'NOVA'   },
  { body:0xffffff, hood:0x06b6d4, roof:0x06b6d4, num:11, sponsor:'AQUA'   },
  { body:0x1a1a1a, hood:0xec4899, roof:0xffffff, num:27, sponsor:'FLASH'  },
  { body:0xd6262b, hood:0xfacc15, roof:0xffffff, num:88, sponsor:'BOLT'   },
  { body:0x166534, hood:0x4ade80, roof:0xffffff, num:14, sponsor:'VIPER'  },
  { body:0x0c4a6e, hood:0x38bdf8, roof:0xffffff, num:6,  sponsor:'STORM'  },
];

// ----------------------------------------------------------------------------
//  Constants & globals
// ----------------------------------------------------------------------------
const ROAD_W   = 13;           // road half-width (wider track)
const RUMBLE_W = 1.6;          // kerb width
const GRASS_W  = ROAD_W * 8;   // grass apron half-extent
const DIV      = 1400;         // track frame samples
const STEP     = 1/60;         // fixed physics timestep
const CAR_SCALE = 1.35;        // overall car size
const UP       = new THREE.Vector3(0,1,0);

const MOBILE = (typeof navigator!=='undefined') &&
  (/iPhone|iPad|iPod|Android|Mobi/i.test(navigator.userAgent) ||
   ((navigator.maxTouchPoints||0) > 1 && Math.min(window.innerWidth,window.innerHeight) < 820));

let renderer, scene, camera, sun, sky, hemiLight, ambLight;
let _GPU=false, _post=null;   // WebGPU renderer + its post-processing (bloom) pipeline
// Granular WebGPU-only material switches, re-enabled one group at a time so a
// blank render can be isolated. PAINT (iridescence + env) and EMIS (emissive
// bloom) are device-safe PBR/value tweaks; HIRES (512px tiles) and NORMAL
// (normal maps on Lambert — the prime blank suspect) stay off pending testing.
let _GPU_PAINT=false, _GPU_EMIS=false, _GPU_HIRES=false, _GPU_NORMAL=false;
let glCanvas, hud2d, hctx;
let frames = [], trackLen = 0;
let playerCar = null;
let _ctxLost = false;
let _spinners = [];          // ambient rotating polygons (e.g. the London Eye)
let _flags = [];             // waving flag strips
let _sway = [];              // gently swaying props (trees)
let _pulse = [];             // pulsing emissive lights (clock faces, pods, windows)
let _scroll = [];            // scrolling textures (city windows shimmer)
let _crowd = [];             // shimmering grandstand crowds
let _wave = [];              // grandstand crowd "wave" segments
let _adt = 1/60;             // last frame delta, for animation
let _animClock = 0;          // global animation time
let _smoke = [];             // arcade tyre-smoke puff pool
let _smokeGroup = null;
let _smokeT = 0;             // emit throttle
let _callout = null;         // big arcade callout text {text,color,t}
let _lastPos = 99;           // for overtake detection
let _lastOvertakeT = -9;     // overtake-callout cooldown clock
let _clouds = [];            // drifting sky cloud billboards
let _grainCanvas = null;     // pre-rendered film-grain tile
let _maxAniso = 8;           // max texture anisotropy (set from renderer caps)

const keys = { gas:false, brake:false, left:false, right:false, boost:false };

const G = {
  state: 'menu',          // menu | rolling | racing | finished
  started: false,
  circuit: CIRCUITS[1],
  vehicle: VEHICLES[1],
  theme: THEMES[3],
  dist: 0, offset: 0, speed: 0, steerVis: 0,
  lap: 1, maxSpeed: 120, view: 'chase',   // chase | cockpit
  // race timing / scoring
  timeLeft: 0, totalTime: 0, rollT: 0, cdNum: -1, green: false,
  banner: 0,
  boost: 1, boostActive: false,           // nitro meter (0..1) and whether it's firing
  lapStart: 0, bestLap: 0, night: false,  // lap timing + best-lap record + day/night
  rain: false, lastWin: false,            // weather + remembered race result (for replay)
  champ: null, recordSet: false,          // championship session (null = single race)
};
let rivals = [];

// ---- persistent best-lap records (localStorage; safe in private mode) ----
let _records = {};
function loadRecords(){ try{ _records = JSON.parse(localStorage.getItem('daytona3d_records')||'{}')||{}; }catch(e){ _records={}; } }
function recordKey(){ return (G.circuit&&G.circuit.name||'?'); }
function bestLapFor(){ return _records[recordKey()] || 0; }
function saveBestLap(t){ try{ _records[recordKey()]=t; localStorage.setItem('daytona3d_records', JSON.stringify(_records)); }catch(e){} }

// ---- driver profile: persistent credits + stats, and live drift score ----
let _profile={credits:0, races:0, wins:0};
let _sessionScore=0, _driftActive=0, _driftCombo=1;
function loadProfile(){ try{ _profile=Object.assign({credits:0,races:0,wins:0}, JSON.parse(localStorage.getItem('daytona3d_profile')||'{}')); }catch(e){} }
function saveProfile(){ try{ localStorage.setItem('daytona3d_profile', JSON.stringify(_profile)); }catch(e){} }

// ---- ghost of your best lap, per circuit (a flat list of [t, dist, offset]) ----
let _ghosts={}, ghostCar=null, _ghost=null, _lapTrace=[], _ghostDelta=null;
function loadGhosts(){ try{ _ghosts=JSON.parse(localStorage.getItem('daytona3d_ghosts')||'{}')||{}; }catch(e){ _ghosts={}; } }
function ghostFor(){ const g=_ghosts[recordKey()]; return (g&&g.length>1)?g:null; }
function saveGhost(trace){ try{ _ghosts[recordKey()]=trace; localStorage.setItem('daytona3d_ghosts', JSON.stringify(_ghosts)); }catch(e){} }
// look up the ghost's {d,o} at lap-time lt (samples are sorted by t)
function ghostAt(lt){
  const g=_ghost; let lo=0, hi=g.length-1;
  if (lt<=g[0][0]) return {d:g[0][1], o:g[0][2]};
  if (lt>=g[hi][0]) return {d:g[hi][1], o:g[hi][2]};
  while (hi-lo>1){ const m=(lo+hi)>>1; if (g[m][0]<=lt) lo=m; else hi=m; }
  const a=g[lo], b=g[hi], f=(lt-a[0])/((b[0]-a[0])||1);
  let dd=b[1]-a[1]; if(dd<-trackLen/2)dd+=trackLen; else if(dd>trackLen/2)dd-=trackLen;
  let d=a[1]+dd*f; if(d<0)d+=trackLen; if(d>=trackLen)d-=trackLen;
  return { d, o:a[2]+(b[2]-a[2])*f };
}
// the ghost's lap-time when it was at the player's current dist (for the +/- delta)
function ghostTimeAtDist(dist){
  const g=_ghost; for (let i=1;i<g.length;i++){ const a=g[i-1], b=g[i];
    let lo=a[1], hi=b[1]; if (hi<lo-trackLen/2) hi+=trackLen;        // unwrap a single step
    let dq=dist; if (dq<lo-trackLen/2) dq+=trackLen;
    if (dq>=lo && dq<=hi){ const f=(dq-lo)/((hi-lo)||1); return a[0]+(b[0]-a[0])*f; }
  }
  return null;
}
function makeGhost(g){   // make a built car translucent + ghostly cyan
  g.traverse(o=>{ if(!o.isMesh) return; o.castShadow=false;
    const ms=Array.isArray(o.material)?o.material:[o.material];
    for (const m of ms){ if(!m) continue; m.transparent=true; m.opacity=0.30; m.depthWrite=false;
      if (m.emissive){ m.emissive.setHex(0x1aa3c8); m.emissiveIntensity=0.6; } }
  });
}
function placeGhost(){
  if (!ghostCar) return;
  if (!_ghost || (G.state!=='racing' && G.state!=='rolling')){ ghostCar.visible=false; _ghostDelta=null; return; }
  ghostCar.visible=true;
  const lt=Math.max(0, G.totalTime-G.lapStart);
  const gp=ghostAt(lt); placeCar(ghostCar, gp.d, gp.o);
  const gt=ghostTimeAtDist(G.dist); _ghostDelta = (gt==null)?null:(lt-gt);   // +ve = behind your ghost
}

// ----------------------------------------------------------------------------
//  Boot
// ----------------------------------------------------------------------------
function initThree(){
  glCanvas = document.getElementById('gl');
  hud2d    = document.getElementById('hud2d');
  hctx     = hud2d.getContext('2d');

  // EXPERIMENTAL WebGPU path (opt-in via ?webgpu=1): the WebGPU build exposes
  // WebGPURenderer; everything else (scene/materials) is identical. Falls back to
  // the proven WebGLRenderer when the WebGPU build isn't loaded.
  _GPU = (typeof THREE.WebGPURenderer === 'function');
  _GPU_PAINT = _GPU; _GPU_EMIS = _GPU;   // device-safe WebGPU material upgrades on; HIRES/NORMAL stay off
  // Mobile: skip MSAA — at full 3x density the supersampling antialiases edges
  // for free, and MSAA buffers at that resolution risk GPU memory / context loss.
  if (_GPU){
    renderer = new THREE.WebGPURenderer({ canvas:glCanvas, antialias:!MOBILE });
  } else {
    renderer = new THREE.WebGLRenderer({ canvas:glCanvas, antialias:!MOBILE, powerPreference:'high-performance' });
  }
  // render at the device's native pixel density (capped at 3x) for max sharpness
  renderer.setPixelRatio(Math.min(3, window.devicePixelRatio||1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  renderer.shadowMap.enabled = true;                 // real-time shadows on mobile too (pushed)
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  _maxAniso = (renderer.capabilities && renderer.capabilities.getMaxAnisotropy) ? renderer.capabilities.getMaxAnisotropy() : 8;
  if (_GPU){ try{ setupWebGPU(); }catch(e){ console.warn('WebGPU post-fx setup failed', e); } }

  // Recover from a lost GPU context (iOS Safari can drop it). preventDefault on
  // 'lost' is REQUIRED or the browser never restores it (permanent black screen).
  glCanvas.addEventListener('webglcontextlost', e=>{ e.preventDefault(); _ctxLost=true; }, false);
  glCanvas.addEventListener('webglcontextrestored', ()=>{ _ctxLost=false; resize(); }, false);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fbfff);
  scene.fog = new THREE.Fog(0xbfe2ff, 1100, 3200);

  camera = new THREE.PerspectiveCamera(62, 1, 0.5, 5000);

  hemiLight = new THREE.HemisphereLight(0xdfe6ee, 0x49663b, 0.58);   // softer, less-blue sky light so flat surfaces aren't washed blue
  scene.add(hemiLight);
  ambLight = new THREE.AmbientLight(0xffffff, 0.30); scene.add(ambLight);
  sun = new THREE.DirectionalLight(0xfff0c4, 2.0);                  // warmer, stronger key light
  sun.position.set(60,120,30);
  sun.castShadow = true;
  {
    const SM = MOBILE?1536:2048;                     // a touch smaller on mobile for memory
    sun.shadow.mapSize.set(SM,SM);
    sun.shadow.camera.near=1; sun.shadow.camera.far=340;
    const S=MOBILE?58:70; sun.shadow.camera.left=-S; sun.shadow.camera.right=S; sun.shadow.camera.top=S; sun.shadow.camera.bottom=-S;
    sun.shadow.bias=-0.0006; sun.shadow.normalBias=0.6;
  }
  scene.add(sun); scene.add(sun.target);

  buildSky();
  resize();
  window.addEventListener('resize', resize);
}

function buildSky(){
  if (sky){ scene.remove(sky); sky.geometry.dispose(); sky.material.dispose(); }
  const th = G.theme || THEMES[3];
  // night swaps in a dark starless-blue gradient; day uses the theme's sky
  const top   = G.night ? '#04050d' : th.skyTop;
  const mid   = G.night ? '#0a1226' : th.skyMid;
  const horiz = G.night ? '#162038' : th.skyHorizon;
  const cv = document.createElement('canvas'); cv.width=16; cv.height=256;
  const x = cv.getContext('2d');
  const g = x.createLinearGradient(0,0,0,256);
  g.addColorStop(0, top); g.addColorStop(0.55, mid); g.addColorStop(1, horiz);
  x.fillStyle=g; x.fillRect(0,0,16,256);
  if (G.night){ x.fillStyle='#fff'; for(let i=0;i<60;i++){ x.globalAlpha=0.3+Math.random()*0.6; x.fillRect((Math.random()*16)|0,(Math.random()*150)|0,1,1);} x.globalAlpha=1; }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map:tex, side:THREE.BackSide, fog:false, depthWrite:false });
  sky = new THREE.Mesh(new THREE.SphereGeometry(3500, 16, 12), mat);
  scene.add(sky);
  scene.background = new THREE.Color(horiz);
  scene.fog.color.set(horiz);
  applyTimeOfDay();
  buildSunGlow();
}
// adjust the key/fill lights + exposure for day vs night
function applyTimeOfDay(){
  if (!sun) return;
  if (G.night){
    sun.color.setHex(0x9fb4e0); sun.intensity=0.5;
    if (hemiLight){ hemiLight.intensity=0.28; hemiLight.color.setHex(0x6072a0); hemiLight.groundColor.setHex(0x161c2a); }
    if (ambLight) ambLight.intensity=0.22;
    renderer.toneMappingExposure=1.12;
  } else {
    sun.color.setHex(0xfff0c4); sun.intensity=2.0;
    if (hemiLight){ hemiLight.intensity=0.58; hemiLight.color.setHex(0xdfe6ee); hemiLight.groundColor.setHex(0x49663b); }
    if (ambLight) ambLight.intensity=0.30;
    renderer.toneMappingExposure=0.98;
  }
}

// a bright sun disc with an additive glow halo — fake "bloom" that is iOS-safe
// (no post-processing). Lives on the sky sphere so it sits at infinity.
let _sunSprite=null;
function buildSunGlow(){
  if (_sunSprite){ _sunSprite.geometry.dispose(); _sunSprite.material.map.dispose(); _sunSprite.material.dispose(); _sunSprite=null; }
  const cv=document.createElement('canvas'); cv.width=cv.height=128; const x=cv.getContext('2d');
  const g=x.createRadialGradient(64,64,2,64,64,64);
  if (G.night){   // a cool, tight moon glow
    g.addColorStop(0,'rgba(232,240,255,0.95)'); g.addColorStop(0.18,'rgba(200,215,245,0.6)');
    g.addColorStop(0.45,'rgba(150,170,220,0.16)'); g.addColorStop(1,'rgba(150,170,220,0)');
  } else {
    g.addColorStop(0,'rgba(255,252,242,1)'); g.addColorStop(0.16,'rgba(255,246,212,0.95)');
    g.addColorStop(0.42,'rgba(255,226,150,0.35)'); g.addColorStop(0.7,'rgba(255,210,140,0.10)'); g.addColorStop(1,'rgba(255,210,140,0)');
  }
  x.fillStyle=g; x.fillRect(0,0,128,128);
  const tex=new THREE.CanvasTexture(cv); tex.colorSpace=THREE.SRGBColorSpace;
  const m=new THREE.MeshBasicMaterial({map:tex, transparent:true, depthWrite:false, fog:false, blending:THREE.AdditiveBlending});
  _sunSprite=new THREE.Mesh(new THREE.PlaneGeometry(G.night?420:820, G.night?420:820), m);
  _sunSprite.position.copy(sun.position).normalize().multiplyScalar(3100);
  _sunSprite.renderOrder=1;
  sky.add(_sunSprite);
  buildClouds();
}

// soft volumetric-ish cloud billboards drifting across the sky
let _cloudTex=null;
function makeCloudTexture(){
  if (_cloudTex) return _cloudTex;
  const cv=document.createElement('canvas'); cv.width=256; cv.height=128; const x=cv.getContext('2d');
  for (let i=0;i<14;i++){ const cx=40+Math.random()*176, cy=60+Math.random()*45, r=24+Math.random()*42;
    const g=x.createRadialGradient(cx,cy,0,cx,cy,r); g.addColorStop(0,'rgba(255,255,255,0.9)'); g.addColorStop(0.6,'rgba(248,250,255,0.4)'); g.addColorStop(1,'rgba(248,250,255,0)');
    x.fillStyle=g; x.beginPath(); x.arc(cx,cy,r,0,6.28); x.fill(); }
  _cloudTex=new THREE.CanvasTexture(cv); _cloudTex.colorSpace=THREE.SRGBColorSpace; return _cloudTex;
}
function buildClouds(){
  _clouds=[];
  const tex=makeCloudTexture();
  const N=MOBILE?5:8;
  for (let i=0;i<N;i++){
    const m=new THREE.MeshBasicMaterial({map:tex, transparent:true, opacity:0.7, depthWrite:false, fog:false});
    const sz=600+(mulberry32(i*7+3)())*700;
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(sz,sz*0.5), m);
    const ang=(i/N)*Math.PI*2 + mulberry32(i+1)()*0.6, rad=2400+mulberry32(i+9)()*500, hy=700+mulberry32(i+4)()*900;
    mesh.userData={ang, rad, hy, spin:0.006+mulberry32(i+2)()*0.01};
    sky.add(mesh); _clouds.push(mesh);
  }
}
function updateClouds(){
  for (const c of _clouds){ const u=c.userData; u.ang += u.spin*_adt;
    c.position.set(Math.cos(u.ang)*u.rad, u.hy, Math.sin(u.ang)*u.rad);
    if (camera) c.quaternion.copy(camera.quaternion);
  }
}

// environment map for glossy paint/chrome/glass reflections (the "modern" look)
let envTex=null;
function buildEnv(){
  try {
    const th=G.theme, W=256, H=128;
    const cv=document.createElement('canvas'); cv.width=W; cv.height=H; const x=cv.getContext('2d');
    const sky = x.createLinearGradient(0,0,0,H);
    if (G.night){ sky.addColorStop(0,'#04060f'); sky.addColorStop(0.45,'#0a1226'); sky.addColorStop(0.6,'#172238'); }
    else { sky.addColorStop(0, th.skyTop); sky.addColorStop(0.45, th.skyMid); sky.addColorStop(0.6, th.skyHorizon); }
    x.fillStyle=sky; x.fillRect(0,0,W,H*0.62);
    // horizon haze band
    const hz=x.createLinearGradient(0,H*0.5,0,H*0.66); hz.addColorStop(0,'rgba(255,255,255,0)'); hz.addColorStop(1, G.night?'rgba(120,140,190,0.25)':'rgba(255,250,235,0.45)');
    x.fillStyle=hz; x.fillRect(0,H*0.5,W,H*0.16);
    // sun (day) or moon + stars (night)
    if (G.night){
      x.fillStyle='#fff'; for(let i=0;i<70;i++){ x.globalAlpha=0.3+Math.random()*0.6; x.fillRect((Math.random()*W)|0,(Math.random()*H*0.55)|0,1,1);} x.globalAlpha=1;
      const mg=x.createRadialGradient(W*0.74,H*0.2,1,W*0.74,H*0.2,22); mg.addColorStop(0,'rgba(225,235,255,1)'); mg.addColorStop(1,'rgba(180,200,240,0)');
      x.fillStyle=mg; x.beginPath(); x.arc(W*0.74,H*0.2,22,0,6.28); x.fill();
      // distant city window glints for reflections
      x.fillStyle='rgba(255,210,140,0.9)'; for(let i=0;i<60;i++){ if(Math.random()<0.5) x.fillRect((Math.random()*W)|0, H*0.5+(Math.random()*H*0.1)|0, 1,1); }
    } else {
      const sg=x.createRadialGradient(W*0.74,H*0.22,2,W*0.74,H*0.22,40); sg.addColorStop(0,'rgba(255,252,238,1)'); sg.addColorStop(0.3,'rgba(255,246,210,0.7)'); sg.addColorStop(1,'rgba(255,246,210,0)');
      x.fillStyle=sg; x.fillRect(W*0.74-44,0,88,80);
    }
    // reflective ground with subtle streaks (gives the paint a road reflection)
    const gnd=x.createLinearGradient(0,H*0.62,0,H); gnd.addColorStop(0, G.night?'#0c0f16':'#3b4a39'); gnd.addColorStop(1, G.night?'#05060a':'#222a1c');
    x.fillStyle=gnd; x.fillRect(0,H*0.62,W,H*0.38);
    x.globalAlpha=0.10; x.fillStyle='#fff'; for(let i=0;i<40;i++){ x.fillRect(Math.random()*W, H*0.62+Math.random()*H*0.36, 6+Math.random()*20, 1); } x.globalAlpha=1;
    const eq=new THREE.CanvasTexture(cv); eq.mapping=THREE.EquirectangularReflectionMapping; eq.colorSpace=THREE.SRGBColorSpace;
    const pmrem=new THREE.PMREMGenerator(renderer);
    const rt=pmrem.fromEquirectangular(eq);
    if (envTex) envTex.dispose();
    // NOTE: do NOT set scene.environment — that would reflect on the road's Lambert
    // material too (sky-blue asphalt). envTex is applied only to car paint/chrome/glass.
    envTex=rt.texture;
    eq.dispose(); pmrem.dispose();
  } catch(e){ /* reflections optional (PMREM may be unavailable on some backends) */ }
}

// ----------------------------------------------------------------------------
//  Track
// ----------------------------------------------------------------------------
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

function buildTrack(circuit){
  G.theme = THEMES[circuit.theme||0] || THEMES[3];
  const curveMul = circuit.curveMul || 1;
  const rng = mulberry32((circuit.seed||1) * 2654435761);

  let cps;
  if (circuit.layout){
    cps = circuit.layout.map(p=>new THREE.Vector3(p[0],p[1],p[2]));
  } else {
    cps = [];
    const NCP = 14;
    for (let i=0;i<NCP;i++){
      const ang = (i/NCP)*Math.PI*2;
      const r = 200 + Math.sin(ang*2 + circuit.seed)*60*curveMul + Math.sin(ang*3)*34*curveMul + (rng()-0.5)*30;
      const y = Math.sin(ang*2)*3 + (rng()-0.5)*2;
      cps.push(new THREE.Vector3(Math.cos(ang)*r, y, Math.sin(ang)*r));
    }
  }
  const curve = new THREE.CatmullRomCurve3(cps, true, 'catmullrom', 0.5);
  trackLen = curve.getLength();

  frames = [];
  for (let i=0;i<DIV;i++){
    const u = i/DIV;
    const pos = curve.getPointAt(u);
    const tan = curve.getTangentAt(u).normalize();
    const flatRight = new THREE.Vector3().crossVectors(tan, UP).normalize();
    frames.push({ pos, tan, flatRight, right:flatRight.clone(), up:UP.clone(), curv:0, bank:0 });
  }
  // signed curvature (heading change per sample)
  for (let i=0;i<DIV;i++){
    const a=frames[i].tan, b=frames[(i+1)%DIV].tan;
    const ha=Math.atan2(a.x,a.z), hb=Math.atan2(b.x,b.z);
    let d=hb-ha; while(d>Math.PI)d-=Math.PI*2; while(d<-Math.PI)d+=Math.PI*2;
    frames[i].curv=d;
  }
  // smooth curvature, then bank each cross-section
  const sm=new Array(DIV), WIN=14;
  for (let i=0;i<DIV;i++){ let s=0; for(let k=-WIN;k<=WIN;k++) s+=frames[(i+k+DIV)%DIV].curv; sm[i]=s/(WIN*2+1); }
  const BANK_K=38, MAXB=0.20, FLAT=120;
  for (let i=0;i<DIV;i++){
    const f=frames[i];
    f.bank = Math.max(-MAXB, Math.min(MAXB, sm[i]*BANK_K*curveMul));
    const di = Math.min(i, DIV-i);
    if (di < FLAT) f.bank *= 0.5 - 0.5*Math.cos(Math.PI*di/FLAT);   // flatten through start/finish
    f.right = f.flatRight.clone().applyAxisAngle(f.tan, f.bank);
    f.up = new THREE.Vector3().crossVectors(f.tan, f.right).normalize();
  }
}

// world position at (dist, lateral offset) — interpolated, follows the banked surface
function worldPos(dist, offset, out){
  let fi = (dist/trackLen)*DIV; fi = ((fi%DIV)+DIV)%DIV;
  const i0 = Math.floor(fi), i1=(i0+1)%DIV, t=fi-i0;
  const A=frames[i0], B=frames[i1];
  out.copy(A.pos).lerp(B.pos, t);
  out.addScaledVector(A.right, offset);
  return out;
}
const _frame = { pos:new THREE.Vector3(), tan:new THREE.Vector3(), right:new THREE.Vector3(), up:new THREE.Vector3(), curv:0, bank:0 };
function frameAt(dist){
  let fi = (dist/trackLen)*DIV; fi = ((fi%DIV)+DIV)%DIV;
  const i0 = Math.floor(fi), i1=(i0+1)%DIV, t=fi-i0;
  const A=frames[i0], B=frames[i1];
  _frame.pos.copy(A.pos).lerp(B.pos, t);
  _frame.tan.copy(A.tan).lerp(B.tan, t).normalize();
  _frame.right.copy(A.right);
  _frame.up.copy(A.up);
  _frame.curv = A.curv; _frame.bank = A.bank;
  return _frame;
}

// ----------------------------------------------------------------------------
//  Road mesh (asphalt + grass verge + kerbs + start checker)
// ----------------------------------------------------------------------------
let roadParts = [];
function clearRoad(){ for (const m of roadParts){ scene.remove(m); m.geometry.dispose(); if(m.material.map)m.material.map.dispose(); m.material.dispose(); } roadParts=[]; }

function darken(hex, f){ const r=Math.round((hex>>16&255)*f), g=Math.round((hex>>8&255)*f), b=Math.round((hex&255)*f); return (r<<16)|(g<<8)|b; }
function surfTex(hexA, hexB, w, h, speck){
  const cv=document.createElement('canvas'); cv.width=w; cv.height=h; const x=cv.getContext('2d');
  const hx=v=>'#'+(v>>>0).toString(16).padStart(6,'0').slice(-6);
  x.fillStyle=hx(hexA); x.fillRect(0,0,w,h);
  const dk=shadeHex(hexA,-58), lt=shadeHex(hexA,42);
  // bold mottled patches for clearly visible variation
  for (let i=0;i<speck/3;i++){ x.globalAlpha=0.22+Math.random()*0.30; x.fillStyle=hx(Math.random()<0.5?dk:lt);
    const r=2.5+Math.random()*6; x.beginPath(); x.arc(Math.random()*w,Math.random()*h,r,0,6.28); x.fill(); }
  // high-contrast aggregate specks
  for (let i=0;i<speck;i++){ x.globalAlpha=0.55+Math.random()*0.45; x.fillStyle=hx(Math.random()<0.5?dk:hexB);
    const s=1+Math.random()*3; x.fillRect(Math.random()*w, Math.random()*h, s, s); }
  x.globalAlpha=1;
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping;
  t.anisotropy=_maxAniso;
  return t;
}
// detailed asphalt: aggregate + repair patches + oil stains + jagged cracks
// (used as both the colour map AND the bump map, so cracks recess and grit raises)
function makeAsphaltTex(w,h){
  const cv=document.createElement('canvas'); cv.width=w; cv.height=h; const x=cv.getContext('2d');
  x.fillStyle='#808288'; x.fillRect(0,0,w,h);
  for (let i=0;i<w*h/10;i++){ const v=Math.random()<0.5?55:175; x.globalAlpha=0.35+Math.random()*0.5; x.fillStyle=`rgb(${v},${v},${v})`; const s=1+Math.random()*2.6; x.fillRect(Math.random()*w,Math.random()*h,s,s); }
  for (let i=0;i<7;i++){ const g=80+Math.random()*70|0; x.globalAlpha=0.22; x.fillStyle=`rgb(${g},${g},${g})`; x.fillRect(Math.random()*w,Math.random()*h,24+Math.random()*70,24+Math.random()*50); }
  for (let i=0;i<12;i++){ x.globalAlpha=0.12+Math.random()*0.2; x.fillStyle='#1d1d1f'; x.beginPath(); x.arc(Math.random()*w,Math.random()*h,8+Math.random()*22,0,6.28); x.fill(); }
  x.globalAlpha=0.6; x.strokeStyle='#141416'; x.lineWidth=1.6; x.lineCap='round';
  for (let i=0;i<16;i++){ let px=Math.random()*w, py=Math.random()*h; x.beginPath(); x.moveTo(px,py);
    for (let s=0;s<7;s++){ px+=(Math.random()-0.5)*48; py+=(Math.random()-0.5)*48; x.lineTo(px,py); } x.stroke(); }
  x.globalAlpha=1;
  _asphaltCanvas=cv;
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=_maxAniso; return t;
}
let _asphaltCanvas=null;
// WebGPU: crank emissive (lit windows / neon) so the bloom pass has lush sources
function boostBloomEmissive(){ if(!_GPU_EMIS) return; for (const p of _pulse){ p.base*=2.4; if(p.mat) p.mat.emissiveIntensity=p.base; } }

function buildRoadMesh(){
  clearRoad();
  const th = G.theme;
  const segLen = trackLen/DIV;
  const V=THREE.Vector3;
  const ia=new V(),oa=new V(),ib=new V(),ob=new V();
  const pt=(out,f,lat,lift)=>{ out.copy(f.pos).addScaledVector(f.right,lat).addScaledVector(f.up,lift); return out; };

  // asphalt
  {
    const pos=[],uv=[],nor=[];
    const push=(p,u,v,n)=>{ pos.push(p.x,p.y,p.z); uv.push(u,v); nor.push(n.x,n.y,n.z); };
    for (let i=0;i<DIV;i++){
      const a=frames[i], b=frames[(i+1)%DIV];
      pt(ia,a,-ROAD_W,0); pt(oa,a,ROAD_W,0); pt(ib,b,-ROAD_W,0); pt(ob,b,ROAD_W,0);
      const va=i*segLen/20, vb=(i+1)*segLen/20;
      push(ia,0,va,a.up); push(ib,0,vb,b.up); push(ob,1,vb,b.up);
      push(ia,0,va,a.up); push(ob,1,vb,b.up); push(oa,1,va,a.up);
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    geo.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
    // Neutral dark-grey asphalt. The material COLOUR (not just the map) is set
    // dark so the road can never wash out to a blue tint under the sky light.
    // DoubleSide: on some track windings the asphalt normals face down, which would
    // back-face-cull the single-sided road and show the sky THROUGH it (a "blue road").
    const tex=makeAsphaltTex(_GPU_HIRES?512:256, _GPU_HIRES?1024:512); tex.repeat.set(5, 1);
    const rmat=new THREE.MeshLambertMaterial({map:tex, color:G.rain?0x3b424b:0x595c61, side:THREE.DoubleSide});
    if (_GPU_NORMAL){ try{ const n=heightToNormal(_asphaltCanvas, G.rain?2:4); n.repeat.set(5,1); rmat.normalMap=n; rmat.normalScale=new THREE.Vector2(G.rain?0.4:0.9,G.rain?0.4:0.9); }catch(e){ rmat.bumpMap=tex; rmat.bumpScale=0.6; } }
    else { rmat.bumpMap=tex; rmat.bumpScale=G.rain?0.3:0.6; }
    const mesh=new THREE.Mesh(geo, rmat);
    mesh.receiveShadow=true; scene.add(mesh); roadParts.push(mesh);
  }
  // grass verge (defines the ground surface used to ground scenery)
  {
    const pos=[],uv=[],nor=[];
    const push=(p,u,v,n)=>{ pos.push(p.x,p.y,p.z); uv.push(u,v); nor.push(n.x,n.y,n.z); };
    for (const sgn of [-1,1]) for (let i=0;i<DIV;i++){
      const a=frames[i], b=frames[(i+1)%DIV];
      const li=sgn*(ROAD_W+RUMBLE_W), lo=sgn*GRASS_W;
      pt(ia,a,li,-0.05); pt(oa,a,lo,-0.05); pt(ib,b,li,-0.05); pt(ob,b,lo,-0.05);
      const va=i*segLen/14, vb=(i+1)*segLen/14, uo=(GRASS_W-ROAD_W-RUMBLE_W)/14;
      push(ia,0,va,a.up); push(ib,0,vb,b.up); push(ob,uo,vb,b.up);
      push(ia,0,va,a.up); push(ob,uo,vb,b.up); push(oa,uo,va,a.up);
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    geo.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
    const gs=_GPU_HIRES?512:256; const tex=surfTex(th.grass, th.grass2, gs, gs, _GPU_HIRES?5200:2600); tex.repeat.set(3, 1);
    const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map:tex, side:THREE.DoubleSide, bumpMap:tex, bumpScale:0.3}));
    mesh.receiveShadow=true; scene.add(mesh); roadParts.push(mesh);
  }
  // kerbs + start/finish checker (vertex colours)
  {
    const pos=[],col=[],nor=[]; const c=new THREE.Color();
    const vert=(p,n)=>{ pos.push(p.x,p.y,p.z); col.push(c.r,c.g,c.b); nor.push(n.x,n.y,n.z); };
    const ribbon=(latIn,latOut,lift,colorFn)=>{
      for (let i=0;i<DIV;i++){
        const a=frames[i], b=frames[(i+1)%DIV];
        pt(ia,a,latIn,lift); pt(oa,a,latOut,lift); pt(ib,b,latIn,lift); pt(ob,b,latOut,lift);
        colorFn(i,c);
        vert(ia,a.up); vert(ib,b.up); vert(ob,b.up); vert(ia,a.up); vert(ob,b.up); vert(oa,a.up);
      }
    };
    ribbon(-ROAD_W-RUMBLE_W,-ROAD_W,0.02, i=>Math.floor(i/4)%2?c.setHex(0xd03a32):c.setHex(0xe9e9ee));
    ribbon( ROAD_W,ROAD_W+RUMBLE_W,0.02, i=>Math.floor(i/4)%2?c.setHex(0xd03a32):c.setHex(0xe9e9ee));
    // ---- lane markings ----
    // solid white edge lines just inside each kerb
    ribbon(ROAD_W-0.6, ROAD_W-0.3, 0.03, ()=>c.setHex(0xeaeaea));
    ribbon(-(ROAD_W-0.3), -(ROAD_W-0.6), 0.03, ()=>c.setHex(0xeaeaea));
    // dashed centre + lane lines (7 frames on / 7 off, per-frame so they follow curves)
    const dashed=(lat,hw)=>{
      for (let i=0;i<DIV;i++){
        if (Math.floor(i/7)%2) continue;
        const a=frames[i], b=frames[(i+1)%DIV];
        pt(ia,a,lat-hw,0.03); pt(oa,a,lat+hw,0.03); pt(ib,b,lat-hw,0.03); pt(ob,b,lat+hw,0.03);
        c.setHex(0xe6e6e6);
        vert(ia,a.up); vert(ib,b.up); vert(ob,b.up); vert(ia,a.up); vert(ob,b.up); vert(oa,a.up);
      }
    };
    dashed(0, 0.18);              // centre line
    dashed(ROAD_W*0.5, 0.15);     // right lane line
    dashed(-ROAD_W*0.5, 0.15);    // left lane line
    // start/finish checker across the road at frames 0..2
    const NB=10;
    for (let i=0;i<3;i++){
      const a=frames[i], b=frames[(i+1)%DIV];
      for (let s=0;s<NB;s++){
        const l1=-ROAD_W+(2*ROAD_W/NB)*s, l2=-ROAD_W+(2*ROAD_W/NB)*(s+1);
        pt(ia,a,l1,0.05); pt(oa,a,l2,0.05); pt(ib,b,l1,0.05); pt(ob,b,l2,0.05);
        c.setHex((i+s)%2===0?0xffffff:0x14181c);
        vert(ia,a.up); vert(ib,b.up); vert(ob,b.up); vert(ia,a.up); vert(ob,b.up); vert(oa,a.up);
      }
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    geo.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
    geo.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
    const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({vertexColors:true, side:THREE.DoubleSide}));
    mesh.receiveShadow=true; scene.add(mesh); roadParts.push(mesh);
  }
}

// ----------------------------------------------------------------------------
//  Car
// ----------------------------------------------------------------------------
// ---- car materials ----
// subtle metallic-flake / orange-peel normal so the clearcoat sparkles
let _flakeTex=null;
function flakeNormalTex(){
  if (_flakeTex) return _flakeTex;
  const cv=document.createElement('canvas'); cv.width=cv.height=128; const x=cv.getContext('2d');
  const img=x.createImageData(128,128);
  for (let i=0;i<img.data.length;i+=4){ img.data[i]=128+(Math.random()*40-20); img.data[i+1]=128+(Math.random()*40-20); img.data[i+2]=255; img.data[i+3]=255; }
  x.putImageData(img,0,0);
  _flakeTex=new THREE.CanvasTexture(cv); _flakeTex.wrapS=_flakeTex.wrapT=THREE.RepeatWrapping; _flakeTex.repeat.set(5,5); return _flakeTex;
}
// a repeating clone of a cached detail tile (so a panel shows several tiles)
function detailClone(kind, rep){ const t=makeDetailTex(kind).clone(); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(rep,rep); t.needsUpdate=true; return t; }
// hero = the player's car gets full clearcoat PBR + flake; rivals get a cheaper metallic.
function paintMat(c, hero){
  if (hero){
    const m=new THREE.MeshPhysicalMaterial({color:c, metalness:0.55, roughness:0.34, clearcoat:1.0, clearcoatRoughness:0.05, envMap:envTex, envMapIntensity:_GPU_PAINT?2.2:1.7});
    m.clearcoatNormalMap=flakeNormalTex(); m.clearcoatNormalScale=new THREE.Vector2(0.16,0.16);
    m.roughnessMap=detailClone('rough',6);   // visible metallic-flake clusters in the sheen
    if (_GPU_PAINT){ try{ m.iridescence=0.25; m.iridescenceIOR=1.3; m.anisotropy=0.4; m.anisotropyRotation=Math.PI*0.25; m.clearcoatRoughness=0.03; }catch(e){} }   // ultra-real paint on WebGPU
    return m;
  }
  const m=new THREE.MeshStandardMaterial({color:c, metalness:0.42, roughness:0.34, envMap:envTex, envMapIntensity:_GPU_PAINT?1.6:1.25});
  m.roughnessMap=detailClone('rough',6);
  return m;
}
function matteMat(c){ const m=new THREE.MeshStandardMaterial({color:c, metalness:0, roughness:0.85}); const t=detailClone('rough',3); m.map=t;
  if (_GPU_NORMAL){ const n=detailNormal('rough',3); if(n){ m.normalMap=n; m.normalScale=new THREE.Vector2(0.6,0.6); } else { m.bumpMap=t; m.bumpScale=0.25; } }
  else { m.bumpMap=t; m.bumpScale=0.25; } return m; }
function glassMat(){ return new THREE.MeshStandardMaterial({color:0x070d18, metalness:0.7, roughness:0.04, envMap:envTex, envMapIntensity:_GPU_PAINT?2.4:1.8}); }
function chromeMat(){ const m=new THREE.MeshStandardMaterial({color:0xc4c9d2, metalness:0.95, roughness:0.2, envMap:envTex, envMapIntensity:1.4}); m.roughnessMap=makeDetailTex('metal'); return m; }
function shadeHex(hex, amt){ const r=Math.max(0,Math.min(255,(hex>>16&255)+amt)), g=Math.max(0,Math.min(255,(hex>>8&255)+amt)), b=Math.max(0,Math.min(255,(hex&255)+amt)); return (r<<16)|(g<<8)|b; }
let _emblemTex=null;
function emblemTex(){ if(_emblemTex)return _emblemTex; const cv=document.createElement('canvas'); cv.width=cv.height=64; const x=cv.getContext('2d');
  x.strokeStyle='#e8edf2'; x.lineWidth=5; x.beginPath(); x.arc(32,32,25,0,6.28); x.stroke(); x.lineWidth=4;
  for(let k=0;k<3;k++){ const a=-Math.PI/2+k*2*Math.PI/3; x.beginPath(); x.moveTo(32,32); x.lineTo(32+Math.cos(a)*23,32+Math.sin(a)*23); x.stroke(); }
  _emblemTex=new THREE.CanvasTexture(cv); return _emblemTex; }

// extrude a smooth car-shaped body from a side profile (front=+x, up=+y) -> faces +z
function extrudeCar(profile, width, bevel, mat){
  const s=new THREE.Shape(); s.moveTo(profile[0][0],profile[0][1]);
  s.splineThru(profile.slice(1).map(p=>new THREE.Vector2(p[0],p[1]))); s.closePath();
  const geo=new THREE.ExtrudeGeometry(s,{depth:width, bevelEnabled:bevel>0, bevelThickness:bevel, bevelSize:bevel, bevelSegments:3, steps:1, curveSegments:MOBILE?12:18});
  geo.translate(0,0,-width/2);
  const m=new THREE.Mesh(geo, mat); m.rotation.y=-Math.PI/2; return m;
}
const SED_LOWER=[[2.58,0.5],[2.62,0.92],[2.42,1.08],[1.4,1.14],[0.55,1.16],[-1.65,1.16],[-2.3,1.1],[-2.58,0.98],[-2.6,0.5],[-2.4,0.34],[2.4,0.34]];
const SED_GLASS=[[0.58,1.16],[0.34,1.58],[-1.05,1.62],[-1.6,1.32],[-1.62,1.16]];
const SED_ROOF =[[0.36,1.55],[-1.05,1.59],[-1.12,1.69],[0.3,1.65]];
const VAN_LOWER=[[2.64,0.54],[2.68,1.05],[2.5,1.3],[2.05,1.32],[-2.64,1.32],[-2.66,0.54],[-2.46,0.36],[2.46,0.36]];
const VAN_GLASS=[[2.05,1.32],[1.86,2.02],[-2.42,2.1],[-2.54,1.32]];
const VAN_ROOF =[[1.86,1.98],[-2.42,2.06],[-2.48,2.26],[1.8,2.18]];

function addGrille(g,w,y,z,lite){
  g.add(lmBox(matteMat(0x09090b), w,0.46,0.06, 0,y,z));
  if (lite) return;
  g.add(lmBox(chromeMat(), w+0.14,0.6,0.08, 0,y,z-0.03));
  for (let i=0;i<5;i++) g.add(lmBox(chromeMat(), 0.05,0.44,0.09, (i/4-0.5)*w*0.86, y, z+0.01));
}
function addLights(g,y,zf,zr,lite){
  g.userData.brakeMats=g.userData.brakeMats||[];
  const hl=new THREE.MeshStandardMaterial({color:0xfff7d6, emissive:0xfff0b0, emissiveIntensity:1.1, roughness:0.22});
  if (lite){   // rivals: simple emissive blocks
    for (const sx of [-0.82,0.82]){
      g.add(lmBox(hl, 0.5,0.2,0.08, sx,y,zf));
      const tl=new THREE.MeshStandardMaterial({color:0xff2a2a, emissive:0xdd1212, emissiveIntensity:0.8, roughness:0.45});
      g.add(lmBox(tl, 0.62,0.2,0.08, sx,y,-zr)); g.userData.brakeMats.push(tl);
    }
    return;
  }
  const housing=chromeMat();
  const lens=new THREE.MeshPhysicalMaterial({color:0xffffff, metalness:0, roughness:0.04, clearcoat:1, envMap:envTex, envMapIntensity:1.6, transparent:true, opacity:0.45});
  for (const sx of [-0.82,0.82]){
    // headlight: chrome reflector housing + bright projector + clear glass lens
    g.add(lmBox(housing, 0.62,0.32,0.05, sx,y,zf-0.02));
    g.add(lmBox(hl, 0.46,0.2,0.05, sx,y,zf+0.005));
    const cap=lmBox(lens, 0.58,0.3,0.05, sx,y,zf+0.03); cap.userData.noShadow=true; g.add(cap);
    // taillight: dark housing + segmented red LED bar (flares on brake)
    g.add(lmBox(matteMat(0x180606), 0.74,0.28,0.05, sx,y,-zr-0.005));
    const tl=new THREE.MeshStandardMaterial({color:0xff3024, emissive:0xe01410, emissiveIntensity:0.8, roughness:0.4});
    for (let i=0;i<3;i++) g.add(lmBox(tl, 0.19,0.18,0.07, sx+(i-1)*0.22, y, -zr));
    g.userData.brakeMats.push(tl);
  }
}
// a realistic multi-spoke alloy wheel face drawn on a canvas (machined silver + lug nuts)
let _wheelTex=null;
function makeWheelTexture(){
  if (_wheelTex) return _wheelTex;
  const S=160, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d'); const c=S/2;
  x.fillStyle='#0b0b0c'; x.beginPath(); x.arc(c,c,c,0,6.28); x.fill();                 // tyre
  x.fillStyle='#16191e'; x.beginPath(); x.arc(c,c,c*0.74,0,6.28); x.fill();            // rim well (dark)
  const g=x.createRadialGradient(c,c*0.7,4,c,c,c*0.7); g.addColorStop(0,'#e3e8ee'); g.addColorStop(0.6,'#aab1bb'); g.addColorStop(1,'#787f89');
  for (let k=0;k<5;k++){ x.save(); x.translate(c,c); x.rotate(k/5*6.28 - Math.PI/2); x.fillStyle=g;
    x.beginPath(); x.moveTo(-6,16); x.lineTo(6,16); x.lineTo(11,c*0.66); x.lineTo(-11,c*0.66); x.closePath(); x.fill(); x.restore(); }   // 5 spokes
  x.strokeStyle='#cfd5dd'; x.lineWidth=S*0.03; x.beginPath(); x.arc(c,c,c*0.72,0,6.28); x.stroke();   // polished outer lip
  const hg=x.createRadialGradient(c,c*0.9,2,c,c,18); hg.addColorStop(0,'#d7dce3'); hg.addColorStop(1,'#9aa0a9');
  x.fillStyle=hg; x.beginPath(); x.arc(c,c,18,0,6.28); x.fill();                       // centre cap
  x.fillStyle='#33373e'; for (let k=0;k<5;k++){ const a=k/5*6.28; x.beginPath(); x.arc(c+Math.cos(a)*11,c+Math.sin(a)*11,2.6,0,6.28); x.fill(); }   // lug nuts
  x.fillStyle='#202329'; x.beginPath(); x.arc(c,c,5,0,6.28); x.fill();
  _wheelTex=new THREE.CanvasTexture(cv); _wheelTex.colorSpace=THREE.SRGBColorSpace; return _wheelTex;
}
function addWheels(g,tx,tz,r,lite){
  const tyre=new THREE.CylinderGeometry(r,r,0.52,lite?10:22); tyre.rotateZ(Math.PI/2);
  const tm=new THREE.MeshStandardMaterial({color:0x0c0c0e, roughness:0.85, metalness:0.0});
  const simpleRim = lite ? new THREE.CylinderGeometry(r*0.62,r*0.62,0.54,8).rotateZ(Math.PI/2) : null;
  const rm=chromeMat();
  const wheelTex = lite?null:makeWheelTexture();
  const discGeo  = lite?null:new THREE.CircleGeometry(r*0.99, 30);
  const brakeGeo = lite?null:new THREE.CylinderGeometry(r*0.58,r*0.58,0.5,18).rotateZ(Math.PI/2);
  const brakeMat = lite?null:new THREE.MeshStandardMaterial({color:0x6a7078, metalness:0.8, roughness:0.4, emissive:0xff2a00, emissiveIntensity:0});
  if (brakeMat) g.userData.brakeDisc=brakeMat;   // glows red-hot under heavy braking
  g.userData.wheels = [];
  for (const [wx,wz] of [[-tx,tz],[tx,tz],[-tx,-tz],[tx,-tz]]){
    const wg=new THREE.Group(); wg.position.set(wx,r,wz);   // a spinnable hub group per corner
    wg.add(new THREE.Mesh(tyre,tm));
    if (!lite){
      wg.add(new THREE.Mesh(brakeGeo, brakeMat));
      const out = wx>0?1:-1;
      const disc=new THREE.Mesh(discGeo, new THREE.MeshStandardMaterial({map:wheelTex, metalness:0.65, roughness:0.4, envMap:envTex, envMapIntensity:1.0}));
      disc.position.x=out*0.27; disc.rotation.y=out*Math.PI/2; disc.userData.noShadow=true; wg.add(disc);
    } else {
      wg.add(new THREE.Mesh(simpleRim, rm));
    }
    g.add(wg); g.userData.wheels.push(wg);
  }
}
function addMirrors(g,x,y,z,mat){ for (const sx of [-x,x]){ g.add(lmBox(mat, 0.18,0.16,0.26, sx,y,z)); } }
// woven carbon-fibre for aero parts (splitter / wing / diffuser)
let _carbonTex=null;
function makeCarbonTex(){ if(_carbonTex) return _carbonTex; const S=64, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d');
  x.fillStyle='#141518'; x.fillRect(0,0,S,S);
  for(let r=0;r<S;r+=8) for(let c=0;c<S;c+=8){ const dk=((r/8+c/8)%2)===0; x.fillStyle=dk?'#23262c':'#0e0f12';
    x.fillRect(c,r,7,4); x.fillStyle=dk?'#0e0f12':'#23262c'; x.fillRect(c,r+4,7,4); }
  const t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(6,3); t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=_maxAniso; _carbonTex=t; return t; }
function carbonMat(){ return new THREE.MeshStandardMaterial({color:0xffffff, map:makeCarbonTex(), metalness:0.5, roughness:0.42, envMap:envTex, envMapIntensity:_GPU_PAINT?1.4:1.0}); }
// Extra stock-car detailing. Lite cars (rivals) get just a grille + mirrors so
// they read right next to the player; the full set is reserved for the hero car.
function addCarDetails(g, W, L, lite, liv){
  const chrome=chromeMat(), dark=matteMat(0x111317);
  const steel=new THREE.MeshStandardMaterial({color:0xb8bcc4, metalness:0.9, roughness:0.3, envMap:envTex, envMapIntensity:1.2});
  // front grille set into the nose + chrome headlight rings
  addGrille(g, W*0.6, 0.66, L*0.5+0.01, lite);
  for (const sx of [-0.82,0.82]) g.add(lmBox(chrome, 0.6,0.3,0.04, sx,0.82,L*0.5+0.005));
  // side mirrors at the A-pillars
  addMirrors(g, W/2-0.02, 1.18, 0.55, dark);
  if (lite) return;                                   // ---- hero-car richness below ----
  // carbon-fibre front splitter blade + a red tow hook poking out of the nose
  g.add(lmBox(carbonMat(), W+0.22, 0.05, 0.5, 0, 0.3, L*0.5+0.15));
  g.add(lmBox(new THREE.MeshStandardMaterial({color:0xd23b2a, roughness:0.6}), 0.16,0.1,0.12, 0,0.52,L*0.5+0.09));
  // side exhaust pipes running along each rocker
  const pg=new THREE.CylinderGeometry(0.09,0.09,1.7,10); pg.rotateX(Math.PI/2);
  for (const sx of [-1,1]){ const p=new THREE.Mesh(pg, steel); p.position.set(sx*(W/2+0.05), 0.34, -0.35); g.add(p); }
  // chrome hood pins + cowl vents on the hood deck
  for (const sx of [-0.78,0.78]) g.add(lmBox(chrome, 0.1,0.05,0.1, sx,1.11,2.0));
  for (const sx of [-0.3,0.3])   g.add(lmBox(dark,   0.16,0.04,0.5, sx,1.11,L*0.05));
  // driver-window safety net (left side)
  g.add(lmBox(new THREE.MeshStandardMaterial({color:0x0a0a0a, roughness:0.95}), 0.05,0.34,0.66, -(W/2-0.2),1.3,0.05));
  // roof flaps + a thin antenna
  for (const dz of [0.0,-0.5]) g.add(lmBox(dark, W-0.72,0.03,0.3, 0,1.61,dz-L*0.06));
  const ant=new THREE.Mesh(new THREE.CylinderGeometry(0.015,0.015,0.5,6), dark); ant.position.set(W*0.28,1.85,-L*0.1); g.add(ant);
  // windshield sun-visor sponsor band (raked to match the screen)
  const band=decal(makeSponsorTex(liv.sponsor||'DAYTONA', liv.body), 1.3,0.2);
  band.position.set(0,1.4,0.5); band.rotation.x=0.62; g.add(band);
  // ---- fine realism touches: panel shut-lines, chrome trim, door handles, wipers ----
  const seam=new THREE.MeshStandardMaterial({color:0x05060a, roughness:0.9});
  // hood & trunk shut-lines (thin recessed grooves across the deck)
  g.add(lmBox(seam, W-0.1,0.02,0.025, 0,1.10,L*0.22+0.96));
  g.add(lmBox(seam, W-0.1,0.02,0.025, 0,1.06,-L*0.34));
  // door shut-lines + a slim chrome door handle on each side
  for (const sx of [-1,1]){ const xe=sx*(W/2+0.005);
    g.add(lmBox(seam, 0.022,0.5,1.4, xe,0.78,0.0));                 // door cut
    g.add(lmBox(seam, 0.022,0.42,0.02, xe,0.78,0.7));              // front edge
    g.add(lmBox(chrome, 0.03,0.05,0.22, xe,1.0,-0.2));             // door handle
  }
  // chrome trim around the glasshouse (windscreen header + side rails)
  g.add(lmBox(chrome, W-0.42,0.04,0.05, 0,1.42,L*0.14+0.02));      // windscreen top trim
  for (const sx of [-1,1]) g.add(lmBox(chrome, 0.04,0.04,L*0.34, sx*(W/2-0.2),1.46,-L*0.06));
  // twin windscreen wipers
  for (const sx of [-0.4,0.1]) g.add(lmBox(seam, 0.025,0.03,0.5, sx, 1.06, L*0.14+0.06));
}
function addDetails(g, W, frontZ, rearZ, beltY, lowY){
  const chrome=chromeMat(), plate=new THREE.MeshStandardMaterial({color:0xeef0f2, roughness:0.5});
  const amber=new THREE.MeshStandardMaterial({color:0xff9a1f, emissive:0xc25500, emissiveIntensity:0.6, roughness:0.5});
  g.add(lmBox(plate, 0.92,0.26,0.05, 0,lowY,frontZ+0.02));
  g.add(lmBox(plate, 0.92,0.26,0.05, 0,lowY,-rearZ-0.02));
  g.add(lmBox(chrome, W+0.03,0.05,4.4, 0,beltY,-0.1));            // belt-line chrome
  for (const sx of [-1.02,1.02]) g.add(lmBox(amber, 0.2,0.12,0.06, sx,lowY+0.12,frontZ));
}

// ---- racing-number roundel + sponsor decal textures (Daytona stock-car style) ----
const _numCache={};
function makeNumberTex(num){
  if (_numCache[num]) return _numCache[num];
  const cv=document.createElement('canvas'); cv.width=cv.height=128; const x=cv.getContext('2d');
  x.clearRect(0,0,128,128);
  x.fillStyle='#ffffff'; x.beginPath(); x.arc(64,64,58,0,6.28); x.fill();
  x.lineWidth=8; x.strokeStyle='#111418'; x.beginPath(); x.arc(64,64,58,0,6.28); x.stroke();
  x.fillStyle='#111418'; x.font='900 86px Arial'; x.textAlign='center'; x.textBaseline='middle'; x.fillText(String(num),64,72);
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; _numCache[num]=t; return t;
}
function makeSponsorTex(text, accent){
  const cv=document.createElement('canvas'); cv.width=256; cv.height=80; const x=cv.getContext('2d');
  x.clearRect(0,0,256,80);
  x.font='italic 900 50px Arial'; x.textAlign='center'; x.textBaseline='middle';
  x.lineWidth=8; x.strokeStyle='#ffffff'; x.strokeText(text,128,42);
  x.fillStyle='#'+(accent>>>0).toString(16).padStart(6,'0').slice(-6); x.fillText(text,128,42);
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
}
function decal(tex, w, h){ return new THREE.Mesh(new THREE.PlaneGeometry(w,h), new THREE.MeshBasicMaterial({map:tex, transparent:true})); }

// smooth low stock-car body side profile (front=+x, up=+y) — rounded nose & tail
const STOCK_BODY=[[2.46,0.40],[2.54,0.74],[2.30,0.96],[1.5,1.02],[0.7,1.04],[-1.45,1.04],[-2.25,0.96],[-2.5,0.66],[-2.48,0.40],[-2.26,0.28],[2.26,0.28]];
// A Daytona-style NASCAR stock car with a smooth curved body. Front faces +z.
function buildCar(vehicle, lite){
  const liv = vehicle.livery || RIVAL_LIVERIES[0];
  const g=new THREE.Group();
  const hero=!lite;
  const main=paintMat(liv.body,hero), accent=paintMat(liv.hood,hero), roofM=paintMat(liv.roof!=null?liv.roof:liv.hood,hero);
  const white=paintMat(0xffffff,hero), glass=glassMat(), dark=matteMat(0x16181c);
  const L=4.9, W=2.16;
  // ---- smooth curved main body (sharper bevel = defined NASCAR panels, not bulbous) ----
  g.add(extrudeCar(STOCK_BODY, W, 0.07, main));
  // white lower band (rockers) + front splitter + rear bumper, slightly proud
  g.add(lmBox(white, W+0.12, 0.2, L*0.9, 0, 0.38, 0));
  g.add(lmBox(white, W+0.16, 0.16, 0.45, 0, 0.44, L*0.49));
  g.add(lmBox(white, W+0.12, 0.18, 0.4, 0, 0.42, -L*0.49));
  // blue HOOD — a big flat panel sitting clearly on the front deck (the key livery zone)
  const hood=lmBox(accent, W-0.06, 0.09, 1.9, 0, 1.05, L*0.22); hood.rotation.x=-0.05; g.add(hood);
  g.add(lmBox(accent, 0.7, 0.1, 0.7, 0, 1.12, L*0.12));   // centre cowl/scoop
  // ---- greenhouse: a tapered (chamfered) cabin so the roof isn't a plain box ----
  const cabLow=lmBox(roofM, W-0.36, 0.34, L*0.4, 0, 1.27, -L*0.05); g.add(cabLow);
  const cabTop=lmBox(roofM, W-0.62, 0.18, L*0.34, 0, 1.5, -L*0.06); g.add(cabTop);   // narrower roof = chamfer
  // roof number roundel (faces up)
  const rn=decal(makeNumberTex(liv.num), 1.2, 1.2); rn.rotation.x=-Math.PI/2; rn.rotation.z=Math.PI; rn.position.set(0,1.60,-L*0.06); g.add(rn);
  // glasshouse
  const ws=lmBox(glass, W-0.5, 0.44, 0.07, 0, 1.18, L*0.14); ws.rotation.x=0.62; g.add(ws);
  const rw=lmBox(glass, W-0.5, 0.42, 0.07, 0, 1.18, -L*0.26); rw.rotation.x=-0.62; g.add(rw);
  for (const sx of [-1,1]) g.add(lmBox(glass, 0.07, 0.32, L*0.3, sx*(W/2-0.22), 1.3, -L*0.06));
  // rear wing on uprights
  g.add(lmBox(main, W+0.02, 0.07, 0.46, 0, 1.45, -L*0.47));
  for (const sx of [-1,1]) g.add(lmBox(dark, 0.09, 0.4, 0.38, sx*W*0.42, 1.2, -L*0.45));
  // door number + sponsor decals (skip on lite rivals)
  if (!lite) for (const sx of [-1,1]){
    const dn=decal(makeNumberTex(liv.num), 0.92, 0.92); dn.position.set(sx*(W/2+0.04), 0.86, 0.42); dn.rotation.y=sx>0?-Math.PI/2:Math.PI/2; g.add(dn);
    const sp=decal(makeSponsorTex(liv.sponsor||'DAYTONA', liv.hood), 1.55,0.5); sp.position.set(sx*(W/2+0.04), 0.68, -0.7); sp.rotation.y=sx>0?-Math.PI/2:Math.PI/2; g.add(sp);
  }
  // sticker headlights + taillights (taillights flare under braking)
  addLights(g, 0.82, L*0.5, L*0.5, lite);
  // grille / mirrors / exhausts / hood pins / window net / antenna …
  addCarDetails(g, W, L, lite, liv);
  // racing wheels tucked under the fenders
  addWheels(g, W/2-0.04, L*0.3, 0.55, lite);
  // additive red glow behind the taillights (blooms under braking)
  const glowMat=new THREE.MeshBasicMaterial({map:glowTex(0xff2a1a), transparent:true, opacity:0.0, depthWrite:false, blending:THREE.AdditiveBlending, fog:false});
  g.userData.tailGlow=[];
  for (const sx of [-0.82,0.82]){ const q=new THREE.Mesh(new THREE.PlaneGeometry(1.5,1.1), glowMat.clone()); q.position.set(sx,0.82,-L*0.5-0.2); q.rotation.y=Math.PI; q.userData.noShadow=true; g.add(q); g.userData.tailGlow.push(q); }
  // a faint contact patch under the car — grounds distant cars that fall outside
  // the (tight) real-time shadow frustum; subtle so it doesn't double the shadow.
  { const sh=new THREE.Mesh(new THREE.PlaneGeometry(W*1.7,L*1.1), new THREE.MeshBasicMaterial({map:blobTex(), transparent:true, opacity:0.28, depthWrite:false, fog:false}));
    sh.rotation.x=-Math.PI/2; sh.position.y=0.04; sh.userData.noShadow=true; sh.renderOrder=-1; g.add(sh); }
  g.scale.setScalar(CAR_SCALE);   // bigger cars (wheels sit at y=0 so it stays grounded)
  g.traverse(o=>{ if(o.isMesh && !o.userData.noShadow){ o.castShadow=true; } });
  return g;
}
// cached soft radial textures for glows + contact shadow
let _blobTex=null, _glowCache={};
function blobTex(){ if(_blobTex) return _blobTex; const cv=document.createElement('canvas'); cv.width=cv.height=128; const x=cv.getContext('2d');
  const g=x.createRadialGradient(64,64,4,64,64,62); g.addColorStop(0,'rgba(0,0,0,0.6)'); g.addColorStop(0.6,'rgba(0,0,0,0.32)'); g.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=g; x.fillRect(0,0,128,128); _blobTex=new THREE.CanvasTexture(cv); return _blobTex; }
function glowTex(hex){ if(_glowCache[hex]) return _glowCache[hex]; const r=(hex>>16&255),g=(hex>>8&255),b=(hex&255);
  const cv=document.createElement('canvas'); cv.width=cv.height=128; const x=cv.getContext('2d');
  const gr=x.createRadialGradient(64,64,2,64,64,62); gr.addColorStop(0,`rgba(${r},${g},${b},1)`); gr.addColorStop(0.4,`rgba(${r},${g},${b},0.5)`); gr.addColorStop(1,`rgba(${r},${g},${b},0)`);
  x.fillStyle=gr; x.fillRect(0,0,128,128); const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; _glowCache[hex]=t; return t; }

// orient a mesh so local +Z = tangent, local +Y = surface up
const _xA=new THREE.Vector3(), _yA=new THREE.Vector3(), _zA=new THREE.Vector3(), _basis=new THREE.Matrix4(), _carPos=new THREE.Vector3();
function placeCar(mesh, dist, offset){
  worldPos(dist, offset, _carPos);
  const f=frameAt(dist);
  mesh.position.copy(_carPos);
  // Orient against WORLD UP so the car is always upright regardless of how the
  // track winds (CW vs CCW flips the surface-normal sign). Forward = the tangent
  // with its vertical component clamped so the car can never stand on its nose.
  _zA.copy(f.tan); _zA.y = Math.max(-0.4, Math.min(0.4, _zA.y));
  if (_zA.lengthSq() < 1e-4) _zA.set(0,0,1);
  _zA.normalize();
  _yA.set(0,1,0);
  _xA.crossVectors(_yA,_zA);
  if (_xA.lengthSq() < 1e-4) _xA.set(1,0,0);
  _xA.normalize();
  _yA.crossVectors(_zA,_xA).normalize();
  _basis.makeBasis(_xA,_yA,_zA);
  mesh.quaternion.setFromRotationMatrix(_basis);
}

// ----------------------------------------------------------------------------
//  Scenery: textures, landmark builders, and the grounded placement system
// ----------------------------------------------------------------------------
let sceneryGroup=null, _scnInfo='';
function disposeTree(obj){ obj.traverse(o=>{ if(o.geometry)o.geometry.dispose(); const m=o.material; if(m){ (Array.isArray(m)?m:[m]).forEach(mt=>{ if(mt.map)mt.map.dispose(); mt.dispose(); }); } }); }

const _detailCache={};
function makeDetailTex(kind){
  if (_detailCache[kind]) return _detailCache[kind];
  const S=_GPU_HIRES?512:256, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d');   // hi-res tile on WebGPU
  x.fillStyle='#e9e9e9'; x.fillRect(0,0,S,S);
  const grain=(n,a,sz)=>{ for(let i=0;i<n;i++){ const v=Math.random()<0.5?30:235; x.fillStyle=`rgba(${v},${v},${v},${Math.random()*a})`; x.fillRect(Math.random()*S,Math.random()*S,sz||2.2,sz||2.2);} };
  if (kind==='stone'){
    // brick courses with per-brick tone + bold dark mortar
    const rows=12, ch=S/rows, cols=8, cw=S/cols;
    for(let r=0;r<rows;r++){ const off=(r%2)?cw/2:0;
      for(let c=-1;c<=cols;c++){ const g=150+Math.random()*80|0; x.fillStyle=`rgb(${g},${g-8},${g-16})`; x.fillRect(c*cw+off+1.5, r*ch+1.5, cw-3, ch-3); } }
    grain(5200,0.16,2.0);
    x.strokeStyle='rgba(20,20,20,0.55)'; x.lineWidth=3.0;
    for(let r=0;r<=rows;r++){ const y=r*ch; x.beginPath(); x.moveTo(0,y); x.lineTo(S,y); x.stroke();
      const off=(r%2)?cw/2:0; for(let c=0;c<=cols;c++){ const vx=c*cw+off; x.beginPath(); x.moveTo(vx,y); x.lineTo(vx,y+ch); x.stroke(); } }
  } else if (kind==='metal'){
    // bold brushed streaks + panel seams + rivets
    for(let i=0;i<S;i++){ x.fillStyle=`rgba(0,0,0,${Math.random()*0.22})`; x.fillRect(0,i,S,1);
                          x.fillStyle=`rgba(255,255,255,${Math.random()*0.12})`; x.fillRect(0,i,S,0.6); }
    x.strokeStyle='rgba(0,0,0,0.5)'; x.lineWidth=3.0;
    for(const sx of [S*0.25,S*0.5,S*0.75]){ x.beginPath(); x.moveTo(sx,0); x.lineTo(sx,S); x.stroke(); }
    x.fillStyle='rgba(40,40,40,0.6)'; for(let i=0;i<120;i++){ x.beginPath(); x.arc(Math.random()*S,Math.random()*S,2.0,0,6.28); x.fill(); }
    grain(1500,0.12,1.8);
  } else if (kind==='glass'){
    const step=S/16;
    x.strokeStyle='rgba(0,0,0,0.4)'; x.lineWidth=2.0;
    for(let i=0;i<=S;i+=step){ x.beginPath(); x.moveTo(i,0); x.lineTo(i,S); x.stroke(); x.beginPath(); x.moveTo(0,i); x.lineTo(S,i); x.stroke(); }
    const n=Math.round(S/step);
    for(let r=0;r<n;r++)for(let c=0;c<n;c++){ if(Math.random()<0.4){ x.fillStyle=`rgba(255,255,255,${0.12+Math.random()*0.3})`; x.fillRect(c*step+2,r*step+2,step-4,step-4);} }
  } else {
    // 'rough' — bold mottled organic patches (foliage / concrete)
    for(let i=0;i<820;i++){ const v=Math.random()<0.5?60:225; x.globalAlpha=0.10+Math.random()*0.22; x.fillStyle=`rgb(${v},${v},${v})`; x.beginPath(); x.arc(Math.random()*S,Math.random()*S,2+Math.random()*9,0,6.28); x.fill(); }
    x.globalAlpha=1; grain(5600,0.20,2.4);
  }
  const t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=_maxAniso; t.generateMipmaps=true;
  _detailCache[kind]=t; _detailCanvas[kind]=cv; return t;
}
// derive a tangent-space normal map from a grayscale-ish source canvas (Sobel)
let _detailCanvas={}, _detailNorm={};
function heightToNormal(cv, strength){
  const S=cv.width, src=cv.getContext('2d').getImageData(0,0,S,S).data;
  const out=document.createElement('canvas'); out.width=out.height=S; const ox=out.getContext('2d'); const dst=ox.createImageData(S,S);
  const h=(i,j)=>{ i=(i+S)%S; j=(j+S)%S; const p=(j*S+i)*4; return (src[p]+src[p+1]+src[p+2])/765; };
  for (let j=0;j<S;j++) for (let i=0;i<S;i++){
    const dx=(h(i+1,j)-h(i-1,j))*strength, dy=(h(i,j+1)-h(i,j-1))*strength;
    let nx=-dx, ny=-dy, nz=1; const l=Math.hypot(nx,ny,nz)||1; nx/=l; ny/=l; nz/=l;
    const p=(j*S+i)*4; dst.data[p]=(nx*0.5+0.5)*255; dst.data[p+1]=(ny*0.5+0.5)*255; dst.data[p+2]=(nz*0.5+0.5)*255; dst.data[p+3]=255;
  }
  ox.putImageData(dst,0,0);
  const t=new THREE.CanvasTexture(out); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=_maxAniso; return t;
}
function detailNormal(kind, rep){
  try {
    if (!_detailNorm[kind]){ makeDetailTex(kind); _detailNorm[kind]=heightToNormal(_detailCanvas[kind], kind==='stone'?5:3); }
    const t=_detailNorm[kind].clone(); t.wrapS=t.wrapT=THREE.RepeatWrapping; if(rep) t.repeat.set(rep,rep); t.needsUpdate=true; return t;
  } catch(e){ return null; }
}
function txMat(opts, kind, rep){
  const m=new THREE.MeshStandardMaterial(opts);
  const k=kind||'rough';
  m.map=makeDetailTex(k).clone(); m.map.wrapS=m.map.wrapT=THREE.RepeatWrapping;
  if (rep) m.map.repeat.set(rep,rep); m.map.needsUpdate=true;
  if (_GPU_NORMAL){ const n=detailNormal(k, rep); if(n){ m.normalMap=n; m.normalScale=new THREE.Vector2(1.0,1.0); } }   // WebGPU: real normal mapping
  else { m.bumpMap=m.map; m.bumpScale=(k==='stone')?0.8:0.4; }
  return m;
}
function makeWindowTexture(glassy){
  const cv=document.createElement('canvas'); cv.width=cv.height=64; const x=cv.getContext('2d');
  x.fillStyle = glassy ? '#86aece' : '#565a61'; x.fillRect(0,0,64,64);
  for (let r=0;r<8;r++) for (let c=0;c<8;c++){ const lit=Math.random();
    x.fillStyle = glassy ? (lit<0.5?'#cfe6ff':'#6f97b8') : (lit<0.3?'#ffd98a':'#34373c');
    x.fillRect(c*8+1, r*8+1, 6, 5); }
  const t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.colorSpace=THREE.SRGBColorSpace; return t;
}
// a dense city-skyline silhouette strip (two layers for depth + lit windows)
function makeSkylineTexture(th){
  const W=2048, H=512; const cv=document.createElement('canvas'); cv.width=W; cv.height=H; const x=cv.getContext('2d');
  x.clearRect(0,0,W,H);
  const dubai = th && th.landmark==='dubai';
  const rng = mulberry32(((th&&th.landmark)||'city').length*131 + 7);
  const backCol  = dubai ? '#8295ac' : '#5b6678';
  const frontCol = dubai ? '#45566c' : '#343c4a';
  const winRGB   = dubai ? '255,228,158' : '255,212,150';
  // back layer — hazier, shorter
  x.globalAlpha=0.7; x.fillStyle=backCol;
  for (let bx=0; bx<W; ){ const bw=40+rng()*90, bh=H*(0.30+rng()*0.32); x.fillRect(bx, H-bh, bw-4, bh); bx+=bw; }
  x.globalAlpha=1;
  // front layer — darker, taller, with occasional spires
  x.fillStyle=frontCol; const fronts=[];
  for (let bx=0; bx<W; ){ const bw=48+rng()*120, bh=H*(0.42+rng()*0.5), fy=H-bh, fw=bw-5;
    x.fillRect(bx, fy, fw, bh); fronts.push([bx,fy,fw]);
    if (rng()<0.16){ x.fillRect(bx+fw/2-2, fy-30-rng()*44, 4, 46); }   // antenna / spire
    bx+=bw; }
  // lit windows on the front buildings
  for (const [fx,fy,fw] of fronts){
    for (let wy=fy+9; wy<H-6; wy+=12) for (let wx=fx+5; wx<fx+fw-5; wx+=10){
      if (rng()<0.45) continue;
      x.fillStyle=`rgba(${winRGB},${(0.3+rng()*0.55).toFixed(2)})`; x.fillRect(wx,wy,5,7);
    }
  }
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; t.wrapS=THREE.RepeatWrapping; return t;
}
// a continuous skyline ringing the circuit on the horizon, behind the near scenery
function buildSkylineBackdrop(cen, th){
  const tex=makeSkylineTexture(th); tex.repeat.set(3,1);
  const R=1100, Hc=460;
  const geo=new THREE.CylinderGeometry(R,R,Hc,64,1,true);
  const mat=new THREE.MeshBasicMaterial({map:tex, transparent:true, side:THREE.BackSide, fog:true, depthWrite:false});
  const ring=new THREE.Mesh(geo,mat);
  ring.position.set(cen.x, Hc*0.5 - 80, cen.z);   // base sinks below the horizon
  ring.renderOrder = -1;                            // draw behind the near world
  sceneryGroup.add(ring);
}
function makeClockFace(){
  const cv=document.createElement('canvas'); cv.width=cv.height=128; const x=cv.getContext('2d');
  x.fillStyle='#f3ead0'; x.beginPath(); x.arc(64,64,62,0,6.28); x.fill();
  x.lineWidth=7; x.strokeStyle='#caa64a'; x.beginPath(); x.arc(64,64,60,0,6.28); x.stroke();
  x.lineWidth=4; x.strokeStyle='#2a2113'; x.beginPath(); x.arc(64,64,52,0,6.28); x.stroke();
  x.fillStyle='#241c10'; for(let i=0;i<12;i++){ const a=i/12*6.28; const r1=46,r2=i%3===0?36:42;
    x.lineWidth=i%3===0?5:3; x.strokeStyle='#241c10'; x.beginPath(); x.moveTo(64+Math.cos(a)*r1,64+Math.sin(a)*r1); x.lineTo(64+Math.cos(a)*r2,64+Math.sin(a)*r2); x.stroke(); }
  x.strokeStyle='#15100a'; x.lineCap='round';
  x.lineWidth=6; x.beginPath(); x.moveTo(64,64); x.lineTo(64+Math.cos(-2.35)*28,64+Math.sin(-2.35)*28); x.stroke();
  x.lineWidth=4; x.beginPath(); x.moveTo(64,64); x.lineTo(64+Math.cos(-0.7)*42,64+Math.sin(-0.7)*42); x.stroke();
  x.fillStyle='#15100a'; x.beginPath(); x.arc(64,64,4,0,6.28); x.fill();
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
}
function makeLatticeTexture(){
  const cv=document.createElement('canvas'); cv.width=cv.height=64; const x=cv.getContext('2d');
  x.fillStyle='#9fc3b0'; x.fillRect(0,0,64,64); x.strokeStyle='#43705c'; x.lineWidth=2;
  for(let i=-64;i<64;i+=14){ x.beginPath(); x.moveTo(i,0); x.lineTo(i+64,64); x.stroke(); x.beginPath(); x.moveTo(i+64,0); x.lineTo(i,64); x.stroke(); }
  const t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.colorSpace=THREE.SRGBColorSpace; return t;
}
function makeCrowdTexture(){
  // Tiered bleacher packed with little spectators: each fan = a coloured torso
  // with a skin-tone head, arranged in staggered rows on shaded concrete steps.
  const cv=document.createElement('canvas'); cv.width=512; cv.height=192; const x=cv.getContext('2d');
  const ROWS=11, perRow=46, stepH=192/ROWS;
  const skins=['#f2c9a0','#e6b48c','#d59a6f','#b9774d','#8a5a36','#6b4528','#f7d7b5'];
  for (let r=0;r<ROWS;r++){
    const yTop=(ROWS-1-r)*stepH;                          // row 0 = front/bottom
    // concrete step: darker at the back, a lighter seat lip at the front
    const shade=28+r*4;
    x.fillStyle=`rgb(${shade+8},${shade+10},${shade+14})`; x.fillRect(0,yTop,512,stepH);
    x.fillStyle=`rgba(0,0,0,0.28)`; x.fillRect(0,yTop,512,Math.max(1,stepH*0.30));   // seat shadow
    const figH=stepH*1.05, headR=figH*0.20, bodyW=512/perRow*0.74;
    for (let c=0;c<perRow;c++){
      if (Math.random()<0.06) continue;                   // a few empty seats
      const cx=(c+0.5)*(512/perRow) + (r%2)*(512/perRow*0.5);
      const fy=yTop+stepH-figH*0.92;
      // torso (shirt)
      x.fillStyle=`hsl(${Math.floor(Math.random()*360)},${55+Math.random()*30|0}%,${42+Math.random()*30|0}%)`;
      x.fillRect(cx-bodyW/2, fy+headR*1.4, bodyW, figH-headR*1.4);
      // head (skin)
      x.fillStyle=skins[Math.random()*skins.length|0];
      x.beginPath(); x.arc(cx, fy+headR, headR, 0, Math.PI*2); x.fill();
    }
  }
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace;
  t.anisotropy=4; return t;
}
function makeCheckerTex(){
  const cv=document.createElement('canvas'); cv.width=cv.height=64; const x=cv.getContext('2d');
  for(let r=0;r<8;r++)for(let c=0;c<8;c++){ x.fillStyle=((r+c)%2)?'#16181c':'#f4f4f4'; x.fillRect(c*8,r*8,8,8); }
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
}
function makeSignTexture(text, bg){
  const cv=document.createElement('canvas'); cv.width=512; cv.height=192; const x=cv.getContext('2d');
  x.fillStyle=bg; x.fillRect(0,0,512,192);
  x.fillStyle='#ffffff'; x.fillRect(8,8,496,176); x.fillStyle=bg; x.fillRect(16,16,480,160);
  x.fillStyle='#ffffff'; x.font='italic bold 92px Georgia'; x.textAlign='center'; x.textBaseline='middle'; x.fillText(text,256,104);
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
}
function lmBox(mat,w,h,d,x,y,z){ const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat); m.position.set(x||0,y||0,z||0); return m; }
// Ground a finished landmark group at the trackside (spec {frac,side,scale,off} or {world}).
// For verge placement it sits on the BANKED surface (pos + right*lat) then adds lift —
// never setY() to just the lift, which would bury it on raised/banked ground.
function placeLandmark(group, g, frames, spec, faceY, lift){
  const f=frames[((Math.floor(DIV*(spec.frac||0)))%DIV+DIV)%DIV];
  if (spec.world){
    g.position.set(spec.world.x, (spec.world.y||0) + (lift||0)*(spec.scale||1), spec.world.z);
    g.rotation.y = (spec.faceAng||0) + (faceY||0);
  } else {
    const off=(ROAD_W+RUMBLE_W)+(spec.off!=null?spec.off:18);
    g.position.copy(f.pos).addScaledVector(f.right, spec.side*off);
    g.position.y += (lift||0)*(spec.scale||1);
    g.rotation.y=Math.atan2(f.tan.x,f.tan.z) + (faceY||0);
  }
  g.scale.setScalar(spec.scale||1); group.add(g); return f;
}

// ---- London landmarks ----
function addBigBen(group, frames, spec){
  const g=new THREE.Group();
  const stone=txMat({color:0xb59442, roughness:0.85},'stone',3);
  const dark =txMat({color:0x6b531f, roughness:0.85},'stone',2);
  const louvre=new THREE.MeshStandardMaterial({color:0x241c10, roughness:0.9});
  const copper=txMat({color:0x2f8f63, roughness:0.5, metalness:0.25},'metal',2);
  const gold  =txMat({color:0xd9b64a, roughness:0.35, metalness:0.6},'metal',2);
  const W=15;
  g.add(lmBox(stone,W+3,16,W+3,0,8,0));
  g.add(lmBox(stone,W,104,W,0,68,0));
  for (const sx of [-1,1]) for (const sz of [-1,1]) g.add(lmBox(dark,1.8,104,1.8,sx*(W/2),68,sz*(W/2)));
  for (const yy of [40,72,100]) g.add(lmBox(dark,W+0.6,2.2,W+0.6,0,yy,0));
  for (const [ax,az] of [[1,0],[-1,0],[0,1],[0,-1]]) for (const yy of [30,56,84]) g.add(lmBox(louvre, ax?0.4:5, 14, az?0.4:5, ax*(W/2+0.1), yy, az*(W/2+0.1)));
  g.add(lmBox(stone,W+2,20,W+2,0,132,0));
  const clockTex=makeClockFace();
  for (const [dx,dz,ry] of [[W/2+1.2,0,-Math.PI/2],[-(W/2+1.2),0,Math.PI/2],[0,W/2+1.2,0],[0,-(W/2+1.2),Math.PI]]){
    g.add(lmBox(stone,dx?0.8:11,11,dz?0.8:11,dx*0.5,132,dz*0.5));
    const c=new THREE.Mesh(new THREE.CircleGeometry(4.7,28), new THREE.MeshStandardMaterial({map:clockTex, emissive:0xfff1c0, emissiveIntensity:0.5}));
    c.position.set(dx,132,dz); c.rotation.y=ry; g.add(c);
  }
  g.add(lmBox(stone,W+1,16,W+1,0,150,0));
  for (const [ax,az] of [[1,0],[-1,0],[0,1],[0,-1]]) g.add(lmBox(louvre, ax?0.4:9, 12, az?0.4:9, ax*(W/2+0.6), 150, az*(W/2+0.6)));
  g.add(lmBox(dark,W+2,2.5,W+2,0,159,0));
  for (const [ax,az,ry] of [[1,0,Math.PI/2],[-1,0,Math.PI/2],[0,1,0],[0,-1,0]]){ const gab=new THREE.Mesh(new THREE.ConeGeometry(5.5,9,3), copper); gab.position.set(ax*5.5,166,az*5.5); gab.rotation.y=ry; g.add(gab); }
  for (const cx of [-1,1]) for (const cz of [-1,1]){ const pin=new THREE.Mesh(new THREE.ConeGeometry(2,18,8), copper); pin.position.set(cx*7,170,cz*7); g.add(pin); const ball=new THREE.Mesh(new THREE.SphereGeometry(1,8,8), gold); ball.position.set(cx*7,180,cz*7); g.add(ball); }
  const spire=new THREE.Mesh(new THREE.ConeGeometry(8.5,40,8), copper); spire.position.y=182; g.add(spire);
  const fin=new THREE.Mesh(new THREE.SphereGeometry(1.8,10,10), gold); fin.position.y=204; g.add(fin);
  const crs=new THREE.Mesh(new THREE.ConeGeometry(0.8,7,6), gold); crs.position.y=210; g.add(crs);
  placeLandmark(group, g, frames, spec);
}
function addLondonEye(group, frames, spec){
  const eye=new THREE.Group();
  const rim=new THREE.MeshStandardMaterial({color:0xb6c2cb, metalness:0.5, roughness:0.4});
  const R=38;
  // the rotating wheel (rim, spokes, pods) goes in its own sub-group so it can turn
  const wheel=new THREE.Group();
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(R,1.3,8,60), rim));
  wheel.add(new THREE.Mesh(new THREE.TorusGeometry(R-2,0.5,6,60), rim));
  for (let k=0;k<18;k++){ const a=k/18*Math.PI; const sp=lmBox(rim,0.35,R*2,0.35,0,0,0); sp.rotation.z=a; wheel.add(sp); }
  const pod=new THREE.MeshStandardMaterial({color:0x9fd4f5, metalness:0.3, roughness:0.25, emissive:0x16384f, emissiveIntensity:0.45});
  for (let k=0;k<28;k++){ const a=k/28*6.28; wheel.add(lmBox(pod,3,2,3,Math.cos(a)*R,Math.sin(a)*R,0)); }
  eye.add(wheel);
  const hub=new THREE.Mesh(new THREE.CylinderGeometry(3.5,3.5,5,14), rim); hub.rotation.x=Math.PI/2; eye.add(hub);
  for (const sx of [-1,1]) for (const sz of [1,-1]){ const leg=lmBox(rim,1.8,R+12,1.8,sx*9,-(R+12)/2+2,sz*7); leg.rotation.x=sz*0.32; eye.add(leg); }
  eye.add(lmBox(rim,22,1.6,16,0,-(R+10),0));
  placeLandmark(group, eye, frames, spec, Math.PI/2, R+10);
  _spinners.push({ obj:wheel, rate:0.16 });   // slow Ferris-wheel turn
}
function addTowerBridge(group, frames, spec){
  const f=frames[((Math.floor(DIV*(spec?spec.frac:0.55)))%DIV+DIV)%DIV], g=new THREE.Group();
  const stone=txMat({color:0xcdbf9f, roughness:0.8},'stone',3);
  const blue =txMat({color:0x4a86c0, roughness:0.5, metalness:0.35},'metal',2);
  const hw = ROAD_W+RUMBLE_W+5;
  for (const sx of [-1,1]){
    g.add(lmBox(stone,11,16,12,sx*hw,8,0)); g.add(lmBox(stone,9,40,10,sx*hw,36,0)); g.add(lmBox(stone,10.5,5,11.5,sx*hw,58,0));
    const roof=new THREE.Mesh(new THREE.ConeGeometry(6,16,4), blue); roof.position.set(sx*hw,68,0); roof.rotation.y=Math.PI/4; g.add(roof);
    for (const cx of [-1,1]) for (const cz of [-1,1]){ const tr=new THREE.Mesh(new THREE.ConeGeometry(2,13,8), blue); tr.position.set(sx*hw+cx*4,64,cz*4.5); g.add(tr); }
  }
  for (const yy of [44,49]) g.add(lmBox(blue,hw*2,1.6,3.4,0,yy,0));
  for (const dz of [-5.5,5.5]) for (const seg of [-1,0,1]){ const sag=(1-Math.abs(seg))*6; g.add(lmBox(blue, hw*0.95, 0.7, 0.7, seg*(hw*0.63), 38-sag, dz)); }
  g.position.copy(f.pos); g.rotation.y=Math.atan2(f.tan.x,f.tan.z); g.scale.setScalar((spec&&spec.scale)||1); group.add(g);
}
function addShard(group, frames, spec){
  const g=new THREE.Group();
  const wtex=makeWindowTexture(false); wtex.repeat.set(3,16);
  const glass=new THREE.MeshStandardMaterial({color:0x46606f, metalness:0.45, roughness:0.16, map:wtex});
  const edge =new THREE.MeshStandardMaterial({color:0x20303a, roughness:0.5, metalness:0.4});
  const h=270, S=8;
  const body=new THREE.Mesh(new THREE.CylinderGeometry(1.5,21,h,S), glass); body.position.y=h/2; body.rotation.y=Math.PI/8; g.add(body);
  for (let k=0;k<S;k++){ const a=k/S*6.28+Math.PI/8; const rr=11; const rib=lmBox(edge,0.5,h,0.5, Math.cos(a)*rr,h/2,Math.sin(a)*rr); rib.rotation.y=-a; g.add(rib); }
  for (let k=0;k<S;k++){ const a=k/S*6.28; const sp=new THREE.Mesh(new THREE.ConeGeometry(1.1,46,3), glass); sp.position.set(Math.cos(a)*3.2,h+10+(k%3)*7,Math.sin(a)*3.2); sp.rotation.z=Math.cos(a)*0.2; sp.rotation.x=Math.sin(a)*0.2; g.add(sp); }
  placeLandmark(group, g, frames, spec);
}
function addGherkin(group, frames, spec){
  const g=new THREE.Group();
  const glass=new THREE.MeshStandardMaterial({color:0x4f876a, metalness:0.35, roughness:0.22, map:makeLatticeTexture()});
  glass.map.repeat.set(8,10);
  const pts=[]; for (let i=0;i<=16;i++){ const t=i/16; const yy=t*140; const rr=Math.sin(t*Math.PI*0.96+0.1)*16+1.5; pts.push(new THREE.Vector2(Math.max(0.4,rr), yy)); }
  g.add(new THREE.Mesh(new THREE.LatheGeometry(pts,24), glass));
  const tip=new THREE.Mesh(new THREE.SphereGeometry(2.4,12,8), new THREE.MeshStandardMaterial({color:0xcfe0d6, metalness:0.4, roughness:0.1})); tip.position.y=141; g.add(tip);
  placeLandmark(group, g, frames, spec);
}
// ---- Dubai landmarks ----
function addBurj(group, frames, spec){
  const g=new THREE.Group();
  const glass=new THREE.MeshStandardMaterial({color:0xcfe2f2, metalness:0.6, roughness:0.16, map:makeWindowTexture(true)});
  glass.map.repeat.set(2,6);
  let y=0; const tiers=15;
  for (let k=0;k<tiers;k++){ const t=k/tiers, len=34*(1-t*0.86), wid=13*(1-t*0.55), hh=24, rot=k*0.22;
    for (let w=0;w<3;w++){ const a=rot + w*Math.PI*2/3; const seg=new THREE.Mesh(new THREE.BoxGeometry(wid,hh,len), glass); seg.position.set(Math.sin(a)*len/2, y+hh/2, Math.cos(a)*len/2); seg.rotation.y=a; g.add(seg); } y+=hh; }
  const core=new THREE.Mesh(new THREE.CylinderGeometry(3.5,7,34,12), glass); core.position.y=y+17; g.add(core); y+=34;
  const spire=new THREE.Mesh(new THREE.CylinderGeometry(0.5,3,150,8), new THREE.MeshStandardMaterial({color:0xeef3f8, metalness:0.7, roughness:0.2})); spire.position.y=y+75; g.add(spire);
  for (const [dx,dz,h,col] of [[-62,22,110,0xbcd6ea],[70,-30,140,0xa9c6dd]]){ const tw=new THREE.Mesh(new THREE.BoxGeometry(22,h,22), new THREE.MeshStandardMaterial({color:col, metalness:0.55, roughness:0.22, map:makeWindowTexture(true)})); tw.material.map.repeat.set(2,10); tw.position.set(dx,h/2,dz); g.add(tw); }
  placeLandmark(group, g, frames, spec);
}
function addBurjAlArab(group, frames, spec){
  const g=new THREE.Group();
  const white=txMat({color:0xeef3f7, roughness:0.45, metalness:0.15, side:THREE.DoubleSide},'glass',3);
  const steel=txMat({color:0xcdd6dd, metalness:0.6, roughness:0.4},'metal',2);
  const h=230;
  const mast=new THREE.Mesh(new THREE.CylinderGeometry(1.6,4,h,8), steel); mast.position.set(-22,h/2,0); g.add(mast);
  for (let k=0;k<8;k++){ const yy=12+k*(h-24)/8; for (const s of [1,-1]){ const br=lmBox(steel,0.8,(h/8)*1.35,0.8,-22+s*2,yy,0); br.rotation.x=s*0.6; g.add(br); } }
  const sail=new THREE.Shape(); sail.moveTo(0,0); sail.lineTo(0,h); sail.quadraticCurveTo(58,h*0.46,44,0); sail.lineTo(0,0);
  const sailGeo=new THREE.ShapeGeometry(sail);
  for (const sgn of [1,-1]){ const s=new THREE.Mesh(sailGeo,white); s.position.set(-22,0,0); s.rotation.y=sgn*0.5; g.add(s); }
  g.add(lmBox(white,2,h,3,-21,h/2,0));
  const heli=new THREE.Mesh(new THREE.CylinderGeometry(11,11,1.6,20), white); heli.position.set(-4,h-14,20); g.add(heli);
  const hpost=new THREE.Mesh(new THREE.CylinderGeometry(2,2,16,8), steel); hpost.position.set(-12,h-22,12); g.add(hpost);
  const mast2=new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.5,22,6), steel); mast2.position.set(-22,h+11,0); g.add(mast2);
  placeLandmark(group, g, frames, spec, Math.PI/2);
}
function addDubaiFrame(group, frames, spec){
  const f=frames[((Math.floor(DIV*(spec?spec.frac:0.26)))%DIV+DIV)%DIV], g=new THREE.Group();
  const gold=new THREE.MeshStandardMaterial({color:0xd4af37, metalness:0.85, roughness:0.3, map:makeWindowTexture(false)});
  gold.map.repeat.set(2,10);
  // a drive-through gate STRADDLING the road: legs sit clear of the kerb on each side
  const half = ROAD_W+RUMBLE_W+12;    // tower centre offset from the road centreline (legs well clear)
  const H=150, tw=13, td=9;
  for (const sx of [-1,1]) g.add(lmBox(gold,tw,H,td,sx*half,H/2,0));
  g.add(lmBox(new THREE.MeshStandardMaterial({color:0xc9a233, metalness:0.85, roughness:0.32}), half*2+tw,12,td+1, 0,H-6,0));
  for (const sx of [-1,1]) g.add(lmBox(gold,tw+2,8,td+2,sx*half,4,0));
  // centred on the track centreline so the player drives through the opening
  g.position.copy(f.pos); g.rotation.y=Math.atan2(f.tan.x,f.tan.z); g.scale.setScalar((spec&&spec.scale)||1); group.add(g);
}
// ---- USA landmarks ----
function addStatueOfLiberty(group, frames, spec){
  const g=new THREE.Group();
  const stone =txMat({color:0x9a8f7a, roughness:0.9},'stone',3);
  const copper=txMat({color:0x53b095, roughness:0.6, metalness:0.2},'metal',2);
  const flame =new THREE.MeshStandardMaterial({color:0xffd24a, emissive:0xffae00, emissiveIntensity:0.6, roughness:0.4});
  g.add(lmBox(stone,34,20,34,0,10,0)); g.add(lmBox(stone,24,28,24,0,34,0)); g.add(lmBox(stone,17,10,17,0,53,0));
  const body=new THREE.Mesh(new THREE.CylinderGeometry(5.5,10,42,12), copper); body.position.y=80; g.add(body);
  const head=new THREE.Mesh(new THREE.SphereGeometry(4.4,12,12), copper); head.position.y=106; g.add(head);
  for(let k=0;k<7;k++){ const a=k/7*6.28; const sp=new THREE.Mesh(new THREE.ConeGeometry(0.9,8,4),copper); sp.position.set(Math.cos(a)*5.4,112,Math.sin(a)*5.4); sp.rotation.z=-Math.cos(a)*0.6; sp.rotation.x=Math.sin(a)*0.6; g.add(sp); }
  const arm=new THREE.Mesh(new THREE.CylinderGeometry(1.7,2.2,28,8),copper); arm.position.set(9,104,0); arm.rotation.z=-0.5; g.add(arm);
  const cup=new THREE.Mesh(new THREE.CylinderGeometry(3.4,2.2,4,12),copper); cup.position.set(17,117,0); g.add(cup);
  const fl=new THREE.Mesh(new THREE.ConeGeometry(2.8,9,10),flame); fl.position.set(17,124,0); g.add(fl);
  const tablet=lmBox(stone,5.5,10,2.5,-8,78,3.5); tablet.rotation.z=0.32; g.add(tablet);
  placeLandmark(group, g, frames, spec);
}
function addGoldenGate(group, frames, spec){
  const g=new THREE.Group();
  const orange=txMat({color:0xc1502e, roughness:0.55, metalness:0.25},'metal',2);
  const deckM =txMat({color:0x8f3f22, roughness:0.7},'metal',3);
  const span=130, towerH=95, deckY=30, cableTop=84;
  g.add(lmBox(deckM, span+60, 3.5, 11, 0, deckY, 0));
  for (const sx of [-1,1]){ g.add(lmBox(orange, 7.5, towerH, 7.5, sx*span/2, towerH/2, 0)); for (const yy of [54,76,90]) g.add(lmBox(orange, 9, 4, 10, sx*span/2, yy, 0)); g.add(lmBox(orange, 11, 8, 12, sx*span/2, 4, 0)); }
  for (const sz of [-4,4]){ let prev=null; for (let i=0;i<=12;i++){ const t=i/12, x=(t-0.5)*span, y=deckY + (cableTop-deckY)*Math.pow(2*t-1,2); if (prev){ const mx=(x+prev.x)/2,my=(y+prev.y)/2, dx=x-prev.x, dy=y-prev.y, len=Math.hypot(dx,dy); const c=lmBox(orange,len,0.7,0.7,mx,my,sz); c.rotation.z=Math.atan2(dy,dx); g.add(c); } prev={x,y}; } }
  placeLandmark(group, g, frames, spec);
}

// ---- build the whole scenery group (grounded, mobile-budgeted) ----
function buildScenery(){
  if (sceneryGroup){ scene.remove(sceneryGroup); disposeTree(sceneryGroup); }
  sceneryGroup = new THREE.Group();
  _spinners = []; _flags = []; _sway = []; _pulse = []; _scroll = []; _crowd = []; _wave = [];
  _scnInfo='';
  const th = G.theme;
  const rng = mulberry32((G.circuit.seed||1) * 40503);

  // prop factories
  const pineTrunk=new THREE.MeshLambertMaterial({color:0x6b4a2b, map:makeDetailTex('metal')});
  const pineLeaf =new THREE.MeshLambertMaterial({color:0x36a84e, map:makeDetailTex('rough')});
  function pine(s){ const g=new THREE.Group(); const tk=new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.4,2,6),pineTrunk); tk.position.y=1; g.add(tk); for(let k=0;k<3;k++){ const c=new THREE.Mesh(new THREE.ConeGeometry(2.2-k*0.5,2.6,7),pineLeaf); c.position.y=2.2+k*1.5; g.add(c);} g.scale.setScalar(s); return g; }
  const rockMat=new THREE.MeshLambertMaterial({color:0xb5793f, flatShading:true, map:makeDetailTex('rough')});
  const rockMat2=new THREE.MeshLambertMaterial({color:0x9c6534, flatShading:true, map:makeDetailTex('stone')});
  function rock(s){ const g=new THREE.Group(); const h=3+rng()*4; const m=new THREE.Mesh(new THREE.ConeGeometry(2.2+rng()*1.5,h,5), rng()<0.5?rockMat:rockMat2); m.position.y=h/2; m.rotation.y=rng()*6.28; g.add(m); const m2=new THREE.Mesh(new THREE.DodecahedronGeometry(1.4+rng()),rockMat2); m2.position.set(1.5,0.8,0.5); g.add(m2); g.scale.setScalar(s); return g; }
  const palmTrunk=new THREE.MeshLambertMaterial({color:0x8a6a3a, map:makeDetailTex('metal')});
  const palmLeaf =new THREE.MeshLambertMaterial({color:0x2f9c4a, side:THREE.DoubleSide, map:makeDetailTex('rough')});
  const NFROND = MOBILE ? 5 : 7;
  function palm(s){ const g=new THREE.Group(); const t=new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.34,5,7),palmTrunk); t.position.y=2.5; t.rotation.z=0.12; g.add(t); for(let k=0;k<NFROND;k++){ const fr=new THREE.Mesh(new THREE.ConeGeometry(0.5,3.4,4),palmLeaf); const piv=new THREE.Group(); piv.add(fr); piv.rotation.y=k/NFROND*6.28; fr.position.set(1.6,5,0); fr.rotation.set(0,0,-0.5); g.add(piv);} g.scale.setScalar(s); return g; }
  const treeTrunk=new THREE.MeshLambertMaterial({color:0x7a5532, map:makeDetailTex('metal')});
  const treeLeaf =new THREE.MeshLambertMaterial({color:0x46c45f, flatShading:true, map:makeDetailTex('rough')});
  function tree(s){ const g=new THREE.Group(); const tk=new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.45,2.4,6),treeTrunk); tk.position.y=1.2; g.add(tk); const c=new THREE.Mesh(new THREE.IcosahedronGeometry(2.4,0),treeLeaf); c.position.y=4; c.scale.y=1.1; g.add(c); g.scale.setScalar(s); return g; }
  const makeProp = th.prop==='rock'?rock : th.prop==='palm'?palm : th.prop==='tree'?tree : pine;

  // hero landmark slots (placed FIRST so verge props can leave a gap in front)
  const L4=[addBigBen, addLondonEye, addGherkin, addShard];
  const REP = MOBILE ? 3 : 4, N12 = MOBILE ? 6 : 10;
  const heroFns = th.landmark==='london' ? Array.from({length:REP}).flatMap(()=>L4)
    : th.landmark==='dubai' ? Array.from({length:N12},(_,i)=>[addBurj,addBurjAlArab][i%2])
    : th.landmark==='usa'   ? Array.from({length:N12},(_,i)=>[addStatueOfLiberty,addGoldenGate][i%2]) : [];
  const cen=new THREE.Vector3(); for(const fr of frames) cen.add(fr.pos); cen.multiplyScalar(1/frames.length);
  const heroSlots = heroFns.map((fn,i)=>{ const fi=Math.floor(((i+0.5)/heroFns.length)*DIV)%DIV, f=frames[fi];
    const outward=(f.pos.x-cen.x)*f.right.x + (f.pos.z-cen.z)*f.right.z; return { fn, fi, side: outward>=0?1:-1 }; });

  // gate (Tower Bridge / Dubai Frame) on the straightest start stretch
  let gateFi=-1;
  if (th.landmark==='london' || th.landmark==='dubai'){ let bs=Infinity;
    for (let i=Math.floor(DIV*0.04);i<=Math.floor(DIV*0.20);i++){ let s=0; for(let k=-45;k<=45;k++) s+=Math.abs(frames[(i+k+DIV)%DIV].curv); if(s<bs){bs=s;gateFi=i;} } }
  const gateNear=i=>{ if(gateFi<0)return false; let d=Math.abs(i-gateFi); d=Math.min(d,DIV-d); return d<30; };
  const heroNear=(i,side)=> gateNear(i) || heroSlots.some(h=>{ if(h.side!==side)return false; let d=Math.abs(i-h.fi); d=Math.min(d,DIV-d); return d<26; });

  // verge props (mobile-budgeted, both verges)
  const PROP_STEP = MOBILE ? 22 : 6;
  const sways = th.prop!=='rock';   // trees/palms sway; rocks don't
  for (let i=0;i<DIV;i+=PROP_STEP){ const f=frames[i];
    for (const side of [-1,1]){ if (heroNear(i,side)) continue;
      const p=makeProp(3.4+rng()*2.4); p.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+2+rng()*6)); sceneryGroup.add(p);
      if (sways) _sway.push({obj:p, ph:rng()*6.28, amp:0.08+rng()*0.06});
      if (!MOBILE && rng()<0.7){ const p2=makeProp(2.2+rng()*2.0); p2.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+16+rng()*16)); sceneryGroup.add(p2); if (sways) _sway.push({obj:p2, ph:rng()*6.28, amp:0.08+rng()*0.06}); }
    }
  }

  // distant skyline ring (city) or mountains
  if (th.skyline==='city'){
    const winTex=makeWindowTexture(th.landmark==='dubai'); const RING=MOBILE?22:46;
    for (let i=0;i<RING;i++){ const ang=(i/RING)*Math.PI*2; const r=560+(mulberry32(i+99)())*260; const h=70+(mulberry32(i+5)())*(th.landmark==='dubai'?260:140); const w=24+(mulberry32(i+13)())*26;
      const col=th.landmark==='dubai'?0x9fb6cc:[0x8a6a52,0x9c7a52,0x70615a,0x86756b][i%4];
      const mat=new THREE.MeshStandardMaterial({color:col, roughness:0.7, metalness:th.landmark==='dubai'?0.4:0.05, map:winTex.clone(), emissive:0xffe39a, emissiveMap:winTex.clone(), emissiveIntensity:0.4}); mat.map.repeat.set(Math.max(1,w/12),Math.max(2,h/12)); mat.emissiveMap.repeat.copy(mat.map.repeat);
      _pulse.push({mat, base:0.42, ph:i*1.3, sp:3.2, flash:true}); _scroll.push({tex:mat.emissiveMap, v:0.02});   // flashy windows + shimmer
      const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,w),mat); b.position.set(Math.cos(ang)*r,h/2-40,Math.sin(ang)*r); sceneryGroup.add(b); }
  } else {
    const mtnMat=new THREE.MeshLambertMaterial({color:th.mountain, flatShading:true, map:makeDetailTex('rough')});
    const snowMat=new THREE.MeshLambertMaterial({color:0xeef3f7, flatShading:true});
    for (let i=0;i<26;i++){ const ang=(i/26)*Math.PI*2; const r=720+(mulberry32(i+99)())*240; const h=130+(mulberry32(i+5)())*200;
      const m=new THREE.Mesh(new THREE.ConeGeometry(h*0.9,h,5),mtnMat); m.position.set(Math.cos(ang)*r,h/2-40,Math.sin(ang)*r); sceneryGroup.add(m);
      if (th.snow){ const cap=new THREE.Mesh(new THREE.ConeGeometry(h*0.32,h*0.34,5),snowMat); cap.position.set(Math.cos(ang)*r,h-40-h*0.17,Math.sin(ang)*r); sceneryGroup.add(cap); } }
  }
  // a bold continuous city skyline on the horizon, ringing the whole circuit
  try{ buildSkylineBackdrop(cen, th); }catch(e){ _scnInfo='SKYLINE-ERR:'+(e&&e.message||e); }

  // hero landmarks — grounded on the banked verge surface, and offset by each
  // landmark's BASE FOOTPRINT so its near edge always clears the kerb by a fixed
  // margin (otherwise a wide base — e.g. the Shard — sits across the racing line).
  const FOOT = new Map([[addBigBen,9],[addLondonEye,11],[addGherkin,17],[addShard,22],
                        [addBurj,19],[addBurjAlArab,26],[addStatueOfLiberty,18],[addGoldenGate,30]]);
  const HSCALE = 1.9;
  heroSlots.forEach(({fn,fi,side})=>{ const f=frames[fi];
    const off=(ROAD_W+RUMBLE_W) + (FOOT.get(fn)||14)*HSCALE + 6;
    const x=f.pos.x+f.right.x*side*off, y=f.pos.y+f.right.y*side*off, z=f.pos.z+f.right.z*side*off;
    try{ fn(sceneryGroup, frames, { world:{x,y,z}, scale:HSCALE, faceAng:Math.atan2(f.tan.x,f.tan.z) }); }catch(e){ _scnInfo='HERO-ERR:'+(e&&e.message||e); }
  });

  // the drive-through gate (spans the road on sA)
  const straightness=i=>{ let s=0; for(let k=-45;k<=45;k++) s+=Math.abs(frames[(i+k+DIV)%DIV].curv); return s; };
  const straightestIn=(lo,hi)=>{ let best=lo,bs=Infinity; for(let i=lo;i<=hi;i++){ const s=straightness(i); if(s<bs){bs=s;best=i;} } return best; };
  const sA=straightestIn(Math.floor(DIV*0.04),Math.floor(DIV*0.20));
  if (th.landmark==='london') try{ addTowerBridge(sceneryGroup, frames, {frac:sA/DIV, scale:1.5}); }catch(e){ _scnInfo='GATE-ERR:'+(e&&e.message||e); }
  if (th.landmark==='dubai')  try{ addDubaiFrame(sceneryGroup, frames, {frac:sA/DIV, scale:1.0}); }catch(e){ _scnInfo='GATE-ERR:'+(e&&e.message||e); }

  // mid-distance buildings (urban) — outside of the loop, clear of landmarks
  if (th.buildings){
    const keepout = heroSlots.map(h=>h.fi).concat(gateFi>=0?[gateFi]:[]);
    const nearLM = i=>keepout.some(k=>{ let d=Math.abs(i-k); d=Math.min(d,DIV-d); return d<70; });
    const winTex=makeWindowTexture(th.landmark==='dubai'); const _v=new THREE.Vector3();
    for (let i=0;i<DIV;i+=(MOBILE?88:44)){ if(nearLM(i)) continue; const f=frames[i]; _v.copy(f.pos).sub(cen); const side=(_v.dot(f.right)>=0)?1:-1;
      const h=20+rng()*(th.landmark==='dubai'?70:34), w=12+rng()*12; const col=th.landmark==='dubai'?0xbcd0e2:[0x8a6248,0x96704e,0x6f5e54][(rng()*3)|0];
      const mat=new THREE.MeshStandardMaterial({color:col, roughness:0.7, metalness:th.landmark==='dubai'?0.45:0.05, map:winTex.clone(), emissive:0xffe39a, emissiveMap:winTex.clone(), emissiveIntensity:0.38}); mat.map.repeat.set(Math.max(1,w/8),Math.max(2,h/10)); mat.emissiveMap.repeat.copy(mat.map.repeat);
      _pulse.push({mat, base:0.4, ph:i*0.7, sp:2.6, flash:true}); _scroll.push({tex:mat.emissiveMap, v:0.016});
      const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,w),mat); b.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+90+rng()*70)); b.position.y+=h/2-2; sceneryGroup.add(b); }
  }

  // start/finish gantry
  const f0=frames[2], gantry=new THREE.Group();
  const postMat=new THREE.MeshLambertMaterial({color:0xb9c0c7, map:makeDetailTex('metal')}), postGeo=new THREE.CylinderGeometry(0.5,0.5,16,8);
  const lp=new THREE.Mesh(postGeo,postMat); lp.position.set(-ROAD_W-2,8,0); gantry.add(lp);
  const rp=new THREE.Mesh(postGeo,postMat); rp.position.set(ROAD_W+2,8,0); gantry.add(rp);
  const beam=new THREE.Mesh(new THREE.BoxGeometry((ROAD_W+2)*2,3,1.5), new THREE.MeshLambertMaterial({color:0xc1272d, map:makeDetailTex('metal')})); beam.position.set(0,15.5,0); gantry.add(beam);
  const board=new THREE.Mesh(new THREE.BoxGeometry(8,3,0.5), new THREE.MeshBasicMaterial({map:makeSignTexture('DAYTONA','#c1272d')})); board.position.set(0,12,0.9); gantry.add(board);
  // a waving checkered flag on the right post (segmented so it ripples)
  {
    const flagTex=makeCheckerTex();
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.16,0.16,6,6), new THREE.MeshLambertMaterial({color:0xe6e6e6})); pole.position.set(ROAD_W+2, 18, 0); gantry.add(pole);
    const NS=7, segW=0.85, segs=[];
    for (let i=0;i<NS;i++){
      const m=flagTex.clone(); m.repeat.set(1/NS,1); m.offset.set(i/NS,0);
      const s=new THREE.Mesh(new THREE.PlaneGeometry(segW,2.4), new THREE.MeshBasicMaterial({map:m, side:THREE.DoubleSide}));
      const px=ROAD_W+2+0.4+i*segW; s.position.set(px, 19.8, 0); gantry.add(s);
      segs.push({mesh:s, t:(i+1)/NS});
    }
    _flags.push({segs});
  }
  gantry.position.copy(f0.pos); gantry.lookAt(f0.pos.clone().add(f0.tan)); sceneryGroup.add(gantry);

  // ---- BIG multi-row grandstands distributed around the lap (outer side, close in) ----
  const crowdTex=makeCrowdTexture();
  const NSEG=MOBILE?10:15, NROW=MOBILE?2:3;
  const standFracs = MOBILE ? [0.008,0.028, 0.25, 0.50, 0.75]
                            : [0.006,0.022,0.038, 0.25, 0.49,0.51,0.53, 0.75];
  const standCen=new THREE.Vector3(); for(const fr of frames) standCen.add(fr.pos); standCen.multiplyScalar(1/frames.length);
  const standPostMat=new THREE.MeshLambertMaterial({color:0xb9c0c7, map:makeDetailTex('metal')});
  let waveIdx=0;
  for (const fr of standFracs){
    const idx=Math.floor(fr*DIV)%DIV, f=frames[idx];
    const side=(new THREE.Vector3().copy(f.pos).sub(standCen).dot(f.right)>=0)?1:-1;   // outward side
    const stand=new THREE.Group();
    const W=MOBILE?78:96, H=24;   // longer grandstands
    const baseMat=new THREE.MeshLambertMaterial({color:0x9aa3b2, map:makeDetailTex('stone').clone()}); baseMat.map.repeat.set(10,5); baseMat.map.wrapS=baseMat.map.wrapT=THREE.RepeatWrapping; baseMat.bumpMap=baseMat.map; baseMat.bumpScale=0.9;
    const baseM=new THREE.Mesh(new THREE.BoxGeometry(W,H,12), baseMat); baseM.position.y=H/2; stand.add(baseM);
    const segW=(W-2)/NSEG, tierH=H*0.24;
    const colBase=waveIdx;                          // columns of THIS stand
    for (let row=0;row<NROW;row++){
      const ry=H*(0.30+row*0.24);
      for (let k=0;k<NSEG;k++){
        const seg=new THREE.Mesh(new THREE.PlaneGeometry(segW-0.1, tierH), new THREE.MeshBasicMaterial({map:crowdTex}));
        seg.position.set(-(W-2)/2+segW*(k+0.5), ry, 6.2 - row*0.8); seg.rotation.x=-0.34; stand.add(seg);
        _wave.push({mesh:seg, baseY:ry, k:colBase+k});   // a whole column rises together
      }
    }
    waveIdx = colBase + NSEG;                       // next stand continues the wave
    const roof=new THREE.Mesh(new THREE.BoxGeometry(W+2,1,13), new THREE.MeshLambertMaterial({color:0xd6262b, map:makeDetailTex('metal')})); roof.position.y=H+0.9; stand.add(roof);
    for (const sx of [-1,1]){ const post=new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.5,H,6), standPostMat); post.position.set(sx*(W/2-1), H/2, 6.5); stand.add(post); }
    stand.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+8));   // close to the track
    stand.lookAt(f.pos.clone().addScaledVector(f.right, side).setY(stand.position.y));
    sceneryGroup.add(stand);
  }

  // collect every other emissive landmark material so its light can pulse gently
  // (buildings were already tagged above with a flashier pulse — skip them)
  { const seen=new Set(_pulse.map(p=>p.mat));
    sceneryGroup.traverse(o=>{ if(!o.isMesh) return; const ms=Array.isArray(o.material)?o.material:[o.material];
      for (const m of ms){ if (m && m.emissive && m.emissiveIntensity>0.01 && !seen.has(m)){ seen.add(m); _pulse.push({mat:m, base:m.emissiveIntensity, ph:seen.size*0.9, sp:1.8}); } } }); }
  sceneryGroup.traverse(o=>{ if(!o.isMesh || o.userData.noShadow) return; const m=o.material; const tr=Array.isArray(m)?m.some(x=>x&&x.transparent):(m&&m.transparent); if(!tr) o.castShadow=true; });
  scene.add(sceneryGroup);
  _scnInfo = 'scn:' + sceneryGroup.children.length + (sceneryGroup.parent?'✓':'✗') + (_scnInfo?(' '+_scnInfo):'');
}

// ----------------------------------------------------------------------------
//  AI rivals (follow the track in soft lanes — no sticky collisions)
// ----------------------------------------------------------------------------
function buildRivals(n){
  for (const r of rivals){ scene.remove(r.mesh); }
  rivals = [];
  const aiTop = G.circuit.maxSpeed * G.circuit.aiSpeed * 0.64;   // competitive straight-line pace
  for (let i=0;i<n;i++){
    const liv = RIVAL_LIVERIES[i % RIVAL_LIVERIES.length];
    const mesh = buildCar({ livery: liv }, true);   // lite detail for rivals
    scene.add(mesh);
    const lane = ((i%4)-1.5) * 3.4;                 // spread across the wider road
    rivals.push({
      mesh, lane, offset: lane, name: liv.sponsor || ('CAR '+(liv.num||i)),
      dist: (i+1)*7,                                // staggered ahead of the player on the grid
      lap: 0,
      baseSpeed: aiTop * (0.95 + 0.08*((i*0.37)%1)),
      speed: 0,
    });
  }
}
const LIVERIES = [0xe23b3b,0x2f6cff,0x22c55e,0xf59e0b,0xa855f7,0x06b6d4,0xec4899,0xfacc15,0xfb7185,0x4ade80];
function updateRivals(dt){
  const playerProg = (G.lap-1)*trackLen + G.dist;
  for (const r of rivals){
    const fi = ((Math.floor((r.dist/trackLen)*DIV))%DIV+DIV)%DIV;
    // --- corner-aware speed: ease off for the sharpest curvature just ahead ---
    let curveAhead=0;
    for (let k=8;k<=70;k+=12) curveAhead=Math.max(curveAhead, Math.abs(frames[(fi+k)%DIV].curv));
    const cornerFactor = 1 - Math.min(0.42, curveAhead*16);
    let target = r.baseSpeed * cornerFactor;
    // --- rubber-band so the field stays a real race around the player ---
    const gap = (r.lap*trackLen + r.dist) - playerProg;   // +ve = ahead of player
    if (gap > 150) target *= 0.92;                        // leaders don't run away from the player
    else if (gap < 0) target *= 1 + Math.min(0.34, -gap/430);  // the further back, the harder they chase
    r.speed += (target - r.speed) * 1.6 * dt;
    // --- racing line: hug the inside of the upcoming corner ---
    const curv = frames[fi].curv;
    let targetOff = -Math.sign(curv) * Math.min(1, Math.abs(curv)*55) * 4.5 + r.lane*0.35;
    // --- overtaking: if a car sits just ahead in my lane, pull to the clearer side ---
    for (const o of rivals){
      if (o===r) continue;
      let dd=o.dist-r.dist; if(dd>trackLen*0.5)dd-=trackLen; if(dd<-trackLen*0.5)dd+=trackLen;
      if (dd>1.5 && dd<13 && Math.abs(o.offset-r.offset)<2.6) targetOff += (r.offset>=o.offset?1:-1)*3.2;
    }
    targetOff = Math.max(-ROAD_W+1.2, Math.min(ROAD_W-1.2, targetOff));
    r.offset += (targetOff - r.offset) * 2.4 * dt;
    r.dist += r.speed * dt;
    if (r.dist >= trackLen){ r.dist -= trackLen; r.lap++; }
  }
  // rivals can't drive through each other
  for (let i=0;i<rivals.length;i++) for (let j=i+1;j<rivals.length;j++) collideCars(rivals[i], rivals[j]);
}

// ---- car-to-car collision: cars are (dist, offset); when two overlap, shove them
//      apart laterally and trade a little speed (a Daytona-style bump). a/b each
//      need {dist, offset, speed}. ----
const CAR_LEN=4.7*CAR_SCALE, CAR_WID=2.3*CAR_SCALE;   // collision size tracks the visual size
function collideCars(a, b){
  let dd = a.dist - b.dist;
  if (dd >  trackLen*0.5) dd -= trackLen;
  if (dd < -trackLen*0.5) dd += trackLen;
  if (Math.abs(dd) >= CAR_LEN) return false;
  const doff = a.offset - b.offset;
  if (Math.abs(doff) >= CAR_WID) return false;
  // push apart laterally (smoothly resolves over a few frames)
  const overlap = CAR_WID - Math.abs(doff);
  const dir = Math.abs(doff) < 0.05 ? (dd>=0 ? 1 : -1) : Math.sign(doff);
  a.offset += dir * overlap * 0.45;
  b.offset -= dir * overlap * 0.45;
  // longitudinal bump: trailing car slows hard, leading car gets nudged forward
  const trailing = dd < 0 ? a : b, leading = dd < 0 ? b : a;
  if (trailing.speed > leading.speed){
    const c = (trailing.speed - leading.speed) * 0.7;
    trailing.speed -= c; leading.speed += c * 0.4;
  }
  return true;
}
function placeRivals(){ for (const r of rivals) placeCar(r.mesh, r.dist, r.offset); }
function computePosition(){
  const playerProg = (G.lap-1)*trackLen + G.dist;
  let pos = 1;
  for (const r of rivals){ if ((r.lap*trackLen + r.dist) > playerProg) pos++; }
  return pos;
}

// ----------------------------------------------------------------------------
//  Race state machine
// ----------------------------------------------------------------------------
function update(dt){
  if (G.state==='menu' || G.state==='finished') return;
  if (G.state==='attract'){ attractUpdate(dt); return; }
  if (G.state==='replay'){ replayUpdate(dt); return; }
  if (G.state==='rolling'){ rollingUpdate(dt); return; }
  if (G.state==='paused') return;
  racingUpdate(dt);
}

function rollingUpdate(dt){
  // gentle forward creep in formation; player auto-centred; controls inactive
  G.speed += (G.maxSpeed*0.20 - G.speed) * 0.6 * dt;
  G.offset += (0 - G.offset) * 2 * dt;
  G.dist += G.speed * dt; if (G.dist>=trackLen) G.dist-=trackLen;
  for (const r of rivals){ r.dist += G.speed*dt; if(r.dist>=trackLen){r.dist-=trackLen;r.lap++;} r.offset += (r.lane-r.offset)*2*dt; }
  G.rollT += dt;
  // 0.0–2.2s: "gentlemen, start your engines"; 2.2–4.3s: 3-2-1; then GREEN
  if (G.rollT >= 2.2){
    const ct = G.rollT - 2.2;
    const n = 3 - Math.floor(ct/0.7);
    if (ct < 2.1){ if (n!==G.cdNum){ G.cdNum=n; showCountdown(String(n)); } }
    else if (!G.green){ G.green=true; showCountdown('GREEN!'); hideBanner(); beginRacing(); }
  }
}
function beginRacing(){
  G.state='racing';
  setTimeout(hideCountdown, 650);
  arcadeCallout('GO!', '#2bd451', [_NOTE.C5,_NOTE.E5,_NOTE.G5,_NOTE.C6]);
  if (window.GameMusic && window.GameMusic.setMode){ try{ window.GameMusic.setMode('race'); }catch(e){} }
}

function racingUpdate(dt){
  const v=G.vehicle, maxSpeed=G.maxSpeed;
  const onGrass = Math.abs(G.offset) > ROAD_W + RUMBLE_W;

  // longitudinal
  if (keys.gas)        G.speed += 84 * v.accelMul * dt;
  else                 G.speed -= 22 * dt;                 // coast
  if (keys.brake)      G.speed -= 95 * v.brakeMul * dt;
  G.speed -= G.speed * 0.012;                              // drag
  if (onGrass)         G.speed -= G.speed * 0.05;          // grass scrub
  // ---- nitro boost: a held surge that drains the meter, refilling when idle ----
  G.boostActive = false;
  if (keys.boost && G.boost>0.02 && G.speed > maxSpeed*0.08){
    G.boostActive = true; G.speed += 150*dt; G.boost = Math.max(0, G.boost - dt*0.5);
  } else {
    G.boost = Math.min(1, G.boost + dt*(keys.gas?0.10:0.16));
  }
  const topNow = G.boostActive ? maxSpeed*1.28 : (onGrass ? maxSpeed*0.5 : maxSpeed);
  if (G.speed > topNow) G.speed += (topNow - G.speed)*0.1;
  G.speed = Math.max(-maxSpeed*0.28, Math.min(maxSpeed*1.3, G.speed));

  // steering -> lateral offset (only meaningful when moving)
  const steer = (keys.right?1:0) - (keys.left?1:0);
  G.steerVis += (steer - G.steerVis) * 0.2;
  const speedFrac = Math.min(1, Math.abs(G.speed)/maxSpeed);
  const grip = v.gripMul * (onGrass?0.7:1) * (G.rain?0.82:1);
  G.offset += steer * 16 * v.steerMul * grip * dt * (0.35 + 0.65*speedFrac) * Math.sign(G.speed||1);
  // gentle centrifugal drift on curves
  const f = frameAt(G.dist);
  G.offset += f.curv * speedFrac * 11 * dt;
  // ---- drift scoring: hold a fast line through corners to build a combo ----
  const driftNow = speedFrac>0.62 && !onGrass && (steer!==0 || Math.abs(f.curv)>0.02);
  if (driftNow){ _driftActive+=dt; _driftCombo=Math.min(6, 1+((_driftActive*0.85)|0)); _sessionScore += speedFrac*55*_driftCombo*dt; }
  else { _driftActive=0; _driftCombo=1; }
  // arcade tyre smoke when sliding / cornering hard / on the grass
  if (_smokeGroup) driftSmoke(f, speedFrac, steer, onGrass);
  if (G.boostActive && _smokeGroup) emitBoostFlame(f);
  // the grass always nudges you back toward the road, so the car can never get
  // stranded/pinned far out in the verge (arcade forgiveness).
  if (Math.abs(G.offset) > ROAD_W){
    G.offset -= Math.sign(G.offset) * Math.min(Math.abs(G.offset)-ROAD_W, 7) * dt;
  }
  // hard world limit (a little into the grass) — can never be reached in practice
  const lim = ROAD_W + GRASS_W*0.45;
  if (G.offset >  lim) G.offset =  lim;
  if (G.offset < -lim) G.offset = -lim;

  // advance along the spline
  G.dist += G.speed * dt;
  if (G.dist >= trackLen){ G.dist -= trackLen; onLapComplete(); }
  if (G.dist < 0) G.dist += trackLen;

  // rivals + collisions (player can't drive through other cars; hitting one costs speed)
  updateRivals(dt);
  let hit=false;
  for (const r of rivals){ if (collideCars(G, r)) hit=true; }
  if (hit){ G.speed *= 0.9; G.shake = Math.min(0.7, (G.shake||0) + 0.35); haptic(40);
            emitSmoke(playerCar.position.x, playerCar.position.y+0.6, playerCar.position.z, 0xffe08a); }
  // arcade overtake callout when the player gains a place (with a cooldown)
  const pos = computePosition();
  if (pos < _lastPos && _animClock - _lastOvertakeT > 1.4){
    arcadeCallout(pos===1?'TAKE THE LEAD!':'OVERTAKE!', pos===1?'#ffd400':'#3fd4ff', [_NOTE.G5,_NOTE.C6]);
    _lastOvertakeT = _animClock;
  }
  _lastPos = pos;
  if (G.offset >  lim) G.offset =  lim;
  if (G.offset < -lim) G.offset = -lim;
  G.shake = (G.shake||0) * (1 - 6*dt);   // decay the impact jolt

  G.totalTime += dt;
  G.timeLeft  -= dt;
  if (G.timeLeft <= 0){ G.timeLeft = 0; finishRace(false); return; }

  if (window.GameMusic && window.GameMusic.setIntensity) window.GameMusic.setIntensity(speedFrac);
  // record the race for instant replay + the current lap's ghost trace (~20 Hz)
  _recT += dt;
  if (_recT >= 0.05){ _recT = 0; recordReplay();
    if (_lapTrace.length<3000) _lapTrace.push([ +(G.totalTime-G.lapStart).toFixed(2), +G.dist.toFixed(1), +G.offset.toFixed(2) ]);
  }
  updateRaceHUDText();
}

// ---- instant replay: record the whole race, then play it back ----
let _replay=[], _recT=0, _repT=0;
function recordReplay(){
  _replay.push({ d:G.dist, o:G.offset, sv:G.steerVis, sp:G.speed, lap:G.lap,
                 br:keys.brake?1:0, r:rivals.map(r=>[r.dist,r.offset]) });
  if (_replay.length > 8000) _replay.shift();
}
function lerpDist(a,b,f){ let d=b-a; if(d>trackLen/2)d-=trackLen; else if(d<-trackLen/2)d+=trackLen; let r=a+d*f; if(r<0)r+=trackLen; if(r>=trackLen)r-=trackLen; return r; }
function replayUpdate(dt){
  if (!_replay.length){ exitReplay(); return; }
  _repT += dt;
  let fi=_repT/0.05, i0=Math.floor(fi);
  if (i0 >= _replay.length-1){ _repT=0; i0=0; fi=0; }   // loop the replay
  const a=_replay[i0], b=_replay[Math.min(i0+1,_replay.length-1)], f=fi-i0;
  G.dist=lerpDist(a.d,b.d,f); G.offset=a.o+(b.o-a.o)*f; G.steerVis=a.sv+(b.sv-a.sv)*f;
  G.speed=a.sp; G.lap=a.lap; keys.brake=!!a.br; G.boostActive=false;
  for (let k=0;k<rivals.length && k<a.r.length;k++){
    rivals[k].dist=lerpDist(a.r[k][0],b.r[k][0],f); rivals[k].offset=a.r[k][1]+(b.r[k][1]-a.r[k][1])*f;
  }
}
function startReplay(){
  if (!_replay.length) return;
  G.state='replay'; _repT=0; keys.gas=keys.brake=keys.left=keys.right=keys.boost=false;
  G.view='cinematic'; cineReset();                      // start in TV-style auto camera
  hideOverlay(); updateViewBtn();
  const pb=document.getElementById('pauseBtn'); if(pb) pb.textContent='✕ EXIT REPLAY';
  const t=document.getElementById('touch'); if(t) t.style.display='none';
  const vb=document.getElementById('viewBtn'); if(vb) vb.classList.remove('hidden');
  showBanner('▶ REPLAY', 0);
}
function exitReplay(){
  G.state='finished'; hideBanner(); G.view='chase';
  const pb=document.getElementById('pauseBtn'); if(pb) pb.textContent='❚❚ PAUSE';
  showEndScreen(G.lastWin);
}

function onLapComplete(){
  // lap timing + persistent best-lap record
  const lapTime = G.totalTime - G.lapStart; G.lapStart = G.totalTime;
  if (lapTime > 1){
    if (G.bestLap > 0 && lapTime < G.bestLap){
      G.bestLap = lapTime; saveBestLap(lapTime); G.recordSet = true;
      _ghost = _lapTrace.slice(); saveGhost(_ghost);                     // beat your ghost -> it becomes the new ghost
      arcadeCallout('NEW LAP RECORD!', '#ffd400', [_NOTE.C6,_NOTE.E5,_NOTE.G5,_NOTE.C6]);
    } else if (G.bestLap === 0){ G.bestLap = lapTime; saveBestLap(lapTime); _ghost=_lapTrace.slice(); saveGhost(_ghost); }   // first lap on this track
  }
  _lapTrace = [];                                                        // start tracing the next lap fresh
  if (G.lap >= G.circuit.laps){ finishRace(true); return; }   // crossed the line on the final lap
  G.lap++;
  G.timeLeft += G.circuit.lapBonus;                            // checkpoint time-extension
  showBanner('CHECKPOINT  +'+G.circuit.lapBonus, 1300);
  arcadeStinger([_NOTE.C5,_NOTE.G5,_NOTE.C6],'square');        // checkpoint chime
  if (G.lap === G.circuit.laps){
    arcadeCallout('FINAL LAP!', '#ff4d4d', [_NOTE.C6,_NOTE.A5,_NOTE.C6]);
    if (window.GameMusic && window.GameMusic.setFinalLap){ try{ window.GameMusic.setFinalLap(true); }catch(e){} }
  }
}

function finishRace(win){
  G.state='finished'; G.lastWin=win;
  haptic([60,40,120]);
  // career: bank credits from finish position + drift score
  const posBonus=[0,300,220,160,130,110,90,70,50,40,30][computePosition()]||20;
  G.earned = Math.round(_sessionScore/40) + posBonus;
  _profile.races++; if (win) _profile.wins++; _profile.credits += G.earned; saveProfile();
  if (win) arcadeCallout('FINISH!', '#ffd400', [_NOTE.C5,_NOTE.E5,_NOTE.G5,_NOTE.C6,_NOTE.G5,_NOTE.C6]);
  showBanner(win?'FINISH!':"TIME UP", 0);
  if (G.champ) try{ champScore(); }catch(e){}  // tally championship points for this round
  showEndScreen(win);
  stopRaceMusic();
  if (window.GameMusic){ try{ window.GameMusic.start && window.GameMusic.start(); window.GameMusic.setMode && window.GameMusic.setMode('menu'); }catch(e){} }
}

// ---- HUD text + banner/countdown helpers ----
function fmtTime(s){ const m=Math.floor(s/60), sec=s-m*60; return m+"'"+String(Math.floor(sec)).padStart(2,'0')+'"'+String(Math.floor((sec%1)*100)).padStart(2,'0'); }
function updateRaceHUDText(){
  setText('lapNum', String(Math.min(G.lap, G.circuit.laps)));
  setText('lapTotal', String(G.circuit.laps));
  setText('timerVal', String(Math.ceil(G.timeLeft)));
  setText('posNum', String(computePosition()));
  setText('posTotal', String(1+rivals.length));
  setText('lapTimeVal', fmtTime(G.totalTime));
}
function showBanner(text, ms, intro){
  const b=document.getElementById('banner'); if(!b) return;
  b.innerHTML=text; b.className = intro?'intro':''; b.classList.remove('hidden');
  if (ms>0) setTimeout(()=>b.classList.add('hidden'), ms);
}
function hideBanner(){ const b=document.getElementById('banner'); if(b) b.classList.add('hidden'); }
function showCountdown(t){ const c=document.getElementById('countdown'); if(!c) return; c.textContent=t; c.classList.remove('hidden'); }
function hideCountdown(){ const c=document.getElementById('countdown'); if(c) c.classList.add('hidden'); }

// ----------------------------------------------------------------------------
//  Camera + render
// ----------------------------------------------------------------------------
const _camPos=new THREE.Vector3(), _look=new THREE.Vector3(), _tmp=new THREE.Vector3(), _camUp=new THREE.Vector3(0,1,0);
const _sunOff=new THREE.Vector3(55,120,35);
function finite(v){ return Number.isFinite(v.x)&&Number.isFinite(v.y)&&Number.isFinite(v.z); }

// ---- cinematic replay director: cuts between TV-style shots automatically ----
let _cine = { shot:null, t:0, dur:0, side:1, anchor:new THREE.Vector3() };
const _cineCam=new THREE.Vector3(), _cineLook=new THREE.Vector3(), _cv=new THREE.Vector3();
const CINE_TYPES=['trackside','heli','low','flyby','onboard','trackside','chopper'];
function cineReset(){ _cine.shot=null; _cine.t=0; _cine.dur=0; }
function cineCut(){
  let s; do{ s=CINE_TYPES[(Math.random()*CINE_TYPES.length)|0]; } while(s===_cine.shot);
  _cine.shot=s; _cine.t=0; _cine.dur=2.6+Math.random()*2.8; _cine.side=Math.random()<0.5?1:-1;
  const f=frameAt(G.dist); worldPos(G.dist,G.offset,_cv);
  if (s==='trackside') _cine.anchor.copy(_cv).addScaledVector(f.right,_cine.side*(ROAD_W+14+Math.random()*22)).addScaledVector(f.tan, 22+Math.random()*32).setY(_cv.y+4+Math.random()*6);
  else if (s==='flyby') _cine.anchor.copy(_cv).addScaledVector(f.right,_cine.side*(5+Math.random()*6)).addScaledVector(f.tan, 48+Math.random()*28).setY(_cv.y+2+Math.random()*2.5);
}
function cineCamera(f){
  _cine.t += _adt;
  if (!_cine.shot || _cine.t>=_cine.dur) cineCut();
  worldPos(G.dist,G.offset,_cv);
  const s=_cine.shot;
  _cineLook.copy(_cv); _cineLook.y+=1.2;
  let snap=false;
  if (s==='heli'){ _cineCam.copy(_cv).addScaledVector(f.tan,-12).setY(_cv.y+28); }
  else if (s==='chopper'){ _cineCam.copy(_cv).addScaledVector(f.tan,18).addScaledVector(f.right,_cine.side*10).setY(_cv.y+16); }
  else if (s==='low'){ _cineCam.copy(_cv).addScaledVector(f.tan,-7).addScaledVector(f.right,_cine.side*2.5).setY(_cv.y+0.8); _cineLook.copy(_cv).addScaledVector(f.tan,18).setY(_cv.y+1.4); }
  else if (s==='onboard'){ _cineCam.copy(_cv).addScaledVector(f.tan,0.4).setY(_cv.y+1.55); _cineLook.copy(_cv).addScaledVector(f.tan,22).addScaledVector(f.right,G.steerVis*3).setY(_cv.y+1.1); }
  else { _cineCam.copy(_cine.anchor); snap=true; }       // trackside / flyby = locked-off camera
  if (snap && _cineCam.distanceTo(_cv)>155) _cine.t=_cine.dur;   // car ran out of frame -> cut next frame
  if (finite(_cineCam) && finite(_cineLook)){
    if (snap) camera.position.copy(_cineCam); else camera.position.lerp(_cineCam, 0.18);
    camera.up.set(0,1,0); camera.lookAt(_cineLook);
  }
}

function present(){
  if (_ctxLost) return;
  if (_GPU){ if (_post) _post.renderAsync(); else renderer.renderAsync(scene, camera); }
  else renderer.render(scene, camera);
}
// EXPERIMENTAL: build a maxed WebGPU post-processing chain. Each effect is
// independently guarded, so whatever the device supports renders and one
// failing effect never kills the rest (bloom always survives). The HUD-canvas
// cinematic grade/vignette/flare/rain still apply on top in both renderers.
async function setupWebGPU(){
  await renderer.init();
  // Known-good bloom-only chain (the version confirmed rendering on-device).
  // Advanced passes (AO/SSR/DoF/FXAA) are parked — they blanked the render and
  // need to be re-introduced and device-tested one at a time. If even bloom
  // fails, _post stays null and we render the scene plainly (never blank).
  try {
    const tsl = await import('three/tsl');
    const { bloom } = await import('three/addons/tsl/display/BloomNode.js');
    const scenePass = tsl.pass(scene, camera);
    const color = scenePass.getTextureNode();
    const post = new THREE.PostProcessing(renderer);
    post.outputNode = color.add(bloom(color, 0.8, 0.4, 0.18));   // strength, radius, threshold
    _post = post;
    console.log('[WebGPU] bloom post-processing active');
  } catch(e){ console.warn('[WebGPU] post-fx unavailable; plain render', e); _post=null; }
}

// ---- world animation: spinning wheels, the turning London Eye, the waving flag ----
function spinWheels(car, speed){
  const ws = car && car.userData.wheels; if (!ws) return;
  const roll = (speed/0.55) * _adt;
  for (const w of ws) w.rotation.x -= roll;
}
function animateWorld(){
  const t=_animClock += _adt;
  // spinning wheels
  spinWheels(playerCar, G.speed);
  for (const r of rivals) spinWheels(r.mesh, r.speed);
  // turning London Eye etc.
  for (const s of _spinners) s.obj.rotation.z += s.rate * _adt;
  // waving flag
  for (const fl of _flags) for (const s of fl.segs){
    s.mesh.position.z = Math.sin(t*5 + s.t*6) * 0.6 * s.t;
    s.mesh.rotation.y = Math.sin(t*5 + s.t*6) * 0.5 * s.t;
  }
  // swaying trees (livelier)
  for (const s of _sway) s.obj.rotation.z = Math.sin(t*2.2 + s.ph) * s.amp;
  // pulsing lights — windows flash brightly, landmark glows breathe gently
  for (const p of _pulse){
    const w = Math.sin(t*(p.sp||1.8) + p.ph);
    p.mat.emissiveIntensity = p.flash ? p.base*(0.2 + 1.0*(0.5+0.5*w)) : p.base*(0.6 + 0.4*w);
  }
  // animated (scrolling) window textures
  for (const sc of _scroll) sc.tex.offset.y += sc.v * _adt;
  // grandstand crowd "wave" — a big hump of standing fans sweeps along the stands
  for (const wv of _wave){ const rise=Math.pow(Math.max(0, Math.sin(t*2.4 - wv.k*0.55)), 0.6); wv.mesh.position.y = wv.baseY + rise*4.0; }
  // arcade tyre-smoke puffs
  updateSmoke();
}

function render(){
  if (!G.started || !frames.length){ present(); return; }

  placeCar(playerCar, G.dist, G.offset);
  placeRivals();
  placeGhost();
  animateWorld();
  // visual lean
  playerCar.rotateY(G.steerVis * 0.16);
  playerCar.rotateZ(-G.steerVis * 0.05 * (G.vehicle.rollMul||1));
  if (playerCar.userData.brakeMats){
    const on = G.state==='racing' && (keys.brake || G.speed<0);
    for (const m of playerCar.userData.brakeMats) m.emissiveIntensity = on?2.6:0.8;
    if (playerCar.userData.tailGlow) for (const q of playerCar.userData.tailGlow){ q.material.opacity = on?0.95:(G.night?0.55:0.32); q.scale.setScalar(on?1.3:1); }
    // brake discs glow red-hot when braking hard at speed, cooling off afterwards
    const bd=playerCar.userData.brakeDisc;
    if (bd){ const heat = (keys.brake && Math.abs(G.speed)>(G.maxSpeed||1)*0.3) ? 1 : 0;
      bd.emissiveIntensity += ((heat?1.6:0) - bd.emissiveIntensity) * Math.min(1, _adt*(heat?6:1.5)); }
  }
  if (sun){ sun.target.position.copy(playerCar.position); sun.position.copy(playerCar.position).add(_sunOff); sun.target.updateMatrixWorld(); }
  // cockpit hides the chassis; dash & chase show the car (dash shows its bonnet)
  const cinematic = ((G.state==='replay' || G.state==='attract') && G.view==='cinematic');
  const firstPerson = (G.view==='cockpit' || G.view==='dash');
  playerCar.visible = !(G.view==='cockpit' || (cinematic && _cine.shot==='onboard'));

  const f = frameAt(G.dist);
  if (cinematic){
    cineCamera(f);
  } else if (firstPerson){
    worldPos(G.dist, G.offset, _tmp);
    let eyeFwd, eyeY, lookDrop;
    if (G.view==='dash'){            // hood cam: nearer the nose so only a short bonnet shows
      eyeFwd = 2.15; eyeY = _tmp.y + 1.74; lookDrop = 1.9;
    } else {                         // cockpit: eye in the cabin
      eyeFwd = 0.4;  eyeY = _tmp.y + 1.5;  lookDrop = 0.4;
    }
    _camPos.copy(_tmp).addScaledVector(f.tan, eyeFwd); _camPos.y = eyeY;
    _look.copy(_tmp).addScaledVector(f.tan, 22).addScaledVector(f.right, G.steerVis*3.2);
    _look.y = eyeY - lookDrop;
    if (finite(_camPos) && finite(_look)){
      camera.position.copy(_camPos);
      if (G.shake>0.02){ const s=G.shake*0.6; camera.position.y += (Math.random()-0.5)*s; camera.position.x += (Math.random()-0.5)*s; }
      camera.up.set(0,1,0);
      camera.lookAt(_look);
      camera.rotateZ(-G.steerVis*0.05);   // subtle body roll
    }
  } else {
    // chase camera — behind + above the car, ALWAYS world-up (never inverts/rolls
    // badly), finiteness-guarded. Height uses world up so the camera is always above.
    const camLat = G.offset * 0.30;
    worldPos(G.dist, camLat, _tmp);
    _camPos.copy(_tmp).addScaledVector(f.tan,-11); _camPos.y += 5.2;
    _look.copy(_tmp).addScaledVector(f.tan, 16);   _look.y += 4.4;
    if (finite(_camPos) && finite(_look)){
      camera.position.lerp(_camPos, 0.25);
      if (G.shake>0.02){ const s=G.shake; camera.position.x+=(Math.random()-0.5)*s; camera.position.y+=(Math.random()-0.5)*s; }
      camera.up.set(0,1,0);
      camera.lookAt(_look);
    }
  }
  if (sky) sky.position.copy(camera.position);
  if (_sunSprite) _sunSprite.quaternion.copy(camera.quaternion);   // keep the sun facing the camera
  updateClouds();

  let targetFov = 62 + speedFracFov()*16 + (G.boostActive?12:0);   // FOV opens with speed (and punches on nitro)
  const asp = camera.aspect||1;
  if (asp < 1){
    const minH = 58*Math.PI/180;
    const vForMinH = 2*Math.atan(Math.tan(minH/2)/asp)*180/Math.PI;
    targetFov = Math.min(98, Math.max(targetFov, vForMinH));
  }
  camera.fov += (targetFov - camera.fov)*0.08; camera.updateProjectionMatrix();

  present();
  drawHUD();
}
function speedFracFov(){ return Math.min(1, Math.abs(G.speed)/(G.maxSpeed||1)); }

// ----------------------------------------------------------------------------
//  HUD overlay (rev gauge + speed + minimap + speed lines) on the 2D canvas
// ----------------------------------------------------------------------------
let miniPath=[], miniBounds=null;
function buildMinimap(){
  let minx=1e9,maxx=-1e9,minz=1e9,maxz=-1e9;
  for (const f of frames){ minx=Math.min(minx,f.pos.x);maxx=Math.max(maxx,f.pos.x);minz=Math.min(minz,f.pos.z);maxz=Math.max(maxz,f.pos.z); }
  miniBounds={minx,maxx,minz,maxz};
  miniPath=[]; for (let i=0;i<frames.length;i+=14) miniPath.push(frames[i].pos);
}
function miniXY(p, x, y, s){
  const b=miniBounds;
  const nx=(p.x-b.minx)/((b.maxx-b.minx)||1), ny=(p.z-b.minz)/((b.maxz-b.minz)||1);
  return [ x + 6 + nx*(s-12), y + 6 + ny*(s-12) ];
}
function lerp(a,b,t){ return a+(b-a)*t; }

// cinematic colour grade + vignette, drawn on the HUD canvas (over the 3D scene)
function drawGrade(W,H,sp){
  // warm light wash up top (cooler at night), gentle cool wash along the bottom
  const wash=hctx.createLinearGradient(0,0,0,H);
  wash.addColorStop(0.0, G.night?'rgba(60,90,170,0.12)':'rgba(255,224,170,0.10)');
  wash.addColorStop(0.42,'rgba(255,255,255,0.0)');
  wash.addColorStop(1.0, G.night?'rgba(4,6,20,0.30)':'rgba(20,40,80,0.12)');
  hctx.fillStyle=wash; hctx.fillRect(0,0,W,H);
  // vignette — tightens & darkens with speed for a sense of rush (darker at night)
  const cx=W*0.5, cy=H*0.52;
  const inner=Math.min(W,H)*(0.33 - sp*0.10);
  const outer=Math.max(W,H)*0.78;
  const base=G.night?0.5:0.38;
  const vg=hctx.createRadialGradient(cx,cy,inner, cx,cy,outer);
  vg.addColorStop(0,'rgba(0,0,8,0)');
  vg.addColorStop(0.62,'rgba(0,0,8,0)');
  vg.addColorStop(1,`rgba(0,0,10,${base+sp*0.18})`);
  hctx.fillStyle=vg; hctx.fillRect(0,0,W,H);
  if (G.rain){ hctx.fillStyle='rgba(42,54,76,0.24)'; hctx.fillRect(0,0,W,H); }   // grey storm wash
}
// animated falling rain streaks (deterministic set, scrolls with the clock)
let _rainDrops=null;
function drawRain(W,H){
  if (!_rainDrops || _rainDrops.W!==W){ const list=[]; for(let i=0;i<110;i++) list.push({x:Math.random(), len:0.04+Math.random()*0.06, sp:0.9+Math.random()*0.8, ph:Math.random()}); _rainDrops={W,list}; }
  const t=_animClock;
  hctx.save(); hctx.strokeStyle='rgba(195,212,238,0.5)'; hctx.lineWidth=Math.max(1,W*0.0018); hctx.lineCap='round';
  for (const d of _rainDrops.list){
    const yy=((t*d.sp + d.ph)%1.2)-0.1, px=d.x*W, py=yy*H;
    hctx.beginPath(); hctx.moveTo(px,py); hctx.lineTo(px - W*0.018, py + d.len*H); hctx.stroke();
  }
  hctx.restore();
}
// pre-rendered film-grain tile
function getGrain(){
  if (_grainCanvas) return _grainCanvas;
  const c=document.createElement('canvas'); c.width=c.height=128; const x=c.getContext('2d');
  const img=x.createImageData(128,128);
  for (let i=0;i<img.data.length;i+=4){ const v=110+(Math.random()*145|0); img.data[i]=img.data[i+1]=img.data[i+2]=v; img.data[i+3]=255; }
  x.putImageData(img,0,0); _grainCanvas=c; return c;
}
function drawGrain(W,H){
  const g=getGrain(); hctx.save(); hctx.globalAlpha=0.04;
  const ox=(Math.random()*128)|0, oy=(Math.random()*128)|0;
  for (let y=-oy;y<H;y+=128) for (let x=-ox;x<W;x+=128) hctx.drawImage(g,x,y);
  hctx.restore();
}
// projected sun position → a real anamorphic lens flare (additive ghosts + streak)
const SUN_DIR = new THREE.Vector3(60,120,30).normalize();
const _fv = new THREE.Vector3();
function drawLensFlare(W,H){
  if (!camera) return;
  _fv.copy(SUN_DIR).multiplyScalar(3000).add(camera.position).project(camera);
  if (_fv.z>1) return;                                   // sun behind the camera
  const sx=(_fv.x*0.5+0.5)*W, sy=(-_fv.y*0.5+0.5)*H;
  if (sx<-W*0.4||sx>W*1.4||sy<-H*0.4||sy>H*1.4) return;
  const dx=W*0.5-sx, dy=H*0.5-sy;
  const vis=Math.max(0, 1 - Math.hypot(dx,dy)/Math.hypot(W,H)*1.5);
  if (vis<=0.02) return;
  hctx.save(); hctx.globalCompositeOperation='lighter';
  const core=Math.min(W,H)*0.24;
  let g=hctx.createRadialGradient(sx,sy,0,sx,sy,core);
  g.addColorStop(0,`rgba(255,252,235,${0.55*vis})`); g.addColorStop(0.3,`rgba(255,236,185,${0.22*vis})`); g.addColorStop(1,'rgba(255,230,170,0)');
  hctx.fillStyle=g; hctx.beginPath(); hctx.arc(sx,sy,core,0,6.28); hctx.fill();
  const ghosts=[[0.3,0.05,'255,220,180'],[0.55,0.09,'170,255,225'],[0.85,0.05,'205,205,255'],[1.2,0.12,'255,205,165'],[1.55,0.07,'180,225,255'],[1.9,0.04,'255,240,210']];
  for (const [t,sz,col] of ghosts){ const gx=sx+dx*2*t, gy=sy+dy*2*t, r=Math.min(W,H)*sz;
    const gg=hctx.createRadialGradient(gx,gy,0,gx,gy,r);
    gg.addColorStop(0,`rgba(${col},${0.2*vis})`); gg.addColorStop(0.7,`rgba(${col},${0.04*vis})`); gg.addColorStop(1,`rgba(${col},0)`);
    hctx.fillStyle=gg; hctx.beginPath(); hctx.arc(gx,gy,r,0,6.28); hctx.fill(); }
  hctx.fillStyle=`rgba(255,244,210,${0.08*vis})`; hctx.fillRect(0, sy-1.5, W, 3);   // anamorphic streak
  hctx.restore();
}

// a single round instrument dial (tacho / speedo) on the dashboard
function drawDial(cx,cy,r,frac,opt){
  opt=opt||{}; frac=Math.max(0,Math.min(1,frac));
  const a0=Math.PI*0.80, a1=Math.PI*2.20;   // ~252° sweep
  hctx.fillStyle='#0b0d11'; hctx.beginPath(); hctx.arc(cx,cy,r*1.16,0,6.28); hctx.fill();
  hctx.lineWidth=r*0.07; hctx.strokeStyle='#474d59'; hctx.beginPath(); hctx.arc(cx,cy,r*1.11,0,6.28); hctx.stroke();
  const fg=hctx.createRadialGradient(cx,cy-r*0.35,r*0.1,cx,cy,r);
  fg.addColorStop(0,'#1c2029'); fg.addColorStop(1,'#0d0f13');
  hctx.fillStyle=fg; hctx.beginPath(); hctx.arc(cx,cy,r,0,6.28); hctx.fill();
  const N=opt.ticks||10;
  for (let i=0;i<=N;i++){ const t=i/N, a=lerp(a0,a1,t), c=Math.cos(a), s=Math.sin(a);
    const red=opt.redFrom!=null && t>=opt.redFrom, lit=t<=frac;
    hctx.strokeStyle = red ? (lit?'#ff5757':'#5b2a30') : (lit?'#eaf1fa':'#586070');
    hctx.lineWidth = (i%(opt.major||1)===0)? r*0.07 : r*0.04;
    hctx.beginPath(); hctx.moveTo(cx+c*r*0.78, cy+s*r*0.78); hctx.lineTo(cx+c*r*0.96, cy+s*r*0.96); hctx.stroke();
  }
  // needle
  const na=lerp(a0,a1,frac);
  hctx.strokeStyle='#ff6a3d'; hctx.lineWidth=r*0.06; hctx.lineCap='round';
  hctx.beginPath(); hctx.moveTo(cx-Math.cos(na)*r*0.12, cy-Math.sin(na)*r*0.12); hctx.lineTo(cx+Math.cos(na)*r*0.84, cy+Math.sin(na)*r*0.84); hctx.stroke();
  hctx.fillStyle='#ff6a3d'; hctx.beginPath(); hctx.arc(cx,cy,r*0.1,0,6.28); hctx.fill();
  hctx.textAlign='center';
  if (opt.value!=null){ hctx.fillStyle='#2bd451'; hctx.font=`900 ${Math.round(r*0.5)}px Arial`; hctx.textBaseline='middle'; hctx.fillText(opt.value, cx, cy+r*0.42); }
  if (opt.label){ hctx.fillStyle='#aeb6c2'; hctx.font=`bold ${Math.round(r*0.2)}px Arial`; hctx.textBaseline='middle'; hctx.fillText(opt.label, cx, cy+r*0.74); }
}
// in-car dashboard: instrument binnacle (tacho + speedo + shift light) and a turning wheel
function drawDashboard(W,H,sp){
  const steer=G.steerVis, kmh=Math.round(Math.abs(G.speed)*2.4);
  // A-pillars (cabin frame)
  hctx.fillStyle='rgba(10,11,16,0.92)';
  hctx.beginPath(); hctx.moveTo(0,0); hctx.lineTo(W*0.18,0); hctx.lineTo(0,H*0.40); hctx.closePath(); hctx.fill();
  hctx.beginPath(); hctx.moveTo(W,0); hctx.lineTo(W*0.82,0); hctx.lineTo(W,H*0.40); hctx.closePath(); hctx.fill();
  // dashboard panel — a curved cowl humped up toward the driver binnacle
  const dashTop=H*0.72;   // shorter dash so the car bonnet shows above it
  hctx.save();
  hctx.beginPath();
  hctx.moveTo(0,H); hctx.lineTo(0,dashTop+H*0.06);
  hctx.quadraticCurveTo(W*0.5, dashTop-H*0.07, W, dashTop+H*0.06);
  hctx.lineTo(W,H); hctx.closePath();
  const dg=hctx.createLinearGradient(0,dashTop-H*0.07,0,H);
  dg.addColorStop(0,'#262a32'); dg.addColorStop(0.22,'#161920'); dg.addColorStop(1,'#070809');
  hctx.fillStyle=dg; hctx.fill();
  hctx.lineWidth=Math.max(2,H*0.004); hctx.strokeStyle='rgba(130,140,160,0.28)'; hctx.stroke();
  hctx.restore();
  // instrument binnacle housing
  hctx.fillStyle='rgba(5,6,9,0.92)';
  roundRect(W*0.15, dashTop-H*0.02, W*0.70, H*0.20, H*0.02); hctx.fill();
  // gauges: tacho (left) + speedo (right)
  const gy=dashTop+H*0.07, gr=Math.min(W,H)*0.092;
  drawDial(W*0.345, gy, gr, sp, {ticks:10, major:1, redFrom:0.8, label:'RPM'});
  drawDial(W*0.655, gy, gr, Math.min(1,kmh/340), {ticks:8, major:2, value:kmh, label:'KM/H'});
  // shift light between the gauges — flares as the revs hit the redline
  const shift = sp>0.86;
  hctx.fillStyle = shift ? '#ff2a2a' : '#3a1414';
  hctx.beginPath(); hctx.arc(W*0.5, gy-gr*0.5, gr*0.16, 0, 6.28); hctx.fill();
  if (shift){ hctx.fillStyle='rgba(255,60,60,0.35)'; hctx.beginPath(); hctx.arc(W*0.5, gy-gr*0.5, gr*0.34, 0, 6.28); hctx.fill(); }
  // gear-ish badge under the shift light
  hctx.fillStyle='#cdd4de'; hctx.font=`900 ${Math.round(gr*0.34)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='middle';
  hctx.fillText('GT', W*0.5, gy+gr*0.25);
  // steering wheel (hub below the screen so only the upper rim shows; rotates with steer)
  const cx=W*0.5, cy=H*1.14, R=W*0.42;
  hctx.save();
  hctx.translate(cx,cy); hctx.rotate(steer*0.7);
  hctx.lineCap='round';
  hctx.lineWidth=Math.max(6,R*0.12); hctx.strokeStyle='#0c0d11';
  hctx.beginPath(); hctx.arc(0,0,R,0,Math.PI*2); hctx.stroke();
  hctx.lineWidth=Math.max(3,R*0.05); hctx.strokeStyle='#2a2d36';
  hctx.beginPath(); hctx.arc(0,0,R,0,Math.PI*2); hctx.stroke();
  hctx.strokeStyle='#191b22'; hctx.lineWidth=R*0.16; hctx.lineCap='butt';
  for (const a of [-Math.PI/2, Math.PI/6, Math.PI*5/6]){
    hctx.beginPath(); hctx.moveTo(0,0); hctx.lineTo(Math.cos(a)*R*0.92, Math.sin(a)*R*0.92); hctx.stroke();
  }
  hctx.fillStyle='#23262e'; hctx.beginPath(); hctx.arc(0,0,R*0.22,0,Math.PI*2); hctx.fill();
  hctx.fillStyle='#d6262b'; hctx.beginPath(); hctx.arc(0,0,R*0.09,0,Math.PI*2); hctx.fill();
  hctx.fillStyle='#e9e9ee'; hctx.fillRect(-R*0.05,-R-R*0.06,R*0.10,R*0.12);   // top-centre rim marker
  hctx.restore();
}
function roundRect(x,y,w,h,r){ hctx.beginPath(); hctx.moveTo(x+r,y); hctx.arcTo(x+w,y,x+w,y+h,r); hctx.arcTo(x+w,y+h,x,y+h,r); hctx.arcTo(x,y+h,x,y,r); hctx.arcTo(x,y,x+w,y,r); hctx.closePath(); }

function drawHUD(){
  const W=hud2d.width, H=hud2d.height;
  hctx.clearRect(0,0,W,H);
  if (!G.started) return;
  const sp = Math.min(1, Math.abs(G.speed)/(G.maxSpeed||1));

  // cinematic grade over the 3D (the HUD canvas sits on top of the GL canvas):
  // a speed-reactive vignette + a faint warm sky wash / cool road wash.
  drawGrade(W,H,sp);
  if (!G.night && !G.rain) drawLensFlare(W,H);   // sun lens flare (clear day only)
  if (G.rain) drawRain(W,H);                      // falling rain streaks
  drawGrain(W,H);              // subtle film grain
  if (G.state==='attract') return;                // attract demo: cinematic only, no gameplay HUD

  // cockpit framing — A-pillars + dashboard lip so first-person reads as "in the car"
  if (G.view==='cockpit'){
    const dashH=H*0.13;
    const grad=hctx.createLinearGradient(0,H-dashH,0,H);
    grad.addColorStop(0,'rgba(8,9,14,0)'); grad.addColorStop(0.5,'rgba(8,9,14,0.82)'); grad.addColorStop(1,'rgba(8,9,14,0.97)');
    hctx.fillStyle=grad; hctx.fillRect(0,H-dashH,W,dashH);
    hctx.fillStyle='rgba(10,11,16,0.9)';
    hctx.beginPath(); hctx.moveTo(0,0); hctx.lineTo(W*0.16,0); hctx.lineTo(0,H*0.34); hctx.closePath(); hctx.fill();
    hctx.beginPath(); hctx.moveTo(W,0); hctx.lineTo(W*0.84,0); hctx.lineTo(W,H*0.34); hctx.closePath(); hctx.fill();
  } else if (G.view==='dash'){
    drawDashboard(W,H,sp);
  }

  // speed lines streaking from the vanishing point at high speed
  if (G.state==='racing' && sp>0.5){
    const n=Math.floor((sp-0.5)*60), cx=W*0.5, cy=H*0.52;
    hctx.strokeStyle=`rgba(255,255,255,${(sp-0.5)*0.45})`; hctx.lineWidth=Math.max(1,W*0.0014);
    for (let i=0;i<n;i++){
      const a=(i*2.39996)%6.283, r0=Math.min(W,H)*0.2, r1=r0+(40+((i*53)%120))*(W/1280);
      hctx.beginPath(); hctx.moveTo(cx+Math.cos(a)*r0, cy+Math.sin(a)*r0); hctx.lineTo(cx+Math.cos(a)*r1, cy+Math.sin(a)*r1); hctx.stroke();
    }
  }

  // rev gauge + speed (top-centre) — hidden in dash view, which has its own dials
  if (G.view!=='dash'){
  const gx=W/2, gy=H*0.235, gr=Math.min(W,H)*0.085;
  const a0=Math.PI*1.18, a1=Math.PI*1.82, ticks=10;
  hctx.lineWidth=Math.max(5,gr*0.18); hctx.lineCap='round';
  for (let i=0;i<ticks;i++){
    hctx.strokeStyle=`hsl(${(1-i/ticks)*230},90%,55%)`;
    hctx.beginPath(); hctx.arc(gx,gy,gr,lerp(a0,a1,i/ticks),lerp(a0,a1,(i+1)/ticks)); hctx.stroke();
  }
  // needle
  const na=lerp(a0,a1,sp);
  hctx.strokeStyle='#ffd400'; hctx.lineWidth=Math.max(3,gr*0.08);
  hctx.beginPath(); hctx.moveTo(gx,gy); hctx.lineTo(gx+Math.cos(na)*gr*0.92, gy+Math.sin(na)*gr*0.92); hctx.stroke();
  hctx.fillStyle='#ffd400'; hctx.beginPath(); hctx.arc(gx,gy,gr*0.1,0,6.28); hctx.fill();
  // tick numbers
  hctx.fillStyle='#fff'; hctx.font=`bold ${Math.max(7,gr*0.2)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='middle';
  for (let i=0;i<=ticks;i++){ const a=lerp(a0,a1,i/ticks); hctx.fillText(String(i), gx+Math.cos(a)*gr*1.28, gy+Math.sin(a)*gr*1.28); }
  // speed number
  const kmh=Math.round(Math.abs(G.speed)*2.4);
  hctx.fillStyle='#2bd451'; hctx.font=`bold ${Math.round(gr*0.5)}px Arial`;
  hctx.fillText(kmh, gx, gy+gr*0.7);
  hctx.fillStyle='#fff'; hctx.font=`bold ${Math.round(gr*0.2)}px Arial`;
  hctx.fillText('KM/H', gx, gy+gr*1.0);
  }

  // minimap (top-right)
  if (miniBounds){
    const s=Math.min(W,H)*0.18, mx=W-s-W*0.03, my=H*0.16;
    hctx.fillStyle='rgba(0,0,0,0.35)'; hctx.strokeStyle='rgba(255,255,255,0.5)'; hctx.lineWidth=Math.max(1,W*0.002);
    hctx.fillRect(mx,my,s,s); hctx.strokeRect(mx,my,s,s);
    // track path
    hctx.strokeStyle='rgba(255,255,255,0.85)'; hctx.lineWidth=Math.max(1.5,W*0.003);
    hctx.beginPath();
    for (let i=0;i<miniPath.length;i++){ const [px,py]=miniXY(miniPath[i],mx,my,s); if(i===0)hctx.moveTo(px,py); else hctx.lineTo(px,py); }
    hctx.closePath(); hctx.stroke();
    // rival dots
    for (const r of rivals){ worldPos(r.dist,0,_tmp); const [px,py]=miniXY(_tmp,mx,my,s); hctx.fillStyle='#ff5a5a'; hctx.beginPath(); hctx.arc(px,py,Math.max(2,W*0.006),0,6.28); hctx.fill(); }
    // player dot
    worldPos(G.dist,0,_tmp); const [px,py]=miniXY(_tmp,mx,my,s); hctx.fillStyle='#2bd451'; hctx.beginPath(); hctx.arc(px,py,Math.max(2.5,W*0.008),0,6.28); hctx.fill();
    hctx.fillStyle='#fff'; hctx.font=`bold ${Math.max(8,W*0.018)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='top';
    hctx.fillText('TRAFFIC', mx+s/2, my+s+2);
  }

  // ---- nitro meter (centre, under the timer) ----
  {
    const bw=W*0.30, bh=Math.max(7,H*0.013), bx=W*0.5-bw/2, by=H*0.118;
    hctx.fillStyle='rgba(0,0,0,0.45)'; roundRect(bx-2,by-2,bw+4,bh+4,bh*0.6); hctx.fill();
    const full=G.boost>=0.999, fw=bw*Math.max(0,Math.min(1,G.boost));
    const gr=hctx.createLinearGradient(bx,0,bx+bw,0); gr.addColorStop(0,'#ff7a1a'); gr.addColorStop(1, full?'#ffe14a':'#ffb02a');
    hctx.fillStyle=gr; roundRect(bx,by,fw,bh,bh*0.5); hctx.fill();
    if (G.boostActive){ hctx.fillStyle='rgba(255,230,120,0.5)'; roundRect(bx,by,fw,bh,bh*0.5); hctx.fill(); }
    hctx.fillStyle = full?'#ffe14a':'#cfd6df'; hctx.font=`900 ${Math.max(8,W*0.02)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='bottom';
    hctx.fillText('NITRO', W*0.5, by-3);
  }
  // ---- best lap record (top-left, under the lap clock) ----
  if (G.bestLap>0){
    hctx.fillStyle='#ffd400'; hctx.font=`bold ${Math.max(9,W*0.022)}px Arial`; hctx.textAlign='left'; hctx.textBaseline='top';
    hctx.fillText('BEST '+fmtTime(G.bestLap), W*0.035, H*0.108);
  }
  // ---- ghost delta: are you ahead of or behind your best-lap ghost? ----
  if (G.state==='racing' && _ghost && _ghostDelta!=null){
    const d=_ghostDelta, ahead=d<0;
    hctx.fillStyle = ahead ? '#2bd451' : '#ff5a5a';
    hctx.font=`900 ${Math.max(10,W*0.026)}px Arial`; hctx.textAlign='left'; hctx.textBaseline='top';
    hctx.fillText('👻 '+(ahead?'-':'+')+Math.abs(d).toFixed(1)+'s', W*0.035, H*0.135);
  }
  // ---- drift score + live combo ----
  if (G.state==='racing'){
    hctx.fillStyle='#ffd400'; hctx.font=`900 ${Math.max(11,W*0.03)}px Arial`; hctx.textAlign='right'; hctx.textBaseline='top';
    hctx.fillText('◆ '+Math.round(_sessionScore).toLocaleString(), W-W*0.035, H*0.255);
    if (_driftActive>0.25){
      const pulse=0.7+0.3*Math.sin(_animClock*14);
      hctx.fillStyle=`rgba(255,150,40,${pulse})`; hctx.font=`900 ${Math.max(13,W*0.04)}px Arial Black, Arial`; hctx.textAlign='center'; hctx.textBaseline='middle';
      hctx.fillText('DRIFT  x'+_driftCombo, W*0.5, H*0.66);
    }
  }

  // ---- big arcade callout (GO! / OVERTAKE! / FINAL LAP! / FINISH!) ----
  if (_callout){
    _callout.t += _adt;
    const T=_callout.t, LIFE=1.5;
    if (T>=LIFE){ _callout=null; }
    else {
      const pop  = T<0.2 ? T/0.2 : 1;                 // springy scale-in
      const fade = T>LIFE-0.4 ? (LIFE-T)/0.4 : 1;     // fade-out
      const fs = Math.round(Math.min(W,H)*0.12)*(0.55+0.45*pop);
      hctx.save();
      hctx.globalAlpha = Math.max(0,Math.min(1,fade));
      hctx.translate(W*0.5, H*0.4);
      hctx.rotate(Math.sin(T*16)*0.025);              // arcade wobble
      hctx.textAlign='center'; hctx.textBaseline='middle';
      hctx.font=`900 ${fs}px Arial Black, Arial`;
      hctx.lineWidth=fs*0.16; hctx.lineJoin='round'; hctx.strokeStyle='#0a0a12';
      hctx.strokeText(_callout.text,0,0);
      hctx.shadowColor=_callout.color; hctx.shadowBlur=fs*0.4;
      hctx.fillStyle=_callout.color;
      hctx.fillText(_callout.text,0,0);
      hctx.restore();
    }
  }
}

// ----------------------------------------------------------------------------
//  Input
// ----------------------------------------------------------------------------
function bindInput(){
  const set=(k,val)=>{ keys[k]=val; };
  window.addEventListener('keydown', e=>{
    if (e.repeat) return;
    if (e.key==='ArrowUp'||e.key==='w'||e.key==='W') set('gas',true);
    else if (e.key==='ArrowDown'||e.key==='s'||e.key==='S') set('brake',true);
    else if (e.key==='ArrowLeft'||e.key==='a'||e.key==='A') set('left',true);
    else if (e.key==='ArrowRight'||e.key==='d'||e.key==='D') set('right',true);
    else if (e.key==='Shift'||e.key===' '||e.code==='Space') set('boost',true);
    else if (e.key==='c'||e.key==='C') toggleView();
  });
  window.addEventListener('keyup', e=>{
    if (e.key==='ArrowUp'||e.key==='w'||e.key==='W') set('gas',false);
    else if (e.key==='ArrowDown'||e.key==='s'||e.key==='S') set('brake',false);
    else if (e.key==='ArrowLeft'||e.key==='a'||e.key==='A') set('left',false);
    else if (e.key==='ArrowRight'||e.key==='d'||e.key==='D') set('right',false);
    else if (e.key==='Shift'||e.key===' '||e.code==='Space') set('boost',false);
  });
  // touch buttons
  const hook=(id,k)=>{
    const el=document.getElementById(id); if(!el) return;
    const on =e=>{ e.preventDefault(); set(k,true); };
    const off=e=>{ e.preventDefault(); set(k,false); };
    el.addEventListener('pointerdown',on); el.addEventListener('pointerup',off);
    el.addEventListener('pointercancel',off); el.addEventListener('pointerleave',off);
  };
  hook('tgas','gas'); hook('tbrake','brake'); hook('tleft','left'); hook('tright','right'); hook('tboost','boost');
}

// ---- gamepad support (polled each frame; standard mapping) ----
let _padOn=false;
function pollGamepad(){
  if (!navigator.getGamepads) return;
  let gp=null; const list=navigator.getGamepads(); for (const g of list){ if(g){ gp=g; break; } }
  if (!gp){ _padOn=false; return; }
  const b=gp.buttons, ax=gp.axes;
  const pressed=i=>b[i]&&(b[i].pressed||b[i].value>0.4);
  const lx=ax[0]||0;
  const padLeft  = lx<-0.35 || pressed(14);
  const padRight = lx> 0.35 || pressed(15);
  const padGas   = pressed(7) || pressed(0);          // RT or A
  const padBrake = pressed(6) || pressed(1);          // LT or B
  const padBoost = pressed(2) || pressed(5);          // X or RB
  const active = padLeft||padRight||padGas||padBrake||padBoost;
  if (active && G.state==='attract'){ endAttract(); return; }
  if (active && _onTitle){ armIdle(); }
  if (G.state==='racing'){
    keys.left=padLeft; keys.right=padRight; keys.gas=keys.gas||padGas; keys.brake=keys.brake||padBrake; keys.boost=keys.boost||padBoost;
  }
  _padOn = active;
}
// ---- haptics (Android & Capacitor; no-op on iOS Safari, harmless) ----
function haptic(ms){ try{ if (navigator.vibrate) navigator.vibrate(ms); }catch(e){} }

// ----------------------------------------------------------------------------
//  Race start (full menu flow lands in M4 — for now START drives immediately)
// ----------------------------------------------------------------------------
function startRace(){
  clearTimeout(_idleTimer); _onTitle=false;
  const pb=document.getElementById('pauseBtn'); if(pb) pb.style.display='';   // restore (attract hid it)
  buildTrack(G.circuit);
  buildSky();
  buildEnv();
  buildRoadMesh();
  buildMinimap();
  try { buildScenery(); } catch(e){ _scnInfo='SCN-ERR:'+(e&&e.message||e); if(sceneryGroup&&!sceneryGroup.parent) scene.add(sceneryGroup); }
  boostBloomEmissive();
  if (playerCar){ scene.remove(playerCar); }
  playerCar = buildCar(G.vehicle); scene.add(playerCar);
  // ghost of your best lap on this circuit
  if (ghostCar){ scene.remove(ghostCar); ghostCar=null; }
  _ghost = ghostFor(); _lapTrace=[]; _ghostDelta=null;
  ghostCar = buildCar(G.vehicle); makeGhost(ghostCar); scene.add(ghostCar); ghostCar.visible=!!_ghost;
  buildRivals(MOBILE ? 7 : 9);
  G.maxSpeed = G.circuit.maxSpeed * G.vehicle.speedMul * 0.58;   // tuned to feel
  G.dist=0; G.offset=0; G.speed=0; G.lap=1; G.steerVis=0;
  G.timeLeft=G.circuit.startTime; G.totalTime=0; G.rollT=0; G.cdNum=-1; G.green=false;
  G.boost=1; G.boostActive=false; G.lapStart=0; G.bestLap=bestLapFor(); G.recordSet=false;   // nitro full + load best lap
  _replay=[]; _recT=0;                                  // fresh replay recording
  _sessionScore=0; _driftActive=0; _driftCombo=1;       // fresh drift score
  keys.gas=keys.brake=keys.left=keys.right=keys.boost=false;
  if (G.view==='cinematic') G.view='chase';
  G.started=true; G.state='rolling';
  _callout=null; _lastPos=1+rivals.length; _lastOvertakeT=-9;   // reset arcade callout state
  initSmoke(); resetSmoke();                          // tyre-smoke pool ready & cleared
  placeCar(playerCar, G.dist, G.offset);
  placeRivals();
  // snap camera behind the car immediately (world-up)
  const f=frameAt(G.dist); worldPos(G.dist,0,_tmp);
  camera.position.copy(_tmp).addScaledVector(f.tan,-11); camera.position.y+=5.2;
  camera.up.set(0,1,0); camera.lookAt(_tmp.clone().addScaledVector(f.tan,16).setY(_tmp.y+4.4));
  // HUD text
  setText('trackName', G.circuit.name+' • '+BUILD.split('—')[0].trim());
  updateRaceHUDText();
  hideOverlay();
  updateViewBtn();
  const vb=document.getElementById('viewBtn'); if(vb) vb.classList.remove('hidden');
  showBanner('GENTLEMEN,<br>START YOUR ENGINES!', 0, true);
  showTouch();
  startRaceMusic();
  initEngine();
}

// ---- race soundtrack: the chosen soundtrack (intro once -> loop) ----
let _raceAudio = { intro:null, loop:null };
function appleActive(){ return G.soundtrack==='applemusic' && window.AppleMusic && window.AppleMusic.authorized; }
function startRaceMusic(){
  stopRaceMusic();
  if (window.GameMusic && window.GameMusic.stop){ try{ window.GameMusic.stop(); }catch(e){} }   // silence procedural menu music
  if (appleActive()){   // stream the player's own Apple Music instead of a built-in track
    if (G.applePlaylist) window.AppleMusic.playPlaylist(G.applePlaylist);
    else window.AppleMusic.resume();
    return;
  }
  const st = SOUNDTRACKS[G.soundtrack] || SOUNDTRACKS.daytona;
  try {
    const intro = new Audio(st.intro); intro.volume=0.75;
    const loop  = new Audio(st.loop);  loop.loop=true; loop.volume=0.75;
    intro.addEventListener('ended', ()=>{ try{ loop.currentTime=0; loop.play().catch(()=>{}); }catch(e){} });
    intro.play().catch(()=>{ try{ loop.play().catch(()=>{}); }catch(e){} });   // if intro blocked, go straight to loop
    _raceAudio = { intro, loop };
  } catch(e){ /* audio optional */ }
}
function stopRaceMusic(){
  for (const k of ['intro','loop']){ const a=_raceAudio[k]; if(a){ try{ a.pause(); a.src=''; }catch(e){} } }
  _raceAudio = { intro:null, loop:null };
}
function pauseRaceMusic(p){
  if (appleActive()){ try{ p?window.AppleMusic.pause():window.AppleMusic.resume(); }catch(e){} }
  for (const k of ['intro','loop']){ const a=_raceAudio[k]; if(a){ try{ p?a.pause():(a.src&&a.play().catch(()=>{})); }catch(e){} } }
}

// ---- procedural engine sound (Web Audio): layered oscillators driven by RPM ----
// Sits UNDER the MP3 race music. Two slightly-detuned saws + a square sub for body,
// shaped by a lowpass that opens with revs, plus a touch of idle wobble.
let _eng = null;
function initEngine(){
  if (_eng) return;
  try {
    const AC = new (window.AudioContext||window.webkitAudioContext)();
    const master = AC.createGain(); master.gain.value = 0;          // silent until racing
    const filter = AC.createBiquadFilter(); filter.type='lowpass';
    filter.frequency.value = 400; filter.Q.value = 7;
    filter.connect(master); master.connect(AC.destination);
    const mk = (type, detune)=>{ const o=AC.createOscillator(); o.type=type; o.detune.value=detune;
      o.frequency.value=60; const g=AC.createGain(); o.connect(g); g.connect(filter); o.start(); return {o,g}; };
    const sawA = mk('sawtooth',  -7); sawA.g.gain.value = 0.55;
    const sawB = mk('sawtooth', +11); sawB.g.gain.value = 0.55;
    const sub  = mk('square',     0); sub.g.gain.value  = 0.32;     // half-frequency body
    _eng = { AC, master, filter, sawA, sawB, sub };
  } catch(e){ _eng = null; }   // audio is optional; never break the game
}
function updateEngine(){
  if (!_eng) return;
  const AC=_eng.AC, t=AC.currentTime;
  const racing = (G.state==='racing' || G.state==='rolling');
  const sp = Math.min(1, Math.abs(G.speed)/(G.maxSpeed||1));
  const onGas = !!(keys && keys.gas);
  // RPM: idle floor + speed, with a little extra lift on the throttle
  const rpm  = 0.12 + sp*0.84 + (onGas?0.06:0);
  const base = 46 + rpm*168;                       // fundamental in Hz
  const wob  = racing && sp<0.05 ? Math.sin(t*9)*1.4 : 0;   // idle lope
  _eng.sawA.o.frequency.setTargetAtTime(base+wob,     t, 0.05);
  _eng.sawB.o.frequency.setTargetAtTime(base+wob,     t, 0.05);
  _eng.sub.o.frequency.setTargetAtTime((base+wob)*0.5, t, 0.05);
  _eng.filter.frequency.setTargetAtTime(340 + rpm*2600 + (onGas?420:0), t, 0.06);
  const vol = racing ? (0.045 + sp*0.085 + (onGas?0.02:0)) : 0;
  _eng.master.gain.setTargetAtTime(vol, t, 0.08);
}

// ---- arcade audio stingers: short synth fanfares for big moments ----
function arcadeStinger(notes, type){
  const AC = _eng && _eng.AC; if (!AC) return;
  const t0 = AC.currentTime;
  notes.forEach((f,i)=>{
    const o=AC.createOscillator(); o.type=type||'square'; o.frequency.value=f;
    const g=AC.createGain(); const st=t0+i*0.09;
    g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(0.12, st+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, st+0.28);
    o.connect(g); g.connect(AC.destination); o.start(st); o.stop(st+0.3);
  });
}

// ---- big arcade callout text (DAYTONA-style "OVERTAKE!", "FINAL LAP!", "GO!") ----
const _NOTE = {C5:523,E5:659,G5:784,C6:1047,A5:880,F5:698,D5:587};
function arcadeCallout(text, color, notes){
  _callout = { text, color: color||'#ffd400', t: 0 };
  if (notes) arcadeStinger(notes, 'square');
}

// ---- arcade tyre-smoke puffs: a recycled pool of camera-facing quads ----
function initSmoke(){
  if (_smokeGroup){ if(!_smokeGroup.parent && scene) scene.add(_smokeGroup); return; }
  _smokeGroup = new THREE.Group(); _smoke = [];
  const N = MOBILE ? 12 : 22;
  const geo = new THREE.PlaneGeometry(1,1);
  for (let i=0;i<N;i++){
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color:0xffffff, transparent:true, opacity:0, depthWrite:false}));
    m.visible=false; _smokeGroup.add(m); _smoke.push({mesh:m, life:0});
  }
  scene.add(_smokeGroup);
}
function emitSmoke(x,y,z, tint){
  let p=null, oldest=1e9;
  for (const s of _smoke){ if(s.life<=0){ p=s; break; } if(s.life<oldest){oldest=s.life; p=s;} }
  if (!p) return;
  p.life = 1; p.mesh.visible=true; p.mesh.position.set(x,y,z);
  p.mesh.material.color.setHex(tint!=null?tint:0xeef0f3);
  p.mesh.scale.setScalar(0.6 + Math.abs((x*7)%0.6));   // varied start size (no Math.random)
}
function updateSmoke(){
  if (!_smoke.length) return;
  for (const s of _smoke){
    if (s.life<=0) continue;
    s.life -= _adt*1.7;
    if (s.life<=0){ s.mesh.visible=false; continue; }
    const m=s.mesh;
    m.scale.setScalar(m.scale.x + _adt*5.5);            // billow outward
    m.position.y += _adt*1.6;                           // drift up
    m.material.opacity = Math.min(0.5, s.life*0.6);
    if (camera) m.quaternion.copy(camera.quaternion);   // billboard to camera
  }
}
function resetSmoke(){ for (const s of _smoke){ s.life=0; s.mesh.visible=false; } _smokeT=0; }
const _smPos=new THREE.Vector3();
// kick up tyre smoke (on tarmac) / dust (on grass) when sliding or cornering hard
function driftSmoke(f, speedFrac, steer, onGrass){
  const hard = onGrass ? speedFrac>0.22
                       : ((steer!==0 && speedFrac>0.55) || Math.abs(f.curv)*speedFrac>0.05);
  if (!hard) return;
  _smokeT -= _adt; if (_smokeT>0) return;
  _smokeT = 0.045;
  worldPos(G.dist, G.offset, _smPos);
  const back = 2.3*CAR_SCALE, sideD = 1.1*CAR_SCALE;
  for (const sx of [-1,1]){
    emitSmoke(_smPos.x - f.tan.x*back + f.right.x*sx*sideD,
              _smPos.y + 0.4,
              _smPos.z - f.tan.z*back + f.right.z*sx*sideD,
              onGrass?0x9a7b4f:0xeef0f3);
  }
}
let _flameT=0;
// orange exhaust flame puffs out the back while the nitro is firing
function emitBoostFlame(f){
  _flameT -= _adt; if (_flameT>0) return;
  _flameT = 0.025;
  worldPos(G.dist, G.offset, _smPos);
  const back=2.6*CAR_SCALE;
  for (const sx of [-0.45,0.45])
    emitSmoke(_smPos.x - f.tan.x*back + f.right.x*sx, _smPos.y+0.55, _smPos.z - f.tan.z*back + f.right.z*sx, Math.random()<0.5?0xff7a1a:0xffd23a);
}

// ---- championship (Grand Prix across all circuits, points by finish position) ----
function champStart(){ G.champ = { round:0, order:[0,1,2,3], points:[], names:[] }; }
function champScore(){
  const c=G.champ, N=1+rivals.length, PTS=[10,8,6,5,4,3,2,1];
  if (!c.points.length){ c.points=new Array(N).fill(0); c.names=['YOU'].concat(rivals.map(r=>r.name||'AI')); }
  const ent=[{i:0, prog:(G.lap-1)*trackLen+G.dist}];
  rivals.forEach((r,k)=>ent.push({i:k+1, prog:r.lap*trackLen+r.dist}));
  ent.sort((a,b)=>b.prog-a.prog);
  ent.forEach((e,p)=>{ c.points[e.i]+=(PTS[p]||0); });
}
function champNextRound(){
  G.champ.round++;
  if (G.champ.round < G.champ.order.length){ G.circuit = CIRCUITS[G.champ.order[G.champ.round]]; startRace(); }
  else showMenu();
}

function showEndScreen(win){
  const o=document.getElementById('overlay'); if(!o) return;
  const pos=computePosition(), total=1+rivals.length;
  const bl = G.bestLap>0 ? fmtTime(G.bestLap) : '—';
  const rec = G.recordSet ? `<div style="color:#ffd400;font-weight:900;margin-top:6px">🏆 NEW LAP RECORD!</div>` : '';
  let champHtml='', champBtn='';
  if (G.champ){
    const c=G.champ, last = c.round >= c.order.length-1;
    const ord=c.points.map((p,i)=>({i,p,name:c.names[i]||'AI'})).sort((a,b)=>b.p-a.p);
    const rows=ord.slice(0,8).map((e,k)=>`<div style="display:flex;justify-content:space-between;${e.i===0?'color:#2bd451;font-weight:900':''}"><span>${k+1}. ${e.name}</span><span>${e.p}</span></div>`).join('');
    champHtml = `<div style="text-align:left;font-size:13px;max-width:260px;margin:8px auto 4px"><b>GRAND PRIX — Round ${c.round+1}/${c.order.length}</b>${rows}</div>`;
    if (last) champHtml += `<div style="color:#ffd400;font-weight:900;margin-top:4px">🏆 CHAMPION: ${ord[0].name}</div>`;
    else champBtn = `<button class="btn" id="nextRaceBtn">NEXT RACE ▶</button><div style="height:8px"></div>`;
  }
  o.innerHTML = `<h1 class="title">${win?'<span class="red">FINISH</span>':'TIME UP'}</h1>
    <div class="menu-card">
      <h2>${win?'RACE COMPLETE':'OUT OF TIME'}</h2>
      <p style="font-size:14px">${G.circuit.name} — Position ${pos}/${total}<br>Total ${fmtTime(G.totalTime)} · Best lap ${bl}</p>
      <p style="font-size:13px;color:#ffae3a;margin:2px 0">Drift score ${Math.round(_sessionScore).toLocaleString()} &nbsp; <span style="color:#ffd400">+◆${(G.earned||0).toLocaleString()} CR</span></p>
      ${rec}${champHtml}
      <div style="height:8px"></div>
      ${champBtn}
      ${_replay.length?'<button class="btn ghost" id="replayBtn">▶ WATCH REPLAY</button><div style="height:8px"></div>':''}
      <button class="btn ghost" id="againBtn">RACE AGAIN ▶</button>
      <div style="height:8px"></div>
      <button class="btn ghost" id="menuBtn">MENU ✕</button>
    </div>`;
  o.classList.remove('hidden');
  const onc=(id,fn)=>{ const e=document.getElementById(id); if(e) e.onclick=fn; };
  onc('nextRaceBtn', champNextRound);
  onc('replayBtn', startReplay);
  onc('againBtn', ()=>startRace());
  onc('menuBtn', ()=>{ G.champ=null; showMenu(); });
}
// ----------------------------------------------------------------------------
//  Menu flow: title -> vehicle -> circuit -> soundtrack -> race
// ----------------------------------------------------------------------------
const SOUNDTRACKS = {
  daytona: { name:'DAYTONA', icon:'🏁', desc:'The original — big arcade theme', intro:'./audio/intro.mp3',      loop:'./audio/soundtrack.mp3' },
  heat:    { name:'HEAT',    icon:'🌆', desc:'Driving synth groove',           intro:'./audio/heat-intro.mp3', loop:'./audio/heat-soundtrack.mp3' },
  applemusic:{ name:'APPLE MUSIC', icon:'🍎', desc:'Stream from your library', apple:true },
};
let selApplePlaylist=null, selApplePlaylistName='';
const VEH_ICON = ['🏎️','🏁','⚡','🛞','🗡️'];
const CIR_ICON = ['🏔️','🎡','🌆','🏜️'];
let selVeh=0, selCir=1, selSnd='daytona', selTod='day', selWx='clear';
const TOD_ITEMS = [{key:'day',icon:'☀️',name:'DAY',desc:'Bright daylight racing'},
                   {key:'night',icon:'🌙',name:'NIGHT',desc:'Neon-lit night with stars'}];
const WX_ITEMS  = [{key:'clear',icon:'⛅',name:'CLEAR',desc:'Dry track, full grip'},
                   {key:'rain', icon:'🌧️',name:'RAIN', desc:'Wet, slippery & moody'}];

function overlayEl(){ return document.getElementById('overlay'); }
function showOverlay(html){
  clearTimeout(_idleTimer); _onTitle=false;                                          // leaving the title disarms attract
  const o=overlayEl(); o.innerHTML=html; o.classList.remove('hidden');
  const hud=document.getElementById('hud'); if(hud) hud.style.visibility='hidden';   // no stale HUD behind menus
  const vb=document.getElementById('viewBtn'); if(vb) vb.classList.add('hidden');     // no view toggle in menus
}

// ---- attract mode: after 5s idle on the title, run a cinematic AI demo lap ----
let _idleTimer=null, _onTitle=false, _attractSnd=0;
function armIdle(){ clearTimeout(_idleTimer); _idleTimer=setTimeout(()=>{ if(_onTitle && G.state==='menu') startAttract(); }, 5000); }
function userActivity(){ if (G.state==='attract'){ endAttract(); } else if (_onTitle){ armIdle(); } }
function startAttract(){
  clearTimeout(_idleTimer);
  // randomise the showcase: circuit, car, time-of-day, weather; cycle soundtrack
  G.circuit = CIRCUITS[(Math.random()*CIRCUITS.length)|0];
  G.vehicle = VEHICLES[(Math.random()*VEHICLES.length)|0];
  G.night = Math.random()<0.5; G.rain = Math.random()<0.4;
  const snds=['daytona','heat']; G.soundtrack = snds[_attractSnd++ % snds.length]; G.applePlaylist=null;
  try {
    buildTrack(G.circuit); buildSky(); buildEnv(); buildRoadMesh(); buildMinimap();
    try{ buildScenery(); }catch(e){} boostBloomEmissive();
    if (playerCar) scene.remove(playerCar);
    playerCar = buildCar(G.vehicle); scene.add(playerCar);
    buildRivals(MOBILE ? 7 : 9);
    G.maxSpeed = G.circuit.maxSpeed * G.vehicle.speedMul * 0.58;
    G.dist=0; G.offset=0; G.speed=G.maxSpeed*0.55; G.lap=1; G.steerVis=0; G.attractLap=0;
    initSmoke(); resetSmoke();
    placeCar(playerCar,G.dist,G.offset); placeRivals();
    G.started=true; G.view='cinematic'; cineReset(); G.state='attract';
    hideOverlay();
    const hud=document.getElementById('hud'); if(hud) hud.style.visibility='hidden';
    ['viewBtn','pauseBtn'].forEach(id=>{ const e=document.getElementById(id); if(e){ if(id==='viewBtn')e.classList.add('hidden'); else e.style.display='none'; }});
    const t=document.getElementById('touch'); if(t) t.style.display='none';
    showBanner('DAYTONA <span class="red">USA</span><br><span style="font-size:0.46em;letter-spacing:2px">▶ TAP TO PLAY</span>', 0, true);
    startRaceMusic();
  } catch(e){ endAttract(); }
}
function attractUpdate(dt){
  const f=frameAt(G.dist), maxSpeed=G.maxSpeed;
  const fi=((Math.floor((G.dist/trackLen)*DIV))%DIV+DIV)%DIV;
  let curveAhead=0; for(let k=8;k<=70;k+=12) curveAhead=Math.max(curveAhead, Math.abs(frames[(fi+k)%DIV].curv));
  const target = maxSpeed*(0.95 - Math.min(0.45, curveAhead*16));
  G.speed += (target - G.speed)*1.3*dt;
  const laneTarget = Math.max(-ROAD_W*0.6, Math.min(ROAD_W*0.6, -f.curv*170));   // hug the inside of corners
  G.offset += (laneTarget - G.offset)*1.0*dt;
  G.steerVis += ((laneTarget-G.offset>0?0.4:-0.4) - G.steerVis)*0.08;
  G.dist += G.speed*dt;
  if (G.dist >= trackLen){ G.dist -= trackLen; if((++G.attractLap)>=1){ endAttract(); return; } }
  updateRivals(dt);
  if (_smokeGroup) driftSmoke(f, Math.min(1,G.speed/maxSpeed), 0, false);
  if (window.GameMusic && window.GameMusic.setIntensity) window.GameMusic.setIntensity(Math.min(1,G.speed/maxSpeed));
}
function endAttract(){
  hideBanner();
  const pb=document.getElementById('pauseBtn'); if(pb) pb.style.display='';
  showMenu();
}

function showMenu(){
  G.state='menu'; G.started=false;
  stopRaceMusic();
  if (window.AppleMusic && window.AppleMusic.isPlaying()) window.AppleMusic.pause();   // hush the user's music in menus
  if (window.GameMusic){ try{ window.GameMusic.start && window.GameMusic.start(); window.GameMusic.setMode && window.GameMusic.setMode('menu'); }catch(e){} }
  showOverlay(`<h1 class="title">DAYTONA <span class="red">USA</span></h1>
    <div class="subtitle">3D POLYGON EDITION</div>
    <div class="subtitle" style="margin:2px 0 10px;color:#ffd400;font-size:14px">◆ ${_profile.credits.toLocaleString()} CR &nbsp;·&nbsp; ${_profile.races} races &nbsp;·&nbsp; ${_profile.wins} wins</div>
    <div class="menu-card">
      <h2>MERCEDES CIRCUIT RACING</h2>
      <p style="font-size:13px;opacity:.85;margin:0 0 14px">Pick your car, circuit, time, weather & soundtrack. ${BUILD}</p>
      <button class="btn" id="startBtn">SINGLE RACE ▶</button>
      <div style="height:8px"></div>
      <button class="btn ghost" id="gpBtn">🏆 GRAND PRIX</button>
    </div>
    <div class="credit">Fan-made, non-commercial.</div>`);
  document.getElementById('startBtn').onclick = ()=>{ try{ensureAudio();}catch(e){} G.champ=null; showVehicleSelect(); };
  document.getElementById('gpBtn').onclick    = ()=>{ try{ensureAudio();}catch(e){} champStart(); showVehicleSelect(); };
  _onTitle=true; armIdle();                       // start the inactivity countdown to attract mode
}

function cardRow(items, selIdx, dataAttr){
  return `<div class="cards">` + items.map((it,i)=>
    `<button class="selcard ${i===selIdx?'sel':''}" ${dataAttr}="${i}">
      <div class="cardicon">${it.icon}</div>
      <div class="cardname">${it.name}</div>
      <div class="carddesc">${it.desc}</div>
    </button>`).join('') + `</div>`;
}

function showVehicleSelect(){
  const items = VEHICLES.map((v,i)=>({icon:VEH_ICON[i], name:v.name.replace('MERCEDES ',''), desc:v.desc}));
  showOverlay(`<h1 class="title">SELECT <span class="red">CAR</span></h1>
    ${cardRow(items, selVeh, 'data-veh')}
    <div class="menu-card"><div class="navrow">
      <button class="btn ghost" id="backBtn">◀ BACK</button>
      <button class="btn" id="nextBtn">NEXT ▶</button>
    </div></div>`);
  wireCards('data-veh', i=>{ selVeh=i; showVehicleSelect(); });
  document.getElementById('backBtn').onclick=showMenu;
  document.getElementById('nextBtn').onclick = G.champ ? showSoundtrackSelect : showCircuitSelect;   // GP skips circuit pick
}

function showCircuitSelect(){
  const items = CIRCUITS.map((c,i)=>({icon:CIR_ICON[i], name:c.name, desc:`${c.laps} laps · top ${c.maxSpeed}`}));
  showOverlay(`<h1 class="title">SELECT <span class="red">CIRCUIT</span></h1>
    ${cardRow(items, selCir, 'data-cir')}
    <div class="menu-card"><div class="navrow">
      <button class="btn ghost" id="backBtn">◀ BACK</button>
      <button class="btn" id="startBtn2">NEXT ▶</button>
    </div></div>`);
  wireCards('data-cir', i=>{ selCir=i; showCircuitSelect(); });
  document.getElementById('backBtn').onclick=showVehicleSelect;
  document.getElementById('startBtn2').onclick=showSoundtrackSelect;
}

function showSoundtrackSelect(){
  const keys=Object.keys(SOUNDTRACKS);
  const items = keys.map(k=>({icon:SOUNDTRACKS[k].icon, name:SOUNDTRACKS[k].name, desc:SOUNDTRACKS[k].desc}));
  const selIdx = keys.indexOf(selSnd);
  const todIdx = TOD_ITEMS.findIndex(t=>t.key===selTod);
  const wxIdx  = WX_ITEMS.findIndex(t=>t.key===selWx);
  showOverlay(`<h1 class="title">SELECT <span class="red">SOUNDTRACK</span></h1>
    ${cardRow(items, selIdx, 'data-snd')}
    <div class="subtitle" style="margin:4px 0 4px">TIME OF DAY</div>
    ${cardRow(TOD_ITEMS, todIdx, 'data-tod')}
    <div class="subtitle" style="margin:4px 0 4px">WEATHER</div>
    ${cardRow(WX_ITEMS, wxIdx, 'data-wx')}
    <div class="menu-card"><div class="navrow">
      <button class="btn ghost" id="backBtn">◀ BACK</button>
      <button class="btn" id="goBtn">GREEN FLAG ▶</button>
    </div></div>`);
  wireCards('data-snd', i=>{ selSnd=keys[i]; if (selSnd==='applemusic') showAppleMusic(); else showSoundtrackSelect(); });
  wireCards('data-tod', i=>{ selTod=TOD_ITEMS[i].key; showSoundtrackSelect(); });
  wireCards('data-wx',  i=>{ selWx=WX_ITEMS[i].key; showSoundtrackSelect(); });
  document.getElementById('backBtn').onclick = G.champ ? showVehicleSelect : showCircuitSelect;
  document.getElementById('goBtn').onclick=()=>{
    G.vehicle=VEHICLES[selVeh]; G.soundtrack=selSnd; G.applePlaylist=selApplePlaylist;
    G.circuit = G.champ ? CIRCUITS[G.champ.order[G.champ.round]] : CIRCUITS[selCir];
    G.night=(selTod==='night'); G.rain=(selWx==='rain');
    startRace();
  };
}

// ---- Apple Music connect / playlist picker ----
function showAppleMusic(){
  const AM = window.AppleMusic;
  let body;
  if (!AM){
    body = `<p style="font-size:13px">Apple Music support didn't load.</p>`;
  } else if (!AM.hasToken()){
    body = `<p style="font-size:13px;line-height:1.4">To play your own Apple Music you need a <b>MusicKit developer token</b> (a JWT from your Apple Developer account). It's saved only on this device.</p>
      <textarea id="amTok" rows="3" placeholder="Paste developer token (eyJ...)" style="width:92%;border-radius:8px;padding:8px;font-size:12px;font-family:monospace"></textarea>
      <div style="height:8px"></div><button class="btn" id="amSave">SAVE TOKEN</button>
      <p style="font-size:11px;opacity:.7;margin-top:10px">Get one at developer.apple.com → Certificates, IDs &amp; Profiles → Keys → enable MusicKit → then generate a signed JWT (ES256).</p>`;
  } else if (!AM.authorized){
    body = `<p style="font-size:13px">Sign in with your Apple Music subscription to play your library.</p>
      <button class="btn" id="amConnect">CONNECT APPLE MUSIC</button>
      <div style="height:8px"></div><button class="btn ghost" id="amClear" style="font-size:12px">Change token</button>`;
  } else {
    body = `<p style="font-size:13px;color:#2bd451">✓ Connected. Pick a playlist:</p><div id="amList" style="max-height:38vh;overflow:auto">Loading your playlists…</div>`;
  }
  showOverlay(`<h1 class="title">🍎 APPLE <span class="red">MUSIC</span></h1>
    <div class="menu-card">${body}
      <div style="height:12px"></div>
      <button class="btn ghost" id="amBack">◀ BACK</button>
    </div>`);
  const onc=(id,fn)=>{ const e=document.getElementById(id); if(e) e.onclick=fn; };
  onc('amBack', showSoundtrackSelect);
  onc('amSave', ()=>{ const t=document.getElementById('amTok').value; if(t&&t.trim().length>20){ AM.setDevToken(t); } showAppleMusic(); });
  onc('amClear', ()=>{ AM.setDevToken(''); showAppleMusic(); });
  onc('amConnect', async ()=>{
    const btn=document.getElementById('amConnect'); if(btn) btn.textContent='CONNECTING…';
    const res = await AM.connect();
    if (res.ok) showAppleMusic();
    else { if(btn) btn.textContent='CONNECT APPLE MUSIC'; alert(res.reason==='nosdk'?'Apple Music SDK not loaded — check your connection.':res.reason==='notoken'?'Developer token is missing or invalid.':'Apple Music sign-in was cancelled.'); }
  });
  if (AM && AM.authorized){
    AM.playlists().then(list=>{
      const el=document.getElementById('amList'); if(!el) return;
      if (!list.length){ el.innerHTML='<p style="font-size:12px;opacity:.8">No library playlists found. Add some in Apple Music, or pick again.</p>'; return; }
      el.innerHTML = list.map(p=>`<button class="btn ghost amPL" data-amid="${p.id}" data-amname="${(p.name||'').replace(/"/g,'&quot;')}" style="display:block;width:100%;text-align:left;margin:4px 0;font-size:13px">▶ ${p.name}</button>`).join('');
      el.querySelectorAll('.amPL').forEach(b=>{ b.onclick=()=>{
        selSnd='applemusic'; selApplePlaylist=b.getAttribute('data-amid'); selApplePlaylistName=b.getAttribute('data-amname');
        showSoundtrackSelect();
      };});
    });
  }
}

function wireCards(attr, cb){
  document.querySelectorAll(`[${attr}]`).forEach(el=>{
    el.onclick=()=>cb(parseInt(el.getAttribute(attr),10));
  });
}

function setText(id, t){ const el=document.getElementById(id); if(el) el.textContent=t; }
function hideOverlay(){
  const o=document.getElementById('overlay'); if(o) o.classList.add('hidden');
  const hud=document.getElementById('hud'); if(hud) hud.style.visibility='visible';
}
function showTouch(){ const t=document.getElementById('touch'); if(t && MOBILE) t.style.display='block'; }

// ----------------------------------------------------------------------------
//  Resize + loop
// ----------------------------------------------------------------------------
function resize(){
  const w=window.innerWidth, h=window.innerHeight;
  camera.aspect=w/h; camera.updateProjectionMatrix();
  const pr=Math.min(3, window.devicePixelRatio||1);
  renderer.setPixelRatio(pr); renderer.setSize(w,h,false);
  const hpr=Math.min(3, window.devicePixelRatio||1);
  hud2d.width=Math.round(w*hpr); hud2d.height=Math.round(h*hpr);
  hud2d.style.width=w+'px'; hud2d.style.height=h+'px';
}

let last=performance.now(), acc=0;
function frame(now){
  let dt=(now-last)/1000; if(dt>0.1)dt=0.1; last=now; acc+=dt;
  _adt = dt;
  pollGamepad();
  while (acc>=STEP){ update(STEP); acc-=STEP; }
  updateEngine();
  if (scene && camera) render();
  requestAnimationFrame(frame);
}

// ----------------------------------------------------------------------------
//  Boot
// ----------------------------------------------------------------------------
function togglePause(){
  if (G.state==='replay'){ exitReplay(); return; }
  if (G.state==='racing'){ G.state='paused'; pauseRaceMusic(true); showBanner('PAUSED', 0); }
  else if (G.state==='paused'){ G.state='racing'; pauseRaceMusic(false); hideBanner(); }
}
window.__togglePause = togglePause;

const VIEW_ORDER = ['chase','cockpit','dash'];
const REPLAY_VIEW_ORDER = ['cinematic','chase','cockpit','dash'];
const VIEW_LABEL = { chase:'👁 CHASE VIEW', cockpit:'👁 COCKPIT VIEW', dash:'👁 DASHBOARD VIEW', cinematic:'🎬 CINEMATIC' };
function updateViewBtn(){
  const b=document.getElementById('viewBtn'); if(!b) return;
  b.innerHTML = VIEW_LABEL[G.view] || VIEW_LABEL.chase;
}
function setView(v){ G.view=v; updateViewBtn(); }
function toggleView(){
  const order = (G.state==='replay') ? REPLAY_VIEW_ORDER : VIEW_ORDER;
  const i=order.indexOf(G.view); setView(order[(i+1)%order.length]);
}
window.__toggleView = toggleView;

function boot(){
  loadRecords(); loadGhosts(); loadProfile();
  initThree();
  bindInput();
  const pb=document.getElementById('pauseBtn'); if(pb) pb.onclick=togglePause;
  const vb=document.getElementById('viewBtn'); if(vb) vb.onclick=toggleView;
  // any input resets the idle timer on the title, or drops out of the attract demo
  ['pointerdown','keydown','touchstart'].forEach(ev=>window.addEventListener(ev, userActivity, {passive:true}));
  showMenu();
  requestAnimationFrame(frame);
}
function ensureAudio(){
  if (window.GameMusic && !window.__audioStarted){
    const AC = new (window.AudioContext||window.webkitAudioContext)();
    window.GameMusic.init(AC); window.GameMusic.start(); window.__audioStarted=true;
  }
}

boot();

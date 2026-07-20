// ============================================================================
//  APEX GP — arcade circuit racer  (formerly Daytona USA 3D)
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

const BUILD = 'BUILD R93 — drawn cabins';

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
// DUBAI — a Sheikh-Zayed-Road mega straight blasting past the supertalls,
// long 8th-gear sweepers, then tightening marina esses on the way home.
const DUBAI_LAYOUT = [
  [0,0,-280],[170,0,-280],[340,0,-280],
  [455,0,-160],[480,0,10],[400,0,160],
  [240,0,215],[80,0,290],[-110,0,320],
  [-300,0,255],[-430,0,110],[-450,0,-70],
  [-330,0,-230],[-165,0,-280],
];
// NEW YORK — a Manhattan street circuit: avenue straights and hard right-angle
// blocks, kinking through the park section before the run back downtown.
const NY_LAYOUT = [
  [0,0,-210],[130,0,-210],[260,0,-210],
  [290,0,-100],[290,0,30],
  [190,0,70],[180,0,180],[60,0,210],
  [-80,0,150],[-210,0,170],[-290,0,80],
  [-290,0,-70],[-180,0,-120],[-120,0,-210],
];
const CANYON_LAYOUT = [
  [0,0,-230],[150,0,-250],[290,0,-170],[340,0,-40],
  [300,0,90],[200,0,170],[70,0,150],[-40,0,210],
  [-180,0,250],[-310,0,150],[-350,0,0],[-300,0,-140],[-170,0,-250],
];
const CIRCUITS = [
  { name:'NEW YORK', laps:6, maxSpeed:122, curveMul:1.0, aiSpeed:0.78, startTime:62, lapBonus:30, seed:7, theme:0, layout:NY_LAYOUT },
  { name:'LONDON',  laps:6, maxSpeed:120, curveMul:1.0,  aiSpeed:0.78, startTime:62, lapBonus:30, seed:11, theme:3, layout:LONDON_LAYOUT },
  { name:'DUBAI',   laps:6, maxSpeed:136, curveMul:1.0,  aiSpeed:0.82, startTime:66, lapBonus:30, seed:23, theme:4, layout:DUBAI_LAYOUT },
  { name:'CANYON',  laps:6, maxSpeed:128, curveMul:1.05, aiSpeed:0.80, startTime:64, lapBonus:30, seed:37, theme:1, layout:CANYON_LAYOUT },
];
const THEMES = [
  // [0] NEW YORK — steel-blue Manhattan: park trees, brownstones, supertalls
  { asphalt:0x7c8086, grass:0x4e8f4c, grass2:0x417f40, mountain:0x8a9099, snow:false,
    prop:'tree', skyline:'city', landmark:'nyc', buildings:true,
    skyTop:'#2f6fc0', skyMid:'#7fb0e8', skyHorizon:'#e8f0fa', fog:0xcfdcea },
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
  { name:'V-CLASS', kind:'van', color:0x0d0f13,
    livery:{ body:0x0d0f13, hood:0x0d0f13, roof:0x0d0f13, num:0, sponsor:'V-CLASS' },
    speedMul:0.96, accelMul:0.92, steerMul:0.9, gripMul:1.08, brakeMul:1.06, rollMul:1.3,
    desc:'The black executive Mercedes MPV — heavy, planted, deceptively rapid.' },
  { name:'S-CLASS', kind:'sedan', color:0x0b0d11,
    livery:{ body:0x0b0d11, hood:0x0b0d11, roof:0x0b0d11, num:0, sponsor:'S-CLASS' },
    speedMul:1.16, accelMul:1.10, steerMul:1.02, gripMul:1.10, brakeMul:1.14, rollMul:1.0,
    desc:'The 537hp flagship limousine — serene comfort, massive pace.' },
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

// debug/showroom camera pose (?pose=rear|front|side) — fixed close-up of the
// player's car so body details can be checked against reference photos.
const _POSE = (typeof location!=='undefined' && /[?&]pose=(\w+)/.exec(location.search)||[])[1]||'';

let renderer, scene, camera, sun, sky, hemiLight, ambLight;
let _GPU=false, _post=null;   // WebGPU renderer + its post-processing (bloom) pipeline
// Granular WebGPU-only material switches (kept off — WebGPU node materials
// choke on them). The same upgrades DO work in classic WebGL, so the desktop
// "max" tier (_HI) enables them there. _MAT* = "on for desktop OR (a working)
// WebGPU group". Set in initThree once the renderer/device is known.
let _GPU_PAINT=false, _GPU_EMIS=false, _GPU_HIRES=false, _GPU_NORMAL=false;
let _HI=false, _MATFX=false, _MATHIRES=false, _MATNORMAL=false, _MATEMIS=false;
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
  gear: 1, rpm: 0.3, shiftCut: 0,         // GT-style drivetrain (5-speed auto + shift kick)
  drift: 0, driftVis: 0, pitchVis: 0,     // Daytona powerslide state + weight-transfer visuals
  lap: 1, maxSpeed: 120, view: 'chase',   // chase | cockpit
  // race timing / scoring
  timeLeft: 0, totalTime: 0, rollT: 0, cdNum: -1, green: false,
  banner: 0,
  boost: 1, boostActive: false,           // nitro meter (0..1) and whether it's firing
  lapStart: 0, bestLap: 0, night: false, sunset: false,  // lap timing + best-lap record + time of day
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
let _sessionScore=0, _driftActive=0, _driftCombo=1, _driftRun=0;
let _draftT=0, _draftCalled=false;   // slipstream draft timer + one-shot callout
let _skidGroup=null, _skids=[], _skidIdx=0, _lastSkidDist=-9;   // persistent tyre-mark pool
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
  // All WebGPU-only material experiments OFF — they blank this device's WebGPU
  // (anisotropy needs geometry tangents the extruded body lacks; normal maps on
  // Lambert don't compile). WebGPU keeps the proven materials + the bloom pass.
  _GPU_PAINT=false; _GPU_EMIS=false; _GPU_HIRES=false; _GPU_NORMAL=false;
  _HI = !MOBILE;   // desktop/Mac "max" tier — these material upgrades are WebGL-safe
  _MATFX=_HI||_GPU_PAINT; _MATHIRES=_HI||_GPU_HIRES; _MATNORMAL=_HI||_GPU_NORMAL; _MATEMIS=_HI||_GPU_EMIS;
  // Mobile: skip MSAA — at full 3x density the supersampling antialiases edges
  // for free, and MSAA buffers at that resolution risk GPU memory / context loss.
  if (_GPU){
    renderer = new THREE.WebGPURenderer({ canvas:glCanvas, antialias:!MOBILE });
  } else {
    renderer = new THREE.WebGLRenderer({ canvas:glCanvas, antialias:!MOBILE, powerPreference:'high-performance' });
  }
  // render at the device's native pixel density (capped at 3x) for max sharpness.
  // Desktop "max" tier supersamples 1.5x above native (capped at 3x) — true SSAA,
  // the single biggest image-quality win: razor-clean edges + crisp distant textures.
  {
    const dpr = window.devicePixelRatio||1;
    renderer.setPixelRatio(MOBILE ? Math.min(3, dpr) : Math.min(3, dpr*1.5));
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  renderer.shadowMap.enabled = true;                 // real-time shadows on mobile too (pushed)
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  _maxAniso = (renderer.capabilities && renderer.capabilities.getMaxAnisotropy) ? renderer.capabilities.getMaxAnisotropy() : 8;
  if (_GPU){ try{ setupWebGPU(); }catch(e){ console.warn('WebGPU post-fx setup failed', e); } }
  // WebGPU blank-frame watchdog: some browsers (macOS Safari) expose WebGPU and
  // initialise cleanly, yet silently present a solid WHITE frame — the import
  // self-heal never fires because nothing threw. So a few seconds in we read the
  // canvas back: the sky gradient should never be uniform. A uniform BRIGHT frame
  // means the renderer is broken → reload without the flag onto proven WebGL.
  // (Uniform DARK is left alone: an unsupported drawImage reads back as blank
  // black, and we must not kick working setups off WebGPU.)
  if (_GPU && window.__WEBGPU_REQUESTED){
    const checkBlank=()=>{ try{
      const w=48,h=48, cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      const x=cv.getContext('2d'); x.drawImage(glCanvas,0,0,w,h);
      const d=x.getImageData(0,0,w,h).data;
      let mn=255,mx=0;
      for (let i=0;i<d.length;i+=4){ const l=(d[i]+d[i+1]+d[i+2])/3; if(l<mn)mn=l; if(l>mx)mx=l; }
      const uniform = (mx-mn<6 && mn>80);   // any uniform LIGHT frame = only the clear
      if (!uniform) return;                 // colour drew; the sky gradient never is.
      if (_post){                           // stage 1: maybe only the bloom pass broke —
        _post=null;                         // drop post-fx and give raw WebGPU a chance
        console.warn('WebGPU blank frame — post-fx disabled, rechecking');
        setTimeout(checkBlank, 4000); return;
      }
      console.warn('WebGPU still blank — falling back to WebGL');
      location.replace(location.pathname);  // stage 2: back to the proven renderer
    }catch(e){} };
    setTimeout(checkBlank, 5000); setTimeout(checkBlank, 14000);
  }

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
    const SM = MOBILE?1536:6144;                     // ultra-crisp 6K shadows on the desktop tier
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
  // night: dark starry blue · sunset: golden-hour gradient · day: the theme's sky
  const top   = G.night ? '#04050d' : (G.sunset ? '#232a5c' : th.skyTop);
  const mid   = G.night ? '#0a1226' : (G.sunset ? '#c65a5e' : th.skyMid);
  const horiz = G.night ? '#162038' : (G.sunset ? '#ffce8a' : th.skyHorizon);
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
    _sunOff.set(55,120,35);
    if (hemiLight){ hemiLight.intensity=0.28; hemiLight.color.setHex(0x6072a0); hemiLight.groundColor.setHex(0x161c2a); }
    if (ambLight) ambLight.intensity=0.22;
    renderer.toneMappingExposure=1.12;
  } else if (G.sunset){
    // golden hour: low, warm-orange key light with a pink/violet sky fill.
    // The sun offset drops near the horizon so everything throws long shadows.
    sun.color.setHex(0xffa050); sun.intensity=1.75;
    _sunOff.set(150,42,60);
    if (hemiLight){ hemiLight.intensity=0.42; hemiLight.color.setHex(0xe8909a); hemiLight.groundColor.setHex(0x4a3a32); }
    if (ambLight) ambLight.intensity=0.26;
    renderer.toneMappingExposure=1.04;
  } else {
    sun.color.setHex(0xfff0c4); sun.intensity=2.0;
    _sunOff.set(55,120,35);
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
  } else if (G.sunset){   // a huge molten-orange setting sun
    g.addColorStop(0,'rgba(255,238,205,1)'); g.addColorStop(0.14,'rgba(255,190,110,0.95)');
    g.addColorStop(0.4,'rgba(255,130,70,0.4)'); g.addColorStop(0.7,'rgba(255,100,80,0.12)'); g.addColorStop(1,'rgba(255,100,80,0)');
  } else {
    g.addColorStop(0,'rgba(255,252,242,1)'); g.addColorStop(0.16,'rgba(255,246,212,0.95)');
    g.addColorStop(0.42,'rgba(255,226,150,0.35)'); g.addColorStop(0.7,'rgba(255,210,140,0.10)'); g.addColorStop(1,'rgba(255,210,140,0)');
  }
  x.fillStyle=g; x.fillRect(0,0,128,128);
  const tex=new THREE.CanvasTexture(cv); tex.colorSpace=THREE.SRGBColorSpace;
  const m=new THREE.MeshBasicMaterial({map:tex, transparent:true, depthWrite:false, fog:false, blending:THREE.AdditiveBlending});
  const sd=G.night?420:(G.sunset?1150:820);
  _sunSprite=new THREE.Mesh(new THREE.PlaneGeometry(sd,sd), m);
  _sunSprite.position.copy(sun.position).normalize();
  if (G.sunset) _sunSprite.position.y=0.10;               // setting sun hugs the horizon
  _sunSprite.position.normalize().multiplyScalar(3100);
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
    const th=G.theme, W=_HI?1024:256, H=_HI?512:128;
    const cv=document.createElement('canvas'); cv.width=W; cv.height=H; const x=cv.getContext('2d');
    const sky = x.createLinearGradient(0,0,0,H);
    if (G.night){ sky.addColorStop(0,'#04060f'); sky.addColorStop(0.45,'#0a1226'); sky.addColorStop(0.6,'#172238'); }
    else if (G.sunset){ sky.addColorStop(0,'#232a5c'); sky.addColorStop(0.45,'#c65a5e'); sky.addColorStop(0.6,'#ffce8a'); }
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
    } else if (G.sunset){
      // huge low sun sitting on the horizon line for molten paint reflections
      const sg=x.createRadialGradient(W*0.74,H*0.56,2,W*0.74,H*0.56,64); sg.addColorStop(0,'rgba(255,232,190,1)'); sg.addColorStop(0.3,'rgba(255,170,90,0.8)'); sg.addColorStop(1,'rgba(255,140,80,0)');
      x.fillStyle=sg; x.fillRect(W*0.74-70,H*0.44,140,H*0.24);
    } else {
      const sg=x.createRadialGradient(W*0.74,H*0.22,2,W*0.74,H*0.22,40); sg.addColorStop(0,'rgba(255,252,238,1)'); sg.addColorStop(0.3,'rgba(255,246,210,0.7)'); sg.addColorStop(1,'rgba(255,246,210,0)');
      x.fillStyle=sg; x.fillRect(W*0.74-44,0,88,80);
    }
    // reflective ground with subtle streaks (gives the paint a road reflection)
    const gnd=x.createLinearGradient(0,H*0.62,0,H); gnd.addColorStop(0, G.night?'#0c0f16':(G.sunset?'#43322a':'#3b4a39')); gnd.addColorStop(1, G.night?'#05060a':(G.sunset?'#1c1410':'#222a1c'));
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
function boostBloomEmissive(){ if(!_MATEMIS) return; for (const p of _pulse){ p.base*=2.4; if(p.mat) p.mat.emissiveIntensity=p.base; } }

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
    const tex=makeAsphaltTex(_HI?1024:256, _HI?2048:512); tex.repeat.set(5, 1);
    // In the rain the asphalt turns into a glossy mirror: a Standard material with
    // the sky environment map and near-zero roughness so the wet surface reflects
    // the sky / sunset / neon. Dry stays Lambert (cheap, matte).
    const rmat = G.rain
      ? new THREE.MeshStandardMaterial({map:tex, color:0x33383f, side:THREE.DoubleSide, metalness:0.14, roughness:0.16, envMap:envTex, envMapIntensity:G.night?1.8:1.35})
      : new THREE.MeshLambertMaterial({map:tex, color:0x595c61, side:THREE.DoubleSide});
    if (_MATNORMAL){ try{ const n=heightToNormal(_asphaltCanvas, G.rain?2:4); n.repeat.set(5,1); rmat.normalMap=n; rmat.normalScale=new THREE.Vector2(G.rain?0.4:0.9,G.rain?0.4:0.9); }catch(e){ rmat.bumpMap=tex; rmat.bumpScale=0.6; } }
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
    const gs=_HI?1024:256; const tex=surfTex(th.grass, th.grass2, gs, gs, _HI?9000:2600); tex.repeat.set(3, 1);
    const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map:tex, side:THREE.DoubleSide, bumpMap:tex, bumpScale:0.3}));
    mesh.receiveShadow=true; scene.add(mesh); roadParts.push(mesh);
  }
  // kerbs + start/finish checker (vertex colours)
  {
    const pos=[],col=[],nor=[],uv=[]; const c=new THREE.Color();
    const vert=(p,n,u,v)=>{ pos.push(p.x,p.y,p.z); col.push(c.r,c.g,c.b); nor.push(n.x,n.y,n.z); uv.push(u,v); };
    const ribbon=(latIn,latOut,lift,colorFn)=>{
      for (let i=0;i<DIV;i++){
        const a=frames[i], b=frames[(i+1)%DIV];
        pt(ia,a,latIn,lift); pt(oa,a,latOut,lift); pt(ib,b,latIn,lift); pt(ob,b,latOut,lift);
        colorFn(i,c);
        const v0=i*0.45, v1=(i+1)*0.45;
        vert(ia,a.up,0,v0); vert(ib,b.up,0,v1); vert(ob,b.up,1,v1); vert(ia,a.up,0,v0); vert(ob,b.up,1,v1); vert(oa,a.up,1,v0);
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
        const v0=i*0.45, v1=(i+1)*0.45;
        vert(ia,a.up,0,v0); vert(ib,b.up,0,v1); vert(ob,b.up,1,v1); vert(ia,a.up,0,v0); vert(ob,b.up,1,v1); vert(oa,a.up,1,v0);
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
        const v0=i*0.45, v1=(i+1)*0.45, u0=s/NB, u1=(s+1)/NB;
        vert(ia,a.up,u0,v0); vert(ib,b.up,u0,v1); vert(ob,b.up,u1,v1); vert(ia,a.up,u0,v0); vert(ob,b.up,u1,v1); vert(oa,a.up,u1,v0);
      }
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    geo.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
    geo.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    // grime tile multiplies the painted vertex colours; its bump gives the
    // kerbs/markings a worn, ridged surface instead of flat shading
    const grime=makeGrimeTex();
    const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({vertexColors:true, side:THREE.DoubleSide, map:grime, bumpMap:grime, bumpScale:0.5}));
    mesh.receiveShadow=true; scene.add(mesh); roadParts.push(mesh);
  }
  // night: sodium lampposts lining the verge — emissive head, an additive glow
  // cross, and (desktop) a warm light pool on the tarmac. Individual meshes so
  // clearRoad() can dispose them; materials shared per build.
  if (G.night){
    const nLamp = MOBILE?12:28;
    const poleMat=new THREE.MeshLambertMaterial({color:0x1a1d24});
    const headMat=new THREE.MeshStandardMaterial({color:0xffd9a0, emissive:0xffb85c, emissiveIntensity:2.6, roughness:0.5});
    const glowM=new THREE.MeshBasicMaterial({map:glowTex(0xffc987), transparent:true, opacity:0.75, depthWrite:false, blending:THREE.AdditiveBlending, fog:false, side:THREE.DoubleSide});
    const poolM=new THREE.MeshBasicMaterial({map:glowTex(0xffc37a), transparent:true, opacity:0.16, depthWrite:false, blending:THREE.AdditiveBlending, fog:false});
    const poleGeo=new THREE.CylinderGeometry(0.09,0.13,7.4,6);
    const headGeo=new THREE.BoxGeometry(1.15,0.24,0.42);
    const glowGeo=new THREE.PlaneGeometry(2.6,2.6);
    const poolGeo=new THREE.PlaneGeometry(11,8);
    const add=m=>{ m.userData.noShadow=true; scene.add(m); roadParts.push(m); };
    for (let k=0;k<nLamp;k++){
      const f=frames[Math.floor(k/nLamp*frames.length)%frames.length];
      const side=(k%2===0)?1:-1, lat=side*(ROAD_W+RUMBLE_W+1.6);
      const bx=f.pos.x+f.right.x*lat, by=f.pos.y, bz=f.pos.z+f.right.z*lat;
      const pole=new THREE.Mesh(poleGeo,poleMat); pole.position.set(bx,by+3.7,bz); add(pole);
      // head cantilevered back over the road
      const hx=bx-f.right.x*side*1.1, hz=bz-f.right.z*side*1.1;
      const head=new THREE.Mesh(headGeo,headMat); head.position.set(hx,by+7.3,hz);
      head.lookAt(hx+f.tan.x,by+7.3,hz+f.tan.z); add(head);
      for (const ry of [0,Math.PI/2]){ const q=new THREE.Mesh(glowGeo,glowM);
        q.position.set(hx,by+7.2,hz); q.rotation.y=ry+Math.atan2(f.tan.x,f.tan.z); add(q); }
      if (!MOBILE){ const p=new THREE.Mesh(poolGeo,poolM);
        p.position.set(hx,by+0.09,hz); p.rotation.x=-Math.PI/2; p.rotation.z=Math.atan2(f.tan.x,f.tan.z); add(p); }
    }
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
    const m=new THREE.MeshPhysicalMaterial({color:c, metalness:0.55, roughness:0.30, clearcoat:1.0, clearcoatRoughness:0.05, envMap:envTex, envMapIntensity:_MATFX?2.5:1.8});
    m.clearcoatNormalMap=flakeNormalTex(); m.clearcoatNormalScale=new THREE.Vector2(0.16,0.16);
    m.roughnessMap=detailClone('rough',6);   // visible metallic-flake clusters in the sheen
    if (_MATFX){ try{ m.iridescence=0.22; m.iridescenceIOR=1.3; m.clearcoatRoughness=0.03;
      if (_HI){ m.anisotropy=0.5; m.anisotropyRotation=Math.PI*0.25; } }catch(e){} }   // ultra-real anisotropic flake (desktop)
    return m;
  }
  const m=new THREE.MeshStandardMaterial({color:c, metalness:0.42, roughness:0.34, envMap:envTex, envMapIntensity:_MATFX?1.6:1.25});
  m.roughnessMap=detailClone('rough',6);
  return m;
}
function matteMat(c){ const m=new THREE.MeshStandardMaterial({color:c, metalness:0, roughness:0.85}); const t=detailClone('rough',3); m.map=t;
  if (_MATNORMAL){ const n=detailNormal('rough',3); if(n){ m.normalMap=n; m.normalScale=new THREE.Vector2(0.6,0.6); } else { m.bumpMap=t; m.bumpScale=0.25; } }
  else { m.bumpMap=t; m.bumpScale=0.25; } return m; }
// clear=true (hero car) makes the glass slightly see-through so the cockpit
// interior and driver's helmet read through the glasshouse.
function glassMat(clear){ return new THREE.MeshStandardMaterial({color:0x0a1220, metalness:0.7, roughness:0.04, envMap:envTex, envMapIntensity:_MATFX?2.4:1.8, transparent:!!clear, opacity:clear?0.72:1}); }
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
  const geo=new THREE.ExtrudeGeometry(s,{depth:width, bevelEnabled:bevel>0, bevelThickness:bevel, bevelSize:bevel, bevelSegments:_HI?4:3, steps:1, curveSegments:MOBILE?12:(_HI?28:18)});
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
  const S=256, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d'); const c=S/2;
  x.fillStyle='#0b0b0c'; x.beginPath(); x.arc(c,c,c,0,6.28); x.fill();                 // tyre
  // white sidewall lettering curved around the tyre (racing-slick look)
  x.save(); x.translate(c,c); x.fillStyle='rgba(238,240,244,0.92)';
  x.font=`900 ${Math.round(S*0.075)}px Arial`; x.textAlign='center'; x.textBaseline='middle';
  const word='APEX GP';
  for (const off of [0, Math.PI]){
    for (let i=0;i<word.length;i++){
      const a=off - (word.length-1)*0.5*0.16 + i*0.16;
      x.save(); x.rotate(a); x.translate(0,-c*0.885);
      x.fillText(word[i],0,0); x.restore();
    }
  }
  x.restore();
  // thin white pinstripe ring between tyre and rim
  x.strokeStyle='rgba(230,233,238,0.75)'; x.lineWidth=S*0.008;
  x.beginPath(); x.arc(c,c,c*0.78,0,6.28); x.stroke();
  x.fillStyle='#16191e'; x.beginPath(); x.arc(c,c,c*0.74,0,6.28); x.fill();            // rim well (dark)
  const g=x.createRadialGradient(c,c*0.7,S*0.025,c,c,c*0.7); g.addColorStop(0,'#e3e8ee'); g.addColorStop(0.6,'#aab1bb'); g.addColorStop(1,'#787f89');
  for (let k=0;k<5;k++){ x.save(); x.translate(c,c); x.rotate(k/5*6.28 - Math.PI/2); x.fillStyle=g;
    x.beginPath(); x.moveTo(-S*0.0375,S*0.1); x.lineTo(S*0.0375,S*0.1); x.lineTo(S*0.069,c*0.66); x.lineTo(-S*0.069,c*0.66); x.closePath(); x.fill(); x.restore(); }   // 5 spokes
  x.strokeStyle='#cfd5dd'; x.lineWidth=S*0.03; x.beginPath(); x.arc(c,c,c*0.72,0,6.28); x.stroke();   // polished outer lip
  const hg=x.createRadialGradient(c,c*0.9,2,c,c,S*0.1125); hg.addColorStop(0,'#d7dce3'); hg.addColorStop(1,'#9aa0a9');
  x.fillStyle=hg; x.beginPath(); x.arc(c,c,S*0.1125,0,6.28); x.fill();                 // centre cap
  x.fillStyle='#33373e'; for (let k=0;k<5;k++){ const a=k/5*6.28; x.beginPath(); x.arc(c+Math.cos(a)*S*0.069,c+Math.sin(a)*S*0.069,S*0.01625,0,6.28); x.fill(); }   // lug nuts
  x.fillStyle='#202329'; x.beginPath(); x.arc(c,c,S*0.031,0,6.28); x.fill();
  _wheelTex=new THREE.CanvasTexture(cv); _wheelTex.colorSpace=THREE.SRGBColorSpace; return _wheelTex;
}
function addWheels(g,tx,tz,r,lite){
  const tyre=new THREE.CylinderGeometry(r,r,0.52,lite?10:(_HI?40:22)); tyre.rotateZ(Math.PI/2);
  const tm=new THREE.MeshStandardMaterial({color:0x1a1a1d, roughness:0.85, metalness:0.0, map:makeTyreTex(), bumpMap:makeTyreTex(), bumpScale:0.4});
  const simpleRim = lite ? new THREE.CylinderGeometry(r*0.62,r*0.62,0.54,8).rotateZ(Math.PI/2) : null;
  const rm=chromeMat();
  const wheelTex = lite?null:makeWheelTexture();
  const discGeo  = lite?null:new THREE.CircleGeometry(r*0.99, _HI?48:30);
  const brakeGeo = lite?null:new THREE.CylinderGeometry(r*0.58,r*0.58,0.5,_HI?30:18).rotateZ(Math.PI/2);
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
function carbonMat(){ return new THREE.MeshStandardMaterial({color:0xffffff, map:makeCarbonTex(), metalness:0.5, roughness:0.42, envMap:envTex, envMapIntensity:_MATFX?1.4:1.0}); }
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
  const band=decal(makeSponsorTex(liv.sponsor||'APEX', liv.body), 1.3,0.2);
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
  // ---- photoreal pass: cockpit interior, driver, baked-shadow depth ----
  // interior shell visible through the (now translucent) hero glass
  const cabin=new THREE.MeshStandardMaterial({color:0x0b0d11, roughness:0.95});
  g.add(lmBox(cabin, W-0.75, 0.30, L*0.30, 0, 1.20, -L*0.05));
  // driver: racing seat + halo headrest + helmet with a dark visor (sits on the left)
  g.add(lmBox(cabin, 0.42, 0.34, 0.14, -0.35, 1.30, -0.52));                       // seat back
  const helmet=new THREE.Mesh(new THREE.SphereGeometry(0.155, 18, 14),
    new THREE.MeshStandardMaterial({color:liv.hood!=null?liv.hood:0xffffff, metalness:0.3, roughness:0.25, envMap:envTex, envMapIntensity:1.4}));
  helmet.position.set(-0.35, 1.34, -0.18); g.add(helmet);
  g.add(lmBox(new THREE.MeshStandardMaterial({color:0x05070c, metalness:0.6, roughness:0.1, envMap:envTex, envMapIntensity:1.6}),
              0.20, 0.09, 0.05, -0.35, 1.35, -0.04));                              // visor
  // baked-look shadowing: dark radial pools inside each wheel arch...
  const archMat=new THREE.MeshBasicMaterial({map:blobTex(), transparent:true, opacity:0.5, depthWrite:false, color:0x000000});
  for (const [ax,az] of [[-1,L*0.3],[1,L*0.3],[-1,-L*0.3],[1,-L*0.3]]){
    const q=new THREE.Mesh(new THREE.PlaneGeometry(1.35,0.85), archMat);
    q.position.set(ax*(W/2+0.035), 0.60, az); q.rotation.y=ax*Math.PI/2;
    q.userData.noShadow=true; g.add(q);
  }
  // ...and an ambient-occlusion gradient hugging each rocker panel
  for (const sxr of [-1,1]){
    const q=new THREE.Mesh(new THREE.PlaneGeometry(L*0.82,0.34),
      new THREE.MeshBasicMaterial({map:aoGradTex(), transparent:true, opacity:0.5, depthWrite:false}));
    q.position.set(sxr*(W/2+0.02), 0.46, -0.05); q.rotation.y=sxr*Math.PI/2;
    q.userData.noShadow=true; g.add(q);
  }
}
// vertical shading tile: black at the bottom fading out upward (rocker AO)
let _aoGrad=null;
function aoGradTex(){
  if (_aoGrad) return _aoGrad;
  const cv=document.createElement('canvas'); cv.width=8; cv.height=64; const x=cv.getContext('2d');
  const gr=x.createLinearGradient(0,0,0,64); gr.addColorStop(0,'rgba(0,0,0,0)'); gr.addColorStop(1,'rgba(0,0,0,0.85)');
  x.fillStyle=gr; x.fillRect(0,0,8,64);
  _aoGrad=new THREE.CanvasTexture(cv); return _aoGrad;
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

// A black executive Mercedes V-Class MPV, built from the van side profiles.
// Styled after the real thing: chrome-framed grille with the three-pointed
// star, privacy-tinted glasshouse, roof rails, running boards, wrap-around
// LED taillights and UK yellow plates.
function addVanBody(g, liv, hero, W, L){
  // NOTE on extents: the beveled extrusion reaches ~z ±2.75 and x ±1.10 — every
  // fitting must mount PROUD of that or it vanishes inside the bodywork.
  const body=paintMat(liv.body, hero), dark=matteMat(0x0d0f13), chrome=chromeMat();
  body.envMapIntensity=Math.min(body.envMapIntensity,1.3);   // keep the black paint OBSIDIAN — sky reflections washed it grey
  const glass=glassMat(false);                                  // privacy tint — opaque black glass
  g.add(extrudeCar(VAN_LOWER, W, 0.07, body));                  // lower hull
  g.add(extrudeCar(VAN_GLASS, W-0.14, 0.04, glass));            // tinted glasshouse band
  g.add(extrudeCar(VAN_ROOF,  W-0.20, 0.04, body));             // roof cap
  // pillars breaking up the glass band (wider than the glass so they show)
  for (const pz of [1.55, 0.45, -0.75, -1.95]) g.add(lmBox(dark, W, 0.78, 0.10, 0, 1.68, pz));
  // roof rails
  for (const sx of [-0.68,0.68]) g.add(lmBox(dark, 0.09,0.07,L*0.66, sx, 2.34, -0.35));
  // chrome beltline strips under the glass
  for (const sx of [-1,1]) g.add(lmBox(chrome, 0.03,0.045,L*0.80, sx*1.115, 1.30, -0.15));

  // ---- NOSE: flat face panel over the curved extrusion, fittings on top ----
  g.add(lmBox(body, W-0.06, 0.94, 0.10, 0, 0.86, 2.72));
  g.add(lmBox(dark,   1.30,0.52,0.06, 0,0.95,2.79));                       // gloss grille
  g.add(lmBox(chrome, 1.42,0.62,0.05, 0,0.95,2.78));                       // chrome frame
  for (const dy of [-0.13,0.13]) g.add(lmBox(chrome, 1.22,0.045,0.08, 0,0.95+dy,2.805));
  { const star=new THREE.Group();
    star.add(new THREE.Mesh(new THREE.TorusGeometry(0.155,0.02,8,28), chrome));
    const spoke=new THREE.BoxGeometry(0.035,0.16,0.035); spoke.translate(0,0.08,0);
    for (let k=0;k<3;k++){ const m=new THREE.Mesh(spoke, chrome); m.rotation.z=k*Math.PI*2/3; star.add(m); }   // one point up, two down
    star.position.set(0,0.95,2.84); g.add(star); }
  for (const sx of [-0.72,0.72]){                                          // LED headlight units
    g.add(lmBox(chrome, 0.58,0.26,0.05, sx,1.16,2.795));
    g.add(lmBox(new THREE.MeshStandardMaterial({color:0xf4f8ff, emissive:0xbfd8ff, emissiveIntensity:0.5, roughness:0.2}), 0.46,0.16,0.05, sx,1.16,2.815));
  }
  g.add(lmBox(dark, W-0.30,0.24,0.08, 0,0.52,2.78));                       // lower intake
  g.add(lmBox(dark, W-0.10,0.12,0.10, 0,0.34,2.62));                       // splitter lip

  // ---- TAILGATE: flat panel + rear window, the V-Class furniture on top ----
  // low-gloss tailgate panel (a mirror-bright horizon band swamped the lamps)
  const tailPanel=new THREE.MeshStandardMaterial({color:0x0b0d11, metalness:0.4, roughness:0.5, envMap:envTex, envMapIntensity:0.5});
  g.add(lmBox(tailPanel, W-0.06, 1.06, 0.10, 0, 0.88, -2.81));             // tailgate panel (clear of the hull's spline bulge)
  g.add(lmBox(glass, W-0.36, 0.60, 0.06, 0, 1.72, -2.66));                 // rear window pane
  // TALL VERTICAL taillight units down each tailgate edge: trapezoid housings
  // (widest at the window line), red/amber/clear segments + a bright vertical
  // LED edge that flares on braking.
  const tlHouse=new THREE.MeshStandardMaterial({color:0x9a1518, roughness:0.3, metalness:0.15, emissive:0xa01218, emissiveIntensity:0.55});
  const tlLed=new THREE.MeshStandardMaterial({color:0xff4038, emissive:0xe0140e, emissiveIntensity:1.3, roughness:0.3});
  const tlAmber=new THREE.MeshStandardMaterial({color:0xff9a2a, emissive:0xa85a00, emissiveIntensity:0.3, roughness:0.4});
  const tlClear=new THREE.MeshStandardMaterial({color:0xd8dde4, roughness:0.25, metalness:0.3});
  g.userData.brakeMats = g.userData.brakeMats||[];
  // outer edge runs straight down the tailgate edge; inner edge tapers.
  const OUT=W/2-0.04;                                    // lamp outer edge x
  for (const sx of [-1,1]){
    const blocks=[[0.42,0.32,1.26],[0.34,0.30,0.97],[0.26,0.22,0.72]];   // [width,height,centreY], widest at the window line
    for (const [bw,bh,by] of blocks){
      const cx=sx*(OUT-bw/2);
      g.add(lmBox(tlHouse, bw+0.05,bh+0.05,0.06, cx, by, -2.875));       // smoked border
      g.add(lmBox(tlLed,   bw,bh,0.06, cx, by, -2.89));                  // bright red lens
    }
    g.add(lmBox(tlAmber, 0.26,0.09,0.05, sx*(OUT-0.17), 1.06, -2.925));  // amber indicator band
    g.add(lmBox(tlClear, 0.20,0.08,0.05, sx*(OUT-0.14), 0.90, -2.925));  // clear reverse lens
  }
  g.userData.brakeMats.push(tlLed);
  g.add(lmBox(chrome, 0.86,0.03,0.05, 0,1.32,-2.885));                     // slim tailgate chrome strip
  { const ring=new THREE.Mesh(new THREE.TorusGeometry(0.09,0.015,8,24), chrome); ring.position.set(0,1.10,-2.90); g.add(ring); }
  // UK yellow number plates front & rear
  const plate=new THREE.MeshStandardMaterial({color:0xf2c811, roughness:0.5});
  g.add(lmBox(plate, 0.92,0.22,0.03, 0,0.62,2.80));
  g.add(lmBox(plate, 0.92,0.22,0.03, 0,0.80,-2.90));
  addMirrors(g, W/2+0.12, 1.45, 1.62, dark);
  if (!hero) return;                                            // ---- hero extras ----
  // polished running boards along each rocker
  const steel=new THREE.MeshStandardMaterial({color:0xb8bcc4, metalness:0.9, roughness:0.3, envMap:envTex, envMapIntensity:1.2});
  for (const sx of [-1,1]) g.add(lmBox(steel, 0.10,0.05,L*0.44, sx*1.14, 0.34, -0.35));
  // door shut-lines, sliding-door rail + chrome handles
  const seam=new THREE.MeshStandardMaterial({color:0x05060a, roughness:0.9});
  for (const sx of [-1,1]){
    g.add(lmBox(seam, 0.02,0.9,0.022, sx*1.115, 0.85, 1.1));
    g.add(lmBox(seam, 0.02,0.9,0.022, sx*1.115, 0.85, -0.05));
    g.add(lmBox(seam, 0.02,0.02,1.15, sx*1.115, 1.26, 0.5));
    g.add(lmBox(chrome, 0.03,0.05,0.20, sx*1.12, 1.05, 1.0));
    g.add(lmBox(chrome, 0.03,0.05,0.20, sx*1.12, 1.05, -0.25));
  }
  g.add(lmBox(dark, W-0.5,0.05,0.35, 0,2.34,-2.35));            // roof spoiler
  g.add(lmBox(dark, 0.14,0.11,0.30, 0,2.32,-1.55));             // shark-fin antenna
  // baked-shadow depth: wheel-arch pools (same trick as the stock car)
  const archMat=new THREE.MeshBasicMaterial({map:blobTex(), transparent:true, opacity:0.5, depthWrite:false, color:0x000000});
  for (const [ax,az] of [[-1,L*0.31],[1,L*0.31],[-1,-L*0.31],[1,-L*0.31]]){
    const q=new THREE.Mesh(new THREE.PlaneGeometry(1.25,0.8), archMat);
    q.position.set(ax*1.125, 0.55, az); q.rotation.y=ax*Math.PI/2; q.userData.noShadow=true; g.add(q);
  }
}

// A black Mercedes S-Class flagship sedan (W223, AMG line) from the dormant
// sedan profiles — wide slat grille + bonnet star, slim LED lights front and
// rear, chrome beltline, flush handles and trapezoid exhausts.
function addSedanBody(g, liv, hero, W, L){
  const body=paintMat(liv.body, hero), dark=matteMat(0x0d0f13), chrome=chromeMat();
  body.envMapIntensity=Math.min(body.envMapIntensity,1.5);
  const glass=glassMat(false);
  g.add(extrudeCar(SED_LOWER, W, 0.07, body));               // hull (extents ~z±2.69, x±1.13)
  g.add(extrudeCar(SED_GLASS, W-0.14, 0.05, glass));
  g.add(extrudeCar(SED_ROOF,  W-0.30, 0.05, body));
  g.add(lmBox(dark, W-0.10, 0.42, 0.08, 0, 1.34, -0.62));    // B-pillar band
  for (const sx of [-1,1]) g.add(lmBox(chrome, 0.03,0.035,L*0.60, sx*1.145, 1.17, -0.45));
  // ---- nose: chrome-framed slat grille, grille star + bonnet star, LED lights ----
  g.add(lmBox(body, W-0.10, 0.62, 0.10, 0, 0.72, 2.60));
  g.add(lmBox(chrome, 1.24,0.46,0.05, 0,0.80,2.70));
  g.add(lmBox(dark,   1.12,0.38,0.06, 0,0.80,2.72));
  for (const dy of [-0.10,0,0.10]) g.add(lmBox(chrome, 1.04,0.028,0.075, 0,0.80+dy,2.745));
  { const star=new THREE.Group();
    star.add(new THREE.Mesh(new THREE.TorusGeometry(0.11,0.016,8,26), chrome));
    const spoke=new THREE.BoxGeometry(0.026,0.115,0.026); spoke.translate(0,0.057,0);
    for (let k=0;k<3;k++){ const m=new THREE.Mesh(spoke, chrome); m.rotation.z=k*Math.PI*2/3; star.add(m); }
    star.position.set(0,0.80,2.79); g.add(star); }
  { const s2=new THREE.Group();                              // upright bonnet star
    s2.add(new THREE.Mesh(new THREE.TorusGeometry(0.055,0.01,6,18), chrome));
    const sp2=new THREE.BoxGeometry(0.016,0.055,0.016); sp2.translate(0,0.027,0);
    for (let k=0;k<3;k++){ const m=new THREE.Mesh(sp2, chrome); m.rotation.z=k*Math.PI*2/3; s2.add(m); }
    s2.position.set(0,1.16,2.28); g.add(s2); }
  const led=new THREE.MeshStandardMaterial({color:0xf4f8ff, emissive:0xbfd8ff, emissiveIntensity:0.55, roughness:0.2});
  for (const sx of [-0.74,0.74]){
    g.add(lmBox(dark, 0.52,0.17,0.06, sx,1.02,2.63));
    g.add(lmBox(led,  0.44,0.09,0.05, sx,1.02,2.67));
  }
  g.add(lmBox(dark, W-0.55,0.20,0.08, 0,0.42,2.64));
  const plate=new THREE.MeshStandardMaterial({color:0xf2c811, roughness:0.5});
  g.add(lmBox(plate, 0.88,0.20,0.03, 0,0.52,2.73));
  // ---- tail: slim horizontal LED units wrapping the wings, chrome, exhausts ----
  g.add(lmBox(body, W-0.10, 0.72, 0.10, 0, 0.70, -2.62));
  const tlHouse=new THREE.MeshStandardMaterial({color:0x5a0f12, roughness:0.3, metalness:0.15, emissive:0x7a0d10, emissiveIntensity:0.5});
  const tlLed=new THREE.MeshStandardMaterial({color:0xff4038, emissive:0xe0140e, emissiveIntensity:1.25, roughness:0.3});
  g.userData.brakeMats=g.userData.brakeMats||[];
  for (const sx of [-1,1]){
    g.add(lmBox(tlHouse, 0.62,0.14,0.06, sx*0.64, 0.98, -2.73));
    g.add(lmBox(tlLed,   0.54,0.05,0.06, sx*0.64, 0.99, -2.745));
    g.add(lmBox(tlHouse, 0.07,0.13,0.30, sx*1.145, 0.98, -2.50));
  }
  g.userData.brakeMats.push(tlLed);
  g.add(lmBox(chrome, 1.12,0.035,0.05, 0,0.86,-2.735));
  g.add(lmBox(plate, 0.88,0.20,0.03, 0,0.60,-2.75));
  const steel=new THREE.MeshStandardMaterial({color:0xb8bcc4, metalness:0.9, roughness:0.3, envMap:envTex, envMapIntensity:1.2});
  for (const sx of [-0.72,0.72]) g.add(lmBox(steel, 0.30,0.10,0.06, sx,0.36,-2.70));
  addMirrors(g, W/2+0.10, 1.22, 0.68, dark);
  if (!hero) return;                                          // ---- hero extras ----
  const seam=new THREE.MeshStandardMaterial({color:0x05060a, roughness:0.9});
  for (const sx of [-1,1]){
    g.add(lmBox(seam, 0.02,0.60,0.022, sx*1.14, 0.78, 0.72));
    g.add(lmBox(seam, 0.02,0.60,0.022, sx*1.14, 0.78, -0.52));
    g.add(lmBox(chrome, 0.028,0.045,0.24, sx*1.145, 1.02, 0.30));   // flush handles
    g.add(lmBox(chrome, 0.028,0.045,0.24, sx*1.145, 1.02, -0.95));
  }
  const archMat=new THREE.MeshBasicMaterial({map:blobTex(), transparent:true, opacity:0.5, depthWrite:false, color:0x000000});
  for (const [ax,az] of [[-1,L*0.30],[1,L*0.30],[-1,-L*0.30],[1,-L*0.30]]){
    const q=new THREE.Mesh(new THREE.PlaneGeometry(1.25,0.75), archMat);
    q.position.set(ax*1.15, 0.52, az); q.rotation.y=ax*Math.PI/2; q.userData.noShadow=true; g.add(q);
  }
}

// smooth low stock-car body side profile (front=+x, up=+y) — rounded nose & tail
const STOCK_BODY=[[2.46,0.40],[2.54,0.74],[2.30,0.96],[1.5,1.02],[0.7,1.04],[-1.45,1.04],[-2.25,0.96],[-2.5,0.66],[-2.48,0.40],[-2.26,0.28],[2.26,0.28]];
// A Daytona-style NASCAR stock car with a smooth curved body. Front faces +z.
function buildCar(vehicle, lite){
  const liv = vehicle.livery || RIVAL_LIVERIES[0];
  const g=new THREE.Group();
  const hero=!lite;
  const main=paintMat(liv.body,hero), accent=paintMat(liv.hood,hero), roofM=paintMat(liv.roof!=null?liv.roof:liv.hood,hero);
  const white=paintMat(0xffffff,hero), glass=glassMat(hero), dark=matteMat(0x16181c);
  const VAN = vehicle.kind==='van', SED = vehicle.kind==='sedan';
  const L = VAN?5.3:(SED?5.2:4.9), W = VAN?2.06:(SED?2.12:2.16);
  if (VAN){
    addVanBody(g, liv, hero, W, L);
    addWheels(g, W/2-0.04, L*0.31, 0.5, lite);
  } else if (SED){
    addSedanBody(g, liv, hero, W, L);
    addWheels(g, W/2-0.04, L*0.30, 0.48, lite);
  } else {
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
    const sp=decal(makeSponsorTex(liv.sponsor||'APEX', liv.hood), 1.55,0.5); sp.position.set(sx*(W/2+0.04), 0.68, -0.7); sp.rotation.y=sx>0?-Math.PI/2:Math.PI/2; g.add(sp);
  }
  // sticker headlights + taillights (taillights flare under braking)
  addLights(g, 0.82, L*0.5, L*0.5, lite);
  // grille / mirrors / exhausts / hood pins / window net / antenna …
  addCarDetails(g, W, L, lite, liv);
  // racing wheels tucked under the fenders
  addWheels(g, W/2-0.04, L*0.3, 0.55, lite);
  }
  // additive red glow behind the taillights (blooms under braking)
  const glowMat=new THREE.MeshBasicMaterial({map:glowTex(0xff2a1a), transparent:true, opacity:0.0, depthWrite:false, blending:THREE.AdditiveBlending, fog:false});
  g.userData.tailGlow=[];
  for (const sx of [-0.82,0.82]){ const q=new THREE.Mesh(new THREE.PlaneGeometry(VAN?0.5:1.5, VAN?0.95:1.1), glowMat.clone()); q.position.set(VAN?sx*1.01:sx,VAN?1.05:0.82,VAN?-L*0.5-0.42:-L*0.5-0.2); q.rotation.y=Math.PI; q.userData.noShadow=true; g.add(q); g.userData.tailGlow.push(q); }
  // a faint contact patch under the car — grounds distant cars that fall outside
  // the (tight) real-time shadow frustum; subtle so it doesn't double the shadow.
  { const sh=new THREE.Mesh(new THREE.PlaneGeometry(W*1.7,L*1.1), new THREE.MeshBasicMaterial({map:blobTex(), transparent:true, opacity:0.28, depthWrite:false, fog:false}));
    sh.rotation.x=-Math.PI/2; sh.position.y=0.04; sh.userData.noShadow=true; sh.renderOrder=-1; g.add(sh); }
  // night lights: warm headlight glow quads + an additive light pool thrown onto
  // the road ahead. Built for every car but hidden by day (toggled per frame).
  { const hg=new THREE.MeshBasicMaterial({map:glowTex(0xfff0c2), transparent:true, opacity:0.85, depthWrite:false, blending:THREE.AdditiveBlending, fog:false});
    g.userData.headGlow=[];
    for (const sx of [-0.82,0.82]){ const q=new THREE.Mesh(new THREE.PlaneGeometry(1.3,1.0), hg.clone());
      q.position.set(sx,VAN?1.16:0.82,L*0.5+0.18); q.userData.noShadow=true; q.visible=false; g.add(q); g.userData.headGlow.push(q); }
    const pool=new THREE.Mesh(new THREE.PlaneGeometry(W*2.7, L*3.1),
      new THREE.MeshBasicMaterial({map:glowTex(0xffe9b8), transparent:true, opacity:0.22, depthWrite:false, blending:THREE.AdditiveBlending, fog:false}));
    pool.rotation.x=-Math.PI/2; pool.position.set(0,0.12,L*0.5+L*1.4);
    pool.userData.noShadow=true; pool.visible=false; g.add(pool); g.userData.lightPool=pool; }
  g.scale.setScalar(CAR_SCALE);   // bigger cars (wheels sit at y=0 so it stays grounded)
  g.traverse(o=>{ if(o.isMesh && !o.userData.noShadow){ o.castShadow=true; } });
  return g;
}
// ---- extra surface tiles: kerb grime, tyre tread, dune sand ripples ----
let _grimeTex=null;
function makeGrimeTex(){          // near-white speckle/scratch tile — MULTIPLIES
  if (_grimeTex) return _grimeTex;   // vertex colours, so kerbs keep their paint
  const S=128, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d');
  x.fillStyle='#e6e6e6'; x.fillRect(0,0,S,S);
  for (let i=0;i<900;i++){ const g=170+Math.random()*70|0; x.globalAlpha=0.25+Math.random()*0.4;
    x.fillStyle=`rgb(${g},${g},${g})`; x.fillRect(Math.random()*S, Math.random()*S, 1+Math.random()*2.5, 1+Math.random()*2.5); }
  x.globalAlpha=0.35; x.strokeStyle='#9a9a9a'; x.lineWidth=1;
  for (let i=0;i<10;i++){ x.beginPath(); const y=Math.random()*S; x.moveTo(0,y); x.lineTo(S,y+(Math.random()-0.5)*10); x.stroke(); }
  x.globalAlpha=1;
  const t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.anisotropy=_maxAniso; _grimeTex=t; return t;
}
let _tyreTex=null;
function makeTyreTex(){           // rubber base + circumferential tread grooves
  if (_tyreTex) return _tyreTex;
  const S=128, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d');
  x.fillStyle='#141416'; x.fillRect(0,0,S,S);
  for (let i=0;i<700;i++){ const g=14+Math.random()*22|0; x.globalAlpha=0.5;
    x.fillStyle=`rgb(${g},${g},${g})`; x.fillRect(Math.random()*S, Math.random()*S, 2, 2); }
  x.globalAlpha=1;
  for (const fy of [0.22,0.4,0.6,0.78]){ x.fillStyle='#050507'; x.fillRect(0,S*fy-2,S,4); }   // grooves
  x.fillStyle='#0a0a0c'; for (let i=0;i<16;i++){ x.fillRect(i*(S/16),S*0.44,3,S*0.12); }      // sipes
  const t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(6,1); t.anisotropy=_maxAniso; _tyreTex=t; return t;
}
let _sandTex=null;
function makeSandTex(){           // wind-ripple waves over speckled sand
  if (_sandTex) return _sandTex;
  const S=256, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d');
  x.fillStyle='#d9bd82'; x.fillRect(0,0,S,S);
  for (let i=0;i<2600;i++){ const p=[['#cfb073',0.5],['#e4ca92',0.45],['#c2a468',0.35]][(Math.random()*3)|0];
    x.globalAlpha=p[1]; x.fillStyle=p[0]; x.fillRect(Math.random()*S, Math.random()*S, 1.5, 1.5); }
  x.globalAlpha=0.5; x.strokeStyle='#b8985c'; x.lineWidth=2.2; x.lineCap='round';
  for (let r=0;r<11;r++){ const y0=r*(S/11)+6; x.beginPath();
    for (let px=0;px<=S;px+=8){ const yy=y0+Math.sin(px*0.09+r*1.7)*4; px===0?x.moveTo(px,yy):x.lineTo(px,yy); } x.stroke(); }
  x.globalAlpha=1;
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(4,2); t.anisotropy=_maxAniso; _sandTex=t; return t;
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
  const S=_MATHIRES?512:256, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d');   // hi-res tile on WebGPU
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
  if (_MATNORMAL){ const n=detailNormal(k, rep); if(n){ m.normalMap=n; m.normalScale=new THREE.Vector2(1.0,1.0); } }   // WebGPU: real normal mapping
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
  t.anisotropy=_maxAniso; return t;
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

// ---- New York landmarks ----
function addEmpireState(group, frames, spec){
  const g=new THREE.Group();
  const deco=txMat({color:0xb8b2a4, roughness:0.75},'stone',3);
  const winA=makeWindowTexture(false), winB=makeWindowTexture(false);
  const win=new THREE.MeshStandardMaterial({color:0xa8a294, roughness:0.7, map:winA, emissive:0xffe39a, emissiveMap:winB, emissiveIntensity:0.35});
  win.map.repeat.set(3,10); win.emissiveMap.repeat.set(3,10);
  // classic art-deco setbacks stepping to the crown
  const steps=[[46,26,46],[38,40,38],[30,56,30],[22,42,22],[15,30,15]];
  let y=0; for (const [w,h,d] of steps){ const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,d), win); b.position.y=y+h/2; g.add(b); y+=h; }
  const crown=new THREE.Mesh(new THREE.CylinderGeometry(4,7,18,10), deco); crown.position.y=y+9; g.add(crown); y+=18;
  const spike=new THREE.Mesh(new THREE.CylinderGeometry(0.5,2,42,8), new THREE.MeshStandardMaterial({color:0xd9dde2, metalness:0.7, roughness:0.25})); spike.position.y=y+21; g.add(spike);
  placeLandmark(group, g, frames, spec);
}
// drive-through gate: twin granite towers + suspended main cables over the road
function addBrooklynBridge(group, frames, spec){
  const f=frames[((Math.floor(DIV*(spec?spec.frac:0.12)))%DIV+DIV)%DIV], g=new THREE.Group();
  const granite=txMat({color:0xb2a38c, roughness:0.85},'stone',4);
  const cableM=new THREE.MeshStandardMaterial({color:0x2b2e34, roughness:0.5, metalness:0.6});
  const half=ROAD_W+RUMBLE_W+10, H=95, tw=12, td=8;
  for (const sx of [-1,1]){
    g.add(lmBox(granite, tw, H, td, sx*half, H/2, 0));
    g.add(lmBox(granite, tw+6, 10, td+2, sx*half, H-5, 0));      // cap
    g.add(lmBox(granite, tw+4, 6, td+1, sx*half, 3, 0));         // plinth
  }
  g.add(lmBox(granite, half*2+tw, 4, td, 0, 26, 0));             // deck edge high over the road
  for (const sz of [-3.5,3.5]){ let prev=null;
    for (let i=0;i<=14;i++){ const t=i/14, x=(t-0.5)*(half*2), y=H-8 - (H-8-32)*(1-Math.pow(2*t-1,2));
      if (prev){ const mx=(x+prev.x)/2,my=(y+prev.y)/2,dx=x-prev.x,dy=y-prev.y,len=Math.hypot(dx,dy);
        const c=lmBox(cableM,len,0.8,0.8,mx,my,sz); c.rotation.z=Math.atan2(dy,dx); g.add(c); }
      if (i%2===0 && i>0 && i<14){ const hgt=y-28; if (hgt>3) g.add(lmBox(cableM,0.4,hgt,0.4,x,28+hgt/2,sz)); }
      prev={x,y};
    }
  }
  g.position.copy(f.pos); g.rotation.y=Math.atan2(f.tan.x,f.tan.z); g.scale.setScalar((spec&&spec.scale)||1); group.add(g);
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
    : th.landmark==='nyc'   ? Array.from({length:N12},(_,i)=>[addEmpireState,addStatueOfLiberty][i%2])
    : th.landmark==='usa'   ? Array.from({length:N12},(_,i)=>[addStatueOfLiberty,addGoldenGate][i%2]) : [];
  const cen=new THREE.Vector3(); for(const fr of frames) cen.add(fr.pos); cen.multiplyScalar(1/frames.length);
  const heroSlots = heroFns.map((fn,i)=>{ const fi=Math.floor(((i+0.5)/heroFns.length)*DIV)%DIV, f=frames[fi];
    const outward=(f.pos.x-cen.x)*f.right.x + (f.pos.z-cen.z)*f.right.z; return { fn, fi, side: outward>=0?1:-1 }; });

  // gate (Tower Bridge / Dubai Frame) on the straightest start stretch
  let gateFi=-1;
  if (th.landmark==='london' || th.landmark==='dubai' || th.landmark==='nyc'){ let bs=Infinity;
    for (let i=Math.floor(DIV*0.04);i<=Math.floor(DIV*0.20);i++){ let s=0; for(let k=-45;k<=45;k++) s+=Math.abs(frames[(i+k+DIV)%DIV].curv); if(s<bs){bs=s;gateFi=i;} } }
  const gateNear=i=>{ if(gateFi<0)return false; let d=Math.abs(i-gateFi); d=Math.min(d,DIV-d); return d<30; };
  const heroNear=(i,side)=> gateNear(i) || heroSlots.some(h=>{ if(h.side!==side)return false; let d=Math.abs(i-h.fi); d=Math.min(d,DIV-d); return d<26; });

  // verge props (mobile-budgeted, both verges)
  const PROP_STEP = MOBILE ? 18 : 3;   // denser trees/props (max on desktop)
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
    const winTex=makeWindowTexture(th.landmark==='dubai'); const RING=MOBILE?30:84;
    for (let i=0;i<RING;i++){ const ang=(i/RING)*Math.PI*2; const r=560+(mulberry32(i+99)())*260; const h=70+(mulberry32(i+5)())*(th.landmark==='dubai'?260:(th.landmark==='nyc'?210:140)); const w=24+(mulberry32(i+13)())*26;
      const col=th.landmark==='dubai'?0x9fb6cc:[0x8a6a52,0x9c7a52,0x70615a,0x86756b][i%4];
      const mat=new THREE.MeshStandardMaterial({color:col, roughness:0.7, metalness:th.landmark==='dubai'?0.4:0.05, map:winTex.clone(), emissive:0xffe39a, emissiveMap:winTex.clone(), emissiveIntensity:0.4}); mat.map.repeat.set(Math.max(1,w/12),Math.max(2,h/12)); mat.emissiveMap.repeat.copy(mat.map.repeat);
      _pulse.push({mat, base:0.62, ph:i*1.3, sp:3.2, flash:true}); _scroll.push({tex:mat.emissiveMap, v:0.02});   // brighter twinkly neon windows
      const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,w),mat); b.position.set(Math.cos(ang)*r,h/2-40,Math.sin(ang)*r); sceneryGroup.add(b); }
  } else {
    const mtnMat=new THREE.MeshLambertMaterial({color:th.mountain, flatShading:true, map:makeDetailTex('rough')});
    const snowMat=new THREE.MeshLambertMaterial({color:0xeef3f7, flatShading:true});
    for (let i=0;i<26;i++){ const ang=(i/26)*Math.PI*2; const r=720+(mulberry32(i+99)())*240; const h=130+(mulberry32(i+5)())*200;
      const m=new THREE.Mesh(new THREE.ConeGeometry(h*0.9,h,5),mtnMat); m.position.set(Math.cos(ang)*r,h/2-40,Math.sin(ang)*r); sceneryGroup.add(m);
      if (th.snow){ const cap=new THREE.Mesh(new THREE.ConeGeometry(h*0.32,h*0.34,5),snowMat); cap.position.set(Math.cos(ang)*r,h-40-h*0.17,Math.sin(ang)*r); sceneryGroup.add(cap); } }
  }
  // rolling golden dunes around the desert circuit — placed OUTSIDE the
  // track's real extent (the layout grew; a fixed radius parked one on the road)
  if (th.landmark==='dubai'){
    let maxR=0; for (const fr of frames){ maxR=Math.max(maxR, Math.hypot(fr.pos.x-cen.x, fr.pos.z-cen.z)); }
    const duneMat=new THREE.MeshLambertMaterial({color:0xffffff, map:makeSandTex(), bumpMap:makeSandTex(), bumpScale:0.6});
    const ND=MOBILE?8:16;
    for (let i=0;i<ND;i++){ const ang=(i/ND)*Math.PI*2 + 0.19;
      const sc=40+(mulberry32(i+7)())*70;
      const r=maxR + sc*2.2 + 40 + (mulberry32(i+55)())*140;   // near edge clears the track
      const d=new THREE.Mesh(new THREE.SphereGeometry(1,10,7), duneMat);
      d.scale.set(sc*2.2, sc*0.5, sc); d.position.set(cen.x+Math.cos(ang)*r, -sc*0.12, cen.z+Math.sin(ang)*r);
      d.rotation.y=ang; sceneryGroup.add(d);
    }
  }
  // a bold continuous city skyline on the horizon, ringing the whole circuit
  try{ buildSkylineBackdrop(cen, th); }catch(e){ _scnInfo='SKYLINE-ERR:'+(e&&e.message||e); }

  // hero landmarks — grounded on the banked verge surface, and offset by each
  // landmark's BASE FOOTPRINT so its near edge always clears the kerb by a fixed
  // margin (otherwise a wide base — e.g. the Shard — sits across the racing line).
  const FOOT = new Map([[addBigBen,9],[addLondonEye,11],[addGherkin,17],[addShard,22],
                        [addBurj,19],[addBurjAlArab,26],[addStatueOfLiberty,18],[addGoldenGate,30],[addEmpireState,25]]);
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
  if (th.landmark==='nyc')    try{ addBrooklynBridge(sceneryGroup, frames, {frac:sA/DIV, scale:1.15}); }catch(e){ _scnInfo='GATE-ERR:'+(e&&e.message||e); }

  // mid-distance buildings (urban) — outside of the loop, clear of landmarks
  if (th.buildings){
    const keepout = heroSlots.map(h=>h.fi).concat(gateFi>=0?[gateFi]:[]);
    const nearLM = i=>keepout.some(k=>{ let d=Math.abs(i-k); d=Math.min(d,DIV-d); return d<70; });
    const winTex=makeWindowTexture(th.landmark==='dubai'); const _v=new THREE.Vector3();
    for (let i=0;i<DIV;i+=(MOBILE?70:22)){ if(nearLM(i)) continue; const f=frames[i]; _v.copy(f.pos).sub(cen); const side=(_v.dot(f.right)>=0)?1:-1;
      const h=20+rng()*(th.landmark==='dubai'?70:34), w=12+rng()*12; const col=th.landmark==='dubai'?0xbcd0e2:[0x8a6248,0x96704e,0x6f5e54][(rng()*3)|0];
      const mat=new THREE.MeshStandardMaterial({color:col, roughness:0.7, metalness:th.landmark==='dubai'?0.45:0.05, map:winTex.clone(), emissive:0xffe39a, emissiveMap:winTex.clone(), emissiveIntensity:0.38}); mat.map.repeat.set(Math.max(1,w/8),Math.max(2,h/10)); mat.emissiveMap.repeat.copy(mat.map.repeat);
      _pulse.push({mat, base:0.58, ph:i*0.7, sp:2.6, flash:true}); _scroll.push({tex:mat.emissiveMap, v:0.016});
      const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,w),mat); b.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+90+rng()*70)); b.position.y+=h/2-2; sceneryGroup.add(b); }
  }

  // start/finish gantry
  const f0=frames[2], gantry=new THREE.Group();
  const postMat=new THREE.MeshLambertMaterial({color:0xb9c0c7, map:makeDetailTex('metal')}), postGeo=new THREE.CylinderGeometry(0.5,0.5,16,8);
  const lp=new THREE.Mesh(postGeo,postMat); lp.position.set(-ROAD_W-2,8,0); gantry.add(lp);
  const rp=new THREE.Mesh(postGeo,postMat); rp.position.set(ROAD_W+2,8,0); gantry.add(rp);
  const beam=new THREE.Mesh(new THREE.BoxGeometry((ROAD_W+2)*2,3,1.5), new THREE.MeshLambertMaterial({color:0xc1272d, map:makeDetailTex('metal')})); beam.position.set(0,15.5,0); gantry.add(beam);
  const board=new THREE.Mesh(new THREE.BoxGeometry(8,3,0.5), new THREE.MeshBasicMaterial({map:makeSignTexture(G.circuit.name,'#c1272d')})); board.position.set(0,12,0.9); gantry.add(board);
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
  const NSEG=MOBILE?12:18, NROW=MOBILE?3:4;
  const standFracs = MOBILE ? [0.008,0.028, 0.25, 0.40, 0.50, 0.62, 0.75]
                            : [0.006,0.022,0.038, 0.13,0.25,0.37, 0.49,0.51,0.53, 0.63,0.75,0.87];
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

  // ---- GT-style drivetrain: 5-speed auto. Each gear pulls hardest low in its
  //      band; upshifts cut the throttle for a beat (the classic shift kick). ----
  {
    const sf=Math.min(1.3, Math.abs(G.speed)/maxSpeed);
    const TOPS=[0.20,0.36,0.54,0.75,1.31];
    let gi=0; while (gi<4 && sf>TOPS[gi]) gi++;
    if (gi+1>G.gear) G.shiftCut=0.13;                      // upshift kick
    G.gear=gi+1;
    if (G.shiftCut>0) G.shiftCut-=dt;
    const lo=gi?TOPS[gi-1]:0, hi=TOPS[gi];
    const inBand=Math.max(0,Math.min(1,(sf-lo)/(hi-lo)));
    const target=(G.shiftCut>0?0.36:0.30)+0.68*inBand;     // revs drop through a shift
    G.rpm += (target-G.rpm)*Math.min(1,dt*(G.shiftCut>0?16:9));
  }
  // longitudinal — low gears pull hard, top gear stretches (GT power band).
  // Controller triggers are ANALOG: partial throttle / trail braking work.
  const gearPull=[1.42,1.26,1.12,1.0,0.88][G.gear-1]||1;
  const throttle = _padGasV>0.06 ? _padGasV : (keys.gas?1:0);
  const brakeIn  = _padBrakeV>0.06 ? _padBrakeV : (keys.brake?1:0);
  if (throttle>0)      G.speed += 84 * v.accelMul * gearPull * (G.shiftCut>0?0.15:1) * throttle * dt;
  else                 G.speed -= 22 * dt;                 // coast
  if (brakeIn>0)       G.speed -= 95 * v.brakeMul * brakeIn * dt;
  G.speed -= G.speed * 0.012;                              // drag
  if (onGrass)         G.speed -= G.speed * 0.05;          // grass scrub
  // ---- nitro boost: a held surge that drains the meter, refilling when idle ----
  G.boostActive = false;
  if (keys.boost && G.boost>0.02 && G.speed > maxSpeed*0.08){
    G.boostActive = true; G.speed += 150*dt; G.boost = Math.max(0, G.boost - dt*0.5);
  } else {
    G.boost = Math.min(1, G.boost + dt*(keys.gas?0.10:0.16));
  }
  // ---- slipstream: tuck in close behind a rival at speed for a draft tow ----
  let draft=false;
  if (G.speed > maxSpeed*0.55 && !onGrass){
    for (const r of rivals){
      const gap=(r.dist - G.dist + trackLen) % trackLen;   // distance to the car ahead
      if (gap>3 && gap<26 && Math.abs(r.offset - G.offset)<3.2){ draft=true; break; }
    }
  }
  if (draft){
    _draftT+=dt;
    G.speed += 34*dt*Math.min(1,_draftT);                  // the tow builds as you sit in it
    if (_draftT>0.9 && !_draftCalled){ _draftCalled=true; arcadeCallout('SLIPSTREAM!', '#7ad7ff', [_NOTE.E5,_NOTE.G5]); }
  } else { _draftT=0; _draftCalled=false; }
  const topNow = (G.boostActive ? maxSpeed*1.28 : (onGrass ? maxSpeed*0.5 : maxSpeed)) * (draft?1.07:1);
  if (G.speed > topNow) G.speed += (topNow - G.speed)*0.1;
  G.speed = Math.max(-maxSpeed*0.28, Math.min(maxSpeed*1.3, G.speed));

  // steering -> lateral offset (only meaningful when moving)
  let steer = (keys.right?1:0) - (keys.left?1:0);
  if (_padSteerAx!==0) steer = _padSteerAx;                // analog stick overrides
  G.steerVis += (steer - G.steerVis) * 0.2;
  const speedFrac = Math.min(1, Math.abs(G.speed)/maxSpeed);
  const grip = v.gripMul * (onGrass?0.7:1) * (G.rain?0.82:1);
  const f = frameAt(G.dist);
  // ---- Daytona-style powerslide: at speed, a brake-tap while steering (or just
  //      steering hard through a real corner) breaks the tail loose. Held, the
  //      slide keeps corner speed; the honest line without it understeers. ----
  const cornering = Math.abs(f.curv)*speedFrac;
  if (!G.drift){
    if (Math.abs(steer)>0.4 && speedFrac>0.5 && (keys.brake || cornering>0.030)) G.drift=Math.sign(steer);
  } else if (Math.abs(steer)<0.1 || speedFrac<0.32){ G.drift=0; }   // hooks back straight
  else { G.drift=Math.sign(steer); }                                // flick across mid-slide
  G.driftVis += ((G.drift ? G.drift*(0.35+0.45*Math.min(1,cornering*14)) : 0) - G.driftVis)*Math.min(1,dt*6);
  // steering authority: GT understeer as speed rises — restored by sliding
  const authority = G.drift ? 1.35 : (1 - 0.38*speedFrac);
  G.offset += steer * 16 * v.steerMul * grip * authority * dt * (0.35 + 0.65*speedFrac) * Math.sign(G.speed||1);
  // centrifugal push (the tail runs wide in a slide)
  G.offset += f.curv * speedFrac * (G.drift?17:11) * dt;
  // corner-speed model: gripping through a fast corner scrubs speed off
  // (understeer); a held powerslide carries momentum — the Daytona way round.
  if (!G.drift && cornering>0.042) G.speed -= G.speed*Math.min(0.9,(cornering-0.042)*26)*dt;
  else if (G.drift)                G.speed -= G.speed*0.055*dt;
  // ---- drift scoring: hold a fast line through corners to build a combo ----
  const driftNow = !onGrass && (!!G.drift ? speedFrac>0.45 : (speedFrac>0.62 && (steer!==0 || Math.abs(f.curv)>0.02)));
  if (driftNow){ const gain=speedFrac*55*_driftCombo*dt; _driftActive+=dt; _driftCombo=Math.min(6, 1+((_driftActive*0.85)|0)); _sessionScore+=gain; _driftRun+=gain; }
  else {
    if (_driftRun>250){ const cols=['#ffd400','#ffae3a','#ff7a3a','#ff4dd2','#7affd4','#ffffff'];
      arcadeCallout('DRIFT +'+Math.round(_driftRun)+(_driftCombo>2?'  x'+_driftCombo:''), cols[Math.min(5,_driftCombo-1)], [_NOTE.G5,_NOTE.C6]); }
    _driftRun=0; _driftActive=0; _driftCombo=1;
  }
  // persistent rubber laid through drifts — a recycled pool of dark strips
  if (driftNow && Math.abs(G.dist-_lastSkidDist)>1.7){ laySkidMarks(f); _lastSkidDist=G.dist; }
  // arcade tyre smoke when sliding / cornering hard / on the grass
  if (_smokeGroup) driftSmoke(f, speedFrac, steer, onGrass);
  if (G.boostActive && _smokeGroup) emitBoostFlame(f);
  if (G.rain && _smokeGroup && speedFrac>0.28) emitRainSpray(f, speedFrac);   // wheel spray in the wet
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
  // cinema audio: one of the soundtrack songs plays over the replay
  try{
    if (window.GameMusic && window.GameMusic.stop) window.GameMusic.stop();
    stopRaceMusic();
    const pool=Object.keys(SOUNDTRACKS).filter(k=>SOUNDTRACKS[k].loop);
    const st=SOUNDTRACKS[pool[(Math.random()*pool.length)|0]];
    const loop=new Audio(st.loop); loop.loop=true; loop.volume=0.7;
    loop.play().catch(()=>{}); _raceAudio={intro:null, loop};
  }catch(e){}
}
function exitReplay(){
  G.state='finished'; hideBanner(); G.view='chase';
  stopRaceMusic();                                       // silence the replay song
  if (window.GameMusic){ try{ window.GameMusic.start && window.GameMusic.start(); window.GameMusic.setMode && window.GameMusic.setMode('menu'); }catch(e){} }
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

// ---- 2D confetti shower over the HUD when the player wins ----
let _confetti=null, _confT=0;
function startConfetti(){
  _confetti=[]; _confT=0;
  const cols=['#ffd400','#ff4d6d','#4dd2ff','#7bff6b','#ff9d3a','#e07bff'];
  for (let i=0;i<150;i++) _confetti.push({
    x:Math.random(), y:-Math.random()*0.5, vx:(Math.random()-0.5)*0.07,
    vy:0.14+Math.random()*0.22, rot:Math.random()*6.28, vr:(Math.random()-0.5)*7,
    s:0.006+Math.random()*0.008, c:cols[i%cols.length] });
}
function drawConfetti(W,H){
  if (!_confetti) return;
  _confT+=_adt; if (_confT>8){ _confetti=null; return; }
  const fade=Math.max(0, Math.min(1, 8-_confT));
  for (const p of _confetti){
    p.x+=p.vx*_adt; p.y+=p.vy*_adt; p.rot+=p.vr*_adt;
    const px=p.x*W, py=p.y*H; if (py>H+20||py<-H*0.6) continue;
    hctx.save(); hctx.translate(px,py); hctx.rotate(p.rot);
    hctx.globalAlpha=fade; hctx.fillStyle=p.c;
    const w=p.s*H, h=p.s*H*1.6*(0.35+0.65*Math.abs(Math.sin(p.rot*2)));  // tumbling flutter
    hctx.fillRect(-w/2,-h/2,w,h);
    hctx.restore();
  }
  hctx.globalAlpha=1;
}

function finishRace(win){
  G.state='finished'; G.lastWin=win;
  haptic([60,40,120]);
  // career: bank credits from finish position + drift score
  const posBonus=[0,300,220,160,130,110,90,70,50,40,30][computePosition()]||20;
  G.earned = Math.round(_sessionScore/40) + posBonus;
  _profile.races++; if (win) _profile.wins++; _profile.credits += G.earned; saveProfile();
  if (win) arcadeCallout('FINISH!', '#ffd400', [_NOTE.C5,_NOTE.E5,_NOTE.G5,_NOTE.C6,_NOTE.G5,_NOTE.C6]);
  if (win) startConfetti();                       // celebration shower over the finish
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
  // pulsing lights — windows now TWINKLE (slow breathe + sharp random sparkle),
  // landmark glows breathe gently
  for (const p of _pulse){
    const w = Math.sin(t*(p.sp||1.8) + p.ph);
    if (p.flash){
      const sparkle = Math.pow(Math.max(0, Math.sin(t*5.3 + p.ph*2.7)), 8);   // occasional bright pops
      p.mat.emissiveIntensity = p.base*(0.28 + 0.8*(0.5+0.5*w) + 0.7*sparkle);
    } else {
      p.mat.emissiveIntensity = p.base*(0.6 + 0.4*w);
    }
  }
  // animated (scrolling) window textures
  for (const sc of _scroll) sc.tex.offset.y += sc.v * _adt;
  // grandstand crowd "wave" — a big hump of standing fans sweeps along the stands
  for (const wv of _wave){ const rise=Math.pow(Math.max(0, Math.sin(t*2.4 - wv.k*0.55)), 0.6); wv.mesh.position.y = wv.baseY + rise*4.0; }
  // arcade tyre-smoke puffs
  updateSmoke();
}

// show/hide the cars' headlight glows + road light-pools with day/night, and
// give the player a real (shadowless, cheap) headlight SpotLight on desktop.
function updateNightLights(){
  const cars=[playerCar]; for (const r of rivals) if (r.mesh) cars.push(r.mesh);
  for (const c of cars){
    if (!c || !c.userData) continue;
    if (c.userData.headGlow) for (const q of c.userData.headGlow) q.visible=!!G.night;
    if (c.userData.lightPool) c.userData.lightPool.visible=!!G.night;
  }
  if (_HI && playerCar && playerCar.userData){
    let sp=playerCar.userData.spot;
    if (G.night && !sp){
      sp=new THREE.SpotLight(0xfff1cf, 2.6, 110, 0.52, 0.5, 1.1);
      sp.position.set(0,1.15,2.0); sp.target.position.set(0,-0.5,34);
      playerCar.add(sp); playerCar.add(sp.target); playerCar.userData.spot=sp;
    }
    if (sp) sp.visible=!!G.night;
  }
}

function render(){
  if (!G.started || !frames.length){ present(); return; }

  placeCar(playerCar, G.dist, G.offset);
  placeRivals();
  placeGhost();
  animateWorld();
  updateNightLights();
  // visual lean + powerslide yaw + weight transfer
  playerCar.rotateY(G.steerVis * 0.16 + (G.driftVis||0)*0.55);      // the Daytona slide angle
  playerCar.rotateZ(-(G.steerVis*0.05 + (G.driftVis||0)*0.06) * (G.vehicle.rollMul||1));
  { const pt=(G.state==='racing' ? ((keys.brake?0.030:0) + (keys.gas?-0.016:0) + (G.shiftCut>0?0.011:0)) : 0);
    G.pitchVis += (pt - G.pitchVis)*0.12;
    playerCar.rotateX(G.pitchVis*(G.vehicle.rollMul||1)); }         // dive / squat / shift kick
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
    const kind = G.vehicle && G.vehicle.kind;
    const tallVan = kind==='van';                          // the V-Class bonnet line is far higher
    const sedanCab = kind==='sedan';                       // S-Class photo cabin: glass band sits high on screen
    if (G.view==='dash'){            // hood cam: nearer the nose so only a short bonnet shows
      eyeFwd = tallVan ? 2.35 : (sedanCab ? 2.3 : 2.15);
      eyeY   = _tmp.y + (tallVan ? 2.62 : (sedanCab ? 2.15 : 1.74));
      lookDrop = tallVan ? 2.55 : (sedanCab ? 3.2 : 1.9);  // steeper pitch drops the road into the glass band
    } else {                         // cockpit: eye in the cabin
      eyeFwd = tallVan ? 1.2 : 0.4;
      eyeY   = _tmp.y + (tallVan ? 2.55 : 1.5);
      lookDrop = 0.4;
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
  } else if (_POSE){
    // fixed close-up debug/showroom pose around the player's car
    worldPos(G.dist, G.offset, _tmp);
    const d = _POSE==='front'?11.5:(_POSE==='side'?0.01:-11.5);
    _camPos.copy(_tmp).addScaledVector(f.tan, d); _camPos.y += 2.6;
    if (_POSE==='side') _camPos.addScaledVector(f.right, 11);
    _look.copy(_tmp); _look.y += 1.8;
    if (finite(_camPos) && finite(_look)){ camera.position.copy(_camPos); camera.up.set(0,1,0); camera.lookAt(_look); }
  } else {
    // chase camera — behind + above the car, ALWAYS world-up (never inverts/rolls
    // badly), finiteness-guarded. Height uses world up so the camera is always above.
    const camLat = G.offset * 0.30;
    const tall = (G.vehicle && G.vehicle.kind==='van') ? 1 : 0;   // the V-Class roof needs a higher, further camera
    worldPos(G.dist, camLat, _tmp);
    _camPos.copy(_tmp).addScaledVector(f.tan,-(11+tall*2.5)); _camPos.y += 5.2+tall*1.3;
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
  // crepuscular god-ray shafts, slowly wheeling around the sun
  { const rot=(performance.now()%120000)/120000*Math.PI*2;
    hctx.save(); hctx.translate(sx,sy); hctx.rotate(rot);
    hctx.fillStyle=`rgba(255,246,210,${0.055*vis})`;
    for (let i=0;i<9;i++){ const a=i/9*Math.PI*2, len=core*(2.1+((i*37)%5)*0.30), hw=0.028+((i*13)%3)*0.012;
      hctx.beginPath(); hctx.moveTo(0,0);
      hctx.lineTo(Math.cos(a-hw)*len, Math.sin(a-hw)*len);
      hctx.lineTo(Math.cos(a+hw)*len, Math.sin(a+hw)*len);
      hctx.closePath(); hctx.fill(); }
    hctx.restore(); }
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
// in-car dashboard: full right-hand-drive cockpit — windscreen, instrument
// binnacle (tacho + speedo + shift light), centre console + vents, and the wheel.
function drawDashboard(W,H,sp){
  const steer=G.steerVis, kmh=Math.round(Math.abs(G.speed)*2.4);
  const Min=Math.min(W,H);
  const VAN = !!(G.vehicle && G.vehicle.kind==='van');   // V-Class gets its real interior
  if (G.vehicle && G.vehicle.kind==='sedan'){ drawSedanDash(W,H,sp,steer,kmh,Min); return; }

  // ============================ WINDSCREEN ============================
  // roof header bar across the very top
  hctx.fillStyle='#0a0b10'; hctx.fillRect(0,0,W,H*0.05);
  hctx.fillStyle='rgba(150,160,180,0.10)'; hctx.fillRect(0,H*0.05-Math.max(1,H*0.003),W,Math.max(1,H*0.003));
  // tinted graduated sun-strip just under the header (windscreen shade band)
  let sb=hctx.createLinearGradient(0,H*0.05,0,H*0.17);
  sb.addColorStop(0,'rgba(22,34,62,0.55)'); sb.addColorStop(1,'rgba(22,34,62,0)');
  hctx.fillStyle=sb; hctx.fillRect(0,H*0.05,W,H*0.12);
  // A-pillars (thick, angled) framing the glass — light grey trim in the V-Class
  hctx.fillStyle=VAN?'rgba(150,154,162,0.96)':'rgba(9,10,15,0.96)';
  hctx.beginPath(); hctx.moveTo(0,H*0.05); hctx.lineTo(W*0.17,H*0.05); hctx.lineTo(0,H*0.55); hctx.closePath(); hctx.fill();
  hctx.beginPath(); hctx.moveTo(W,H*0.05); hctx.lineTo(W*0.83,H*0.05); hctx.lineTo(W,H*0.55); hctx.closePath(); hctx.fill();
  // faint glass reflection sheen sweeping across the upper screen
  let gs=hctx.createLinearGradient(0,0,W*0.9,H*0.5);
  gs.addColorStop(0,'rgba(200,218,240,0)'); gs.addColorStop(0.55,'rgba(200,218,240,0.05)');
  gs.addColorStop(0.66,'rgba(200,218,240,0.11)'); gs.addColorStop(0.76,'rgba(200,218,240,0)');
  hctx.fillStyle=gs; hctx.fillRect(0,H*0.05,W,H*0.45);
  // rear-view mirror hanging from the header, centred
  hctx.save(); hctx.translate(W*0.5,H*0.05);
  hctx.fillStyle='#0a0b0f'; hctx.fillRect(-W*0.006,0,W*0.012,H*0.022);          // stalk
  hctx.fillStyle='#15171e'; roundRect(-W*0.095,H*0.018,W*0.19,H*0.044,H*0.012); hctx.fill();
  let mg=hctx.createLinearGradient(0,H*0.02,0,H*0.06); mg.addColorStop(0,'#26405e'); mg.addColorStop(1,'#0b121d');
  hctx.fillStyle=mg; roundRect(-W*0.084,H*0.024,W*0.168,H*0.032,H*0.008); hctx.fill();
  hctx.restore();
  // sun visor folded up over the driver's (right) side of the glass
  hctx.save(); hctx.translate(W*0.78,H*0.05); hctx.rotate(0.02);
  hctx.fillStyle='#14161d'; roundRect(-W*0.16,0,W*0.32,H*0.05,H*0.012); hctx.fill();
  hctx.fillStyle='rgba(150,160,180,0.12)'; hctx.fillRect(-W*0.16,H*0.044,W*0.32,Math.max(1,H*0.004));
  hctx.restore();
  // right wing mirror out on the door (RHD driver side)
  hctx.fillStyle='#0c0e13'; roundRect(W*0.885,H*0.315,W*0.105,H*0.075,H*0.014); hctx.fill();
  const wm=hctx.createLinearGradient(0,H*0.32,0,H*0.39); wm.addColorStop(0,'#2c4a6a'); wm.addColorStop(1,'#0e1826');
  hctx.fillStyle=wm; roundRect(W*0.893,H*0.322,W*0.089,H*0.061,H*0.01); hctx.fill();
  hctx.fillStyle='rgba(90,95,104,0.9)'; hctx.fillRect(W*0.893,H*0.362,W*0.089,H*0.021);   // road in the mirror
  // door card + window sill sliver along the right edge
  hctx.fillStyle='#0e1016';
  hctx.beginPath(); hctx.moveTo(W,H*0.42); hctx.lineTo(W*0.945,H*0.50); hctx.lineTo(W*0.945,H); hctx.lineTo(W,H); hctx.closePath(); hctx.fill();
  hctx.fillStyle='rgba(150,160,180,0.15)'; hctx.fillRect(W*0.945,H*0.50,Math.max(1,W*0.004),H*0.5);

  if (VAN){ drawVanDash(W,H,sp,steer,kmh,Min); return; }

  // ============================ DASHBOARD ============================
  const dashTop=H*0.70;   // cowl top — leaves the road / bonnet visible above
  // wiper blades parked low across the bottom of the glass (just above the cowl)
  hctx.strokeStyle='rgba(16,18,24,0.85)'; hctx.lineWidth=Math.max(2,H*0.0045); hctx.lineCap='round';
  hctx.beginPath(); hctx.moveTo(W*0.20,dashTop+H*0.01); hctx.lineTo(W*0.50,dashTop-H*0.14); hctx.stroke();
  hctx.beginPath(); hctx.moveTo(W*0.55,dashTop+H*0.01); hctx.lineTo(W*0.80,dashTop-H*0.12); hctx.stroke();
  // padded cowl, humped toward the driver (right) binnacle
  hctx.save();
  hctx.beginPath();
  hctx.moveTo(0,H); hctx.lineTo(0,dashTop+H*0.06);
  hctx.quadraticCurveTo(W*0.32, dashTop+H*0.02, W*0.62, dashTop+H*0.015);
  hctx.quadraticCurveTo(W*0.80, dashTop-H*0.055, W, dashTop+H*0.02);
  hctx.lineTo(W,H); hctx.closePath();
  const dg=hctx.createLinearGradient(0,dashTop-H*0.06,0,H);
  dg.addColorStop(0,'#2a2e37'); dg.addColorStop(0.18,'#171a21'); dg.addColorStop(1,'#070809');
  hctx.fillStyle=dg; hctx.fill();
  // contrast-stitch seam along the cowl crest
  hctx.lineWidth=Math.max(1.4,H*0.0022); hctx.strokeStyle='rgba(168,134,96,0.55)'; hctx.setLineDash([6,5]);
  hctx.stroke(); hctx.setLineDash([]);
  hctx.restore();
  // brushed trim accent strip spanning the dash face
  let tg=hctx.createLinearGradient(0,0,W,0);
  tg.addColorStop(0,'#3a3f49'); tg.addColorStop(0.5,'#6b7280'); tg.addColorStop(1,'#2c313a');
  hctx.fillStyle=tg; hctx.fillRect(W*0.04,dashTop+H*0.075,W*0.92,Math.max(2,H*0.006));

  // air vent helper (rounded housing + horizontal louvres)
  const vent=(x,y,w,h)=>{
    hctx.fillStyle='#0c0e12'; roundRect(x,y,w,h,h*0.28); hctx.fill();
    hctx.lineWidth=Math.max(1,h*0.06); hctx.strokeStyle='rgba(120,132,150,0.4)'; roundRect(x,y,w,h,h*0.28); hctx.stroke();
    hctx.strokeStyle='rgba(95,105,120,0.6)'; hctx.lineWidth=Math.max(1,h*0.05);
    for (let i=1;i<5;i++){ const yy=y+h*i/5; hctx.beginPath(); hctx.moveTo(x+w*0.1,yy); hctx.lineTo(x+w*0.9,yy); hctx.stroke(); }
  };
  vent(W*0.05, dashTop+H*0.10, W*0.16, H*0.06);          // far-left (passenger) vent
  vent(W*0.41, dashTop+H*0.135, W*0.16, H*0.055);        // centre vent

  // centre-console infotainment / nav screen (passenger-centre)
  const sx=W*0.235, sy=dashTop+H*0.10, sw=W*0.30, sh=H*0.115;
  hctx.fillStyle='#04060a'; roundRect(sx,sy,sw,sh,H*0.012); hctx.fill();
  hctx.lineWidth=Math.max(1.5,H*0.003); hctx.strokeStyle='rgba(120,138,165,0.45)'; roundRect(sx,sy,sw,sh,H*0.012); hctx.stroke();
  hctx.save(); roundRect(sx,sy,sw,sh,H*0.012); hctx.clip();
  // faux sat-nav route line
  hctx.strokeStyle='rgba(40,210,170,0.85)'; hctx.lineWidth=Math.max(2,H*0.004); hctx.lineCap='round';
  hctx.beginPath(); hctx.moveTo(sx+sw*0.18,sy+sh*0.92); hctx.lineTo(sx+sw*0.34,sy+sh*0.52);
  hctx.lineTo(sx+sw*0.52,sy+sh*0.58); hctx.lineTo(sx+sw*0.66,sy+sh*0.2); hctx.lineTo(sx+sw*0.86,sy+sh*0.26); hctx.stroke();
  hctx.fillStyle='rgba(40,210,170,0.9)'; hctx.beginPath(); hctx.arc(sx+sw*0.18,sy+sh*0.92,Math.max(2,H*0.005),0,6.28); hctx.fill();
  // header + readouts
  hctx.textAlign='left'; hctx.textBaseline='alphabetic';
  hctx.fillStyle='#8fb0c8'; hctx.font=`700 ${Math.round(sh*0.18)}px Arial`;
  hctx.fillText((G.circuit&&G.circuit.name||'CIRCUIT').toUpperCase(), sx+sw*0.06, sy+sh*0.26);
  hctx.fillStyle='#e9eef5'; hctx.font=`900 ${Math.round(sh*0.34)}px Arial`;
  hctx.fillText(kmh+' ', sx+sw*0.06, sy+sh*0.66);
  hctx.fillStyle='#8fb0c8'; hctx.font=`700 ${Math.round(sh*0.15)}px Arial`;
  hctx.fillText('KM/H', sx+sw*0.06, sy+sh*0.82);
  hctx.textAlign='right';
  hctx.fillStyle='#ffd24a'; hctx.font=`900 ${Math.round(sh*0.2)}px Arial`;
  hctx.fillText('LAP '+Math.min(G.lap,(G.circuit&&G.circuit.laps)||G.lap)+'/'+((G.circuit&&G.circuit.laps)||'-'), sx+sw*0.94, sy+sh*0.84);
  hctx.restore();
  hctx.textAlign='center'; hctx.textBaseline='middle';

  // centre-console gear selector knob (between the seats)
  hctx.fillStyle='#101216'; roundRect(W*0.40, H*0.92, W*0.16, H*0.07, H*0.014); hctx.fill();
  hctx.fillStyle='#1c2029'; hctx.beginPath(); hctx.arc(W*0.48, H*0.955, Min*0.028, 0, 6.28); hctx.fill();
  hctx.fillStyle='#cdd4de'; hctx.font=`900 ${Math.round(Min*0.03)}px Arial`;
  hctx.fillText('D', W*0.48, H*0.955);

  // ===================== DRIVER BINNACLE (right, RHD) =====================
  const bx=W*0.72;                                       // driver sits on the right
  // anti-glare hood arcing over the instrument cluster
  hctx.fillStyle='#0d0f14';
  hctx.beginPath();
  hctx.moveTo(bx-W*0.22, dashTop+H*0.012);
  hctx.quadraticCurveTo(bx, dashTop-H*0.085, bx+W*0.22, dashTop+H*0.012);
  hctx.quadraticCurveTo(bx, dashTop-H*0.038, bx-W*0.22, dashTop+H*0.012);
  hctx.closePath(); hctx.fill();
  hctx.fillStyle='rgba(5,6,9,0.94)';
  roundRect(bx-W*0.205, dashTop-H*0.015, W*0.41, H*0.165, H*0.022); hctx.fill();
  hctx.lineWidth=Math.max(1.5,H*0.003); hctx.strokeStyle='rgba(120,132,150,0.3)';
  roundRect(bx-W*0.205, dashTop-H*0.015, W*0.41, H*0.165, H*0.022); hctx.stroke();
  const gy=dashTop+H*0.055, gr=Min*0.078;
  drawDial(bx-W*0.092, gy, gr, Math.max(0,Math.min(1,G.rpm||sp)), {ticks:10, major:1, redFrom:0.8, label:'RPM'});
  drawDial(bx+W*0.092, gy, gr, Math.min(1,kmh/340), {ticks:8, major:2, value:kmh, label:'KM/H'});
  // shift light between the gauges — flares as the revs hit the redline
  const shift = (G.rpm||sp)>0.90;
  hctx.fillStyle = shift ? '#ff2a2a' : '#3a1414';
  hctx.beginPath(); hctx.arc(bx, gy-gr*0.62, gr*0.16, 0, 6.28); hctx.fill();
  if (shift){ hctx.fillStyle='rgba(255,60,60,0.35)'; hctx.beginPath(); hctx.arc(bx, gy-gr*0.62, gr*0.34, 0, 6.28); hctx.fill(); }
  // gear badge under the shift light
  hctx.fillStyle='#cdd4de'; hctx.font=`900 ${Math.round(gr*0.32)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='middle';
  hctx.fillText(String(G.gear||1), bx, gy+gr*0.35);   // current gear

  // ===================== STEERING WHEEL (right, RHD) =====================
  // modern flat-bottom (D-cut) racing wheel — compact, on the right.
  const cx=bx, cy=H*1.0, R=Min*0.175;
  // indicator + wiper stalks poking out from the column behind the wheel
  hctx.strokeStyle='#14161c'; hctx.lineCap='round'; hctx.lineWidth=Math.max(4,Min*0.015);
  hctx.beginPath(); hctx.moveTo(cx-Min*0.05, cy-R*0.62); hctx.lineTo(cx-Min*0.19, cy-R*0.86); hctx.stroke();
  hctx.beginPath(); hctx.moveTo(cx+Min*0.05, cy-R*0.56); hctx.lineTo(cx+Min*0.185, cy-R*0.78); hctx.stroke();
  hctx.fillStyle='#1d212b';
  hctx.beginPath(); hctx.arc(cx-Min*0.19, cy-R*0.86, Min*0.011, 0, 6.28); hctx.fill();
  hctx.beginPath(); hctx.arc(cx+Min*0.185, cy-R*0.78, Min*0.011, 0, 6.28); hctx.fill();
  hctx.save();
  hctx.translate(cx,cy); hctx.rotate(steer*0.55);
  hctx.lineCap='round'; hctx.lineJoin='round';
  // D-shaped rim outline (flat bottom)
  const flatY=R*0.66, fx=Math.sqrt(Math.max(0,R*R-flatY*flatY));
  const aL=Math.atan2(flatY,-fx), aR=Math.atan2(flatY,fx);
  const rimPath=()=>{ hctx.beginPath(); hctx.moveTo(-fx,flatY); hctx.arc(0,0,R,aL,aR,false); hctx.closePath(); };
  // outer rim: dark base then a thin brushed-metal highlight on the inner edge
  rimPath(); hctx.lineWidth=Math.max(7,R*0.20); hctx.strokeStyle='#0a0b0f'; hctx.stroke();
  const rg=hctx.createLinearGradient(0,-R,0,flatY);
  rg.addColorStop(0,'#3a3f4a'); rg.addColorStop(0.5,'#202329'); rg.addColorStop(1,'#101216');
  rimPath(); hctx.lineWidth=Math.max(4,R*0.12); hctx.strokeStyle=rg; hctx.stroke();
  rimPath(); hctx.lineWidth=Math.max(1.5,R*0.02); hctx.strokeStyle='rgba(150,165,190,0.30)'; hctx.stroke();
  // thumb grips at ~10 and 2 o'clock (modern moulded bulges)
  hctx.fillStyle='#15171d';
  for (const s of [-1,1]){
    const a=-Math.PI/2 + s*0.7;
    hctx.beginPath(); hctx.ellipse(Math.cos(a)*R, Math.sin(a)*R, R*0.12, R*0.18, a, 0, Math.PI*2); hctx.fill();
  }
  // spokes: two horizontal (3 & 9, swept slightly down) + a single bottom stem
  hctx.strokeStyle='#1b1e25'; hctx.lineCap='butt';
  hctx.lineWidth=R*0.30;
  for (const s of [-1,1]){ hctx.beginPath(); hctx.moveTo(0,R*0.04); hctx.lineTo(s*R*0.86, R*0.30); hctx.stroke(); }
  hctx.lineWidth=R*0.26; hctx.beginPath(); hctx.moveTo(0,R*0.10); hctx.lineTo(0,flatY); hctx.stroke();
  // central boss — rounded square housing with a red badge and trim ring
  hctx.fillStyle='#1c1f26'; roundRect(-R*0.34,-R*0.30,R*0.68,R*0.62,R*0.14); hctx.fill();
  hctx.lineWidth=Math.max(1.5,R*0.025); hctx.strokeStyle='rgba(150,165,190,0.35)';
  roundRect(-R*0.34,-R*0.30,R*0.68,R*0.62,R*0.14); hctx.stroke();
  // multifunction buttons on the spokes (silver pills)
  hctx.fillStyle='#cfd5df';
  for (const s of [-1,1]){ roundRect(s*R*0.50-R*0.10, R*0.16, R*0.20, R*0.10, R*0.05); hctx.fill(); }
  // brand badge
  hctx.fillStyle='#d6262b'; hctx.beginPath(); hctx.arc(0,0,R*0.13,0,Math.PI*2); hctx.fill();
  hctx.fillStyle='#0c0d11'; hctx.font=`900 ${Math.round(R*0.16)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='middle';
  hctx.fillText('GT', 0, R*0.01);
  // 12 o'clock centre marker (motorsport stripe)
  hctx.fillStyle='#d6262b'; roundRect(-R*0.045,-R-R*0.05, R*0.09, R*0.16, R*0.02); hctx.fill();
  // driver's gloved hands at 9 & 3 — they grip the rim and turn with the wheel
  for (const s of [-1,1]){
    hctx.save(); hctx.translate(s*R,0);
    // racing-suit sleeve reaching up from below
    hctx.fillStyle='#0d0e13';
    hctx.beginPath(); hctx.ellipse(s*R*0.32, R*0.62, R*0.20, R*0.50, s*0.35, 0, 6.28); hctx.fill();
    // palm wrapped around the rim
    hctx.fillStyle='#101014';
    hctx.beginPath(); hctx.ellipse(0,0,R*0.145,R*0.27,0,0,6.28); hctx.fill();
    // fingers curling over the inner face of the rim
    hctx.fillStyle='#191922';
    for (let k=0;k<4;k++){ const fy=-R*0.185+k*R*0.12;
      hctx.beginPath(); hctx.ellipse(-s*R*0.105,fy,R*0.075,R*0.052,0,0,6.28); hctx.fill(); }
    // thumb hooked over the top inside
    hctx.beginPath(); hctx.ellipse(-s*R*0.10,-R*0.20,R*0.05,R*0.095,s*0.55,0,6.28); hctx.fill();
    // glove knuckle highlight
    hctx.fillStyle='rgba(120,128,148,0.18)';
    hctx.beginPath(); hctx.ellipse(s*R*0.04,-R*0.04,R*0.055,R*0.14,0,0,6.28); hctx.fill();
    hctx.restore();
  }
  hctx.restore();
  // cabin ambient shadow — the corners darken so the frame reads as "inside"
  const vg=hctx.createRadialGradient(W*0.5,H*0.52,Min*0.46,W*0.5,H*0.60,Min*1.05);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,0.38)');
  hctx.fillStyle=vg; hctx.fillRect(0,0,W,H);
}
// ---- photoreal V-Class dashboard: the owner's real interior photo is
//      composited as the dash (windscreen punched out so the 3D world shows
//      through), with a live rotating wheel, cluster needles and screen
//      content drawn on top. Falls back to the procedural dash until loaded.
function drawVanDash(W,H,sp,steer,kmh,Min){
  const dashTop=H*0.64;                                  // the van dash sits tall and deep
  // wipers parked on the glass
  hctx.strokeStyle='rgba(16,18,24,0.85)'; hctx.lineWidth=Math.max(2,H*0.0045); hctx.lineCap='round';
  hctx.beginPath(); hctx.moveTo(W*0.22,dashTop+H*0.005); hctx.lineTo(W*0.5,dashTop-H*0.12); hctx.stroke();
  hctx.beginPath(); hctx.moveTo(W*0.56,dashTop+H*0.005); hctx.lineTo(W*0.80,dashTop-H*0.10); hctx.stroke();
  // deep soft-touch dash top with a stitched leading edge
  hctx.beginPath();
  hctx.moveTo(0,H); hctx.lineTo(0,dashTop+H*0.02);
  hctx.quadraticCurveTo(W*0.5, dashTop-H*0.045, W, dashTop+H*0.02);
  hctx.lineTo(W,H); hctx.closePath();
  const dg=hctx.createLinearGradient(0,dashTop-H*0.04,0,H);
  dg.addColorStop(0,'#2e3138'); dg.addColorStop(0.16,'#1a1c21'); dg.addColorStop(1,'#08090b');
  hctx.fillStyle=dg; hctx.fill();
  hctx.lineWidth=Math.max(1.4,H*0.0022); hctx.strokeStyle='rgba(120,126,138,0.5)'; hctx.setLineDash([5,5]);
  hctx.beginPath(); hctx.moveTo(0,dashTop+H*0.025); hctx.quadraticCurveTo(W*0.5, dashTop-H*0.04, W, dashTop+H*0.025); hctx.stroke();
  hctx.setLineDash([]);
  // burl-wood trim band sweeping the full width
  const wy=dashTop+H*0.075, wh=H*0.085;
  hctx.save();
  hctx.beginPath();
  hctx.moveTo(0,wy); hctx.quadraticCurveTo(W*0.5, wy-H*0.03, W, wy);
  hctx.lineTo(W,wy+wh); hctx.quadraticCurveTo(W*0.5, wy+wh-H*0.03, 0, wy+wh);
  hctx.closePath();
  const wg=hctx.createLinearGradient(0,wy-H*0.03,0,wy+wh);
  wg.addColorStop(0,'#5a4026'); wg.addColorStop(0.45,'#392715'); wg.addColorStop(0.75,'#4c341d'); wg.addColorStop(1,'#221606');
  hctx.fillStyle=wg; hctx.fill();
  hctx.clip();
  hctx.globalAlpha=0.35; hctx.strokeStyle='#8a5a34'; hctx.lineWidth=1.4;
  for (let r=0;r<7;r++){ hctx.beginPath();
    for (let px=0;px<=W;px+=24){ const yy=wy+wh*(0.14+r*0.13)+Math.sin(px*0.012+r*2.1)*3.2; px===0?hctx.moveTo(px,yy):hctx.lineTo(px,yy); }
    hctx.stroke(); }
  hctx.globalAlpha=1; hctx.restore();
  hctx.lineWidth=Math.max(1.5,H*0.003); hctx.strokeStyle='rgba(200,206,214,0.55)';
  hctx.beginPath(); hctx.moveTo(0,wy); hctx.quadraticCurveTo(W*0.5, wy-H*0.03, W, wy); hctx.stroke();
  // round turbine vents set into the wood (chrome ring + radial louvres)
  const vent=(cx,cy,r)=>{
    hctx.fillStyle='#0c0e12'; hctx.beginPath(); hctx.arc(cx,cy,r,0,6.28); hctx.fill();
    hctx.lineWidth=Math.max(2,r*0.16); hctx.strokeStyle='#c9cfd7'; hctx.beginPath(); hctx.arc(cx,cy,r,0,6.28); hctx.stroke();
    hctx.strokeStyle='#3a3f47'; hctx.lineWidth=Math.max(1,r*0.09);
    for (let k=0;k<8;k++){ const a=k/8*6.28+0.4; hctx.beginPath(); hctx.moveTo(cx+Math.cos(a)*r*0.25,cy+Math.sin(a)*r*0.25); hctx.lineTo(cx+Math.cos(a+0.5)*r*0.86,cy+Math.sin(a+0.5)*r*0.86); hctx.stroke(); }
    hctx.fillStyle='#1d2129'; hctx.beginPath(); hctx.arc(cx,cy,r*0.2,0,6.28); hctx.fill();
  };
  const vr=Min*0.036, vy=wy+wh*0.42;
  vent(W*0.06,vy,vr); vent(W*0.24,vy,vr); vent(W*0.415,vy,vr); vent(W*0.585,vy,vr); vent(W*0.945,vy,vr);
  // tablet-style infotainment screen STANDING on the dash top (silver frame)
  { const sw=W*0.20, sh=H*0.105, sx=W*0.5-sw/2, sy=dashTop-H*0.075;
    hctx.fillStyle='#b9bec6'; roundRect(sx-W*0.008,sy-H*0.008,sw+W*0.016,sh+H*0.016,H*0.012); hctx.fill();
    hctx.fillStyle='#04060a'; roundRect(sx,sy,sw,sh,H*0.008); hctx.fill();
    hctx.save(); roundRect(sx,sy,sw,sh,H*0.008); hctx.clip();
    hctx.strokeStyle='rgba(40,210,170,0.85)'; hctx.lineWidth=Math.max(2,H*0.004); hctx.lineCap='round';
    hctx.beginPath(); hctx.moveTo(sx+sw*0.14,sy+sh*0.88); hctx.lineTo(sx+sw*0.36,sy+sh*0.44);
    hctx.lineTo(sx+sw*0.55,sy+sh*0.56); hctx.lineTo(sx+sw*0.85,sy+sh*0.2); hctx.stroke();
    hctx.fillStyle='#e9eef5'; hctx.font=`900 ${Math.round(sh*0.30)}px Arial`; hctx.textAlign='left'; hctx.textBaseline='alphabetic';
    hctx.fillText(kmh, sx+sw*0.08, sy+sh*0.36);
    hctx.fillStyle='#8fb0c8'; hctx.font=`700 ${Math.round(sh*0.15)}px Arial`;
    hctx.fillText('KM/H · '+(G.circuit&&G.circuit.name||''), sx+sw*0.08, sy+sh*0.55);
    hctx.restore();
    hctx.fillStyle='#9aa0a8'; hctx.fillRect(W*0.5-W*0.012, sy+sh+H*0.008, W*0.024, H*0.012); }   // stand
  // wood centre console sweeping down in a V, with the COMAND touchpad
  hctx.beginPath();
  hctx.moveTo(W*0.415,wy+wh); hctx.lineTo(W*0.585,wy+wh);
  hctx.lineTo(W*0.64,H); hctx.lineTo(W*0.36,H); hctx.closePath();
  const cg=hctx.createLinearGradient(0,wy+wh,0,H);
  cg.addColorStop(0,'#3c2915'); cg.addColorStop(0.5,'#31200f'); cg.addColorStop(1,'#1c1108');
  hctx.fillStyle=cg; hctx.fill();
  hctx.strokeStyle='rgba(200,206,214,0.4)'; hctx.lineWidth=Math.max(1.5,H*0.0025); hctx.stroke();
  // silver climate button strips on the console face (under the centre vents)
  hctx.textAlign='center'; hctx.textBaseline='middle';
  for (const byy of [wy+wh+H*0.022, wy+wh+H*0.056]){
    hctx.fillStyle='#c3c8d0'; roundRect(W*0.425, byy, W*0.15, H*0.022, H*0.009); hctx.fill();
    hctx.fillStyle='#5a5f68';
    for (let k=0;k<5;k++) hctx.fillRect(W*0.437+k*W*0.028, byy+H*0.006, W*0.016, H*0.010);
  }
  hctx.fillStyle='#b9bec6'; roundRect(W*0.455, H*0.87, W*0.09, H*0.055, H*0.012); hctx.fill();     // touchpad
  hctx.fillStyle='#1c2029'; hctx.beginPath(); hctx.arc(W*0.5, H*0.965, Min*0.026, 0, 6.28); hctx.fill();
  hctx.lineWidth=Math.max(2,Min*0.006); hctx.strokeStyle='#c9cfd7'; hctx.beginPath(); hctx.arc(W*0.5, H*0.965, Min*0.026, 0, 6.28); hctx.stroke();   // rotary
  // ---- driver cluster (right): hooded twin dials + centre info screen ----
  const bx=W*0.75;
  hctx.fillStyle='#0d0f14';
  hctx.beginPath(); hctx.moveTo(bx-W*0.185, dashTop+H*0.012);
  hctx.quadraticCurveTo(bx, dashTop-H*0.075, bx+W*0.185, dashTop+H*0.012);
  hctx.quadraticCurveTo(bx, dashTop-H*0.03, bx-W*0.185, dashTop+H*0.012); hctx.closePath(); hctx.fill();
  hctx.fillStyle='rgba(5,6,9,0.94)';
  roundRect(bx-W*0.175, dashTop-H*0.008, W*0.35, H*0.135, H*0.02); hctx.fill();
  const gy=dashTop+H*0.052, gr=Min*0.062;
  drawDial(bx-W*0.105, gy, gr, Math.max(0,Math.min(1,G.rpm||sp)), {ticks:10, major:1, redFrom:0.8, label:'RPM'});
  drawDial(bx+W*0.105, gy, gr, Math.min(1,kmh/340), {ticks:8, major:2, value:kmh, label:'KM/H'});
  hctx.fillStyle='#0a1220'; roundRect(bx-W*0.036, gy-gr*0.55, W*0.072, gr*1.1, H*0.008); hctx.fill();   // centre info screen
  hctx.fillStyle='#7ad7ff'; hctx.font=`900 ${Math.round(gr*0.42)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='middle';
  hctx.fillText('D'+(G.gear||1), bx, gy-gr*0.14);
  hctx.fillStyle='#cdd4de'; hctx.font=`700 ${Math.round(gr*0.26)}px Arial`;
  hctx.fillText('LAP '+Math.min(G.lap,(G.circuit&&G.circuit.laps)||G.lap)+'/'+((G.circuit&&G.circuit.laps)||'-'), bx, gy+gr*0.3);
  // ---- the three-spoke Mercedes wheel (round rim, star on the boss) ----
  const cx=bx, cy=H*1.0, R=Min*0.25;
  hctx.save(); hctx.translate(cx,cy); hctx.rotate(steer*0.55);
  hctx.lineCap='round';
  hctx.lineWidth=Math.max(7,R*0.21); hctx.strokeStyle='#0a0b0f';
  hctx.beginPath(); hctx.arc(0,0,R,0,6.28); hctx.stroke();
  const rg=hctx.createLinearGradient(0,-R,0,R);
  rg.addColorStop(0,'#34383f'); rg.addColorStop(0.5,'#1c1f24'); rg.addColorStop(1,'#101216');
  hctx.lineWidth=Math.max(4,R*0.13); hctx.strokeStyle=rg;
  hctx.beginPath(); hctx.arc(0,0,R,0,6.28); hctx.stroke();
  // spokes: two horizontal + one down, with silver multifunction pods
  hctx.strokeStyle='#1b1e25'; hctx.lineCap='butt'; hctx.lineWidth=R*0.26;
  for (const s2 of [-1,1]){ hctx.beginPath(); hctx.moveTo(0,0); hctx.lineTo(s2*R*0.9, R*0.06); hctx.stroke(); }
  hctx.lineWidth=R*0.22; hctx.beginPath(); hctx.moveTo(0,R*0.1); hctx.lineTo(0,R*0.9); hctx.stroke();
  hctx.fillStyle='#c3c8d0';
  for (const s2 of [-1,1]){ roundRect(s2*R*0.52-R*0.11, -R*0.09, R*0.22, R*0.18, R*0.05); hctx.fill(); }
  // boss with the three-pointed star
  hctx.fillStyle='#15181e'; hctx.beginPath(); hctx.arc(0,0,R*0.30,0,6.28); hctx.fill();
  hctx.lineWidth=Math.max(1.5,R*0.03); hctx.strokeStyle='#c9cfd7';
  hctx.beginPath(); hctx.arc(0,0,R*0.21,0,6.28); hctx.stroke();
  for (let k=0;k<3;k++){ const a=-Math.PI/2 + k*Math.PI*2/3;
    hctx.beginPath(); hctx.moveTo(0,0); hctx.lineTo(Math.cos(a)*R*0.21, Math.sin(a)*R*0.21); hctx.stroke(); }
  // driver's hands at 9 & 3 (turn with the wheel)
  for (const s2 of [-1,1]){
    hctx.save(); hctx.translate(s2*R,0);
    hctx.fillStyle='#0d0e13';
    hctx.beginPath(); hctx.ellipse(s2*R*0.32, R*0.62, R*0.20, R*0.50, s2*0.35, 0, 6.28); hctx.fill();
    hctx.fillStyle='#101014';
    hctx.beginPath(); hctx.ellipse(0,0,R*0.145,R*0.27,0,0,6.28); hctx.fill();
    hctx.fillStyle='#191922';
    for (let k=0;k<4;k++){ const fy=-R*0.185+k*R*0.12;
      hctx.beginPath(); hctx.ellipse(-s2*R*0.105,fy,R*0.075,R*0.052,0,0,6.28); hctx.fill(); }
    hctx.beginPath(); hctx.ellipse(-s2*R*0.10,-R*0.20,R*0.05,R*0.095,s2*0.55,0,6.28); hctx.fill();
    hctx.restore();
  }
  hctx.restore();
  // cabin ambient shadow
  const vg=hctx.createRadialGradient(W*0.5,H*0.5,Min*0.46,W*0.5,H*0.58,Min*1.05);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,0.36)');
  hctx.fillStyle=vg; hctx.fillRect(0,0,W,H);
}
// ---- drawn S-Class cabin (replicates the driver's-seat reference): cream
//      leather, centred wheel with star, widescreen cluster, portrait OLED
//      screen, chrome vents, blue ambient light, door card at right. ----
function drawSedanDash(W,H,sp,steer,kmh,Min){
  const dashTop=H*0.52;
  // upper dash cowl (near-black, soft sheen)
  hctx.beginPath();
  hctx.moveTo(0,H); hctx.lineTo(0,dashTop+H*0.06);
  hctx.quadraticCurveTo(W*0.5, dashTop-H*0.075, W, dashTop+H*0.015);
  hctx.lineTo(W,H); hctx.closePath();
  const dg=hctx.createLinearGradient(0,dashTop-H*0.07,0,H);
  dg.addColorStop(0,'#23252c'); dg.addColorStop(0.2,'#131419'); dg.addColorStop(1,'#07080b');
  hctx.fillStyle=dg; hctx.fill();
  // blue ambient light line along the dash crest
  hctx.save(); hctx.shadowColor='#2e6cff'; hctx.shadowBlur=Math.max(6,Min*0.02);
  hctx.strokeStyle='rgba(70,130,255,0.9)'; hctx.lineWidth=Math.max(1.5,Min*0.005);
  hctx.beginPath(); hctx.moveTo(0,dashTop+H*0.075);
  hctx.quadraticCurveTo(W*0.5, dashTop-H*0.055, W, dashTop+H*0.03); hctx.stroke(); hctx.restore();
  // cream lower band (leather knee roll + console)
  const lg=hctx.createLinearGradient(0,H*0.80,0,H);
  lg.addColorStop(0,'#c9bda8'); lg.addColorStop(1,'#8f8471');
  hctx.fillStyle=lg; hctx.fillRect(0,H*0.80,W,H*0.20);
  hctx.fillStyle='rgba(0,0,0,0.18)'; hctx.fillRect(0,H*0.80,W,Math.max(1.5,H*0.004));
  // chrome vent bank (upper left)
  for (let k=0;k<4;k++){ const vx=W*(0.095+k*0.062), vy=dashTop+H*0.012, vw=W*0.052, vh=H*0.030;
    hctx.fillStyle='#c9cfd7'; roundRect(vx,vy,vw,vh,vh*0.4); hctx.fill();
    hctx.fillStyle='#14161b'; roundRect(vx+vw*0.07,vy+vh*0.18,vw*0.86,vh*0.64,vh*0.3); hctx.fill();
    hctx.strokeStyle='#9aa2ac'; hctx.lineWidth=Math.max(1,vh*0.09);
    hctx.beginPath(); hctx.moveTo(vx+vw*0.12,vy+vh*0.5); hctx.lineTo(vx+vw*0.88,vy+vh*0.5); hctx.stroke(); }
  // portrait OLED screen (left) with live content
  { const sx=W*0.115, sy=dashTop+H*0.045, sw=W*0.175, sh=H*0.30;
    hctx.fillStyle='#04060a'; roundRect(sx,sy,sw,sh,Min*0.02); hctx.fill();
    hctx.lineWidth=Math.max(1.5,Min*0.004); hctx.strokeStyle='rgba(120,138,165,0.5)'; roundRect(sx,sy,sw,sh,Min*0.02); hctx.stroke();
    hctx.save(); roundRect(sx,sy,sw,sh,Min*0.02); hctx.clip();
    hctx.strokeStyle='rgba(40,210,170,0.85)'; hctx.lineWidth=Math.max(2,sh*0.012); hctx.lineCap='round';
    hctx.beginPath(); hctx.moveTo(sx+sw*0.16,sy+sh*0.62); hctx.lineTo(sx+sw*0.38,sy+sh*0.40);
    hctx.lineTo(sx+sw*0.56,sy+sh*0.48); hctx.lineTo(sx+sw*0.84,sy+sh*0.24); hctx.stroke();
    hctx.textAlign='left'; hctx.textBaseline='alphabetic';
    hctx.fillStyle='#e9eef5'; hctx.font=`900 ${Math.round(sh*0.13)}px Arial`;
    hctx.fillText(kmh, sx+sw*0.10, sy+sh*0.16);
    hctx.fillStyle='#8fb0c8'; hctx.font=`700 ${Math.round(sh*0.055)}px Arial`;
    hctx.fillText('KM/H · D'+(G.gear||1), sx+sw*0.10, sy+sh*0.225);
    hctx.fillStyle='#ffd24a'; hctx.font=`900 ${Math.round(sh*0.055)}px Arial`;
    hctx.fillText('LAP '+Math.min(G.lap,(G.circuit&&G.circuit.laps)||G.lap)+'/'+((G.circuit&&G.circuit.laps)||'-'), sx+sw*0.10, sy+sh*0.80);
    hctx.restore(); hctx.textAlign='center'; hctx.textBaseline='middle'; }
  // door card (right) with wood sliver, speaker and ambient line
  { hctx.fillStyle='#101216';
    hctx.beginPath(); hctx.moveTo(W,H*0.30); hctx.lineTo(W*0.87,H*0.42); hctx.lineTo(W*0.84,H); hctx.lineTo(W,H); hctx.closePath(); hctx.fill();
    const wgd=hctx.createLinearGradient(W*0.86,0,W,0); wgd.addColorStop(0,'#4c341d'); wgd.addColorStop(1,'#2a1b0d');
    hctx.fillStyle=wgd; hctx.beginPath(); hctx.moveTo(W*0.875,H*0.46); hctx.lineTo(W,H*0.36); hctx.lineTo(W,H*0.46); hctx.lineTo(W*0.885,H*0.56); hctx.closePath(); hctx.fill();
    hctx.save(); hctx.shadowColor='#2e6cff'; hctx.shadowBlur=Math.max(5,Min*0.015);
    hctx.strokeStyle='rgba(70,130,255,0.8)'; hctx.lineWidth=Math.max(1.2,Min*0.004);
    hctx.beginPath(); hctx.moveTo(W*0.878,H*0.50); hctx.lineTo(W,H*0.40); hctx.stroke(); hctx.restore();
    hctx.strokeStyle='#8b929c'; hctx.lineWidth=Math.max(1.5,Min*0.005);
    hctx.beginPath(); hctx.arc(W*0.93,H*0.72,Min*0.045,0,6.28); hctx.stroke();
    hctx.fillStyle='#1a1d23'; hctx.beginPath(); hctx.arc(W*0.93,H*0.72,Min*0.04,0,6.28); hctx.fill(); }
  // ---- widescreen cluster behind the wheel (drawn BEFORE it: stays static) ----
  const ccx=W*0.52, cw=W*0.30, ch=H*0.155, cy0=dashTop-H*0.125;
  hctx.fillStyle='#05070d'; roundRect(ccx-cw/2,cy0,cw,ch,Min*0.018); hctx.fill();
  hctx.save(); hctx.shadowColor='#2e6cff'; hctx.shadowBlur=Math.max(4,Min*0.012);
  hctx.strokeStyle='rgba(90,140,255,0.55)'; hctx.lineWidth=Math.max(1.2,Min*0.0035);
  roundRect(ccx-cw/2,cy0,cw,ch,Min*0.018); hctx.stroke(); hctx.restore();
  const dial=(dx,frac,red)=>{ const dr=ch*0.36, dyc=cy0+ch*0.52;
    hctx.strokeStyle='rgba(140,160,200,0.8)'; hctx.lineWidth=Math.max(1.2,dr*0.05);
    hctx.beginPath(); hctx.arc(dx,dyc,dr,Math.PI*0.75,Math.PI*2.25); hctx.stroke();
    for (let i=0;i<=8;i++){ const a=Math.PI*0.75+i/8*Math.PI*1.5;
      hctx.beginPath(); hctx.moveTo(dx+Math.cos(a)*dr*0.86,dyc+Math.sin(a)*dr*0.86);
      hctx.lineTo(dx+Math.cos(a)*dr,dyc+Math.sin(a)*dr); hctx.stroke(); }
    const na=Math.PI*0.75+Math.max(0,Math.min(1,frac))*Math.PI*1.5;
    hctx.strokeStyle=red?'#ff5a3a':'#ffc24a'; hctx.lineWidth=Math.max(2,dr*0.09);
    hctx.beginPath(); hctx.moveTo(dx,dyc); hctx.lineTo(dx+Math.cos(na)*dr*0.9,dyc+Math.sin(na)*dr*0.9); hctx.stroke(); };
  dial(ccx-cw*0.30, Math.max(0,Math.min(1,G.rpm||sp)), true);
  dial(ccx+cw*0.30, Math.min(1,kmh/340), false);
  hctx.fillStyle='#7ad7ff'; hctx.font=`900 ${Math.round(ch*0.26)}px Arial`;
  hctx.fillText('D'+(G.gear||1), ccx, cy0+ch*0.42);
  hctx.fillStyle='#e9eef5'; hctx.font=`900 ${Math.round(ch*0.20)}px Arial`;
  hctx.fillText(kmh, ccx, cy0+ch*0.70);
  // ---- the cream two-spoke wheel, rotating, star on the boss ----
  const cx=ccx, cyw=H*1.04, R=Min*0.34;
  hctx.save(); hctx.translate(cx,cyw); hctx.rotate(steer*0.6);
  hctx.lineCap='round';
  hctx.lineWidth=Math.max(8,R*0.16); hctx.strokeStyle='#8f8471';
  hctx.beginPath(); hctx.arc(0,0,R,0,6.28); hctx.stroke();
  const rg=hctx.createLinearGradient(0,-R,0,R);
  rg.addColorStop(0,'#efe7d8'); rg.addColorStop(0.5,'#d9cdb8'); rg.addColorStop(1,'#b3a48d');
  hctx.lineWidth=Math.max(5,R*0.11); hctx.strokeStyle=rg;
  hctx.beginPath(); hctx.arc(0,0,R,0,6.28); hctx.stroke();
  // twin silver spoke bars + bottom spoke
  hctx.strokeStyle='#b8bec7'; hctx.lineCap='butt'; hctx.lineWidth=R*0.14;
  for (const s2 of [-1,1]){ hctx.beginPath(); hctx.moveTo(s2*R*0.34,0); hctx.lineTo(s2*R*0.92,0); hctx.stroke(); }
  hctx.strokeStyle='#a8aeb7'; hctx.lineWidth=R*0.11;
  hctx.beginPath(); hctx.moveTo(0,R*0.34); hctx.lineTo(0,R*0.92); hctx.stroke();
  // touch pads on the spokes
  hctx.fillStyle='#20232a';
  for (const s2 of [-1,1]){ roundRect(s2*R*0.56-R*0.10,-R*0.055,R*0.20,R*0.11,R*0.03); hctx.fill(); }
  // boss + chrome three-pointed star
  hctx.fillStyle='#15171d'; hctx.beginPath(); hctx.arc(0,0,R*0.30,0,6.28); hctx.fill();
  hctx.lineWidth=Math.max(1.5,R*0.028); hctx.strokeStyle='#cfd5dd';
  hctx.beginPath(); hctx.arc(0,0,R*0.20,0,6.28); hctx.stroke();
  for (let k=0;k<3;k++){ const a=-Math.PI/2+k*Math.PI*2/3;
    hctx.beginPath(); hctx.moveTo(0,0); hctx.lineTo(Math.cos(a)*R*0.20,Math.sin(a)*R*0.20); hctx.stroke(); }
  hctx.restore();
  // cabin lighting follows the world + ambient vignette
  if (G.night){ hctx.fillStyle='rgba(6,8,16,0.42)'; hctx.fillRect(0,dashTop-H*0.13,W,H); }
  else if (G.sunset){ hctx.fillStyle='rgba(120,60,20,0.13)'; hctx.fillRect(0,dashTop-H*0.13,W,H); }
  const vg=hctx.createRadialGradient(W*0.5,H*0.48,Min*0.5,W*0.5,H*0.6,Min*1.08);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,0.34)');
  hctx.fillStyle=vg; hctx.fillRect(0,0,W,H);
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
  drawConfetti(W,H);           // victory shower (active only after a win)
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
  // needle follows engine RPM (dips through each upshift)
  const na=lerp(a0,a1,Math.max(0,Math.min(1,(G.state==='racing'||G.state==='rolling')?G.rpm:sp)));
  hctx.strokeStyle='#ffd400'; hctx.lineWidth=Math.max(3,gr*0.08);
  hctx.beginPath(); hctx.moveTo(gx,gy); hctx.lineTo(gx+Math.cos(na)*gr*0.92, gy+Math.sin(na)*gr*0.92); hctx.stroke();
  hctx.fillStyle='#ffd400'; hctx.beginPath(); hctx.arc(gx,gy,gr*0.1,0,6.28); hctx.fill();
  // tick numbers
  hctx.fillStyle='#fff'; hctx.font=`bold ${Math.max(7,gr*0.2)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='middle';
  for (let i=0;i<=ticks;i++){ const a=lerp(a0,a1,i/ticks); hctx.fillText(String(i), gx+Math.cos(a)*gr*1.28, gy+Math.sin(a)*gr*1.28); }
  // speed number
  const kmh=Math.round(Math.abs(G.speed)*2.4);
  hctx.fillStyle='#ffd400'; hctx.font=`900 ${Math.round(gr*0.3)}px Arial`;
  hctx.fillText('G'+(G.gear||1), gx+gr*0.85, gy+gr*0.35);          // current gear
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

// ---- Bluetooth / USB controller support (Gamepad API, standard mapping) ----
// Xbox / PlayStation / MFi pads: left stick or d-pad steers (ANALOG), RT/R2
// gas + LT/L2 brake (analog triggers), A/Cross gas, B/Circle brake, X/Square
// or RB nitro, Y/Triangle camera, Start pauses. Menus navigate with the
// d-pad/stick, A selects, B goes back. Rumble fires with the game's haptics.
let _padOn=false, _padSteerAx=0, _padGasV=0, _padBrakeV=0;
const _padPrev={};
let _padNavIdx=0;
function pollGamepad(){
  if (!navigator.getGamepads) return;
  let gp=null; const list=navigator.getGamepads(); for (const g of list){ if(g){ gp=g; break; } }
  if (!gp){ _padOn=false; _padSteerAx=0; _padGasV=0; _padBrakeV=0; return; }
  const b=gp.buttons, ax=gp.axes;
  const val=i=>(b[i]&&b[i].value)||0;
  const pressed=i=>!!(b[i]&&(b[i].pressed||b[i].value>0.4));
  const rise=(name,on)=>{ const was=_padPrev[name]; _padPrev[name]=on; return on&&!was; };
  // analog steering (deadzoned + rescaled) — d-pad forces full lock
  const lx=ax[0]||0, ly=ax[1]||0;
  _padSteerAx = Math.abs(lx)>0.15 ? Math.max(-1,Math.min(1,(Math.abs(lx)-0.15)/0.8))*Math.sign(lx) : 0;
  if (pressed(14)) _padSteerAx=-1; else if (pressed(15)) _padSteerAx=1;
  _padGasV   = Math.max(val(7), pressed(0)?1:0);      // RT (analog) or A
  _padBrakeV = Math.max(val(6), pressed(1)?1:0);      // LT (analog) or B
  const padLeft  = _padSteerAx<-0.25, padRight=_padSteerAx>0.25;
  const padGas   = _padGasV>0.06, padBrake=_padBrakeV>0.06;
  const padBoost = pressed(2) || pressed(5);          // X or RB
  const aBtn   = rise('a',  pressed(0));
  const bBtn   = rise('bk', pressed(1));
  const stBtn  = rise('st', pressed(9));
  const yBtn   = rise('y',  pressed(3));
  const active = padLeft||padRight||padGas||padBrake||padBoost||aBtn||stBtn;
  if (active && G.state==='attract'){ endAttract(); return; }
  if (active && _onTitle){ armIdle(); }
  // ---- menu navigation: d-pad/stick moves, A selects, B backs out ----
  const overlay=document.getElementById('overlay');
  if (overlay && !overlay.classList.contains('hidden')){
    const items=[...overlay.querySelectorAll('button, .selcard')].filter(e=>e.offsetParent!==null);
    if (items.length){
      const prev = rise('nl', lx<-0.5||pressed(14)) || rise('nu', ly<-0.5||pressed(12));
      const next = rise('nr', lx> 0.5||pressed(15)) || rise('nd', ly> 0.5||pressed(13));
      if (_padNavIdx>=items.length) _padNavIdx=0;
      if (prev) _padNavIdx=(_padNavIdx-1+items.length)%items.length;
      if (next) _padNavIdx=(_padNavIdx+1)%items.length;
      items.forEach((e,i)=>e.classList.toggle('padsel', i===_padNavIdx));
      if (aBtn){ const el=items[_padNavIdx]; _padNavIdx=0; if (el) el.click(); }
      else if (bBtn){ const back=overlay.querySelector('#backBtn')||overlay.querySelector('#amBack')
        ||[...overlay.querySelectorAll('button')].find(e=>/◀/.test(e.textContent)); if (back){ _padNavIdx=0; back.click(); } }
      _padOn=true; return;                            // a menu is up — don't drive
    }
  }
  // Start pauses / resumes; Y cycles the camera
  if (stBtn && (G.state==='racing'||G.state==='paused')) togglePause();
  if (yBtn && (G.state==='racing'||G.state==='replay')) toggleView();
  // ---- race input: write on press, clear on OUR release (keyboard untouched) ----
  if (G.state==='racing'){
    if (padLeft)  keys.left=true;  else if (_padPrev.pl) keys.left=false;
    if (padRight) keys.right=true; else if (_padPrev.pr) keys.right=false;
    if (padGas)   keys.gas=true;   else if (_padPrev.pg) keys.gas=false;
    if (padBrake) keys.brake=true; else if (_padPrev.pb) keys.brake=false;
    if (padBoost) keys.boost=true; else if (_padPrev.px) keys.boost=false;
  }
  _padPrev.pl=padLeft; _padPrev.pr=padRight; _padPrev.pg=padGas; _padPrev.pb=padBrake; _padPrev.px=padBoost;
  _padOn = active;
}
// controller connect/disconnect feedback
try{
  window.addEventListener('gamepadconnected', ()=>{ try{ arcadeCallout('🎮 CONTROLLER CONNECTED', '#7ad7ff', [_NOTE.C5,_NOTE.E5]); }catch(e){} });
  window.addEventListener('gamepaddisconnected', ()=>{ _padOn=false; _padSteerAx=0; _padGasV=0; _padBrakeV=0; });
}catch(e){}
// ---- haptics: phone vibration + controller rumble (both optional) ----
function haptic(ms){
  try{ if (navigator.vibrate) navigator.vibrate(ms); }catch(e){}
  try{
    const dur=Math.min(600, Array.isArray(ms)?ms.reduce((a,b)=>a+b,0):(ms||80));
    const list=navigator.getGamepads?navigator.getGamepads():[];
    for (const g of list){ if (!g) continue; const act=g.vibrationActuator;
      if (act && act.playEffect) act.playEffect(act.type||'dual-rumble', {duration:dur, strongMagnitude:0.7, weakMagnitude:0.4}); }
  }catch(e){}
}

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
  buildRivals(G.timeTrial ? 0 : (MOBILE ? 7 : 9));   // time trial = solo vs your ghost
  G.maxSpeed = G.circuit.maxSpeed * G.vehicle.speedMul * 0.58;   // tuned to feel
  G.dist=0; G.offset=0; G.speed=0; G.lap=1; G.steerVis=0;
  G.gear=1; G.rpm=0.3; G.shiftCut=0; G.drift=0; G.driftVis=0; G.pitchVis=0;
  G.timeLeft=G.timeTrial ? G.circuit.startTime*3 : G.circuit.startTime; G.totalTime=0; G.rollT=0; G.cdNum=-1; G.green=false;
  G.boost=1; G.boostActive=false; G.lapStart=0; G.bestLap=bestLapFor(); G.recordSet=false;   // nitro full + load best lap
  _replay=[]; _recT=0;                                  // fresh replay recording
  _sessionScore=0; _driftActive=0; _driftCombo=1; _driftRun=0;   // fresh drift score
  keys.gas=keys.brake=keys.left=keys.right=keys.boost=false;
  G.view = (G.vehicle && (G.vehicle.kind==='van'||G.vehicle.kind==='sedan')) ? 'dash'
         : (G.view==='cinematic' ? 'chase' : G.view);   // Mercedes start in their cabin
  G.started=true; G.state='rolling';
  _callout=null; _lastPos=1+rivals.length; _lastOvertakeT=-9;   // reset arcade callout state
  initSmoke(); resetSmoke();                          // tyre-smoke pool ready & cleared
  ensureSkids(); resetSkids();                        // fresh rubber for a fresh race
  placeCar(playerCar, G.dist, G.offset);
  placeRivals();
  // snap camera behind the car immediately (world-up)
  const f=frameAt(G.dist); worldPos(G.dist,0,_tmp);
  camera.position.copy(_tmp).addScaledVector(f.tan,-11); camera.position.y+=5.2;
  camera.up.set(0,1,0); camera.lookAt(_tmp.clone().addScaledVector(f.tan,16).setY(_tmp.y+4.4));
  // HUD text
  // renderer tag so a screenshot instantly tells us which path is active
  setText('trackName', G.circuit.name+' • '+BUILD.split('—')[0].trim()+(_GPU?' • WEBGPU':' • WEBGL'));
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
function appleActive(){ const st=SOUNDTRACKS[G.soundtrack]; return !!(st && st.apple && window.AppleMusic && window.AppleMusic.authorized); }
function startRaceMusic(){
  stopRaceMusic();
  if (window.GameMusic && window.GameMusic.stop){ try{ window.GameMusic.stop(); }catch(e){} }   // silence procedural menu music
  const sel = SOUNDTRACKS[G.soundtrack] || SOUNDTRACKS.daytona;
  if (appleActive()){   // stream the player's own Apple Music instead of a built-in track
    if (G.applePlaylist) window.AppleMusic.playPlaylist(G.applePlaylist);
    else window.AppleMusic.resume();
    return;
  }
  // the Apple card without a connected account falls back to the arcade theme
  const st = sel.apple ? SOUNDTRACKS.daytona : sel;
  try {
    const loop = new Audio(st.loop); loop.loop=true; loop.volume=0.75;
    if (st.intro){                       // intro once -> loop
      const intro = new Audio(st.intro); intro.volume=0.75;
      intro.addEventListener('ended', ()=>{ try{ loop.currentTime=0; loop.play().catch(()=>{}); }catch(e){} });
      intro.play().catch(()=>{ try{ loop.play().catch(()=>{}); }catch(e){} });   // if intro blocked, go straight to loop
      _raceAudio = { intro, loop };
    } else {                             // loop-only track (full songs)
      loop.play().catch(()=>{});
      _raceAudio = { intro:null, loop };
    }
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
  // RPM follows the real drivetrain when racing (audible gear shifts)
  const rpm  = racing ? (0.10 + Math.max(0,Math.min(1,G.rpm))*0.86)
                      : (0.12 + sp*0.84 + (onGas?0.06:0));
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
// ---- persistent skid marks: a recycled pool of dark strips laid at the rear
//      wheels while drifting. They stay on the track (oldest reused first). ----
const _skBasis=new THREE.Matrix4(), _skPos=new THREE.Vector3();
function ensureSkids(){
  if (_skidGroup){ if(!_skidGroup.parent && scene) scene.add(_skidGroup); return; }
  _skidGroup=new THREE.Group(); _skids=[];
  const N=MOBILE?90:260;
  const geo=new THREE.PlaneGeometry(0.34,2.4);
  const mat=new THREE.MeshBasicMaterial({color:0x0b0b0d, transparent:true, opacity:0.30, depthWrite:false, side:THREE.DoubleSide, fog:true});
  for (let i=0;i<N;i++){ const m=new THREE.Mesh(geo,mat); m.visible=false; m.userData.noShadow=true; _skidGroup.add(m); _skids.push(m); }
  scene.add(_skidGroup);
}
function resetSkids(){ for (const s of _skids) s.visible=false; _skidIdx=0; _lastSkidDist=-9; }
function laySkidMarks(f){
  if (!_skids.length) return;
  const sideD=1.1*CAR_SCALE;
  for (const sx of [-1,1]){
    const m=_skids[_skidIdx]; _skidIdx=(_skidIdx+1)%_skids.length;
    worldPos((G.dist-2.0*CAR_SCALE+trackLen)%trackLen, G.offset+sx*sideD, _skPos);
    m.position.copy(_skPos); m.position.y+=0.07;
    _skBasis.makeBasis(f.right, f.tan, f.up);           // plane lies in the road surface
    m.quaternion.setFromRotationMatrix(_skBasis);
    m.visible=true;
  }
}
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
let _sprayT=0;
// fine misty spray kicked up off the wheels on a wet track
function emitRainSpray(f, speedFrac){
  _sprayT -= _adt; if (_sprayT>0) return;
  _sprayT = 0.05 - speedFrac*0.03;
  worldPos(G.dist, G.offset, _smPos);
  const back=2.4*CAR_SCALE, sideD=1.1*CAR_SCALE;
  for (const sx of [-1,1])
    emitSmoke(_smPos.x - f.tan.x*back + f.right.x*sx*sideD, _smPos.y+0.35,
              _smPos.z - f.tan.z*back + f.right.z*sx*sideD, 0xbcc6d2);   // grey wet mist
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
  daytona: { name:'KING OF SPEED', icon:'🏁', desc:'The real Daytona USA arcade theme', loop:'./audio/king-of-speed.m4a' },
  heat:    { name:'NEW DAWN FADES', icon:'🌘', desc:'Joy Division — your purchased copy', loop:'./audio/new-dawn-fades.m4a' },
  buckrogers:{ name:'BUCK ROGERS', icon:'🚀', desc:'Feeder — your purchased copy', loop:'./audio/buck-rogers.m4a' },
  topgun:  { name:'TOP GUN', icon:'✈️', desc:'Danger Zone — your purchased copy', loop:'./audio/danger-zone.m4a' },
  applemusic:{ name:'APPLE MUSIC', icon:'🍎', desc:'Stream from your library', apple:true },
};
let selApplePlaylist=null, selApplePlaylistName='';
const VEH_ICON = ['🏎️','🏁','⚡','🛞','🗡️','🚐','🚘'];
const CIR_ICON = ['🗽','🎡','🌆','🏜️'];
let selVeh=0, selCir=1, selSnd='daytona', selTod='day', selWx='clear';
const TOD_ITEMS = [{key:'day',icon:'☀️',name:'DAY',desc:'Bright daylight racing'},
                   {key:'night',icon:'🌙',name:'NIGHT',desc:'Neon-lit night with stars'},
                   {key:'sunset',icon:'🌇',name:'SUNSET',desc:'Golden hour, long shadows'}];
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
  const todRoll=Math.random(); G.night = todRoll<0.34; G.sunset = !G.night && todRoll<0.62;
  G.rain = Math.random()<0.4;
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
    ensureSkids(); resetSkids();
    placeCar(playerCar,G.dist,G.offset); placeRivals();
    G.started=true; G.view='cinematic'; cineReset(); G.state='attract';
    hideOverlay();
    const hud=document.getElementById('hud'); if(hud) hud.style.visibility='hidden';
    ['viewBtn','pauseBtn'].forEach(id=>{ const e=document.getElementById(id); if(e){ if(id==='viewBtn')e.classList.add('hidden'); else e.style.display='none'; }});
    const t=document.getElementById('touch'); if(t) t.style.display='none';
    showBanner('APEX <span class="red">GP</span><br><span style="font-size:0.46em;letter-spacing:2px">▶ TAP TO PLAY</span>', 0, true);
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
  showOverlay(`<h1 class="title">APEX <span class="red">GP</span></h1>
    <div class="subtitle">ARCADE CIRCUIT RACING</div>
    <div class="checker" style="width:min(560px,84vw);margin:0 auto 12px"></div>
    <div class="subtitle" style="margin:2px 0 10px;color:#ffd400;font-size:14px">◆ ${_profile.credits.toLocaleString()} CR &nbsp;·&nbsp; ${_profile.races} races &nbsp;·&nbsp; ${_profile.wins} wins</div>
    <div class="menu-card arcade">
      <h2>SELECT RACE MODE</h2>
      <button class="btn" id="startBtn">SINGLE RACE ▶</button>
      <div style="height:8px"></div>
      <button class="btn ghost" id="ttBtn">⏱ TIME TRIAL</button>
      <div style="height:8px"></div>
      <button class="btn ghost" id="gpBtn">🏆 GRAND PRIX</button>
      <div class="flash" style="margin-top:16px;color:#ffd400;letter-spacing:3px;font-weight:900;font-size:14px">◉ FREE PLAY — PRESS START</div>
    </div>
    <div class="checker" style="width:min(560px,84vw);margin:12px auto 0"></div>
    <div class="credit">Fan-made, non-commercial. · ${BUILD}</div>`);
  document.getElementById('startBtn').onclick = ()=>{ try{ensureAudio();}catch(e){} G.champ=null; G.timeTrial=false; showVehicleSelect(); };
  document.getElementById('ttBtn').onclick    = ()=>{ try{ensureAudio();}catch(e){} G.champ=null; G.timeTrial=true; showVehicleSelect(); };
  document.getElementById('gpBtn').onclick    = ()=>{ try{ensureAudio();}catch(e){} G.timeTrial=false; champStart(); showVehicleSelect(); };
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
  wireCards('data-snd', i=>{ selSnd=keys[i]; if (SOUNDTRACKS[selSnd].apple) showAppleMusic(); else showSoundtrackSelect(); });
  wireCards('data-tod', i=>{ selTod=TOD_ITEMS[i].key; showSoundtrackSelect(); });
  wireCards('data-wx',  i=>{ selWx=WX_ITEMS[i].key; showSoundtrackSelect(); });
  document.getElementById('backBtn').onclick = G.champ ? showVehicleSelect : showCircuitSelect;
  document.getElementById('goBtn').onclick=()=>{
    G.vehicle=VEHICLES[selVeh]; G.soundtrack=selSnd; G.applePlaylist=selApplePlaylist;
    G.circuit = G.champ ? CIRCUITS[G.champ.order[G.champ.round]] : CIRCUITS[selCir];
    G.night=(selTod==='night'); G.sunset=(selTod==='sunset'); G.rain=(selWx==='rain');
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
  if (G.state==='racing'){
    G.state='paused'; pauseRaceMusic(true);
    showOverlay(`<h1 class="title">PAUSED</h1>
      <div class="menu-card">
        <button class="btn" id="resumeBtn">▶ RESUME</button>
        <div style="height:8px"></div>
        <button class="btn ghost" id="quitBtn">✕ QUIT TO MENU</button>
      </div>`);
    const r=document.getElementById('resumeBtn'); if(r) r.onclick=togglePause;
    const q=document.getElementById('quitBtn'); if(q) q.onclick=()=>{
      hideBanner(); stopRaceMusic();
      const t=document.getElementById('touch'); if(t) t.style.display='none';
      showMenu();
    };
  }
  else if (G.state==='paused'){
    G.state='racing'; pauseRaceMusic(false); hideOverlay();
    const vb=document.getElementById('viewBtn'); if(vb) vb.classList.remove('hidden');   // showOverlay hid it
  }
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

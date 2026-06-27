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

const BUILD = 'BUILD R17 — prelude removed (single soundtrack)';

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
const CIRCUITS = [
  { name:'DAYTONA', laps:8, maxSpeed:118, curveMul:0.85, aiSpeed:0.74, startTime:60, lapBonus:26, seed:1,  theme:0 },
  { name:'LONDON',  laps:6, maxSpeed:120, curveMul:1.0,  aiSpeed:0.78, startTime:62, lapBonus:30, seed:11, theme:3, layout:LONDON_LAYOUT },
  { name:'DUBAI',   laps:6, maxSpeed:132, curveMul:1.0,  aiSpeed:0.82, startTime:66, lapBonus:30, seed:23, theme:4, layout:DUBAI_LAYOUT },
];
const THEMES = [
  { asphalt:0x83878d, grass:0x4a9c54, grass2:0x3f8f49, mountain:0x8a9099, snow:true,
    prop:'pine', skyline:'mountain', landmark:'usa', buildings:false,
    skyTop:'#1f6fd6', skyMid:'#5aa6f0', skyHorizon:'#dff0ff', fog:0xbfe2ff },
  {},
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
const ROAD_W   = 9;            // road half-width
const RUMBLE_W = 1.6;          // kerb width
const GRASS_W  = ROAD_W * 8;   // grass apron half-extent
const DIV      = 1400;         // track frame samples
const STEP     = 1/60;         // fixed physics timestep
const UP       = new THREE.Vector3(0,1,0);

const MOBILE = (typeof navigator!=='undefined') &&
  (/iPhone|iPad|iPod|Android|Mobi/i.test(navigator.userAgent) ||
   ((navigator.maxTouchPoints||0) > 1 && Math.min(window.innerWidth,window.innerHeight) < 820));

let renderer, scene, camera, sun, sky;
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

const keys = { gas:false, brake:false, left:false, right:false };

const G = {
  state: 'menu',          // menu | rolling | racing | finished
  started: false,
  circuit: CIRCUITS[1],
  vehicle: VEHICLES[1],
  theme: THEMES[3],
  dist: 0, offset: 0, speed: 0, steerVis: 0,
  lap: 1, maxSpeed: 120,
  // race timing / scoring
  timeLeft: 0, totalTime: 0, rollT: 0, cdNum: -1, green: false,
  banner: 0,
};
let rivals = [];

// ----------------------------------------------------------------------------
//  Boot
// ----------------------------------------------------------------------------
function initThree(){
  glCanvas = document.getElementById('gl');
  hud2d    = document.getElementById('hud2d');
  hctx     = hud2d.getContext('2d');

  renderer = new THREE.WebGLRenderer({ canvas:glCanvas, antialias:!MOBILE, powerPreference:'high-performance' });
  renderer.setPixelRatio(Math.min(MOBILE?1.25:2, window.devicePixelRatio||1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = !MOBILE;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Recover from a lost GPU context (iOS Safari can drop it). preventDefault on
  // 'lost' is REQUIRED or the browser never restores it (permanent black screen).
  glCanvas.addEventListener('webglcontextlost', e=>{ e.preventDefault(); _ctxLost=true; }, false);
  glCanvas.addEventListener('webglcontextrestored', ()=>{ _ctxLost=false; resize(); }, false);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fbfff);
  scene.fog = new THREE.Fog(0xbfe2ff, 1100, 3200);

  camera = new THREE.PerspectiveCamera(62, 1, 0.5, 5000);

  scene.add(new THREE.HemisphereLight(0xd7dde4, 0x4a6a3a, 0.5));   // softer, less-blue sky light so flat surfaces aren't washed blue
  scene.add(new THREE.AmbientLight(0xffffff, 0.32));
  sun = new THREE.DirectionalLight(0xfff3d0, 1.6);
  sun.position.set(60,120,30);
  sun.castShadow = !MOBILE;
  if (sun.castShadow){
    sun.shadow.mapSize.set(2048,2048);
    sun.shadow.camera.near=1; sun.shadow.camera.far=320;
    const S=70; sun.shadow.camera.left=-S; sun.shadow.camera.right=S; sun.shadow.camera.top=S; sun.shadow.camera.bottom=-S;
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
  const cv = document.createElement('canvas'); cv.width=16; cv.height=256;
  const x = cv.getContext('2d');
  const g = x.createLinearGradient(0,0,0,256);
  g.addColorStop(0, th.skyTop); g.addColorStop(0.55, th.skyMid); g.addColorStop(1, th.skyHorizon);
  x.fillStyle=g; x.fillRect(0,0,16,256);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map:tex, side:THREE.BackSide, fog:false, depthWrite:false });
  sky = new THREE.Mesh(new THREE.SphereGeometry(3500, 16, 12), mat);
  scene.add(sky);
  scene.background = new THREE.Color(th.skyHorizon);
  scene.fog.color.set(th.skyHorizon);
}

// environment map for glossy paint/chrome/glass reflections (the "modern" look)
let envTex=null;
function buildEnv(){
  try {
    const th=G.theme;
    const cv=document.createElement('canvas'); cv.width=128; cv.height=64; const x=cv.getContext('2d');
    const grad=x.createLinearGradient(0,0,0,64);
    grad.addColorStop(0, th.skyTop); grad.addColorStop(0.45, th.skyMid); grad.addColorStop(0.6, th.skyHorizon);
    grad.addColorStop(0.62, '#3b4a39'); grad.addColorStop(1, '#26301f');
    x.fillStyle=grad; x.fillRect(0,0,128,64);
    const sg=x.createRadialGradient(96,16,2,96,16,28); sg.addColorStop(0,'rgba(255,250,230,0.95)'); sg.addColorStop(1,'rgba(255,250,230,0)');
    x.fillStyle=sg; x.fillRect(66,0,60,38);
    const eq=new THREE.CanvasTexture(cv); eq.mapping=THREE.EquirectangularReflectionMapping; eq.colorSpace=THREE.SRGBColorSpace;
    const pmrem=new THREE.PMREMGenerator(renderer);
    const rt=pmrem.fromEquirectangular(eq);
    if (envTex) envTex.dispose();
    // NOTE: do NOT set scene.environment — modern three.js would reflect it on the
    // road's Lambert material too, turning the asphalt sky-blue. Apply envTex only
    // to the car paint/chrome/glass materials below.
    envTex=rt.texture;
    eq.dispose(); pmrem.dispose();
  } catch(e){ /* reflections optional */ }
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
  x.fillStyle='#'+hexA.toString(16).padStart(6,'0'); x.fillRect(0,0,w,h);
  x.fillStyle='#'+hexB.toString(16).padStart(6,'0');
  for (let i=0;i<speck;i++){ x.globalAlpha=0.4+Math.random()*0.4; x.fillRect(Math.random()*w, Math.random()*h, 1+Math.random()*2, 1+Math.random()*2); }
  x.globalAlpha=1;
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; t.wrapS=t.wrapT=THREE.RepeatWrapping;
  return t;
}

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
    const tex=surfTex(0x9a9a9a, 0x6e6e6e, 64, 128, 120); tex.repeat.set(1, 1);
    const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map:tex, color:0x595c61, side:THREE.DoubleSide}));
    mesh.receiveShadow=!MOBILE; scene.add(mesh); roadParts.push(mesh);
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
    const tex=surfTex(th.grass, th.grass2, 64, 64, 500);
    const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map:tex, side:THREE.DoubleSide}));
    mesh.receiveShadow=!MOBILE; scene.add(mesh); roadParts.push(mesh);
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
    mesh.receiveShadow=!MOBILE; scene.add(mesh); roadParts.push(mesh);
  }
}

// ----------------------------------------------------------------------------
//  Car
// ----------------------------------------------------------------------------
// ---- car materials ----
function paintMat(c){ return MOBILE
  ? new THREE.MeshStandardMaterial({color:c, metalness:0.35, roughness:0.32, envMap:envTex, envMapIntensity:1.1})
  : new THREE.MeshPhysicalMaterial({color:c, metalness:0.25, roughness:0.3, clearcoat:1.0, clearcoatRoughness:0.08, envMap:envTex, envMapIntensity:1.2}); }
function matteMat(c){ return new THREE.MeshStandardMaterial({color:c, metalness:0, roughness:0.85}); }
function glassMat(){ return new THREE.MeshStandardMaterial({color:0x0b1626, metalness:0.5, roughness:0.06, envMap:envTex, envMapIntensity:1.6}); }
function chromeMat(){ return new THREE.MeshStandardMaterial({color:0xc4c9d2, metalness:0.95, roughness:0.2, envMap:envTex, envMapIntensity:1.4}); }
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
  const geo=new THREE.ExtrudeGeometry(s,{depth:width, bevelEnabled:bevel>0, bevelThickness:bevel, bevelSize:bevel, bevelSegments:2, steps:1, curveSegments:8});
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
function addLights(g,y,zf,zr){
  const hl=new THREE.MeshStandardMaterial({color:0xfff6c8, emissive:0xfff0b0, emissiveIntensity:0.9, roughness:0.3});
  g.userData.brakeMats=g.userData.brakeMats||[];
  for (const sx of [-0.82,0.82]){
    g.add(lmBox(hl, 0.5,0.2,0.08, sx,y,zf));
    const tl=new THREE.MeshStandardMaterial({color:0xff2a2a, emissive:0xdd1212, emissiveIntensity:0.8, roughness:0.45});
    g.add(lmBox(tl, 0.62,0.2,0.08, sx,y,-zr)); g.userData.brakeMats.push(tl);
  }
}
function addWheels(g,tx,tz,r,lite){
  const tyre=new THREE.CylinderGeometry(r,r,0.46,lite?10:16); tyre.rotateZ(Math.PI/2);
  const tm=matteMat(0x0b0b0b);
  const rim=new THREE.CylinderGeometry(r*0.62,r*0.62,0.5,lite?8:14); rim.rotateZ(Math.PI/2);
  const rm=chromeMat();
  const hub=new THREE.CylinderGeometry(r*0.18,r*0.18,0.52,8); hub.rotateZ(Math.PI/2); const hm=matteMat(0x2a2e34);
  g.userData.wheels = [];
  for (const [wx,wz] of [[-tx,tz],[tx,tz],[-tx,-tz],[tx,-tz]]){
    const wg=new THREE.Group(); wg.position.set(wx,r,wz);   // a spinnable hub group per corner
    const w=new THREE.Mesh(tyre,tm); wg.add(w);
    if (!lite){ const d=new THREE.Mesh(rim,rm); wg.add(d); const h=new THREE.Mesh(hub,hm); wg.add(h); }
    g.add(wg); g.userData.wheels.push(wg);
  }
}
function addMirrors(g,x,y,z,mat){ for (const sx of [-x,x]){ g.add(lmBox(mat, 0.18,0.16,0.26, sx,y,z)); } }
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
  const main=paintMat(liv.body), accent=paintMat(liv.hood), roofM=paintMat(liv.roof!=null?liv.roof:liv.hood);
  const white=paintMat(0xffffff), glass=glassMat(), dark=matteMat(0x16181c);
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
  addLights(g, 0.82, L*0.5, L*0.5);
  // racing wheels tucked under the fenders
  addWheels(g, W/2-0.04, L*0.3, 0.55, lite);
  if (!MOBILE) g.traverse(o=>{ if(o.isMesh){ o.castShadow=true; } });
  return g;
}

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
  const S=128, cv=document.createElement('canvas'); cv.width=cv.height=S; const x=cv.getContext('2d');
  x.fillStyle='#f2f2f2'; x.fillRect(0,0,S,S);
  const grain=(n,a)=>{ for(let i=0;i<n;i++){ const v=Math.random()<0.5?0:255; x.fillStyle=`rgba(${v},${v},${v},${Math.random()*a})`; x.fillRect(Math.random()*S,Math.random()*S,1.6,1.6);} };
  if (kind==='stone'){
    grain(2200,0.10); x.strokeStyle='rgba(0,0,0,0.28)'; x.lineWidth=1.4;
    const rows=8, ch=S/rows;
    for(let r=0;r<=rows;r++){ const y=r*ch; x.beginPath(); x.moveTo(0,y); x.lineTo(S,y); x.stroke();
      const cols=6, cw=S/cols, off=(r%2)?cw/2:0;
      for(let c=0;c<=cols;c++){ const vx=c*cw+off; x.beginPath(); x.moveTo(vx,y); x.lineTo(vx,y+ch); x.stroke(); } }
  } else if (kind==='metal'){
    for(let i=0;i<S;i+=2){ x.fillStyle=`rgba(0,0,0,${Math.random()*0.08})`; x.fillRect(i,0,1,S); } grain(900,0.06);
  } else if (kind==='glass'){
    x.strokeStyle='rgba(0,0,0,0.22)'; x.lineWidth=1;
    for(let i=0;i<=S;i+=16){ x.beginPath(); x.moveTo(i,0); x.lineTo(i,S); x.stroke(); x.beginPath(); x.moveTo(0,i); x.lineTo(S,i); x.stroke(); }
    for(let r=0;r<8;r++)for(let c=0;c<8;c++){ if(Math.random()<0.3){ x.fillStyle=`rgba(255,255,255,${Math.random()*0.18})`; x.fillRect(c*16+1,r*16+1,14,14);} }
  } else { grain(1600,0.09); }
  const t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.colorSpace=THREE.SRGBColorSpace;
  _detailCache[kind]=t; return t;
}
function txMat(opts, kind, rep){
  const m=new THREE.MeshStandardMaterial(opts);
  m.map=makeDetailTex(kind||'rough').clone(); m.map.wrapS=m.map.wrapT=THREE.RepeatWrapping;
  if (rep) m.map.repeat.set(rep,rep); m.map.needsUpdate=true;
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
  const cv=document.createElement('canvas'); cv.width=256; cv.height=96; const x=cv.getContext('2d');
  x.fillStyle='#41474f'; x.fillRect(0,0,256,96);
  for (let r=0;r<7;r++) for (let cc=0;cc<40;cc++){ x.fillStyle=`hsl(${Math.random()*360},70%,${45+Math.random()*30}%)`; x.fillRect(cc*6+(r%2)*3, r*13+3, 4, 7); }
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
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
  const W=66, H=150, tw=13, td=9;
  for (const sx of [-1,1]) g.add(lmBox(gold,tw,H,td,sx*W/2,H/2,0));
  g.add(lmBox(new THREE.MeshStandardMaterial({color:0xc9a233, metalness:0.85, roughness:0.32}), W+tw,12,td+1, 0,H-6,0));
  for (const sx of [-1,1]) g.add(lmBox(gold,tw+2,8,td+2,sx*W/2,4,0));
  // sit on the banked verge to one side (grounded)
  const off=(ROAD_W+RUMBLE_W)+20;
  g.position.copy(f.pos).addScaledVector(f.right, off); g.rotation.y=Math.atan2(f.tan.x,f.tan.z); g.scale.setScalar((spec&&spec.scale)||1); group.add(g);
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
  const palmTrunk=new THREE.MeshLambertMaterial({color:0x8a6a3a});
  const palmLeaf =new THREE.MeshLambertMaterial({color:0x2f9c4a, side:THREE.DoubleSide});
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
  const postMat=new THREE.MeshLambertMaterial({color:0xb9c0c7}), postGeo=new THREE.CylinderGeometry(0.5,0.5,16,8);
  const lp=new THREE.Mesh(postGeo,postMat); lp.position.set(-ROAD_W-2,8,0); gantry.add(lp);
  const rp=new THREE.Mesh(postGeo,postMat); rp.position.set(ROAD_W+2,8,0); gantry.add(rp);
  const beam=new THREE.Mesh(new THREE.BoxGeometry((ROAD_W+2)*2,3,1.5), new THREE.MeshLambertMaterial({color:0xc1272d})); beam.position.set(0,15.5,0); gantry.add(beam);
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
  const NSEG=8, NROW=MOBILE?2:3;
  const standFracs = MOBILE ? [0.008,0.028, 0.25, 0.50, 0.75]
                            : [0.006,0.022,0.038, 0.25, 0.49,0.51,0.53, 0.75];
  const standCen=new THREE.Vector3(); for(const fr of frames) standCen.add(fr.pos); standCen.multiplyScalar(1/frames.length);
  const standPostMat=new THREE.MeshLambertMaterial({color:0xb9c0c7});
  let waveIdx=0;
  for (const fr of standFracs){
    const idx=Math.floor(fr*DIV)%DIV, f=frames[idx];
    const side=(new THREE.Vector3().copy(f.pos).sub(standCen).dot(f.right)>=0)?1:-1;   // outward side
    const stand=new THREE.Group();
    const W=44, H=24;
    const baseM=new THREE.Mesh(new THREE.BoxGeometry(W,H,12), new THREE.MeshLambertMaterial({color:0x9aa3b2})); baseM.position.y=H/2; stand.add(baseM);
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
    const roof=new THREE.Mesh(new THREE.BoxGeometry(W+2,1,13), new THREE.MeshLambertMaterial({color:0xd6262b})); roof.position.y=H+0.9; stand.add(roof);
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
  if (!MOBILE) sceneryGroup.traverse(o=>{ if(o.isMesh) o.castShadow=true; });
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
    const lane = ((i%4)-1.5) * 2.6;                 // spread across the road
    rivals.push({
      mesh, lane, offset: lane,
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
const CAR_LEN=4.7, CAR_WID=2.3;
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
  if (G.state==='rolling'){ rollingUpdate(dt); return; }
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
  const topNow = onGrass ? maxSpeed*0.5 : maxSpeed;
  if (G.speed > topNow) G.speed += (topNow - G.speed)*0.1;
  G.speed = Math.max(-maxSpeed*0.28, Math.min(maxSpeed, G.speed));

  // steering -> lateral offset (only meaningful when moving)
  const steer = (keys.right?1:0) - (keys.left?1:0);
  G.steerVis += (steer - G.steerVis) * 0.2;
  const speedFrac = Math.min(1, Math.abs(G.speed)/maxSpeed);
  const grip = v.gripMul * (onGrass?0.7:1);
  G.offset += steer * 16 * v.steerMul * grip * dt * (0.35 + 0.65*speedFrac) * Math.sign(G.speed||1);
  // gentle centrifugal drift on curves
  const f = frameAt(G.dist);
  G.offset += f.curv * speedFrac * 11 * dt;
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
  if (hit){ G.speed *= 0.9; G.shake = Math.min(0.7, (G.shake||0) + 0.35); }
  if (G.offset >  lim) G.offset =  lim;
  if (G.offset < -lim) G.offset = -lim;
  G.shake = (G.shake||0) * (1 - 6*dt);   // decay the impact jolt

  G.totalTime += dt;
  G.timeLeft  -= dt;
  if (G.timeLeft <= 0){ G.timeLeft = 0; finishRace(false); return; }

  if (window.GameMusic && window.GameMusic.setIntensity) window.GameMusic.setIntensity(speedFrac);
  updateRaceHUDText();
}

function onLapComplete(){
  if (G.lap >= G.circuit.laps){ finishRace(true); return; }   // crossed the line on the final lap
  G.lap++;
  G.timeLeft += G.circuit.lapBonus;                            // checkpoint time-extension
  showBanner('CHECKPOINT  +'+G.circuit.lapBonus, 1300);
  if (G.lap === G.circuit.laps && window.GameMusic && window.GameMusic.setFinalLap){
    try{ window.GameMusic.setFinalLap(true); }catch(e){}
  }
}

function finishRace(win){
  G.state='finished';
  showBanner(win?'FINISH!':"TIME UP", 0);
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

function present(){
  if (_ctxLost) return;
  renderer.render(scene, camera);
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
}

function render(){
  if (!G.started || !frames.length){ present(); return; }

  placeCar(playerCar, G.dist, G.offset);
  placeRivals();
  animateWorld();
  // visual lean
  playerCar.rotateY(G.steerVis * 0.16);
  playerCar.rotateZ(-G.steerVis * 0.05 * (G.vehicle.rollMul||1));
  if (playerCar.userData.brakeMats){
    const on = G.state==='racing' && (keys.brake || G.speed<0);
    for (const m of playerCar.userData.brakeMats) m.emissiveIntensity = on?2.6:0.8;
  }
  if (sun){ sun.target.position.copy(playerCar.position); sun.position.copy(playerCar.position).add(_sunOff); sun.target.updateMatrixWorld(); }

  // chase camera — behind + above the car, ALWAYS world-up (never inverts/rolls
  // badly), finiteness-guarded. Height uses world up so the camera is always above.
  const f = frameAt(G.dist);
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
  if (sky) sky.position.copy(camera.position);

  let targetFov = 62 + speedFracFov()*16;   // FOV opens with speed for more sense of rush
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

function drawHUD(){
  const W=hud2d.width, H=hud2d.height;
  hctx.clearRect(0,0,W,H);
  if (!G.started) return;
  const sp = Math.min(1, Math.abs(G.speed)/(G.maxSpeed||1));

  // speed lines streaking from the vanishing point at high speed
  if (G.state==='racing' && sp>0.5){
    const n=Math.floor((sp-0.5)*60), cx=W*0.5, cy=H*0.52;
    hctx.strokeStyle=`rgba(255,255,255,${(sp-0.5)*0.45})`; hctx.lineWidth=Math.max(1,W*0.0014);
    for (let i=0;i<n;i++){
      const a=(i*2.39996)%6.283, r0=Math.min(W,H)*0.2, r1=r0+(40+((i*53)%120))*(W/1280);
      hctx.beginPath(); hctx.moveTo(cx+Math.cos(a)*r0, cy+Math.sin(a)*r0); hctx.lineTo(cx+Math.cos(a)*r1, cy+Math.sin(a)*r1); hctx.stroke();
    }
  }

  // rev gauge
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
  });
  window.addEventListener('keyup', e=>{
    if (e.key==='ArrowUp'||e.key==='w'||e.key==='W') set('gas',false);
    else if (e.key==='ArrowDown'||e.key==='s'||e.key==='S') set('brake',false);
    else if (e.key==='ArrowLeft'||e.key==='a'||e.key==='A') set('left',false);
    else if (e.key==='ArrowRight'||e.key==='d'||e.key==='D') set('right',false);
  });
  // touch buttons
  const hook=(id,k)=>{
    const el=document.getElementById(id); if(!el) return;
    const on =e=>{ e.preventDefault(); set(k,true); };
    const off=e=>{ e.preventDefault(); set(k,false); };
    el.addEventListener('pointerdown',on); el.addEventListener('pointerup',off);
    el.addEventListener('pointercancel',off); el.addEventListener('pointerleave',off);
  };
  hook('tgas','gas'); hook('tbrake','brake'); hook('tleft','left'); hook('tright','right');
}

// ----------------------------------------------------------------------------
//  Race start (full menu flow lands in M4 — for now START drives immediately)
// ----------------------------------------------------------------------------
function startRace(){
  buildTrack(G.circuit);
  buildSky();
  buildEnv();
  buildRoadMesh();
  buildMinimap();
  try { buildScenery(); } catch(e){ _scnInfo='SCN-ERR:'+(e&&e.message||e); if(sceneryGroup&&!sceneryGroup.parent) scene.add(sceneryGroup); }
  if (playerCar){ scene.remove(playerCar); }
  playerCar = buildCar(G.vehicle); scene.add(playerCar);
  buildRivals(MOBILE ? 7 : 9);
  G.maxSpeed = G.circuit.maxSpeed * G.vehicle.speedMul * 0.58;   // tuned to feel
  G.dist=0; G.offset=0; G.speed=0; G.lap=1; G.steerVis=0;
  G.timeLeft=G.circuit.startTime; G.totalTime=0; G.rollT=0; G.cdNum=-1; G.green=false;
  G.started=true; G.state='rolling';
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
  showBanner('GENTLEMEN,<br>START YOUR ENGINES!', 0, true);
  showTouch();
  startRaceMusic();
}

// ---- race soundtrack: the chosen soundtrack (intro once -> loop) ----
let _raceAudio = { intro:null, loop:null };
function startRaceMusic(){
  stopRaceMusic();
  if (window.GameMusic && window.GameMusic.stop){ try{ window.GameMusic.stop(); }catch(e){} }   // silence procedural menu music
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
function pauseRaceMusic(p){ for (const k of ['intro','loop']){ const a=_raceAudio[k]; if(a){ try{ p?a.pause():(a.src&&a.play().catch(()=>{})); }catch(e){} } } }

function showEndScreen(win){
  const o=document.getElementById('overlay'); if(!o) return;
  const pos=computePosition(), total=1+rivals.length;
  o.innerHTML = `<h1 class="title">${win?'<span class="red">FINISH</span>':'TIME UP'}</h1>
    <div class="menu-card">
      <h2>${win?'RACE COMPLETE':'OUT OF TIME'}</h2>
      <p style="font-size:15px">${G.circuit.name} — Position ${pos}/${total}<br>Total time ${fmtTime(G.totalTime)}</p>
      <button class="btn" id="againBtn">RACE AGAIN ▶</button>
      <div style="height:10px"></div>
      <button class="btn ghost" id="menuBtn">MENU ✕</button>
    </div>`;
  o.classList.remove('hidden');
  document.getElementById('againBtn').onclick = ()=>startRace();
  document.getElementById('menuBtn').onclick  = ()=>showMenu();
}
// ----------------------------------------------------------------------------
//  Menu flow: title -> vehicle -> circuit -> soundtrack -> race
// ----------------------------------------------------------------------------
const SOUNDTRACKS = {
  daytona: { name:'DAYTONA', icon:'🏁', desc:'The original — big arcade theme', intro:'./audio/intro.mp3',      loop:'./audio/soundtrack.mp3' },
  heat:    { name:'HEAT',    icon:'🌆', desc:'Driving synth groove',           intro:'./audio/heat-intro.mp3', loop:'./audio/heat-soundtrack.mp3' },
};
const VEH_ICON = ['🏎️','🏁'];
const CIR_ICON = ['🏔️','🎡','🌆'];
let selVeh=0, selCir=1, selSnd='daytona';

function overlayEl(){ return document.getElementById('overlay'); }
function showOverlay(html){
  const o=overlayEl(); o.innerHTML=html; o.classList.remove('hidden');
  const hud=document.getElementById('hud'); if(hud) hud.style.visibility='hidden';   // no stale HUD behind menus
}

function showMenu(){
  G.state='menu'; G.started=false;
  stopRaceMusic();
  if (window.GameMusic){ try{ window.GameMusic.start && window.GameMusic.start(); window.GameMusic.setMode && window.GameMusic.setMode('menu'); }catch(e){} }
  showOverlay(`<h1 class="title">DAYTONA <span class="red">USA</span></h1>
    <div class="subtitle">3D POLYGON EDITION</div>
    <div class="menu-card">
      <h2>MERCEDES CIRCUIT RACING</h2>
      <p style="font-size:13px;opacity:.85;margin:0 0 16px">Pick your car, circuit & soundtrack. ${BUILD}</p>
      <button class="btn" id="startBtn">START ▶</button>
    </div>
    <div class="credit">Fan-made, non-commercial.</div>`);
  document.getElementById('startBtn').onclick = ()=>{ try{ensureAudio();}catch(e){} showVehicleSelect(); };
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
  document.getElementById('nextBtn').onclick=showCircuitSelect;
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
  showOverlay(`<h1 class="title">SELECT <span class="red">SOUNDTRACK</span></h1>
    ${cardRow(items, selIdx, 'data-snd')}
    <div class="menu-card"><div class="navrow">
      <button class="btn ghost" id="backBtn">◀ BACK</button>
      <button class="btn" id="goBtn">GREEN FLAG ▶</button>
    </div></div>`);
  wireCards('data-snd', i=>{ selSnd=keys[i]; showSoundtrackSelect(); });
  document.getElementById('backBtn').onclick=showCircuitSelect;
  document.getElementById('goBtn').onclick=()=>{
    G.vehicle=VEHICLES[selVeh]; G.circuit=CIRCUITS[selCir]; G.soundtrack=selSnd;
    startRace();
  };
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
  const pr=Math.min(MOBILE?1.25:2, window.devicePixelRatio||1);
  renderer.setPixelRatio(pr); renderer.setSize(w,h,false);
  const hpr=Math.min(2, window.devicePixelRatio||1);
  hud2d.width=Math.round(w*hpr); hud2d.height=Math.round(h*hpr);
  hud2d.style.width=w+'px'; hud2d.style.height=h+'px';
}

let last=performance.now(), acc=0;
function frame(now){
  let dt=(now-last)/1000; if(dt>0.1)dt=0.1; last=now; acc+=dt;
  _adt = dt;
  while (acc>=STEP){ update(STEP); acc-=STEP; }
  if (scene && camera) render();
  requestAnimationFrame(frame);
}

// ----------------------------------------------------------------------------
//  Boot
// ----------------------------------------------------------------------------
function togglePause(){
  if (G.state==='racing'){ G.state='paused'; pauseRaceMusic(true); showBanner('PAUSED', 0); }
  else if (G.state==='paused'){ G.state='racing'; pauseRaceMusic(false); hideBanner(); }
}
window.__togglePause = togglePause;

function boot(){
  initThree();
  bindInput();
  const pb=document.getElementById('pauseBtn'); if(pb) pb.onclick=togglePause;
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

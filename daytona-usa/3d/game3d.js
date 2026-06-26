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

const BUILD = 'BUILD R1 — clean rewrite (foundation)';

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
  { name:'MERCEDES V-CLASS', kind:'van',   color:0x0c0d0f,
    speedMul:0.90, accelMul:0.82, steerMul:0.78, gripMul:0.80, brakeMul:0.82, rollMul:1.7,
    desc:'Luxury MPV in black — heavy & planted: gentle steering, lower grip, leans in turns.' },
  { name:'MERCEDES S-CLASS', kind:'sedan', color:0x0c0d0f,
    speedMul:1.10, accelMul:1.16, steerMul:1.24, gripMul:1.20, brakeMul:1.15, rollMul:0.7,
    desc:'Flagship saloon in black — fast & agile: sharp steering, strong brakes, high grip.' },
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
  renderer.toneMappingExposure = 1.0;
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

  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x5a8a4a, 1.0));
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  sun = new THREE.DirectionalLight(0xfff3d0, 2.0);
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
    const tex=surfTex(th.asphalt, 0x000000, 64, 128, 220); tex.repeat.set(1, 1);
    const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map:tex}));
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
function buildCar(vehicle){
  const g = new THREE.Group();
  const van = vehicle.kind==='van';
  const L = van?4.9:4.6, W=2.0, H=van?1.9:1.25;
  const bodyMat = new THREE.MeshStandardMaterial({ color:vehicle.color, metalness:0.5, roughness:0.35 });
  const glassMat = new THREE.MeshStandardMaterial({ color:0x223044, metalness:0.4, roughness:0.1 });
  const brakeMat = new THREE.MeshStandardMaterial({ color:0x330000, emissive:0xff1500, emissiveIntensity:0.8 });

  // body (built facing +Z = forward)
  const body=new THREE.Mesh(new THREE.BoxGeometry(W, H*0.62, L), bodyMat); body.position.y=H*0.42; g.add(body);
  // cabin
  const cabH=van?H*0.7:H*0.5, cabL=van?L*0.62:L*0.42;
  const cab=new THREE.Mesh(new THREE.BoxGeometry(W*0.92, cabH, cabL), bodyMat);
  cab.position.set(0, H*0.62+cabH*0.5-0.05, van?-0.1:-0.25); g.add(cab);
  // windscreen
  const ws=new THREE.Mesh(new THREE.BoxGeometry(W*0.84, cabH*0.7, 0.1), glassMat);
  ws.position.set(0, H*0.62+cabH*0.55, (van?-0.1:-0.25)+cabL*0.5); g.add(ws);
  // wheels
  const wheelMat=new THREE.MeshStandardMaterial({color:0x111114, roughness:0.8});
  const wheelGeo=new THREE.CylinderGeometry(0.5,0.5,0.4,14); wheelGeo.rotateZ(Math.PI/2);
  const wb=L*0.32, tw=W*0.5+0.05;
  for (const sx of [-1,1]) for (const sz of [-1,1]){
    const w=new THREE.Mesh(wheelGeo, wheelMat); w.position.set(sx*tw, 0.5, sz*wb); g.add(w);
  }
  // brake lights (rear = -Z)
  const brakeMats=[];
  for (const sx of [-1,1]){
    const bl=new THREE.Mesh(new THREE.BoxGeometry(0.4,0.25,0.08), brakeMat.clone());
    bl.position.set(sx*W*0.34, H*0.45, -L*0.5-0.02); g.add(bl); brakeMats.push(bl.material);
  }
  g.userData.brakeMats = brakeMats;
  g.traverse(o=>{ if(o.isMesh && !MOBILE){ o.castShadow=true; } });
  return g;
}

// orient a mesh so local +Z = tangent, local +Y = surface up
const _xA=new THREE.Vector3(), _yA=new THREE.Vector3(), _zA=new THREE.Vector3(), _basis=new THREE.Matrix4(), _carPos=new THREE.Vector3();
function placeCar(mesh, dist, offset){
  worldPos(dist, offset, _carPos);
  const f=frameAt(dist);
  mesh.position.copy(_carPos);
  _zA.copy(f.tan); _yA.copy(f.up);
  _xA.crossVectors(_yA,_zA).normalize();
  _yA.crossVectors(_zA,_xA).normalize();
  _basis.makeBasis(_xA,_yA,_zA);
  mesh.quaternion.setFromRotationMatrix(_basis);
}

// ----------------------------------------------------------------------------
//  AI rivals (follow the track in soft lanes — no sticky collisions)
// ----------------------------------------------------------------------------
function buildRivals(n){
  for (const r of rivals){ scene.remove(r.mesh); }
  rivals = [];
  const aiTop = G.circuit.maxSpeed * G.circuit.aiSpeed * 0.42;
  for (let i=0;i<n;i++){
    const liv = LIVERIES[i % LIVERIES.length];
    const mesh = buildCar({ kind: i%2?'sedan':'van', color: liv });
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
    let target = r.baseSpeed;
    const gap = (r.lap*trackLen + r.dist) - playerProg;   // +ve = ahead of player
    if (gap >  140) target *= 0.95;                       // rubber-band so the pack stays close
    if (gap < -140) target *= 1.06;
    r.speed += (target - r.speed) * 1.2 * dt;
    r.offset += (r.lane - r.offset) * 2.0 * dt;
    r.dist += r.speed * dt;
    if (r.dist >= trackLen){ r.dist -= trackLen; r.lap++; }
  }
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
  if (keys.gas)        G.speed += 62 * v.accelMul * dt;
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

  // rivals + timing
  updateRivals(dt);
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
  if (window.GameMusic && window.GameMusic.setMode){ try{ window.GameMusic.setMode('menu'); }catch(e){} }
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

function render(){
  if (!G.started || !frames.length){ present(); return; }

  placeCar(playerCar, G.dist, G.offset);
  placeRivals();
  // visual lean
  playerCar.rotateY(G.steerVis * 0.16);
  playerCar.rotateZ(-G.steerVis * 0.05 * (G.vehicle.rollMul||1));
  if (playerCar.userData.brakeMats){
    const on = G.state==='racing' && (keys.brake || G.speed<0);
    for (const m of playerCar.userData.brakeMats) m.emissiveIntensity = on?2.6:0.8;
  }
  if (sun){ sun.target.position.copy(playerCar.position); sun.position.copy(playerCar.position).add(_sunOff); sun.target.updateMatrixWorld(); }

  // chase camera — derived from the track frame, finiteness-guarded
  const f = frameAt(G.dist);
  const camLat = G.offset * 0.30;
  worldPos(G.dist, camLat, _tmp);
  _camPos.copy(_tmp).addScaledVector(f.tan,-11).addScaledVector(f.up,5.2);
  _look.copy(_tmp).addScaledVector(f.tan, 16).addScaledVector(f.up, 4.4);
  if (finite(_camPos) && finite(_look)){
    camera.position.lerp(_camPos, 0.25);
    _camUp.lerp(f.up, 0.1); camera.up.copy(_camUp);
    camera.lookAt(_look);
  }
  if (sky) sky.position.copy(camera.position);

  let targetFov = 62 + speedFracFov()*10;
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
//  Minimal HUD (full HUD lands in M3)
// ----------------------------------------------------------------------------
function drawHUD(){
  const W=hud2d.width, H=hud2d.height;
  hctx.clearRect(0,0,W,H);
  // speed readout
  hctx.fillStyle='#fff'; hctx.strokeStyle='#000'; hctx.lineWidth=Math.max(2,W*0.004);
  hctx.font=`bold ${Math.round(W*0.05)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='middle';
  const kmh=Math.round(Math.abs(G.speed)*2.4);
  hctx.strokeText(kmh+' KM/H', W*0.5, H*0.12); hctx.fillText(kmh+' KM/H', W*0.5, H*0.12);
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
  buildRoadMesh();
  if (playerCar){ scene.remove(playerCar); }
  playerCar = buildCar(G.vehicle); scene.add(playerCar);
  buildRivals(MOBILE ? 7 : 9);
  G.maxSpeed = G.circuit.maxSpeed * G.vehicle.speedMul * 0.42;   // tuned to feel
  G.dist=0; G.offset=0; G.speed=0; G.lap=1; G.steerVis=0;
  G.timeLeft=G.circuit.startTime; G.totalTime=0; G.rollT=0; G.cdNum=-1; G.green=false;
  G.started=true; G.state='rolling';
  placeCar(playerCar, G.dist, G.offset);
  placeRivals();
  // snap camera behind the car immediately
  const f=frameAt(G.dist); worldPos(G.dist,0,_tmp);
  camera.position.copy(_tmp).addScaledVector(f.tan,-11).addScaledVector(f.up,5.2);
  camera.up.set(0,1,0); camera.lookAt(_tmp.clone().addScaledVector(f.tan,16).addScaledVector(f.up,4.4));
  // HUD text
  setText('trackName', G.circuit.name+' • '+BUILD.split('—')[0].trim());
  updateRaceHUDText();
  hideOverlay();
  showBanner('GENTLEMEN,<br>START YOUR ENGINES!', 0, true);
  showTouch();
}

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
function showMenu(){
  G.state='menu'; G.started=false;
  const o=document.getElementById('overlay'); if(!o) return;
  // minimal menu (full flow in M4)
  o.innerHTML = `<h1 class="title">DAYTONA <span class="red">USA</span></h1>
    <div class="subtitle">3D POLYGON EDITION</div>
    <div class="menu-card"><h2>MERCEDES CIRCUIT RACING</h2>
      <p style="font-size:13px">${BUILD}</p>
      <button class="btn" id="startBtn">START ▶</button></div>`;
  o.classList.remove('hidden');
  document.getElementById('startBtn').onclick = ()=>{ try{ensureAudio();}catch(e){} startRace(); };
}

function setText(id, t){ const el=document.getElementById(id); if(el) el.textContent=t; }
function hideOverlay(){ const o=document.getElementById('overlay'); if(o) o.classList.add('hidden'); }
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
  while (acc>=STEP){ update(STEP); acc-=STEP; }
  if (scene && camera) render();
  requestAnimationFrame(frame);
}

// ----------------------------------------------------------------------------
//  Boot
// ----------------------------------------------------------------------------
function boot(){
  initThree();
  bindInput();
  // wire the existing menu START button (full menu flow arrives in M4)
  const sb=document.getElementById('startBtn');
  if (sb) sb.onclick = ()=>{ try{ ensureAudio(); }catch(e){} startRace(); };
  // show the build tag on the menu card
  const card=document.querySelector('.menu-card p');
  if (card) card.textContent = BUILD;
  requestAnimationFrame(frame);
  // dev diagnostic (removed before final ship)
  window.__dbg = ()=>({
    off:+G.offset.toFixed(1), dist:+G.dist.toFixed(0), speed:+G.speed.toFixed(1), lap:G.lap,
    camFinite: Number.isFinite(camera.position.x)&&Number.isFinite(camera.position.y)&&Number.isFinite(camera.position.z),
    state:G.state, timeLeft:+G.timeLeft.toFixed(1), pos:G.started?computePosition():0, rivals:rivals.length,
  });
  window.__forceTime = (t)=>{ G.timeLeft=t; };   // dev hook
  window.__startCircuit = (i)=>{ G.circuit=CIRCUITS[i]; startRace(); };   // dev hook (removed at ship)
}
function ensureAudio(){
  if (window.GameMusic && !window.__audioStarted){
    const AC = new (window.AudioContext||window.webkitAudioContext)();
    window.GameMusic.init(AC); window.GameMusic.start(); window.__audioStarted=true;
  }
}

boot();

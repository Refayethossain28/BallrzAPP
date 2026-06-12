/* ============================================================================
 * DAYTONA USA — 3D Polygon Edition
 * A true 3D (WebGL / Three.js) arcade racer in the spirit of SEGA's Daytona
 * USA. The track is a closed Catmull-Rom spline, extruded into a polygonal
 * road ribbon (asphalt + rumble kerbs + lane lines + grass verges) that loops
 * seamlessly. The Hornet and its 39 rivals are low-poly meshes; a chase camera
 * follows the action and the arcade HUD is drawn over the top.
 *
 * Three.js is vendored locally (./vendor/three.module.js) so the game needs no
 * network connection and runs straight from the file system.
 * ========================================================================== */
import * as THREE from './vendor/three.module.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const glCanvas = document.getElementById('gl');
const hud2d = document.getElementById('hud2d');
const hctx = hud2d.getContext('2d');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const FIELD = 40, OPPONENTS = FIELD - 1;
const ROAD_W = 9;                 // road half-width (world units)
const RUMBLE_W = 1.6;
const DIV = 1400;                 // spline samples (road resolution)
const FPS = 60, STEP = 1/FPS;

const DIFFS = [
  { name:'THREE-SEVEN SPEEDWAY',  laps:8, maxSpeed:105, curveMul:0.8, aiSpeed:0.82, startTime:55, lapBonus:24, seed:1 },
  { name:'DINOSAUR CANYON',       laps:4, maxSpeed:120, curveMul:1.0, aiSpeed:0.90, startTime:62, lapBonus:34, seed:7 },
  { name:'SEA-SIDE STREET GALAXY',laps:8, maxSpeed:135, curveMul:1.2, aiSpeed:0.97, startTime:70, lapBonus:30, seed:3 },
];
const LIVERIES = [0xe23b3b,0x2f6cff,0x22c55e,0xf59e0b,0xa855f7,0x06b6d4,
                  0xec4899,0xfacc15,0xfb7185,0x4ade80,0x38bdf8,0xfb923c,0xffffff];

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const G = {
  state:'menu', diff:0,
  L:0,                // track length
  dist:0,             // player distance along track
  playerX:0,          // lateral offset -1..1
  speed:0, maxSpeed:105, curveMul:0.8, aiSpeedMul:0.82,
  totalLaps:8, lap:1, lapTime:0, lastLapTime:0, bestLapTime:Infinity,
  totalTime:0, timeLeft:55, lapBonus:24,
  cars:[], place:FIELD, countdown:0, bannerTimer:0, shake:0, skid:0,
  reversedLine:false, camMode:0,
};

// ---------------------------------------------------------------------------
// Three.js core
// ---------------------------------------------------------------------------
let renderer, scene, camera;
let frames = [];      // [{pos:Vector3, tan:Vector3, right:Vector3, curv:Number}]
let playerCar, rivalMeshes = [];
const UP = new THREE.Vector3(0,1,0);

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas:glCanvas, antialias:true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6fb7ff);
  scene.fog = new THREE.Fog(0x9fd0ff, 220, 620);

  camera = new THREE.PerspectiveCamera(62, 1, 0.5, 2000);

  scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x35602f, 1.05));
  const sun = new THREE.DirectionalLight(0xfff3d0, 1.0);
  sun.position.set(120, 200, 80);
  scene.add(sun);

  resize();
  window.addEventListener('resize', resize);
}

// ---------------------------------------------------------------------------
// Track construction
// ---------------------------------------------------------------------------
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

let roadMesh=null, sceneryGroup=null, miniPath=[];

function buildTrack(diff) {
  // ---- control points: an organic closed circuit with hills ----
  const rng = mulberry32(diff.seed * 2654435761);
  const NCP = 14;
  const cps = [];
  for (let i=0;i<NCP;i++){
    const ang = (i/NCP)*Math.PI*2;
    const r = 200 + Math.sin(ang*2 + diff.seed)*60*diff.curveMul
                  + Math.sin(ang*3)*34*diff.curveMul + (rng()-0.5)*30;
    const y = Math.sin(ang*2)*9 + Math.sin(ang*3+1)*6 + (rng()-0.5)*4;
    cps.push(new THREE.Vector3(Math.cos(ang)*r, y, Math.sin(ang)*r));
  }
  const curve = new THREE.CatmullRomCurve3(cps, true, 'catmullrom', 0.5);
  G.L = curve.getLength();

  // ---- sample equal-arc-length frames ----
  frames = [];
  for (let i=0;i<DIV;i++){
    const u = i/DIV;
    const pos = curve.getPointAt(u);
    const tan = curve.getTangentAt(u).normalize();
    const right = new THREE.Vector3().crossVectors(tan, UP).normalize(); // horizontal right
    frames.push({ pos, tan, right, curv:0 });
  }
  // signed curvature (heading change per sample)
  for (let i=0;i<DIV;i++){
    const a = frames[i].tan, b = frames[(i+1)%DIV].tan;
    const ha = Math.atan2(a.x, a.z), hb = Math.atan2(b.x, b.z);
    let d = hb - ha; while (d>Math.PI) d-=Math.PI*2; while (d<-Math.PI) d+=Math.PI*2;
    frames[i].curv = d;
  }

  buildRoadMesh();
  buildScenery(rng);
  buildMinimap();
}

// Build the whole road (asphalt + kerbs + lines + grass) as one vertex-coloured mesh
function buildRoadMesh() {
  if (roadMesh){ scene.remove(roadMesh); roadMesh.geometry.dispose(); }
  const pos = [], col = [];
  const c = new THREE.Color();
  const tmpI = new THREE.Vector3(), tmpO = new THREE.Vector3();

  function pt(out, frame, lat, lift){
    out.copy(frame.pos).addScaledVector(frame.right, lat); out.y += lift; return out;
  }
  function tri(a,b,cc, color){
    pos.push(a.x,a.y,a.z, b.x,b.y,b.z, cc.x,cc.y,cc.z);
    for (let k=0;k<3;k++) col.push(color.r, color.g, color.b);
  }
  // a ribbon between two lateral offsets, coloured per-sample
  function ribbon(latIn, latOut, lift, colorFn){
    const ia=new THREE.Vector3(), oa=new THREE.Vector3(), ib=new THREE.Vector3(), ob=new THREE.Vector3();
    for (let i=0;i<DIV;i++){
      const a=frames[i], b=frames[(i+1)%DIV];
      pt(ia,a,latIn,lift); pt(oa,a,latOut,lift); pt(ib,b,latIn,lift); pt(ob,b,latOut,lift);
      colorFn(i, c);
      tri(ia,ib,ob,c); tri(ia,ob,oa,c);
    }
  }
  const asphalt = i => (Math.floor(i/5)%2 ? c.setHex(0x83878d) : c.setHex(0x7a7e84));
  const grass   = i => (Math.floor(i/5)%2 ? c.setHex(0x3c8246) : c.setHex(0x357a3f));
  // verges
  ribbon(-ROAD_W*9, -ROAD_W-RUMBLE_W, -0.05, grass);
  ribbon( ROAD_W+RUMBLE_W, ROAD_W*9, -0.05, grass);
  // rumble kerbs
  ribbon(-ROAD_W-RUMBLE_W, -ROAD_W, 0.02, i=> Math.floor(i/4)%2 ? c.setHex(0xd03a32) : c.setHex(0xe9e9ee));
  ribbon( ROAD_W, ROAD_W+RUMBLE_W, 0.02, i=> Math.floor(i/4)%2 ? c.setHex(0xd03a32) : c.setHex(0xe9e9ee));
  // asphalt
  ribbon(-ROAD_W, ROAD_W, 0, asphalt);
  // dashed centre line + two lane lines
  const dash = i => (Math.floor(i/3)%2 ? c.setHex(0xe9e9ee) : c.setHex(0x7a7e84));
  ribbon(-0.28, 0.28, 0.04, dash);
  ribbon(-ROAD_W*0.34-0.25, -ROAD_W*0.34+0.25, 0.04, dash);
  ribbon( ROAD_W*0.34-0.25,  ROAD_W*0.34+0.25, 0.04, dash);
  // start/finish checker band (first few samples)
  const startGeoPos=[], startGeoCol=[];
  {
    const ia=new THREE.Vector3(),oa=new THREE.Vector3(),ib=new THREE.Vector3(),ob=new THREE.Vector3();
    const NB=10;
    for (let i=0;i<3;i++){
      const a=frames[i], b=frames[(i+1)%DIV];
      for (let s=0;s<NB;s++){
        const l1=-ROAD_W + (2*ROAD_W/NB)*s, l2=-ROAD_W + (2*ROAD_W/NB)*(s+1);
        pt(ia,a,l1,0.05); pt(oa,a,l2,0.05); pt(ib,b,l1,0.05); pt(ob,b,l2,0.05);
        const white = (i+s)%2===0;
        c.setHex(white?0xffffff:0x14181c);
        startGeoPos.push(ia.x,ia.y,ia.z, ib.x,ib.y,ib.z, ob.x,ob.y,ob.z,
                         ia.x,ia.y,ia.z, ob.x,ob.y,ob.z, oa.x,oa.y,oa.z);
        for (let k=0;k<6;k++) startGeoCol.push(c.r,c.g,c.b);
      }
    }
  }
  for (let i=0;i<startGeoPos.length;i+=3){ pos.push(startGeoPos[i],startGeoPos[i+1],startGeoPos[i+2]); }
  for (let i=0;i<startGeoCol.length;i+=3){ col.push(startGeoCol[i],startGeoCol[i+1],startGeoCol[i+2]); }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col,3));
  geo.computeVertexNormals();
  roadMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors:true, side:THREE.DoubleSide }));
  scene.add(roadMesh);
}

// Pines, signs, the start gantry, distant mountains
function buildScenery(rng) {
  if (sceneryGroup){ scene.remove(sceneryGroup); }
  sceneryGroup = new THREE.Group();

  const pineTrunk = new THREE.MeshLambertMaterial({color:0x5b4226});
  const pineLeaf  = new THREE.MeshLambertMaterial({color:0x1f6b2e});
  function pine(scale){
    const g = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.4,2,6), pineTrunk); t.position.y=1; g.add(t);
    for (let k=0;k<3;k++){
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.2-k*0.5, 2.6, 7), pineLeaf);
      cone.position.y = 2.2 + k*1.5; g.add(cone);
    }
    g.scale.setScalar(scale);
    return g;
  }
  // line the verges with pines + the occasional sign
  for (let i=0;i<DIV;i+=11){
    const side = (i%22===0)?1:-1;
    const f = frames[i];
    const p = pine(1.4 + rng()*1.2);
    p.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+6+rng()*16));
    sceneryGroup.add(p);
  }
  // distant mountain ring
  const rockMat = new THREE.MeshLambertMaterial({color:0x8a9099, flatShading:true});
  const snowMat = new THREE.MeshLambertMaterial({color:0xeef3f7, flatShading:true});
  for (let i=0;i<26;i++){
    const ang = (i/26)*Math.PI*2;
    const r = 760 + (mulberry32(i+99)())*220;
    const h = 120 + (mulberry32(i+5)())*180;
    const m = new THREE.Mesh(new THREE.ConeGeometry(h*0.9, h, 5), rockMat);
    m.position.set(Math.cos(ang)*r, h/2-40, Math.sin(ang)*r);
    sceneryGroup.add(m);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(h*0.32, h*0.34, 5), snowMat);
    cap.position.set(Math.cos(ang)*r, h-40-h*0.17, Math.sin(ang)*r);
    sceneryGroup.add(cap);
  }
  // start/finish gantry over the line
  const f0 = frames[2];
  const gantry = new THREE.Group();
  const postMat = new THREE.MeshLambertMaterial({color:0xb9c0c7});
  const postGeo = new THREE.CylinderGeometry(0.5,0.5,16,8);
  const lp = new THREE.Mesh(postGeo, postMat); lp.position.set(-ROAD_W-2,8,0); gantry.add(lp);
  const rp = new THREE.Mesh(postGeo, postMat); rp.position.set( ROAD_W+2,8,0); gantry.add(rp);
  const beam = new THREE.Mesh(new THREE.BoxGeometry((ROAD_W+2)*2,3,1.5),
                              new THREE.MeshLambertMaterial({color:0xc1272d}));
  beam.position.set(0,15.5,0); gantry.add(beam);
  const board = new THREE.Mesh(new THREE.BoxGeometry(8,3,0.5),
                               new THREE.MeshBasicMaterial({color:0x111111}));
  board.position.set(0,12,0.9); gantry.add(board);
  // orient gantry across the track
  gantry.position.copy(f0.pos);
  gantry.lookAt(f0.pos.clone().add(f0.tan));
  sceneryGroup.add(gantry);

  scene.add(sceneryGroup);
}

function buildMinimap() {
  miniPath = [];
  let minX=1e9,minZ=1e9,maxX=-1e9,maxZ=-1e9;
  for (let i=0;i<DIV;i+=6){
    const p=frames[i].pos; miniPath.push({x:p.x,z:p.z});
    if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x; if(p.z<minZ)minZ=p.z; if(p.z>maxZ)maxZ=p.z;
  }
  G.mapBox = { minX,minZ, w:Math.max(1,maxX-minX), h:Math.max(1,maxZ-minZ) };
}

// ---------------------------------------------------------------------------
// Car meshes
// ---------------------------------------------------------------------------
function buildCarMesh(bodyColor, isHornet) {
  const g = new THREE.Group();
  const mat = c => new THREE.MeshLambertMaterial({color:c});
  // chassis
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 4.8), mat(bodyColor));
  body.position.y = 0.85; g.add(body);
  // lower stripe (Hornet red)
  if (isHornet){
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.45,0.34,4.85), mat(0xd6262b));
    stripe.position.y = 0.62; g.add(stripe);
  }
  // white front bumper
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(2.5,0.4,0.5), mat(0xeaeaee));
  bumper.position.set(0,0.5,2.45); g.add(bumper);
  // cabin
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.0,0.8,2.2), mat(isHornet?0x2056cf:bodyColor));
  cabin.position.set(0,1.55,-0.2); g.add(cabin);
  // windows (dark)
  const glass = mat(0x101b2e);
  const wF = new THREE.Mesh(new THREE.BoxGeometry(1.7,0.6,0.15), glass); wF.position.set(0,1.6,0.95); g.add(wF);
  const wB = new THREE.Mesh(new THREE.BoxGeometry(1.7,0.6,0.15), glass); wB.position.set(0,1.6,-1.35); g.add(wB);
  // spoiler
  const sp = new THREE.Mesh(new THREE.BoxGeometry(2.4,0.15,0.6), mat(isHornet?0xd6262b:0x222222));
  sp.position.set(0,1.55,-2.4); g.add(sp);
  const spL = new THREE.Mesh(new THREE.BoxGeometry(0.15,0.6,0.4), mat(0x222)); spL.position.set(-1.0,1.2,-2.3); g.add(spL);
  const spR = spL.clone(); spR.position.x=1.0; g.add(spR);
  // wheels
  const wheelGeo = new THREE.CylinderGeometry(0.55,0.55,0.45,12);
  const wheelMat = mat(0x111111);
  for (const [wx,wz] of [[-1.25,1.4],[1.25,1.4],[-1.25,-1.5],[1.25,-1.5]]){
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI/2; w.position.set(wx,0.55,wz); g.add(w);
  }
  // roof number / name for the Hornet via a small canvas texture
  if (isHornet){
    const tex = makeTextTexture('41');
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(1.6,1.6),
                  new THREE.MeshBasicMaterial({map:tex, transparent:true}));
    roof.rotation.x = -Math.PI/2; roof.position.set(0,1.97,-0.2); g.add(roof);
  }
  return g;
}
function makeTextTexture(txt){
  const cv = document.createElement('canvas'); cv.width=cv.height=128;
  const x = cv.getContext('2d');
  x.fillStyle='rgba(0,0,0,0)'; x.fillRect(0,0,128,128);
  x.fillStyle='#ffffff'; x.font='bold 90px Arial'; x.textAlign='center'; x.textBaseline='middle';
  x.fillText(txt,64,68);
  const t = new THREE.CanvasTexture(cv); t.needsUpdate=true; return t;
}

// ---------------------------------------------------------------------------
// Helpers: map (distance, offset) -> world
// ---------------------------------------------------------------------------
function frameAt(dist){
  let u = (dist % G.L) / G.L; if (u<0) u+=1;
  return frames[Math.floor(u*DIV) % DIV];
}
function worldPos(dist, offset, out){
  const f = frameAt(dist);
  return out.copy(f.pos).addScaledVector(f.right, offset * ROAD_W * 0.82);
}
function placeCar(mesh, dist, offset, yLift){
  const f = frameAt(dist);
  worldPos(dist, offset, mesh.position); mesh.position.y += (yLift||0);
  // orient along tangent (yaw + pitch)
  const t = f.tan;
  mesh.rotation.order = 'YXZ';
  mesh.rotation.y = Math.atan2(t.x, t.z);
  mesh.rotation.x = -Math.atan2(t.y, Math.hypot(t.x,t.z));
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = { left:false,right:false,gas:false,brake:false,reverse:false };
function bindKey(code,d){
  switch(code){
    case 'ArrowLeft': case 'KeyA': keys.left=d; break;
    case 'ArrowRight': case 'KeyD': keys.right=d; break;
    case 'ArrowUp': case 'KeyW': keys.gas=d; break;
    case 'ArrowDown': case 'KeyS': keys.reverse=d; break;
    case 'Space': keys.brake=d; break;
  }
}
window.addEventListener('keydown', e=>{
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].includes(e.code)) e.preventDefault();
  if (e.code==='KeyP'||e.code==='Escape'){ if(!e.repeat) togglePause(); return; }
  if (e.code==='KeyC'){ if(!e.repeat) G.camMode=(G.camMode+1)%2; return; }
  bindKey(e.code,true);
  if (G.state==='menu' && (e.code==='Enter'||e.code==='Space')) startRace();
});
window.addEventListener('keyup', e=>bindKey(e.code,false));
function bindTouch(id,key){
  const el=document.getElementById(id); if(!el) return;
  const set=v=>e=>{e.preventDefault();keys[key]=v;};
  el.addEventListener('touchstart',set(true),{passive:false});
  el.addEventListener('touchend',set(false),{passive:false});
  el.addEventListener('touchcancel',set(false),{passive:false});
}
bindTouch('tleft','left'); bindTouch('tright','right'); bindTouch('tgas','gas'); bindTouch('tbrake','brake');
if ('ontouchstart' in window) document.getElementById('touch').style.display='block';

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
let AC=null,engOsc=null,engGain=null,engFilter=null;
function initAudio(){
  if (AC) return;
  try{
    AC=new (window.AudioContext||window.webkitAudioContext)();
    engOsc=AC.createOscillator(); engOsc.type='sawtooth';
    engFilter=AC.createBiquadFilter(); engFilter.type='lowpass'; engFilter.frequency.value=800;
    engGain=AC.createGain(); engGain.gain.value=0;
    engOsc.connect(engFilter).connect(engGain).connect(AC.destination); engOsc.start();
  }catch(e){ AC=null; }
}
function updateEngine(){
  if(!AC) return;
  const r=Math.abs(G.speed)/G.maxSpeed;
  engOsc.frequency.setTargetAtTime(60+r*220+(G.skid>0?40:0), AC.currentTime,0.05);
  engFilter.frequency.setTargetAtTime(500+r*2500, AC.currentTime,0.05);
  engGain.gain.setTargetAtTime(G.state==='racing'?0.04+r*0.10:0, AC.currentTime,0.1);
}
function beep(f,d,t,v){
  if(!AC) return;
  const o=AC.createOscillator(),g=AC.createGain();
  o.type=t||'square'; o.frequency.value=f; g.gain.value=v||0.15;
  g.gain.setTargetAtTime(0.0001,AC.currentTime+d*0.5,d*0.3);
  o.connect(g).connect(AC.destination); o.start(); o.stop(AC.currentTime+d);
}

// ---------------------------------------------------------------------------
// Opponents
// ---------------------------------------------------------------------------
function resetCars(){
  G.cars=[]; rivalMeshes.forEach(m=>scene.remove(m)); rivalMeshes=[];
  const laneX=[-0.75,0.75,-0.4,0.4];
  const segLen = G.L/DIV;
  for (let i=0;i<OPPONENTS;i++){
    const row=Math.floor(i/4);
    const dist = ((10 + row*2.4) * (segLen*8)) % G.L;   // pack staggered up the road
    const car = {
      offset:laneX[i%4], targetLane:laneX[i%4], dist,
      basePace:(0.80+Math.random()*0.20)*G.aiSpeedMul, speed:0,
      color:LIVERIES[i%LIVERIES.length], lap:1, progress:0, jitter:Math.random()*6.28,
    };
    G.cars.push(car);
    const mesh = buildCarMesh(car.color, false);
    scene.add(mesh); rivalMeshes.push(mesh);
  }
}
function loopDelta(a,b){ let d=a-b; while(d>G.L/2)d-=G.L; while(d<-G.L/2)d+=G.L; return d; }
function approach(v,t,a){ return v>t?Math.max(t,v-a):Math.min(t,v+a); }

function updateCars(dt){
  const segLen=G.L/DIV;
  for (const car of G.cars){
    const f = frameAt(car.dist);
    const ahead = frameAt(car.dist + segLen*60);
    let pace=car.basePace;
    if (Math.abs(ahead.curv)>0.02) pace*=0.84; else if (Math.abs(ahead.curv)>0.01) pace*=0.93;
    const gap=loopDelta(car.dist,G.dist)/G.L;
    if (gap>0.04) pace*=0.94; else if (gap<-0.04) pace*=1.06;
    car.speed=approach(car.speed, G.maxSpeed*Math.max(0.45,Math.min(1.02,pace)), (G.maxSpeed/3)*dt);

    if (ahead.curv>0.012) car.targetLane=-0.6; else if (ahead.curv<-0.012) car.targetLane=0.6;
    let dodge=0;
    const dzP=loopDelta(car.dist,G.dist);
    if (dzP>0 && dzP<segLen*40 && Math.abs(car.offset-G.playerX)<0.7) dodge += car.offset>=G.playerX?1:-1;
    for (const o of G.cars){
      if (o===car) continue;
      const dz=loopDelta(o.dist,car.dist);
      if (dz>0 && dz<segLen*30 && Math.abs(o.offset-car.offset)<0.6){ dodge += car.offset>=o.offset?1:-1; car.speed=Math.min(car.speed,o.speed); }
    }
    let want=car.targetLane + dodge*0.7 + Math.sin(car.jitter+car.dist*0.01)*0.05;
    want=Math.max(-0.95,Math.min(0.95,want));
    car.offset=approach(car.offset, want, dt*1.6);

    car.dist += car.speed*dt;
    if (car.dist>=G.L){ car.dist-=G.L; car.lap++; }
    car.progress=car.lap*G.L + car.dist;
    void f;
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
function update(dt){
  if (G.state==='countdown'){
    G.countdown-=dt;
    const n=Math.ceil(G.countdown); const el=document.getElementById('countdown');
    if (G.countdown<=0){ G.state='racing'; el.classList.add('hidden'); beep(880,0.4,'square',0.2); }
    else { el.textContent=n; if(el.dataset.last!=n){el.dataset.last=n; beep(440,0.15,'square',0.15);} }
    return;
  }
  if (G.state!=='racing') return;

  const f = frameAt(G.dist);
  const sp = G.speed/G.maxSpeed;
  const segLen = G.L/DIV;

  const dx = dt*1.9*sp;
  if (keys.left) G.playerX-=dx;
  if (keys.right) G.playerX+=dx;
  G.playerX -= dx*sp*f.curv*42*G.curveMul;     // centrifugal on curves

  const accel=G.maxSpeed/4.5, brake=-G.maxSpeed/2.2, decel=-G.maxSpeed/5.5;
  if (keys.gas && !keys.reverse) G.speed+=accel*dt;
  else if (keys.reverse) G.speed+=brake*dt;
  else G.speed=approach(G.speed,0,-decel*dt);
  if (keys.brake) G.speed=approach(G.speed,0,-brake*dt);

  G.skid=Math.max(0,G.skid-dt);
  if ((G.playerX<-1||G.playerX>1) && G.speed>G.maxSpeed*0.2){
    G.speed += decel*dt*2; G.speed*=1-0.55*dt; G.shake=0.5;
    if (Math.random()<0.1) beep(120,0.05,'sawtooth',0.05);
  }
  if (G.speed>0){
    for (const car of G.cars){
      const d=loopDelta(car.dist,G.dist);
      if (d>0 && d<segLen*14 && Math.abs(G.playerX-car.offset)<0.9){
        G.speed=car.speed*0.85;
        const side=(G.playerX>=car.offset)?1:-1;
        G.playerX=Math.max(-1.0,Math.min(1.0,G.playerX+side*0.18));
        G.shake=0.8; G.skid=0.3; beep(90,0.12,'sawtooth',0.18);
      }
    }
  }
  G.speed=Math.max(-G.maxSpeed*0.25, Math.min(G.speed,G.maxSpeed));
  if (Math.abs(G.playerX)>0.7 && Math.abs(f.curv)>0.012 && G.speed>G.maxSpeed*0.6) G.skid=Math.max(G.skid,0.2);

  G.dist += G.speed*dt;
  while (G.dist>=G.L){ G.dist-=G.L; if(G.reversedLine){G.reversedLine=false;G.lap++;} else onLapComplete(); }
  while (G.dist<0){ G.dist+=G.L; G.lap--; G.reversedLine=true; }
  G.playerX=Math.max(-2.2,Math.min(2.2,G.playerX));

  G.lapTime+=dt; G.totalTime+=dt; G.timeLeft-=dt;
  if (G.timeLeft<=0){ G.timeLeft=0; flashBanner('TIME UP'); finishRace(false); return; }
  G.shake=Math.max(0,G.shake-dt*2);

  updateCars(dt);
  const myProg=G.lap*G.L+G.dist; let ah=0;
  for (const car of G.cars) if (car.progress>myProg) ah++;
  G.place=ah+1;
}
function onLapComplete(){
  G.lastLapTime=G.lapTime;
  if (G.lapTime<G.bestLapTime){ G.bestLapTime=G.lapTime; flashBanner('FAST LAP!'); beep(1046,0.4,'square',0.18); }
  G.lapTime=0; G.lap++; G.timeLeft+=G.lapBonus; flashBanner('CHECKPOINT +'+G.lapBonus);
  if (G.lap>G.totalLaps){ finishRace(true); return; }
  beep(660,0.25,'square',0.15);
}
function flashBanner(t){ const b=document.getElementById('banner'); b.textContent=t; b.classList.remove('hidden'); G.bannerTimer=1.4; }

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const _camPos=new THREE.Vector3(), _look=new THREE.Vector3(), _fwd=new THREE.Vector3(), _tmp=new THREE.Vector3();
function render(){
  // place player + rivals
  placeCar(playerCar, G.dist, G.playerX, 0);
  for (let i=0;i<G.cars.length;i++) placeCar(rivalMeshes[i], G.cars[i].dist, G.cars[i].offset, 0);

  // chase / hood camera
  const f = frameAt(G.dist);
  _fwd.copy(f.tan);
  worldPos(G.dist, G.playerX, _tmp);
  if (G.camMode===0){
    _camPos.copy(_tmp).addScaledVector(_fwd,-11).add(new THREE.Vector3(0,4.6,0));
    _look.copy(_tmp).addScaledVector(_fwd,12); _look.y+=1.2;
  } else {
    _camPos.copy(_tmp).addScaledVector(_fwd,0.2); _camPos.y+=2.2;
    _look.copy(_tmp).addScaledVector(_fwd,14); _look.y+=1.0;
  }
  if (G.shake>0){ _camPos.x+=(Math.random()-0.5)*G.shake; _camPos.y+=(Math.random()-0.5)*G.shake; }
  camera.position.lerp(_camPos, 0.25);
  camera.lookAt(_look);

  renderer.render(scene, camera);

  if (G.bannerTimer>0){ G.bannerTimer-=STEP; if(G.bannerTimer<=0) document.getElementById('banner').classList.add('hidden'); }
  drawHUD2D(); drawTextHUD();
}

// ---------------------------------------------------------------------------
// HUD overlay (rev gauge + minimap) on the 2D canvas
// ---------------------------------------------------------------------------
function lerp(a,b,t){ return a+(b-a)*t; }
function drawHUD2D(){
  const W=hud2d.width, H=hud2d.height;
  hctx.clearRect(0,0,W,H);
  // rev gauge
  const gx=W/2, gy=H*0.255, gr=Math.min(W,H)*0.1;
  const a0=Math.PI*1.18, a1=Math.PI*1.82, ticks=10;
  hctx.lineWidth=Math.max(5,gr*0.16); hctx.lineCap='round';
  for (let i=0;i<ticks;i++){
    hctx.strokeStyle=`hsl(${(1-i/ticks)*230},90%,55%)`;
    hctx.beginPath(); hctx.arc(gx,gy,gr,lerp(a0,a1,i/ticks),lerp(a0,a1,(i+1)/ticks)); hctx.stroke();
  }
  hctx.fillStyle='#fff'; hctx.font=`bold ${Math.max(7,gr*0.18)}px Arial`; hctx.textAlign='center'; hctx.textBaseline='middle';
  for (let i=0;i<=ticks;i++){ const a=lerp(a0,a1,i/ticks),rr=gr+gr*0.28; hctx.fillText(i,gx+Math.cos(a)*rr,gy+Math.sin(a)*rr); }
  const rev=Math.min(1,Math.abs(G.speed)/G.maxSpeed), na=lerp(a0,a1,rev);
  hctx.strokeStyle='#ffd400'; hctx.lineWidth=Math.max(2,gr*0.07);
  hctx.beginPath(); hctx.moveTo(gx,gy); hctx.lineTo(gx+Math.cos(na)*gr*0.92,gy+Math.sin(na)*gr*0.92); hctx.stroke();
  hctx.fillStyle='#ffd400'; hctx.beginPath(); hctx.arc(gx,gy,gr*0.11,0,6.28); hctx.fill();
  hctx.fillStyle='#2bd451'; hctx.font=`bold ${Math.max(12,gr*0.4)}px Arial`; hctx.textBaseline='alphabetic';
  hctx.fillText(Math.round(rev*100)+'%',gx,gy+gr*0.62);
  // minimap
  drawMinimap(W,H);
}
function drawMinimap(W,H){
  if(!miniPath.length) return;
  const size=Math.min(W,H)*0.18, pad=W*0.012, bx=W-size-pad, by=H*0.30;
  const box=G.mapBox, sc=(size*0.82)/Math.max(box.w,box.h);
  const ox=bx+size/2-(box.minX+box.w/2)*sc, oy=by+size/2-(box.minZ+box.h/2)*sc;
  hctx.strokeStyle='rgba(255,255,255,0.85)'; hctx.lineWidth=2;
  hctx.strokeRect(bx,by,size,size);
  hctx.strokeStyle='#cfd6dd'; hctx.lineWidth=Math.max(2,size*0.03); hctx.beginPath();
  for (let i=0;i<miniPath.length;i++){ const p=miniPath[i],X=ox+p.x*sc,Y=oy+p.z*sc; i?hctx.lineTo(X,Y):hctx.moveTo(X,Y); }
  hctx.closePath(); hctx.stroke();
  for (const car of G.cars){
    if (Math.abs(loopDelta(car.dist,G.dist))>G.L*0.35) continue;
    const f=frameAt(car.dist); hctx.fillStyle='#ff7fc4'; hctx.fillRect(ox+f.pos.x*sc-2,oy+f.pos.z*sc-2,4,4);
  }
  const pf=frameAt(G.dist); hctx.fillStyle='#ff2a2a'; hctx.fillRect(ox+pf.pos.x*sc-3,oy+pf.pos.z*sc-3,6,6);
  hctx.fillStyle='#fff'; hctx.font=`bold ${Math.max(9,size*0.1)}px Arial`; hctx.textAlign='center';
  hctx.fillText('TRAFFIC',bx+size/2,by+size+size*0.13);
}
function fmtArcade(t){
  if(!isFinite(t)) return `--'--"--`;
  const m=Math.floor(t/60),s=Math.floor(t%60),cs=Math.floor((t*100)%100);
  return `${m}'${String(s).padStart(2,'0')}"${String(cs).padStart(2,'0')}`;
}
function drawTextHUD(){
  document.getElementById('lapNum').textContent=Math.max(1,Math.min(G.lap,G.totalLaps));
  document.getElementById('lapTotal').textContent=G.totalLaps;
  document.getElementById('lapTimeVal').textContent=fmtArcade(G.lapTime);
  const tv=document.getElementById('timerVal'); tv.textContent=Math.ceil(G.timeLeft);
  tv.style.color=G.timeLeft<8?'#ff3b3b':'#ffd400';
  document.getElementById('posNum').textContent=G.place;
  document.getElementById('posTotal').textContent=FIELD;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
function menuHTML(){
  return `
    <h1 class="title">DAYTONA <span class="red">USA</span></h1>
    <div class="subtitle">3D POLYGON EDITION</div>
    <div class="menu-card">
      <h2>SELECT COURSE</h2>
      <div class="diff">
        <button class="btn ghost ${G.diff===0?'sel':''}" data-diff="0">BEGINNER</button>
        <button class="btn ghost ${G.diff===1?'sel':''}" data-diff="1">ADVANCED</button>
        <button class="btn ghost ${G.diff===2?'sel':''}" data-diff="2">EXPERT</button>
      </div>
      <div class="keys">
        <b>↑ / W</b><span>Accelerate</span><b>↓ / S</b><span>Reverse</span>
        <b>← → / A D</b><span>Steer</span><b>SPACE</b><span>Brake</span>
        <b>C</b><span>Change camera</span><b>P / ESC</b><span>Pause</span>
      </div>
      <button class="btn" id="startBtn">START ENGINE ▶</button>
    </div>
    <div class="credit">A homage to SEGA's Daytona USA (1993). Fan-made, non-commercial. •
      <a href="../index.html" style="color:#9fe">2D arcade version</a></div>`;
}
function showMenu(){ G.state='menu'; const el=document.getElementById('overlay'); el.innerHTML=menuHTML(); el.classList.remove('hidden'); wireMenu(); }
function wireMenu(){
  document.querySelectorAll('[data-diff]').forEach(b=>{
    b.onclick=()=>{ G.diff=parseInt(b.dataset.diff,10);
      document.querySelectorAll('[data-diff]').forEach(x=>x.classList.remove('sel')); b.classList.add('sel'); beep(520,0.08,'square',0.1); };
  });
  const s=document.getElementById('startBtn'); if(s) s.onclick=startRace;
}
function startRace(){
  initAudio(); if (AC&&AC.state==='suspended') AC.resume();
  const d=DIFFS[G.diff];
  G.maxSpeed=d.maxSpeed; G.curveMul=d.curveMul; G.aiSpeedMul=d.aiSpeed;
  G.totalLaps=d.laps; G.timeLeft=d.startTime; G.lapBonus=d.lapBonus;
  document.getElementById('trackName').textContent=d.name;

  buildTrack(d);
  if (!playerCar){ playerCar=buildCarMesh(0x1f54c8,true); scene.add(playerCar); }
  resetCars();
  G.dist=0; G.playerX=0; G.speed=0; G.lap=1; G.lapTime=0; G.lastLapTime=0; G.bestLapTime=Infinity;
  G.totalTime=0; G.place=FIELD; G.shake=0; G.skid=0; G.reversedLine=false;

  // snap camera behind the grid immediately
  placeCar(playerCar,0,0,0);
  const f=frameAt(0); worldPos(0,0,_tmp);
  camera.position.copy(_tmp).addScaledVector(f.tan,-11).add(new THREE.Vector3(0,4.6,0));
  camera.lookAt(_tmp);

  document.getElementById('overlay').classList.add('hidden');
  const cd=document.getElementById('countdown'); cd.classList.remove('hidden'); cd.textContent='3'; cd.dataset.last='3';
  G.countdown=3.0; G.state='countdown'; beep(440,0.15,'square',0.15);
}
function finishRace(completed){
  G.state='finished';
  const place=G.place, win=completed&&place===1;
  const ord=place+(['th','st','nd','rd'][(place%100>>3^1)&&place%10]||'th');
  const el=document.getElementById('overlay');
  el.innerHTML=`
    <h1 class="title">${win?'YOU <span class="red">WIN!</span>':(completed?'FINISH':'TIME <span class="red">UP</span>')}</h1>
    <div class="subtitle ${win?'flash':''}">${win?'DAYTONA!  CHAMPION!':(completed?'GOOD RACE — TRY AGAIN':'OUT OF TIME — TRY AGAIN')}</div>
    <div class="menu-card"><h2>RESULTS</h2>
      <div class="keys" style="grid-template-columns:auto 1fr;">
        <b>POSITION</b><span>${ord} of ${FIELD}</span>
        <b>LAPS</b><span>${Math.min(G.lap,G.totalLaps)} / ${G.totalLaps}</span>
        <b>TOTAL TIME</b><span>${fmtArcade(G.totalTime)}</span>
        <b>BEST LAP</b><span>${G.bestLapTime===Infinity?'--':fmtArcade(G.bestLapTime)}</span>
      </div>
      <button class="btn" id="againBtn">RACE AGAIN ▶</button>
    </div>`;
  el.classList.remove('hidden');
  document.getElementById('againBtn').onclick=()=>showMenu();
  beep(win?1318:220,0.6,'square',0.2);
}
function togglePause(){
  if (G.state==='racing'){
    G.state='paused';
    const el=document.getElementById('overlay');
    el.innerHTML=`<h1 class="title">PAUSED</h1><div class="menu-card">
      <button class="btn" id="resumeBtn">RESUME ▶</button><div style="height:10px"></div>
      <button class="btn ghost" id="quitBtn">QUIT TO MENU</button></div>`;
    el.classList.remove('hidden');
    document.getElementById('resumeBtn').onclick=()=>{el.classList.add('hidden');G.state='racing';};
    document.getElementById('quitBtn').onclick=()=>showMenu();
  } else if (G.state==='paused'){ document.getElementById('overlay').classList.add('hidden'); G.state='racing'; }
}

// ---------------------------------------------------------------------------
// Resize + loop
// ---------------------------------------------------------------------------
function resize(){
  const w=window.innerWidth, h=window.innerHeight;
  renderer.setSize(w,h,false);
  camera.aspect=w/h; camera.updateProjectionMatrix();
  const dpr=Math.min(2,window.devicePixelRatio||1);
  hud2d.width=Math.round(w*dpr); hud2d.height=Math.round(h*dpr);
  hud2d.style.width=w+'px'; hud2d.style.height=h+'px';
}
let last=performance.now(), acc=0;
function frame(now){
  let dt=(now-last)/1000; if (dt>0.1) dt=0.1; last=now; acc+=dt;
  while (acc>=STEP){ update(STEP); acc-=STEP; }
  updateEngine();
  if (scene && camera) render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
try {
  initThree();
  // build a default track so the menu has a world behind it
  buildTrack(DIFFS[0]);
  playerCar=buildCarMesh(0x1f54c8,true); scene.add(playerCar); placeCar(playerCar,0,0,0);
  const f=frameAt(0); worldPos(0,0,_tmp);
  camera.position.copy(_tmp).addScaledVector(f.tan,-11).add(new THREE.Vector3(0,5,0)); camera.lookAt(_tmp);
  wireMenu();
  requestAnimationFrame(frame);
} catch (e) {
  const err=document.getElementById('err');
  err.style.display='flex';
  err.innerHTML='<div>⚠️ Could not start 3D mode (WebGL may be unavailable).<br>'+
    'Try the <a href="../index.html" style="color:#9fe">2D arcade version</a>.<br><br>'+
    '<small style="opacity:.6">'+(e&&e.message?e.message:e)+'</small></div>';
  console.error(e);
}

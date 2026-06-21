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
  { name:'THREE-SEVEN SPEEDWAY',  laps:8, maxSpeed:108, curveMul:0.8, aiSpeed:0.72, startTime:55, lapBonus:24, seed:1, theme:0 },
  { name:'DINOSAUR CANYON',       laps:4, maxSpeed:122, curveMul:1.0, aiSpeed:0.82, startTime:62, lapBonus:34, seed:7, theme:1 },
  { name:'SEA-SIDE STREET GALAXY',laps:8, maxSpeed:136, curveMul:1.2, aiSpeed:0.90, startTime:70, lapBonus:30, seed:3, theme:2 },
];
// per-course environment themes (colours, props, set-pieces)
const THEMES = [
  { // alpine speedway
    asphalt:0x83878d, grass:0x4a9c54, grass2:0x3f8f49, mountain:0x8a9099, snow:true,
    prop:'pine', water:false, dino:false, tunnel:true,
    skyTop:'#1f6fd6', skyMid:'#5aa6f0', skyHorizon:'#dff0ff', fog:0xbfe2ff,
  },
  { // dinosaur canyon (desert)
    asphalt:0x8a8079, grass:0xb89a5e, grass2:0xa98a4e, mountain:0xb5793f, snow:false,
    prop:'rock', water:false, dino:true, tunnel:true,
    skyTop:'#3a78c0', skyMid:'#9ab6d0', skyHorizon:'#e9d9b8', fog:0xe2d2ad,
  },
  { // sea-side galaxy
    asphalt:0x8a8e94, grass:0x4aa86a, grass2:0x3f9a5e, mountain:0x6f88a0, snow:false,
    prop:'palm', water:true, dino:false, tunnel:false,
    skyTop:'#1a86d6', skyMid:'#57b6ef', skyHorizon:'#bfeaff', fog:0xbfeaff,
  },
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
  reversedLine:false, camMode:0, theme:null,
};

// ---------------------------------------------------------------------------
// Three.js core
// ---------------------------------------------------------------------------
let renderer, scene, camera, sky;
let frames = [];      // [{pos:Vector3, tan:Vector3, right:Vector3, curv:Number}]
let playerCar, rivalMeshes = [];
const UP = new THREE.Vector3(0,1,0);

// Painted sky: vertical gradient + a glowing sun + soft clouds, on a big dome
function makeSkyTexture(th){
  th = th || THEMES[0];
  const cv=document.createElement('canvas'); cv.width=1024; cv.height=512; const x=cv.getContext('2d');
  const g=x.createLinearGradient(0,0,0,512);
  g.addColorStop(0,th.skyTop); g.addColorStop(0.55,th.skyMid); g.addColorStop(0.8,th.skyHorizon); g.addColorStop(1,th.skyHorizon);
  x.fillStyle=g; x.fillRect(0,0,1024,512);
  // sun with halo
  const sx=300, sy=120;
  const hal=x.createRadialGradient(sx,sy,8,sx,sy,150);
  hal.addColorStop(0,'rgba(255,250,210,0.95)'); hal.addColorStop(0.3,'rgba(255,245,190,0.4)'); hal.addColorStop(1,'rgba(255,245,190,0)');
  x.fillStyle=hal; x.fillRect(sx-160,sy-160,320,320);
  x.fillStyle='#fffbe0'; x.beginPath(); x.arc(sx,sy,46,0,6.28); x.fill();
  // clouds
  x.fillStyle='rgba(255,255,255,0.9)';
  function cloud(cx,cy,s){ for(let k=0;k<6;k++){ const a=k/6*6.28; x.beginPath(); x.ellipse(cx+Math.cos(a)*s*1.2,cy+Math.sin(a)*s*0.4,s*(0.8+Math.random()*0.5),s*0.55,0,0,6.28); x.fill(); } }
  for (let i=0;i<7;i++) cloud(120+Math.random()*900, 150+Math.random()*180, 22+Math.random()*26);
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
}
function buildSky(th){
  if (sky){ scene.remove(sky); sky.geometry.dispose(); sky.material.map.dispose(); sky.material.dispose(); }
  const geo=new THREE.SphereGeometry(1200,32,16);
  const mat=new THREE.MeshBasicMaterial({map:makeSkyTexture(th), side:THREE.BackSide, fog:false, depthWrite:false});
  sky=new THREE.Mesh(geo,mat); scene.add(sky);
  // environment map so PBR car paint reflects the sky
  if (renderer){
    const pm = new THREE.PMREMGenerator(renderer);
    const eq = makeSkyTexture(th); eq.mapping = THREE.EquirectangularReflectionMapping;
    const rt = pm.fromEquirectangular(eq);
    if (scene.environment) scene.environment.dispose();
    scene.environment = rt.texture;
    eq.dispose(); pm.dispose();
  }
}

let sun = null;
const MOBILE = (typeof window!=='undefined') &&
  (('ontouchstart' in window) || (window.matchMedia && matchMedia('(pointer:coarse)').matches));

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas:glCanvas, antialias:!MOBILE, powerPreference:'high-performance' });
  renderer.setPixelRatio(Math.min(MOBILE?1.5:2, window.devicePixelRatio || 1));
  // cinematic colour + soft shadows
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6fb7ff);
  scene.fog = new THREE.Fog(0xbfe2ff, 320, 900);

  camera = new THREE.PerspectiveCamera(62, 1, 0.5, 3000);
  buildSky();

  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x5a8a4a, 1.0));
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  sun = new THREE.DirectionalLight(0xfff3d0, 2.0);
  sun.position.set(60, 120, 30);
  sun.castShadow = true;
  const SM = MOBILE ? 1024 : 2048;
  sun.shadow.mapSize.set(SM, SM);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 320;
  const S = 70;
  sun.shadow.camera.left = -S; sun.shadow.camera.right = S;
  sun.shadow.camera.top = S; sun.shadow.camera.bottom = -S;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
  scene.add(sun); scene.add(sun.target);   // target follows the player each frame

  resize();
  window.addEventListener('resize', resize);
}

// ---------------------------------------------------------------------------
// Track construction
// ---------------------------------------------------------------------------
function mulberry32(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

let sceneryGroup=null, miniPath=[];

function buildTrack(diff) {
  G.theme = THEMES[diff.theme || 0];
  scene.background.set(G.theme.skyHorizon);
  scene.fog.color.setHex(G.theme.fog);
  buildSky(G.theme);
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
    const flatRight = new THREE.Vector3().crossVectors(tan, UP).normalize(); // horizontal right
    frames.push({ pos, tan, flatRight, right:flatRight.clone(), up:UP.clone(), curv:0, bank:0 });
  }
  // signed curvature (heading change per sample)
  for (let i=0;i<DIV;i++){
    const a = frames[i].tan, b = frames[(i+1)%DIV].tan;
    const ha = Math.atan2(a.x, a.z), hb = Math.atan2(b.x, b.z);
    let d = hb - ha; while (d>Math.PI) d-=Math.PI*2; while (d<-Math.PI) d+=Math.PI*2;
    frames[i].curv = d;
  }
  // ---- banked corners: smooth the curvature, then tilt each cross-section ----
  const sm = new Array(DIV);
  const WIN = 14;
  for (let i=0;i<DIV;i++){
    let s=0; for (let k=-WIN;k<=WIN;k++) s += frames[(i+k+DIV)%DIV].curv;
    sm[i] = s/(WIN*2+1);
  }
  const BANK_K = 42, MAXB = 0.62;     // up to ~35° of banking on the hardest turns (Daytona-style)
  for (let i=0;i<DIV;i++){
    const f = frames[i];
    f.bank = Math.max(-MAXB, Math.min(MAXB, sm[i]*BANK_K*G.curveMul));
    f.right = f.flatRight.clone().applyAxisAngle(f.tan, f.bank);
    f.up = new THREE.Vector3().crossVectors(f.tan, f.right).normalize();
  }

  buildRoadMesh();
  buildScenery(rng);
  buildMinimap();
}

// Build the road as: a UV-textured asphalt ribbon (with lane markings baked into
// the texture), a tiled grass ribbon, and a vertex-coloured "trim" mesh for the
// kerbs, guardrails and start/finish checker. Normals come from each frame's
// banked surface normal so lighting stays correct through banking and hills.
let roadParts = [];
// Fully release a mesh/group's GPU resources (geometry, materials, textures) so
// rebuilding the world each race (incl. the Restart button) doesn't leak.
function disposeTree(obj){
  obj.traverse(o=>{
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const mt of mats){ if (mt.map) mt.map.dispose(); mt.dispose(); }
  });
}
function clearRoadParts(){ for (const m of roadParts){ scene.remove(m); disposeTree(m); } roadParts=[]; }
const V3 = THREE.Vector3;

function buildRoadMesh() {
  clearRoadParts();
  const th = G.theme;
  const segLen = G.L/DIV;
  const TILE = 20;                 // world units of track per texture repeat
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  function pt(out, frame, lat, lift){
    out.copy(frame.pos).addScaledVector(frame.right, lat).addScaledVector(frame.up, lift); return out;
  }

  // ---------- asphalt (textured) ----------
  {
    const pos=[],uv=[],nor=[];
    const ia=new V3,oa=new V3,ib=new V3,ob=new V3;
    const push=(p,u,v,n)=>{ pos.push(p.x,p.y,p.z); uv.push(u,v); nor.push(n.x,n.y,n.z); };
    for (let i=0;i<DIV;i++){
      const a=frames[i], b=frames[(i+1)%DIV];
      pt(ia,a,-ROAD_W,0); pt(oa,a,ROAD_W,0); pt(ib,b,-ROAD_W,0); pt(ob,b,ROAD_W,0);
      const va=i*segLen/TILE, vb=(i+1)*segLen/TILE;
      push(ia,0,va,a.up); push(ib,0,vb,b.up); push(ob,1,vb,b.up);
      push(ia,0,va,a.up); push(ob,1,vb,b.up); push(oa,1,va,a.up);
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    geo.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
    const tex=makeAsphaltTexture(th);
    tex.wrapS=THREE.ClampToEdgeWrapping; tex.wrapT=THREE.RepeatWrapping; tex.anisotropy=maxAniso;
    const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map:tex}));
    mesh.receiveShadow=true; scene.add(mesh); roadParts.push(mesh);
  }

  // ---------- grass verges (tiled texture) ----------
  {
    const pos=[],uv=[],nor=[];
    const ia=new V3,oa=new V3,ib=new V3,ob=new V3;
    const push=(p,u,v,n)=>{ pos.push(p.x,p.y,p.z); uv.push(u,v); nor.push(n.x,n.y,n.z); };
    const GW=ROAD_W*6, GTILE=14;
    for (const sgn of [-1,1]) for (let i=0;i<DIV;i++){
      const a=frames[i], b=frames[(i+1)%DIV];
      const li=sgn*(ROAD_W+RUMBLE_W), lo=sgn*GW;
      pt(ia,a,li,-0.05); pt(oa,a,lo,-0.05); pt(ib,b,li,-0.05); pt(ob,b,lo,-0.05);
      const va=i*segLen/GTILE, vb=(i+1)*segLen/GTILE, uo=(GW-ROAD_W-RUMBLE_W)/GTILE;
      push(ia,0,va,a.up); push(ib,0,vb,b.up); push(ob,uo,vb,b.up);
      push(ia,0,va,a.up); push(ob,uo,vb,b.up); push(oa,uo,va,a.up);
    }
    const geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    geo.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
    const tex=makeGroundTexture(th);
    tex.wrapS=THREE.RepeatWrapping; tex.wrapT=THREE.RepeatWrapping; tex.anisotropy=maxAniso;
    const mesh=new THREE.Mesh(geo, new THREE.MeshLambertMaterial({map:tex, side:THREE.DoubleSide}));
    mesh.receiveShadow=true; scene.add(mesh); roadParts.push(mesh);
  }

  // ---------- trim: kerbs + guardrails + checker (vertex colours) ----------
  {
    const pos=[],col=[],nor=[]; const c=new THREE.Color();
    const vert=(p,n)=>{ pos.push(p.x,p.y,p.z); col.push(c.r,c.g,c.b); nor.push(n.x,n.y,n.z); };
    const ia=new V3,oa=new V3,ib=new V3,ob=new V3;
    function ribbon(latIn,latOut,lift,colorFn){
      for (let i=0;i<DIV;i++){
        const a=frames[i], b=frames[(i+1)%DIV];
        pt(ia,a,latIn,lift); pt(oa,a,latOut,lift); pt(ib,b,latIn,lift); pt(ob,b,latOut,lift);
        colorFn(i,c);
        vert(ia,a.up); vert(ib,b.up); vert(ob,b.up); vert(ia,a.up); vert(ob,b.up); vert(oa,a.up);
      }
    }
    // rumble kerbs
    ribbon(-ROAD_W-RUMBLE_W,-ROAD_W,0.02, i=>Math.floor(i/4)%2?c.setHex(0xd03a32):c.setHex(0xe9e9ee));
    ribbon( ROAD_W,ROAD_W+RUMBLE_W,0.02, i=>Math.floor(i/4)%2?c.setHex(0xd03a32):c.setHex(0xe9e9ee));
    // guardrails
    function guardrail(lat){
      const inward=lat>0?-1:1;
      for (let i=0;i<DIV;i++){
        const a=frames[i], b=frames[(i+1)%DIV];
        pt(ia,a,lat,0.15); pt(oa,a,lat,1.15); pt(ib,b,lat,0.15); pt(ob,b,lat,1.15);
        const na=a.right.clone().multiplyScalar(inward), nb=b.right.clone().multiplyScalar(inward);
        c.setHex(Math.floor(i/3)%4===0?0xd03a32:0xeef1f4);
        vert(ia,na); vert(ib,nb); vert(ob,nb); vert(ia,na); vert(ob,nb); vert(oa,na);
      }
    }
    guardrail(-ROAD_W-RUMBLE_W-0.4); guardrail(ROAD_W+RUMBLE_W+0.4);
    // start/finish checker
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

// ---- procedural surface textures (theme-tinted) ----
function makeAsphaltTexture(th){
  const cv=document.createElement('canvas'); cv.width=128; cv.height=256; const x=cv.getContext('2d');
  x.fillStyle='#'+th.asphalt.toString(16).padStart(6,'0'); x.fillRect(0,0,128,256);
  // grain
  for (let i=0;i<2600;i++){ const g=200+Math.random()*55|0; x.fillStyle=`rgba(${g},${g},${g},${Math.random()*0.10})`; x.fillRect(Math.random()*128,Math.random()*256,1.5,1.5); }
  for (let i=0;i<1400;i++){ x.fillStyle=`rgba(0,0,0,${Math.random()*0.12})`; x.fillRect(Math.random()*128,Math.random()*256,2,2); }
  // edge lines (solid white)
  x.fillStyle='#eef1f4'; x.fillRect(3,0,4,256); x.fillRect(121,0,4,256);
  // lane dividers (dashed white) at 1/3 and 2/3 across
  for (const cx of [128/3, 256/3]){
    x.fillStyle='#e9e9ee'; x.fillRect(cx-2,8,4,86); x.fillRect(cx-2,134,4,86);
  }
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
}
function makeGroundTexture(th){
  const cv=document.createElement('canvas'); cv.width=128; cv.height=128; const x=cv.getContext('2d');
  const base=th.grass.toString(16).padStart(6,'0');
  x.fillStyle='#'+base; x.fillRect(0,0,128,128);
  const g2='#'+th.grass2.toString(16).padStart(6,'0');
  for (let i=0;i<1800;i++){ x.fillStyle = Math.random()<0.5?g2:'rgba(255,255,255,0.05)'; x.fillRect(Math.random()*128,Math.random()*128,Math.random()*3+1,Math.random()*3+1); }
  // blades / speckle
  for (let i=0;i<500;i++){ x.fillStyle=`rgba(0,0,0,${Math.random()*0.08})`; x.fillRect(Math.random()*128,Math.random()*128,1,2); }
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
}

// Theme-aware scenery: course-specific props, set-pieces, a tunnel and the gantry
function buildScenery(rng) {
  if (sceneryGroup){ scene.remove(sceneryGroup); disposeTree(sceneryGroup); }
  sceneryGroup = new THREE.Group();
  const th = G.theme;

  // ---- prop factories ----
  const pineTrunk = new THREE.MeshLambertMaterial({color:0x5b4226});
  const pineLeaf  = new THREE.MeshLambertMaterial({color:0x1f6b2e});
  function pine(scale){
    const g = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.4,2,6), pineTrunk); t.position.y=1; g.add(t);
    for (let k=0;k<3;k++){
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.2-k*0.5, 2.6, 7), pineLeaf);
      cone.position.y = 2.2 + k*1.5; g.add(cone);
    }
    g.scale.setScalar(scale); return g;
  }
  const rockMat = new THREE.MeshLambertMaterial({color:0xb5793f, flatShading:true});
  const rockMat2= new THREE.MeshLambertMaterial({color:0x9c6534, flatShading:true});
  function rock(scale){
    const g=new THREE.Group();
    const h=3+rng()*4;
    const m=new THREE.Mesh(new THREE.ConeGeometry(2.2+rng()*1.5, h, 5), rng()<0.5?rockMat:rockMat2);
    m.position.y=h/2; m.rotation.y=rng()*6.28; g.add(m);
    const m2=new THREE.Mesh(new THREE.DodecahedronGeometry(1.4+rng()), rockMat2); m2.position.set(1.5,0.8,0.5); g.add(m2);
    g.scale.setScalar(scale); return g;
  }
  const palmTrunk=new THREE.MeshLambertMaterial({color:0x8a6a3a});
  const palmLeaf =new THREE.MeshLambertMaterial({color:0x2f9c4a, side:THREE.DoubleSide});
  function palm(scale){
    const g=new THREE.Group();
    const t=new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.34,5,7), palmTrunk); t.position.y=2.5; t.rotation.z=0.12; g.add(t);
    for (let k=0;k<7;k++){
      const fr=new THREE.Mesh(new THREE.ConeGeometry(0.5,3.4,4), palmLeaf);
      fr.position.y=5; fr.rotation.z=Math.PI/2 - 0.5; fr.rotation.y=k/7*6.28;
      const piv=new THREE.Group(); piv.add(fr); piv.rotation.y=k/7*6.28; piv.children[0].position.set(1.6,5,0); piv.children[0].rotation.set(0,0,-0.5);
      g.add(piv);
    }
    g.scale.setScalar(scale); return g;
  }
  const makeProp = th.prop==='rock' ? rock : th.prop==='palm' ? palm : pine;

  // ---- line the verges with the course's props ----
  for (let i=0;i<DIV;i+=10){
    const side=(i%20===0)?1:-1, f=frames[i];
    const p=makeProp(1.2 + rng()*1.3);
    p.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+6+rng()*16));
    sceneryGroup.add(p);
  }
  // ---- distant mountain / canyon-wall ring ----
  const mtnMat = new THREE.MeshLambertMaterial({color:th.mountain, flatShading:true});
  const snowMat = new THREE.MeshLambertMaterial({color:0xeef3f7, flatShading:true});
  for (let i=0;i<26;i++){
    const ang=(i/26)*Math.PI*2;
    const r=720 + (mulberry32(i+99)())*240;
    const h=130 + (mulberry32(i+5)())*200;
    const m=new THREE.Mesh(new THREE.ConeGeometry(h*0.9,h,5), mtnMat);
    m.position.set(Math.cos(ang)*r, h/2-40, Math.sin(ang)*r); sceneryGroup.add(m);
    if (th.snow){
      const cap=new THREE.Mesh(new THREE.ConeGeometry(h*0.32,h*0.34,5), snowMat);
      cap.position.set(Math.cos(ang)*r, h-40-h*0.17, Math.sin(ang)*r); sceneryGroup.add(cap);
    }
  }
  // ---- sea-side water plane ----
  if (th.water){
    const water=new THREE.Mesh(new THREE.PlaneGeometry(3600,3600),
      new THREE.MeshLambertMaterial({color:0x2a7fc4, transparent:true, opacity:0.88}));
    water.rotation.x=-Math.PI/2; water.position.y=-6; sceneryGroup.add(water);
  }
  // ---- dinosaur set-piece (canyon) ----
  if (th.dino){
    const di=Math.floor(DIV*0.45), f=frames[di];
    const dino=makeDinosaur();
    dino.position.copy(f.pos).addScaledVector(f.right, 60).setY((f.pos.y||0));
    dino.lookAt(f.pos.clone().setY(dino.position.y));
    sceneryGroup.add(dino);
  }
  // ---- tunnel over a mid-track stretch ----
  if (th.tunnel){
    const stoneA=new THREE.MeshLambertMaterial({color:0x6b6f74}), stoneB=new THREE.MeshLambertMaterial({color:0x595d62});
    const t0=Math.floor(DIV*0.6), t1=t0+34;
    for (let i=t0;i<t1;i+=2){
      const f=frames[i%DIV];
      const portal=new THREE.Group();
      const pl=new THREE.Mesh(new THREE.BoxGeometry(1.6,9,2.4), i%4?stoneA:stoneB); pl.position.set(-(ROAD_W+RUMBLE_W+0.8),4.5,0); portal.add(pl);
      const pr=pl.clone(); pr.position.x=ROAD_W+RUMBLE_W+0.8; portal.add(pr);
      const top=new THREE.Mesh(new THREE.BoxGeometry((ROAD_W+RUMBLE_W+1.6)*2,2.2,2.4), i%4?stoneB:stoneA); top.position.y=9.5; portal.add(top);
      portal.position.copy(f.pos); portal.lookAt(f.pos.clone().add(f.tan));
      sceneryGroup.add(portal);
    }
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
  // DAYTONA sign board on the gantry
  board.material = new THREE.MeshBasicMaterial({ map: makeSignTexture('DAYTONA', '#c1272d') });
  // orient gantry across the track
  gantry.position.copy(f0.pos);
  gantry.lookAt(f0.pos.clone().add(f0.tan));
  sceneryGroup.add(gantry);

  // grandstands packed with crowd along the start straight (outer side)
  const crowdTex = makeCrowdTexture();
  for (let s=0;s<4;s++){
    const idx=(8 + s*7)%DIV, f=frames[idx];
    const stand=new THREE.Group();
    const base=new THREE.Mesh(new THREE.BoxGeometry(26,9,8), new THREE.MeshLambertMaterial({color:0x9aa3b2}));
    base.position.y=4.5; stand.add(base);
    const seats=new THREE.Mesh(new THREE.PlaneGeometry(25,8.4), new THREE.MeshBasicMaterial({map:crowdTex}));
    seats.position.set(0,5.4,4.05); seats.rotation.x=-0.32; stand.add(seats);
    const roof=new THREE.Mesh(new THREE.BoxGeometry(27,0.6,9), new THREE.MeshLambertMaterial({color:0xd6262b}));
    roof.position.y=9.4; stand.add(roof);
    stand.position.copy(f.pos).addScaledVector(f.right, ROAD_W+RUMBLE_W+15);
    stand.lookAt(f.pos.clone().addScaledVector(f.right, 1).setY(stand.position.y));
    sceneryGroup.add(stand);
  }
  // roadside DAYTONA billboards
  for (let b=0;b<3;b++){
    const idx=(120 + b*180)%DIV, f=frames[idx], side=b%2?1:-1;
    const bd=new THREE.Group();
    const panel=new THREE.Mesh(new THREE.PlaneGeometry(16,6), new THREE.MeshBasicMaterial({map:makeSignTexture('DAYTONA USA','#1f54c8'), side:THREE.DoubleSide}));
    panel.position.y=9; bd.add(panel);
    const post=new THREE.Mesh(new THREE.BoxGeometry(0.6,12,0.6), new THREE.MeshLambertMaterial({color:0x555}));
    post.position.y=6; bd.add(post);
    bd.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+10));
    bd.lookAt(f.pos.clone().setY(bd.position.y));
    sceneryGroup.add(bd);
  }

  if (!MOBILE) sceneryGroup.traverse(o=>{ if (o.isMesh) o.castShadow = true; });
  scene.add(sceneryGroup);
}
// A simple brontosaurus silhouette for Dinosaur Canyon
function makeDinosaur(){
  const g=new THREE.Group();
  const skin=new THREE.MeshLambertMaterial({color:0x5f8a4a, flatShading:true});
  const body=new THREE.Mesh(new THREE.SphereGeometry(7,10,8), skin); body.scale.set(1.6,1,1); body.position.y=14; g.add(body);
  // neck
  let nx=0, ny=20;
  for (let k=0;k<6;k++){
    const seg=new THREE.Mesh(new THREE.CylinderGeometry(2.4-k*0.25,2.7-k*0.25,3.2,7), skin);
    nx+=2.0; ny+=2.4; seg.position.set(nx*0.4,ny-6, 6+k*1.2); seg.rotation.x=0.5; g.add(seg);
  }
  const head=new THREE.Mesh(new THREE.BoxGeometry(2.6,2.2,4), skin); head.position.set(1.0,21,13.5); g.add(head);
  // tail
  for (let k=0;k<6;k++){ const seg=new THREE.Mesh(new THREE.CylinderGeometry(2.6-k*0.4,3.0-k*0.4,3,7), skin); seg.position.set(0,12-k*0.6,-7-k*2.4); seg.rotation.x=-1.2; g.add(seg); }
  // legs
  for (const [lx,lz] of [[-3.5,4],[3.5,4],[-3.5,-4],[3.5,-4]]){ const leg=new THREE.Mesh(new THREE.CylinderGeometry(1.6,1.9,9,7), skin); leg.position.set(lx,5,lz); g.add(leg); }
  g.scale.setScalar(1.4);
  return g;
}
function makeCrowdTexture(){
  const cv=document.createElement('canvas'); cv.width=256; cv.height=96; const x=cv.getContext('2d');
  x.fillStyle='#41474f'; x.fillRect(0,0,256,96);
  for (let r=0;r<7;r++) for (let cc=0;cc<40;cc++){
    x.fillStyle=`hsl(${Math.random()*360},70%,${45+Math.random()*30}%)`;
    x.fillRect(cc*6+ (r%2)*3, r*13+3, 4, 7);
  }
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
}
function makeSignTexture(text, bg){
  const cv=document.createElement('canvas'); cv.width=512; cv.height=192; const x=cv.getContext('2d');
  x.fillStyle=bg; x.fillRect(0,0,512,192);
  x.fillStyle='#ffffff'; x.fillRect(8,8,496,176); x.fillStyle=bg; x.fillRect(16,16,480,160);
  x.fillStyle='#ffffff'; x.font='italic bold 92px Georgia'; x.textAlign='center'; x.textBaseline='middle';
  x.fillText(text,256,104);
  const t=new THREE.CanvasTexture(cv); t.colorSpace=THREE.SRGBColorSpace; return t;
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
function buildCarMesh(bodyColor, isHornet, number) {
  number = number==null ? 41 : number;
  const g = new THREE.Group();
  // glossy PBR car paint (reflects the sky env map); matte for rubber/plastic
  const paint = c => new THREE.MeshStandardMaterial({color:c, metalness:0.55, roughness:0.32});
  const matte = c => new THREE.MeshStandardMaterial({color:c, metalness:0.0, roughness:0.85});
  const mat = paint;
  const roof = isHornet ? 0x2056cf : shadeHex(bodyColor,-40);
  // low wide chassis
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.62, 4.9), mat(bodyColor));
  body.position.y = 0.62; g.add(body);
  // sloped hood (front deck a touch lower)
  const hood = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.4, 1.9), mat(bodyColor));
  hood.position.set(0, 0.82, 1.45); g.add(hood);
  // Hornet wrap-around stripe / generic accent
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.54,0.3,4.95), mat(isHornet?0xd6262b:shadeHex(bodyColor,-26)));
  stripe.position.y = 0.5; g.add(stripe);
  // white front splitter + bumper
  const split = new THREE.Mesh(new THREE.BoxGeometry(2.55,0.18,0.5), mat(0xeaeaee)); split.position.set(0,0.4,2.55); g.add(split);
  // greenhouse: low cabin set back, with angled pillars
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.1,0.56,2.0), mat(roof));
  cabin.position.set(0,1.18,-0.35); g.add(cabin);
  const glass = new THREE.MeshStandardMaterial({color:0x0e1a30, metalness:0.4, roughness:0.06});
  const ws = new THREE.Mesh(new THREE.BoxGeometry(1.9,0.62,0.12), glass);   // windshield
  ws.position.set(0,1.2,0.72); ws.rotation.x=0.5; g.add(ws);
  const rw = new THREE.Mesh(new THREE.BoxGeometry(1.9,0.6,0.12), glass);    // rear window
  rw.position.set(0,1.2,-1.42); rw.rotation.x=-0.5; g.add(rw);
  const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.1,0.5,1.9), glass); sideL.position.set(-1.0,1.2,-0.35); g.add(sideL);
  const sideR = sideL.clone(); sideR.position.x=1.0; g.add(sideR);
  // rear wing on uprights
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.5,0.12,0.7), mat(isHornet?0xd6262b:0x1a1a1a));
  wing.position.set(0,1.3,-2.5); g.add(wing);
  const upL = new THREE.Mesh(new THREE.BoxGeometry(0.14,0.5,0.4), mat(0x1a1a1a)); upL.position.set(-1.05,1.05,-2.4); g.add(upL);
  const upR = upL.clone(); upR.position.x=1.05; g.add(upR);
  // fat tyres at the corners
  const tyre = new THREE.CylinderGeometry(0.6,0.6,0.55,14), tyreMat = matte(0x0b0b0b);
  const rimMat = new THREE.MeshStandardMaterial({color:0xc4c9d2, metalness:0.95, roughness:0.22});
  for (const [wx,wz] of [[-1.3,1.5],[1.3,1.5],[-1.3,-1.6],[1.3,-1.6]]){
    const w = new THREE.Mesh(tyre, tyreMat); w.rotation.z=Math.PI/2; w.position.set(wx,0.6,wz); g.add(w);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.26,0.26,0.57,8), rimMat);
    rim.rotation.z=Math.PI/2; rim.position.set(wx,0.6,wz); g.add(rim);
  }
  // headlights
  const hl = new THREE.MeshStandardMaterial({color:0xfff6c8, emissive:0xfff0b0, emissiveIntensity:0.7, roughness:0.4});
  for (const sx of [-0.7,0.7]){ const l=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.3,0.1),hl); l.position.set(sx,0.7,2.46); g.add(l); }
  // racing number on roof + doors
  const numTex = makeTextTexture(String(number));
  const roofN = new THREE.Mesh(new THREE.PlaneGeometry(1.4,1.4), new THREE.MeshBasicMaterial({map:numTex, transparent:true}));
  roofN.rotation.x=-Math.PI/2; roofN.rotation.z=Math.PI; roofN.position.set(0,1.47,-0.35); g.add(roofN);
  const roundel = makeRoundelTexture(String(number), isHornet);
  for (const sx of [-1.06,1.06]){
    const dr = new THREE.Mesh(new THREE.PlaneGeometry(1.2,1.0), new THREE.MeshBasicMaterial({map:roundel, transparent:true}));
    dr.position.set(sx,0.7,-0.2); dr.rotation.y = sx<0?-Math.PI/2:Math.PI/2; g.add(dr);
  }
  // solid parts cast & receive shadows; transparent number decals don't cast
  g.traverse(o=>{ if (o.isMesh){ o.receiveShadow = true; o.castShadow = !(o.material && o.material.transparent); } });
  return g;
}
function shadeHex(hex, amt){
  const r=Math.max(0,Math.min(255,((hex>>16)&255)+amt));
  const gg=Math.max(0,Math.min(255,((hex>>8)&255)+amt));
  const b=Math.max(0,Math.min(255,(hex&255)+amt));
  return (r<<16)|(gg<<8)|b;
}
function makeRoundelTexture(num, isHornet){
  const cv=document.createElement('canvas'); cv.width=cv.height=128; const x=cv.getContext('2d');
  x.clearRect(0,0,128,128);
  x.fillStyle=isHornet?'#ffffff':'rgba(255,255,255,0.92)'; x.beginPath(); x.arc(64,64,42,0,6.28); x.fill();
  x.fillStyle=isHornet?'#1f54c8':'#111'; x.font='bold 60px Arial'; x.textAlign='center'; x.textBaseline='middle';
  x.fillText(num,64,68);
  const t=new THREE.CanvasTexture(cv); t.needsUpdate=true; return t;
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
  // ride the banked surface: lateral along the tilted right, height along its normal
  return out.copy(f.pos).addScaledVector(f.right, offset * ROAD_W * 0.82).addScaledVector(f.up, 0.05);
}
const _basis = new THREE.Matrix4();
function placeCar(mesh, dist, offset, yLift){
  const f = frameAt(dist);
  worldPos(dist, offset, mesh.position); mesh.position.addScaledVector(f.up, yLift||0);
  // full orientation from the banked road frame (yaw + pitch + bank roll)
  _basis.makeBasis(f.right, f.up, f.tan);
  mesh.quaternion.setFromRotationMatrix(_basis);
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
  if (e.code==='KeyM'){ if(!e.repeat && window.GameMusic) window.GameMusic.toggleMute(); return; }
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
    if (window.GameMusic) window.GameMusic.init(AC);
  }catch(e){ AC=null; }
}
function updateEngine(){
  if(!AC) return;
  const r=Math.abs(G.speed)/G.maxSpeed;
  engOsc.frequency.setTargetAtTime(60+r*220+(G.skid>0?40:0), AC.currentTime,0.05);
  engFilter.frequency.setTargetAtTime(500+r*2500, AC.currentTime,0.05);
  engGain.gain.setTargetAtTime(G.state==='racing'?0.04+r*0.10:0, AC.currentTime,0.1);
  if (window.GameMusic) window.GameMusic.setIntensity(G.state==='racing'?r:0);
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
  G.cars=[]; rivalMeshes.forEach(m=>{ scene.remove(m); disposeTree(m); }); rivalMeshes=[];
  const laneX=[-0.75,0.75,-0.4,0.4];
  const segLen = G.L/DIV;
  for (let i=0;i<OPPONENTS;i++){
    const row=Math.floor(i/4);
    const dist = ((10 + row*2.4) * (segLen*8)) % G.L;   // pack staggered up the road
    const num = 2 + ((i*7+3) % 96);                 // varied racing numbers
    const car = {
      offset:laneX[i%4], targetLane:laneX[i%4], dist,
      basePace:(0.80+Math.random()*0.20)*G.aiSpeedMul, speed:0,
      color:LIVERIES[i%LIVERIES.length], lap:1, progress:0, jitter:Math.random()*6.28,
    };
    G.cars.push(car);
    const mesh = buildCarMesh(car.color, false, num);
    if (MOBILE) mesh.traverse(o=>{ if(o.isMesh) o.castShadow=false; });   // perf: rivals don't cast on mobile
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
  const offRoad = Math.abs(G.playerX) > 1;

  // --- steering: responsive, keeps authority at low speed, and much easier on grass ---
  const steerAuth = Math.min(1, Math.abs(G.speed)/(G.maxSpeed*0.22) + 0.30);
  let steer = dt * 2.6 * steerAuth;
  if (offRoad) steer *= 2.4;                          // easy to wrestle back onto the track
  // Verified empirically: +playerX renders to screen-LEFT, so RIGHT decreases it.
  if (keys.left)  G.playerX += steer;
  if (keys.right) G.playerX -= steer;
  G.playerX -= dt * sp*sp * f.curv * 40 * G.curveMul; // centrifugal (eases when off the throttle)
  // smoothed visual steer for car turn-in / body roll (right key = +1)
  const steerInput = (keys.right?1:0) - (keys.left?1:0);
  G.steerVis = approach(G.steerVis||0, steerInput, dt*5);

  // --- throttle / brake: punchy launch that eases near top speed, strong brakes ---
  const accel = (G.maxSpeed/3.0) * (1 - sp*0.5);
  const brakePow = G.maxSpeed/1.8;
  const coast = G.maxSpeed/6.5;
  if (keys.gas && !keys.reverse) G.speed += Math.max(0, accel) * dt;
  else if (keys.reverse) G.speed = approach(G.speed, -G.maxSpeed*0.30, brakePow*dt);
  else G.speed = approach(G.speed, 0, coast*dt);
  if (keys.brake) G.speed = approach(G.speed, 0, brakePow*dt);

  // --- grass: slow toward a moderate speed (not a crawl) so you can still steer back ---
  G.skid = Math.max(0, G.skid - dt);
  if (offRoad && Math.abs(G.speed) > G.maxSpeed*0.12){
    const grassMax = G.maxSpeed * 0.42 * (G.speed < 0 ? -1 : 1);
    G.speed = approach(G.speed, grassMax, G.maxSpeed*1.4*dt);
    G.shake = 0.5;
    if (Math.random()<0.08) beep(120,0.05,'sawtooth',0.05);
  }
  if (G.speed>0){
    for (const car of G.cars){
      const d=loopDelta(car.dist,G.dist);
      if (d>0 && d<segLen*8 && Math.abs(G.playerX-car.offset)<0.82){
        // bump-and-go: keep most of your momentum and get nudged toward the
        // open side so you can power around rather than getting stopped dead
        G.speed *= 0.9;
        const side=(G.playerX>=car.offset)?1:-1;
        G.playerX=Math.max(-1.1,Math.min(1.1,G.playerX+side*0.22));
        G.shake=0.6; G.skid=0.22; beep(90,0.10,'sawtooth',0.16);
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
  const myProg=Math.max(1,G.lap)*G.L+G.dist; let ah=0;   // guard reverse-over-line
  for (const car of G.cars) if (car.progress>myProg) ah++;
  G.place=ah+1;
}
function onLapComplete(){
  G.lastLapTime=G.lapTime;
  const hadBest = G.bestLapTime !== Infinity;       // no "fast lap" on the very first lap
  if (G.lapTime<G.bestLapTime){ G.bestLapTime=G.lapTime; if (hadBest){ flashBanner('FAST LAP!'); beep(1046,0.4,'square',0.18); } }
  G.lapTime=0; G.lap++; G.timeLeft+=G.lapBonus;
  if (G.lap>G.totalLaps){ finishRace(true); return; }
  if (G.lap===G.totalLaps){                        // final lap: kick the music up a gear
    flashBanner('FINAL LAP!');
    if (window.GameMusic) window.GameMusic.setFinalLap(true);
  } else {
    flashBanner('CHECKPOINT +'+G.lapBonus);
  }
  beep(660,0.25,'square',0.15);
}
function flashBanner(t){ const b=document.getElementById('banner'); b.textContent=t; b.classList.remove('hidden'); G.bannerTimer=1.4; }

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const _camPos=new THREE.Vector3(), _look=new THREE.Vector3(), _fwd=new THREE.Vector3(), _tmp=new THREE.Vector3();
const _camUp=new THREE.Vector3(0,1,0);
const _sunOff=new THREE.Vector3(55, 120, 35);   // fixed sun direction relative to the player
function render(){
  // place player + rivals
  placeCar(playerCar, G.dist, G.playerX, 0);
  const lean = G.steerVis || 0;                    // nose turns toward the steer direction
  playerCar.rotateY(lean * 0.18);
  playerCar.rotateZ(-lean * 0.06);
  // keep the sun's shadow frustum centred on the player
  if (sun){
    sun.target.position.copy(playerCar.position);
    sun.position.copy(playerCar.position).add(_sunOff);
    sun.target.updateMatrixWorld();
  }
  for (let i=0;i<G.cars.length;i++) placeCar(rivalMeshes[i], G.cars[i].dist, G.cars[i].offset, 0);

  // chase / hood camera — lifts along the banked surface normal so it rolls
  // through the banking, and the FOV opens up a touch with speed.
  // The chase cam follows mostly the ROAD (not the car's full offset) so the
  // car visibly slides across the track when you steer — proper steering feel.
  const f = frameAt(G.dist);
  _fwd.copy(f.tan);
  const camLat = (G.camMode===0) ? G.playerX*0.28 : G.playerX;
  worldPos(G.dist, camLat, _tmp);
  if (G.camMode===0){
    _camPos.copy(_tmp).addScaledVector(_fwd,-11).addScaledVector(f.up,4.6);
    _look.copy(_tmp).addScaledVector(_fwd,12).addScaledVector(f.up,1.2);
  } else {
    _camPos.copy(_tmp).addScaledVector(_fwd,0.2).addScaledVector(f.up,2.2);
    _look.copy(_tmp).addScaledVector(_fwd,14).addScaledVector(f.up,1.0);
  }
  if (G.shake>0){ _camPos.x+=(Math.random()-0.5)*G.shake; _camPos.y+=(Math.random()-0.5)*G.shake; }
  camera.position.lerp(_camPos, 0.25);
  _camUp.lerp(f.up, 0.1); camera.up.copy(_camUp);     // roll with the bank
  camera.lookAt(_look);
  if (sky) sky.position.copy(camera.position);        // sky stays around us
  const targetFov = 62 + Math.min(1,Math.abs(G.speed)/G.maxSpeed)*10;
  camera.fov += (targetFov - camera.fov)*0.08; camera.updateProjectionMatrix();

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
  // speed lines streaking from the vanishing point at high speed
  const sp=Math.abs(G.speed)/G.maxSpeed;
  if (G.state==='racing' && sp>0.55){
    const n=Math.floor((sp-0.55)*60), cx=W*0.5, cy=H*0.52;
    hctx.strokeStyle=`rgba(255,255,255,${(sp-0.55)*0.5})`; hctx.lineWidth=Math.max(1,W*0.0015);
    for (let i=0;i<n;i++){
      const a=(i*2.39996)%6.283, r0=Math.min(W,H)*0.18, r1=r0+ (40+Math.random()*120)*(W/1280);
      hctx.beginPath();
      hctx.moveTo(cx+Math.cos(a)*r0, cy+Math.sin(a)*r0);
      hctx.lineTo(cx+Math.cos(a)*r1, cy+Math.sin(a)*r1); hctx.stroke();
    }
  }
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
  const kmh = Math.round(rev*320);                 // arcade-style speed readout
  hctx.textBaseline='alphabetic';
  hctx.fillStyle='#2bd451'; hctx.font=`bold ${Math.max(14,gr*0.48)}px Arial`;
  hctx.fillText(kmh, gx, gy+gr*0.62);
  hctx.fillStyle='#bff5cc'; hctx.font=`bold ${Math.max(8,gr*0.18)}px Arial`;
  hctx.fillText('KM/H', gx, gy+gr*0.90);
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
        <b>C</b><span>Change camera</span><b>M</b><span>Mute music</span>
        <b>P / ESC</b><span>Pause</span>
      </div>
      <button class="btn" id="startBtn">START ENGINE ▶</button>
    </div>
    <div class="credit">A homage to SEGA's Daytona USA (1993). Fan-made, non-commercial. •
      <a href="../index.html" style="color:#9fe">2D arcade version</a></div>`;
}
function showMenu(){ G.state='menu'; if(window.GameMusic){window.GameMusic.setMode('menu');window.GameMusic.duck(false);} const el=document.getElementById('overlay'); el.innerHTML=menuHTML(); el.classList.remove('hidden'); wireMenu(); }
function wireMenu(){
  document.querySelectorAll('[data-diff]').forEach(b=>{
    b.onclick=()=>{ G.diff=parseInt(b.dataset.diff,10);
      document.querySelectorAll('[data-diff]').forEach(x=>x.classList.remove('sel')); b.classList.add('sel'); beep(520,0.08,'square',0.1); };
  });
  const s=document.getElementById('startBtn'); if(s) s.onclick=startRace;
}
function startRace(){
  initAudio(); if (AC&&AC.state==='suspended') AC.resume();
  if (window.GameMusic){ window.GameMusic.start(); window.GameMusic.setMode('race'); window.GameMusic.duck(false); }
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
  if (window.GameMusic) window.GameMusic.setMode('menu');
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
    if (window.GameMusic) window.GameMusic.duck(true);
    const el=document.getElementById('overlay');
    el.innerHTML=`<h1 class="title">PAUSED</h1><div class="menu-card">
      <button class="btn" id="resumeBtn">RESUME ▶</button><div style="height:10px"></div>
      <button class="btn ghost" id="restartBtn">RESTART RACE ↻</button><div style="height:10px"></div>
      <button class="btn ghost" id="quitBtn">EXIT TO MENU ✕</button></div>`;
    el.classList.remove('hidden');
    document.getElementById('resumeBtn').onclick=()=>{el.classList.add('hidden');G.state='racing';if(window.GameMusic)window.GameMusic.duck(false);};
    document.getElementById('restartBtn').onclick=()=>startRace();
    document.getElementById('quitBtn').onclick=()=>showMenu();
  } else if (G.state==='paused'){ document.getElementById('overlay').classList.add('hidden'); G.state='racing'; if(window.GameMusic)window.GameMusic.duck(false); }
}
window.__togglePause = togglePause;   // for the on-screen pause button

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
  const pb=document.getElementById('pauseBtn'); if(pb) pb.onclick=togglePause;
  requestAnimationFrame(frame);
} catch (e) {
  const err=document.getElementById('err');
  err.style.display='flex';
  err.innerHTML='<div>⚠️ Could not start 3D mode (WebGL may be unavailable).<br>'+
    'Try the <a href="../index.html" style="color:#9fe">2D arcade version</a>.<br><br>'+
    '<small style="opacity:.6">'+(e&&e.message?e.message:e)+'</small></div>';
  console.error(e);
}

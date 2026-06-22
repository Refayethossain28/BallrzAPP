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
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const glCanvas = document.getElementById('gl');
const hud2d = document.getElementById('hud2d');
const hctx = hud2d.getContext('2d');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const FIELD = 11, OPPONENTS = FIELD - 1;   // you + 10 rival competitors
const ROAD_W = 9;                 // road half-width (world units)
const RUMBLE_W = 1.6;
const DIV = 1400;                 // spline samples (road resolution)
const FPS = 60, STEP = 1/FPS;

const CIRCUITS = [
  { name:'DAYTONA', laps:8, maxSpeed:118, curveMul:0.85, aiSpeed:0.74, startTime:60, lapBonus:26, seed:1,  theme:0 },
  { name:'LONDON',  laps:6, maxSpeed:120, curveMul:1.05, aiSpeed:0.78, startTime:60, lapBonus:30, seed:11, theme:3 },
  { name:'DUBAI',   laps:6, maxSpeed:132, curveMul:1.1,  aiSpeed:0.82, startTime:64, lapBonus:30, seed:23, theme:4 },
];
// per-circuit environment themes (colours, props, set-pieces)
const THEMES = [
  { // 0 Daytona — alpine speedway
    asphalt:0x83878d, grass:0x4a9c54, grass2:0x3f8f49, mountain:0x8a9099, snow:true,
    prop:'pine', water:false, dino:false, tunnel:true, skyline:'mountain', landmark:null, buildings:false,
    skyTop:'#1f6fd6', skyMid:'#5aa6f0', skyHorizon:'#dff0ff', fog:0xbfe2ff,
  },
  { // 1 dinosaur canyon (kept for variety)
    asphalt:0x8a8079, grass:0xb89a5e, grass2:0xa98a4e, mountain:0xb5793f, snow:false,
    prop:'rock', water:false, dino:true, tunnel:true, skyline:'mountain', landmark:null, buildings:false,
    skyTop:'#3a78c0', skyMid:'#9ab6d0', skyHorizon:'#e9d9b8', fog:0xe2d2ad,
  },
  { // 2 sea-side (kept for variety)
    asphalt:0x8a8e94, grass:0x4aa86a, grass2:0x3f9a5e, mountain:0x6f88a0, snow:false,
    prop:'palm', water:true, dino:false, tunnel:false, skyline:'mountain', landmark:null, buildings:false,
    skyTop:'#1a86d6', skyMid:'#57b6ef', skyHorizon:'#bfeaff', fog:0xbfeaff,
  },
  { // 3 London — overcast city
    asphalt:0x6f7378, grass:0x4f7d46, grass2:0x447439, mountain:0x9aa6b2, snow:false,
    prop:'tree', water:false, dino:false, tunnel:false, skyline:'city', landmark:'london', buildings:true,
    skyTop:'#8190a0', skyMid:'#a6b6c4', skyHorizon:'#ccd6de', fog:0xc6d0d8,
  },
  { // 4 Dubai — desert metropolis
    asphalt:0x8a8e94, grass:0xcdb47e, grass2:0xbfa666, mountain:0xd8c79a, snow:false,
    prop:'palm', water:false, dino:false, tunnel:false, skyline:'city', landmark:'dubai', buildings:true,
    skyTop:'#1f7fd6', skyMid:'#67b6ef', skyHorizon:'#ecd9a8', fog:0xe9d9b0,
  },
];
// player vehicles
const VEHICLES = [
  { name:'MERCEDES V-CLASS', kind:'van',   color:0x30353d,
    speedMul:0.90, accelMul:0.82, steerMul:0.78, gripMul:0.80, brakeMul:0.82, rollMul:1.7,
    desc:'Luxury MPV — heavy & planted: gentle steering & brakes, lower grip, leans in turns.' },
  { name:'MERCEDES S-CLASS', kind:'sedan', color:0x171b20,
    speedMul:1.10, accelMul:1.16, steerMul:1.24, gripMul:1.20, brakeMul:1.15, rollMul:0.7,
    desc:'Flagship saloon — fast & agile: sharp steering, strong brakes, high grip.' },
];
const LIVERIES = [0xe23b3b,0x2f6cff,0x22c55e,0xf59e0b,0xa855f7,0x06b6d4,
                  0xec4899,0xfacc15,0xfb7185,0x4ade80,0x38bdf8,0xfb923c,0xffffff];

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const G = {
  state:'menu', diff:0, vehicle:1, circuit:0,
  L:0,                // track length
  dist:0,             // player distance along track
  playerX:0,          // lateral offset -1..1
  speed:0, maxSpeed:105, curveMul:0.8, aiSpeedMul:0.82, accelMul:1, steerMul:1, gripMul:1, brakeMul:1, rollMul:1,
  totalLaps:8, lap:1, lapTime:0, lastLapTime:0, bestLapTime:Infinity,
  totalTime:0, timeLeft:55, lapBonus:24,
  cars:[], place:FIELD, countdown:0, bannerTimer:0, shake:0, skid:0,
  reversedLine:false, camMode:0, theme:null, retro:true,
};

// ---------------------------------------------------------------------------
// Three.js core
// ---------------------------------------------------------------------------
let renderer, scene, camera, sky, composer, bloomPass, fxaaPass;
let frames = [];      // [{pos:Vector3, tan:Vector3, right:Vector3, curv:Number}]
let playerCar, rivalMeshes = [];
const UP = new THREE.Vector3(0,1,0);

// subtle cinematic vignette (applied to the final image)
const VignetteShader = {
  uniforms: { tDiffuse:{value:null}, strength:{value:0.42} },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;'+
    'void main(){ vec4 c=texture2D(tDiffuse,vUv); vec2 d=vUv-0.5; float dd=dot(d,d);'+
    ' float vig=1.0 - strength*smoothstep(0.10,0.50,dd);'+
    ' gl_FragColor=vec4(c.rgb*vig, c.a); }'
};

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
    if (envTexture) envTexture.dispose();
    envTexture = rt.texture;
    scene.environment = G.retro ? null : envTexture;
    eq.dispose(); pm.dispose();
  }
}

let sun = null, envTexture = null;
const MOBILE = (typeof window!=='undefined') &&
  (('ontouchstart' in window) || (window.matchMedia && matchMedia('(pointer:coarse)').matches));

// ---- PS1 retro mode: low-res render, vertex "wobble", blocky textures ----
const PS1_SNAP = 'vec4 _p=gl_Position; _p.xyz/=_p.w;'+
  ' _p.xy=floor(_p.xy*vec2(160.0,120.0))/vec2(160.0,120.0); _p.xyz*=_p.w; gl_Position=_p;';
function retroizeMaterial(m){
  if (!m || m.__ps1) return;
  m.__ps1 = true;
  m.onBeforeCompile = (sh)=>{ sh.vertexShader = sh.vertexShader.replace(
    '#include <project_vertex>', '#include <project_vertex>\n'+PS1_SNAP); };
  if (m.map){ m.map.magFilter=THREE.NearestFilter; m.map.minFilter=THREE.NearestFilter; m.map.generateMipmaps=false; m.map.needsUpdate=true; }
  if ('envMapIntensity' in m) m.envMapIntensity = 0;
  m.needsUpdate = true;
}
function retroizeScene(){ scene.traverse(o=>{ if(o.isMesh){ const mm=Array.isArray(o.material)?o.material:[o.material]; mm.forEach(retroizeMaterial); } }); }
function applyGraphicsMode(){
  const retro = G.retro;
  renderer.shadowMap.enabled = !retro;
  renderer.toneMapping = retro ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  scene.environment = retro ? null : envTexture;
  if (retro) retroizeScene();
  resize();
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas:glCanvas, antialias:!MOBILE, powerPreference:'high-performance' });
  renderer.setPixelRatio(Math.min(MOBILE?1.5:2, window.devicePixelRatio || 1));
  // cinematic colour + soft shadows
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;  // applied by OutputPass in the composer
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

  // --- post-processing: bloom -> filmic output -> FXAA -> vignette ---
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(new THREE.Vector2(1,1), MOBILE?0.35:0.5, 0.4, 0.9);
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());             // ACES tonemap + sRGB
  if (!MOBILE){ fxaaPass = new ShaderPass(FXAAShader); composer.addPass(fxaaPass); }
  composer.addPass(new ShaderPass(VignetteShader));

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
  // push fog back on city circuits so the skyline / landmarks stay visible
  scene.fog.near = 360; scene.fog.far = (G.theme.skyline==='city') ? 1600 : 900;
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
  const treeTrunk=new THREE.MeshLambertMaterial({color:0x6b4a2b});
  const treeLeaf =new THREE.MeshLambertMaterial({color:0x2f7d3a, flatShading:true});
  function tree(scale){
    const g=new THREE.Group();
    const t=new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.45,2.4,6), treeTrunk); t.position.y=1.2; g.add(t);
    const c=new THREE.Mesh(new THREE.IcosahedronGeometry(2.4,0), treeLeaf); c.position.y=4; c.scale.y=1.1; g.add(c);
    g.scale.setScalar(scale); return g;
  }
  const makeProp = th.prop==='rock' ? rock : th.prop==='palm' ? palm : th.prop==='tree' ? tree : pine;

  // ---- line the verges with the course's props ----
  for (let i=0;i<DIV;i+=10){
    const side=(i%20===0)?1:-1, f=frames[i];
    const p=makeProp(1.2 + rng()*1.3);
    p.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+6+rng()*16));
    sceneryGroup.add(p);
  }
  if (th.skyline==='city'){
    // ---- distant city skyline ring (towers with lit windows) ----
    const winTex = makeWindowTexture(th.landmark==='dubai');
    for (let i=0;i<46;i++){
      const ang=(i/46)*Math.PI*2;
      const r=560 + (mulberry32(i+99)())*260;
      const h=70 + (mulberry32(i+5)())*(th.landmark==='dubai'?260:140);
      const w=24 + (mulberry32(i+13)())*26;
      const col = th.landmark==='dubai' ? 0x9fb6cc : [0x8a6a52,0x9c7a52,0x70615a,0x86756b][i%4];
      const mat = new THREE.MeshStandardMaterial({color:col, roughness:0.7, metalness:th.landmark==='dubai'?0.4:0.05, map:winTex.clone()});
      mat.map.repeat.set(Math.max(1,w/12), Math.max(2,h/12));
      const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,w), mat);
      b.position.set(Math.cos(ang)*r, h/2-40, Math.sin(ang)*r); sceneryGroup.add(b);
    }
  } else {
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
  }
  // ---- mid-distance buildings lining urban circuits ----
  if (th.buildings){
    const winTex = makeWindowTexture(th.landmark==='dubai');
    for (let i=0;i<DIV;i+=24){
      const side=(i%48===0)?1:-1, f=frames[i];
      const h=24 + rng()*(th.landmark==='dubai'?90:46), w=12+rng()*12;
      const col = th.landmark==='dubai' ? 0xbcd0e2 : [0x8a6248,0x96704e,0x6f5e54][(rng()*3)|0];
      const mat=new THREE.MeshStandardMaterial({color:col, roughness:0.7, metalness:th.landmark==='dubai'?0.45:0.05, map:winTex.clone()});
      mat.map.repeat.set(Math.max(1,w/8), Math.max(2,h/10));
      const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,w), mat);
      b.position.copy(f.pos).addScaledVector(f.right, side*(ROAD_W+RUMBLE_W+26+rng()*40)); b.position.y += h/2-2;
      sceneryGroup.add(b);
    }
  }
  // ---- landmark set-pieces ----
  if (th.landmark==='london') addBigBen(sceneryGroup, frames);
  if (th.landmark==='dubai') addBurj(sceneryGroup, frames);
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
// building facade texture (rows of windows; glassy=blue towers, else lit offices)
function makeWindowTexture(glassy){
  const cv=document.createElement('canvas'); cv.width=cv.height=64; const x=cv.getContext('2d');
  x.fillStyle = glassy ? '#86aece' : '#565a61'; x.fillRect(0,0,64,64);
  for (let r=0;r<8;r++) for (let c=0;c<8;c++){
    const lit=Math.random();
    x.fillStyle = glassy ? (lit<0.5?'#cfe6ff':'#6f97b8') : (lit<0.3?'#ffd98a':'#34373c');
    x.fillRect(c*8+1, r*8+1, 6, 5);
  }
  const t=new THREE.CanvasTexture(cv); t.wrapS=t.wrapT=THREE.RepeatWrapping; t.colorSpace=THREE.SRGBColorSpace; return t;
}
// London — a towering Elizabeth Tower (Big Ben) + a big London Eye, near the start
function addBigBen(group, frames){
  const f=frames[Math.floor(DIV*0.04)];
  const g=new THREE.Group();
  const stone=new THREE.MeshStandardMaterial({color:0xc2a974, roughness:0.85});
  const trim =new THREE.MeshStandardMaterial({color:0x9c8550, roughness:0.85});
  const baseB=new THREE.Mesh(new THREE.BoxGeometry(17,14,17), trim); baseB.position.y=7; g.add(baseB);
  const shaft=new THREE.Mesh(new THREE.BoxGeometry(13,86,13), stone); shaft.position.y=57; g.add(shaft);
  for (const sx of [-6.7,6.7]) for (const sz of [-6.7,6.7]){
    const p=new THREE.Mesh(new THREE.BoxGeometry(1.6,86,1.6), trim); p.position.set(sx,57,sz); g.add(p);
  }
  const cm=new THREE.MeshStandardMaterial({color:0xfff4d4, emissive:0x6a5a28, emissiveIntensity:0.9, roughness:0.5});
  for (const [dx,dz,ry] of [[6.8,0,Math.PI/2],[-6.8,0,-Math.PI/2],[0,6.8,0],[0,-6.8,Math.PI]]){
    const c=new THREE.Mesh(new THREE.CircleGeometry(3.7,22), cm); c.position.set(dx,92,dz); c.rotation.y=ry; g.add(c);
  }
  const belfry=new THREE.Mesh(new THREE.BoxGeometry(15,14,15), trim); belfry.position.y=107; g.add(belfry);
  const spire=new THREE.Mesh(new THREE.ConeGeometry(9,28,4), new THREE.MeshStandardMaterial({color:0x3f6b4a, roughness:0.6})); spire.position.y=128; spire.rotation.y=Math.PI/4; g.add(spire);
  g.position.copy(f.pos).addScaledVector(f.right, 40).setY(0);
  g.rotation.y=Math.atan2(f.tan.x, f.tan.z); group.add(g);

  const f2=frames[Math.floor(DIV*0.12)], eye=new THREE.Group();
  const rimMat=new THREE.MeshStandardMaterial({color:0xe6edf3, metalness:0.5, roughness:0.4});
  eye.add(new THREE.Mesh(new THREE.TorusGeometry(34,1.3,8,48), rimMat));
  eye.add(new THREE.Mesh(new THREE.TorusGeometry(32.5,0.5,6,48), rimMat));
  for (let k=0;k<12;k++){ const a=k/12*Math.PI; const sp=new THREE.Mesh(new THREE.BoxGeometry(0.5,68,0.5), rimMat); sp.rotation.z=a; eye.add(sp); }
  for (let k=0;k<22;k++){ const a=k/22*6.28; const cap=new THREE.Mesh(new THREE.BoxGeometry(2.8,1.9,2.8), new THREE.MeshStandardMaterial({color:0x9fd4f5, metalness:0.3, roughness:0.3, emissive:0x16384f, emissiveIntensity:0.4})); cap.position.set(Math.cos(a)*34, Math.sin(a)*34, 0); eye.add(cap); }
  const leg=new THREE.Mesh(new THREE.BoxGeometry(1.6,46,1.6), rimMat); leg.position.set(5,-20,6); leg.rotation.x=0.3; eye.add(leg);
  const leg2=leg.clone(); leg2.position.x=-5; eye.add(leg2);
  eye.position.copy(f2.pos).addScaledVector(f2.right, 54).setY(40);
  eye.rotation.y=Math.atan2(f2.tan.x, f2.tan.z); group.add(eye);
}
// Dubai — a Burj Khalifa-style spire that towers over the whole circuit
function addBurj(group, frames){
  const f=frames[Math.floor(DIV*0.05)], g=new THREE.Group();
  const mat=new THREE.MeshStandardMaterial({color:0xd6e6f2, metalness:0.65, roughness:0.2, map:makeWindowTexture(true)});
  mat.map.repeat.set(3,16);
  let y=0, w=36;
  for (let k=0;k<9;k++){ const h=36; const seg=new THREE.Mesh(new THREE.BoxGeometry(w,h,w), mat); seg.position.y=y+h/2; seg.rotation.y=k*0.14; g.add(seg); y+=h; w*=0.85; }
  const spire=new THREE.Mesh(new THREE.CylinderGeometry(0.6,3.2,110,8), new THREE.MeshStandardMaterial({color:0xeef3f8, metalness:0.7, roughness:0.25})); spire.position.y=y+55; g.add(spire);
  g.position.copy(f.pos).addScaledVector(f.right, 78).setY(0); group.add(g);
  // a couple of supporting towers for a skyline cluster
  for (const [u,off,h,col] of [[0.03,-62,150,0xbcd6ea],[0.08,86,180,0xa9c6dd]]){
    const ff=frames[Math.floor(DIV*u)];
    const t=new THREE.Mesh(new THREE.BoxGeometry(26,h,26), new THREE.MeshStandardMaterial({color:col, metalness:0.55, roughness:0.25, map:makeWindowTexture(true)}));
    t.material.map.repeat.set(2,10);
    t.position.copy(ff.pos).addScaledVector(ff.right, off).setY(h/2); group.add(t);
  }
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
// Shared vehicle materials + player vehicle models (Mercedes V-Class / S-Class)
// ---------------------------------------------------------------------------
function paintMat(c){ return MOBILE
  ? new THREE.MeshStandardMaterial({color:c, metalness:0.5, roughness:0.34, envMapIntensity:1.0})
  : new THREE.MeshPhysicalMaterial({color:c, metalness:0.45, roughness:0.3, clearcoat:1.0, clearcoatRoughness:0.12, envMapIntensity:1.15}); }
function matteMat(c){ return new THREE.MeshStandardMaterial({color:c, metalness:0, roughness:0.85}); }
function glassMat(){ return new THREE.MeshStandardMaterial({color:0x0e1a30, metalness:0.4, roughness:0.06}); }
function chromeMat(){ return new THREE.MeshStandardMaterial({color:0xc4c9d2, metalness:0.95, roughness:0.22}); }
function applyShadows(g){ g.traverse(o=>{ if(o.isMesh){ o.receiveShadow=true; o.castShadow=!(o.material&&o.material.transparent); } }); }

function makeEmblemTexture(){
  const cv=document.createElement('canvas'); cv.width=cv.height=64; const x=cv.getContext('2d');
  x.clearRect(0,0,64,64);
  x.strokeStyle='#e8edf2'; x.lineWidth=5; x.beginPath(); x.arc(32,32,25,0,6.28); x.stroke();
  x.lineWidth=4;
  for (let k=0;k<3;k++){ const a=-Math.PI/2 + k*2*Math.PI/3; x.beginPath(); x.moveTo(32,32); x.lineTo(32+Math.cos(a)*23, 32+Math.sin(a)*23); x.stroke(); }
  const t=new THREE.CanvasTexture(cv); t.needsUpdate=true; return t;
}
function addEmblem(g,x,y,z,r){
  const m=new THREE.Mesh(new THREE.CircleGeometry(r,20), new THREE.MeshBasicMaterial({map:makeEmblemTexture(), transparent:true}));
  m.position.set(x,y,z); g.add(m);
}
function addLights(g,y,zf,zr){
  const hl=new THREE.MeshStandardMaterial({color:0xfff6c8, emissive:0xfff0b0, emissiveIntensity:0.8, roughness:0.4});
  const tl=new THREE.MeshStandardMaterial({color:0xff2a2a, emissive:0xcc1010, emissiveIntensity:0.6, roughness:0.5});
  for (const sx of [-0.8,0.8]){
    const a=new THREE.Mesh(new THREE.BoxGeometry(0.55,0.2,0.08),hl); a.position.set(sx,y,zf); g.add(a);
    const b=new THREE.Mesh(new THREE.BoxGeometry(0.55,0.18,0.08),tl); b.position.set(sx,y,zr); g.add(b);
  }
}
function addWheels(g,tx,tz,r){
  const tyre=new THREE.CylinderGeometry(r,r,0.5,16), tm=matteMat(0x0b0b0b), rm=chromeMat();
  for (const [wx,wz] of [[-tx,tz],[tx,tz],[-tx,-tz],[tx,-tz]]){
    const w=new THREE.Mesh(tyre,tm); w.rotation.z=Math.PI/2; w.position.set(wx,r,wz); g.add(w);
    const rim=new THREE.Mesh(new THREE.CylinderGeometry(r*0.55,r*0.55,0.52,10),rm); rim.rotation.z=Math.PI/2; rim.position.set(wx,r,wz); g.add(rim);
  }
}
// kind: 'van' (V-Class) or 'sedan' (S-Class). Front faces +z.
function buildVehicleMesh(kind, color){
  const g=new THREE.Group();
  if (kind==='van'){
    const body=new THREE.Mesh(new THREE.BoxGeometry(2.6,1.45,5.6), paintMat(color)); body.position.y=1.2; g.add(body);
    const skirt=new THREE.Mesh(new THREE.BoxGeometry(2.64,0.5,5.64), matteMat(0x111316)); skirt.position.y=0.6; g.add(skirt);
    const win=new THREE.Mesh(new THREE.BoxGeometry(2.52,0.72,4.3), glassMat()); win.position.set(0,1.7,-0.1); g.add(win);
    const roof=new THREE.Mesh(new THREE.BoxGeometry(2.5,0.2,5.0), paintMat(color)); roof.position.set(0,2.0,-0.2); g.add(roof);
    const ws=new THREE.Mesh(new THREE.BoxGeometry(2.42,0.95,0.2), glassMat()); ws.position.set(0,1.7,2.45); ws.rotation.x=0.32; g.add(ws);
    const grille=new THREE.Mesh(new THREE.BoxGeometry(2.2,0.62,0.16), matteMat(0x0a0a0a)); grille.position.set(0,1.02,2.82); g.add(grille);
    const cs=new THREE.Mesh(new THREE.BoxGeometry(2.3,0.07,0.05), chromeMat()); cs.position.set(0,1.3,2.85); g.add(cs);
    addEmblem(g,0,1.04,2.92,0.42); addLights(g,1.05,2.84,-2.84); addWheels(g,1.36,1.95,0.62);
  } else {
    const body=new THREE.Mesh(new THREE.BoxGeometry(2.4,0.86,5.5), paintMat(color)); body.position.y=0.8; g.add(body);
    const hood=new THREE.Mesh(new THREE.BoxGeometry(2.32,0.34,1.9), paintMat(color)); hood.position.set(0,1.04,1.95); g.add(hood);
    const trunk=new THREE.Mesh(new THREE.BoxGeometry(2.32,0.4,1.2), paintMat(color)); trunk.position.set(0,1.04,-2.2); g.add(trunk);
    const cabin=new THREE.Mesh(new THREE.BoxGeometry(2.16,0.6,2.7), paintMat(color)); cabin.position.set(0,1.42,-0.2); g.add(cabin);
    const gl=new THREE.Mesh(new THREE.BoxGeometry(2.18,0.5,2.5), glassMat()); gl.position.set(0,1.45,-0.2); g.add(gl);
    const ws=new THREE.Mesh(new THREE.BoxGeometry(2.05,0.62,0.16), glassMat()); ws.position.set(0,1.4,1.12); ws.rotation.x=0.6; g.add(ws);
    const rw=new THREE.Mesh(new THREE.BoxGeometry(2.05,0.56,0.16), glassMat()); rw.position.set(0,1.4,-1.5); rw.rotation.x=-0.6; g.add(rw);
    const roof=new THREE.Mesh(new THREE.BoxGeometry(2.02,0.14,2.0), paintMat(color)); roof.position.set(0,1.73,-0.25); g.add(roof);
    const grille=new THREE.Mesh(new THREE.BoxGeometry(1.95,0.46,0.16), matteMat(0x07080a)); grille.position.set(0,0.92,2.78); g.add(grille);
    const cs=new THREE.Mesh(new THREE.BoxGeometry(2.05,0.08,0.05), chromeMat()); cs.position.set(0,1.16,2.82); g.add(cs);
    addEmblem(g,0,0.96,2.88,0.34); addLights(g,0.96,2.8,-2.78); addWheels(g,1.26,1.85,0.58);
  }
  applyShadows(g);
  return g;
}

// ---------------------------------------------------------------------------
// Car meshes
// ---------------------------------------------------------------------------
function buildCarMesh(bodyColor, isHornet, number) {
  number = number==null ? 41 : number;
  const g = new THREE.Group();
  // glossy PBR car paint (reflects the sky env map); clearcoat on desktop
  const paint = c => MOBILE
    ? new THREE.MeshStandardMaterial({color:c, metalness:0.5, roughness:0.34, envMapIntensity:1.0})
    : new THREE.MeshPhysicalMaterial({color:c, metalness:0.45, roughness:0.3, clearcoat:1.0, clearcoatRoughness:0.12, envMapIntensity:1.15});
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
  let steer = dt * 2.6 * steerAuth * (G.steerMul||1);  // vehicle steering response
  if (offRoad) steer *= 2.4;                          // easy to wrestle back onto the track
  // Verified empirically: +playerX renders to screen-LEFT, so RIGHT decreases it.
  if (keys.left)  G.playerX += steer;
  if (keys.right) G.playerX -= steer;
  // centrifugal: lower-grip cars (the van) slide wider through curves
  G.playerX -= dt * sp*sp * f.curv * 40 * G.curveMul / (G.gripMul||1);
  // smoothed visual steer for car turn-in / body roll (right key = +1)
  const steerInput = (keys.right?1:0) - (keys.left?1:0);
  G.steerVis = approach(G.steerVis||0, steerInput, dt*5);

  // --- throttle / brake: punchy launch that eases near top speed, strong brakes ---
  const accel = (G.maxSpeed/3.0) * (1 - sp*0.5) * (G.accelMul||1);
  const brakePow = (G.maxSpeed/1.8) * (G.brakeMul||1);
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
  playerCar.rotateZ(-lean * 0.06 * (G.rollMul||1)); // the van leans more in corners
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

  if (G.retro) renderer.render(scene, camera); else composer.render();

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
const overlayEl = () => document.getElementById('overlay');
const CIRCUIT_DESC = ['Banked alpine speedway','Overcast city streets','Desert metropolis'];
const CIRCUIT_ICON = ['🏁','🎡','🌇'];
const VEHICLE_ICON = ['🚐','🚗'];

function menuHTML(){
  return `
    <h1 class="title">DAYTONA <span class="red">USA</span></h1>
    <div class="subtitle">3D POLYGON EDITION</div>
    <div class="menu-card">
      <h2>MERCEDES CIRCUIT RACING</h2>
      <p style="font-size:13px;opacity:.85;margin:0 0 16px;line-height:1.4">
        Choose your Mercedes, then pick a circuit — Daytona, London or Dubai.</p>
      <div class="keys">
        <b>↑ / W</b><span>Accelerate</span><b>↓ / S</b><span>Reverse</span>
        <b>← → / A D</b><span>Steer</span><b>SPACE</b><span>Brake</span>
        <b>C</b><span>Change camera</span><b>P</b><span>Pause</span>
      </div>
      <button class="btn" id="startBtn">START ▶</button>
      <div style="height:10px"></div>
      <button class="btn ghost" id="gfxBtn">GRAPHICS: ${G.retro?'PS1 RETRO':'MODERN'}</button>
    </div>
    <div class="credit">Fan-made, non-commercial. Mercedes-Benz marks belong to their owner. •
      <a href="../index.html" style="color:#9fe">2D version</a></div>`;
}
function previewRebuild(){
  buildTrack(CIRCUITS[G.circuit]);
  if (playerCar){ scene.remove(playerCar); disposeTree(playerCar); }
  playerCar=buildVehicleMesh(VEHICLES[G.vehicle].kind, VEHICLES[G.vehicle].color);
  scene.add(playerCar); placeCar(playerCar,0,0,0);
  applyGraphicsMode();
}
function vehicleHTML(){
  return `
    <h1 class="title">SELECT <span class="red">VEHICLE</span></h1>
    <div class="menu-card">
      <div class="cards">${VEHICLES.map((v,i)=>`
        <button class="selcard ${G.vehicle===i?'sel':''}" data-veh="${i}">
          <div class="cardicon">${VEHICLE_ICON[i]}</div>
          <div class="cardname">${v.name}</div>
          <div class="carddesc">${v.desc}</div>
        </button>`).join('')}</div>
      <div class="navrow">
        <button class="btn ghost" id="backBtn">◀ BACK</button>
        <button class="btn" id="nextBtn">NEXT ▶</button>
      </div>
    </div>
    <div class="credit">Fan-made, non-commercial. Mercedes-Benz marks belong to their owner.</div>`;
}
function circuitHTML(){
  return `
    <h1 class="title">SELECT <span class="red">CIRCUIT</span></h1>
    <div class="menu-card">
      <div class="cards">${CIRCUITS.map((c,i)=>`
        <button class="selcard ${G.circuit===i?'sel':''}" data-cir="${i}">
          <div class="cardicon">${CIRCUIT_ICON[i]}</div>
          <div class="cardname">${c.name}</div>
          <div class="carddesc">${CIRCUIT_DESC[i]} • ${c.laps} laps</div>
        </button>`).join('')}</div>
      <div class="navrow">
        <button class="btn ghost" id="backBtn">◀ BACK</button>
        <button class="btn" id="startBtn2">START ENGINE ▶</button>
      </div>
    </div>`;
}
function showMenu(){
  G.state='menu';
  if(window.GameMusic){window.GameMusic.setMode('menu');window.GameMusic.duck(false);}
  const el=overlayEl(); el.innerHTML=menuHTML(); el.classList.remove('hidden');
  document.getElementById('startBtn').onclick=showVehicleSelect;
  document.getElementById('gfxBtn').onclick=()=>{ G.retro=!G.retro; previewRebuild(); showMenu(); beep(440,0.08,'square',0.1); };
}
function showVehicleSelect(){
  G.state='menu'; initAudio();
  const el=overlayEl(); el.innerHTML=vehicleHTML(); el.classList.remove('hidden');
  el.querySelectorAll('[data-veh]').forEach(b=>b.onclick=()=>{
    G.vehicle=parseInt(b.dataset.veh,10);
    el.querySelectorAll('[data-veh]').forEach(x=>x.classList.remove('sel')); b.classList.add('sel'); beep(520,0.08,'square',0.1);
  });
  document.getElementById('backBtn').onclick=showMenu;
  document.getElementById('nextBtn').onclick=showCircuitSelect;
}
function showCircuitSelect(){
  G.state='menu';
  const el=overlayEl(); el.innerHTML=circuitHTML(); el.classList.remove('hidden');
  el.querySelectorAll('[data-cir]').forEach(b=>b.onclick=()=>{
    G.circuit=parseInt(b.dataset.cir,10);
    el.querySelectorAll('[data-cir]').forEach(x=>x.classList.remove('sel')); b.classList.add('sel'); beep(520,0.08,'square',0.1);
  });
  document.getElementById('backBtn').onclick=showVehicleSelect;
  document.getElementById('startBtn2').onclick=startRace;
}
function wireMenu(){ const s=document.getElementById('startBtn'); if(s) s.onclick=showVehicleSelect; }
function startRace(){
  initAudio(); if (AC&&AC.state==='suspended') AC.resume();
  if (window.GameMusic){ window.GameMusic.start(); window.GameMusic.setMode('race'); window.GameMusic.duck(false); }
  const c=CIRCUITS[G.circuit], v=VEHICLES[G.vehicle];
  G.maxSpeed=c.maxSpeed*v.speedMul; G.curveMul=c.curveMul; G.aiSpeedMul=c.aiSpeed;
  G.accelMul=v.accelMul; G.steerMul=v.steerMul; G.gripMul=v.gripMul; G.brakeMul=v.brakeMul; G.rollMul=v.rollMul;
  G.totalLaps=c.laps; G.timeLeft=c.startTime; G.lapBonus=c.lapBonus;
  document.getElementById('trackName').textContent=c.name+' • '+v.name.replace('MERCEDES ','');

  buildTrack(c);
  if (playerCar){ scene.remove(playerCar); disposeTree(playerCar); }
  playerCar=buildVehicleMesh(v.kind, v.color); scene.add(playerCar);
  resetCars();
  applyGraphicsMode();
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
      <div style="height:10px"></div>
      <button class="btn ghost" id="menuBtn">CHANGE CAR / TRACK</button>
    </div>`;
  el.classList.remove('hidden');
  document.getElementById('againBtn').onclick=()=>startRace();
  document.getElementById('menuBtn').onclick=()=>showVehicleSelect();
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
  camera.aspect=w/h; camera.updateProjectionMatrix();
  if (G.retro){
    // render at a low internal resolution; CSS upscales it with chunky pixels
    const lowH = 240, lowW = Math.max(1, Math.round(lowH * w/h));
    renderer.setPixelRatio(1); renderer.setSize(lowW, lowH, false);
  } else {
    const pr=Math.min(MOBILE?1.5:2, window.devicePixelRatio||1);
    renderer.setPixelRatio(pr); renderer.setSize(w,h,false);
    if (composer){
      composer.setPixelRatio(pr); composer.setSize(w,h);
      if (fxaaPass){ const r=fxaaPass.material.uniforms.resolution.value; r.set(1/(w*pr), 1/(h*pr)); }
    }
  }
  const hpr=Math.min(2, window.devicePixelRatio||1);
  hud2d.width=Math.round(w*hpr); hud2d.height=Math.round(h*hpr);
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
  buildTrack(CIRCUITS[0]);
  playerCar=buildVehicleMesh(VEHICLES[G.vehicle].kind, VEHICLES[G.vehicle].color); scene.add(playerCar); placeCar(playerCar,0,0,0);
  applyGraphicsMode();
  const f=frameAt(0); worldPos(0,0,_tmp);
  camera.position.copy(_tmp).addScaledVector(f.tan,-11).add(new THREE.Vector3(0,5,0)); camera.lookAt(_tmp);
  showMenu();
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

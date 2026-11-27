import * as THREE from 'three';
import { Sim, HALF, OBST, ITEMS, WEAPONS, NAMES, COLORS, MAX_KARTS, LAVA, PADS } from './sim.js';
import { HostNet, ClientNet, LanHostNet, LanClientNet, detectLan } from '../net.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WLABEL = { rocket: '🚀 ROCKET', mine: '💣 MINE', mg: '🔫 GUN', shield: '🛡️ SHIELD', boost: '⚡ BOOST', homing: '🎯 HOMING', triple: '🚀🚀🚀 TRIPLE' };
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const token = lsGet('kart.token') || (() => { const t = 'k' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); lsSet('kart.token', t); return t; })();

const G = { mode: null, sim: null, net: null, myId: token, roster: new Map(), snaps: [], code: null, lan: null, cfg: { bots: 2, target: 10 }, welcomed: false, shake: 0, flash: 0, reconnects: 0, leaving: false };

// ------------------------------------------------------------------ helpers / audio
let actx = null;
function audio() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } if (actx && actx.state === 'suspended') actx.resume(); return actx; }
function tone(f0, f1, dur, type = 'square', vol = 0.12) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, a.currentTime); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), a.currentTime + dur);
  g.gain.setValueAtTime(vol, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur);
  o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + dur);
}
const sfx = { boom: (v = 1) => tone(160, 30, 0.45, 'sawtooth', 0.22 * v), pick: () => tone(500, 1000, 0.15, 'triangle', 0.14), hit: () => tone(220, 90, 0.12, 'square', 0.15), shoot: () => tone(700, 300, 0.07, 'square', 0.06), fire: () => tone(300, 120, 0.2, 'sawtooth', 0.12) };
let toastT = 0;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

// ------------------------------------------------------------------ three.js scene
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: window.devicePixelRatio < 2, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const mkTex = (c, rep) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]); } t.anisotropy = 4; return t; };
// sky gradient + fog
{ const c = mkCanvas(2, 256), x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, '#5aa9ff'); g.addColorStop(0.5, '#9fd8ff'); g.addColorStop(1, '#f6ecff'); x.fillStyle = g; x.fillRect(0, 0, 2, 256); scene.background = mkTex(c); }
scene.fog = new THREE.Fog(0xd6ecff, 80, 210);
const camera = new THREE.PerspectiveCamera(62, 1, 0.5, 400);
scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa88a, 1.5));
const sun = new THREE.DirectionalLight(0xfff6e0, 2.4); sun.position.set(40, 70, 25); scene.add(sun);
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.fov = w / h < 1 ? 76 : 62; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const radial = (stops, size = 64) => { const c = mkCanvas(size, size), x = c.getContext('2d'), g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2); for (const [o, col] of stops) g.addColorStop(o, col); x.fillStyle = g; x.fillRect(0, 0, size, size); return mkTex(c); };
const softTex = radial([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,.55)'], [1, 'rgba(255,255,255,0)']]);
const shadowTex = radial([[0, 'rgba(0,0,0,.55)'], [0.6, 'rgba(0,0,0,.3)'], [1, 'rgba(0,0,0,0)']]);

// arena floor with painted markings
{
  const S = 1024, c = mkCanvas(S, S), x = c.getContext('2d'), n = 16, t = S / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { x.fillStyle = (i + j) % 2 ? '#cfd0d9' : '#c3c4ce'; x.fillRect(i * t, j * t, t, t); }
  for (let k = 0; k < 900; k++) { x.fillStyle = `rgba(80,80,100,${Math.random() * 0.04})`; x.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 5, 2 + Math.random() * 5); }
  x.strokeStyle = 'rgba(255,255,255,.95)'; x.lineWidth = 8; x.setLineDash([34, 22]); x.strokeRect(70, 70, S - 140, S - 140);
  x.setLineDash([]); x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = 9; x.beginPath(); x.moveTo(S / 2, 46); x.lineTo(S / 2, S / 2 - 190); x.moveTo(S / 2, S / 2 + 190); x.lineTo(S / 2, S - 46); x.moveTo(46, S / 2); x.lineTo(S / 2 - 190, S / 2); x.moveTo(S / 2 + 190, S / 2); x.lineTo(S - 46, S / 2); x.stroke();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, HALF * 2), new THREE.MeshStandardMaterial({ map: mkTex(c), roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
}
// grass outside + trees
{
  const c = mkCanvas(128, 128), x = c.getContext('2d'); x.fillStyle = '#62dd4b'; x.fillRect(0, 0, 128, 128);
  for (let k = 0; k < 420; k++) { x.fillStyle = Math.random() < 0.5 ? 'rgba(40,160,40,.3)' : 'rgba(200,255,140,.3)'; x.fillRect(Math.random() * 128, Math.random() * 128, 2, 2 + Math.random() * 4); }
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshStandardMaterial({ map: mkTex(c, [60, 60]), roughness: 1 }));
  grass.rotation.x = -Math.PI / 2; grass.position.y = -0.06; scene.add(grass);
  const N = 64, trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.6, 3.4, 8), new THREE.MeshStandardMaterial({ color: 0xf1e3c8, roughness: 0.8 }), N);
  const leaf = new THREE.InstancedMesh(new THREE.SphereGeometry(3.2, 14, 12), new THREE.MeshStandardMaterial({ roughness: 0.55 }), N);
  const m4 = new THREE.Matrix4(), col = new THREE.Color(), hues = [0.88, 0.78, 0.92, 0.33, 0.08];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + Math.random() * 0.1, r = HALF + 9 + Math.random() * 40, tx = Math.cos(a) * r, tz = Math.sin(a) * r, sc = 0.8 + Math.random() * 0.8;
    m4.compose(new THREE.Vector3(tx, 1.7 * sc, tz), new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc)); trunk.setMatrixAt(i, m4);
    m4.compose(new THREE.Vector3(tx, 5.6 * sc, tz), new THREE.Quaternion(), new THREE.Vector3(sc, sc * 0.95, sc)); leaf.setMatrixAt(i, m4);
    col.setHSL(hues[i % hues.length], 0.7, 0.62); leaf.setColorAt(i, col);
  }
  scene.add(trunk, leaf);
}
// walls: red/white barrier stripes + corner pylons
{
  const c = mkCanvas(128, 32), x = c.getContext('2d'); x.fillStyle = '#8f3df5'; x.fillRect(0, 0, 128, 32); x.fillStyle = '#a45bff'; x.fillRect(0, 0, 128, 8); x.fillStyle = '#7a2fe0'; x.fillRect(0, 26, 128, 6);
  const wallM = new THREE.MeshStandardMaterial({ map: mkTex(c, [HALF / 4, 1]), roughness: 0.6 });
  const W = (cx, cz, w, d, rot) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.2, d), wallM.clone()); m.material.map = m.material.map.clone(); m.material.map.needsUpdate = true; m.material.map.repeat.set((rot ? d : w) / 8, 1); m.position.set(cx, 1.1, cz); scene.add(m); };
  W(0, HALF + 1, HALF * 2 + 4, 2); W(0, -HALF - 1, HALF * 2 + 4, 2); W(HALF + 1, 0, 2, HALF * 2, 1); W(-HALF - 1, 0, 2, HALF * 2, 1);
  { // red/white curbs painted along the inside of the walls
    const c2 = mkCanvas(128, 32), x2 = c2.getContext('2d'); x2.fillStyle = '#fff'; x2.fillRect(0, 0, 128, 32); x2.fillStyle = '#ee3b45'; for (let i = 0; i < 4; i++) x2.fillRect(i * 32 + 16, 0, 16, 32);
    for (const [cx, cz, len, rot] of [[0, HALF - 1.1, HALF * 2, 0], [0, -HALF + 1.1, HALF * 2, 0], [HALF - 1.1, 0, HALF * 2, 1], [-HALF + 1.1, 0, HALF * 2, 1]]) {
      const t2 = mkTex(c2, [len / 6, 1]); const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 2.2), new THREE.MeshStandardMaterial({ map: t2, roughness: 0.7 }));
      m.rotation.x = -Math.PI / 2; m.rotation.z = rot ? Math.PI / 2 : 0; m.position.set(cx, 0.03, cz); scene.add(m);
    }
  }
  const post = new THREE.MeshStandardMaterial({ color: 0xffffff }), glow = new THREE.MeshBasicMaterial({ color: 0xffd60a });
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const g = new THREE.Group(); const po = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 7, 8), post); po.position.y = 3.5; g.add(po);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 10), glow); orb.position.y = 7.6; g.add(orb);
    g.position.set(sx * (HALF + 1), 0, sz * (HALF + 1)); scene.add(g);
  }
}
// crates
const crateTex = (hex) => {
  const c = mkCanvas(128, 128), x = c.getContext('2d'), col = '#' + hex.toString(16).padStart(6, '0');
  x.fillStyle = col; x.fillRect(0, 0, 128, 128); x.fillStyle = 'rgba(0,0,0,.18)'; x.fillRect(0, 0, 128, 12); x.fillRect(0, 116, 128, 12);
  x.strokeStyle = 'rgba(255,255,255,.55)'; x.lineWidth = 8; x.strokeRect(8, 8, 112, 112); x.beginPath(); x.moveTo(8, 8); x.lineTo(120, 120); x.moveTo(120, 8); x.lineTo(8, 120); x.stroke();
  return c;
};
{
  const pal = [0xff5c8a, 0xffb703, 0x3ddc5a, 0x8e6bff, 0x38bdf8];
  OBST.forEach((o, i) => {
    const t = mkTex(crateTex(pal[i % pal.length]), [Math.max(1, Math.round(o.w / 2)), 1]), tt = mkTex(crateTex(0xf2f2f7));
    const side = new THREE.MeshStandardMaterial({ map: t, roughness: 0.55 }), top = new THREE.MeshStandardMaterial({ map: tt, roughness: 0.5 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(o.w * 2, 3.2, o.d * 2), [side, side, top, top, side, side]);
    m.position.set(o.x, 1.6, o.z); scene.add(m);
  });
}
// lava pit + speed pads
const lavaTex = (() => { const c = mkCanvas(256, 256), x = c.getContext('2d'); x.fillStyle = '#d6280a'; x.fillRect(0, 0, 256, 256); for (let i = 0; i < 90; i++) { x.fillStyle = Math.random() < 0.5 ? '#ff7a1a' : '#ffc928'; x.beginPath(); x.arc(Math.random() * 256, Math.random() * 256, 8 + Math.random() * 22, 0, 7); x.fill(); } return mkTex(c, [1, 1]); })();
lavaTex.wrapS = lavaTex.wrapT = THREE.RepeatWrapping;
const lava = new THREE.Mesh(new THREE.CircleGeometry(LAVA.r, 40), new THREE.MeshBasicMaterial({ map: lavaTex })); lava.rotation.x = -Math.PI / 2; lava.position.set(LAVA.x, 0.05, LAVA.z); scene.add(lava);
const lavaRim = new THREE.Mesh(new THREE.RingGeometry(LAVA.r, LAVA.r + 1.1, 40), new THREE.MeshStandardMaterial({ color: 0x2b2b33, roughness: 0.8 })); lavaRim.rotation.x = -Math.PI / 2; lavaRim.position.set(LAVA.x, 0.07, LAVA.z); scene.add(lavaRim);
const lavaGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, color: 0xff7a1a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })); lavaGlow.scale.set(30, 30, 1); lavaGlow.position.set(LAVA.x, 2.5, LAVA.z); scene.add(lavaGlow);
const padTex = (() => { const c = mkCanvas(128, 128), x = c.getContext('2d'); x.fillStyle = '#ffd60a'; x.beginPath(); x.arc(64, 64, 62, 0, 7); x.fill(); x.strokeStyle = '#fff'; x.lineWidth = 6; x.beginPath(); x.arc(64, 64, 56, 0, 7); x.stroke(); x.fillStyle = '#fff'; x.font = '900 78px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('⚡', 64, 70); return mkTex(c); })();
const padMeshes = PADS.map((p) => { const m = new THREE.Mesh(new THREE.CircleGeometry(3.2, 28), new THREE.MeshBasicMaterial({ map: padTex })); m.rotation.x = -Math.PI / 2; m.position.set(p[0], 0.06, p[1]); scene.add(m); return m; });
// clouds
const clouds = [];
for (let i = 0; i < 14; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0.95, fog: false, depthWrite: false, color: 0xffffff }));
  const a = Math.random() * Math.PI * 2, r = 150 + Math.random() * 60; sp.position.set(Math.cos(a) * r, 50 + Math.random() * 40, Math.sin(a) * r); sp.scale.set(70 + Math.random() * 50, 22 + Math.random() * 10, 1);
  clouds.push(sp); scene.add(sp);
}

// item boxes
const qTex = (() => { const c = mkCanvas(128, 128), x = c.getContext('2d'), g = x.createLinearGradient(0, 0, 128, 128); g.addColorStop(0, '#ffe066'); g.addColorStop(1, '#ff9f0a'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); x.strokeStyle = '#fff'; x.lineWidth = 8; x.strokeRect(6, 6, 116, 116); x.fillStyle = '#fff'; x.font = '900 92px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.shadowColor = 'rgba(0,0,0,.4)'; x.shadowBlur = 8; x.fillText('?', 64, 70); return mkTex(c); })();
const itemMeshes = ITEMS.map((p) => {
  const g = new THREE.Group(); g.position.set(p[0], 0, p[1]);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), new THREE.MeshStandardMaterial({ map: qTex, emissive: 0x884400, emissiveMap: qTex, emissiveIntensity: 0.55, roughness: 0.3 })); box.position.y = 1.9; g.add(box);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, color: 0xffcc33, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })); halo.scale.set(5, 5, 1); halo.position.y = 1.9; g.add(halo);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.07, 6, 28), new THREE.MeshBasicMaterial({ color: 0xffe9a0 })); ring.rotation.x = Math.PI / 2; ring.position.y = 0.15; g.add(ring);
  scene.add(g); return { g, box, ring, pop: 1, was: true };
});

// karts
const boxMat = (c, r = 0.5, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
const wheelGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.5, 16); wheelGeo.rotateZ(Math.PI / 2);
const hubGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.54, 10); hubGeo.rotateZ(Math.PI / 2);
const wheelMat = boxMat(0x151517, 0.95), hubMat = boxMat(0xd1d1d6, 0.3, 0.8), headMat = boxMat(0xffd7b5, 0.8), glowGeo = new THREE.SphereGeometry(1, 14, 12);
const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff4b0 }), tailMat = new THREE.MeshBasicMaterial({ color: 0xff2d2d });
const ANIMALS = [
  { n: 'bunny', c: 0xffffff, ear: 'long', in: 0xffb3c7 }, { n: 'bear', c: 0xa5683a, ear: 'round' }, { n: 'cat', c: 0xff9f43, ear: 'point' }, { n: 'frog', c: 0x5fd35f, ear: 'eyes' },
  { n: 'panda', c: 0xffffff, ear: 'round', dark: 0x1c1c1e, patch: true }, { n: 'fox', c: 0xff7a2f, ear: 'point', muzzle: 0xffffff }, { n: 'pig', c: 0xffb0c8, ear: 'flop', snout: 0xff8fb0 }, { n: 'koala', c: 0xb9bcc8, ear: 'round', big: true, nose: 0x2a2a2e },
];
const SPH = (r) => new THREE.SphereGeometry(r, 16, 12);
function animalHead(body, ci, add) {
  const A = ANIMALS[ci % ANIMALS.length], fur = boxMat(A.c, 0.7), dk = boxMat(A.dark || 0x1c1c1e, 0.8), eyeW = boxMat(0xffffff, 0.3), pup = new THREE.MeshBasicMaterial({ color: 0x111111 });
  const Y = 2.15, Z = -0.4, R = 0.66;
  add(SPH(R), fur, 0, Y, Z);
  add(new THREE.SphereGeometry(R + 0.04, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.42), boxMat(0xffffff, 0.35), 0, Y + 0.02, Z - 0.02).visible = false; // (spare)
  const ear = (x, geo, mat, y, rz) => { const m = add(geo, mat, x, y, Z - 0.05); m.rotation.z = rz; return m; };
  if (A.ear === 'long') for (const x of [-0.28, 0.28]) { ear(x, new THREE.CapsuleGeometry(0.17, 0.75, 4, 8), fur, Y + 0.95, x * 0.5); add(new THREE.CapsuleGeometry(0.09, 0.55, 4, 8), boxMat(A.in, 0.8), x, Y + 0.97, Z + 0.1).rotation.z = x * 0.5; }
  else if (A.ear === 'round') for (const x of [-0.5, 0.5]) { const r = A.big ? 0.36 : 0.26; add(SPH(r), A.dark ? dk : fur, x, Y + 0.5, Z); if (A.big) add(SPH(0.2), boxMat(0xf0d6e0, 0.8), x, Y + 0.5, Z + 0.18); }
  else if (A.ear === 'point') for (const x of [-0.38, 0.38]) { const c = new THREE.ConeGeometry(0.24, 0.5, 4); ear(x, c, fur, Y + 0.68, -x * 0.25); }
  else if (A.ear === 'flop') for (const x of [-0.45, 0.45]) { const c = new THREE.ConeGeometry(0.22, 0.38, 4); const m = ear(x, c, fur, Y + 0.5, -x * 1.2); m.rotation.x = 0.5; }
  const eyeX = [-0.25, 0.25];
  if (A.ear === 'eyes') for (const x of eyeX) { add(SPH(0.22), fur, x * 1.2, Y + 0.55, Z + 0.05); add(SPH(0.15), eyeW, x * 1.2, Y + 0.56, Z + 0.2); add(SPH(0.075), pup, x * 1.2, Y + 0.56, Z + 0.32); }
  else for (const x of eyeX) { if (A.patch) add(SPH(0.17), dk, x * 1.05, Y + 0.08, Z + 0.5).scale.set(1, 1.3, 0.5); add(SPH(0.13), eyeW, x, Y + 0.1, Z + 0.52); add(SPH(0.065), pup, x, Y + 0.1, Z + 0.62); }
  if (A.muzzle) add(SPH(0.3), boxMat(A.muzzle, 0.7), 0, Y - 0.18, Z + 0.5).scale.set(1.1, 0.8, 0.8);
  if (A.snout) add(SPH(0.24), boxMat(A.snout, 0.7), 0, Y - 0.12, Z + 0.58).scale.set(1.2, 0.85, 0.7);
  add(SPH(0.09), boxMat(A.nose || 0x2a2a2e, 0.4), 0, Y - 0.05, Z + (A.snout ? 0.78 : 0.66));
  if (A.ear === 'eyes') add(new THREE.BoxGeometry(0.5, 0.05, 0.05), pup, 0, Y - 0.25, Z + 0.62);
  add(new THREE.CylinderGeometry(R * 0.7, R * 0.75, 0.2, 14), boxMat(0xf2f2f7, 0.5), 0, Y - 0.6, Z); // collar
}
const karts = new Map();
function makeKart(id, name, ci) {
  const col = COLORS[ci % COLORS.length], g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const paint = boxMat(col, 0.38, 0), dark = boxMat(0x3b3b4a, 0.6, 0.1), white = boxMat(0xf2f2f7, 0.4);
  const add = (geo, mat, x, y, z, parent = body) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
  add(new THREE.BoxGeometry(1.9, 0.62, 3.1), paint, 0, 0.78, 0);
  add(new THREE.BoxGeometry(1.5, 0.5, 1.2), paint, 0, 0.68, 1.95).rotation.x = 0.12;
  add(new THREE.BoxGeometry(2.1, 0.28, 0.5), dark, 0, 0.5, 2.55);                       // front bumper
  add(new THREE.BoxGeometry(0.5, 0.05, 3.0), white, 0, 1.12, 0.1);                       // racing stripe
  add(new THREE.BoxGeometry(0.5, 0.5, 2.0), paint, -1.15, 0.72, -0.2); add(new THREE.BoxGeometry(0.5, 0.5, 2.0), paint, 1.15, 0.72, -0.2); // side pods
  add(new THREE.BoxGeometry(1.25, 0.65, 1.1), dark, 0, 1.28, -0.35);                     // seat
  add(new THREE.BoxGeometry(1.25, 0.9, 0.3), dark, 0, 1.6, -0.95);                       // seat back
  const wheel = add(new THREE.TorusGeometry(0.34, 0.07, 6, 14), dark, 0, 1.55, 0.55); wheel.rotation.x = 1.1; // steering wheel
  animalHead(body, ci, add);
  add(new THREE.BoxGeometry(2.3, 0.14, 0.7), dark, 0, 1.75, -1.65); add(new THREE.BoxGeometry(0.14, 0.7, 0.5), dark, -0.9, 1.4, -1.5); add(new THREE.BoxGeometry(0.14, 0.7, 0.5), dark, 0.9, 1.4, -1.5); // rear wing
  add(new THREE.SphereGeometry(0.2, 8, 6), lampMat, -0.6, 0.78, 2.5); add(new THREE.SphereGeometry(0.2, 8, 6), lampMat, 0.6, 0.78, 2.5);                       // headlights
  add(new THREE.BoxGeometry(0.4, 0.16, 0.1), tailMat, -0.65, 0.95, -1.58); add(new THREE.BoxGeometry(0.4, 0.16, 0.1), tailMat, 0.65, 0.95, -1.58);            // tail lights
  const pipe = new THREE.CylinderGeometry(0.14, 0.14, 0.5, 8); pipe.rotateX(Math.PI / 2);
  add(pipe, hubMat, -0.45, 0.62, -1.7); add(pipe, hubMat, 0.45, 0.62, -1.7);
  const wheels = [];
  for (const [x, z] of [[-1.1, 1.25], [1.1, 1.25], [-1.1, -1.15], [1.1, -1.15]]) { const w = new THREE.Group(); w.position.set(x, 0.55, z); w.add(new THREE.Mesh(wheelGeo, wheelMat), new THREE.Mesh(hubGeo, hubMat)); g.add(w); wheels.push(w); }
  const sh = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0x64d2ff, transparent: true, opacity: 0.32, depthWrite: false })); sh.scale.set(2.5, 2.2, 3.1); sh.position.y = 1.1; sh.visible = false; g.add(sh);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })); blob.rotation.x = -Math.PI / 2; blob.scale.set(3.6, 4.6, 1); blob.position.y = 0.05; g.add(blob);
  const cv = mkCanvas(256, 72), tex = mkTex(cv);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); tag.scale.set(4.4, 1.24, 1); tag.position.y = 3.9; tag.renderOrder = 10; g.add(tag);
  const crown = new THREE.Sprite(new THREE.SpriteMaterial({ map: (() => { const c = mkCanvas(64, 64), x = c.getContext('2d'); x.font = '48px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('👑', 32, 36); return mkTex(c); })(), transparent: true, depthTest: false })); crown.scale.set(2, 2, 1); crown.position.y = 5.2; crown.renderOrder = 11; crown.visible = false; g.add(crown);
  scene.add(g);
  const k = { g, body, wheels, crown, cv, tex, sh, tag, name, ci, tagKey: '', px: null, pz: null, ph: 0, spin: 0, roll: 0, em: 0, dust: 0, turn: 0, speed: 0 };
  karts.set(id, k); return k;
}
function paintTag(k, hp, mine) {
  const key = k.name + '|' + Math.ceil(hp / 5) + '|' + mine;
  if (key === k.tagKey) return; k.tagKey = key;
  const x = k.cv.getContext('2d'); x.clearRect(0, 0, 256, 72);
  x.font = '700 30px -apple-system, Roboto, sans-serif'; x.textAlign = 'center'; x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,.7)';
  x.strokeText(k.name, 128, 30); x.fillStyle = mine ? '#ffd60a' : '#fff'; x.fillText(k.name, 128, 30);
  x.fillStyle = 'rgba(0,0,0,.6)'; x.fillRect(38, 42, 180, 16);
  x.fillStyle = hp > 55 ? '#30d158' : hp > 28 ? '#ffd60a' : '#ff453a'; x.fillRect(40, 44, 176 * Math.max(0, hp) / 100, 12);
  k.tex.needsUpdate = true;
}

// particles (pooled sprites)
const parts = [];
for (let i = 0; i < 160; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, transparent: true, depthWrite: false })); sp.visible = false; scene.add(sp);
  parts.push({ sp, life: 0, age: 0, vx: 0, vy: 0, vz: 0, s0: 1, s1: 1, g: 0, o: 1 });
}
let pi = 0;
function emit(x, y, z, vx, vy, vz, life, s0, s1, color, add, grav = 0, o = 1) {
  let p = null;
  for (let t = 0; t < parts.length; t++) { const c = parts[(pi + t) % parts.length]; if (c.life <= 0) { p = c; pi = (pi + t + 1) % parts.length; break; } }
  if (!p) { p = parts[pi]; pi = (pi + 1) % parts.length; }
  p.sp.position.set(x, y, z); p.vx = vx; p.vy = vy; p.vz = vz; p.life = life; p.age = 0; p.s0 = s0; p.s1 = s1; p.g = grav; p.o = o;
  p.sp.material.color.set(color); p.sp.material.blending = add ? THREE.AdditiveBlending : THREE.NormalBlending; p.sp.visible = true; p.sp.scale.set(s0, s0, 1);
}
function updateParts(dt) {
  for (const p of parts) {
    if (p.life <= 0) continue;
    p.age += dt; if (p.age >= p.life) { p.life = 0; p.sp.visible = false; continue; }
    const f = p.age / p.life; p.vy -= p.g * dt;
    p.sp.position.x += p.vx * dt; p.sp.position.y = Math.max(0.1, p.sp.position.y + p.vy * dt); p.sp.position.z += p.vz * dt;
    const s = p.s0 + (p.s1 - p.s0) * f; p.sp.scale.set(s, s, 1); p.sp.material.opacity = p.o * (1 - f) * (1 - f * 0.3);
  }
}

// projectiles / mines / explosions
const projMeshes = new Map(), mineMeshes = new Map(), booms = [];
const rocketGeo = new THREE.CapsuleGeometry(0.24, 1.0, 4, 10); rocketGeo.rotateX(Math.PI / 2);
const rocketMat = new THREE.MeshStandardMaterial({ color: 0xe5e5ea, emissive: 0xff5500, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.3 });
const homingMat = new THREE.MeshStandardMaterial({ color: 0xff5cf0, emissive: 0xff2fd0, emissiveIntensity: 0.9, metalness: 0.4, roughness: 0.3 });
const bulletGeo = new THREE.SphereGeometry(0.2, 8, 6), bulletMat = new THREE.MeshBasicMaterial({ color: 0xfff176 });
const mineGeo = new THREE.CylinderGeometry(0.95, 1.05, 0.34, 18), mineOff = boxMat(0x6e1c1c, 0.5, 0.4), mineOn = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff0000, emissiveIntensity: 1 });
const spikeGeo = new THREE.ConeGeometry(0.16, 0.5, 6);
const ringGeo = new THREE.RingGeometry(0.7, 1, 32);
function boom(x, z, r) {
  const m = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xffb02e, transparent: true, opacity: 0.95, depthWrite: false }));
  m.position.set(x, 1.2, z); scene.add(m); booms.push({ m, age: 0, r, ring: false });
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.2, z); scene.add(ring); booms.push({ m: ring, age: 0, r: r * 1.5, ring: true });
  for (let i = 0; i < 20; i++) { const a = Math.random() * Math.PI * 2, sp = 5 + Math.random() * 14; emit(x, 1.2, z, Math.cos(a) * sp, 4 + Math.random() * 9, Math.sin(a) * sp, 0.5 + Math.random() * 0.5, 1.1, 0.2, Math.random() < 0.5 ? 0xffd23f : 0xff6a1f, true, 22); }
  for (let i = 0; i < 9; i++) { const a = Math.random() * Math.PI * 2, sp = Math.random() * 3.5; emit(x, 1.5, z, Math.cos(a) * sp, 2 + Math.random() * 3, Math.sin(a) * sp, 1.1 + Math.random() * 0.8, 2.2, 6 + r * 0.5, 0x3a3a3f, false, -1, 0.8); }
}
function burst(id, color, n = 10) {
  const k = lastView && lastView.k.find((q) => q.id === id); if (!k) return;
  for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 6; emit(k.x, 1.6, k.z, Math.cos(a) * sp, 3 + Math.random() * 5, Math.sin(a) * sp, 0.5 + Math.random() * 0.3, 0.9, 0.1, color, true, 16); }
}

// ------------------------------------------------------------------ views (host reads sim directly, clients interpolate)
const fromArr = (a) => ({ id: a[0], x: a[1], z: a[2], h: a[3], hp: a[4], fl: a[5], w: WEAPONS[a[6]] || '', kills: a[7], deaths: a[8], ammo: a[9], rt: a[10] });
function simView() {
  const s = G.sim;
  return {
    st: s.state, left: Math.max(0, Math.round(s.left)), target: s.cfg.target, over: s.state === 'over' ? s.over : null,
    k: [...s.karts.values()].map((k) => ({ id: k.id, x: k.x, z: k.z, h: k.h, hp: Math.max(0, Math.round(k.hp)), fl: (k.dead ? 1 : 0) | (k.shield > 0 ? 2 : 0) | (k.boost > 0 ? 4 : 0) | (k.inv > 0 ? 8 : 0), w: k.weapon, kills: k.kills, deaths: k.deaths, ammo: k.ammo, rt: Math.ceil(Math.max(0, k.rt)) })),
    p: s.proj.map((p) => ({ id: p.id, type: p.type, x: p.x, z: p.z, h: p.h })), m: s.mines.map((m) => ({ id: m.id, x: m.x, z: m.z, on: m.arm <= 0 })), i: s.itemT.map((t) => (t > 0 ? '0' : '1')).join(''),
  };
}
const lerpAng = (a, b, f) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * f; };
function netView() {
  const sn = G.snaps; if (!sn.length) return null;
  const rt = performance.now() - 110;
  let a = sn[0], b = sn[sn.length - 1], f = 1;
  if (rt >= b.rt) { a = b; f = 1; }
  else if (rt > sn[0].rt) for (let i = 0; i < sn.length - 1; i++) if (sn[i].rt <= rt && rt <= sn[i + 1].rt) { a = sn[i]; b = sn[i + 1]; f = (rt - a.rt) / Math.max(1, b.rt - a.rt); break; }
  const am = new Map(a.k.map((k) => [k[0], k])), pm = new Map(a.p.map((p) => [p[0], p]));
  return {
    st: b.st, left: b.left, target: b.target, over: b.over,
    k: b.k.map((kb) => { const ka = am.get(kb[0]); const o = fromArr(kb); if (ka && !(ka[5] & 1) && !(kb[5] & 1) && Math.hypot(kb[1] - ka[1], kb[2] - ka[2]) < 20) { o.x = ka[1] + (kb[1] - ka[1]) * f; o.z = ka[2] + (kb[2] - ka[2]) * f; o.h = lerpAng(ka[3], kb[3], f); } return o; }),
    p: b.p.map((pb) => { const pa = pm.get(pb[0]); return { id: pb[0], type: pb[1], x: pa ? pa[2] + (pb[2] - pa[2]) * f : pb[2], z: pa ? pa[3] + (pb[3] - pa[3]) * f : pb[3], h: pb[4] }; }),
    m: b.m.map((m) => ({ id: m[0], x: m[1], z: m[2], on: !!m[3] })), i: b.i,
  };
}

// ------------------------------------------------------------------ input
const inp = { l: false, r: false, f: false };
function bindPad(id, key) {
  const el = $(id);
  const set = (v) => (e) => { e.preventDefault(); inp[key] = v; el.classList.toggle('down', v); if (v) audio(); };
  el.addEventListener('pointerdown', (e) => { try { el.setPointerCapture(e.pointerId); } catch {} set(true)(e); });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, set(false));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindPad('#pad-l', 'l'); bindPad('#pad-r', 'r'); bindPad('#pad-f', 'f');
const KEYS = { ArrowLeft: 'l', a: 'l', A: 'l', ArrowRight: 'r', d: 'r', D: 'r', ' ': 'f', ArrowUp: 'f', w: 'f', W: 'f' };
addEventListener('keydown', (e) => { const k = KEYS[e.key]; if (k && G.mode && e.target.tagName !== 'INPUT') { inp[k] = true; e.preventDefault(); } });
addEventListener('keyup', (e) => { const k = KEYS[e.key]; if (k) inp[k] = false; });
const steerVal = () => (inp.l ? 1 : 0) - (inp.r ? 1 : 0);

// ------------------------------------------------------------------ events
const nameOf = (id) => (G.roster.get(id) || {}).name || '?';
function feed(html) { const d = document.createElement('div'); d.innerHTML = html; $('#feed').appendChild(d); setTimeout(() => d.remove(), 4600); while ($('#feed').children.length > 4) $('#feed').firstChild.remove(); }
let lastView = null, lastKillT = 0, streak = 0;
const STREAK = ['', 'KILL!', 'DOUBLE KILL!', 'TRIPLE KILL!', 'MEGA KILL!', 'UNSTOPPABLE!'];
function streakPop() {
  const t = performance.now(); streak = t - lastKillT < 6000 ? Math.min(5, streak + 1) : 1; lastKillT = t;
  const el = $('#popup'); el.textContent = STREAK[streak]; el.classList.remove('go'); void el.offsetWidth; el.classList.add('go'); tone(400 + streak * 120, 900 + streak * 150, 0.25, 'triangle', 0.16);
}
function distToMe(x, z) { const me = lastView && lastView.k.find((k) => k.id === G.myId); return me ? Math.hypot(me.x - x, me.z - z) : 30; }
function processEvents(evs) {
  for (const e of evs || []) {
    switch (e[0]) {
      case 'boom': boom(e[1], e[2], e[3]); sfx.boom(Math.max(0.15, 1 - distToMe(e[1], e[2]) / 60)); break;
      case 'hit': burst(e[1], 0xffd23f, 7); if (e[1] === G.myId) { G.shake = 0.5; G.flash = 1; sfx.hit(); } break;
      case 'pick': burst(e[1], 0x7df9ff, 14); if (e[1] === G.myId) sfx.pick(); break;
      case 'kill': {
        const a = e[1] ? nameOf(e[1]) : null, b = nameOf(e[2]);
        feed(a && e[1] !== e[2] ? `<b>${esc(a)}</b> 💥 ${esc(b)}` : `${esc(b)} crashed`);
        if (e[2] === G.myId) G.killer = a && e[1] !== e[2] ? a : null;
        if (e[1] === G.myId && e[2] !== G.myId) streakPop();
        break;
      }
      case 'new': feed('🏁 New round!'); break;
    }
  }
}

// ------------------------------------------------------------------ render loop
let lastT = performance.now(), hudT = 0, camX = 0, camZ = 0, camH = 0, camInit = false, camRoll = 0;
let qN = 0, qT = 0, qLevel = 0;
function autoQuality(dt) { // lower resolution automatically on slow phones
  if (!G.mode || qLevel >= 2) return;
  qN++; qT += dt;
  if (qT > 4) {
    const fps = qN / qT; qN = 0; qT = 0;
    if (fps < 26) { qLevel++; renderer.setPixelRatio(qLevel === 1 ? 1 : 0.7); resize(); }
  }
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  autoQuality(dt);
  for (let i = booms.length - 1; i >= 0; i--) {
    const b = booms[i]; b.age += dt; const p = b.age / (b.ring ? 0.45 : 0.5);
    if (p >= 1) { scene.remove(b.m); b.m.material.dispose(); booms.splice(i, 1); continue; }
    if (b.ring) { const s = b.r * (0.2 + p * 0.95); b.m.scale.set(s, s, s); b.m.material.opacity = 0.8 * (1 - p); }
    else { const s = b.r * (0.35 + Math.sqrt(p) * 0.75); b.m.scale.set(s, s, s); b.m.material.opacity = 0.95 * (1 - p); b.m.material.color.setHSL(0.11 - p * 0.07, 1, 0.55 - p * 0.15); }
  }
  updateParts(dt);
  lavaTex.offset.set(Math.sin(now / 2400) * 0.15, now / 9000); lavaGlow.material.opacity = 0.45 + Math.sin(now / 400) * 0.1;
  if (Math.random() < dt * 5) { const a = Math.random() * 6.28, r = Math.random() * LAVA.r * 0.9; emit(LAVA.x + Math.cos(a) * r, 0.3, LAVA.z + Math.sin(a) * r, 0, 4 + Math.random() * 3, 0, 0.9, 0.9, 0.2, 0xffa01f, true, 6, 0.9); }
  padMeshes.forEach((m, i) => m.scale.setScalar(1 + Math.sin(now / 250 + i) * 0.06));
  for (const c of clouds) { c.position.x += dt * 0.6; if (c.position.x > 230) c.position.x = -230; }
  const tt = now / 1000;
  const v = G.mode ? (G.sim ? simView() : netView()) : null;
  itemMeshes.forEach((it, i) => {
    const on = !v || v.i[i] === '1';
    if (on && !it.was) it.pop = 0;
    it.was = on; it.g.visible = on;
    it.pop = Math.min(1, it.pop + dt * 3.5);
    const sc = it.pop < 1 ? 1 + Math.sin(it.pop * Math.PI) * 0.35 : 1, e = it.pop * (2 - it.pop);
    it.box.scale.setScalar(sc * e); it.box.position.y = 1.9 + Math.sin(tt * 2.2 + i) * 0.22; it.box.rotation.y = tt * 1.6; it.box.rotation.x = Math.sin(tt * 1.1 + i) * 0.25;
    it.ring.rotation.z = tt * 1.2; it.ring.scale.setScalar(1 + Math.sin(tt * 3 + i) * 0.08);
  });
  if (!v) { // menu backdrop: slow orbit
    const t = now / 4500; camera.position.set(Math.sin(t) * 58, 20, Math.cos(t) * 58); camera.lookAt(0, 2, 0); renderer.render(scene, camera); return;
  }
  lastView = v;
  const seen = new Set();
  let me = null, leaderId = null, lk = 0;
  for (const k of v.k) if (k.kills > lk) { lk = k.kills; leaderId = k.id; }
  for (const k of v.k) {
    seen.add(k.id);
    const r = G.roster.get(k.id) || { name: '?', ci: 0 };
    const km = karts.get(k.id) || makeKart(k.id, r.name, r.ci);
    if (km.name !== r.name || km.ci !== r.ci) { scene.remove(km.g); karts.delete(k.id); continue; }
    const dead = k.fl & 1, boost = k.fl & 4;
    km.g.visible = !dead;
    if (km.px !== null && dt > 0) {
      const mv = Math.hypot(k.x - km.px, k.z - km.pz);
      if (mv < 8) {
        km.speed += (mv / dt - km.speed) * Math.min(1, dt * 8);
        let dh = k.h - km.ph; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
        km.turn += (dh / dt - km.turn) * Math.min(1, dt * 8);
      }
    }
    km.px = k.x; km.pz = k.z; km.ph = k.h;
    km.g.position.set(k.x, 0, k.z); km.g.rotation.y = k.h;
    km.spin += km.speed * dt * 1.9; for (const w of km.wheels) w.children[0].rotation.x = km.spin, w.children[1].rotation.x = km.spin;
    km.roll += (Math.max(-0.22, Math.min(0.22, km.turn * 0.1)) - km.roll) * Math.min(1, dt * 8);
    km.body.rotation.z = km.roll; km.body.position.y = Math.sin(tt * 30 + k.x) * 0.012 * Math.min(1, km.speed / 10);
    km.wheels[0].rotation.y = km.wheels[1].rotation.y = -Math.max(-0.5, Math.min(0.5, km.turn * 0.25));
    km.sh.visible = !!(k.fl & 2) || ((k.fl & 8) && Math.floor(now / 120) % 2 === 0);
    km.sh.material.opacity = 0.3 + Math.sin(tt * 8) * 0.06;
    km.g.scale.setScalar(boost ? 1.05 : 1);
    paintTag(km, k.hp, k.id === G.myId);
    km.tag.visible = k.id !== G.myId;
    km.crown.visible = k.id === leaderId && !dead; km.crown.position.y = 5.2 + Math.sin(tt * 3) * 0.15;
    if (!dead && v.st === 'play') { // exhaust, boost flames, dust
      const fx = Math.sin(k.h), fz = Math.cos(k.h);
      km.em -= dt;
      if (km.em <= 0) {
        km.em = boost ? 0.025 : 0.07;
        const bx = k.x - fx * 1.9, bz = k.z - fz * 1.9;
        if (boost) { for (const sd of [-0.45, 0.45]) emit(bx - fz * sd, 0.7, bz + fx * sd, -fx * 6, 0.3, -fz * 6, 0.28, 1.2, 0.2, Math.random() < 0.5 ? 0x4dc8ff : 0xffffff, true, 0, 0.95); }
        else emit(bx, 0.7, bz, -fx * 1.5, 0.8, -fz * 1.5, 0.55, 0.5, 1.5, 0xb8b8c0, false, 0, 0.4);
      }
      km.dust -= dt;
      if (km.dust <= 0 && Math.abs(km.turn) > 1.5 && km.speed > 8) { km.dust = 0.05; for (const sd of [-1.1, 1.1]) emit(k.x - fx * 1.2 - fz * sd, 0.2, k.z - fz * 1.2 + fx * sd, (Math.random() - 0.5) * 2, 1, (Math.random() - 0.5) * 2, 0.6, 0.8, 2.4, 0xd9c9a3, false, 0, 0.5); }
    }
    if (k.id === G.myId) me = k;
  }
  for (const [id, km] of karts) if (!seen.has(id)) { scene.remove(km.g); karts.delete(id); }
  const pseen = new Set();
  for (const p of v.p) {
    pseen.add(p.id);
    let m = projMeshes.get(p.id);
    if (!m) { m = new THREE.Mesh(p.type === 'b' ? bulletGeo : rocketGeo, p.type === 'r' ? rocketMat : p.type === 'h' ? homingMat : bulletMat); scene.add(m); projMeshes.set(p.id, m); if (p.type !== 'b') sfx.fire(); else if (distToMe(p.x, p.z) < 25) sfx.shoot(); }
    m.position.set(p.x, 1.2, p.z); m.rotation.y = p.h;
    if (p.type !== 'b') { const fx = Math.sin(p.h), fz = Math.cos(p.h); emit(p.x - fx * 0.9, 1.2, p.z - fz * 0.9, -fx * 2, 0.4, -fz * 2, 0.35, 0.9, 0.2, p.type === 'h' ? 0xff5cf0 : 0xff8c1a, true, 0, 0.95); emit(p.x - fx * 1.1, 1.2, p.z - fz * 1.1, 0, 0.8, 0, 0.8, 0.6, 1.8, 0x9a9aa2, false, 0, 0.45); }
    else if (Math.random() < 0.5) emit(p.x, 1.2, p.z, 0, 0, 0, 0.12, 0.5, 0.1, 0xffe27a, true, 0, 0.9);
  }
  for (const [id, m] of projMeshes) if (!pseen.has(id)) { scene.remove(m); projMeshes.delete(id); }
  const mseen = new Set();
  for (const mi of v.m) {
    mseen.add(mi.id);
    let m = mineMeshes.get(mi.id);
    if (!m) {
      m = new THREE.Mesh(mineGeo, mineOff); scene.add(m); mineMeshes.set(mi.id, m);
      for (let i = 0; i < 8; i++) { const sp = new THREE.Mesh(spikeGeo, mineOff); const a = (i / 8) * Math.PI * 2; sp.position.set(Math.cos(a) * 0.7, 0.3, Math.sin(a) * 0.7); sp.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6); m.add(sp); }
    }
    m.position.set(mi.x, 0.2, mi.z);
    const lit = mi.on && Math.floor(now / 300) % 2 === 0, mat = lit ? mineOn : mineOff; m.material = mat; for (const c of m.children) c.material = mat;
  }
  for (const [id, m] of mineMeshes) if (!mseen.has(id)) { scene.remove(m); mineMeshes.delete(id); }

  // camera chase
  if (me) {
    if (!camInit) { camX = me.x; camZ = me.z; camH = me.h; camInit = true; }
    const dead = me.fl & 1;
    if (!dead) { const k = 1 - Math.pow(0.0008, dt); camX += (me.x - camX) * Math.min(1, k * 1.6); camZ += (me.z - camZ) * Math.min(1, k * 1.6); camH = lerpAng(camH, me.h, Math.min(1, k * 1.1)); }
    const back = dead ? 16 : 9.5, up = dead ? 12 : 5.6;
    camera.position.set(camX - Math.sin(camH) * back, up, camZ - Math.cos(camH) * back);
    G.shake = Math.max(0, G.shake - dt * 2.5);
    if (G.shake > 0) camera.position.add(new THREE.Vector3((Math.random() - 0.5) * G.shake, (Math.random() - 0.5) * G.shake, (Math.random() - 0.5) * G.shake));
    camera.lookAt(camX + Math.sin(camH) * 4, dead ? 0 : 1.2, camZ + Math.cos(camH) * 4);
    const mk = karts.get(me.id); camRoll += (((mk ? -mk.turn : 0) * 0.018) - camRoll) * Math.min(1, dt * 5); camera.rotateZ(Math.max(-0.07, Math.min(0.07, camRoll)));
    const fov = (innerWidth / innerHeight < 1 ? 76 : 62) + (me.fl & 4 ? 12 : 0); camera.fov += (fov - camera.fov) * Math.min(1, dt * 6); camera.updateProjectionMatrix();
  } else { camera.position.set(0, 50, 60); camera.lookAt(0, 0, 0); }
  renderer.render(scene, camera);
  if (now - hudT > 100) { hudT = now; updateHud(v, me); }
}

let bannerKey = '';
function updateHud(v, me) {
  if (me) {
    $('#hp-fill').style.width = Math.max(0, me.hp) + '%';
    $('#hp-fill').style.background = me.hp > 55 ? '' : me.hp > 28 ? 'linear-gradient(90deg,#ffd60a,#ffe066)' : 'linear-gradient(90deg,#ff453a,#ff7a70)';
    $('#hp-text').textContent = Math.max(0, me.hp);
    const w = $('#weapon'); w.classList.toggle('on', !!me.w && !(me.fl & 1));
    w.textContent = me.w ? WLABEL[me.w] + (me.w === 'mg' ? ' ×' + me.ammo : '') : '';
  }
  const s = Math.max(0, v.left); $('#timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const rank = [...v.k].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).slice(0, 4);
  $('#board').innerHTML = rank.map((k) => `<div class="${k.id === G.myId ? 'me' : ''}"><span>${esc(nameOf(k.id))}</span><i>${k.kills}</i></div>`).join('') + `<div style="color:#a1a1aa"><span>First to</span><i>${v.target}</i></div>`;
  let key = '', html = '';
  if (v.st === 'over' && v.over) {
    const win = v.over.winner === G.myId;
    key = 'over' + v.over.winner;
    html = `${win ? '🏆 You win!' : '🏁 ' + esc(nameOf(v.over.winner)) + ' wins'}<small>${v.over.rank.slice(0, 5).map((r, i) => `${i + 1}. ${esc(nameOf(r[0]))} — ${r[1]} kills`).join('<br>')}</small><small>Next round starting…</small>`;
  } else if (me && me.fl & 1) {
    key = 'dead' + me.rt + (G.killer || '');
    html = `💥 ${G.killer ? 'Destroyed by ' + esc(G.killer) : 'You crashed'}<small>Respawning in ${me.rt}…</small>`;
  } else if (G.mode === 'client' && !me) { key = 'wait'; html = 'Joining…'; }
  if (key !== bannerKey) { bannerKey = key; const b = $('#banner'); b.hidden = !key; b.innerHTML = html; }
  $('#hud').style.setProperty('--flash', G.flash);
  if (G.flash > 0) G.flash = Math.max(0, G.flash - 0.2);
}

// ------------------------------------------------------------------ host / solo loop
let simTimer = 0, snapAcc = 0, metaT = 0, lastSim = 0;
function sendRoster() {
  G.roster = new Map(G.sim.roster().map((r) => [r[0], { name: r[1], ci: r[2], bot: r[3] }]));
  if (G.net) for (const e of G.net.entries) if (e.pid) G.net.send(e, { t: 'roster', r: G.sim.roster() });
  G.sim.rosterDirty = false;
}
function simLoop() {
  const s = G.sim; if (!s) return;
  const now = performance.now(); let el = Math.min(0.25, (now - lastSim) / 1000); lastSim = now;
  s.setInput(G.myId, steerVal(), inp.f);
  while (el > 0) { const d = Math.min(1 / 60, el); s.step(d); el -= d; snapAcc += d; }
  if (s.rosterDirty) sendRoster();
  if (snapAcc >= 0.05) {
    snapAcc = 0;
    const snap = s.snapshot();
    processEvents(snap.ev);
    if (G.net) for (const e of G.net.entries) if (e.pid) G.net.send(e, snap);
  }
  if (G.net && G.net.setMeta && now - metaT > 2000) {
    metaT = now;
    const ks = [...s.karts.values()];
    G.net.setMeta({ game: 'kart', title: myName() + "'s game", seated: ks.filter((k) => !k.isBot).length, max: MAX_KARTS, bots: ks.filter((k) => k.isBot).length, blinds: `First to ${s.cfg.target}`, running: true });
  }
}
function hostMessage(entry, msg) {
  const s = G.sim; if (!s || !msg || typeof msg !== 'object') return;
  if (msg.t === 'join') {
    const pid = String(msg.token || '').slice(0, 64);
    if (!pid || pid === G.myId) return;
    for (const e of G.net.entries) if (e !== entry && e.pid === pid) { G.net.send(e, { t: 'replaced' }); try { e.conn.close(); } catch {} }
    entry.pid = pid;
    if (!s.karts.has(pid)) {
      if (s.karts.size >= MAX_KARTS) { const bot = [...s.karts.values()].find((k) => k.isBot); if (bot) s.removeKart(bot.id); }
      if (!s.addKart(pid, String(msg.name || 'Racer'), false)) { G.net.send(entry, { t: 'info', msg: 'Game is full' }); entry.pid = null; return; }
    }
    G.net.send(entry, { t: 'welcome', id: pid });
    sendRoster();
  } else if (msg.t === 'in' && entry.pid) s.setInput(entry.pid, msg.s, msg.f);
  else if (msg.t === 'leave' && entry.pid) { s.removeKart(entry.pid); entry.pid = null; }
}
function hostClosed(entry) {
  const pid = entry.pid; if (!pid) return;
  setTimeout(() => { if (G.sim && G.net && ![...G.net.entries].some((e) => e.pid === pid)) G.sim.removeKart(pid); }, 8000);
}

// ------------------------------------------------------------------ flow
const myName = () => ($('#name').value.trim() || 'Racer').slice(0, 12);
const panels = ['menu', 'setup', 'join', 'invite'];
function showPanel(id) { for (const p of panels) $('#' + p).hidden = p !== id; if (id === 'join') pollRooms(); }
function enterGame() { for (const p of panels) $('#' + p).hidden = true; $('#hud').hidden = false; bannerKey = ''; $('#banner').hidden = true; $('#feed').innerHTML = ''; camInit = false; audio(); }
function resetWorld() {
  for (const k of karts.values()) scene.remove(k.g); karts.clear(); camInit = false;
  for (const m of projMeshes.values()) scene.remove(m); projMeshes.clear();
  for (const m of mineMeshes.values()) scene.remove(m); mineMeshes.clear();
}

function startHosting(online) {
  const cfg = G.cfg;
  G.sim = new Sim({ target: cfg.target }); G.mode = online ? 'host' : 'solo'; G.snaps = []; G.leaving = false;
  const me = myName(); lsSet('kart.name', me);
  G.sim.addKart(G.myId, me, false);
  const names = NAMES.filter((n) => n !== me).sort(() => Math.random() - 0.5);
  for (let i = 0; i < cfg.bots; i++) G.sim.addKart('bot' + i, names[i], true);
  sendRoster(); lastSim = performance.now(); snapAcc = 0;
  clearInterval(simTimer); simTimer = setInterval(simLoop, 16);
  enterGame();
  $('#btn-invite').hidden = !online;
  if (online) {
    if (!G.lan && !window.Peer) { toast('Network library failed to load'); quit(); return; }
    const Net = G.lan ? LanHostNet : HostNet;
    toast('Creating game…');
    G.net = new Net({
      onReady: (code) => { G.code = code; history.replaceState(null, '', '?t=' + code); showInvite(); $('#invite').hidden = false; },
      onMessage: hostMessage, onClose: hostClosed,
      onError: (e) => toast('Network: ' + (e.type || e.message || 'error')),
    });
  }
}

function joinGame(code) {
  code = code.trim().toUpperCase();
  if (code.length !== 5) return toast('Codes are 5 characters');
  if (!G.lan && !window.Peer) return toast('Network library failed to load');
  lsSet('kart.name', myName());
  G.mode = 'client'; G.sim = null; G.code = code; G.snaps = []; G.roster = new Map(); G.welcomed = false; G.reconnects = 0; G.leaving = false;
  toast('Joining ' + code + '…');
  connectClient(true);
}
function connectClient(first) {
  if (G.net) G.net.destroy();
  const Net = G.lan ? LanClientNet : ClientNet;
  G.net = new Net(G.code, {
    onOpen: () => { G.reconnects = 0; G.net.send({ t: 'join', name: myName(), token: G.myId }); },
    onMessage: (m) => {
      if (m.t === 'welcome') { if (!G.welcomed) { G.welcomed = true; enterGame(); $('#btn-invite').hidden = true; history.replaceState(null, '', '?t=' + G.code); } }
      else if (m.t === 'roster') { G.roster = new Map(m.r.map((r) => [r[0], { name: r[1], ci: r[2], bot: r[3] }])); }
      else if (m.t === 'snap') { m.rt = performance.now(); G.snaps.push(m); if (G.snaps.length > 12) G.snaps.shift(); processEvents(m.ev); }
      else if (m.t === 'info') toast(m.msg);
      else if (m.t === 'replaced') { toast('Opened on another device'); quit(); }
    },
    onClose: () => reconnectSoon(),
    onError: (e) => {
      if (first && !G.welcomed) { toast('No game found with code ' + G.code); quit(); }
      else reconnectSoon();
    },
  });
}
function reconnectSoon() {
  if (G.leaving || G.mode !== 'client') return;
  if (++G.reconnects > 8) { toast('Lost connection to the host'); quit(); return; }
  toast('Reconnecting…');
  setTimeout(() => { if (!G.leaving && G.mode === 'client') connectClient(false); }, Math.min(1000 * G.reconnects, 4000));
}
setInterval(() => { // client input uplink
  if (G.mode === 'client' && G.net && G.net.conn && G.net.conn.open && G.welcomed) G.net.send({ t: 'in', s: steerVal(), f: inp.f });
}, 40);

function quit() {
  G.leaving = true;
  if (G.net) { if (G.mode === 'client') { G.net.send({ t: 'leave' }); const n = G.net; setTimeout(() => n.destroy(), 250); } else G.net.destroy(); G.net = null; }
  clearInterval(simTimer); G.sim = null; G.mode = null; G.snaps = []; G.code = null; lastView = null;
  resetWorld();
  $('#hud').hidden = true; history.replaceState(null, '', location.pathname); showPanel('menu');
}
$('#btn-quit').addEventListener('click', () => { if (confirm(G.mode === 'host' ? 'End the game for everyone?' : 'Leave the game?')) quit(); });

// invite
function inviteUrl() {
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname), ip = G.lan && G.lan.ips && G.lan.ips[0];
  const base = G.lan && local && ip ? `http://${ip.ip}:${location.port || G.lan.port}` : location.origin;
  return `${base}/kart.html?t=${G.code}`;
}
function showInvite() {
  const url = inviteUrl();
  $('#inv-code').textContent = G.code; $('#inv-url').textContent = url.replace(/^https?:\/\//, '');
  let svg = ''; try { const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make(); svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch {}
  $('#inv-qr').innerHTML = svg;
}
$('#inv-done').addEventListener('click', () => { $('#invite').hidden = true; });
$('#btn-invite').addEventListener('click', () => { showInvite(); $('#invite').hidden = false; });
$('#inv-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(inviteUrl()); toast('Link copied'); } catch { toast('Copy not available here'); } });

// menu wiring
$('#name').value = lsGet('kart.name') || lsGet('felt.name') || '';
$('#b-solo').addEventListener('click', () => { G.cfg.bots = 5; G.cfg.target = 10; startHosting(false); });
$('#b-host').addEventListener('click', () => { $('#setup-title').textContent = G.lan ? 'Host on this Wi-Fi' : 'Host a Game'; showPanel('setup'); });
$('#b-join').addEventListener('click', () => showPanel('join'));
for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => showPanel('menu'));
for (const [id, key] of [['#seg-bots', 'bots'], ['#seg-target', 'target']]) $(id).addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  for (const x of $(id).children) x.classList.toggle('on', x === b);
  G.cfg[key] = +b.dataset.v;
});
$('#setup-go').addEventListener('click', () => startHosting(true));
$('#join-go').addEventListener('click', () => joinGame($('#code').value));
$('#code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(e.target.value); });
let roomT = 0;
async function pollRooms() {
  clearTimeout(roomT);
  if (!G.lan || $('#join').hidden) return;
  try {
    const rooms = (await (await fetch('/api/rooms', { cache: 'no-store' })).json()).filter((r) => r.game === 'kart');
    $('#rooms-wrap').hidden = false;
    $('#rooms').innerHTML = rooms.length ? rooms.map((r) => `<button class="room" data-room="${esc(r.code)}"><span>${esc(r.title || 'Game')}<small>${esc(r.code)} · ${r.seated} player${r.seated === 1 ? '' : 's'}${r.bots ? ` + ${r.bots} bots` : ''} · ${esc(r.blinds || '')}</small></span><b>Join</b></button>`).join('') : '<div class="room" style="color:#a1a1aa">No games yet — ask a friend to host</div>';
  } catch {}
  roomT = setTimeout(pollRooms, 2000);
}
$('#rooms').addEventListener('click', (e) => { const b = e.target.closest('[data-room]'); if (b) joinGame(b.dataset.room); });

// boot
detectLan().then((info) => { if (info) { G.lan = info; $('#lan-badge').hidden = false; } });
const invite = new URLSearchParams(location.search).get('t');
if (invite) { $('#code').value = invite.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); if ($('#name').value.trim()) showPanel('join'); else setTimeout(() => { toast('Enter your name, then tap Join a Game'); $('#name').focus(); }, 300); }
requestAnimationFrame(frame);
window.__kart = G; // handy for debugging/tests

import * as THREE from 'three';
import { Sim, HALF, OBST, ITEMS, WEAPONS, NAMES, COLORS, MAX_KARTS } from './sim.js';
import { HostNet, ClientNet, LanHostNet, LanClientNet, detectLan } from '../net.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WLABEL = { rocket: '🚀 ROCKET', mine: '💣 MINE', mg: '🔫 GUN', shield: '🛡️ SHIELD', boost: '⚡ BOOST' };
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
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7ec8ff);
scene.fog = new THREE.Fog(0x7ec8ff, 60, 150);
const camera = new THREE.PerspectiveCamera(62, 1, 0.5, 300);
scene.add(new THREE.HemisphereLight(0xffffff, 0x556677, 1.05));
const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(30, 60, 20); scene.add(sun);
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.fov = w / h < 1 ? 76 : 62; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// arena
(function buildArena() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#3a3f4b'; x.fillRect(0, 0, 128, 128);
  x.fillStyle = '#434957'; x.fillRect(0, 0, 64, 64); x.fillRect(64, 64, 64, 64);
  x.strokeStyle = 'rgba(255,255,255,.07)'; x.lineWidth = 2; x.strokeRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(HALF / 4, HALF / 4); tex.anisotropy = 4;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2, HALF * 2), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: 0x5a8f5a }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.05; scene.add(outer);
  const wallM = new THREE.MeshStandardMaterial({ color: 0xe5484d, roughness: 0.7 }), stripe = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
  const W = (cx, cz, w, d) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 2.4, d), wallM); m.position.set(cx, 1.2, cz); scene.add(m);
    const s = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.5, d + 0.02), stripe); s.position.set(cx, 1.9, cz); scene.add(s);
  };
  W(0, HALF + 1, HALF * 2 + 4, 2); W(0, -HALF - 1, HALF * 2 + 4, 2); W(HALF + 1, 0, 2, HALF * 2); W(-HALF - 1, 0, 2, HALF * 2);
  const pal = [0x5e5ce6, 0xff9f0a, 0x30d158, 0xbf5af2, 0x64d2ff];
  OBST.forEach((o, i) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(o.w * 2, 3.2, o.d * 2), new THREE.MeshStandardMaterial({ color: pal[i % pal.length], roughness: 0.6 }));
    m.position.set(o.x, 1.6, o.z); scene.add(m);
    const t = new THREE.Mesh(new THREE.BoxGeometry(o.w * 2 + 0.1, 0.35, o.d * 2 + 0.1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    t.position.set(o.x, 3.2, o.z); scene.add(t);
  });
})();

// item boxes
const itemMeshes = ITEMS.map((p, i) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshStandardMaterial({ color: 0xffd60a, emissive: 0xaa7700, roughness: 0.3 }));
  m.position.set(p[0], 1.6, p[1]); scene.add(m); return m;
});

// karts
const boxMat = (c, r = 0.5) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.45, 14); wheelGeo.rotateZ(Math.PI / 2);
const wheelMat = boxMat(0x1c1c1e, 0.9), headMat = boxMat(0xffd7b5, 0.8), glowGeo = new THREE.SphereGeometry(1, 12, 10);
const karts = new Map(); // id -> { g, tagCtx, tagTex, last }
function makeKart(id, name, ci) {
  const col = COLORS[ci % COLORS.length], g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 3), boxMat(col, 0.35)); body.position.y = 0.75; g.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.45, 0.9), boxMat(col, 0.35)); nose.position.set(0, 0.65, 1.7); g.add(nose);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 1.1), boxMat(0x2c2c2e)); seat.position.set(0, 1.25, -0.2); g.add(seat);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 12), headMat); head.position.set(0, 1.85, -0.2); g.add(head);
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.47, 14, 12, 0, Math.PI * 2, 0, Math.PI / 2), boxMat(col, 0.3)); helm.position.set(0, 1.9, -0.2); g.add(helm);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.15, 0.55), boxMat(0x1c1c1e)); wing.position.set(0, 1.55, -1.5); g.add(wing);
  for (const [x, z] of [[-1, 1.1], [1, 1.1], [-1, -1.1], [1, -1.1]]) { const w = new THREE.Mesh(wheelGeo, wheelMat); w.position.set(x, 0.5, z); g.add(w); }
  const sh = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0x64d2ff, transparent: true, opacity: 0.35 })); sh.scale.set(2.4, 2.1, 2.9); sh.position.y = 1; sh.visible = false; g.add(sh);
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 72;
  const tex = new THREE.CanvasTexture(cv);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); tag.scale.set(4.4, 1.24, 1); tag.position.y = 3.6; tag.renderOrder = 10; g.add(tag);
  scene.add(g);
  const k = { g, cv, tex, sh, tag, name, ci, tagKey: '' };
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

// projectiles / mines / explosions
const projMeshes = new Map(), mineMeshes = new Map(), booms = [];
const rocketGeo = new THREE.CapsuleGeometry(0.22, 0.9, 4, 8); rocketGeo.rotateX(Math.PI / 2);
const rocketMat = new THREE.MeshStandardMaterial({ color: 0xd1d1d6, emissive: 0xff6a00, emissiveIntensity: 0.8 });
const bulletGeo = new THREE.SphereGeometry(0.22, 8, 6), bulletMat = new THREE.MeshBasicMaterial({ color: 0xfff176 });
const mineGeo = new THREE.CylinderGeometry(0.95, 1.05, 0.3, 16), mineOff = boxMat(0x7a1f1f), mineOn = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff0000, emissiveIntensity: 0.9 });
function boom(x, z, r) {
  const m = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xff9a1f, transparent: true, opacity: 0.9 }));
  m.position.set(x, 1.2, z); scene.add(m); booms.push({ m, age: 0, r });
}

// ------------------------------------------------------------------ views (host reads sim directly, clients interpolate)
const fromArr = (a) => ({ id: a[0], x: a[1], z: a[2], h: a[3], hp: a[4], fl: a[5], w: WEAPONS[a[6]] || '', kills: a[7], deaths: a[8], ammo: a[9], rt: a[10] });
function simView() {
  const s = G.sim;
  return {
    st: s.state, left: Math.max(0, Math.round(s.left)), target: s.cfg.target, over: s.state === 'over' ? s.over : null,
    k: [...s.karts.values()].map((k) => ({ id: k.id, x: k.x, z: k.z, h: k.h, hp: k.hp, fl: (k.dead ? 1 : 0) | (k.shield > 0 ? 2 : 0) | (k.boost > 0 ? 4 : 0) | (k.inv > 0 ? 8 : 0), w: k.weapon, kills: k.kills, deaths: k.deaths, ammo: k.ammo, rt: Math.ceil(Math.max(0, k.rt)) })),
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
let lastView = null;
function distToMe(x, z) { const me = lastView && lastView.k.find((k) => k.id === G.myId); return me ? Math.hypot(me.x - x, me.z - z) : 30; }
function processEvents(evs) {
  for (const e of evs || []) {
    switch (e[0]) {
      case 'boom': boom(e[1], e[2], e[3]); sfx.boom(Math.max(0.15, 1 - distToMe(e[1], e[2]) / 60)); break;
      case 'hit': if (e[1] === G.myId) { G.shake = 0.5; G.flash = 1; sfx.hit(); } break;
      case 'pick': if (e[1] === G.myId) sfx.pick(); break;
      case 'kill': {
        const a = e[1] ? nameOf(e[1]) : null, b = nameOf(e[2]);
        feed(a && e[1] !== e[2] ? `<b>${esc(a)}</b> 💥 ${esc(b)}` : `${esc(b)} crashed`);
        if (e[2] === G.myId) G.killer = a && e[1] !== e[2] ? a : null;
        break;
      }
      case 'new': feed('🏁 New round!'); break;
    }
  }
}

// ------------------------------------------------------------------ render loop
let lastT = performance.now(), hudT = 0, camX = 0, camZ = 0, camH = 0, camInit = false;
const nameTagReset = () => { for (const k of karts.values()) k.tagKey = ''; };
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  for (let i = booms.length - 1; i >= 0; i--) {
    const b = booms[i]; b.age += dt; const p = b.age / 0.5;
    if (p >= 1) { scene.remove(b.m); b.m.material.dispose(); booms.splice(i, 1); continue; }
    const s = b.r * (0.35 + p * 0.9); b.m.scale.set(s, s, s); b.m.material.opacity = 0.9 * (1 - p);
  }
  for (const m of itemMeshes) { m.rotation.y += dt * 1.8; m.rotation.x += dt * 0.9; }
  const v = G.mode ? (G.sim ? simView() : netView()) : null;
  if (!v) { // menu backdrop: slow orbit
    const t = now / 4000; camera.position.set(Math.sin(t) * 55, 22, Math.cos(t) * 55); camera.lookAt(0, 0, 0); renderer.render(scene, camera); return;
  }
  lastView = v;
  ITEMS.forEach((_, i) => { itemMeshes[i].visible = v.i[i] === '1'; });
  // karts
  const seen = new Set();
  let me = null;
  for (const k of v.k) {
    seen.add(k.id);
    const r = G.roster.get(k.id) || { name: '?', ci: 0 };
    const km = karts.get(k.id) || makeKart(k.id, r.name, r.ci);
    if (km.name !== r.name || km.ci !== r.ci) { scene.remove(km.g); karts.delete(k.id); continue; }
    const dead = k.fl & 1;
    km.g.visible = !dead;
    km.g.position.set(k.x, 0, k.z); km.g.rotation.y = k.h;
    km.sh.visible = !!(k.fl & 2) || ((k.fl & 8) && Math.floor(now / 120) % 2 === 0);
    km.g.scale.setScalar(k.fl & 4 ? 1.06 : 1);
    paintTag(km, k.hp, k.id === G.myId);
    km.tag.visible = k.id !== G.myId;
    if (k.id === G.myId) me = k;
  }
  for (const [id, km] of karts) if (!seen.has(id)) { scene.remove(km.g); karts.delete(id); }
  // projectiles
  const pseen = new Set();
  for (const p of v.p) {
    pseen.add(p.id);
    let m = projMeshes.get(p.id);
    if (!m) { m = new THREE.Mesh(p.type === 'r' ? rocketGeo : bulletGeo, p.type === 'r' ? rocketMat : bulletMat); scene.add(m); projMeshes.set(p.id, m); if (p.type === 'r') sfx.fire(); else if (distToMe(p.x, p.z) < 25) sfx.shoot(); }
    m.position.set(p.x, 1.2, p.z); m.rotation.y = p.h;
  }
  for (const [id, m] of projMeshes) if (!pseen.has(id)) { scene.remove(m); projMeshes.delete(id); }
  const mseen = new Set();
  for (const mi of v.m) {
    mseen.add(mi.id);
    let m = mineMeshes.get(mi.id);
    if (!m) { m = new THREE.Mesh(mineGeo, mineOff); scene.add(m); mineMeshes.set(mi.id, m); }
    m.position.set(mi.x, 0.2, mi.z); m.material = mi.on && Math.floor(now / 300) % 2 === 0 ? mineOn : mineOff;
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
    camera.fov = (innerWidth / innerHeight < 1 ? 76 : 62) + (me.fl & 4 ? 10 : 0); camera.updateProjectionMatrix();
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
  for (const k of karts.values()) scene.remove(k.g); karts.clear();
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

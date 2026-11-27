// Kart Battle — authoritative simulation. Pure JS (no DOM) so the host's browser runs it
// and node can test it. Coordinates: x/z plane, heading h, forward = (sin h, cos h).
export const HALF = 44; // arena half-size
export const MAX_KARTS = 12;
export const OBST = [ // axis-aligned blocks: center x,z and half sizes
  { x: -22, z: 14, w: 3, d: 8 }, { x: 22, z: -14, w: 3, d: 8 },
  { x: 20, z: 20, w: 7, d: 2 }, { x: -20, z: -20, w: 7, d: 2 },
  { x: -10, z: -30, w: 2, d: 2 }, { x: 10, z: 30, w: 2, d: 2 },
  { x: 32, z: 4, w: 2, d: 2 }, { x: -32, z: -4, w: 2, d: 2 },
  { x: 0, z: 22, w: 2, d: 5 }, { x: 0, z: -22, w: 2, d: 5 },
];
export const SPAWNS = [[-36, -36], [36, 36], [-36, 36], [36, -36], [0, -38], [0, 38], [-38, 0], [38, 0], [-14, 12], [14, -12], [-26, 28], [26, -28]];
export const ITEMS = [[-14, -14], [14, 14], [-14, 14], [14, -14], [0, 12], [0, -12], [-30, 0], [30, 0], [-36, 22], [36, -22]];
export const WEAPONS = ['', 'rocket', 'mine', 'mg', 'shield', 'boost', 'homing', 'triple'];
export const LAVA = { x: 0, z: 0, r: 6.5 }; // hazard pit in the middle
export const PADS = [[-27, 0], [27, 0], [0, -30], [0, 30]]; // speed strips
export const NAMES = ['Zoom', 'Blaze', 'Nitro', 'Turbo', 'Drift', 'Rex', 'Pixel', 'Bolt', 'Dash', 'Comet', 'Vortex', 'Spike'];
export const COLORS = [0xff453a, 0x0a84ff, 0x30d158, 0xffd60a, 0xbf5af2, 0xff9f0a, 0x64d2ff, 0xff375f, 0xac8e68, 0x5e5ce6, 0x32d74b, 0xe5e5ea];

const R_KART = 1.25, SPEED = 17, BOOST = 28, STEER = 2.3;
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Sim {
  constructor(cfg = {}) {
    this.cfg = { target: 10, time: 180, ...cfg };
    this.karts = new Map(); this.proj = []; this.mines = []; this.ev = [];
    this.itemT = ITEMS.map(() => 0); this.nid = 1; this.t = 0;
    this.state = 'play'; this.over = null; this.left = this.cfg.time; this.overT = 0; this.rosterDirty = true;
  }
  addKart(id, name, isBot) {
    if (this.karts.size >= MAX_KARTS) return null;
    const used = new Set([...this.karts.values()].map((k) => k.ci));
    let ci = 0; while (used.has(ci)) ci++;
    const k = { id, name: String(name || 'Racer').slice(0, 12), isBot, ci, x: 0, z: 0, h: 0, v: 0, hp: 100, weapon: '', ammo: 0, cd: 0, shield: 0, boost: 0, inv: 0,
      kills: 0, deaths: 0, dead: false, rt: 0, s: 0, f: false, fprev: false, stuck: 0, aiT: 0, aiJit: Math.random() * 6, lastHit: '' };
    this.karts.set(id, k); this.spawn(k); this.rosterDirty = true; return k;
  }
  removeKart(id) { if (this.karts.delete(id)) this.rosterDirty = true; }
  setInput(id, s, f) { const k = this.karts.get(id); if (k) { k.s = clamp(+s || 0, -1, 1); k.f = !!f; } }
  spawn(k) {
    let best = SPAWNS[0], bd = -1;
    const order = SPAWNS.map((p) => p).sort(() => Math.random() - 0.5);
    for (const p of order) {
      let d = 1e9;
      for (const o of this.karts.values()) if (o !== k && !o.dead) d = Math.min(d, Math.hypot(o.x - p[0], o.z - p[1]));
      if (d > bd) { bd = d; best = p; }
    }
    k.x = best[0]; k.z = best[1]; k.h = Math.atan2(-best[0], -best[1]); k.v = 0; k.hp = 100; k.dead = false; k.weapon = ''; k.ammo = 0;
    k.shield = 0; k.boost = 0; k.inv = 2;
  }
  reset() {
    this.proj = []; this.mines = []; this.itemT = ITEMS.map(() => 0); this.left = this.cfg.time; this.state = 'play'; this.over = null;
    for (const k of this.karts.values()) { k.kills = 0; k.deaths = 0; this.spawn(k); }
    this.ev.push(['new']);
  }

  damage(k, amt, by) {
    if (k.dead || k.inv > 0 || k.shield > 0 || this.state !== 'play') return;
    k.hp -= amt; k.lastHit = by; this.ev.push(['hit', k.id]);
    if (k.hp <= 0) {
      k.dead = true; k.rt = 3; k.deaths++; k.v = 0; this.ev.push(['boom', k.x, k.z, 4]);
      const a = this.karts.get(by);
      if (a && a !== k) a.kills++;
      else if (a === k) k.kills = Math.max(0, k.kills - 1);
      this.ev.push(['kill', a ? a.id : '', k.id]);
    }
  }
  explode(x, z, r, dmg, owner) {
    this.ev.push(['boom', x, z, r]);
    for (const k of this.karts.values()) {
      if (k.dead) continue;
      const d = Math.hypot(k.x - x, k.z - z);
      if (d < r + R_KART) { this.damage(k, dmg * (1 - 0.6 * Math.min(1, d / (r + R_KART))), owner); k.v += 3; }
    }
  }
  fire(k) {
    const fx = Math.sin(k.h), fz = Math.cos(k.h);
    switch (k.weapon) {
      case 'rocket': this.proj.push({ id: this.nid++, type: 'r', x: k.x + fx * 2, z: k.z + fz * 2, h: k.h, sp: 42, life: 2.2, o: k.id }); k.weapon = ''; break;
      case 'homing': {
        let tg = null, bd = 1e9;
        for (const o of this.karts.values()) if (o !== k && !o.dead) { const d = Math.hypot(o.x - k.x, o.z - k.z), a = Math.abs(wrap(Math.atan2(o.x - k.x, o.z - k.z) - k.h)); if (a < 1.2 && d < bd) { bd = d; tg = o.id; } }
        this.proj.push({ id: this.nid++, type: 'h', x: k.x + fx * 2, z: k.z + fz * 2, h: k.h, sp: 30, life: 3.2, o: k.id, tg }); k.weapon = ''; break;
      }
      case 'triple':
        for (const a of [-0.2, 0, 0.2]) this.proj.push({ id: this.nid++, type: 'r', x: k.x + fx * 2, z: k.z + fz * 2, h: k.h + a, sp: 42, life: 2.2, o: k.id });
        k.weapon = ''; break;
      case 'mine': this.mines.push({ id: this.nid++, x: k.x - fx * 2.2, z: k.z - fz * 2.2, arm: 0.8, life: 45, o: k.id }); k.weapon = ''; break;
      case 'mg':
        if (k.cd <= 0) {
          const j = (Math.random() - 0.5) * 0.06;
          this.proj.push({ id: this.nid++, type: 'b', x: k.x + fx * 1.8, z: k.z + fz * 1.8, h: k.h + j, sp: 60, life: 0.9, o: k.id });
          k.cd = 0.08; if (--k.ammo <= 0) k.weapon = '';
        } break;
      case 'shield': k.shield = 5; k.weapon = ''; break;
      case 'boost': k.boost = 3; k.weapon = ''; break;
    }
  }

  stepBot(k, dt) {
    k.aiT += dt;
    let tgt = null, td = 1e9;
    for (const o of this.karts.values()) if (o !== k && !o.dead) { const d = Math.hypot(o.x - k.x, o.z - k.z); if (d < td) { td = d; tgt = o; } }
    let gx = 0, gz = 0, haveGoal = false;
    if (!k.weapon) {
      let bd = 1e9;
      ITEMS.forEach((p, i) => { if (this.itemT[i] <= 0) { const d = Math.hypot(p[0] - k.x, p[1] - k.z); if (d < bd) { bd = d; gx = p[0]; gz = p[1]; haveGoal = true; } } });
      if (bd > 45) haveGoal = false;
    }
    if (!haveGoal && tgt) { gx = tgt.x; gz = tgt.z; haveGoal = true; }
    let want = haveGoal ? wrap(Math.atan2(gx - k.x, gz - k.z) - k.h) : Math.sin(k.aiT * 0.7 + k.aiJit);
    // avoid walls/blocks: probe ahead
    for (const [dist, side] of [[5, 0], [4, 0.6], [4, -0.6]]) {
      const px = k.x + Math.sin(k.h + side) * dist, pz = k.z + Math.cos(k.h + side) * dist;
      if (Math.abs(px) > HALF - 1 || Math.abs(pz) > HALF - 1 || Math.hypot(px - LAVA.x, pz - LAVA.z) < LAVA.r + 2 || OBST.some((o) => Math.abs(px - o.x) < o.w + 0.8 && Math.abs(pz - o.z) < o.d + 0.8)) { want = side >= 0 ? -1.2 : 1.2; if (side === 0) want = k.aiJit > 3 ? 1.4 : -1.4; break; }
    }
    k.s = clamp(want * 1.6, -1, 1);
    k.f = false;
    if (k.weapon) {
      const ang = tgt ? Math.abs(wrap(Math.atan2(tgt.x - k.x, tgt.z - k.z) - k.h)) : 9;
      if ((k.weapon === 'rocket' || k.weapon === 'triple') && tgt && ang < 0.2 && td < 36) k.f = true;
      else if (k.weapon === 'homing' && tgt && ang < 0.5 && td < 40) k.f = true;
      else if (k.weapon === 'mg' && tgt && ang < 0.2 && td < 30) k.f = true;
      else if (k.weapon === 'mine' && (Math.random() < dt * 0.6)) k.f = true;
      else if ((k.weapon === 'shield' || k.weapon === 'boost') && Math.random() < dt * 1.5) k.f = true;
    }
    k.fprev = false; // bots fire on level, not edge
  }

  step(dt) {
    this.t += dt;
    if (this.state === 'over') { this.overT -= dt; if (this.overT <= 0) this.reset(); }
    else {
      this.left -= dt;
      let top = null;
      for (const k of this.karts.values()) if (!top || k.kills > top.kills) top = k;
      if (top && (top.kills >= this.cfg.target || this.left <= 0)) {
        this.state = 'over'; this.overT = 9;
        this.over = { winner: top.id, rank: [...this.karts.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map((k) => [k.id, k.kills, k.deaths]) };
        this.ev.push(['over']);
      }
    }
    for (let i = 0; i < ITEMS.length; i++) if (this.itemT[i] > 0) this.itemT[i] -= dt;

    for (const k of this.karts.values()) {
      if (k.dead) { k.rt -= dt; if (k.rt <= 0 && this.state === 'play') this.spawn(k); continue; }
      if (k.isBot) this.stepBot(k, dt);
      k.cd -= dt; k.inv -= dt;
      if (k.shield > 0) k.shield -= dt;
      if (k.boost > 0) k.boost -= dt;
      const tv = this.state === 'play' ? (k.boost > 0 ? BOOST : SPEED) : 0;
      k.v += (tv - k.v) * Math.min(1, 2.5 * dt);
      k.h += k.s * STEER * dt * (0.45 + 0.55 * Math.min(1, k.v / SPEED));
      k.x += Math.sin(k.h) * k.v * dt; k.z += Math.cos(k.h) * k.v * dt;
      // walls
      const lim = HALF - R_KART;
      if (Math.abs(k.x) > lim) { k.x = Math.sign(k.x) * lim; k.v *= 0.7; }
      if (Math.abs(k.z) > lim) { k.z = Math.sign(k.z) * lim; k.v *= 0.7; }
      // blocks (circle vs AABB)
      for (const o of OBST) {
        const cx = clamp(k.x, o.x - o.w, o.x + o.w), cz = clamp(k.z, o.z - o.d, o.z + o.d);
        let dx = k.x - cx, dz = k.z - cz, d = Math.hypot(dx, dz);
        if (d < R_KART) {
          if (d < 1e-4) { dx = k.x - o.x; dz = k.z - o.z; d = Math.hypot(dx, dz) || 1; }
          k.x += (dx / d) * (R_KART - d); k.z += (dz / d) * (R_KART - d); k.v *= 0.75;
        }
      }
      // items
      if (!k.weapon) ITEMS.forEach((p, i) => {
        if (this.itemT[i] <= 0 && Math.hypot(p[0] - k.x, p[1] - k.z) < 2.4) {
          this.itemT[i] = 6;
          const r = Math.random();
          k.weapon = r < 0.2 ? 'rocket' : r < 0.32 ? 'mine' : r < 0.5 ? 'mg' : r < 0.6 ? 'shield' : r < 0.68 ? 'boost' : r < 0.84 ? 'homing' : 'triple';
          k.ammo = k.weapon === 'mg' ? 22 : 1;
          this.ev.push(['pick', k.id]);
        }
      });
      // lava pit + speed pads
      if (Math.hypot(k.x - LAVA.x, k.z - LAVA.z) < LAVA.r) { k.lava = (k.lava || 0) + dt; if (k.lava >= 0.2) { k.lava = 0; this.damage(k, 9, k.lastHit || ''); } k.v *= 1 - 0.8 * dt; }
      for (const pd of PADS) if (Math.hypot(k.x - pd[0], k.z - pd[1]) < 3.2) k.boost = Math.max(k.boost, 1.2);
      // fire
      if (k.weapon && this.state === 'play') {
        if (k.weapon === 'mg' ? k.f : (k.f && (k.isBot || !k.fprev))) this.fire(k);
      }
      k.fprev = k.f;
    }
    // kart-kart bumping
    const ks = [...this.karts.values()].filter((k) => !k.dead);
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
      const a = ks[i], b = ks[j], dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d < R_KART * 2 && d > 1e-4) { const p = (R_KART * 2 - d) / 2; a.x -= (dx / d) * p; a.z -= (dz / d) * p; b.x += (dx / d) * p; b.z += (dz / d) * p; a.v *= 0.9; b.v *= 0.9; }
    }
    // projectiles
    for (let i = this.proj.length - 1; i >= 0; i--) {
      const p = this.proj[i];
      const ox = p.x, oz = p.z;
      if (p.type === 'h') {
        const t = p.tg && this.karts.get(p.tg);
        if (t && !t.dead) { const da = wrap(Math.atan2(t.x - p.x, t.z - p.z) - p.h); p.h += clamp(da, -2.6 * dt, 2.6 * dt); }
      }
      p.x += Math.sin(p.h) * p.sp * dt; p.z += Math.cos(p.h) * p.sp * dt; p.life -= dt;
      let hit = p.life <= 0 || Math.abs(p.x) > HALF || Math.abs(p.z) > HALF || OBST.some((o) => Math.abs(p.x - o.x) < o.w && Math.abs(p.z - o.z) < o.d);
      let victim = null;
      if (!hit) for (const k of this.karts.values()) {
        if (k.dead || k.id === p.o) continue;
        // sweep: check midpoint too so fast shots don't tunnel
        const mx = (ox + p.x) / 2, mz = (oz + p.z) / 2;
        if (Math.hypot(k.x - p.x, k.z - p.z) < R_KART + 0.3 || Math.hypot(k.x - mx, k.z - mz) < R_KART + 0.3) { victim = k; hit = true; break; }
      }
      if (!hit) continue;
      this.proj.splice(i, 1);
      if (p.type === 'r' || p.type === 'h') this.explode(p.x, p.z, 5.5, p.type === 'h' ? 40 : 48, p.o);
      else if (victim) this.damage(victim, 8, p.o);
    }
    // mines
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i]; m.arm -= dt; m.life -= dt;
      let boom = m.life <= 0;
      if (m.arm <= 0) for (const k of this.karts.values()) if (!k.dead && Math.hypot(k.x - m.x, k.z - m.z) < 2.2) boom = true;
      if (boom) { this.mines.splice(i, 1); this.explode(m.x, m.z, 5, 60, m.o); }
    }
  }

  roster() { return [...this.karts.values()].map((k) => [k.id, k.name, k.ci, k.isBot ? 1 : 0]); }
  snapshot() {
    const r2 = (n) => Math.round(n * 100) / 100;
    return {
      t: 'snap', st: this.state, left: Math.max(0, Math.round(this.left)), target: this.cfg.target,
      k: [...this.karts.values()].map((k) => [k.id, r2(k.x), r2(k.z), r2(k.h), Math.max(0, Math.round(k.hp)), (k.dead ? 1 : 0) | (k.shield > 0 ? 2 : 0) | (k.boost > 0 ? 4 : 0) | (k.inv > 0 ? 8 : 0), WEAPONS.indexOf(k.weapon), k.kills, k.deaths, k.ammo, Math.ceil(k.rt > 0 ? k.rt : 0)]),
      p: this.proj.map((p) => [p.id, p.type, r2(p.x), r2(p.z), r2(p.h)]),
      m: this.mines.map((m) => [m.id, r2(m.x), r2(m.z), m.arm <= 0 ? 1 : 0]),
      i: this.itemT.map((t) => (t > 0 ? 0 : 1)).join(''),
      ev: this.ev.splice(0), over: this.state === 'over' ? this.over : null,
    };
  }
}

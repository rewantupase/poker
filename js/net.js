// Peer-to-peer networking via WebRTC (PeerJS). The host's browser runs the table;
// no game server is needed, so the whole app deploys as static files on Vercel.
const PREFIX = 'felt-poker-v1-';
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  ...((window.FELT_CONFIG && window.FELT_CONFIG.iceServers) || []),
];
const OPTS = () => {
  const o = { debug: 0, config: { iceServers: ICE } };
  const c = window.FELT_CONFIG || {};
  if (c.peerHost) Object.assign(o, { host: c.peerHost, port: c.peerPort || 443, path: c.peerPath || '/', secure: true });
  return o;
};

export function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const r = crypto.getRandomValues(new Uint32Array(5));
  for (const x of r) s += A[x % A.length];
  return s;
}

export class HostNet {
  constructor(h) {
    this.h = h; // { onReady(code), onMessage(entry, msg), onClose(entry), onError(err) }
    this.entries = new Set();
    this.open(makeCode());
  }
  open(code) {
    this.code = code;
    const peer = (this.peer = new Peer(PREFIX + code, OPTS()));
    peer.on('open', () => this.h.onReady(code));
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') { peer.destroy(); this.open(makeCode()); return; }
      if (e.type === 'peer-unavailable') return;
      this.h.onError(e);
    });
    peer.on('disconnected', () => { if (!this.closed) setTimeout(() => { try { peer.reconnect(); } catch {} }, 1000); });
    peer.on('connection', (conn) => {
      const entry = { conn, pid: null };
      conn.on('open', () => this.entries.add(entry));
      conn.on('data', (d) => { try { this.h.onMessage(entry, d); } catch (err) { console.error(err); } });
      const close = () => { if (this.entries.delete(entry)) this.h.onClose(entry); };
      conn.on('close', close);
      conn.on('error', close);
    });
  }
  send(entry, msg) { try { if (entry.conn.open) entry.conn.send(msg); } catch {} }
  destroy() { this.closed = true; try { this.peer.destroy(); } catch {} }
}

export class ClientNet {
  constructor(code, h) {
    this.h = h; // { onOpen, onMessage, onClose, onError }
    this.opened = false;
    const peer = (this.peer = new Peer(OPTS()));
    this.timer = setTimeout(() => { if (!this.opened) this.fail({ type: 'timeout' }); }, 15000);
    peer.on('open', () => {
      const conn = (this.conn = peer.connect(PREFIX + code.toUpperCase(), { reliable: true, serialization: 'json' }));
      conn.on('open', () => { this.opened = true; clearTimeout(this.timer); h.onOpen(); });
      conn.on('data', (d) => h.onMessage(d));
      conn.on('close', () => { if (!this.closed) h.onClose(); });
      conn.on('error', () => { if (!this.closed) h.onClose(); });
    });
    peer.on('error', (e) => this.fail(e));
  }
  fail(e) {
    if (this.closed) return;
    clearTimeout(this.timer);
    if (this.opened) this.h.onClose(); else this.h.onError(e);
  }
  send(msg) { try { if (this.conn && this.conn.open) this.conn.send(msg); } catch {} }
  destroy() { this.closed = true; clearTimeout(this.timer); try { this.peer.destroy(); } catch {} }
}

// ------------------------------------------------------------------ Wi-Fi (LAN) mode
// Same interface as HostNet / ClientNet, but relayed through lan-server.js on the local
// network instead of WebRTC + internet signaling. No internet connection is needed.
export async function detectLan() {
  if (location.protocol === 'file:') return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('/api/info', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    const j = r.ok ? await r.json() : null;
    return j && j.lan ? j : null;
  } catch { return null; }
}

const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

function hostToken() {
  try {
    let t = localStorage.getItem('felt.lanhost');
    if (!t) { t = makeCode() + makeCode() + makeCode(); localStorage.setItem('felt.lanhost', t); }
    return t;
  } catch { return 'tok' + Math.random().toString(36).slice(2); }
}

export class LanHostNet {
  constructor(h) {
    this.h = h;
    this.entries = new Set();
    this.byCid = new Map();
    this.token = hostToken();
    this.code = makeCode();
    this.ready = false;
    this.connect();
  }
  connect() {
    if (this.closed) return;
    const ws = (this.ws = new WebSocket(wsUrl()));
    ws.onopen = () => ws.send(JSON.stringify({ t: 'host', code: this.code, token: this.token }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'hosted') {
        this.retries = 0;
        for (const cid of m.cids || []) this.add(cid);
        if (!this.ready) { this.ready = true; this.h.onReady(this.code); }
        if (this.meta) this.setMeta(this.meta);
      } else if (m.t === 'error') {
        if (m.e === 'taken' && !this.ready) { this.code = makeCode(); ws.onclose = null; ws.close(); this.connect(); }
        else this.h.onError({ type: m.e });
      } else if (m.t === 'peer') {
        if (m.ev === 'open') this.add(m.cid);
        else this.drop(m.cid);
      } else if (m.t === 'data') {
        const e = this.byCid.get(m.cid);
        if (e) { try { this.h.onMessage(e, m.d); } catch (err) { console.error(err); } }
      }
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.retries = (this.retries || 0) + 1;
      if (this.retries > 40) { this.h.onError({ type: 'server-lost' }); return; }
      setTimeout(() => this.connect(), Math.min(500 * this.retries, 3000));
    };
  }
  add(cid) {
    if (this.byCid.has(cid)) return;
    const entry = { cid, pid: null, conn: { open: true, close: () => this.raw({ t: 'kick', cid }) } };
    this.byCid.set(cid, entry); this.entries.add(entry);
  }
  drop(cid) {
    const e = this.byCid.get(cid);
    if (!e) return;
    this.byCid.delete(cid);
    if (this.entries.delete(e)) this.h.onClose(e);
  }
  raw(o) { try { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); } catch {} }
  send(entry, msg) { this.raw({ t: 'data', cid: entry.cid, d: msg }); }
  setMeta(meta) { this.meta = meta; this.raw({ t: 'meta', meta }); }
  destroy() { this.closed = true; this.raw({ t: 'close' }); try { this.ws.close(); } catch {} }
}

export class LanClientNet {
  constructor(code, h) {
    this.h = h;
    this.opened = false;
    this.conn = { open: false };
    this.timer = setTimeout(() => { if (!this.opened) this.fail({ type: 'timeout' }); }, 8000);
    const ws = (this.ws = new WebSocket(wsUrl()));
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', code: code.toUpperCase() }));
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'joined') { this.opened = true; this.conn.open = true; clearTimeout(this.timer); h.onOpen(); }
      else if (m.t === 'data') h.onMessage(m.d);
      else if (m.t === 'hostback') { if (this.opened) h.onOpen(); }
      else if (m.t === 'hostgone') { this.gone = true; }
      else if (m.t === 'error') this.fail({ type: m.e === 'no-room' ? 'peer-unavailable' : m.e });
    };
    ws.onclose = () => { this.conn.open = false; if (this.closed) return; if (this.opened) h.onClose(); else this.fail({ type: 'network' }); };
    ws.onerror = () => {};
  }
  fail(e) {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.closed = true;
    try { this.ws.close(); } catch {}
    if (this.opened) this.h.onClose(); else this.h.onError(e);
  }
  send(msg) { try { if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'data', d: msg })); } catch {} }
  destroy() { this.closed = true; clearTimeout(this.timer); try { this.ws.close(); } catch {} }
}

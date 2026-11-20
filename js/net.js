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

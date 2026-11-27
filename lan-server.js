#!/usr/bin/env node
/*
 * Felt — Wi-Fi mode server (no internet needed, no packages to install).
 *
 *   node lan-server.js          (or: npm start)
 *
 * Serves the game over HTTP to every device on the same Wi-Fi and relays game
 * messages between the host's browser and the other players over WebSocket.
 * The game itself still runs in the host's browser, exactly like online mode.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const WANT_PORT = Number(process.env.PORT || process.argv[2]) || 3000;
const MAX_MSG = 64 * 1024;
const GRACE_MS = 30000; // how long a table survives if its host drops for a moment

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
// only the game's own files are ever served
const ALLOW = ['index.html', 'config.js', 'manifest.webmanifest', 'sw.js', 'css/', 'js/', 'vendor/', 'fonts/', 'icons/'];

let PORT = WANT_PORT;

// ---------------------------------------------------------------- network info
function lanIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push({ name, ip: i.address });
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a.ip) - rank(b.ip));
}

// ---------------------------------------------------------------- minimal WebSocket (RFC 6455)
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const sockets = new Set();

class WS {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.open = true; this.alive = true; this.frag = null;
    this.onmessage = () => {}; this.onclose = () => {};
    this.role = null; this.room = null; this.cid = 0; this.rate = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    sockets.add(this);
  }
  onData(d) {
    this.alive = true;
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_MSG * 4) return this.close(1009);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2)) return this.close(1009); len = b.readUInt32BE(6); off = 10; }
      if (len > MAX_MSG) return this.close(1009);
      if (!masked) return this.close(1002);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const data = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) { this.frame(0xa, data); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        if (op === 0x1) this.frag = [];
        if (!this.frag) continue;
        this.frag.push(data);
        if (fin) { const txt = Buffer.concat(this.frag).toString('utf8'); this.frag = null; this.onmessage(txt); }
      }
    }
  }
  frame(op, p) {
    if (!this.open) return;
    let h;
    if (p.length < 126) h = Buffer.from([0x80 | op, p.length]);
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(p.length, 6); }
    try { this.socket.write(Buffer.concat([h, p])); } catch { /* socket gone */ }
  }
  send(obj) { this.frame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this.frame(0x8, p);
    try { this.socket.end(); } catch { /* ignore */ }
    this.finish();
  }
  finish() {
    if (!this.open) return;
    this.open = false; sockets.delete(this);
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.onclose();
  }
}

// keep-alive: drop sockets that stop answering pings (phone walked out of range, etc.)
setInterval(() => {
  for (const ws of [...sockets]) {
    if (!ws.alive) { ws.finish(); continue; }
    ws.alive = false; ws.frame(0x9, Buffer.alloc(0));
  }
}, 20000).unref();
setInterval(() => { for (const ws of sockets) ws.rate = 0; }, 1000).unref();

// ---------------------------------------------------------------- tables (rooms)
const rooms = new Map(); // code -> { code, token, host, clients: Map(cid -> ws), meta, timer }
let nextCid = 1;
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
const err = (e) => ({ t: 'error', e });

function destroyRoom(room, notify = true) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
  for (const c of room.clients.values()) { if (notify) c.send({ t: 'hostgone' }); c.room = null; c.close(4002); }
  room.clients.clear();
  if (room.host) { const h = room.host; room.host = null; h.room = null; h.close(); }
}

function onHost(ws, m) {
  if (ws.role) return;
  const code = normCode(m.code), token = String(m.token || '').slice(0, 64);
  if (code.length !== 5 || !token) return ws.send(err('bad-code'));
  let room = rooms.get(code);
  if (room) {
    if (room.token !== token) return ws.send(err('taken'));
    clearTimeout(room.timer);
    const old = room.host;
    room.host = ws; ws.role = 'host'; ws.room = room;
    if (old && old !== ws) { old.room = null; old.close(4001); }
    ws.send({ t: 'hosted', code, resumed: true, cids: [...room.clients.keys()] });
    for (const c of room.clients.values()) c.send({ t: 'hostback' });
  } else {
    if (rooms.size >= 30) return ws.send(err('full'));
    room = { code, token, host: ws, clients: new Map(), meta: {}, timer: null };
    rooms.set(code, room); ws.role = 'host'; ws.room = room;
    ws.send({ t: 'hosted', code, resumed: false, cids: [] });
  }
}

function onJoin(ws, m) {
  if (ws.role) return;
  const room = rooms.get(normCode(m.code));
  if (!room || !room.host) { ws.send(err('no-room')); return ws.close(4003); }
  if (room.clients.size >= 40) { ws.send(err('full')); return ws.close(4004); }
  ws.role = 'client'; ws.room = room; ws.cid = nextCid++;
  room.clients.set(ws.cid, ws);
  ws.send({ t: 'joined' });
  room.host.send({ t: 'peer', cid: ws.cid, ev: 'open' });
}

function cleanMeta(x) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  const n = (v) => Math.max(0, Math.min(99, Number(v) | 0));
  return { title: s(x && x.title, 40), seated: n(x && x.seated), max: n(x && x.max), bots: n(x && x.bots), blinds: s(x && x.blinds, 14), running: !!(x && x.running) };
}

function handle(ws) {
  ws.onmessage = (txt) => {
    if (++ws.rate > 300) return ws.close(1008); // flood guard
    let m;
    try { m = JSON.parse(txt); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const room = ws.room;
    switch (m.t) {
      case 'host': onHost(ws, m); break;
      case 'join': onJoin(ws, m); break;
      case 'data':
        if (ws.role === 'client' && room && room.host) room.host.send({ t: 'data', cid: ws.cid, d: m.d });
        else if (ws.role === 'host' && room) { const c = room.clients.get(Number(m.cid)); if (c) c.send({ t: 'data', d: m.d }); }
        break;
      case 'kick':
        if (ws.role === 'host' && room) { const c = room.clients.get(Number(m.cid)); if (c) c.close(4005); }
        break;
      case 'meta': if (ws.role === 'host' && room) room.meta = cleanMeta(m.meta); break;
      case 'close': if (ws.role === 'host' && room) destroyRoom(room); break;
    }
  };
  ws.onclose = () => {
    const room = ws.room;
    if (!room) return;
    if (ws.role === 'client') {
      room.clients.delete(ws.cid);
      if (room.host) room.host.send({ t: 'peer', cid: ws.cid, ev: 'close' });
    } else if (ws.role === 'host' && room.host === ws) {
      room.host = null;
      for (const c of room.clients.values()) c.send({ t: 'hostlost' });
      room.timer = setTimeout(() => destroyRoom(room), GRACE_MS);
    }
  };
}

// ---------------------------------------------------------------- HTTP
function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serve(req, res) {
  let u;
  try { u = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (u === '/api/info') return json(res, { lan: true, port: PORT, ips: lanIPs(), host: os.hostname() });
  if (u === '/api/rooms') {
    return json(res, [...rooms.values()].filter((r) => r.host).map((r) => ({ code: r.code, ...r.meta })));
  }
  if (u === '/') u = '/index.html';
  const rel = u.replace(/^\/+/, '');
  const ok = !rel.includes('..') && !rel.includes('\\') && ALLOW.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));
  const file = path.join(ROOT, rel);
  if (!ok || !file.startsWith(ROOT + path.sep)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(serve);
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  handle(new WS(socket));
});

function banner() {
  const ips = lanIPs();
  const line = '─'.repeat(54);
  console.log('\n' + line + '\n  Felt — Wi-Fi mode (works with no internet)\n' + line);
  console.log(`\n  On this computer:        http://localhost:${PORT}`);
  if (ips.length) {
    console.log('  Friends on the same Wi-Fi open:');
    for (const i of ips) console.log(`     http://${i.ip}:${PORT}   (${i.name})`);
  } else {
    console.log('\n  No Wi-Fi/LAN address found. Connect this computer to the Wi-Fi,');
    console.log('  or turn on a phone/laptop hotspot and join it (no data needed).');
  }
  console.log('\n  Tip: open the game on THIS computer, tap "Host a Table", then');
  console.log('  friends scan the QR code or pick your table from the list.');
  console.log('  Press Ctrl+C to stop.\n');
}

let tries = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && tries++ < 10) { PORT++; server.listen(PORT, '0.0.0.0'); return; }
  console.error('Could not start the server:', e.message);
  process.exit(1);
});
server.listen(PORT, '0.0.0.0', banner);

process.on('SIGINT', () => { console.log('\nStopped.'); process.exit(0); });

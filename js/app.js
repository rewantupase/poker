import { Table } from './engine.js';
import { evaluate, describeHole, rankOf, suitOf, RANK_CH, SUIT_CH, isRed, CATEGORY } from './cards.js';
import { analyze, findOuts } from './odds.js';
import { HostNet, ClientNet, LanHostNet, LanClientNet, detectLan } from './net.js';
import { sfx, unlockAudio, isSoundOn, setSound } from './sound.js';

// ---------------------------------------------------------------- utils
const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => {
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, '') + 'M';
  if (n >= 1e5) return Math.round(n / 1e3) + 'K';
  return n.toLocaleString('en-US');
};
const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const initials = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const BOT_NAMES = ['Ava', 'Leo', 'Maya', 'Kai', 'Zoe', 'Ravi', 'Nora', 'Hugo', 'Ivy', 'Omar', 'Luna', 'Theo'];

function getToken() {
  let t = localStorage.getItem('felt.token');
  if (!t) { t = 'p-' + crypto.getRandomValues(new Uint32Array(4)).join('-'); localStorage.setItem('felt.token', t); }
  return t;
}

const S = {
  mode: null, // 'bots' | 'host' | 'client'
  myId: getToken(),
  table: null, host: null, client: null, code: null,
  view: null, offset: 0, lastEvent: -1, seen: new Set(), seenHand: -1,
  raiseOpen: false, raiseTo: 0, pre: null, sentTurn: -1,
  unread: 0, lastLogLen: 0, reconnects: 0, leaving: false, wake: null, sheet: null,
  odds: null, showOdds: localStorage.getItem('felt.odds') !== '0', prevBets: {}, prevHand: -1, paidHand: -1,
};

// ---------------------------------------------------------------- cards
function cardHTML(c, cls = '', at = '') {
  if (c == null) return `<div class="card back ${cls}" ${at}></div>`;
  const r = RANK_CH[rankOf(c)], s = SUIT_CH[suitOf(c)];
  return `<div class="card ${isRed(c) ? 'red' : ''} ${cls}" ${at} data-c="${c}"><span class="cr">${r}</span><span class="cs">${s}</span><span class="cc">${s}</span></div>`;
}
// marks an element to be animated once (dealt from the deck, or flipped face-up)
function fx(key, kind, ord) {
  if (S.seen.has(key)) return { cls: '', at: '' };
  S.seen.add(key);
  return { cls: 'fx', at: `data-kind="${kind}" data-ord="${ord}"` };
}

// ---------------------------------------------------------------- toast & alert
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function alertBox(title, msg, buttons) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'alert-wrap';
    el.innerHTML = `<div class="alert"><div class="alert-body"><h3>${esc(title)}</h3>${msg ? `<p>${esc(msg)}</p>` : ''}</div>
      <div class="alert-btns ${buttons.length > 2 ? 'stack' : ''}">${buttons.map((b, i) => `<button data-i="${i}" class="${b.style || ''}">${esc(b.text)}</button>`).join('')}</div></div>`;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      el.classList.remove('show');
      setTimeout(() => el.remove(), 200);
      resolve(buttons[+b.dataset.i].value);
    });
  });
}

// ---------------------------------------------------------------- screens & sheets
function show(id) { $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id)); }
function openSheet(id) {
  closeSheets(true);
  S.sheet = id;
  $('#scrim').classList.add('show');
  $('#' + id).classList.add('show');
  if (id === 'sheet-log') { S.unread = 0; renderBadge(); renderLog(); setTimeout(() => { const l = $('#log-list'); l.scrollTop = l.scrollHeight; }, 50); }
  if (id === 'sheet-menu') renderMenu();
  if (id === 'sheet-odds') renderOdds();
  if (id === 'sheet-join') pollRooms();
}
function closeSheets(silent) {
  S.sheet = null;
  $$('.sheet.show').forEach((s) => s.classList.remove('show'));
  if (!silent) $('#scrim').classList.remove('show');
  else $('#scrim').classList.remove('show');
  document.activeElement?.blur?.();
}
$('#scrim').addEventListener('click', () => closeSheets());
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheets(); });

// swipe-down to dismiss sheets
$$('.sheet').forEach((sheet) => {
  let y0 = null, dy = 0;
  const grab = sheet.querySelector('.grabber');
  const nav = sheet.querySelector('.nav');
  const start = (e) => { y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none'; };
  const move = (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transform = `translateY(${dy}px)`; };
  const end = () => { if (y0 == null) return; sheet.style.transition = ''; sheet.style.transform = ''; if (dy > 90) closeSheets(); y0 = null; };
  [grab, nav].forEach((el) => { el.addEventListener('touchstart', start, { passive: true }); el.addEventListener('touchmove', move, { passive: true }); el.addEventListener('touchend', end); });
});

// ---------------------------------------------------------------- home
const nameInput = $('#name-input');
nameInput.value = localStorage.getItem('felt.name') || '';
nameInput.addEventListener('input', () => localStorage.setItem('felt.name', nameInput.value.trim()));
const myName = () => nameInput.value.trim() || 'Player';

document.addEventListener('pointerdown', unlockAudio, { passive: true });

$('#home').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (!b) return;
  const go = b.dataset.go;
  if ((go === 'bots' || go === 'host' || go === 'join') && !nameInput.value.trim()) {
    nameInput.focus(); toast('Enter your name first'); return;
  }
  if (go === 'bots' || go === 'host') openSetup(go);
  if (go === 'join') { openSheet('sheet-join'); setTimeout(() => $('#join-code').focus(), 300); }
  if (go === 'rankings') { renderRankings(); openSheet('sheet-rankings'); }
});

// ---------------------------------------------------------------- setup sheet
const setup = { maxSeats: 6, bots: 5, blinds: '10/20', startStack: 2000, turnTime: 25, blindUp: 0, rebuy: true, mode: 'bots', maxHands: 0, odds: true };
function syncSetup() {
  const minBots = setup.mode === 'bots' ? 1 : 0;
  setup.bots = Math.max(minBots, Math.min(setup.bots, setup.maxSeats - 1));
  $$('#sheet-setup .stepper').forEach((st) => {
    const f = st.dataset.field;
    $('output', st).textContent = setup[f];
    const [minus, plus] = $$('button', st);
    const min = f === 'bots' ? minBots : +st.dataset.min;
    const max = f === 'bots' ? setup.maxSeats - 1 : +st.dataset.max;
    minus.disabled = setup[f] <= min; plus.disabled = setup[f] >= max;
  });
  $('#setup-note').textContent = setup.mode === 'host'
    ? `You'll get a table code to share. Up to ${setup.maxSeats - setup.bots} friends can join${setup.bots ? `, plus ${setup.bots} bot${setup.bots > 1 ? 's' : ''}` : ''}. Keep this app open while hosting.`
    : `You vs ${setup.bots} bot${setup.bots > 1 ? 's' : ''}. Bots play with different styles.`;
}
function openSetup(mode) {
  setup.mode = mode;
  setup.bots = mode === 'bots' ? setup.maxSeats - 1 : 0;
  $('#setup-title').textContent = mode === 'bots' ? 'Play vs Bots' : 'Host a Table';
  $('#setup-start').textContent = mode === 'bots' ? 'Deal' : 'Create';
  syncSetup();
  openSheet('sheet-setup');
}
$('#sheet-setup').addEventListener('click', (e) => {
  const sb = e.target.closest('.stepper button');
  if (sb) {
    const st = sb.parentElement, f = st.dataset.field;
    const d = sb === st.firstElementChild ? -1 : 1;
    setup[f] += d;
    if (f === 'maxSeats') setup.maxSeats = Math.max(2, Math.min(10, setup.maxSeats));
    if (f === 'maxSeats' && setup.mode === 'bots') setup.bots = setup.maxSeats - 1;
    sfx.tap(); syncSetup(); return;
  }
  const seg = e.target.closest('.segmented button');
  if (seg) {
    $$('button', seg.parentElement).forEach((b) => b.classList.toggle('on', b === seg));
    setup[seg.parentElement.dataset.field] = +seg.dataset.v;
    sfx.tap();
  }
});
$('#sheet-setup').addEventListener('change', (e) => {
  const f = e.target.dataset.field;
  if (f === 'rebuy') setup.rebuy = e.target.checked;
  else if (f === 'odds') setup.odds = e.target.checked;
  else if (f === 'blinds') setup.blinds = e.target.value;
  else if (f === 'startStack') setup.startStack = +e.target.value;
});
$('#setup-start').addEventListener('click', () => {
  const [sb, bb] = setup.blinds.split('/').map(Number);
  const cfg = { maxSeats: setup.maxSeats, sb, bb, startStack: setup.startStack, turnTime: setup.turnTime, rebuy: setup.rebuy, blindUp: setup.blindUp, maxHands: setup.maxHands, odds: setup.odds };
  closeSheets();
  startLocal(cfg, setup.mode === 'host', setup.bots);
});

// ---------------------------------------------------------------- local / host
function addBot(t) {
  const used = new Set(t.seats.filter(Boolean).map((p) => p.name));
  const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot';
  return t.addPlayer({ id: 'bot-' + Math.random().toString(36).slice(2, 8), name, isBot: true });
}

let flushQueued = false;
function onTableChange() {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const t = S.table;
    if (!t) return;
    applyView(t.viewFor(S.myId));
    if (S.host) for (const e of S.host.entries) S.host.send(e, { t: 'state', v: t.viewFor(e.pid) });
    pushMeta();
  });
}

function startLocal(cfg, online, bots) {
  resetClientState();
  S.mode = online ? 'host' : 'bots';
  const t = (S.table = new Table(cfg, { onChange: onTableChange }));
  t.addPlayer({ id: S.myId, name: myName() }, 0);
  for (let k = 0; k < bots; k++) addBot(t);
  show('game');
  requestWake();
  fitTable();
  if (online) {
    if (!S.lan && !window.Peer) { toast('Network library failed to load'); return; }
    overlay('Creating table…', () => leaveTable(true));
    S.host = new (S.lan ? LanHostNet : HostNet)({
      onReady: (code) => {
        S.code = code; overlay(null);
        history.replaceState(null, '', '?t=' + code);
        onTableChange();
        shareInvite(true);
      },
      onMessage: hostMessage,
      onClose: (entry) => { if (entry.pid && ![...S.host.entries].some((e) => e.pid === entry.pid)) t.setConnected(entry.pid, false); },
      onError: (err) => { overlay(null); toast('Network: ' + (err.type || err.message || 'error')); },
    });
  } else {
    t.start();
  }
  onTableChange();
}

function hostMessage(entry, msg) {
  const t = S.table;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'join': {
      const pid = String(msg.token || '').slice(0, 64);
      if (!pid || pid === S.myId) return;
      for (const e of S.host.entries) if (e !== entry && e.pid === pid) { S.host.send(e, { t: 'replaced' }); try { e.conn.close(); } catch {} }
      entry.pid = pid;
      if (t.findSeat(pid) >= 0) t.setConnected(pid, true);
      else if (t.addPlayer({ id: pid, name: String(msg.name || 'Player') }) < 0) S.host.send(entry, { t: 'info', msg: 'Table is full — you are spectating' });
      S.host.send(entry, { t: 'state', v: t.viewFor(pid) });
      break;
    }
    case 'act': if (entry.pid) t.act(entry.pid, msg.a, msg.amt); break;
    case 'chat': if (entry.pid) t.addChat(entry.pid, msg.text); break;
    case 'rebuy': if (entry.pid) t.rebuy(entry.pid); break;
    case 'sit': if (entry.pid) t.sitOut(entry.pid, !!msg.out); break;
    case 'leave': if (entry.pid) { t.removePlayer(entry.pid); entry.pid = null; } break;
  }
}

// ---------------------------------------------------------------- client
function joinTable(code) {
  code = code.trim().toUpperCase();
  if (code.length !== 5) { toast('Codes are 5 characters'); return; }
  if (!S.lan && !window.Peer) { toast('Network library failed to load'); return; }
  closeSheets();
  resetClientState();
  S.mode = 'client'; S.code = code; S.reconnects = 0;
  overlay('Joining ' + code + '…', () => leaveTable(true));
  connectClient(true);
}
function connectClient(first) {
  if (S.client) S.client.destroy();
  S.client = new (S.lan ? LanClientNet : ClientNet)(S.code, {
    onOpen: () => {
      S.reconnects = 0;
      S.client.send({ t: 'join', name: myName(), token: S.myId });
      overlay(null);
      if (first) { show('game'); requestWake(); fitTable(); history.replaceState(null, '', '?t=' + S.code); }
    },
    onMessage: (m) => {
      if (m.t === 'state') applyView(m.v);
      else if (m.t === 'info') toast(m.msg);
      else if (m.t === 'replaced') { S.leaving = true; toast('Opened on another device'); leaveTable(true); }
    },
    onClose: () => reconnectSoon(),
    onError: (e) => {
      if (first && !S.view) {
        overlay(null);
        alertBox('Table not found', e.type === 'peer-unavailable' || e.type === 'timeout' ? `No table is open with code ${S.code}. Check the code and make sure the host still has the app open.` : 'Could not connect: ' + (e.type || 'network error'), [{ text: 'OK', value: 1, style: 'strong' }]);
        leaveTable(true);
      } else reconnectSoon();
    },
  });
}
function reconnectSoon() {
  if (S.leaving || S.mode !== 'client') return;
  S.reconnects++;
  if (S.reconnects > 8) {
    overlay(null);
    alertBox('Disconnected', 'Lost connection to the host. The table may have closed.', [{ text: 'OK', value: 1, style: 'strong' }]);
    leaveTable(true);
    return;
  }
  overlay('Reconnecting…', () => leaveTable(true));
  setTimeout(() => { if (!S.leaving && S.mode === 'client') connectClient(false); }, Math.min(1000 * S.reconnects, 4000));
}
let roomTimer = 0;
async function pollRooms() {
  clearTimeout(roomTimer);
  const box = $('#lan-rooms');
  if (!S.lan || !$('#sheet-join').classList.contains('show')) return;
  try {
    const rooms = await (await fetch('/api/rooms', { cache: 'no-store' })).json();
    box.hidden = false;
    $('#lan-rooms-list').innerHTML = rooms.length ? rooms.map((r) => `<button class="row btn-row" data-room="${esc(r.code)}"><span class="row-label">${esc(r.title || 'Table')}<small>${esc(r.code)} · ${r.seated}/${r.max} seated${r.bots ? ` · ${r.bots} bots` : ''} · ${esc(r.blinds || '')}</small></span><span class="row-chev">Join</span></button>`).join('') : '<div class="row"><span class="row-label muted">No tables yet — ask a friend to host</span></div>';
  } catch {}
  roomTimer = setTimeout(pollRooms, 2000);
}
$('#lan-rooms-list').addEventListener('click', (e) => { const b = e.target.closest('[data-room]'); if (b) joinTable(b.dataset.room); });
$('#join-go').addEventListener('click', () => joinTable($('#join-code').value));
$('#join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinTable(e.target.value); });
$('#join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

// ---------------------------------------------------------------- unified API
const api = {
  act(a, amt) {
    if (!S.view || S.view.turnId === S.sentTurn) return;
    S.sentTurn = S.view.turnId;
    S.raiseOpen = false;
    if (S.client) S.client.send({ t: 'act', a, amt });
    else S.table.act(S.myId, a, amt);
  },
  chat(text) { if (S.client) S.client.send({ t: 'chat', text }); else S.table.addChat(S.myId, text); },
  rebuy() { if (S.client) S.client.send({ t: 'rebuy' }); else S.table.rebuy(S.myId); },
  sit(out) { if (S.client) S.client.send({ t: 'sit', out }); else S.table.sitOut(S.myId, out); },
  seat() { if (S.client) S.client.send({ t: 'join', name: myName(), token: S.myId }); else S.table.addPlayer({ id: S.myId, name: myName() }); },
};

function resetClientState() {
  Object.assign(S, { view: null, lastEvent: -1, seen: new Set(), seenHand: -1, raiseOpen: false, pre: null, sentTurn: -1, unread: 0, lastLogLen: 0, leaving: false, code: null });
}

async function leaveTable(force) {
  if (!force) {
    const hosting = S.mode === 'host';
    const ok = await alertBox(hosting ? 'End table?' : 'Leave table?', hosting ? 'This closes the table for everyone.' : 'Your seat will be given up.', [
      { text: 'Cancel', value: false }, { text: hosting ? 'End Table' : 'Leave', value: true, style: 'destructive' }]);
    if (!ok) return;
  }
  S.leaving = true;
  closeSheets();
  if (S.client) { S.client.send({ t: 'leave' }); const c = S.client; setTimeout(() => c.destroy(), 300); S.client = null; }
  if (S.host) { S.host.destroy(); S.host = null; }
  if (S.table) { S.table.running = false; S.table.onChange = () => {}; S.table.schedule = () => {}; S.table = null; }
  S.mode = null;
  overlay(null);
  releaseWake();
  history.replaceState(null, '', location.pathname);
  show('home');
}

function overlay(text, onCancel) {
  const o = $('#overlay');
  if (!text) { o.hidden = true; return; }
  $('#overlay-text').textContent = text;
  o.hidden = false;
  $('#overlay-cancel').onclick = () => { o.hidden = true; onCancel && onCancel(); };
}

function inviteUrl() {
  if (S.lan) {
    const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    const ip = S.lan.ips && S.lan.ips[0];
    const base = local && ip ? `http://${ip.ip}:${location.port || S.lan.port}` : location.origin;
    return `${base}/?t=${S.code}`;
  }
  return `${location.origin}/?t=${S.code}`;
}
function showInvite() {
  const url = inviteUrl();
  $('#inv-code').textContent = S.code;
  $('#inv-url').textContent = url.replace('http://', '');
  let svg = '';
  try { const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make(); svg = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch {}
  $('#inv-qr').innerHTML = svg;
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  $('#inv-note').textContent = local && !(S.lan.ips && S.lan.ips.length)
    ? 'No Wi-Fi address found. Connect this computer to the Wi-Fi (or a hotspot) and restart.'
    : 'Friends on the same Wi-Fi can scan this, or open the address in a browser. No internet needed.';
  openSheet('sheet-invite');
}
$('#inv-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(inviteUrl()); toast('Link copied'); } catch { toast('Copy not available here'); } });
let lastMeta = '';
function pushMeta() {
  const t = S.table;
  if (!S.lan || !S.host || !S.host.setMeta || !t) return;
  const v = t.viewFor(S.myId);
  const meta = { title: myName() + "'s table", seated: v.seats.filter(Boolean).length, max: v.config.maxSeats, bots: v.seats.filter((x) => x && x.isBot).length, blinds: `${fmt(v.config.sb)}/${fmt(v.config.bb)}`, running: !!v.handNo };
  const k = JSON.stringify(meta);
  if (k !== lastMeta) { lastMeta = k; S.host.setMeta(meta); }
}

async function shareInvite(auto) {
  if (!S.code) return;
  if (S.lan) { if (auto) showInvite(); else showInvite(); return; }
  const url = `${location.origin}/?t=${S.code}`;
  if (auto) { toast(`Table ${S.code} is open — share the code`); return; }
  try {
    if (navigator.share) await navigator.share({ title: 'Join my poker table', text: `Join my Felt poker table. Code: ${S.code}`, url });
    else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  } catch {}
}
$('#room-pill').addEventListener('click', () => shareInvite(false));

// ---------------------------------------------------------------- view handling
function applyView(v) {
  const prev = S.view;
  S.view = v;
  S.offset = v.now - Date.now();
  if (v.handNo !== S.seenHand) { S.seenHand = v.handNo; S.seen = new Set(); S.pre = null; S.raiseOpen = false; }
  if (!prev || prev.turnId !== v.turnId) S.sentTurn = -1;
  if (!v.legal) S.raiseOpen = false;
  playEvents(v);
  trackLog(v);
  // pre-actions
  if (v.legal && S.pre && S.sentTurn !== v.turnId) {
    const l = v.legal, pre = S.pre;
    S.pre = null;
    if (pre === 'checkfold') return api.act(l.canCheck ? 'check' : 'fold');
    if (pre === 'check' && l.canCheck) return api.act('check');
    if (pre === 'callany') return api.act(l.canCheck ? 'check' : 'call');
  }
  if (v.legal && (!prev || prev.turnId !== v.turnId)) navigator.vibrate?.(25);
  render();
}

function playEvents(v) {
  const evs = v.events || [];
  const max = evs.length ? evs[evs.length - 1].id : 0;
  if (S.lastEvent < 0) { S.lastEvent = max; return; }
  for (const e of evs) {
    if (e.id <= S.lastEvent) continue;
    if (e.type === 'chips') sfx.chip();
    else if (e.type === 'check') sfx.check();
    else if (e.type === 'fold') sfx.fold();
    else if (e.type === 'win') sfx.win();
    else if (e.type === 'turn' && e.seat === v.you) sfx.turn();
  }
  S.lastEvent = max;
}

function trackLog(v) {
  const n = v.log.length ? v.log[v.log.length - 1].t : 0;
  const newChats = v.log.filter((l) => l.chat && l.t > S.lastLogLen).length;
  if (S.lastLogLen && newChats && S.sheet !== 'sheet-log') { S.unread += newChats; renderBadge(); const last = v.log.filter((l) => l.chat).pop(); toast(`${last.name}: ${last.text}`); }
  S.lastLogLen = Math.max(S.lastLogLen, n);
  if (S.sheet === 'sheet-log') renderLog();
}
function renderBadge() { const b = $('#chat-badge'); b.hidden = !S.unread; b.textContent = S.unread > 9 ? '9+' : S.unread; }

// ---------------------------------------------------------------- table geometry
let geo = { w: 0, h: 0, landscape: true };
function fitTable() {
  const wrap = $('#table-wrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const landscape = W / H > 1.05;
  const aspect = landscape ? 1.85 : 0.68;
  // leave room for seats that sit on/over the rail
  const padT = landscape ? Math.min(78, H * 0.13) : Math.min(64, H * 0.08);
  const padB = landscape ? Math.min(48, H * 0.08) : Math.min(44, H * 0.06);
  const padX = landscape ? Math.min(70, W * 0.05) : 6;
  const W2 = W - 2 * padX, H2 = H - padT - padB;
  let w = W2, h = W2 / aspect;
  if (h > H2) { h = H2; w = H2 * aspect; }
  const t = $('#table');
  t.style.width = w + 'px'; t.style.height = h + 'px';
  t.style.marginTop = (padT - padB) + 'px';
  t.classList.toggle('portrait', !landscape);
  const base = Math.min(w, h * (landscape ? 1.85 : 1.25));
  t.style.setProperty('--u', (base / 100).toFixed(2) + 'px');
  geo = { w, h, landscape };
  if (S.view) render();
}
window.addEventListener('resize', fitTable);
new ResizeObserver(fitTable).observe($('#table-wrap'));

function seatPos(rel, n) {
  const a = (Math.PI / 2) + (rel * 2 * Math.PI) / n;
  return { cos: Math.cos(a), sin: Math.sin(a) };
}

// ---------------------------------------------------------------- chips on the felt
const CHIP_MULT = [1, 5, 25, 100, 500];
const chipLabel = (d) => (d >= 1000 && d % 1000 === 0 ? d / 1000 + 'K' : String(d));
function tablePile(amount, cfg, cols = 3, maxK = CHIP_MULT.length - 1) {
  if (amount <= 0) return '';
  let rem = amount;
  const out = [];
  for (let k = maxK; k >= 0; k--) {
    const d = cfg.bb * CHIP_MULT[k];
    const n = Math.floor(rem / d);
    if (n > 0) { out.push({ k, n }); rem -= n * d; }
  }
  if (!out.length) out.push({ k: 0, n: 1 });
  return `<span class="pile">${out.slice(0, cols).map((c) => {
    const n = Math.min(c.n, 7);
    return `<span class="col" style="--h:${n - 1}">${Array.from({ length: n }, (_, i) => `<i class="chip c${c.k + 1}" style="--i:${i}">${i === n - 1 ? `<b>${chipLabel(cfg.bb * CHIP_MULT[c.k])}</b>` : ''}</i>`).join('')}</span>`;
  }).join('')}</span>`;
}
const rectCenter = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
function flyChips(from, to, n, k = 1, delay = 0) {
  if (reduceMotion || !from || !to) return;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('i');
    el.className = 'chip fly c' + k;
    el.style.left = from.x - 11 + 'px'; el.style.top = from.y - 11 + 'px';
    document.body.appendChild(el);
    const dx = to.x - from.x, dy = to.y - from.y;
    const jx = (Math.random() - 0.5) * 16, jy = (Math.random() - 0.5) * 10;
    const a = el.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.5 + jx}px, ${dy * 0.5 - 24 + jy}px) scale(1.2)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx + jx}px, ${dy + jy}px) scale(.85)`, opacity: 0.95 },
    ], { duration: 520, delay: delay + i * 55, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'backwards' });
    a.onfinish = () => el.remove();
  }
  setTimeout(() => sfx.chip(), delay + 380);
}

// ---------------------------------------------------------------- render
let dealCtx = { idx: {}, m: 1 };

function render() {
  const v = S.view;
  if (!v) return;
  const n = v.seats.length;
  const cfg = v.config;
  const you = v.you >= 0 ? v.you : 0;
  const winners = new Set();
  if (v.results) v.results.pots.forEach((p) => p.winners.forEach((w) => winners.add(w)));
  const bestCards = new Set();
  if (v.results && !v.results.uncontested) v.results.pots[0].winners.forEach((w) => (v.seats[w]?.best || []).forEach((c) => bestCards.add(c)));

  // deal order: clockwise starting left of the dealer
  const idx = {};
  let m = 0;
  if (v.dealer >= 0) for (let k = 1; k <= n; k++) { const j = (v.dealer + k) % n; if (v.seats[j] && v.seats[j].inHand) idx[j] = m++; }
  dealCtx = { idx, m: Math.max(1, m) };

  // top bar
  const pill = $('#room-pill');
  pill.hidden = !S.code;
  if (S.code) pill.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M12 3v12M7 8l5-5 5 5"/></svg>${S.code}`;
  $('#table-info').textContent = `NLH · ${fmt(cfg.sb)}/${fmt(cfg.bb)}${v.handNo ? ` · Hand ${v.handNo}${cfg.maxHands ? '/' + cfg.maxHands : ''}` : ''}`;

  // seats
  let html = '';
  const rx = geo.landscape ? 46 : 44, ry = geo.landscape ? 42 : 45;
  for (let i = 0; i < n; i++) {
    const p = v.seats[i];
    const rel = (i - you + n) % n;
    const { cos, sin } = seatPos(rel, n);
    const x = 50 + rx * cos, y = 50 + ry * sin;
    const style = `left:${x}%;top:${y}%`;
    if (!p) {
      const canBot = S.mode !== 'client' && S.table;
      const canSit = v.you < 0;
      html += `<div class="seat empty" style="${style}" data-empty="${i}">
        <div class="avatar ghost">${canSit ? 'Sit' : canBot ? '+' : ''}</div>
        <div class="plate ghost"><div class="pname">${canSit ? 'Open seat' : canBot ? 'Add bot' : 'Empty'}</div></div></div>`;
      continue;
    }
    const me = i === v.you;
    const active = i === v.toAct;
    const won = winners.has(i) && v.street === 'showdown';
    const cls = ['seat', cos > 0.3 && 'right', me && 'me', active && 'active', p.folded && 'folded', !p.inHand && 'waiting', won && 'winner', !p.connected && 'offline', p.allIn && 'allin'].filter(Boolean).join(' ');
    let cards = '';
    if (!me && p.inHand && !p.folded) {
      if (p.cards) {
        cards = `<div class="seat-cards face">${p.cards.map((c, k) => { const f = fx(`s${i}-${k}-f`, 'flip', k); return cardHTML(c, `sm ${bestCards.size && !bestCards.has(c) ? 'dim' : ''} ${f.cls}`, f.at); }).join('')}</div>`;
      } else {
        cards = `<div class="seat-cards">${[0, 1].map((k) => { const f = fx(`s${i}-${k}`, 'deal', k * dealCtx.m + (dealCtx.idx[i] ?? 0)); return cardHTML(null, 'sm ' + f.cls, f.at); }).join('')}</div>`;
      }
    }
    let tag = '';
    if (won) tag = `<div class="tag win">+${fmt(p.won)}</div>`;
    else if (p.lastAction) tag = `<div class="tag a-${p.lastAction.toLowerCase().replace(/[^a-z]/g, '')}">${p.lastAction}</div>`;
    else if (p.sittingOut) tag = `<div class="tag">Sitting out</div>`;
    else if (!p.inHand && v.street !== 'idle') tag = `<div class="tag">${p.stack === 0 ? 'Busted' : 'Next hand'}</div>`;
    const handTag = p.handName && !me ? `<div class="hand-name">${esc(p.handName)}</div>` : '';
    html += `<div class="${cls}" style="${style}" data-seat="${i}">
      ${cards}
      <div class="avatar" style="--h:${hue(p.name)}">
        <svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="47"/></svg>
        <span>${p.isBot ? '<svg class="bot-ic" viewBox="0 0 24 24"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h0M15 13h0"/></svg>' : esc(initials(p.name))}</span>
        ${!p.connected ? '<i class="offline-dot"></i>' : ''}
      </div>
      <div class="plate"><div class="pname">${esc(p.name)}</div><div class="pstack">${p.allIn && p.inHand && !p.folded ? 'ALL IN' : `<i class="coin"></i>${fmt(p.stack)}`}</div></div>
      ${p.stack > 0 ? `<div class="spile">${tablePile(p.stack, cfg, 3, 2)}</div>` : ''}
      ${tag}${handTag}
    </div>`;
    if (p.bet > 0) {
      const bx = 50 + rx * 0.58 * cos, by = 50 + ry * 0.56 * sin;
      html += `<div class="bet" data-seat="${i}" data-amt="${p.bet}" data-k="${chipColor(p.bet, cfg.bb)}" style="left:${bx}%;top:${by}%"><span class="bet-amt">${fmt(p.bet)}</span>${tablePile(p.bet, cfg, 3)}</div>`;
    }
    if (i === v.dealer && v.handNo) {
      const base = Math.atan2(sin, cos);
      const a = base + (geo.landscape ? 0.32 : 0.42);
      const dx = 50 + rx * 0.74 * Math.cos(a), dy = 50 + ry * 0.74 * Math.sin(a);
      html += `<div class="dealer" style="left:${dx}%;top:${dy}%">D</div>`;
      const a2 = base - (geo.landscape ? 0.3 : 0.4);
      const kx = 50 + rx * 0.76 * Math.cos(a2), ky = 50 + ry * 0.76 * Math.sin(a2);
      html += `<div class="deckpile" id="deckpile" style="left:${kx}%;top:${ky}%"><i class="card back"></i><i class="card back"></i><i class="card back"></i><i class="card back"></i></div>`;
    }
  }
  $('#seats').innerHTML = html;

  // board
  let b = '';
  for (let k = 0; k < 5; k++) {
    const c = v.board[k];
    if (c == null) { b += '<div class="card slot"></div>'; continue; }
    const f = fx('b' + k, 'board', k < 3 ? k : 0);
    b += cardHTML(c, `${bestCards.size && !bestCards.has(c) ? 'dim' : ''} ${bestCards.has(c) ? 'hl' : ''} ${f.cls}`, f.at);
  }
  $('#board').innerHTML = b;

  // pot (chips already collected from earlier streets)
  const bets = v.seats.reduce((s, p) => s + (p ? p.bet : 0), 0);
  const collected = v.pot - bets;
  const potShown = collected > 0 ? collected : v.pot;
  $('#pot').innerHTML = v.pot > 0
    ? `<div class="pot-row"><span class="pot-main">${collected > 0 ? '' : '<small>Pot</small>'}${fmt(potShown)}</span>${tablePile(collected, cfg, 5)}</div>${bets && collected > 0 ? `<span class="pot-total">Total ${fmt(v.pot)}</span>` : ''}`
    : '';
  $('#pot').classList.toggle('hidden', v.pot <= 0 || (v.street === 'showdown' && !!v.results));

  // chips sweep into the pot at the end of a street, then pay out to the winners
  const potC = rectCenter($('#pot'));
  if (S.prevHand === v.handNo) {
    let k = 0;
    for (const i in S.prevBets) {
      const pb = S.prevBets[i], cur = v.seats[i];
      if (cur && cur.bet === 0 && pb.amt > 0) { flyChips(pb, potC, Math.min(6, Math.max(2, Math.round(pb.amt / cfg.bb))), pb.k, k * 40); k++; }
    }
  }
  if (v.street === 'showdown' && v.results && S.paidHand !== v.handNo) {
    S.paidHand = v.handNo;
    v.results.pots.forEach((pot) => pot.winners.forEach((w, wi) => {
      const av = $(`.seat[data-seat="${w}"] .avatar`);
      if (av) flyChips(potC, rectCenter(av), Math.min(10, Math.max(3, Math.round(pot.amount / cfg.bb / pot.winners.length))), 3, 450 + wi * 90);
    }));
  }
  S.prevBets = {};
  $$('#seats .bet').forEach((el) => { const c = rectCenter(el); S.prevBets[el.dataset.seat] = { x: c.x, y: c.y, amt: +el.dataset.amt, k: +el.dataset.k }; });
  S.prevHand = v.handNo;

  $('#status').innerHTML = statusText(v);
  renderHero(v, bestCards);
  renderActions(v);
  animateDeals();
  refreshOdds();
  paintOdds();
  renderOver(v);
}

// cards fly out of the dealer's deck one at a time; shown cards flip face-up
function animateDeals() {
  const els = $$('.fx');
  if (!els.length) return;
  const v = S.view;
  const deck = $('#deckpile');
  const src = deck || (v.dealer >= 0 && $(`.seat[data-seat="${v.dealer}"] .avatar`)) || $('#center');
  const o = rectCenter(src);
  for (const el of els) {
    el.classList.remove('fx');
    if (reduceMotion) continue;
    const kind = el.dataset.kind, ord = +el.dataset.ord || 0;
    if (kind === 'flip') {
      el.animate([{ transform: 'scaleX(.05)', opacity: 0.4 }], { duration: 340, delay: ord * 140, easing: 'ease-out', fill: 'backwards' });
      continue;
    }
    const r = el.getBoundingClientRect();
    const dx = o.x - (r.left + r.width / 2), dy = o.y - (r.top + r.height / 2);
    const delay = kind === 'board' ? ord * 130 : ord * 80;
    el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(.4) rotate(${(Math.random() * 60 - 30).toFixed(0)}deg)`, opacity: 0 },
      { opacity: 1, offset: 0.2 },
    ], { duration: 460, delay, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'backwards' });
    setTimeout(() => {
      sfx.card();
      if (deck) deck.animate([{ transform: 'translate(-50%,-50%) translate(0,0) rotate(0)' }, { transform: 'translate(-50%,-50%) translate(3px,-3px) rotate(3deg)' }, { transform: 'translate(-50%,-50%) translate(0,0) rotate(0)' }], { duration: 160 });
    }, delay + 30);
  }
}

function chipColor(amt, bb) {
  const r = amt / bb;
  return r >= 50 ? 4 : r >= 15 ? 3 : r >= 4 ? 2 : 1;
}

function statusText(v) {
  if (v.street === 'showdown' && v.results) {
    return v.results.pots.map((p, k) => {
      const names = p.winners.map((w) => esc(v.seats[w]?.name || '?')).join(' & ');
      const label = v.results.pots.length > 1 ? `<small>${k === 0 ? 'Main pot' : 'Side pot'}</small> ` : '';
      return `<div class="result">${label}<b>${names}</b> ${p.winners.length > 1 ? 'split' : 'wins'} ${fmt(p.amount)}${p.handName ? ` · ${esc(p.handName)}` : ''}</div>`;
    }).join('');
  }
  if (v.street === 'idle') {
    const seated = v.seats.filter(Boolean);
    const withChips = seated.filter((p) => p.stack > 0);
    if (!v.running) {
      if (S.mode === 'host') return `<div class="waiting">${seated.length < 2 ? 'Waiting for players to join…' : `${seated.length} players seated`}</div>`;
      return '<div class="waiting">Waiting for the host to start…</div>';
    }
    if (v.handNo > 0 && withChips.length === 1 && !v.config.rebuy) return `<div class="result"><b>${esc(withChips[0].name)}</b> wins the table 🏆</div>`;
    return '<div class="waiting">Waiting for players…</div>';
  }
  return '';
}

function renderHero(v, bestCards) {
  const p = v.you >= 0 ? v.seats[v.you] : null;
  const hc = $('#hero-cards'), hn = $('#hero-hand');
  if (!p || !p.cards || !p.cards.length) { hc.innerHTML = ''; hn.textContent = ''; $('#hero').classList.add('empty'); return; }
  $('#hero').classList.remove('empty');
  hc.innerHTML = p.cards.map((c, k) => {
    const f = fx('h' + k, 'deal', k * dealCtx.m + (dealCtx.idx[v.you] ?? 0));
    return cardHTML(c, `lg ${p.folded ? 'dim' : ''} ${bestCards.size && !bestCards.has(c) ? 'dim' : ''} ${bestCards.has(c) ? 'hl' : ''} ${f.cls}`, f.at);
  }).join('');
  let label = '';
  if (p.handName) label = p.handName;
  else if (v.board.length >= 3) label = evaluate([...p.cards, ...v.board]).name;
  else label = describeHole(p.cards);
  hn.innerHTML = p.folded ? '<span class="muted">Folded</span>' : esc(label);
}

const clampTo = (x, l) => Math.max(l.minTo, Math.min(l.maxTo, x));
function denoms(cfg, maxTo) {
  const out = [];
  for (const m of CHIP_MULT) { const d = cfg.bb * m; if (d <= maxTo) out.push(d); }
  return out;
}
function pileHTML(amount, ds) {
  let rem = amount, h = '';
  for (let k = ds.length - 1; k >= 0; k--) {
    const d = ds[k], n = Math.floor(rem / d);
    if (!n) continue;
    rem -= n * d;
    const shown = Math.min(n, 6);
    h += `<button class="stack" data-d="${d}" aria-label="Remove a ${fmt(d)} chip"><span class="stack-chips">${Array.from({ length: shown }, (_, i) => `<i class="chip c${k + 1}" style="--i:${i}">${i === shown - 1 ? `<b>${chipLabel(d)}</b>` : ''}</i>`).join('')}</span>${n > 1 ? `<b>${n}</b>` : ''}</button>`;
  }
  if (rem > 0) h += `<span class="loose">+${fmt(rem)}</span>`;
  return h;
}

function renderActions(v) {
  const el = $('#actions');
  const rp = $('#raise-panel');
  const p = v.you >= 0 ? v.seats[v.you] : null;
  const l = v.legal;
  const pending = l && S.sentTurn === v.turnId;
  let html = '';

  if (v.over) {
    html = '<div class="idle-msg">Game over</div>';
  } else if (S.mode === 'host' && !v.running) {
    const seated = v.seats.filter(Boolean).length;
    html = `<button class="btn btn-gray" data-act="invite">Invite</button><button class="btn btn-filled grow" data-act="start" ${seated < 2 ? 'disabled' : ''}>${seated < 2 ? 'Need 2+ players' : 'Start Game'}</button>`;
  } else if (l) {
    if (S.raiseOpen && l.canRaise) {
      html = `<button class="btn btn-gray" data-act="cancel">Cancel</button>
        <button class="btn btn-call" data-act="${l.canCheck ? 'check' : 'call'}" ${pending ? 'disabled' : ''}>${l.canCheck ? 'Check' : 'Call ' + fmt(l.toCall)}</button>
        <button class="btn btn-raise grow" data-act="confirm" ${pending ? 'disabled' : ''}></button>`;
    } else {
      const allinCall = !l.canCheck && l.toCall >= p.stack;
      html = `<button class="btn btn-fold" data-act="fold" ${pending ? 'disabled' : ''}>Fold</button>
        <button class="btn btn-call grow" data-act="${l.canCheck ? 'check' : 'call'}" ${pending ? 'disabled' : ''}>${l.canCheck ? 'Check' : allinCall ? 'All-in ' + fmt(l.toCall) : 'Call ' + fmt(l.toCall)}</button>
        ${l.canRaise ? `<button class="btn btn-raise" data-act="raise" ${pending ? 'disabled' : ''}>${l.isBet ? 'Bet' : 'Raise'}</button>` : ''}`;
    }
  } else if (p && p.inHand && !p.folded && !p.allIn && ['preflop', 'flop', 'turn', 'river'].includes(v.street)) {
    const facing = v.currentBet > p.bet;
    const opts = facing ? [['checkfold', 'Check / Fold'], ['callany', 'Call Any']] : [['checkfold', 'Check / Fold'], ['check', 'Check'], ['callany', 'Call Any']];
    html = opts.map(([k, t]) => `<button class="btn pre ${S.pre === k ? 'on' : ''}" data-pre="${k}"><i></i>${t}</button>`).join('');
  } else if (p && p.stack === 0 && (!p.inHand || v.street === 'showdown' || v.street === 'idle')) {
    html = v.config.rebuy ? `<button class="btn btn-filled grow" data-act="rebuy">Rebuy ${fmt(v.config.startStack)}</button>` : '<div class="idle-msg">You’re out of chips · Spectating</div>';
  } else if (p && p.sittingOut) {
    html = `<div class="idle-msg">You’re sitting out</div><button class="btn btn-filled" data-act="sitin">I’m Back</button>`;
  } else if (!p) {
    html = v.seats.some((s) => !s) ? `<div class="idle-msg">Spectating</div><button class="btn btn-filled" data-act="seat">Take a Seat</button>` : '<div class="idle-msg">Spectating · table full</div>';
  } else if (p.inHand && p.allIn && v.street !== 'showdown') {
    html = '<div class="idle-msg">You’re all-in</div>';
  } else if (!p.inHand && v.running && v.street !== 'idle') {
    html = '<div class="idle-msg">You’ll be dealt in next hand</div>';
  } else {
    html = '<div class="idle-msg"></div>';
  }
  el.innerHTML = html;
  el.classList.toggle('my-turn', !!l);

  const raising = !!(l && S.raiseOpen && l.canRaise);
  $('#dock').classList.toggle('raising', raising);
  if (raising) {
    rp.hidden = false;
    S.raiseTo = clampTo(S.raiseTo || l.minTo, l);
    const ds = denoms(v.config, l.maxTo);
    const rack = $('#chip-rack');
    const key = ds.join(',');
    if (rack.dataset.key !== key) {
      rack.dataset.key = key;
      rack.innerHTML = ds.map((d, k) => `<button class="chip-btn c${k + 1}" data-d="${d}" aria-label="Add ${fmt(d)}"><span>${fmt(d)}</span></button>`).join('');
    }
    $('#raise-label').textContent = l.isBet ? 'Bet' : 'Raise to';
    const sb = v.config.sb, pa = l.pot + l.toCall;
    const snap = (x) => clampTo(Math.round(x / sb) * sb, l);
    const opts = [['Min', l.minTo], ['½ Pot', snap(l.currentBet + pa * 0.5)], ['¾ Pot', snap(l.currentBet + pa * 0.75)], ['Pot', snap(l.currentBet + pa)]];
    const seenV = new Set();
    let ph = '';
    for (const [name, val] of opts) {
      if (seenV.has(val) || (name !== 'Min' && (val <= l.minTo || val >= l.maxTo))) continue;
      seenV.add(val);
      ph += `<button data-to="${val}">${name}</button>`;
    }
    ph += `<button data-to="${l.maxTo}" class="allin">All-in</button>`;
    $('#presets').innerHTML = ph;
    updateRaiseUI();
  } else {
    rp.hidden = true;
    $('#chip-rack').dataset.key = '';
  }
}

function updateRaiseUI() {
  const v = S.view, l = v && v.legal;
  if (!l || !S.raiseOpen) return;
  S.raiseTo = clampTo(S.raiseTo || l.minTo, l);
  const atMax = S.raiseTo >= l.maxTo;
  $('#raise-value').textContent = fmt(S.raiseTo);
  $('#bet-pile').innerHTML = pileHTML(S.raiseTo, denoms(v.config, l.maxTo));
  $$('#chip-rack .chip-btn').forEach((b) => { b.disabled = atMax; });
  $$('#presets button').forEach((b) => b.classList.toggle('on', +b.dataset.to === S.raiseTo));
  $('#raise-clear').disabled = S.raiseTo <= l.minTo;
  const btn = $('#actions [data-act="confirm"]');
  if (btn) btn.textContent = atMax ? 'All-in ' + fmt(l.maxTo) : (l.isBet ? 'Bet ' : 'Raise to ') + fmt(S.raiseTo);
}

function flyChipFrom(btn) {
  if (reduceMotion) return;
  const to = $('#bet-pile');
  if (!to) return;
  flyChips(rectCenter(btn), rectCenter(to), 1, +(btn.className.match(/c(\d)/) || [0, 1])[1], 0);
}
function addChip(btn) {
  const l = S.view?.legal;
  if (!l || !S.raiseOpen || S.raiseTo >= l.maxTo) return false;
  S.raiseTo = clampTo(S.raiseTo + +btn.dataset.d, l);
  navigator.vibrate?.(8);
  flyChipFrom(btn);
  updateRaiseUI();
  return true;
}
let holdT, holdI;
const stopHold = () => { clearTimeout(holdT); clearInterval(holdI); };
$('#chip-rack').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.chip-btn');
  if (!b || b.disabled) return;
  e.preventDefault();
  addChip(b);
  stopHold();
  holdT = setTimeout(() => { holdI = setInterval(() => { if (!addChip(b)) stopHold(); }, 130); }, 380);
});
$('#chip-rack').addEventListener('click', (e) => { const b = e.target.closest('.chip-btn'); if (b && !b.disabled && e.detail === 0) addChip(b); });
['pointerup', 'pointercancel'].forEach((t) => window.addEventListener(t, stopHold));
$('#bet-pile').addEventListener('click', (e) => {
  const st = e.target.closest('.stack');
  const l = S.view?.legal;
  if (!st || !l) return;
  S.raiseTo = clampTo(S.raiseTo - +st.dataset.d, l);
  sfx.tap(); updateRaiseUI();
});
$('#raise-clear').addEventListener('click', () => { const l = S.view?.legal; if (!l) return; S.raiseTo = l.minTo; sfx.tap(); updateRaiseUI(); });
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-to]');
  if (!b) return;
  S.raiseTo = +b.dataset.to; sfx.chip(); updateRaiseUI();
});

$('#actions').addEventListener('click', (e) => {
  const pre = e.target.closest('[data-pre]');
  if (pre) { S.pre = S.pre === pre.dataset.pre ? null : pre.dataset.pre; sfx.tap(); renderActions(S.view); return; }
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const a = b.dataset.act;
  const l = S.view?.legal;
  switch (a) {
    case 'fold': case 'check': case 'call': api.act(a); break;
    case 'raise': S.raiseOpen = true; S.raiseTo = l.minTo; sfx.tap(); render(); break;
    case 'cancel': S.raiseOpen = false; render(); break;
    case 'confirm': api.act(S.raiseTo >= l.maxTo ? 'allin' : 'raise', S.raiseTo); break;
    case 'start': S.table.start(); break;
    case 'invite': shareInvite(false); break;
    case 'rebuy': api.rebuy(); break;
    case 'sitin': api.sit(false); break;
    case 'seat': api.seat(); break;
  }
});

// tap empty seat: add bot (host/local) or sit (spectator)
$('#seats').addEventListener('click', (e) => {
  const empty = e.target.closest('[data-empty]');
  if (empty) {
    if (S.view?.you < 0) { api.seat(); return; }
    if (S.table && S.mode !== 'client') { addBot(S.table); sfx.tap(); }
    return;
  }
  const seat = e.target.closest('[data-seat]');
  if (seat && S.table && S.mode !== 'client') {
    const i = +seat.dataset.seat;
    const p = S.table.seats[i];
    if (p && p.id !== S.myId) {
      alertBox(p.name, p.isBot ? 'Remove this bot from the table?' : 'Remove this player from the table?', [
        { text: 'Cancel', value: false }, { text: 'Remove', value: true, style: 'destructive' }]).then((ok) => { if (ok) S.table.removePlayer(p.id); });
    }
  }
});

// keyboard shortcuts on desktop
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || !S.view?.legal || $('#game').classList.contains('active') === false) return;
  const l = S.view.legal;
  if (e.key === 'f') api.act('fold');
  else if (e.key === 'c') api.act(l.canCheck ? 'check' : 'call');
  else if (e.key === 'r' && l.canRaise) { if (S.raiseOpen) api.act(S.raiseTo >= l.maxTo ? 'allin' : 'raise', S.raiseTo); else { S.raiseOpen = true; S.raiseTo = l.minTo; render(); } }
  else if (e.key === 'Escape' && S.raiseOpen) { S.raiseOpen = false; render(); }
});

// ---------------------------------------------------------------- timer loop
function tick() {
  const v = S.view;
  if (v && v.deadline && v.toAct >= 0) {
    const remain = v.deadline - (Date.now() + S.offset);
    const frac = Math.max(0, Math.min(1, remain / (v.config.turnTime * 1000)));
    const ring = $(`.seat[data-seat="${v.toAct}"] .ring circle`);
    if (ring) {
      ring.style.strokeDashoffset = String(295.3 * (1 - frac));
      ring.style.stroke = frac < 0.25 ? 'var(--red)' : frac < 0.5 ? 'var(--orange)' : 'var(--green)';
    }
    const dock = $('#actions');
    if (v.legal) dock.style.setProperty('--t', frac);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- menu
function renderMenu() {
  const v = S.view;
  const p = v && v.you >= 0 ? v.seats[v.you] : null;
  const isHost = S.mode !== 'client' && S.table;
  const free = v ? v.seats.filter((s) => !s).length : 0;
  const bots = v ? v.seats.filter((s) => s && s.isBot).length : 0;
  let h = '';
  if (S.code) h += `<div class="group"><button class="row btn-row" data-m="invite"><span class="row-icon blue">↗</span><span class="row-label">Invite Friends</span><span class="row-value">${S.code}</span></button></div>`;
  h += '<div class="group">';
  if (p) h += `<div class="row"><span class="row-icon green">◐</span><span class="row-label">Sit Out Next Hand</span><label class="switch"><input type="checkbox" data-m="sitout" ${p.sittingOut ? 'checked' : ''}/><span></span></label></div>`;
  if (p && p.stack === 0 && v.config.rebuy) h += `<button class="row btn-row" data-m="rebuy"><span class="row-icon orange">＋</span><span class="row-label">Rebuy ${fmt(v.config.startStack)}</span></button>`;
  h += `<div class="row"><span class="row-icon pink">♪</span><span class="row-label">Sound</span><label class="switch"><input type="checkbox" data-m="sound" ${isSoundOn() ? 'checked' : ''}/><span></span></label></div>`;
  if (v && v.config.odds && p) {
    h += `<button class="row btn-row" data-m="odds"><span class="row-icon blue">%</span><span class="row-label">Odds &amp; Deck</span><span class="chev">›</span></button>`;
    h += `<div class="row"><span class="row-icon green">◔</span><span class="row-label">Show Odds on Table</span><label class="switch"><input type="checkbox" data-m="showodds" ${S.showOdds ? 'checked' : ''}/><span></span></label></div>`;
  }
  h += `<button class="row btn-row" data-m="rankings"><span class="row-icon purple">♠</span><span class="row-label">Hand Rankings</span><span class="chev">›</span></button>`;
  h += '</div>';
  if (isHost) {
    h += '<div class="group-title">Host</div><div class="group">';
    if (!S.table.running) h += `<button class="row btn-row" data-m="start"><span class="row-icon green">▶</span><span class="row-label">Start Game</span></button>`;
    h += `<button class="row btn-row" data-m="addbot" ${free ? '' : 'disabled'}><span class="row-icon blue">＋</span><span class="row-label">Add Bot</span><span class="row-value">${free} open</span></button>`;
    h += `<button class="row btn-row" data-m="rmbot" ${bots ? '' : 'disabled'}><span class="row-icon gray">－</span><span class="row-label">Remove a Bot</span><span class="row-value">${bots}</span></button>`;
    h += '</div>';
  }
  if (v) h += `<p class="footnote">Blinds ${fmt(v.config.sb)}/${fmt(v.config.bb)} · Stack ${fmt(v.config.startStack)} · ${v.config.turnTime}s timer · ${v.seats.length} seats${v.config.blindUp ? ` · blinds double every ${v.config.blindUp} hands` : ''}</p>`;
  h += `<div class="group"><button class="row btn-row destructive" data-m="leave"><span class="row-label">${S.mode === 'host' ? 'End Table' : 'Leave Table'}</span></button></div>`;
  $('#menu-body').innerHTML = h;
}
$('#menu-body').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-m]');
  if (!b || b.disabled) return;
  const m = b.dataset.m;
  if (m === 'invite') shareInvite(false);
  if (m === 'rebuy') { api.rebuy(); closeSheets(); }
  if (m === 'rankings') { renderRankings(); openSheet('sheet-rankings'); }
  if (m === 'odds') openSheet('sheet-odds');
  if (m === 'start') { S.table.start(); closeSheets(); }
  if (m === 'addbot') { addBot(S.table); renderMenu(); }
  if (m === 'rmbot') { const bot = [...S.table.seats].reverse().find((s) => s && s.isBot); if (bot) S.table.removePlayer(bot.id); renderMenu(); }
  if (m === 'leave') leaveTable(false);
});
$('#menu-body').addEventListener('change', (e) => {
  const m = e.target.dataset.m;
  if (m === 'sound') { setSound(e.target.checked); if (e.target.checked) { unlockAudio(); sfx.chip(); } }
  if (m === 'sitout') api.sit(e.target.checked);
  if (m === 'showodds') { S.showOdds = e.target.checked; localStorage.setItem('felt.odds', S.showOdds ? '1' : '0'); S.odds = null; refreshOdds(); paintOdds(); }
});
$('#btn-menu').addEventListener('click', () => openSheet('sheet-menu'));
$('#btn-log').addEventListener('click', () => openSheet('sheet-log'));

// ---------------------------------------------------------------- log & chat
function renderLog() {
  const v = S.view;
  if (!v) return;
  const me = v.you >= 0 ? v.seats[v.you]?.name : null;
  $('#log-list').innerHTML = v.log.map((l) => {
    if (l.chat) return `<div class="msg ${l.name === me ? 'mine' : ''}"><span class="who">${esc(l.name)}</span><span class="bubble">${esc(l.text)}</span></div>`;
    if (l.hand) return `<div class="log-sep">${esc(l.text)}</div>`;
    return `<div class="log-line ${l.win ? 'win' : ''} ${l.street ? 'street' : ''}">${esc(l.text)}</div>`;
  }).join('');
  const list = $('#log-list');
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) list.scrollTop = list.scrollHeight;
}
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const i = $('#chat-input');
  if (i.value.trim()) api.chat(i.value.trim());
  i.value = '';
});

// ---------------------------------------------------------------- rankings
function renderRankings() {
  const C = (s) => { const r = '23456789TJQKA'.indexOf(s[0]) + 2, su = 'shdc'.indexOf(s[1]); return (r - 2) * 4 + su; };
  const rows = [
    ['Royal Flush', 'A, K, Q, J, 10 of one suit', 'As Ks Qs Js Ts'],
    ['Straight Flush', 'Five in a row, same suit', '9h 8h 7h 6h 5h'],
    ['Four of a Kind', 'Four cards of one rank', 'Qs Qh Qd Qc 7s'],
    ['Full House', 'Three of a kind plus a pair', 'Jh Jd Jc 4s 4h'],
    ['Flush', 'Any five of one suit', 'Ad Jd 8d 6d 2d'],
    ['Straight', 'Five in a row, any suits', 'Ts 9h 8d 7c 6s'],
    ['Three of a Kind', 'Three cards of one rank', '8s 8h 8d Kc 3s'],
    ['Two Pair', 'Two different pairs', 'As Ad 5c 5h Js'],
    ['One Pair', 'Two cards of one rank', 'Kh Kc 9s 6d 2h'],
    ['High Card', 'None of the above', 'Ah Js 8c 5d 3h'],
  ];
  $('#rankings-body').innerHTML = '<div class="group">' + rows.map(([n, d, cs], i) => `
    <div class="rank-row"><div class="rank-n">${i + 1}</div><div class="rank-txt"><b>${n}</b><span>${d}</span></div>
    <div class="rank-cards">${cs.split(' ').map((c) => cardHTML(C(c), 'xs')).join('')}</div></div>`).join('') + '</div>';
}

// ---------------------------------------------------------------- odds & deck tracker
const pct = (x) => (x > 0 && x < 0.005 ? '<1%' : Math.round(x * 100) + '%');
function oddsState(force) {
  const v = S.view;
  if (!v || !v.config.odds || (!S.showOdds && !force)) return null;
  const p = v.you >= 0 ? v.seats[v.you] : null;
  if (!p || !p.cards || p.cards.length < 2 || !p.inHand || p.folded) return null;
  if (['showdown', 'idle', 'over'].includes(v.street)) return null;
  const opps = v.seats.filter((q, i) => q && i !== v.you && q.inHand && !q.folded).length;
  if (opps < 1) return null;
  return { key: `${p.cards.join()}|${v.board.join()}|${opps}`, p, opps };
}
let oddsTimer;
function refreshOdds(force) {
  const st = oddsState(force);
  if (!st) { if (!force) S.odds = null; return; }
  if (S.odds && S.odds.key === st.key) return;
  clearTimeout(oddsTimer);
  const run = () => {
    const cur = oddsState(force);
    if (!cur || cur.key !== st.key) return;
    const board = S.view.board;
    const r = analyze(cur.p.cards, board, cur.opps, 1600);
    r.key = st.key; r.outs = findOuts(cur.p.cards, board);
    S.odds = r;
    paintOdds();
    if (S.sheet === 'sheet-odds') renderOdds();
  };
  if (force) run(); else oddsTimer = setTimeout(run, 60);
}
function paintOdds() {
  const el = $('#odds-line');
  const st = oddsState();
  if (!st) { el.hidden = true; return; }
  el.hidden = false;
  const o = S.odds;
  if (!o) { el.innerHTML = '<span class="odds-sub">Calculating odds…</span>'; return; }
  const v = S.view, l = v.legal;
  el.classList.toggle('stale', o.key !== st.key);
  const col = o.equity >= 0.5 ? 'var(--green)' : o.equity >= 0.3 ? 'var(--yellow)' : 'var(--red)';
  let need = '';
  if (l && l.toCall > 0) { const nd = l.toCall / (v.pot + l.toCall); need = `<span class="odds-need ${o.equity >= nd ? 'good' : 'bad'}">needs ${pct(nd)}</span>`; }
  el.innerHTML = `<span class="odds-bar"><i style="width:${Math.round(o.equity * 100)}%;background:${col}"></i></span><b>${pct(o.equity)}</b><span class="odds-sub">to win</span>${need}`;
}
$('#odds-line').addEventListener('click', () => openSheet('sheet-odds'));

function renderOdds() {
  const v = S.view;
  if (!v) return;
  const you = v.you >= 0 ? v.seats[v.you] : null;
  const mine = new Set((you && you.cards) || []), board = new Set(v.board), shown = new Set();
  v.seats.forEach((q, i) => { if (q && i !== v.you && q.cards) q.cards.forEach((c) => shown.add(c)); });
  const unseen = 52 - mine.size - board.size - shown.size;
  const st = oddsState(true);
  let h = '', outs = new Set();
  if (!v.config.odds) h += '<p class="footnote center">The host turned the odds helper off for this table.</p>';
  else if (!st) h += `<p class="footnote center">${you && you.folded ? 'You folded this hand.' : 'Your odds show up once you’re dealt in and there’s an opponent to beat.'}</p>`;
  else {
    if (!S.odds || S.odds.key !== st.key) refreshOdds(true);
    const o = S.odds;
    if (o && o.key === st.key) {
      h += oddsBlocks(o, st, v);
      if (o.outs) outs = new Set(o.outs.list);
    }
  }
  let g = '';
  for (const s of [0, 1, 2, 3]) for (let r = 14; r >= 2; r--) {
    const c = (r - 2) * 4 + s;
    const cls = mine.has(c) ? 'mine' : board.has(c) ? 'board' : shown.has(c) ? 'shown' : outs.has(c) ? 'out' : '';
    g += `<i class="dk ${cls} ${isRed(c) ? 'red' : ''}"><b>${RANK_CH[r]}</b>${SUIT_CH[s]}</i>`;
  }
  h += `<div class="group-title">The deck · ${unseen} unseen</div><div class="odds-card"><div class="deck-grid">${g}</div>
    <div class="deck-legend"><span><i class="sw mine"></i>Yours</span><span><i class="sw board"></i>Board</span><span><i class="sw shown"></i>Shown</span>${outs.size ? '<span><i class="sw out"></i>Outs</span>' : ''}<span><i class="sw"></i>Unseen</span></div></div>
    <p class="footnote">Every hand starts with a fresh shuffle of all 52 cards (Fisher–Yates, driven by the secure random generator on the host’s device), so each unseen card is equally likely to be anywhere. Chances are estimated from 1,600 simulated runouts against random opponent hands.</p>`;
  $('#odds-body').innerHTML = h;
}
function oddsBlocks(o, st, v) {
  const l = v.legal;
  const cur = v.board.length >= 3 ? evaluate([...st.p.cards, ...v.board]).cat : -1;
  let h = `<div class="group-title">Your chances · vs ${o.opps} opponent${o.opps > 1 ? 's' : ''}</div><div class="odds-card">
    <div class="stackbar"><i class="w" style="width:${o.win * 100}%"></i><i class="t" style="width:${o.tie * 100}%"></i><i class="l" style="width:${o.lose * 100}%"></i></div>
    <div class="legend"><span><b>${pct(o.win)}</b>Win</span><span><b>${pct(o.tie)}</b>Split</span><span><b>${pct(o.lose)}</b>Lose</span></div></div>`;
  if (l && l.toCall > 0) {
    const nd = l.toCall / (v.pot + l.toCall);
    const ok = o.equity >= nd;
    h += `<div class="group-title">Pot odds</div><div class="odds-card"><div class="pot-odds">Call <b>${fmt(l.toCall)}</b> to win <b>${fmt(v.pot)}</b>. You need <b>${pct(nd)}</b> to break even and have <b>${pct(o.equity)}</b>.</div><div class="verdict ${ok ? 'good' : 'bad'}">${ok ? 'Calling is profitable on the odds' : 'The odds don’t justify a call'}</div></div>`;
  }
  if (o.outs) {
    const ou = o.outs;
    h += `<div class="group-title">Outs</div><div class="odds-card"><div class="pot-odds"><b>${ou.count}</b> of ${ou.unseen} unseen cards improve your hand — ${ou.cards === 3 ? `${pct(ou.next)} on the turn, ${pct(ou.river)} by the river` : `${pct(ou.next)} on the river`}.</div></div>`;
  }
  const rows = o.cats.map((p, c) => ({ c, p })).filter((r) => r.p >= 0.005).reverse();
  h += `<div class="group-title">How your hand finishes</div><div class="odds-card">${rows.map((r) => `<div class="cat-row ${r.c === cur ? 'cur' : ''}"><span>${CATEGORY[r.c]}</span><span class="bar"><i style="width:${Math.max(2, r.p * 100)}%"></i></span><b>${pct(r.p)}</b></div>`).join('')}</div>`;
  return h;
}

// ---------------------------------------------------------------- game over
function renderOver(v) {
  const el = $('#over');
  if (!v.over) { el.hidden = true; return; }
  const st = v.over.standings;
  $('#over-body').innerHTML = `<div class="trophy">🏆</div><h2>${esc(st[0].name)} wins</h2><p>${fmt(st[0].stack)} chips after ${v.over.hands} hand${v.over.hands === 1 ? '' : 's'}</p>
    <div class="group">${st.map((x, i) => `<div class="row"><span class="rank-n">${i + 1}</span><span class="row-label">${esc(x.name)}</span><span class="row-value">${fmt(x.stack)}</span></div>`).join('')}</div>`;
  $('#over-actions').innerHTML = (S.mode !== 'client' ? '<button class="btn btn-filled btn-lg" data-over="rematch">Rematch</button>' : '<div class="idle-msg">Waiting for the host…</div>') + '<button class="btn btn-gray btn-lg" data-over="leave">Leave Table</button>';
  el.hidden = false;
}
$('#over').addEventListener('click', (e) => {
  const b = e.target.closest('[data-over]');
  if (!b) return;
  if (b.dataset.over === 'rematch' && S.table) { S.seen = new Set(); S.table.rematch(); }
  if (b.dataset.over === 'leave') leaveTable(false);
});

// ---------------------------------------------------------------- wake lock & lifecycle
async function requestWake() {
  try { if ('wakeLock' in navigator && !S.wake) { S.wake = await navigator.wakeLock.request('screen'); S.wake.addEventListener('release', () => { S.wake = null; }); } } catch {}
}
function releaseWake() { try { S.wake?.release(); } catch {} S.wake = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.mode) {
    requestWake();
    if (S.mode === 'client' && S.client && !S.client.conn?.open) reconnectSoon();
  }
});
window.addEventListener('beforeunload', (e) => { if (S.mode === 'host' && S.host) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- boot
const params = new URLSearchParams(location.search);
const invite = params.get('t');
detectLan().then((info) => {
  if (!info) return;
  S.lan = info;
  $('#lan-badge').hidden = false;
});
if (invite) {
  $('#join-code').value = invite.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (nameInput.value.trim()) setTimeout(() => openSheet('sheet-join'), 250);
  else setTimeout(() => { nameInput.focus(); toast('Enter your name, then tap Join with Code'); }, 300);
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});

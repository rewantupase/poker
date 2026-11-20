import { Table } from './engine.js';
import { evaluate, describeHole, rankOf, suitOf, RANK_CH, SUIT_CH, isRed } from './cards.js';
import { HostNet, ClientNet } from './net.js';
import { sfx, unlockAudio, isSoundOn, setSound } from './sound.js';

// ---------------------------------------------------------------- utils
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
};

// ---------------------------------------------------------------- cards
function cardHTML(c, cls = '') {
  if (c == null) return `<div class="card back ${cls}"></div>`;
  const r = RANK_CH[rankOf(c)], s = SUIT_CH[suitOf(c)];
  return `<div class="card ${isRed(c) ? 'red' : ''} ${cls}" data-c="${c}"><span class="cr">${r}</span><span class="cs">${s}</span><span class="cc">${s}</span></div>`;
}
function animCls(key) {
  if (S.seen.has(key)) return '';
  S.seen.add(key);
  return 'deal-in';
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
const setup = { maxSeats: 6, bots: 5, blinds: '10/20', startStack: 2000, turnTime: 25, blindUp: 0, rebuy: true, mode: 'bots' };
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
  else if (f === 'blinds') setup.blinds = e.target.value;
  else if (f === 'startStack') setup.startStack = +e.target.value;
});
$('#setup-start').addEventListener('click', () => {
  const [sb, bb] = setup.blinds.split('/').map(Number);
  const cfg = { maxSeats: setup.maxSeats, sb, bb, startStack: setup.startStack, turnTime: setup.turnTime, rebuy: setup.rebuy, blindUp: setup.blindUp };
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
    if (!window.Peer) { toast('Network library failed to load'); return; }
    overlay('Creating table…', () => leaveTable(true));
    S.host = new HostNet({
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
  if (!window.Peer) { toast('Network library failed to load'); return; }
  closeSheets();
  resetClientState();
  S.mode = 'client'; S.code = code; S.reconnects = 0;
  overlay('Joining ' + code + '…', () => leaveTable(true));
  connectClient(true);
}
function connectClient(first) {
  if (S.client) S.client.destroy();
  S.client = new ClientNet(S.code, {
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

async function shareInvite(auto) {
  if (!S.code) return;
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
    if (e.type === 'deal') sfx.deal();
    else if (e.type === 'board') sfx.board();
    else if (e.type === 'chips') sfx.chip();
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

// ---------------------------------------------------------------- render
function render() {
  const v = S.view;
  if (!v) return;
  const n = v.seats.length;
  const you = v.you >= 0 ? v.you : 0;
  const winners = new Set();
  if (v.results) v.results.pots.forEach((p) => p.winners.forEach((w) => winners.add(w)));
  const bestCards = new Set();
  if (v.results && !v.results.uncontested) v.results.pots[0].winners.forEach((w) => (v.seats[w]?.best || []).forEach((c) => bestCards.add(c)));

  // top bar
  const pill = $('#room-pill');
  pill.hidden = !S.code;
  if (S.code) pill.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M12 3v12M7 8l5-5 5 5"/></svg>${S.code}`;
  $('#table-info').textContent = `NLH · ${fmt(v.config.sb)}/${fmt(v.config.bb)}${v.handNo ? ` · Hand ${v.handNo}` : ''}`;

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
    const out = p.folded || !p.inHand;
    const won = winners.has(i) && v.street === 'showdown';
    const cls = ['seat', cos > 0.3 && 'right', me && 'me', active && 'active', p.folded && 'folded', !p.inHand && 'waiting', won && 'winner', !p.connected && 'offline', p.allIn && 'allin'].filter(Boolean).join(' ');
    let cards = '';
    if (!me && p.inHand && !p.folded) {
      if (p.cards) cards = `<div class="seat-cards face">${p.cards.map((c, k) => cardHTML(c, `sm ${bestCards.size && !bestCards.has(c) ? 'dim' : ''} ${animCls(`s${i}-${k}-f`)}`)).join('')}</div>`;
      else cards = `<div class="seat-cards">${cardHTML(null, 'sm ' + animCls(`s${i}-0`))}${cardHTML(null, 'sm ' + animCls(`s${i}-1`))}</div>`;
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
      <div class="plate"><div class="pname">${esc(p.name)}</div><div class="pstack">${p.allIn && p.inHand && !p.folded ? 'ALL IN' : fmt(p.stack)}</div></div>
      ${tag}${handTag}
    </div>`;
    // bet chips
    if (p.bet > 0) {
      const bx = 50 + rx * 0.58 * cos, by = 50 + ry * 0.56 * sin;
      html += `<div class="bet" style="left:${bx}%;top:${by}%"><i class="chip c${chipColor(p.bet, v.config.bb)}"></i>${fmt(p.bet)}</div>`;
    }
    if (i === v.dealer && v.handNo) {
      const a = Math.atan2(sin, cos) + (geo.landscape ? 0.32 : 0.42);
      const dx = 50 + rx * 0.74 * Math.cos(a), dy = 50 + ry * 0.74 * Math.sin(a);
      html += `<div class="dealer" style="left:${dx}%;top:${dy}%">D</div>`;
    }
  }
  $('#seats').innerHTML = html;

  // board
  let b = '';
  for (let k = 0; k < 5; k++) {
    const c = v.board[k];
    b += c == null ? '<div class="card slot"></div>' : cardHTML(c, `${bestCards.size && !bestCards.has(c) ? 'dim' : ''} ${bestCards.has(c) ? 'hl' : ''} ${animCls('b' + k)}`);
  }
  $('#board').innerHTML = b;

  // pot
  const bets = v.seats.reduce((s, p) => s + (p ? p.bet : 0), 0);
  const collected = v.pot - bets;
  const potShown = collected > 0 ? collected : v.pot;
  $('#pot').innerHTML = v.pot > 0
    ? `<span class="pot-main"><i class="chip c${chipColor(potShown, v.config.bb)}"></i>${collected > 0 ? '' : '<small>Pot</small>'}${fmt(potShown)}</span>${bets && collected ? `<span class="pot-total">Total ${fmt(v.pot)}</span>` : ''}`
    : '';
  $('#pot').classList.toggle('hidden', v.pot <= 0 || (v.street === 'showdown' && v.results));

  // status
  $('#status').innerHTML = statusText(v);

  renderHero(v, bestCards);
  renderActions(v);
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
  hc.innerHTML = p.cards.map((c, k) => cardHTML(c, `lg ${p.folded ? 'dim' : ''} ${bestCards.size && !bestCards.has(c) ? 'dim' : ''} ${bestCards.has(c) ? 'hl' : ''} ${animCls('h' + k)}`)).join('');
  let label = '';
  if (p.handName) label = p.handName;
  else if (v.board.length >= 3) label = evaluate([...p.cards, ...v.board]).name;
  else label = describeHole(p.cards);
  hn.innerHTML = p.folded ? '<span class="muted">Folded</span>' : esc(label);
}

function renderActions(v) {
  const el = $('#actions');
  const rp = $('#raise-panel');
  const p = v.you >= 0 ? v.seats[v.you] : null;
  const l = v.legal;
  const pending = l && S.sentTurn === v.turnId;
  let html = '';

  if (S.mode === 'host' && !v.running) {
    const seated = v.seats.filter(Boolean).length;
    html = `<button class="btn btn-gray" data-act="invite">Invite</button><button class="btn btn-filled grow" data-act="start" ${seated < 2 ? 'disabled' : ''}>${seated < 2 ? 'Need 2+ players' : 'Start Game'}</button>`;
  } else if (l) {
    if (S.raiseOpen && l.canRaise) {
      html = `<button class="btn btn-gray" data-act="cancel">Cancel</button>
        <button class="btn btn-call" data-act="${l.canCheck ? 'check' : 'call'}" ${pending ? 'disabled' : ''}>${l.canCheck ? 'Check' : 'Call ' + fmt(l.toCall)}</button>
        <button class="btn btn-raise grow" data-act="confirm" ${pending ? 'disabled' : ''}>${S.raiseTo >= l.maxTo ? 'All-in ' + fmt(l.maxTo) : (l.isBet ? 'Bet ' : 'Raise to ') + fmt(S.raiseTo)}</button>`;
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

  // timer bar on my turn
  el.classList.toggle('my-turn', !!l);

  // raise panel
  if (l && S.raiseOpen && l.canRaise) {
    rp.hidden = false;
    const slider = $('#raise-slider');
    slider.min = l.minTo; slider.max = l.maxTo; slider.step = v.config.sb;
    S.raiseTo = Math.max(l.minTo, Math.min(l.maxTo, S.raiseTo || l.minTo));
    slider.value = S.raiseTo;
    updateSliderFill();
    $('#raise-label').textContent = l.isBet ? 'Bet' : 'Raise to';
    $('#raise-value').textContent = fmt(S.raiseTo);
    const potAfterCall = l.pot + l.toCall;
    const presets = [['Min', l.minTo], ['½ Pot', l.currentBet + Math.round(potAfterCall / 2)], ['¾ Pot', l.currentBet + Math.round(potAfterCall * 0.75)], ['Pot', l.currentBet + potAfterCall]];
    let ph = '';
    for (const [name, val] of presets) if (val > l.minTo && val < l.maxTo || name === 'Min') ph += `<button data-to="${val}" class="${S.raiseTo === val ? 'on' : ''}">${name}</button>`;
    ph += `<button data-to="${l.maxTo}" class="allin ${S.raiseTo === l.maxTo ? 'on' : ''}">All-in</button>`;
    $('#presets').innerHTML = ph;
  } else rp.hidden = true;
}

function updateSliderFill() {
  const s = $('#raise-slider');
  const pct = ((s.value - s.min) / (s.max - s.min || 1)) * 100;
  s.style.setProperty('--pct', pct + '%');
}

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
$('#raise-slider').addEventListener('input', (e) => {
  S.raiseTo = +e.target.value;
  const l = S.view?.legal;
  if (l && S.raiseTo > l.maxTo - +e.target.step) S.raiseTo = l.maxTo;
  $('#raise-value').textContent = fmt(S.raiseTo);
  updateSliderFill();
  renderActionsOnly();
});
function renderActionsOnly() {
  const btn = $('#actions [data-act="confirm"]');
  const l = S.view?.legal;
  if (btn && l) btn.textContent = S.raiseTo >= l.maxTo ? 'All-in ' + fmt(l.maxTo) : (l.isBet ? 'Bet ' : 'Raise to ') + fmt(S.raiseTo);
  $$('#presets button').forEach((b) => b.classList.toggle('on', +b.dataset.to === S.raiseTo));
}
$('#presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-to]');
  if (!b) return;
  S.raiseTo = +b.dataset.to; sfx.tap();
  $('#raise-slider').value = S.raiseTo; updateSliderFill();
  $('#raise-value').textContent = fmt(S.raiseTo);
  renderActionsOnly();
});
$$('.raise-top .step').forEach((b) => b.addEventListener('click', () => {
  const l = S.view?.legal; if (!l) return;
  const step = S.view.config.bb * +b.dataset.step;
  S.raiseTo = Math.max(l.minTo, Math.min(l.maxTo, S.raiseTo + step));
  $('#raise-slider').value = S.raiseTo; updateSliderFill();
  $('#raise-value').textContent = fmt(S.raiseTo);
  renderActionsOnly(); sfx.tap();
}));

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
  if (m === 'start') { S.table.start(); closeSheets(); }
  if (m === 'addbot') { addBot(S.table); renderMenu(); }
  if (m === 'rmbot') { const bot = [...S.table.seats].reverse().find((s) => s && s.isBot); if (bot) S.table.removePlayer(bot.id); renderMenu(); }
  if (m === 'leave') leaveTable(false);
});
$('#menu-body').addEventListener('change', (e) => {
  const m = e.target.dataset.m;
  if (m === 'sound') { setSound(e.target.checked); if (e.target.checked) { unlockAudio(); sfx.chip(); } }
  if (m === 'sitout') api.sit(e.target.checked);
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
if (invite) {
  $('#join-code').value = invite.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (nameInput.value.trim()) setTimeout(() => openSheet('sheet-join'), 250);
  else setTimeout(() => { nameInput.focus(); toast('Enter your name, then tap Join with Code'); }, 300);
}
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});

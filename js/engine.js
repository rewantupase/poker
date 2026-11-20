// Authoritative No-Limit Texas Hold'em table. Runs on the host device only.
import { newDeck, shuffle, evaluate, bestFive, cardText } from './cards.js';
import { botDecide } from './bot.js';

export const DEFAULTS = { maxSeats: 6, sb: 10, bb: 20, startStack: 2000, turnTime: 25, rebuy: true, blindUp: 0 };
const BETTING = ['preflop', 'flop', 'turn', 'river'];
const NEXT = { preflop: 'flop', flop: 'turn', turn: 'river' };
const fmt = (n) => n.toLocaleString('en-US');

export class Table {
  constructor(config = {}, opts = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.config.maxSeats = Math.max(2, Math.min(10, this.config.maxSeats | 0));
    this.seats = new Array(this.config.maxSeats).fill(null);
    this.schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.now = opts.now || (() => Date.now());
    this.onChange = opts.onChange || (() => {});
    this.fast = !!opts.fast;
    this.dealer = -1; this.handNo = 0; this.street = 'idle';
    this.board = []; this.deck = []; this.log = []; this.events = []; this.eventId = 0;
    this.results = null; this.toAct = -1; this.turnId = 0; this.running = false;
    this.currentBet = 0; this.minRaise = this.config.bb; this.deadline = null;
    this.sbSeat = -1; this.bbSeat = -1; this.pendingStart = false;
  }

  // ---------- helpers ----------
  emit() { this.onChange(); }
  wait(ms) { return this.fast ? 0 : ms; }
  pushEvent(type, seat = -1) {
    this.events.push({ id: ++this.eventId, type, seat });
    if (this.events.length > 24) this.events.shift();
  }
  addLog(text, extra = {}) {
    this.log.push({ t: this.now(), text, ...extra });
    if (this.log.length > 200) this.log.shift();
  }
  findSeat(id) { return this.seats.findIndex((p) => p && p.id === id); }
  isBetting() { return BETTING.includes(this.street); }
  canAct(p) { return !!p && p.inHand && !p.folded && !p.allIn; }
  needsToAct(p) { return this.canAct(p) && !(p.acted && p.bet === this.currentBet); }
  live() { return this.seats.filter((p) => p && p.inHand && !p.folded); }
  potTotal() { return this.seats.reduce((s, p) => s + (p ? p.totalIn : 0), 0); }
  eligible() {
    const r = [];
    this.seats.forEach((p, i) => { if (p && p.stack > 0 && !p.sittingOut && !p.leaving) r.push(i); });
    return r;
  }
  nextSeat(from, pred) {
    const n = this.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + k) % n) + n) % n;
      const p = this.seats[i];
      if (p && pred(p, i)) return i;
    }
    return -1;
  }
  guard(fn) {
    const key = this.handNo + ':' + this.street;
    return () => { if (this.handNo + ':' + this.street === key) fn(); };
  }

  // ---------- seating ----------
  addPlayer({ id, name, isBot = false, style }, seat = -1) {
    const existing = this.findSeat(id);
    if (existing >= 0) return existing;
    if (seat < 0 || seat >= this.seats.length || this.seats[seat]) seat = this.seats.findIndex((s) => !s);
    if (seat < 0) return -1;
    const clean = String(name || 'Player').trim().slice(0, 14) || 'Player';
    this.seats[seat] = {
      id, name: clean, isBot, style: style ?? Math.random(), stack: this.config.startStack,
      connected: true, dcAt: 0, sittingOut: false, leaving: false, timeouts: 0,
      cards: [], bet: 0, totalIn: 0, inHand: false, folded: false, allIn: false, acted: false,
      raiseRight: true, lastAction: null, showCards: false, handName: null, best: null, won: 0, score: 0,
    };
    this.addLog(`${clean} sat down`);
    this.maybeStart();
    this.emit();
    return seat;
  }

  removePlayer(id) {
    const i = this.findSeat(id);
    if (i < 0) return;
    const p = this.seats[i];
    this.addLog(`${p.name} left the table`);
    if (p.inHand && this.street !== 'idle' && this.street !== 'showdown') {
      p.leaving = true;
      if (this.canAct(p)) {
        if (this.toAct === i) { this.act(id, 'fold'); return; }
        p.folded = true; p.lastAction = 'Fold';
        const live = this.live();
        if (live.length === 1 && this.isBetting()) { this.winUncontested(live[0]); return; }
      }
    } else {
      this.seats[i] = null;
    }
    this.emit();
  }

  setConnected(id, c) {
    const i = this.findSeat(id);
    if (i < 0) return;
    const p = this.seats[i];
    if (p.connected === c) return;
    p.connected = c;
    if (!c) p.dcAt = this.now(); else { p.timeouts = 0; }
    this.addLog(`${p.name} ${c ? 'reconnected' : 'disconnected'}`);
    if (!c && this.toAct === i) {
      const tid = this.turnId;
      this.schedule(() => { if (this.turnId === tid) this.timeout(); }, this.wait(3000));
    }
    this.emit();
  }

  sitOut(id, out) {
    const i = this.findSeat(id);
    if (i < 0) return;
    const p = this.seats[i];
    p.sittingOut = !!out;
    if (!out) p.timeouts = 0;
    this.addLog(`${p.name} ${out ? 'is sitting out' : 'is back'}`);
    this.maybeStart();
    this.emit();
  }

  rebuy(id) {
    const i = this.findSeat(id);
    if (i < 0) return;
    const p = this.seats[i];
    if (!this.config.rebuy || p.stack > 0) return;
    if (p.inHand && !p.folded && this.isBetting()) return;
    p.stack = this.config.startStack;
    p.sittingOut = false; p.timeouts = 0;
    this.addLog(`${p.name} rebought for ${fmt(p.stack)}`);
    this.maybeStart();
    this.emit();
  }

  addChat(id, text) {
    const i = this.findSeat(id);
    const name = i >= 0 ? this.seats[i].name : 'Spectator';
    const t = String(text || '').trim().slice(0, 140);
    if (!t) return;
    this.addLog(t, { chat: true, name });
    this.emit();
  }

  start() { this.running = true; this.maybeStart(); this.emit(); }

  maybeStart() {
    if (this.running && this.street === 'idle' && !this.pendingStart && this.eligible().length >= 2) {
      this.pendingStart = true;
      this.schedule(() => { this.pendingStart = false; if (this.street === 'idle') this.startHand(); }, this.wait(1200));
    }
  }

  // ---------- hand flow ----------
  startHand() {
    const now = this.now();
    this.seats.forEach((p, i) => {
      if (!p) return;
      if (p.leaving || (!p.isBot && !p.connected && now - p.dcAt > 90000)) { this.seats[i] = null; return; }
      if (p.isBot && p.stack === 0 && this.config.rebuy) {
        p.stack = this.config.startStack;
        this.addLog(`${p.name} rebought for ${fmt(p.stack)}`);
      }
    });
    for (const p of this.seats) if (p) Object.assign(p, {
      cards: [], bet: 0, totalIn: 0, inHand: false, folded: false, allIn: false, acted: false,
      raiseRight: true, lastAction: null, showCards: false, handName: null, best: null, won: 0, score: 0,
    });
    this.results = null; this.board = [];
    const el = this.eligible();
    if (!this.running || el.length < 2) {
      this.street = 'idle'; this.toAct = -1; this.deadline = null; this.emit(); return;
    }
    const c = this.config;
    if (c.blindUp > 0 && this.handNo > 0 && this.handNo % c.blindUp === 0) {
      c.sb *= 2; c.bb *= 2;
      this.addLog(`Blinds up → ${fmt(c.sb)}/${fmt(c.bb)}`);
    }
    this.handNo++;
    el.forEach((i) => { this.seats[i].inHand = true; });
    const inHand = (p) => p.inHand;
    this.dealer = this.nextSeat(this.dealer, inHand);
    let sb, bb;
    if (el.length === 2) { sb = this.dealer; bb = this.nextSeat(sb, inHand); }
    else { sb = this.nextSeat(this.dealer, inHand); bb = this.nextSeat(sb, inHand); }
    this.sbSeat = sb; this.bbSeat = bb;
    this.deck = shuffle(newDeck());
    this.street = 'preflop';
    this.addLog(`Hand #${this.handNo} · Blinds ${fmt(c.sb)}/${fmt(c.bb)}`, { hand: true });
    this.post(sb, c.sb, 'SB');
    this.post(bb, c.bb, 'BB');
    this.currentBet = c.bb; this.minRaise = c.bb;
    for (let r = 0; r < 2; r++) {
      let i = this.dealer;
      for (let k = 0; k < el.length; k++) { i = this.nextSeat(i, inHand); this.seats[i].cards.push(this.deck.pop()); }
    }
    this.pushEvent('deal');
    this.continueRound(bb);
  }

  move(p, amt) {
    amt = Math.max(0, Math.min(amt, p.stack));
    p.stack -= amt; p.bet += amt; p.totalIn += amt;
    if (p.stack === 0) p.allIn = true;
    return amt;
  }

  post(i, amt, label) {
    const p = this.seats[i];
    this.move(p, amt);
    p.lastAction = label;
  }

  roundComplete() {
    const a = this.live().filter((p) => this.canAct(p));
    if (a.length === 0) return true;
    if (a.length === 1 && a[0].bet >= this.currentBet) return true;
    return a.every((p) => p.acted && p.bet === this.currentBet);
  }

  continueRound(from) {
    const live = this.live();
    if (live.length === 1) return this.winUncontested(live[0]);
    if (this.roundComplete()) return this.endStreet();
    this.toAct = this.nextSeat(from, (q) => this.needsToAct(q));
    this.startTurn();
  }

  startTurn() {
    const i = this.toAct;
    const p = this.seats[i];
    const tid = ++this.turnId;
    const ms = this.config.turnTime * 1000;
    this.deadline = this.now() + ms;
    this.pushEvent('turn', i);
    if (p.isBot) {
      this.schedule(() => {
        if (this.turnId !== tid) return;
        const d = botDecide(this, i);
        this.act(p.id, d.action, d.amount);
      }, this.wait(700 + Math.random() * 1300));
    } else {
      const away = !p.connected || p.sittingOut;
      this.schedule(() => { if (this.turnId === tid) this.timeout(); }, this.wait(away ? Math.min(ms, 2500) : ms));
    }
    this.emit();
  }

  timeout() {
    const i = this.toAct;
    const p = this.seats[i];
    if (!p) return;
    const l = this.legal(i);
    p.timeouts++;
    this.act(p.id, l.canCheck ? 'check' : 'fold', 0, true);
    if (p.timeouts >= 2 && !p.isBot && !p.sittingOut) {
      p.sittingOut = true;
      this.addLog(`${p.name} timed out and is sitting out`);
      this.emit();
    }
  }

  legal(i) {
    const p = this.seats[i];
    if (!p) return null;
    const toCall = Math.max(0, this.currentBet - p.bet);
    const maxTo = p.bet + p.stack;
    const othersCanAct = this.seats.some((q) => q && q !== p && this.canAct(q));
    const canRaise = p.raiseRight && p.stack > toCall && othersCanAct;
    const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
    return {
      toCall: Math.min(toCall, p.stack), canCheck: toCall === 0, canRaise, minTo, maxTo,
      pot: this.potTotal(), currentBet: this.currentBet, isBet: this.currentBet === 0, myBet: p.bet,
    };
  }

  act(id, action, amount, fromTimeout = false) {
    const i = this.findSeat(id);
    if (i < 0 || i !== this.toAct || !this.isBetting()) return false;
    const p = this.seats[i];
    const l = this.legal(i);
    if (action === 'allin') {
      if (l.canRaise) { action = 'raise'; amount = l.maxTo; } else action = 'call';
    }
    if (action === 'call' && l.canCheck) action = 'check';
    if (action === 'check' && !l.canCheck) return false;
    if (action === 'raise' && !l.canRaise) action = l.canCheck ? 'check' : 'call';
    let label, text;
    switch (action) {
      case 'fold':
        p.folded = true; label = 'Fold'; text = 'folds';
        this.pushEvent('fold', i);
        break;
      case 'check':
        label = 'Check'; text = 'checks';
        this.pushEvent('check', i);
        break;
      case 'call': {
        const amt = this.move(p, l.toCall);
        label = p.allIn ? 'All-in' : 'Call';
        text = p.allIn ? `calls ${fmt(amt)} and is all-in` : `calls ${fmt(amt)}`;
        this.pushEvent('chips', i);
        break;
      }
      case 'raise': {
        let to = Math.floor(Number(amount) || 0);
        to = Math.max(l.minTo, Math.min(l.maxTo, to));
        const wasBet = this.currentBet === 0;
        const raiseSize = to - this.currentBet;
        this.move(p, to - p.bet);
        const full = raiseSize >= this.minRaise;
        if (full) this.minRaise = raiseSize;
        this.currentBet = to;
        for (const q of this.seats) {
          if (!q || q === p || !this.canAct(q)) continue;
          if (full) q.raiseRight = true; else if (q.acted) q.raiseRight = false;
          q.acted = false;
        }
        label = p.allIn ? 'All-in' : wasBet ? 'Bet' : 'Raise';
        text = p.allIn ? `goes all-in for ${fmt(to)}` : wasBet ? `bets ${fmt(to)}` : `raises to ${fmt(to)}`;
        this.pushEvent('chips', i);
        break;
      }
      default:
        return false;
    }
    p.acted = true;
    p.lastAction = label;
    if (!fromTimeout) p.timeouts = 0;
    this.addLog(`${p.name} ${text}`);
    this.turnId++;
    this.continueRound(i);
    return true;
  }

  returnUncalled() {
    let max = -1, maxP = null, second = 0;
    for (const p of this.seats) {
      if (!p || !p.inHand) continue;
      if (p.bet > max) { second = Math.max(second, max); max = p.bet; maxP = p; }
      else second = Math.max(second, p.bet);
    }
    if (maxP && max > second) {
      const d = max - second;
      maxP.bet -= d; maxP.totalIn -= d; maxP.stack += d;
      if (maxP.stack > 0) maxP.allIn = false;
      this.addLog(`Uncalled ${fmt(d)} returned to ${maxP.name}`);
    }
  }

  endStreet() {
    this.returnUncalled();
    for (const p of this.seats) {
      if (!p || !p.inHand) continue;
      p.bet = 0; p.acted = false; p.raiseRight = true;
      if (!p.folded && !p.allIn) p.lastAction = null;
    }
    this.currentBet = 0; this.minRaise = this.config.bb;
    this.toAct = -1; this.deadline = null; this.turnId++;
    this.emit();
    if (this.street === 'river') { this.schedule(this.guard(() => this.showdown()), this.wait(700)); return; }
    this.schedule(this.guard(() => this.dealNext()), this.wait(650));
  }

  dealNext() {
    const next = NEXT[this.street];
    this.deck.pop(); // burn
    const k = next === 'flop' ? 3 : 1;
    for (let j = 0; j < k; j++) this.board.push(this.deck.pop());
    this.street = next;
    this.pushEvent('board');
    this.addLog(`${next[0].toUpperCase() + next.slice(1)}: ${this.board.map(cardText).join(' ')}`, { street: true });
    const live = this.live();
    const actors = live.filter((p) => this.canAct(p));
    if (actors.length <= 1) {
      for (const p of live) p.showCards = true; // all-in runout: cards face up
      this.emit();
      this.schedule(this.guard(() => this.endStreet()), this.wait(1500));
      return;
    }
    this.continueRound(this.dealer);
  }

  winUncontested(p) {
    this.returnUncalled();
    const total = this.potTotal();
    p.stack += total; p.won = total;
    const seat = this.seats.indexOf(p);
    this.results = { uncontested: true, pots: [{ amount: total, winners: [seat], handName: null }] };
    this.addLog(`${p.name} wins ${fmt(total)}`, { win: true });
    this.pushEvent('win', seat);
    this.finishHand(2600);
  }

  buildPots() {
    const contrib = [];
    this.seats.forEach((p, i) => { if (p && p.inHand) contrib.push({ i, amt: p.totalIn, live: !p.folded }); });
    const pots = [];
    for (;;) {
      const liveRem = contrib.filter((c) => c.live && c.amt > 0);
      if (!liveRem.length) break;
      const level = Math.min(...liveRem.map((c) => c.amt));
      let amount = 0;
      for (const c of contrib) { const take = Math.min(c.amt, level); amount += take; c.amt -= take; }
      const eligible = liveRem.map((c) => c.i);
      const prev = pots[pots.length - 1];
      if (prev && prev.eligible.length === eligible.length && prev.eligible.every((x, k) => x === eligible[k])) prev.amount += amount;
      else pots.push({ amount, eligible });
    }
    const left = contrib.reduce((s, c) => s + c.amt, 0);
    if (left > 0 && pots.length) pots[pots.length - 1].amount += left;
    return pots;
  }

  showdown() {
    this.street = 'showdown';
    const live = this.live();
    for (const p of live) {
      const all = [...p.cards, ...this.board];
      const ev = evaluate(all);
      p.score = ev.score; p.handName = ev.name; p.best = bestFive(all, ev.score); p.showCards = true;
    }
    const n = this.seats.length;
    const dist = (i) => (i - this.dealer - 1 + n) % n;
    const pots = this.buildPots();
    const out = [];
    pots.forEach((pot, k) => {
      const best = Math.max(...pot.eligible.map((i) => this.seats[i].score));
      const winners = pot.eligible.filter((i) => this.seats[i].score === best).sort((a, b) => dist(a) - dist(b));
      const share = Math.floor(pot.amount / winners.length);
      const rem = pot.amount - share * winners.length;
      winners.forEach((i, j) => { const amt = share + (j < rem ? 1 : 0); this.seats[i].stack += amt; this.seats[i].won += amt; });
      const hn = this.seats[winners[0]].handName;
      out.push({ amount: pot.amount, winners, handName: hn });
      const label = pots.length > 1 ? (k === 0 ? ' main pot' : ` side pot ${k}`) : '';
      const names = winners.map((i) => this.seats[i].name).join(' & ');
      this.addLog(`${names} ${winners.length > 1 ? 'split' : 'wins'} ${fmt(pot.amount)}${label} with ${hn}`, { win: true });
    });
    for (const p of live) this.addLog(`${p.name} shows ${p.cards.map(cardText).join(' ')} — ${p.handName}`);
    this.results = { uncontested: false, pots: out };
    this.pushEvent('win', out[0]?.winners[0] ?? -1);
    this.finishHand(6000);
  }

  finishHand(ms) {
    this.street = 'showdown';
    this.toAct = -1; this.deadline = null; this.turnId++;
    for (const p of this.seats) if (p) p.bet = 0;
    for (const p of this.seats) if (p && p.inHand && p.stack === 0 && !p.isBot) this.addLog(`${p.name} is out of chips`);
    this.emit();
    const h = this.handNo;
    this.schedule(() => { if (this.handNo === h && this.street === 'showdown') this.startHand(); }, this.wait(ms));
  }

  // ---------- views ----------
  viewFor(id) {
    const you = this.findSeat(id);
    const seats = this.seats.map((p, i) => {
      if (!p) return null;
      const show = i === you || p.showCards;
      return {
        id: p.id, name: p.name, stack: p.stack, bet: p.bet, inHand: p.inHand, folded: p.folded, allIn: p.allIn,
        isBot: p.isBot, connected: p.connected, sittingOut: p.sittingOut, lastAction: p.lastAction, won: p.won,
        cards: show ? p.cards : null, nCards: p.inHand && !p.folded ? p.cards.length : 0,
        handName: p.showCards ? p.handName : null, best: p.showCards ? p.best : null,
      };
    });
    return {
      config: this.config, seats, board: this.board, street: this.street, toAct: this.toAct, turnId: this.turnId,
      dealer: this.dealer, sbSeat: this.sbSeat, bbSeat: this.bbSeat, currentBet: this.currentBet,
      pot: this.potTotal(), handNo: this.handNo, deadline: this.deadline, now: this.now(),
      results: this.results, log: this.log.slice(-80), events: this.events, you, running: this.running,
      legal: you >= 0 && you === this.toAct ? this.legal(you) : null,
    };
  }
}

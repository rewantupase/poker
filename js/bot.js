import { evaluate } from './cards.js';

// Monte Carlo equity of `hole` vs `opps` random hands
export function equity(hole, board, opps, iters = 220) {
  const used = new Set([...hole, ...board]);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  const need = opps * 2 + (5 - board.length);
  let win = 0;
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < need; k++) {
      const j = k + Math.floor(Math.random() * (rest.length - k));
      const t = rest[k]; rest[k] = rest[j]; rest[j] = t;
    }
    const b = board.concat(rest.slice(opps * 2, need));
    const my = evaluate(hole.concat(b)).score;
    let best = true, ties = 0;
    for (let o = 0; o < opps; o++) {
      const s = evaluate([rest[2 * o], rest[2 * o + 1], ...b]).score;
      if (s > my) { best = false; break; }
      if (s === my) ties++;
    }
    if (best) win += 1 / (ties + 1);
  }
  return win / iters;
}

export function botDecide(t, seat) {
  const p = t.seats[seat];
  const l = t.legal(seat);
  const opps = Math.max(1, t.live().length - 1);
  const pot = t.potTotal();
  const { sb, bb } = t.config;
  const aggr = 0.25 + (p.style ?? 0.5) * 0.5; // 0.25 .. 0.75
  const r = Math.random();
  const eq = equity(p.cards, t.board, Math.min(opps, 4));
  const fair = 1 / (Math.min(opps, 4) + 1);
  const strength = eq / fair; // >1 = better than average
  const toCall = l.toCall;
  const potOdds = toCall / (pot + toCall || 1);

  const raiseTo = (frac) => {
    let to = t.currentBet + Math.round(((pot + toCall) * frac) / sb) * sb;
    to = Math.max(l.minTo, Math.min(l.maxTo, to));
    if (to > l.maxTo * 0.8) to = l.maxTo; // commit fully rather than leave crumbs
    return { action: 'raise', amount: to };
  };

  if (l.canCheck) {
    if (l.canRaise && (strength > 1.7 || (strength > 1.3 && r < aggr) || r < 0.07 * aggr)) {
      return raiseTo(0.45 + r * 0.45);
    }
    return { action: 'check' };
  }
  if (l.canRaise && ((strength > 2.1 && r < 0.35 + aggr * 0.4) || (eq > 0.8 && r < 0.75))) {
    return raiseTo(0.65 + r * 0.45);
  }
  const callable = eq >= potOdds * (1.15 - aggr * 0.3) || (toCall <= bb && strength > 0.75);
  if (callable) return { action: 'call' };
  if (r < 0.03 && toCall < p.stack * 0.15) return { action: 'call' };
  return { action: 'fold' };
}

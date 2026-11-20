import { evaluate } from './cards.js';

// Monte Carlo odds for the hero's hand against `opps` random opponent hands.
// Returns win / tie / lose fractions, equity (win + share of splits) and the
// distribution of the hero's final hand category.
export function analyze(hole, board, opps, iters = 1600) {
  const used = new Set([...hole, ...board]);
  const rest = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) rest.push(c);
  opps = Math.max(1, Math.min(opps, 9));
  const need = opps * 2 + (5 - board.length);
  const cats = new Array(9).fill(0);
  let win = 0, tie = 0, share = 0;
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < need; k++) {
      const j = k + Math.floor(Math.random() * (rest.length - k));
      const t = rest[k]; rest[k] = rest[j]; rest[j] = t;
    }
    const b = board.concat(rest.slice(opps * 2, need));
    const me = evaluate(hole.concat(b));
    cats[me.cat]++;
    let beaten = false, ties = 0;
    for (let o = 0; o < opps; o++) {
      const s = evaluate([rest[2 * o], rest[2 * o + 1], ...b]).score;
      if (s > me.score) { beaten = true; break; }
      if (s === me.score) ties++;
    }
    if (beaten) continue;
    if (ties) { tie++; share += 1 / (ties + 1); } else { win++; share += 1; }
  }
  return {
    win: win / iters, tie: tie / iters, lose: 1 - (win + tie) / iters,
    equity: share / iters, cats: cats.map((n) => n / iters), opps, iters,
  };
}

// Cards that would improve the hero's made hand on the next card (flop / turn only).
// A card only counts if it helps beyond what the board alone would already give.
export function findOuts(hole, board) {
  if (board.length < 3 || board.length > 4) return null;
  const cur = evaluate(hole.concat(board)).cat;
  const used = new Set([...hole, ...board]);
  const list = [];
  for (let c = 0; c < 52; c++) {
    if (used.has(c)) continue;
    const e = evaluate([...hole, ...board, c]).cat;
    if (e > cur && e > evaluate([...board, c]).cat) list.push(c);
  }
  const unseen = 52 - used.size;
  const k = list.length;
  const next = k / unseen;
  const river = board.length === 3 ? 1 - ((unseen - k) / unseen) * ((unseen - k - 1) / (unseen - 1)) : next;
  return { count: k, unseen, list, next, river, cards: board.length };
}

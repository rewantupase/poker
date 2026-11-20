// Cards are ints 0..51: rank = (c >> 2) + 2 (2..14), suit = c & 3
export const rankOf = (c) => (c >> 2) + 2;
export const suitOf = (c) => c & 3;

export const RANK_CH = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
// ︎ forces text (not emoji) rendering on iOS
export const SUIT_CH = ['♠︎', '♥︎', '♦︎', '♣︎'];
export const isRed = (c) => { const s = suitOf(c); return s === 1 || s === 2; };

const RANK_NAME = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
const plural = (r) => (r === 6 ? 'Sixes' : RANK_NAME[r] + 's');

export const CATEGORY = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

export function cardText(c) { return RANK_CH[rankOf(c)] + SUIT_CH[suitOf(c)]; }

export function newDeck() { const d = []; for (let i = 0; i < 52; i++) d.push(i); return d; }

function randInt(n) {
  const cr = globalThis.crypto;
  if (cr && cr.getRandomValues) {
    const a = new Uint32Array(1);
    const lim = Math.floor(0x100000000 / n) * n;
    let x;
    do { cr.getRandomValues(a); x = a[0]; } while (x >= lim);
    return x % n;
  }
  return Math.floor(Math.random() * n);
}

export function shuffle(d) {
  for (let i = d.length - 1; i > 0; i--) { const j = randInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

function straightHigh(mask) {
  for (let h = 14; h >= 5; h--) { const m = 0b11111 << (h - 4); if ((mask & m) === m) return h; }
  return 0;
}

function describe(cat, k) {
  switch (cat) {
    case 0: return `${RANK_NAME[k[0]]} High`;
    case 1: return `Pair of ${plural(k[0])}`;
    case 2: return `Two Pair, ${plural(k[0])} & ${plural(k[1])}`;
    case 3: return `Three of a Kind, ${plural(k[0])}`;
    case 4: return `Straight, ${RANK_NAME[k[0]]} High`;
    case 5: return `Flush, ${RANK_NAME[k[0]]} High`;
    case 6: return `Full House, ${plural(k[0])} over ${plural(k[1])}`;
    case 7: return `Four of a Kind, ${plural(k[0])}`;
    case 8: return k[0] === 14 ? 'Royal Flush' : `Straight Flush, ${RANK_NAME[k[0]]} High`;
  }
  return '';
}

function mk(cat, ks) {
  let v = cat;
  for (let i = 0; i < 5; i++) v = v * 16 + (ks[i] || 0);
  return { score: v, cat, name: describe(cat, ks), short: CATEGORY[cat] };
}

// Evaluate best 5-card hand out of 5..7 cards. Higher score wins.
export function evaluate(cards) {
  const rc = new Array(15).fill(0);
  const sc = [0, 0, 0, 0];
  const sm = [0, 0, 0, 0];
  let mask = 0;
  for (const c of cards) {
    const r = rankOf(c), s = suitOf(c);
    rc[r]++; sc[s]++; sm[s] |= 1 << r; mask |= 1 << r;
  }
  if (mask & (1 << 14)) mask |= 2;
  let flush = -1;
  for (let s = 0; s < 4; s++) {
    if (sc[s] >= 5) {
      flush = s;
      let fm = sm[s];
      if (fm & (1 << 14)) fm |= 2;
      const sh = straightHigh(fm);
      if (sh) return mk(8, [sh]);
    }
  }
  const quads = [], trips = [], pairs = [], singles = [];
  for (let r = 14; r >= 2; r--) {
    const n = rc[r];
    if (n === 4) quads.push(r); else if (n === 3) trips.push(r); else if (n === 2) pairs.push(r); else if (n === 1) singles.push(r);
  }
  const kickers = (exclude, count) => {
    const out = [];
    for (let r = 14; r >= 2 && out.length < count; r--) if (rc[r] > 0 && !exclude.includes(r)) out.push(r);
    return out;
  };
  if (quads.length) return mk(7, [quads[0], ...kickers([quads[0]], 1)]);
  if (trips.length && (trips.length >= 2 || pairs.length)) {
    return mk(6, [trips[0], Math.max(trips[1] || 0, pairs[0] || 0)]);
  }
  if (flush >= 0) {
    const ks = [];
    for (let r = 14; r >= 2 && ks.length < 5; r--) if (sm[flush] & (1 << r)) ks.push(r);
    return mk(5, ks);
  }
  const sh = straightHigh(mask);
  if (sh) return mk(4, [sh]);
  if (trips.length) return mk(3, [trips[0], ...kickers([trips[0]], 2)]);
  if (pairs.length >= 2) return mk(2, [pairs[0], pairs[1], ...kickers([pairs[0], pairs[1]], 1)]);
  if (pairs.length === 1) return mk(1, [pairs[0], ...kickers([pairs[0]], 3)]);
  return mk(0, kickers([], 5));
}

// The exact 5 cards making the best hand (for highlighting)
export function bestFive(cards, score) {
  if (cards.length <= 5) return cards.slice();
  const target = score ?? evaluate(cards).score;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const h = [cards[a], cards[b], cards[c], cards[d], cards[e]];
      if (evaluate(h).score === target) return h;
    }
  return cards.slice(0, 5);
}

// Friendly label for 2 hole cards preflop
export function describeHole(cards) {
  if (!cards || cards.length < 2) return '';
  const [a, b] = cards;
  const ra = rankOf(a), rb = rankOf(b);
  if (ra === rb) return `Pocket ${plural(ra)}`;
  const hi = Math.max(ra, rb), lo = Math.min(ra, rb);
  const s = suitOf(a) === suitOf(b) ? 'suited' : 'offsuit';
  return `${RANK_CH[hi]}-${RANK_CH[lo]} ${s}`;
}

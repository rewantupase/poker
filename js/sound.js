let ctx = null;
let enabled = localStorage.getItem('felt.sound') !== '0';

export function unlockAudio() {
  if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
  if (ctx && ctx.state === 'suspended') ctx.resume();
}
export const isSoundOn = () => enabled;
export function setSound(on) { enabled = on; localStorage.setItem('felt.sound', on ? '1' : '0'); }

function tone(freq, dur, type = 'sine', vol = 0.12, when = 0) {
  if (!ctx || !enabled) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, freq, when = 0) {
  if (!ctx || !enabled) return;
  const t = ctx.currentTime + when;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
  const g = ctx.createGain(); g.gain.value = vol;
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
}

export const sfx = {
  card: () => noise(0.05, 0.32, 2800),
  deal: () => { noise(0.05, 0.35, 2800); noise(0.05, 0.3, 2600, 0.07); },
  board: () => { noise(0.05, 0.3, 2800); },
  chip: () => { tone(2400, 0.05, 'triangle', 0.07); tone(3100, 0.06, 'triangle', 0.05, 0.035); tone(2700, 0.05, 'triangle', 0.04, 0.07); },
  check: () => { tone(160, 0.06, 'sine', 0.3); tone(150, 0.06, 'sine', 0.25, 0.09); },
  fold: () => noise(0.14, 0.18, 1200),
  turn: () => { tone(988, 0.12, 'sine', 0.09); tone(1319, 0.18, 'sine', 0.08, 0.1); },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.08, i * 0.09)),
  tap: () => tone(1800, 0.02, 'sine', 0.03),
};

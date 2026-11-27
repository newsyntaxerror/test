// 다인이 리믹스 스튜디오 — 내장 신스 비트 엔진 (Web Audio, 외부 음원/저작권 없음)
// 순수 JS DSP로 4종 프리셋(테크노/하우스/트랩/Lo-fi)을 만들어 AudioBuffer로 반환한다.

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GENRES = {
  techno: { label: '테크노', bpm: 140, root: 33, color: '#FF2A85' },
  house: { label: '하우스', bpm: 128, root: 36, color: '#FF7AC8' },
  trap: { label: '트랩', bpm: 145, root: 29, color: '#9D6BFF' },
  lofi: { label: 'Lo-fi', bpm: 90, root: 41, color: '#7BC8A4' },
};

// ────────────────────────────────────────────────────────────────
// 한 곡 전체(타임라인) 길이의 비트 버퍼를 합성한다.
// spec = { genre, bpm, total, sections:[{start,dur,kind,beatOn}] }
// ────────────────────────────────────────────────────────────────
export function buildBeat(ctx, spec) {
  const sr = ctx.sampleRate;
  const total = Math.max(0.5, spec.total);
  const n = Math.ceil(total * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const rnd = mulberry32(0x51ce);
  const bpm = spec.bpm || 140;
  const beat = 60 / bpm, bar = beat * 4, step = bar / 16;
  const genre = spec.genre || 'techno';
  const root = GENRES[genre] ? GENRES[genre].root : 33;

  const panGain = (p) => [Math.cos(((p + 1) * Math.PI) / 4), Math.sin(((p + 1) * Math.PI) / 4)];

  function put(i, v, pan = 0) {
    if (i < 0 || i >= n) return;
    const [gl, gr] = panGain(pan);
    L[i] += v * gl; R[i] += v * gr;
  }
  const idx = (t) => Math.floor(t * sr);

  // ── 드럼/악기 보이스 ──────────────────────────────────────
  function kick(t, amp = 1, opt = {}) {
    const long = !!opt.long;
    const dur = long ? 1.1 : 0.42;
    const s0 = idx(t);
    let ph = 0;
    const f0 = long ? 58 : 52, fdrop = long ? 70 : 150;
    const decay = long ? 2.2 : 7.5;
    for (let k = 0; k < dur * sr; k++) {
      const p = k / sr;
      const f = f0 + fdrop * Math.exp(-p * (long ? 14 : 34));
      ph += (2 * Math.PI * f) / sr;
      let s = Math.sin(ph) * Math.exp(-p * decay);
      s += (rnd() * 2 - 1) * Math.exp(-p * 180) * 0.45;
      s = Math.tanh(s * 1.6) * amp;
      put(s0 + k, s * 0.92, 0);
    }
  }

  function sub(t, dur, freq, amp = 1) {
    const s0 = idx(t), len = Math.min(dur * sr, n - s0);
    let ph = 0;
    for (let k = 0; k < len; k++) {
      const p = k / sr;
      const f = freq * (1 + 0.06 * Math.exp(-p * 8));
      ph += (2 * Math.PI * f) / sr;
      const env = Math.min(1, p / 0.012) * Math.exp(-p * (1.1 / Math.max(0.25, dur)));
      put(s0 + k, Math.tanh(Math.sin(ph) * env * amp * 1.5) * 0.85, 0);
    }
  }

  function snare(t, amp = 1, tone = 190) {
    const s0 = idx(t), dur = 0.19;
    let ph = 0;
    for (let k = 0; k < dur * sr; k++) {
      const p = k / sr;
      ph += (2 * Math.PI * tone) / sr;
      const env = Math.exp(-p * 26);
      const noise = (rnd() * 2 - 1) * Math.exp(-p * 18);
      const v = (Math.sin(ph) * 0.35 + noise * 0.8) * env * amp;
      put(s0 + k, v * 0.75, 0.05);
    }
  }

  function clap(t, amp = 1) {
    const s0 = idx(t);
    const taps = [0, 0.008, 0.017, 0.026];
    for (const off of taps) {
      const st = s0 + Math.floor(off * sr);
      const len = Math.floor(0.09 * sr);
      for (let k = 0; k < len; k++) {
        const p = k / sr;
        const env = Math.exp(-p * (off === 0.026 ? 55 : 120));
        put(st + k, (rnd() * 2 - 1) * env * amp * 0.5, -0.15);
      }
    }
  }

  function hat(t, amp = 1, open = false) {
    const s0 = idx(t);
    const dur = open ? 0.16 : 0.045;
    let lp = 0, hpPrev = 0;
    for (let k = 0; k < dur * sr; k++) {
      const p = k / sr;
      const nz = rnd() * 2 - 1;
      lp += (nz - lp) * 0.35;         // 1-pole lowpass → highpass = nz - lp
      const hp = nz - lp;
      const env = Math.exp(-p * (open ? 16 : 55));
      put(s0 + k, hp * env * amp * 0.42, open ? 0.25 : -0.25);
    }
  }

  function bass(t, dur, freq, amp = 1, bright = 0.5) {
    const s0 = idx(t), len = Math.min(dur * sr, n - s0);
    let ph = 0, lp = 0;
    const cut = 0.08 + bright * 0.22;
    for (let k = 0; k < len; k++) {
      const p = k / sr;
      ph += (2 * Math.PI * freq) / sr;
      const saw = ((ph / (2 * Math.PI)) % 1) * 2 - 1;
      lp += (saw - lp) * cut;
      const env = Math.min(1, p / 0.006) * Math.exp(-p * (2.4 / Math.max(0.12, dur)));
      put(s0 + k, lp * env * amp * 0.4, 0);
    }
  }

  function acid(t, dur, freq, amp = 1, cut0 = 400, res = 0.55) {
    const s0 = idx(t), len = Math.min(dur * sr, n - s0);
    let ph = 0, low = 0, band = 0;
    for (let k = 0; k < len; k++) {
      const p = k / sr;
      ph += (2 * Math.PI * freq) / sr;
      const saw = 2 * (((ph / (2 * Math.PI)) % 1)) - 1;
      const fc = cut0 + 2600 * Math.exp(-p * 16);
      const f = 2 * Math.sin((Math.PI * Math.min(fc, sr * 0.45)) / sr);
      low += f * band;
      const high = saw - low - res * band;
      band += f * high;
      const env = Math.min(1, p / 0.004) * Math.exp(-p * (5.5 / Math.max(0.06, dur)));
      put(s0 + k, Math.tanh(low * 2.2) * env * amp * 0.3, 0.2);
    }
  }

  function stab(t, dur, midis, amp = 1) {
    const s0 = idx(t), len = Math.min(dur * sr, n - s0);
    const freqs = midis.map(mtof);
    for (let k = 0; k < len; k++) {
      const p = k / sr;
      let v = 0;
      for (const f of freqs) v += Math.sin(2 * Math.PI * f * p) * 0.5 + Math.sin(4 * Math.PI * f * p) * 0.15;
      const env = Math.min(1, p / 0.005) * Math.exp(-p * (6 / Math.max(0.08, dur)));
      put(s0 + k, (v / freqs.length) * env * amp * 0.42, 0.1);
    }
  }

  function pad(t, dur, midis, amp = 1) {
    const s0 = idx(t), len = Math.min(dur * sr, n - s0);
    const freqs = midis.map(mtof);
    for (let k = 0; k < len; k++) {
      const p = k / sr;
      let v = 0;
      for (const f of freqs) {
        v += Math.sin(2 * Math.PI * f * p + Math.sin(p * 3.1) * 0.6) * 0.4;
        v += Math.sin(2 * Math.PI * f * 1.004 * p) * 0.25;
      }
      const env = Math.min(1, p / 0.25) * Math.min(1, (len / sr - p) / 0.35);
      put(s0 + k, (v / freqs.length) * env * amp * 0.32, -0.1);
    }
  }

  function riser(t, dur, amp = 1) {
    const s0 = idx(t), len = Math.min(dur * sr, n - s0);
    let lp = 0;
    for (let k = 0; k < len; k++) {
      const p = k / sr, x = p / dur;
      const nz = rnd() * 2 - 1;
      const cut = 0.02 + 0.5 * x * x;
      lp += (nz - lp) * cut;
      const v = lp * Math.pow(x, 1.6) * amp * 0.5;
      put(s0 + k, v, Math.sin(x * 9) * 0.3);
    }
  }

  function vinyl(t, dur, amp = 0.05) {
    const s0 = idx(t), len = Math.min(dur * sr, n - s0);
    let lp = 0;
    for (let k = 0; k < len; k++) {
      const nz = rnd() * 2 - 1;
      lp += (nz - lp) * 0.35;
      let v = lp * amp;
      if (rnd() < 0.00035) v += (rnd() * 2 - 1) * 0.08;
      put(s0 + k, v, 0);
    }
  }

  // ── 마디 단위 패턴 ──────────────────────────────────────
  const SCALE_TECHNO = [0, 0, 7, 5];
  const ACID = [0, 12, 3, 7, 10, 0, 15, 12, 0, 7, 3, 10, 12, 0, 7, 3];
  const HOUSE_CHORDS = [[0, 3, 7, 10], [0, 3, 7, 10], [-2, 3, 5, 10], [0, 3, 7, 14]];
  const LOFI_CHORDS = [[9, 12, 16, 19], [5, 9, 12, 16], [0, 4, 7, 11], [7, 11, 14, 17]];

  function drop(start, bars, energy) {
    const e = energy == null ? 1 : energy;
    for (let b = 0; b < bars; b++) {
      const bt = start + b * bar;
      const cycl = b % 4;
      if (genre === 'techno') {
        for (const s of [0, 4, 8, 12]) kick(bt + s * step, e);
        clap(bt + 4 * step, 0.85 * e); clap(bt + 12 * step, 0.85 * e);
        for (let s = 2; s < 16; s += 4) hat(bt + s * step, 0.55 * e, true);
        if (b >= bars - 2 || e > 0.8) for (let s = 1; s < 16; s += 2) hat(bt + s * step, 0.2 * e);
        for (let s = 0; s < 16; s += 2) {
          if (s % 4 === 0) continue;
          const note = root + SCALE_TECHNO[(s / 2) % 4 | 0] + (b % 2 ? 12 : 0);
          bass(bt + s * step, step * 1.7, mtof(note), 1.0 * e, 0.6);
        }
        for (let s = 0; s < 16; s++) {
          if (s % 8 === 3 && cycl % 2) continue;
          const note = root + 12 + ACID[(s + b * 3) % 16];
          const acc = s % 4 === 0 ? 1.15 : 0.8;
          acid(bt + s * step, step * 0.9, mtof(note), acc * e, 360 + (s % 3) * 120, 0.62);
        }
      } else if (genre === 'house') {
        for (const s of [0, 4, 8, 12]) kick(bt + s * step, e);
        for (const s of [2, 6, 10, 14]) hat(bt + s * step, 0.5 * e, true);
        for (let s = 0; s < 16; s += 2) hat(bt + s * step, 0.16 * e);
        clap(bt + 4 * step, 0.8 * e); clap(bt + 12 * step, 0.8 * e);
        for (const s of [2, 6, 10, 14]) bass(bt + s * step, step * 1.8, mtof(root + (s % 8 === 6 ? 7 : 0)), 0.95 * e, 0.5);
        for (const s of [3, 7, 11, 15]) stab(bt + s * step, step * 0.6, HOUSE_CHORDS[cycl].map((x) => x + root + 12), 0.9 * e);
      } else if (genre === 'trap') {
        kick(bt, 1.0 * e);
        if (b % 2 === 1) kick(bt + 6 * step, 0.9 * e);
        kick(bt + 10 * step, 0.85 * e);
        snare(bt + 8 * step, 1.0 * e, 230);
        for (let s = 0; s < 16; s += 2) hat(bt + s * step, 0.34 * e);
        if (b % 4 === 3) for (let s = 12; s < 16; s++) hat(bt + s * step, 0.24 * e);
        sub(bt, bar * 0.55, mtof(root + (b % 2 ? 3 : 0)), 1.0 * e);
        sub(bt + 10 * step, bar * 0.32, mtof(root + 7), 0.8 * e);
        if (b % 4 === 0) stab(bt + 14 * step, step * 2, [root + 12, root + 19, root + 24], 0.5 * e);
      } else { // lofi
        kick(bt, 0.95 * e); kick(bt + 10 * step, 0.8 * e, { long: true });
        snare(bt + 4 * step, 0.55 * e, 165); snare(bt + 12 * step, 0.5 * e, 165);
        for (let s = 0; s < 16; s += 2) hat(bt + s * step + (s % 4 ? 0.012 : 0), 0.16 * e);
        pad(bt, bar * 0.98, LOFI_CHORDS[cycl].map((x) => x + 12), 0.9 * e);
        bass(bt + 2 * step, step * 2.4, mtof(root - 12 + LOFI_CHORDS[cycl][0]), 0.7 * e, 0.25);
        bass(bt + 10 * step, step * 2.4, mtof(root - 12 + LOFI_CHORDS[cycl][2]), 0.6 * e, 0.25);
      }
    }
  }

  function intro(start, bars) {
    for (let b = 0; b < bars; b++) {
      const bt = start + b * bar;
      if (genre === 'trap') {
        for (let s = 0; s < 16; s += 2) hat(bt + s * step, 0.18);
        if (b >= bars - 1) snare(bt + 8 * step, 0.4, 220);
      } else if (genre === 'lofi') {
        pad(bt, bar, LOFI_CHORDS[b % 4].map((x) => x + 12), 0.7);
        for (let s = 0; s < 16; s += 2) hat(bt + s * step, 0.1);
      } else {
        for (let s = 0; s < 16; s += 2) hat(bt + s * step, 0.2);
        for (const s of [2, 6, 10, 14]) hat(bt + s * step, 0.4, true);
        if (b >= 1) kick(bt, 0.75);
        if (b >= bars - 1) clap(bt + 4 * step, 0.5);
      }
    }
    if (bars > 0) riser(start + Math.max(0, (bars - 1) * bar), Math.min(bar, bars * bar), 0.9);
  }

  function breakdown(start, bars) {
    if (bars <= 0) return;
    const chords = genre === 'lofi' ? LOFI_CHORDS : HOUSE_CHORDS;
    for (let b = 0; b < bars; b++) {
      const bt = start + b * bar;
      pad(bt, bar, chords[b % 4].map((x) => x + root + 12), 0.75);
    }
    riser(start + Math.max(0, (bars - 1) * bar - bar * 0.25), bar * 1.25, 0.75);
    hat(start + (bars - 1) * bar + 14 * step, 0.25, true);
  }

  function outro(start, bars) {
    for (let b = 0; b < bars; b++) {
      const bt = start + b * bar;
      const fade = Math.max(0, 1 - b / Math.max(1, bars));
      kick(bt, 0.8 * fade, { long: true });
      hat(bt + 2 * step, 0.3 * fade, true);
      hat(bt + 6 * step, 0.3 * fade, true);
      if (genre === 'lofi') pad(bt, bar, LOFI_CHORDS[b % 4].map((x) => x + 12), 0.5 * fade);
    }
  }

  // ── 타임라인 렌더 ────────────────────────────────────────
  const secs = (spec.sections || []).slice();
  if (!secs.length) secs.push({ start: 0, dur: total, kind: 'drop', beatOn: true });

  if (genre === 'lofi') vinyl(0, total, 0.045);

  secs.forEach((sec, i) => {
    if (!sec.beatOn) return;
    const bars = sec.dur / bar;
    if (bars < 0.05) return;
    const kind = sec.kind || 'drop';
    if (kind === 'intro') intro(sec.start, bars);
    else if (kind === 'break') breakdown(sec.start, bars);
    else if (kind === 'outro') outro(sec.start, bars);
    else drop(sec.start, bars, kind === 'drop2' ? 1.05 : 1);
  });

  // ── 마스터 버스: 소프트 클립 + 살짝의 스테레오 감쇠 ─────
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const l = Math.tanh(L[i] * 0.9), r = Math.tanh(R[i] * 0.9);
    L[i] = l; R[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  const norm = peak > 0.89 ? 0.89 / peak : 1;
  for (let i = 0; i < n; i++) { L[i] *= norm; R[i] *= norm; }

  const buf = ctx.createBuffer(2, n, sr);
  buf.copyToChannel(L, 0);
  buf.copyToChannel(R, 1);
  buf.__bars = Math.round(total / bar);
  return buf;
}

// 리버브용 임펄스 (짧고 밝은 스튜디오 룸)
export function makeIR(ctx, seconds = 1.7, decay = 3.6) {
  const sr = ctx.sampleRate;
  const n = Math.ceil(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const rnd = mulberry32(0xbeef);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.pow(1 - i / n, decay) * Math.exp(-t * 1.2);
      d[i] = (rnd() * 2 - 1) * env * 0.55;
    }
    // 앞쪽 초기 반사
    for (const [ms, g] of [[11, 0.5], [19, 0.34], [27, 0.24], [41, 0.16]]) {
      const k = Math.floor((ms + c * 3) * sr / 1000);
      if (k < n) d[k] += g;
    }
  }
  return buf;
}

// 16bit PCM WAV 인코더 (브라우저 어디서나 저장 가능)
export function encodeWav(channels, sampleRate) {
  const numCh = channels.length;
  const len = channels[0].length;
  const buffer = new ArrayBuffer(44 + len * numCh * 2);
  const view = new DataView(buffer);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + len * numCh * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true); view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, len * numCh * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

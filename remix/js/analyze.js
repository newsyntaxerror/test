// 오디오 디코딩 · 파형 · 목소리 구간 감지 · BPM 추정

export async function decodeMedia(ctx, arrayBuffer) {
  const ab = arrayBuffer.slice(0); // decodeAudioData가 버퍼를 detach 하므로 복사본 사용
  return await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve).catch(reject);
  });
}

export function mixToMono(buffer) {
  const n = buffer.length;
  const ch = buffer.numberOfChannels;
  if (ch === 1) return buffer.getChannelData(0);
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i];
}

// 목소리/옹알이 구간 자동 감지 — 최대 12개
export function detectVoice(buffer, opts = {}) {
  const maxSegments = opts.maxSegments || 12;
  const sr = buffer.sampleRate;
  const mono = mixToMono(buffer);

  // 고역 강조(프리엠퍼시스)로 목소리를 배경음보다 띄운다
  const emph = new Float32Array(mono.length);
  for (let i = 1; i < mono.length; i++) emph[i] = mono[i] - 0.92 * mono[i - 1];

  const hop = Math.max(128, Math.round(sr * 0.01));
  const win = hop * 2;
  const frames = Math.max(1, Math.floor((emph.length - win) / hop));
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const off = f * hop;
    for (let i = 0; i < win; i++) { const v = emph[off + i]; s += v * v; }
    db[f] = 10 * Math.log10(s / win + 1e-12);
  }
  // 3프레임 중앙값 스무딩
  const sm = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = db[Math.max(0, f - 1)], b = db[f], c = db[Math.min(frames - 1, f + 1)];
    sm[f] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  const sorted = Array.from(sm).sort((x, y) => x - y);
  const floor = percentile(sorted, 0.2);
  const top = percentile(sorted, 0.95);
  const thr = floor + Math.min(16, Math.max(5, 0.45 * (top - floor)));

  const frameSec = hop / sr;
  const runs = [];
  let start = -1;
  for (let f = 0; f < frames; f++) {
    if (sm[f] >= thr && start < 0) start = f;
    if ((sm[f] < thr || f === frames - 1) && start >= 0) {
      runs.push([start, sm[f] >= thr ? f : f - 1]);
      start = -1;
    }
  }

  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && (r[0] - last[1]) * frameSec < 0.11) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }

  const segs = [];
  const pad = 0.04;
  const minLen = 0.09;
  for (const [a, b] of merged) {
    let t0 = Math.max(0, a * frameSec - pad);
    let t1 = Math.min(buffer.duration, b * frameSec + pad);
    if (t1 - t0 < minLen) continue;
    // 너무 긴 구간(배경음이 계속 깔린 경우)은 1.2초 단위로 쪼갠다
    if (t1 - t0 > 2.8) {
      const chunks = Math.ceil((t1 - t0) / 1.2);
      const len = (t1 - t0) / chunks;
      for (let k = 0; k < chunks; k++) segs.push([t0 + k * len, t0 + (k + 1) * len]);
    } else segs.push([t0, t1]);
  }

  const out = segs.map(([a, b]) => {
    const fa = Math.floor(a / frameSec), fb = Math.min(frames - 1, Math.ceil(b / frameSec));
    let peak = -Infinity, sum = 0, cnt = 0;
    for (let f = fa; f <= fb; f++) { peak = Math.max(peak, sm[f]); sum += sm[f]; cnt++; }
    const rel = (sum / Math.max(1, cnt)) - floor;
    return {
      start: +a.toFixed(3),
      end: +b.toFixed(3),
      score: +(rel * Math.pow(b - a, 0.3)).toFixed(2),
      level: +rel.toFixed(1),
    };
  }).filter((s) => s.end - s.start >= minLen);

  out.sort((x, y) => y.score - x.score);
  const keep = out.slice(0, maxSegments);
  keep.sort((x, y) => x.start - y.start);
  keep.forEach((s, i) => { s.id = i; s.on = true; });
  return keep;
}

// 간이 BPM 추정 (온셋 자기상관 + 템포 사전확률)
export function estimateBpm(buffer) {
  const sr = buffer.sampleRate;
  const mono = mixToMono(buffer);
  const hop = Math.max(128, Math.round(sr * 0.01));
  const frames = Math.floor(mono.length / hop);
  if (frames < 60) return null;

  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const off = f * hop;
    for (let i = 0; i < hop; i++) { const v = mono[off + i]; sum += v * v; }
    env[f] = Math.sqrt(sum / hop);
  }
  // 온셋 강도 (반파 정류 + 국소 평균 제거)
  const onset = new Float32Array(frames);
  const w = 5;
  for (let f = 1; f < frames; f++) {
    let m = 0, c = 0;
    for (let k = Math.max(0, f - w); k <= Math.min(frames - 1, f + w); k++) { m += env[k]; c++; }
    onset[f] = Math.max(0, env[f] - m / c);
  }
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += onset[f];
  mean /= frames;
  for (let f = 0; f < frames; f++) onset[f] = onset[f] - mean * 0.5;

  const frameSec = hop / sr;
  const maxLag = Math.min(frames - 2, Math.round(1.25 / frameSec));
  const ac = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let acc = 0;
    for (let f = 0; f + lag < frames; f++) acc += onset[f] * onset[f + lag];
    ac[lag] = acc / (frames - lag);
  }

  let best = null;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = 60 / bpm / frameSec;
    if (lag < 1.5) continue;
    let score = 0, wsum = 0;
    const weights = [1, 0.6, 0.4, 0.28];
    for (let m = 1; m <= 4; m++) {
      const l = lag * m;
      if (l > maxLag) break;
      const i0 = Math.floor(l), frac = l - i0;
      const v = ac[i0] * (1 - frac) + (ac[Math.min(maxLag, i0 + 1)] || 0) * frac;
      score += v * weights[m - 1];
      wsum += weights[m - 1];
    }
    score /= Math.max(0.001, wsum);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 118) / 0.62, 2));
    const s = score * prior;
    if (!best || s > best.s) best = { bpm, s, raw: score };
  }
  if (!best || !isFinite(best.bpm)) return null;
  let bpm = best.bpm;
  if (bpm < 80) bpm *= 2;
  if (bpm > 180) bpm /= 2;
  return { bpm: Math.round(bpm), confidence: +best.s.toFixed(3) };
}

export function waveformPeaks(buffer, bins = 1200) {
  const mono = mixToMono(buffer);
  const n = mono.length;
  const step = n / bins;
  const mins = new Float32Array(bins), maxs = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const a = Math.floor(b * step), z = Math.min(n, Math.floor((b + 1) * step));
    let mn = 0, mx = 0;
    for (let i = a; i < z; i++) { const v = mono[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    mins[b] = mn; maxs[b] = mx;
  }
  return { mins, maxs, duration: buffer.duration };
}

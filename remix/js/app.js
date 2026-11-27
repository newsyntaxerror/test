// 다인이 리믹스 스튜디오 — 앱 로직
import { loadAssets, drawScene, drawWave, setCustomLogo, canvasToBlob, W, H } from './draw.js';
import { decodeMedia, detectVoice, estimateBpm, waveformPeaks } from './analyze.js';
import { buildBeat, makeIR, encodeWav, GENRES } from './dsp.js';
import { buildArrangement, defaultSections, fitToSeconds, totalBeats, newSection, labelFor, SECTION_KINDS } from './arrange.js';
import { BUILTINS, loadUserFormats, saveUserFormats, cloneFormat } from './formats.js';
import { tryYoutube } from './yt.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const LS_STATE = 'daini-remix.state.v2';

const S = {
  voice: null,          // {name, buffer, peaks, segments, duration}
  videoUrl: null,
  videoDur: 0,
  beatMode: 'synth',
  genre: 'techno',
  bpm: 140,
  backing: null,        // {name, buffer, peaks, duration}
  trim: { start: 0, end: 0 },
  offsetBack: 0,
  sections: defaultSections(),
  mix: { voiceVol: 1, beatVol: 0.8, reverb: 0.18, pitch: 1 },
  fmtId: 'ver1',
  fmt: cloneFormat(BUILTINS[0]),
  userFormats: [],
  autoEdit: true,
  cutBeats: 4,
  punch: 0.045,
  flash: 0.1,
  pulse: true,
  fitY: 0.42,
  title1: '뿌애!',
  title2: '*140*BPM 테크노 리믹스',
  lenUnit: 'sec',
  arr: null,
};

const el = {};
let actx = null;
let beatCache = { key: '', buf: null, rate: 0 };
let playing = false;
let playState = null;
let rafId = 0;
let staticT = 0.6;
let drawTimer = 0;

// ──────────────────────────────────────────────────────
// 오디오 컨텍스트
function audioCtx() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC({ latencyHint: 'interactive' });
  }
  return actx;
}

// ──────────────────────────────────────────────────────
// 영상 컷 재생 엔진 (여러 video 엘리먼트를 미리 시킹해 끊김 없이 점프컷)
class CutEngine {
  constructor() {
    this.els = [];
    this.shots = [];
    this.prepared = new Map();
    this.activeIdx = -1;
    this.activeEl = null;
    this.url = null;
    this.generation = 0;
  }

  ensureEls() {
    if (this.els.length) return;
    for (let i = 0; i < 3; i++) {
      const v = document.createElement('video');
      v.muted = true;
      v.defaultMuted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      v.preload = 'auto';
      v.loop = true;
      v.style.cssText = 'position:fixed;left:-4px;top:-4px;width:2px;height:2px;opacity:.01;pointer-events:none';
      document.body.appendChild(v);
      this.els.push(v);
    }
  }

  setSource(url) {
    this.generation++;
    this.pauseAll();
    this.url = url;
    this.prepared.clear();
    this.activeIdx = -1;
    this.activeEl = null;
    if (!url) return;
    this.ensureEls();
    this.els.forEach((v) => {
      v.src = url;
      try { v.load(); } catch (e) {}
    });
  }

  setShots(shots) {
    this.shots = shots || [];
    this.prepared.clear();
    this.pauseAll();
    this.activeIdx = -1;
    this.prime(0);
  }

  indexAt(t) {
    const shots = this.shots;
    if (!shots.length) return -1;
    let lo = 0, hi = shots.length - 1;
    if (t < shots[0].tStart) return 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = shots[mid];
      if (t < s.tStart) hi = mid - 1;
      else if (t >= s.tEnd) lo = mid + 1;
      else return mid;
    }
    return clamp(lo, 0, shots.length - 1);
  }

  spare() {
    const busy = new Set(this.prepared.values());
    if (this.activeEl) busy.add(this.activeEl);
    return this.els.find((e) => !busy.has(e)) || null;
  }

  seekTo(v, time) {
    return new Promise((resolve) => {
      const t = Math.max(0, time);
      if (Math.abs(v.currentTime - t) < 0.03 && v.readyState >= 2) return resolve();
      let done = false;
      const fin = () => { if (!done) { done = true; v.removeEventListener('seeked', fin); resolve(); } };
      v.addEventListener('seeked', fin);
      try { v.currentTime = t; } catch (e) { fin(); }
      setTimeout(fin, 900);
    });
  }

  async prime(idx) {
    if (idx < 0 || idx >= this.shots.length) return;
    if (this.prepared.has(idx)) return;
    const gen = this.generation;
    const v = this.spare();
    if (!v) return;
    this.prepared.set(idx, v);
    await this.seekTo(v, this.shots[idx].srcStart);
    if (gen !== this.generation) return;
    if (this.prepared.get(idx) === v && v !== this.activeEl) {
      try { v.pause(); } catch (e) {}
    }
  }

  async sync(t) {
    const idx = this.indexAt(t);
    if (idx < 0) return;
    if (idx === this.activeIdx) return;
    const shot = this.shots[idx];
    let v = this.prepared.get(idx);
    if (v) {
      this.prepared.delete(idx);
      if (this.activeEl && this.activeEl !== v) { try { this.activeEl.pause(); } catch (e) {} }
      this.activeEl = v;
      this.activeIdx = idx;
      try { await v.play(); } catch (e) {}
      this.syncRate();
    } else {
      // 준비된 엘리먼트가 없으면 현재 엘리먼트로 폴백(잠깐 멈췄다 이어짐)
      const f = this.activeEl || this.els[0];
      if (f) {
        this.activeIdx = idx;
        this.activeEl = f;
        await this.seekTo(f, shot.srcStart);
        try { await f.play(); } catch (e) {}
      }
    }
    this.prime(idx + 1);
    this.prime(idx + 2);
  }

  syncRate() {
    if (!this.activeEl) return;
    try { this.activeEl.playbackRate = 1; } catch (e) {}
  }

  async startAt(t) {
    this.pauseAll();
    this.activeIdx = -1;
    this.prepared.clear();
    await this.prime(this.indexAt(t));
    await this.sync(t + 0.001);
  }

  pauseAll() {
    this.els.forEach((v) => { try { v.pause(); } catch (e) {} });
  }

  async showStatic(t) {
    if (!this.shots.length || !this.els.length || !this.url) { drawPreview(t); return; }
    const idx = this.indexAt(t);
    const shot = this.shots[idx];
    if (!this.activeEl) this.activeEl = this.els[0];
    if (!this.activeEl) { drawPreview(t); return; }
    if (this.activeIdx !== idx) {
      this.activeIdx = idx;
      await this.seekTo(this.activeEl, shot.srcStart);
    }
    this.prime(idx + 1);
    this.draw();
  }

  draw() {
    const sc = sceneAt(staticT, this.activeEl);
    drawScene(el.previewCtx, { ...sc, scale: 0.5 });
  }
}

const engine = new CutEngine();

// ──────────────────────────────────────────────────────
// 편곡/장면 계산
function rebuild() {
  S.arr = buildArrangement(S);
  updateArrangeUI();
  engine.setShots(S.arr.shots);
  scheduleDraw();
  return S.arr;
}

function sectionAt(t) {
  const arr = S.arr;
  if (!arr) return null;
  for (const s of arr.sections) if (t >= s.start && t < s.end) return s;
  return arr.sections[arr.sections.length - 1] || null;
}

function beatEnv(t) {
  const arr = S.arr;
  if (!arr) return 0;
  const sec = sectionAt(t);
  const b = arr.beat;
  const phase = ((t % b) + b) % b;
  let e = Math.exp(-phase / (b * 0.30));
  if (sec && !sec.beat) e *= 0.2;
  return e;
}

function dropPunchAt(t) {
  const arr = S.arr;
  if (!arr) return 0;
  for (const s of arr.sections) {
    if (s.kind !== 'drop') continue;
    const dt = t - s.start;
    if (dt >= 0 && dt < 0.36) return 0.055 * (1 - dt / 0.36);
  }
  return 0;
}

function sceneAt(t, videoEl, opts = {}) {
  const env = beatEnv(t);
  return {
    fmt: S.fmt,
    video: videoEl || null,
    t,
    env,
    punch: S.punch,
    flash: S.flash * env,
    pulse: S.pulse,
    title1: S.title1,
    title2: S.title2,
    bpm: S.bpm,
    genreLabel: GENRES[S.genre].label,
    fitY: S.fitY,
    dropPunch: dropPunchAt(t),
    total: S.arr ? S.arr.total : 0,
    scale: opts.scale || 0.5,
  };
}

function drawPreview(t) {
  if (!el.previewCtx) return;
  const sc = sceneAt(t, engine.activeEl);
  drawScene(el.previewCtx, sc);
  el.playerTime.textContent = t.toFixed(1);
}

function scheduleDraw() {
  clearTimeout(drawTimer);
  drawTimer = setTimeout(() => {
    if (playing) return;
    engine.showStatic(staticT);
  }, 60);
}

// ──────────────────────────────────────────────────────
// 비트 버퍼 (캐시)
function beatSpec(arr) {
  return {
    genre: S.genre,
    bpm: S.bpm,
    total: arr.total,
    sections: arr.beatPlan.map((b) => ({ start: b.start, dur: b.dur, kind: b.kind, beatOn: b.beatOn })),
  };
}

function beatKey(arr) {
  return [S.genre, S.bpm, arr.total.toFixed(3), S.sections.map((s) => s.kind + s.beats + (s.beat ? 1 : 0)).join('|')].join('/');
}

async function getBeatBuffer(ctx, arr) {
  const key = beatKey(arr);
  if (beatCache.key === key && beatCache.buf && beatCache.rate === ctx.sampleRate) return beatCache.buf;
  // 합성이 메인스레드를 잠깐 막으므로 다음 프레임에 양보
  await new Promise((r) => setTimeout(r, 0));
  const buf = buildBeat(ctx, beatSpec(arr));
  beatCache = { key, buf, rate: ctx.sampleRate };
  return buf;
}

// ──────────────────────────────────────────────────────
// 믹스 스케줄 (미리듣기 = 실시간, WAV = 오프라인 공용)
function scheduleMix(ctx, out, arr, t0, beatBuf) {
  const stops = [];
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.gain.setValueAtTime(0.9, t0 + Math.max(0.1, arr.total - 0.06));
  master.gain.linearRampToValueAtTime(0.0001, t0 + arr.total + 0.02);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 20;
  comp.ratio.value = 3.2;
  comp.attack.value = 0.004;
  comp.release.value = 0.22;
  master.connect(comp);
  comp.connect(out);

  let conv = null, wetGain = null;
  if (S.mix.reverb > 0.002 && S.voice) {
    conv = ctx.createConvolver();
    conv.buffer = makeIR(ctx, 1.55, 3.2);
    wetGain = ctx.createGain();
    wetGain.gain.value = 0.85;
    conv.connect(wetGain);
    wetGain.connect(master);
  }

  // 반주
  if (S.beatMode === 'file' && S.backing) {
    const src = ctx.createBufferSource();
    src.buffer = S.backing.buffer;
    const g = ctx.createGain();
    g.gain.value = S.mix.beatVol * (S.backing.norm || 1);
    src.connect(g); g.connect(master);
    const trimStart = clamp(S.trim.start, 0, Math.max(0, S.backing.duration - 0.2));
    const trimEnd = clamp(S.trim.end, trimStart + 0.25, S.backing.duration);
    const startAt = clamp(trimStart + S.offsetBack, trimStart, trimEnd - 0.2);
    const loopEnd = Math.min(trimEnd, startAt + arr.bar * 4);
    src.loop = true;
    src.loopStart = startAt;
    src.loopEnd = Math.max(startAt + 0.2, loopEnd);
    src.start(t0, startAt);
    src.stop(t0 + arr.total + 0.05);
    stops.push(src);
  } else if (beatBuf) {
    const src = ctx.createBufferSource();
    src.buffer = beatBuf;
    const g = ctx.createGain();
    g.gain.value = S.mix.beatVol;
    src.connect(g); g.connect(master);
    src.start(t0, 0, Math.min(arr.total + 0.05, beatBuf.duration));
    stops.push(src);
  }

  // 목소리 구간
  if (S.voice && S.voice.buffer) {
    for (const ev of arr.voiceEvents) {
      const dur = (ev.bufEnd - ev.bufStart) / ev.rate;
      const at = t0 + ev.tStart;
      const src = ctx.createBufferSource();
      src.buffer = S.voice.buffer;
      try { src.playbackRate.value = ev.rate; } catch (e) {}
      const g = ctx.createGain();
      const vg = Math.max(0.0001, S.mix.voiceVol);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(vg, at + Math.min(0.012, dur * 0.2));
      g.gain.setValueAtTime(vg, at + Math.max(0.013, dur - 0.025));
      g.gain.linearRampToValueAtTime(0.0001, at + dur);
      src.connect(g);
      g.connect(master);
      if (conv) { const send = ctx.createGain(); send.gain.value = S.mix.reverb; g.connect(send); send.connect(conv); }
      try {
        src.start(at, ev.bufStart, ev.bufEnd - ev.bufStart);
        src.stop(at + dur + 0.04);
      } catch (e) {}
      stops.push(src);
    }
  }

  return {
    stop() {
      for (const s of stops) { try { s.stop(); } catch (e) {} }
      try { master.disconnect(); comp.disconnect(); } catch (e) {}
      if (conv) { try { conv.disconnect(); } catch (e) {} }
    },
  };
}

// ──────────────────────────────────────────────────────
// 미리보기 재생
async function play() {
  if (playing) { stopPlayback(); return; }
  if (!S.voice && !(S.beatMode === 'file' && S.backing)) {
    toast('먼저 다인 영상을 올려 주세요');
    return;
  }
  const ctx = audioCtx();
  try { await ctx.resume(); } catch (e) {}
  const arr = rebuild();
  if (!arr.total) return;
  const beatBuf = S.beatMode === 'synth' ? await getBeatBuffer(ctx, arr) : null;
  stopPlayback(true);
  const t0 = ctx.currentTime + 0.35;
  const mix = scheduleMix(ctx, ctx.destination, arr, t0, beatBuf);
  playState = { t0, mix, arr, start: performance.now() };
  playing = true;
  el.btnPlay.textContent = '■ 정지';
  el.btnStop.hidden = false;
  el.playDot.classList.add('on');
  await engine.startAt(0);
  loop();
}

function loop() {
  if (!playing || !playState) return;
  const ctx = audioCtx();
  const t = ctx.currentTime - playState.t0;
  const arr = playState.arr;
  if (t >= arr.total + 0.02) { stopPlayback(); return; }
  const show = Math.max(0, t);
  engine.sync(show);
  const sc = sceneAt(show, engine.activeEl);
  drawScene(el.previewCtx, sc);
  el.playerTime.textContent = show.toFixed(1);
  el.progressBar.style.width = `${clamp((show / arr.total) * 100, 0, 100)}%`;
  rafId = requestAnimationFrame(loop);
}

function stopPlayback(silent) {
  playing = false;
  cancelAnimationFrame(rafId);
  if (playState) { try { playState.mix.stop(); } catch (e) {} }
  playState = null;
  engine.pauseAll();
  el.btnPlay.textContent = '▶ 미리보기';
  el.btnStop.hidden = true;
  el.playDot.classList.remove('on');
  if (!silent) {
    el.progressBar.style.width = '0%';
    el.playerTime.textContent = '0.0';
    scheduleDraw();
  }
}

// ──────────────────────────────────────────────────────
// 파일 처리
async function onVoiceFile(file) {
  if (!file) return;
  setStatus('영상을 분석하는 중…');
  const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm|ogv)$/i.test(file.name);
  const url = URL.createObjectURL(file);
  let vDur = 0;
  if (isVideo) {
    if (S.videoUrl && S.videoUrl !== url) URL.revokeObjectURL(S.videoUrl);
    S.videoUrl = url;
    engine.setSource(url);
    vDur = await probeVideo(url);
    S.videoDur = vDur;
  } else {
    S.videoUrl = null;
    S.videoDur = 0;
    engine.setSource(null);
  }

  const ctx = audioCtx();
  let buf = null, err = null;
  try {
    const ab = await file.arrayBuffer();
    buf = await decodeMedia(ctx, ab);
  } catch (e) { err = e; }

  if (!buf) {
    S.voice = null;
    el.voiceLoaded.hidden = false;
    el.voiceName.textContent = file.name;
    el.voiceDur.textContent = vDur ? `${vDur.toFixed(1)}초 영상 · 오디오 없음` : '오디오 없음';
    el.segList.innerHTML = '';
    el.segCount.textContent = '0';
    el.segOn.textContent = '0';
    el.segHint.hidden = false;
    toast('오디오를 읽지 못했어요. 다른 형식(MP4/M4A)으로 저장해 보세요.');
    setStatus('오디오 없음 · 반주만 사용할 수 있어요');
    rebuild();
    return;
  }

  const segments = detectVoice(buf);
  const vp = peakOf(buf);
  const norm = clamp(0.55 / Math.max(0.01, vp), 0.6, 8);
  S.voice = { name: file.name, buffer: buf, segments, peaks: waveformPeaks(buf, 1400), duration: buf.duration, norm };
  el.voiceLoaded.hidden = false;
  el.voiceName.textContent = file.name;
  el.voiceDur.textContent = `${buf.duration.toFixed(1)}초${vDur ? ` · 영상 ${vDur.toFixed(1)}초` : ''}`;
  el.dropVoice.style.display = 'none';
  renderSegments();
  drawWave(el.waveVoice, S.voice.peaks, { markers: segments, color: 'rgba(255,255,255,.5)' });
  setStatus(`${segments.length}개 목소리 구간 · ${GENRES[S.genre].label} ${S.bpm} BPM`);
  rebuild();
  fitAutoTitles();
}

function peakOf(buffer) {
  let p = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 3) { const v = Math.abs(d[i]); if (v > p) p = v; }
  }
  return p;
}

function probeVideo(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.src = url;
    const done = () => resolve(isFinite(v.duration) ? v.duration : 0);
    v.addEventListener('loadedmetadata', done, { once: true });
    setTimeout(done, 4000);
  });
}

function renderSegments() {
  const segs = S.voice ? S.voice.segments : [];
  const list = el.segList;
  list.innerHTML = '';
  segs.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'seg' + (s.on ? '' : ' off');
    row.innerHTML = `
      <input type="checkbox" data-i="${i}" ${s.on ? 'checked' : ''} aria-label="구간 사용">
      <div class="time">${s.start.toFixed(2)}–${s.end.toFixed(2)}<em>${(s.end - s.start).toFixed(2)}초</em></div>
      <div class="nudge">
        <button class="mini" data-nudge="-1" data-i="${i}" title="시작점 50ms 앞으로" aria-label="시작 50ms 앞으로">◀</button>
        <button class="mini" data-nudge="1" data-i="${i}" title="시작점 50ms 뒤로" aria-label="시작 50ms 뒤로">▶</button>
      </div>
      <button class="mini" data-play="${i}" title="이 구간만 듣기" aria-label="이 구간 듣기">▶|</button>`;
    list.appendChild(row);
  });
  el.segCount.textContent = String(segs.length);
  el.segOn.textContent = String(segs.filter((s) => s.on).length);
  el.segHint.hidden = segs.length > 0;
}

function nudgeSeg(i, dir) {
  const s = S.voice && S.voice.segments[i];
  if (!s) return;
  const d = 0.05 * dir;
  const len = s.end - s.start;
  s.start = clamp(s.start + d, 0, Math.max(0, S.voice.duration - len - 0.01));
  s.end = s.start + len;
  renderSegments();
  drawWave(el.waveVoice, S.voice.peaks, { markers: S.voice.segments, color: 'rgba(255,255,255,.5)' });
  rebuild();
}

function playSegment(i) {
  const s = S.voice && S.voice.segments[i];
  if (!s) return;
  const ctx = audioCtx();
  ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = S.voice.buffer;
  const g = ctx.createGain();
  g.gain.value = S.mix.voiceVol;
  src.connect(g); g.connect(ctx.destination);
  src.start(0, s.start, s.end - s.start);
  toast(`구간 ${i + 1} · ${(s.end - s.start).toFixed(2)}초`);
}

function evenSplit() {
  if (!S.voice) return;
  const dur = S.voice.duration;
  const n = 8;
  const step = dur / n;
  S.voice.segments = Array.from({ length: n }, (_, i) => ({
    id: i,
    start: +(i * step + step * 0.08).toFixed(3),
    end: +((i + 1) * step - step * 0.05).toFixed(3),
    score: 1,
    level: 0,
    on: true,
  }));
  renderSegments();
  drawWave(el.waveVoice, S.voice.peaks, { markers: S.voice.segments, color: 'rgba(255,255,255,.5)' });
  rebuild();
  toast('8개 구간으로 균등 분할했어요');
}

function reanalyze() {
  if (!S.voice) return;
  S.voice.segments = detectVoice(S.voice.buffer);
  renderSegments();
  drawWave(el.waveVoice, S.voice.peaks, { markers: S.voice.segments, color: 'rgba(255,255,255,.5)' });
  rebuild();
  toast(`${S.voice.segments.length}개 구간을 다시 찾았어요`);
}

async function onBackFile(file) {
  if (!file) return;
  setStatus('음원을 분석하는 중…');
  const ctx = audioCtx();
  try {
    const ab = await file.arrayBuffer();
    const buf = await decodeMedia(ctx, ab);
    S.backing = { name: file.name, buffer: buf, peaks: waveformPeaks(buf, 1400), duration: buf.duration, norm: clamp(0.6 / Math.max(0.01, peakOf(buf)), 0.5, 6) };
    S.trim = { start: 0, end: Math.min(buf.duration, 30) };
    S.offsetBack = 0;
    S.beatMode = 'file';
    syncBeatMode();
    el.backLoaded.hidden = false;
    el.dropBack.style.display = 'none';
    el.backName.textContent = file.name;
    el.backDur.textContent = `${buf.duration.toFixed(1)}초`;
    el.trimStartNum.max = buf.duration.toFixed(1);
    el.trimEndNum.max = buf.duration.toFixed(1);
    el.trimStartNum.value = '0';
    el.trimEndNum.value = S.trim.end.toFixed(1);
    el.trimStart.min = 0; el.trimStart.max = 1000; el.trimStart.value = 0;
    el.trimEnd.min = 0; el.trimEnd.max = 1000; el.trimEnd.value = Math.round((S.trim.end / buf.duration) * 1000);
    el.offsetBack.value = '0';
    drawBackWave();
    const est = estimateBpm(buf);
    el.bpmEst.textContent = est ? `${est.bpm}` : '–';
    el.btnBpmApply.hidden = !est;
    el.btnBpmApply.dataset.bpm = est ? String(est.bpm) : '';
    rebuild();
    setStatus(`${file.name} · ${buf.duration.toFixed(1)}초${est ? ` · 추정 ${est.bpm} BPM` : ''}`);
    toast('음원을 불러왔어요. 쓸 구간을 골라 주세요');
  } catch (e) {
    toast('이 파일의 오디오를 읽지 못했어요 (MP3/M4A/WAV 권장)');
    setStatus('음원을 읽지 못했어요');
  }
}

function drawBackWave() {
  if (!S.backing) return;
  drawWave(el.waveBack, S.backing.peaks, {
    markers: [{ start: S.trim.start, end: S.trim.end, on: true }],
    selection: { start: S.trim.start, end: S.trim.end },
    color: 'rgba(0,245,212,.55)',
  });
}

// ──────────────────────────────────────────────────────
// UI 갱신
function setStatus(t) { el.subStatus.textContent = t; }

function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function updateArrangeUI() {
  const arr = S.arr;
  if (!arr) return;
  el.totalLen.textContent = arr.total.toFixed(1);
  el.totalLen2.textContent = arr.total.toFixed(1);
  el.totalBars.textContent = String(+(totalBeats(S.sections) / 4).toFixed(2));
  el.bpmLabel.textContent = String(S.bpm);
  el.cutCount.textContent = String(arr.cutCount);
  if (document.activeElement !== el.lenCustom) {
    el.lenCustom.value = S.lenUnit === 'sec' ? arr.total.toFixed(1) : String(+(totalBeats(S.sections) / 4).toFixed(2));
  }
  el.lenUnitLabel.textContent = S.lenUnit === 'sec' ? '초' : '마디';

  // 타임라인 바
  const bar = el.tlBar;
  bar.innerHTML = '';
  arr.sections.forEach((s) => {
    const d = document.createElement('div');
    d.className = s.kind;
    d.style.flex = `${Math.max(0.4, s.dur)} 0 0`;
    d.textContent = s.dur > arr.total * 0.11 ? s.label : '';
    if (s.voice) { const i = document.createElement('i'); d.appendChild(i); }
    d.title = `${s.label} · ${(s.dur).toFixed(1)}초`;
    bar.appendChild(d);
  });
  renderSections();
  renderFmtChips();
}

function renderSections() {
  const beat = 60 / S.bpm;
  const list = el.secList;
  list.innerHTML = '';
  S.sections.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'sec';
    const unit = s.unit || 'bar';
    const val = unit === 'bar' ? s.beats / 4 : (s.beats * beat);
    row.innerHTML = `
      <div class="sec-top">
        <div class="nm">${labelFor(S.sections, i)}<em>${(SECTION_KINDS[s.kind] || SECTION_KINDS.drop).tag}</em></div>
        <div class="sec-tools">
          <button class="tog ${s.voice ? 'on' : ''}" data-act="voice" data-i="${i}" title="목소리 넣기">🎤</button>
          <button class="tog ${s.beat ? 'on' : ''}" data-act="beat" data-i="${i}" title="비트 켜기">🥁</button>
          <button class="del" data-act="del" data-i="${i}" aria-label="구간 삭제">✕</button>
        </div>
      </div>
      <div class="ctl">
        <div class="len">
          <button data-act="minus" data-i="${i}">−</button>
          <input type="number" data-act="len" data-i="${i}" value="${+val.toFixed(unit === 'bar' ? 2 : 1)}" min="${unit === 'bar' ? 0.25 : 0.1}" step="${unit === 'bar' ? 0.5 : 0.1}">
          <button data-act="plus" data-i="${i}">+</button>
        </div>
        <button class="unit" data-act="unit" data-i="${i}">${unit === 'bar' ? '마디' : '초'}</button>
        <span class="secs">${(s.beats * beat).toFixed(1)}초</span>
      </div>`;
    list.appendChild(row);
  });
}

function renderFmtChips() {
  const box = el.fmtChips;
  box.innerHTML = '';
  const all = [...BUILTINS, ...S.userFormats];
  all.forEach((f) => {
    const b = document.createElement('div');
    b.className = 'fmtchip' + (f.id === S.fmtId ? ' on' : '');
    b.dataset.id = f.id;
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    b.innerHTML = `<i style="background:${f.accent || '#FF2A85'}"></i><span class="nm">${f.name}</span>${f.builtin ? '' : '<button class="x" aria-label="포맷 삭제">✕</button>'}`;
    b.addEventListener('click', (e) => {
      if (!f.builtin && e.target.closest('.x')) { deleteFormat(f.id); return; }
      applyFormat(f);
    });
    box.appendChild(b);
  });
}

function applyFormat(f) {
  S.fmtId = f.id;
  S.fmt = cloneFormat(f);
  if (f.logoData) loadCustomLogo(f.logoData);
  syncFormatInputs();
  renderFmtChips();
  saveState();
  scheduleDraw();
  setStatus(`${f.name} 포맷`);
}

function syncFormatInputs() {
  const f = S.fmt;
  el.fmtBg.value = toHex(f.bg || '#000000');
  el.fmtAccent.value = toHex(f.accent || '#FF2A85');
  el.fmtFont.value = String(f.fontScale || 1);
  el.fmtFontOut.textContent = `${Math.round((f.fontScale || 1) * 100)}%`;
  el.badgeLogo.value = (f.badge && f.badge.logo) || 'cat';
  el.badgeText.value = (f.badge && f.badge.text) || '다인이네';
  el.badgeText.disabled = !(f.badge && f.badge.show);
  el.btnDelFmt.hidden = !!f.builtin;
  el.dropLogo.hidden = ((f.badge && f.badge.logo) || 'cat') !== 'custom';
}

const toHex = (c) => (/^#/.test(c) && (c.length === 7 || c.length === 4) ? c : '#000000');

function loadCustomLogo(dataUrl) {
  const img = new Image();
  img.onload = () => { setCustomLogo(img); scheduleDraw(); };
  img.src = dataUrl;
}

function deleteFormat(id) {
  S.userFormats = S.userFormats.filter((f) => f.id !== id);
  saveUserFormats(S.userFormats);
  if (S.fmtId === id) applyFormat(BUILTINS[0]);
  else { renderFmtChips(); saveState(); }
  toast('포맷을 삭제했어요');
}

function saveCurrentFormat() {
  const box = document.getElementById('fmtSaveBox');
  if (box) { box.remove(); return; }
  const wrap = document.createElement('div');
  wrap.id = 'fmtSaveBox';
  wrap.className = 'row gap';
  wrap.style.marginTop = '10px';
  wrap.innerHTML = `<input id="fmtName" class="text" placeholder="포맷 이름 (예: 다인이네 핑크)" maxlength="20">
    <button id="fmtSaveOk" class="primary sm">저장</button>`;
  el.cardFormat.appendChild(wrap);
  const nameInput = wrap.querySelector('#fmtName');
  nameInput.value = S.fmt.builtin ? `${S.fmt.name} 복사` : `${S.fmt.name} 2`;
  nameInput.focus();
  wrap.querySelector('#fmtSaveOk').addEventListener('click', () => {
    const name = (nameInput.value || '').trim() || '내 포맷';
    const f = cloneFormat(S.fmt, { id: 'u' + Date.now().toString(36), builtin: false, name });
    f.logoData = currentLogoData;
    S.userFormats.push(f);
    const ok = saveUserFormats(S.userFormats);
    applyFormat(f);
    wrap.remove();
    toast(ok ? '포맷을 저장했어요' : '저장 공간이 부족해 이미지를 줄여 주세요');
  });
}

let currentLogoData = null;

function fmtEdited(patch) {
  Object.assign(S.fmt, patch);
  if (S.fmt.badge) S.fmt.badge = { ...S.fmt.badge, ...(patch.badge || {}) };
  scheduleDraw();
  saveState();
}

// ──────────────────────────────────────────────────────
// 상태 저장/복원
function saveState() {
  try {
    const data = {
      beatMode: S.beatMode, genre: S.genre, bpm: S.bpm,
      sections: S.sections, mix: S.mix,
      fmtId: S.fmtId, fmt: S.fmt,
      autoEdit: S.autoEdit, cutBeats: S.cutBeats, punch: S.punch, flash: S.flash, pulse: S.pulse, fitY: S.fitY,
      title1: S.title1, title2: S.title2, lenUnit: S.lenUnit,
      trim: S.trim, offsetBack: S.offsetBack,
    };
    localStorage.setItem(LS_STATE, JSON.stringify(data));
  } catch (e) {}
}

function loadState() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) {}
  if (!d) return;
  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
  S.beatMode = d.beatMode === 'file' ? 'file' : 'synth';
  S.genre = GENRES[d.genre] ? d.genre : 'techno';
  S.bpm = clamp(num(d.bpm, 140), 90, 160);
  if (Array.isArray(d.sections) && d.sections.length) {
    S.sections = d.sections.filter((s) => s && s.kind && isFinite(s.beats)).map((s) => ({
      id: s.id || 's' + Math.random().toString(36).slice(2, 6),
      kind: SECTION_KINDS[s.kind] ? s.kind : 'drop',
      beats: clamp(num(s.beats, 16), 1, 128),
      voice: !!s.voice, beat: !!s.beat, unit: s.unit === 'sec' ? 'sec' : 'bar',
    }));
  }
  if (d.mix) S.mix = { ...S.mix, ...d.mix };
  S.userFormats = loadUserFormats();
  if (d.fmtId) {
    const f = [...BUILTINS, ...S.userFormats].find((x) => x.id === d.fmtId);
    if (f) { S.fmtId = f.id; S.fmt = cloneFormat(f); }
  }
  S.autoEdit = d.autoEdit !== false;
  S.cutBeats = [1, 2, 4, 8].includes(d.cutBeats) ? d.cutBeats : 4;
  S.punch = num(d.punch, 0.045);
  S.flash = num(d.flash, 0.1);
  S.pulse = d.pulse !== false;
  S.fitY = clamp(num(d.fitY, 0.42), 0, 1);
  if (typeof d.title1 === 'string') S.title1 = d.title1;
  if (typeof d.title2 === 'string') S.title2 = d.title2;
  S.lenUnit = d.lenUnit === 'bar' ? 'bar' : 'sec';
  if (S.beatMode === 'file' && !S.backing) S.beatMode = 'synth';
  if (d.trim) S.trim = d.trim;
  S.offsetBack = num(d.offsetBack, 0);
}

// ──────────────────────────────────────────────────────
// 렌더(내보내기)
function pickMime() {
  const cands = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of cands) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c; } catch (e) {}
  }
  return '';
}

async function renderAll() {
  if (playing) stopPlayback();
  const arr = rebuild();
  if (!arr.total) return;
  if (!S.voice && !(S.beatMode === 'file' && S.backing)) { toast('먼저 영상을 올려 주세요'); return; }
  el.btnRender.disabled = true;
  el.renderBox.hidden = false;
  el.outList.innerHTML = '';
  el.renderMsg.className = 'status';
  el.renderMsg.textContent = '렌더링 준비 중…';
  el.renderBar.style.width = '2%';

  const ctx = audioCtx();
  try { await ctx.resume(); } catch (e) {}

  const rc = el.renderCanvas;
  rc.width = W; rc.height = H;
  const rctx = rc.getContext('2d', { alpha: false });
  const stamp = new Date();
  const name = `daini-remix_${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}_${arr.total.toFixed(1)}s`;

  let videoDone = false;
  const canVideo = typeof rc.captureStream === 'function' && !!window.MediaRecorder;

  if (canVideo) {
    try {
      const mime = pickMime();
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const stream = rc.captureStream(30);
      const dest = ctx.createMediaStreamDestination();
      stream.addTrack(dest.stream.getAudioTracks()[0]);

      const rec = new MediaRecorder(stream, mime
        ? { mimeType: mime, videoBitsPerSecond: 9000000, audioBitsPerSecond: 192000 }
        : { videoBitsPerSecond: 9000000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { rec.onstop = r; });

      const beatBuf = S.beatMode === 'synth' ? await getBeatBuffer(ctx, arr) : null;
      const t0 = ctx.currentTime + 0.4;
      const mix = scheduleMix(ctx, dest, arr, t0, beatBuf);
      await engine.startAt(0);
      el.renderMsg.textContent = `렌더링 중… 0.0 / ${arr.total.toFixed(1)}초 (실시간)`;

      let started = false;
      await new Promise((resolve) => {
        const step = () => {
          const t = ctx.currentTime - t0;
          if (t < 0) { requestAnimationFrame(step); return; }
          if (!started) { started = true; try { rec.start(250); } catch (e) {} }
          if (t >= arr.total + 0.01) { resolve(); return; }
          engine.sync(t);
          drawScene(rctx, sceneAt(t, engine.activeEl, { scale: 1 }));
          el.renderBar.style.width = `${clamp((t / arr.total) * 100, 2, 100)}%`;
          el.renderMsg.textContent = `렌더링 중… ${t.toFixed(1)} / ${arr.total.toFixed(1)}초 (실시간)`;
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });

      try { rec.stop(); } catch (e) {}
      await stopped;
      mix.stop();
      engine.pauseAll();
      el.renderBar.style.width = '100%';

      const blob = new Blob(chunks, { type: mime || 'video/webm' });
      if (blob.size > 1000) {
        const vidUrl = URL.createObjectURL(blob);
        addOut(`영상 (${ext.toUpperCase()})`, `${(blob.size / 1048576).toFixed(1)}MB · ${arr.total.toFixed(1)}초`, vidUrl, `${name}.${ext}`);
        videoDone = true;
      } else {
        el.renderMsg.className = 'status err';
        el.renderMsg.textContent = '영상 녹화가 비어 있어요. 오디오(WAV)로 저장해 주세요.';
      }
      // 썸네일
      try {
        const img = rc.toDataURL('image/jpeg', 0.9);
        addOut('썸네일 (JPG)', '1080×1920', URL.createObjectURL(dataURItoBlob(img)), `${name}_thumb.jpg`);
      } catch (e) {}
    } catch (e) {
      console.error(e);
      el.renderMsg.className = 'status err';
      el.renderMsg.textContent = '이 브라우저에서는 영상 녹화가 막혔어요. 오디오(WAV)는 계속 만들 수 있어요.';
    }
  } else {
    el.renderMsg.className = 'status err';
    el.renderMsg.textContent = '이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않아요. 고음질 WAV로 저장해 주세요.';
  }

  // WAV는 항상 만든다
  el.renderMsg.textContent = videoDone ? '영상 완료 · 오디오(WAV) 만드는 중…' : '오디오(WAV) 만드는 중…';
  await new Promise((r) => setTimeout(r, 60));
  try {
    const wav = await renderWav(arr);
    addOut('오디오 (WAV 48kHz)', `${(wav.size / 1048576).toFixed(1)}MB · 어디서나 재생`, URL.createObjectURL(wav), `${name}.wav`);
    if (videoDone) {
      el.renderMsg.className = 'status ok';
      el.renderMsg.textContent = `완료! ${arr.total.toFixed(1)}초 · 목소리 ${S.voice ? S.voice.segments.filter((x) => x.on).length : 0}구간 · ${arr.cutCount}컷`;
    }
  } catch (e) {
    console.error(e);
    el.renderMsg.className = 'status err';
    el.renderMsg.textContent = 'WAV 오디오 생성에 실패했어요.';
  }
  el.btnRender.disabled = false;
}

function dataURItoBlob(dataURI) {
  const [head, b64] = dataURI.split(',');
  const mime = /:(.*?);/.exec(head)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function addOut(title, meta, url, filename) {
  const card = document.createElement('div');
  card.className = 'outcard';
  card.innerHTML = `<div class="oc-l"><b>${title}</b><span>${meta}</span></div>
    <a class="primary sm" download="${filename}" href="${url}">저장</a>`;
  el.outList.appendChild(card);
}

async function renderWav(arr) {
  const sr = 48000;
  const oc = new OfflineAudioContext(2, Math.ceil(arr.total * sr), sr);
  const beatBuf = S.beatMode === 'synth'
    ? buildBeat(oc, {
        genre: S.genre, bpm: S.bpm, total: arr.total,
        sections: arr.beatPlan.map((b) => ({ start: b.start, dur: b.dur, kind: b.kind, beatOn: b.beatOn })),
      })
    : null;
  scheduleMix(oc, oc.destination, arr, 0, beatBuf);
  const rendered = await oc.startRendering();
  return encodeWav([rendered.getChannelData(0), rendered.getChannelData(1)], rendered.sampleRate);
}

// ──────────────────────────────────────────────────────
// 유튜브
async function importYoutube() {
  const url = el.ytUrl.value.trim();
  if (!url) { toast('유튜브 링크를 넣어 주세요'); return; }
  el.ytMsg.className = 'status';
  el.ytMsg.textContent = '가져오는 중…';
  const proxy = el.ytProxy.value.trim();
  const res = await tryYoutube(url, proxy);
  if (!res.ok) {
    el.ytMsg.className = 'status err';
    el.ytMsg.textContent = '유튜브 차단으로 직접 가져오기가 막혔습니다. 유튜브 화면 녹화 영상이나 저장한 음원 파일을 올리면 바로 오디오가 추출됩니다.';
    return;
  }
  el.ytMsg.className = 'status';
  el.ytMsg.textContent = '오디오 주소를 받았어요. 내려받는 중…';
  try {
    const r = await fetch(res.url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ab = await r.arrayBuffer();
    const buf = await decodeMedia(audioCtx(), ab);
    S.backing = { name: 'YouTube 오디오', buffer: buf, peaks: waveformPeaks(buf, 1400), duration: buf.duration };
    S.trim = { start: 0, end: Math.min(buf.duration, 30) };
    S.beatMode = 'file';
    syncBeatMode();
    el.backLoaded.hidden = false;
    el.backName.textContent = 'YouTube 오디오';
    el.backDur.textContent = `${buf.duration.toFixed(1)}초`;
    el.trimEndNum.value = S.trim.end.toFixed(1);
    drawBackWave();
    rebuild();
    el.ytMsg.className = 'status ok';
    el.ytMsg.textContent = '가져왔어요! 내 음원 탭에서 구간을 골라 주세요.';
  } catch (e) {
    el.ytMsg.className = 'status err';
    el.ytMsg.innerHTML = `오디오 주소는 받았지만 브라우저가 내려받기를 막았어요(CORS). 아래 링크를 열어 저장한 뒤 <b>내 음원</b>에 올려 주세요.<br><a href="${res.url}" target="_blank" rel="noopener">${res.url.slice(0, 80)}…</a>`;
  }
}

// ──────────────────────────────────────────────────────
// 이벤트 연결
function syncBeatMode() {
  $$('#beatTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.beatMode));
  el.paneSynth.hidden = S.beatMode !== 'synth';
  el.paneFile.hidden = S.beatMode !== 'file';
  el.paneYt.hidden = S.beatMode !== 'yt';
}

function syncControls() {
  el.genreChips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.genre === S.genre));
  el.bpm.value = String(S.bpm);
  el.bpmOut.textContent = String(S.bpm);
  el.voiceVol.value = String(S.mix.voiceVol);
  el.voiceVolOut.textContent = `${Math.round(S.mix.voiceVol * 100)}%`;
  el.beatVol.value = String(S.mix.beatVol);
  el.beatVolOut.textContent = `${Math.round(S.mix.beatVol * 100)}%`;
  el.reverb.value = String(S.mix.reverb);
  el.reverbOut.textContent = `${Math.round(S.mix.reverb * 100)}%`;
  el.pitch.value = String(S.mix.pitch);
  el.pitchOut.textContent = S.mix.pitch.toFixed(2);
  el.title1.value = S.title1;
  el.title2.value = S.title2;
  el.autoEdit.checked = S.autoEdit;
  el.editOpts.classList.toggle('off', !S.autoEdit);
  el.cutBeats.value = String(S.cutBeats);
  el.punchLevel.value = String(S.punch);
  el.flashLevel.value = String(S.flash);
  el.pulseOn.checked = S.pulse;
  el.fitY.value = String(S.fitY);
  el.fitYOut.textContent = `${Math.round(S.fitY * 100)}%`;
  el.lenUnit.dataset.unit = S.lenUnit;
  syncBeatMode();
  syncFormatInputs();
}

function fitAutoTitles() {
  // 비트/장르가 바뀌면 2번째 줄의 BPM 숫자만 조용히 갱신
  if (/BPM/i.test(S.title2)) {
    const next = S.title2.replace(/(\*?)(\d+)(\*?\s*)BPM/gi, (m, a, num, b) => `${a}${S.bpm}${b}BPM`);
    if (next !== S.title2) { S.title2 = next; el.title2.value = next; }
  }
}

function bind() {
  el.cardFormat = $('#cardFormat');

  // 파일 선택
  el.fileVoice.addEventListener('change', (e) => onVoiceFile(e.target.files[0]));
  el.fileBack.addEventListener('change', (e) => onBackFile(e.target.files[0]));
  el.fileLogo.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const dataUrl = await shrinkImage(f, 320);
    currentLogoData = dataUrl;
    loadCustomLogo(dataUrl);
    S.fmt.badge = { ...(S.fmt.badge || {}), logo: 'custom' };
    el.badgeLogo.value = 'custom';
    saveState();
    toast('로고 이미지를 넣었어요');
  });

  ['dropVoice', 'dropBack', 'dropLogo'].forEach((id) => {
    const drop = document.getElementById(id);
    if (!drop) return;
    const input = drop.querySelector('input[type=file]');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hover'); }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      input.files = e.dataTransfer.files;
      if (id === 'dropVoice') onVoiceFile(f);
      else if (id === 'dropBack') onBackFile(f);
      else onLogoFile(f);
    });
  });

  async function onLogoFile(f) {
    const dataUrl = await shrinkImage(f, 320);
    currentLogoData = dataUrl;
    loadCustomLogo(dataUrl);
    S.fmt.badge = { ...(S.fmt.badge || {}), logo: 'custom' };
    el.badgeLogo.value = 'custom';
    saveState();
  }

  el.btnChangeVoice.addEventListener('click', () => {
    el.dropVoice.style.display = '';
    el.fileVoice.value = '';
    el.fileVoice.click();
  });
  el.btnChangeBack.addEventListener('click', () => {
    el.dropBack.style.display = '';
    el.fileBack.value = '';
    el.fileBack.click();
  });
  el.btnAnalyze.addEventListener('click', reanalyze);
  el.btnEven.addEventListener('click', evenSplit);
  el.segList.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.play != null) playSegment(+b.dataset.play);
    if (b.dataset.nudge) nudgeSeg(+b.dataset.i, +b.dataset.nudge);
  });
  el.segList.addEventListener('change', (e) => {
    const i = +e.target.dataset.i;
    if (!S.voice || !S.voice.segments[i]) return;
    S.voice.segments[i].on = e.target.checked;
    renderSegments();
    drawWave(el.waveVoice, S.voice.peaks, { markers: S.voice.segments, color: 'rgba(255,255,255,.5)' });
    rebuild();
  });

  // 비트 탭
  $$('#beatTabs button').forEach((b) => b.addEventListener('click', () => {
    S.beatMode = b.dataset.tab;
    syncBeatMode();
    rebuild();
    saveState();
  }));
  el.genreChips.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.genre = b.dataset.genre;
    if (!S.bpmLocked) {
      const def = GENRES[S.genre].bpm;
      S.bpm = def;
      el.bpm.value = String(def);
      el.bpmOut.textContent = String(def);
      fitAutoTitles();
    }
    el.genreChips.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    rebuild();
    saveState();
  });
  el.bpm.addEventListener('input', () => {
    S.bpm = +el.bpm.value;
    S.bpmLocked = true;
    el.bpmOut.textContent = String(S.bpm);
    fitAutoTitles();
    rebuild();
  });
  el.bpm.addEventListener('change', saveState);

  // 트림
  const applyTrim = (from, val) => {
    if (!S.backing) return;
    const dur = S.backing.duration;
    if (from === 'start') S.trim.start = clamp(val, 0, S.trim.end - 0.2);
    else S.trim.end = clamp(val, S.trim.start + 0.2, dur);
    el.trimStartNum.value = S.trim.start.toFixed(1);
    el.trimEndNum.value = S.trim.end.toFixed(1);
    el.trimStart.value = String((S.trim.start / dur) * 1000);
    el.trimEnd.value = String((S.trim.end / dur) * 1000);
    drawBackWave();
    rebuild();
  };
  el.trimStart.addEventListener('input', () => applyTrim('start', (+el.trimStart.value / 1000) * S.backing.duration));
  el.trimEnd.addEventListener('input', () => applyTrim('end', (+el.trimEnd.value / 1000) * S.backing.duration));
  el.trimStartNum.addEventListener('change', () => applyTrim('start', +el.trimStartNum.value));
  el.trimEndNum.addEventListener('change', () => applyTrim('end', +el.trimEndNum.value));
  el.offsetBack.addEventListener('change', () => {
    S.offsetBack = clamp(+el.offsetBack.value || 0, 0, 8);
    saveState(); rebuild();
  });
  el.btnBpmApply.addEventListener('click', () => {
    const b = +el.btnBpmApply.dataset.bpm;
    if (!b) return;
    S.bpm = b;
    el.bpm.value = String(b);
    el.bpmOut.textContent = String(b);
    rebuild(); saveState();
    toast(`BPM ${b}로 맞췄어요`);
  });
  el.btnTrimPlay.addEventListener('click', () => {
    if (!S.backing) return;
    const ctx = audioCtx(); ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = S.backing.buffer;
    const g = ctx.createGain(); g.gain.value = S.mix.beatVol;
    src.connect(g); g.connect(ctx.destination);
    src.start(0, S.trim.start, Math.min(S.backing.duration - S.trim.start, S.trim.end - S.trim.start));
    toast('선택 구간을 재생해요');
  });

  // 유튜브
  el.btnYt.addEventListener('click', importYoutube);
  el.ytProxy.value = localStorage.getItem('daini-remix.ytproxy') || '';
  el.btnYtProxySave.addEventListener('click', () => {
    localStorage.setItem('daini-remix.ytproxy', el.ytProxy.value.trim());
    toast('프록시 주소를 저장했어요');
  });

  // 길이
  el.lenPresets.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    applyTarget(+b.dataset.sec);
    el.lenPresets.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  });
  function applyTarget(sec) {
    if (!isFinite(sec) || sec <= 0) return;
    const cur = S.arr ? S.arr.total : 0;
    if (Math.abs(cur - sec) < 0.06) return;   // 이미 그 길이면 그대로
    S.sections = fitToSeconds(S.sections, S.bpm, sec);
    rebuild(); saveState();
    toast(`총 ${S.arr.total.toFixed(1)}초에 맞췄어요`);
  }
  el.lenCustom.addEventListener('change', () => {
    const v = +el.lenCustom.value;
    if (!isFinite(v) || v <= 0) return;
    const sec = S.lenUnit === 'sec' ? v : v * (60 / S.bpm) * 4;
    applyTarget(sec);
  });
  el.btnFit.addEventListener('click', () => {
    const v = +el.lenCustom.value;
    if (!isFinite(v) || v <= 0) return;
    applyTarget(S.lenUnit === 'sec' ? v : v * (60 / S.bpm) * 4);
  });
  el.lenUnit.addEventListener('click', () => {
    S.lenUnit = S.lenUnit === 'sec' ? 'bar' : 'sec';
    el.lenUnit.dataset.unit = S.lenUnit;
    updateArrangeUI();
    saveState();
  });
  el.lenCustom.step = '0.1';

  // 구간 편집
  el.secList.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const i = +b.dataset.i;
    const s = S.sections[i];
    if (!s) return;
    const act = b.dataset.act;
    const stepBar = 4;
    if (act === 'minus') s.beats = Math.max(1, s.beats - (s.unit === 'sec' ? 1 : 4));
    if (act === 'plus') s.beats = Math.min(128, s.beats + (s.unit === 'sec' ? 1 : 4));
    if (act === 'unit') s.unit = s.unit === 'sec' ? 'bar' : 'sec';
    if (act === 'voice') s.voice = !s.voice;
    if (act === 'beat') s.beat = !s.beat;
    if (act === 'del') { S.sections.splice(i, 1); if (!S.sections.length) S.sections = defaultSections(); }
    rebuild(); saveState();
  });
  el.secList.addEventListener('change', (e) => {
    const inp = e.target.closest('input[data-act="len"]');
    if (!inp) return;
    const i = +inp.dataset.i;
    const s = S.sections[i];
    if (!s) return;
    const v = +inp.value;
    if (!isFinite(v) || v <= 0) return;
    const beat = 60 / S.bpm;
    s.beats = s.unit === 'sec' ? Math.max(1, Math.round((v / beat) * 4) / 4) : Math.max(1, v * 4);
    rebuild(); saveState();
  });
  el.btnAddDrop.addEventListener('click', () => { S.sections.push(newSection('drop', 16)); rebuild(); saveState(); });
  el.btnAddBreak.addEventListener('click', () => { S.sections.push(newSection('break', 8, { beat: false })); rebuild(); saveState(); });
  el.btnAddIntro.addEventListener('click', () => { S.sections.push(newSection('intro', 8, { voice: false })); rebuild(); saveState(); });
  el.btnResetSec.addEventListener('click', () => { S.sections = defaultSections(); rebuild(); saveState(); toast('기본 구성으로 돌아왔어요'); });

  // 자동 편집
  el.autoEdit.addEventListener('change', () => {
    S.autoEdit = el.autoEdit.checked;
    el.editOpts.classList.toggle('off', !S.autoEdit);
    rebuild(); saveState();
  });
  el.cutBeats.addEventListener('change', () => { S.cutBeats = +el.cutBeats.value; rebuild(); saveState(); });
  el.punchLevel.addEventListener('change', () => { S.punch = +el.punchLevel.value; saveState(); scheduleDraw(); });
  el.flashLevel.addEventListener('change', () => { S.flash = +el.flashLevel.value; saveState(); scheduleDraw(); });
  el.pulseOn.addEventListener('change', () => { S.pulse = el.pulseOn.checked; saveState(); scheduleDraw(); });
  el.fitY.addEventListener('input', () => {
    S.fitY = +el.fitY.value;
    el.fitYOut.textContent = `${Math.round(S.fitY * 100)}%`;
    scheduleDraw();
  });
  el.fitY.addEventListener('change', saveState);

  // 포맷
  el.fmtBg.addEventListener('input', () => fmtEdited({ bg: el.fmtBg.value }));
  el.fmtAccent.addEventListener('input', () => fmtEdited({ accent: el.fmtAccent.value }));
  el.fmtFont.addEventListener('input', () => {
    const v = +el.fmtFont.value;
    el.fmtFontOut.textContent = `${Math.round(v * 100)}%`;
    fmtEdited({ fontScale: v });
  });
  el.badgeLogo.addEventListener('change', () => {
    if (el.badgeLogo.value === 'custom') { el.dropLogo.hidden = false; return; }
    fmtEdited({ badge: { ...(S.fmt.badge || {}), logo: el.badgeLogo.value } });
  });
  el.badgeText.addEventListener('input', () => fmtEdited({ badge: { ...(S.fmt.badge || {}), text: el.badgeText.value } }));
  el.btnSaveFmt.addEventListener('click', saveCurrentFormat);
  el.btnDelFmt.addEventListener('click', () => {
    if (S.fmt.builtin) return;
    deleteFormat(S.fmt.id);
  });

  // 사운드 · 제목
  el.title1.addEventListener('input', () => { S.title1 = el.title1.value; saveState(); scheduleDraw(); });
  el.title2.addEventListener('input', () => { S.title2 = el.title2.value; saveState(); scheduleDraw(); });
  const bindSlider = (node, out, key, fmt, after) => {
    node.addEventListener('input', () => {
      S.mix[key] = +node.value;
      out.textContent = fmt(S.mix[key]);
      if (after) after();
      scheduleDraw();
    });
    node.addEventListener('change', saveState);
  };
  bindSlider(el.voiceVol, el.voiceVolOut, 'voiceVol', (v) => `${Math.round(v * 100)}%`);
  bindSlider(el.beatVol, el.beatVolOut, 'beatVol', (v) => `${Math.round(v * 100)}%`);
  bindSlider(el.reverb, el.reverbOut, 'reverb', (v) => `${Math.round(v * 100)}%`);
  bindSlider(el.pitch, el.pitchOut, 'pitch', (v) => v.toFixed(2), () => rebuild());

  // 재생/정지
  el.btnPlay.addEventListener('click', play);
  el.btnStop.addEventListener('click', () => stopPlayback());
  el.btnRender.addEventListener('click', () => renderAll().catch((e) => {
    console.error(e);
    el.renderMsg.className = 'status err';
    el.renderMsg.textContent = '렌더링 중 오류가 났어요: ' + e.message;
    el.btnRender.disabled = false;
  }));
  el.btnHelp.addEventListener('click', () => {
    const d = document.querySelector('details.help');
    d.open = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  window.addEventListener('resize', () => { scheduleDraw(); if (S.voice) { drawWave(el.waveVoice, S.voice.peaks, { markers: S.voice.segments, color: 'rgba(255,255,255,.5)' }); drawBackWave(); } });
  window.addEventListener('beforeunload', (e) => { if (playing) { e.preventDefault(); e.returnValue = ''; } });
}

// ──────────────────────────────────────────────────────
// 초기화
function cacheEls() {
  const map = {
    subStatus: 'subStatus', preview: 'preview', playerTime: 'playerTime', totalLen: 'totalLen',
    progressBar: 'progressBar', btnPlay: 'btnPlay', btnStop: 'btnStop', playDot: 'playDot',
    fileVoice: 'fileVoice', dropVoice: 'dropVoice', btnChangeVoice: 'btnChangeVoice', btnChangeBack: 'btnChangeBack', voiceLoaded: 'voiceLoaded', voiceName: 'voiceName', voiceDur: 'voiceDur',
    waveVoice: 'waveVoice', segCount: 'segCount', segOn: 'segOn', btnAnalyze: 'btnAnalyze', btnEven: 'btnEven',
    segList: 'segList', segHint: 'segHint',
    beatTabs: 'beatTabs', paneSynth: 'pane-synth', paneFile: 'pane-file', paneYt: 'pane-yt',
    genreChips: 'genreChips', bpm: 'bpm', bpmOut: 'bpmOut',
    fileBack: 'fileBack', dropBack: 'dropBack', backLoaded: 'backLoaded', backName: 'backName', backDur: 'backDur',
    waveBack: 'waveBack', trimStart: 'trimStart', trimEnd: 'trimEnd', trimStartNum: 'trimStartNum',
    trimEndNum: 'trimEndNum', btnTrimPlay: 'btnTrimPlay', bpmEst: 'bpmEst', btnBpmApply: 'btnBpmApply',
    offsetBack: 'offsetBack',
    ytUrl: 'ytUrl', btnYt: 'btnYt', ytMsg: 'ytMsg', ytProxy: 'ytProxy', btnYtProxySave: 'btnYtProxySave',
    lenPresets: 'lenPresets', lenCustom: 'lenCustom', lenUnit: 'lenUnit', lenUnitLabel: 'lenUnitLabel', btnFit: 'btnFit',
    totalLen2: 'totalLen2', totalBars: 'totalBars', cutCount: 'cutCount', bpmLabel: 'bpmLabel', tlBar: 'tlBar',
    secList: 'secList', btnAddDrop: 'btnAddDrop', btnAddBreak: 'btnAddBreak', btnAddIntro: 'btnAddIntro', btnResetSec: 'btnResetSec',
    autoEdit: 'autoEdit', editOpts: 'editOpts', cutBeats: 'cutBeats', punchLevel: 'punchLevel', flashLevel: 'flashLevel',
    pulseOn: 'pulseOn', fitY: 'fitY', fitYOut: 'fitYOut',
    fmtChips: 'fmtChips', fmtBg: 'fmtBg', fmtAccent: 'fmtAccent', fmtFont: 'fmtFont', fmtFontOut: 'fmtFontOut',
    badgeLogo: 'badgeLogo', badgeText: 'badgeText', dropLogo: 'dropLogo', fileLogo: 'fileLogo',
    btnSaveFmt: 'btnSaveFmt', btnDelFmt: 'btnDelFmt',
    title1: 'title1', title2: 'title2',
    voiceVol: 'voiceVol', voiceVolOut: 'voiceVolOut', beatVol: 'beatVol', beatVolOut: 'beatVolOut',
    reverb: 'reverb', reverbOut: 'reverbOut', pitch: 'pitch', pitchOut: 'pitchOut',
    btnRender: 'btnRender', renderBox: 'renderBox', renderBar: 'renderBar', renderMsg: 'renderMsg',
    outList: 'outList', thumb: 'thumb', btnHelp: 'btnHelp', toast: 'toast',
  };
  for (const k in map) el[k] = document.getElementById(map[k]);
}

function shrinkImage(file, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, size / Math.max(img.width, img.height, 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * s));
      c.height = Math.max(1, Math.round(img.height * s));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

async function init() {
  cacheEls();
  el.preview.width = 540;
  el.preview.height = 960;
  el.previewCtx = el.preview.getContext('2d', { alpha: false });

  const rc = document.createElement('canvas');
  rc.id = 'renderCanvas';
  rc.width = W; rc.height = H;
  rc.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
  document.body.appendChild(rc);
  el.renderCanvas = rc;

  loadState();
  try { await loadAssets(); } catch (e) {}
  if (S.fmt.logoData) loadCustomLogo(S.fmt.logoData);

  bind();
  syncControls();
  rebuild();
  drawPreview(staticT);
  setStatus(S.voice ? '영상 준비됨' : '영상 → 목소리 자동 추출 → 비트 리믹스');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => {}).catch(() => {});
  }
  window.__remix = { S, engine, rebuild, get arr() { return S.arr; } };
  document.documentElement.dataset.ready = '1';
}

init().catch((e) => {
  console.error(e);
  setStatus('초기화 오류: ' + e.message);
});

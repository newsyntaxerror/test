// 옹알이 리믹스 — 앱 로직
import { loadAssets, drawScene, drawWave, setCustomLogo, canvasToBlob, W, H } from './draw.js?v=1.7.0';
import { encodeMp4, sourceTimeAt, shotRate, shotMoves, webCodecsSupported, webCodecsVideoSupported, webCodecsAudioSupported, hybridAudioSupported } from './encode.js?v=1.7.0';
import { decodeMedia, decodeMediaFile, detectVoice, estimateBpm, waveformPeaks, detectGridOffset } from './analyze.js?v=1.7.0';
import { buildBeat, makeIR, encodeWav, GENRES } from './dsp.js?v=1.7.0';
import { buildArrangement, defaultSections, fitToSeconds, totalBeats, newSection, labelFor, SECTION_KINDS } from './arrange.js?v=1.7.0';
import { BUILTINS, loadUserFormats, saveUserFormats, cloneFormat } from './formats.js?v=1.7.0';
import { tryYoutube } from './yt.js?v=1.7.0';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const clampNum = (v, a, b, fallback = a) => (typeof v === 'number' && isFinite(v) ? Math.max(a, Math.min(b, v)) : fallback);

const LS_STATE = 'daini-remix.state.v2';

const S = {
  voice: null,          // {name, buffer, peaks, segments, duration}
  videoUrl: null,
  videoDur: 0,
  genre: 'techno',
  bpm: 140,
  beatOn: true,         // 🥁 장르 비트 사용(v1.7) — 배경노래와 함께도 켜 둘 수 있다
  songOn: true,         // 🎵 배경노래 사용
  backing: null,        // 🎵 배경노래 {name, buffer, peaks, duration, norm, kind}
  songBpm: 0,           // 배경노래에서 추정한 BPM
  songTrack: { start: 0, len: 0, vol: 1, fadeIn: 0, fadeOut: 0, srcOffset: 0 },   // 🎵 배경노래 트랙
  trim: { start: 0, end: 0 },
  offsetBack: 0,
  outputSpeed: 1,       // ⏩ 최종 배속(0.5~2.0) — 영상·소리 전부 같은 배율로
  sections: defaultSections(),
  mix: { voiceVol: 1, beatVol: 0.8, reverb: 0.18, pitch: 1 },
  voiceFx: 'all',       // all = 전체 목소리 · baby = 👶 아기 고음 위주(성인 저음 감쇄)
  voiceTrack: { offset: 0, vol: 1 },   // 🎙️ 옹알이 트랙 전체 시작 오프셋·볼륨
  voiceClips: null,     // null = 자동 배치 · [{id, segId, at, len, vol}] = 타임라인에서 손으로 만든 배치
  clipsFor: null,       // 손으로 만든 배치가 어느 영상 것인지(이름·길이·구간 수) — 다른 영상엔 쓰지 않는다
  beatTrack: { start: 0, len: 0, vol: 1, fadeIn: 0, fadeOut: 0, srcOffset: 0 },   // 🎵 비트 트랙
  remixPattern: true,   // 가져온 음원 모드에서 박자 그리드 리믹스 패턴 사용
  beatDuck: 5,          // 옹알이가 터질 때 가져온 음원을 눌러주는 양(dB)
  gridConf: 0,          // 첫 박 자동 감지 신뢰도
  fmtId: 'ver1',
  fmt: cloneFormat(BUILTINS[0]),
  userFormats: [],
  fitMode: 'sync',      // sync = 음원 싱크 믹싱(기본) · smooth = 1배속 부드럽게 · beatcut = 비트 점프컷
  renderRes: null,      // '720' | '1080' — 모바일 기본은 720p
  fxMode: 'auto',       // auto = 알아서 편집 · manual = 직접 편집
  fx: { shake: 1, color: 'vivid', edge: true, psy: 2 },   // psy = 🪩 싸이키 조명 (0 끔 · 1 약 · 2 강)
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
let lastDrawT = 0;        // 미리보기 캔버스에 마지막으로 그린 타임라인 시각(진단용)
let staticT = 0.6;
let drawTimer = 0;
let segAudio = null;      // 구간 미리듣기(한 번에 하나만)
const tl = { t: 0, playing: false, state: null, raf: 0, sel: null, drag: null };

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
    this.anchorIdx = -1;
    this.anchorT = 0;
    this.anchorSrc = 0;
    this.speed = 1;          // v1.7 최종 배속 — 타임라인 초가 실시간보다 speed배 빨리 흘러가므로 영상도 같이 빠르게
  }

  ensureEls() {
    if (this.els.length) return;
    // v1.6: 음원 싱크 모드는 0.2초 스터터까지 이어져, 다음 샷을 더 미리 seek해 둘 요소가 필요하다.
    //      (한 번에 하나만 재생하므로 일시정지된 요소를 여러 개 두는 것은 부담이 적다)
    for (let i = 0; i < 5; i++) {
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

  seekTo(v, time, tol = 0.03) {
    return new Promise((resolve) => {
      const t = Math.max(0, time);
      if (Math.abs(v.currentTime - t) < tol && v.readyState >= 2) return resolve();
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
    const shot = this.shots[idx];
    this.applyRate(v, shot);
    await this.seekTo(v, shot.srcStart);
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
    const exp = this.shotSourceTime(shot, t);
    // 음원 싱크 샷은 짧은 스터터도 많아, 들어오는 순간의 정확한 원본 시점으로 맞춘다.
    const tol = shot.sync ? 0.05 : 0.12;
    let v = this.prepared.get(idx);
    this.activeIdx = idx;                      // await 사이 재진입 방지
    if (v) {
      this.prepared.delete(idx);
      if (this.activeEl && this.activeEl !== v) { try { this.activeEl.pause(); } catch (e) {} }
      this.activeEl = v;
    } else {
      // 준비된 엘리먼트가 없으면 현재 엘리먼트로 폴백(잠깐 멈췄다 이어짐)
      const f = this.activeEl || this.els[0];
      if (!f) return;
      this.activeEl = f;
    }
    const elv = this.activeEl;
    await this.seekTo(elv, exp, tol);
    this.applyRate(elv, shot);
    try { const p = elv.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    this.applyRate(elv, shot);                 // 사파리는 play 전 설정을 무시할 때가 있다
    this.resetAnchor(t, elv.currentTime);
    // 짧은 스터터가 이어져도 다음 샷들이 미리 seek되어 있도록 3개까지 준비한다.
    const ahead = (shot.sync || this.shots[idx + 1] && this.shots[idx + 1].sync) ? 3 : 2;
    for (let k = 1; k <= ahead; k++) this.prime(idx + k);
  }

  // 샷 배속(rate)을 video 엘리먼트에 적용 — 최종 배속(v1.7)까지 곱해 영상 진행이 소리와 같이 간다
  applyRate(v, shot) {
    if (!v) return;
    const sp = clampNum(this.speed, 0.25, 4, 1);
    const r = clamp(shotRate(shot) * sp, 0.0625, 16);
    try { if (v.defaultPlaybackRate !== r) v.defaultPlaybackRate = r; } catch (e) {}
    try { if (Math.abs((v.playbackRate || 1) - r) > 0.001) v.playbackRate = r; } catch (e) {}
  }

  resetAnchor(t, src) {
    this.anchorIdx = this.activeIdx;
    this.anchorT = t;
    this.anchorSrc = src;
  }

  syncRate() {
    const shot = this.shots[this.activeIdx];
    if (!this.activeEl || !shot) return;
    this.applyRate(this.activeEl, shot);
  }

  // 샷의 특정 시각에 보여야 하는 원본 영상 위치(배속·루프 반영)
  shotSourceTime(shot, t) {
    if (!shot) return 0;
    const vDur = S.videoDur || 0;
    if (shotMoves(shot)) {
      const x = shot.srcStart + Math.max(0, t - shot.tStart) * shotRate(shot);
      if (vDur > 0.05) return ((x % vDur) + vDur) % vDur;
      return Math.max(0, x);
    }
    return Math.max(0, shot.srcStart);
  }

  // 현재 샷의 예상 원본 시점과 실제 video 시점의 차이만 보정한다.
  // (오디오 컨텍스트 시각 t가 기준 — 미리보기와 저장된 MP4가 같은 프레임을 보게 된다)
  follow(t) {
    const v = this.activeEl;
    if (!v) return;
    const shot = this.shots[this.activeIdx];
    if (!shot) return;
    this.applyRate(v, shot);
    if (v.paused) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
    if (this.anchorIdx !== this.activeIdx) { this.resetAnchor(t, v.currentTime); return; }
    const vDur = S.videoDur || 0;
    const exp = this.shotSourceTime(shot, t);
    let drift = Math.abs(v.currentTime - exp);
    if (vDur > 0.05) drift = Math.min(drift, Math.abs(vDur - drift));   // 루프 경계는 가깝다
    const remain = shot.tEnd - t;
    // 짧은 싱크 샷은 보정 seek를 하지 않는다 — seek가 재생을 멈춰 오히려 프레임이 밀리고,
    // 어차피 다음 컷에서 정확한 시점으로 다시 붙는다. 긴 샷만 0.16초 넘게 어긋나면 당긴다.
    const tol = shot.sync ? 0.16 : 0.22;
    const now = performance.now();
    if (remain > (shot.sync ? 0.16 : 0.08) && drift > tol && now - (this._lastSeek || 0) > 220) {
      this._lastSeek = now;
      try { v.currentTime = exp; } catch (e) {}
    }
  }

  async startAt(t, autoplay = true) {
    this.pauseAll();
    this.activeIdx = -1;
    this.prepared.clear();
    await this.prime(this.indexAt(t));
    if (autoplay) {
      await this.sync(t + 0.001);
    } else {
      // 녹화 전 준비: 첫 샷을 재생 직전 상태로 대기(프리롤 동안 재생하지 않아 1배속 시작과 어긋나지 않음)
      const idx = this.indexAt(t);
      const v = this.prepared.get(idx);
      if (v) {
        this.prepared.delete(idx);
        if (this.activeEl && this.activeEl !== v) { try { this.activeEl.pause(); } catch (e) {} }
        this.activeEl = v;
        this.activeIdx = idx;
        const shot = this.shots[idx];
        await this.seekTo(v, this.shotSourceTime(shot, t), shot.sync ? 0.02 : 0.18);
        this.applyRate(v, shot);
        this.resetAnchor(t, v.currentTime);
      }
      this.prime(idx + 1);
      this.prime(idx + 2);
    }
  }

  // 녹화 시작 시점에 1배속으로 재생을 건다
  playNow() {
    const v = this.activeEl;
    if (!v) return;
    try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    this.syncRate();
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
      await this.seekTo(this.activeEl, this.shotSourceTime(shot, t), shot.sync ? 0.02 : shot.smooth ? 0.18 : 0.03);
      this.applyRate(this.activeEl, shot);
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
    shake: shakeAmp(t, env),
    colorFx: (S.fx && S.fx.color) || 'none',
    edgeOn: !!(S.fx && S.fx.edge),
    psy: (S.fx && S.fx.psy) || 0,
    beat: (S.arr && S.arr.beat) || 60 / (S.bpm || 140),
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

// 비트 쉐이크 진폭(1080 기준 px) — 드롭·강박에서만 흔들린다
function shakeAmp(t, env) {
  const lv = (S.fx && S.fx.shake) || 0;
  if (!lv) return 0;
  const sec = sectionAt(t);
  const drop = !!(sec && sec.kind === 'drop');
  const punch = dropPunchAt(t) * 8;
  const amt = Math.min(1, Math.max(env, punch) * (drop ? 1 : 0.45));
  return (lv === 2 ? 11 : 5.5) * amt;
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
// 목소리 음역 필터 (v1.5) — 미리듣기·오프라인 믹스·MP4 내보내기가 같은 체인을 쓴다.
//  · 전체 목소리: 그대로
//  · 👶 아기 고음 위주: highpass 320Hz(성인 저음 감쇄) + peaking 700Hz -9dB(저역 웅웅 담당)
function voiceFxChain(ctx, src, dst) {
  if (S.voiceFx !== 'baby') { src.connect(dst); return null; }
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 320;
  hp.Q.value = 0.707;
  const pk = ctx.createBiquadFilter();
  pk.type = 'peaking';
  pk.frequency.value = 700;
  pk.Q.value = 1.1;
  pk.gain.value = -9;
  src.connect(hp);
  hp.connect(pk);
  pk.connect(dst);
  return [hp, pk];
}

// ──────────────────────────────────────────────────────
// 믹스 스케줄 (미리듣기 = 실시간, WAV = 오프라인 공용)
// opts.from: 타임라인의 어느 지점(초)부터 재생할지 — 플레이헤드 미리듣기용
// opts.speed: 최종 배속(v1.7) — 모두 같은 배율로 눌러 재생해 영상·소리 싱크를 유지한다.
//   배경노래 · 장르 비트 · 옹알이 세 트랙이 한 타임라인에서 같이 빨라지거나 느려진다.
function scheduleMix(ctx, out, arr, t0, beatBuf, opts = {}) {
  const stops = [];
  const sp = clampNum(opts.speed, 0.25, 4, 1);
  const from = clampNum(opts.from, 0, Math.max(0, arr.total - 0.02), 0);
  const span = Math.max(0.02, arr.total - from);
  const endAt = t0 + span / sp;
  const T = (t) => t0 + Math.max(0, t - from) / sp;   // 타임라인 초 → 출력 초
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.9, t0);
  master.gain.setValueAtTime(0.9, Math.max(t0 + 0.02, endAt - 0.06));
  master.gain.linearRampToValueAtTime(0.0001, endAt + 0.02);
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

  // 반주 — 🎵 배경노래 트랙 + 🥁 장르 비트 트랙 (v1.7 3단 믹싱)
  //  · 배경노래는 박자에 맞춰 깔리고(전체 선택 구간 루프), 옹알이가 터질 때 살짝 눌린다(덕킹)
  //  · 장르 비트는 노래 BPM 그리드에 맞춰 그 위에 얹힌다(둘을 같이 켤 수 있다)
  const duckDb = clampNum(S.beatDuck, 0, 12, 0);
  const duckEvents = (gainNode, vBase, a, b) => {
    if (duckDb <= 0.2) return;
    const duck = Math.pow(10, -duckDb / 20);
    for (const ev of arr.voiceEvents) {
      const evDur = (ev.bufEnd - ev.bufStart) / (ev.rate || 1);
      const s0 = Math.max(ev.tStart, a);
      const e0 = Math.min(ev.tStart + evDur, b);
      if (e0 - s0 < 0.05) continue;
      let at0 = T(s0) - 0.03 / sp;
      if (at0 < t0) at0 = t0;
      if (at0 > endAt - 0.05) continue;
      gainNode.gain.setValueAtTime(Math.max(0.0001, vBase * duck), at0);
      gainNode.gain.linearRampToValueAtTime(vBase, Math.min(endAt, at0 + 0.16 / sp));
    }
  };

  // 🎵 배경노래
  if (S.songOn !== false && S.backing && S.backing.buffer && arr.songTrack) {
    const st = arr.songTrack;
    const sStart = Math.max(st.start, from);
    const sEnd = Math.min(st.end, arr.total);
    const sSpan = sEnd - sStart;
    if (sSpan > 0.03) {
      const at = T(sStart);
      const sg = ctx.createGain();
      const norm = S.backing.norm || 1;
      const sVol = Math.max(0.0001, (st.vol == null ? 1 : st.vol) * norm);
      const fi = (sStart <= st.start + 0.005 ? Math.min(st.fadeIn || 0, sSpan * 0.5) : 0) / sp;
      const fo = Math.min(st.fadeOut || 0, sSpan * 0.5) / sp;
      sg.gain.setValueAtTime(fi > 0 ? 0.0001 : sVol, at);
      if (fi > 0) sg.gain.linearRampToValueAtTime(sVol, at + fi);
      if (fo > 0) {
        sg.gain.setValueAtTime(sVol, Math.max(at + fi, at + sSpan / sp - fo));
        sg.gain.linearRampToValueAtTime(0.0001, at + sSpan / sp);
      }
      duckEvents(sg, sVol, sStart, sEnd);
      sg.connect(master);
      const bsrc = ctx.createBufferSource();
      bsrc.buffer = S.backing.buffer;
      bsrc.connect(sg);
      try { bsrc.playbackRate.value = sp; } catch (e) {}
      const dur = S.backing.duration;
      const tA = clamp(S.trim.start, 0, Math.max(0, dur - 0.2));
      const tB = clamp(S.trim.end, tA + 0.25, dur);
      const srcStart = clamp(tA + (S.offsetBack || 0) + (st.srcOffset || 0), tA, Math.max(tA, tB - 0.2));
      const loopLen = Math.max(0.2, tB - srcStart);
      // 타임라인 0초 = 노래의 다운비트. 트랙을 늦게 시작해도 그 지점이 전역 박자선 위에 오도록 위상을 잡는다.
      let phase = (sStart * sp) % loopLen;
      if (phase < 0) phase += loopLen;
      bsrc.loop = true;
      bsrc.loopStart = srcStart;
      bsrc.loopEnd = srcStart + loopLen;
      bsrc.start(at, Math.min(srcStart + phase, Math.max(0, dur - 0.02)), sSpan);
      bsrc.stop(at + sSpan / sp + 0.03);
      stops.push(bsrc);
      stops.push({ stop() { try { sg.disconnect(); } catch (e) {} } });
    }
  }

  // 🥁 장르 비트
  if (S.beatOn !== false && beatBuf) {
    const bt = arr.beatTrack || { start: 0, end: arr.total, len: arr.total, vol: 1, fadeIn: 0, fadeOut: 0, srcOffset: 0 };
    const bStart = Math.max(bt.start, from);
    const bEnd = Math.min(bt.end, arr.total);
    const bSpan = bEnd - bStart;
    if (bSpan > 0.03) {
      const at = T(bStart);
      const bg = ctx.createGain();
      const bVol = Math.max(0.0001, S.mix.beatVol * (bt.vol == null ? 1 : bt.vol));
      const fi = (bStart <= bt.start + 0.005 ? Math.min(bt.fadeIn || 0, bSpan * 0.5) : 0) / sp;
      const fo = Math.min(bt.fadeOut || 0, bSpan * 0.5) / sp;
      bg.gain.setValueAtTime(fi > 0 ? 0.0001 : bVol, at);
      if (fi > 0) bg.gain.linearRampToValueAtTime(bVol, at + fi);
      if (fo > 0) {
        bg.gain.setValueAtTime(bVol, Math.max(at + fi, at + bSpan / sp - fo));
        bg.gain.linearRampToValueAtTime(0.0001, at + bSpan / sp);
      }
      duckEvents(bg, bVol, bStart, bEnd);
      bg.connect(master);
      const bsrc = ctx.createBufferSource();
      bsrc.buffer = beatBuf;
      bsrc.connect(bg);
      try { bsrc.playbackRate.value = sp; } catch (e) {}
      const off = Math.max(0, (bStart - bt.start) * sp);
      bsrc.start(at, Math.min(off, Math.max(0, beatBuf.duration - 0.05)), Math.min(bSpan * sp, Math.max(0.02, beatBuf.duration - off)));
      stops.push(bsrc);
      stops.push({ stop() { try { bg.disconnect(); } catch (e) {} } });
    }
  }

  // 목소리 구간 — 조각별 볼륨(ev.gain) · 트랙 볼륨 · 음역 필터 · 최종 배속(sp)
  if (S.voice && S.voice.buffer) {
    const trackVol = clampNum(S.voiceTrack && S.voiceTrack.vol, 0, 1.5, 1);
    for (const ev of arr.voiceEvents) {
      const rate = ev.rate || 1;
      const evDur = (ev.bufEnd - ev.bufStart) / rate;
      const evEnd = ev.tStart + evDur;
      if (evEnd <= from + 0.002) continue;
      const skip = Math.max(0, from - ev.tStart);
      const dur = evDur - skip;
      if (dur < 0.02) continue;
      const bufStart = ev.bufStart + skip * rate;
      const at = T(ev.tStart + skip);
      const outDur = dur / sp;                      // 출력에서 차지하는 시간
      const src = ctx.createBufferSource();
      src.buffer = S.voice.buffer;
      try { src.playbackRate.value = rate * sp; } catch (e) {}
      const g = ctx.createGain();
      const vg = Math.max(0.0001, S.mix.voiceVol * (ev.gain == null ? 1 : ev.gain) * trackVol);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(vg, at + Math.min(0.012 / sp, outDur * 0.2));
      g.gain.setValueAtTime(vg, at + Math.max(0.013 / sp, outDur - 0.025 / sp));
      g.gain.linearRampToValueAtTime(0.0001, at + outDur);
      const chain = voiceFxChain(ctx, src, g);
      if (chain) stops.push({ stop() { for (const f of chain) { try { f.disconnect(); } catch (e) {} } } });
      g.connect(master);
      if (conv) { const send = ctx.createGain(); send.gain.value = S.mix.reverb; g.connect(send); send.connect(conv); }
      try {
        src.start(at, Math.min(bufStart, Math.max(0, S.voice.buffer.duration - 0.01)), dur * rate);
        src.stop(at + outDur + 0.04);
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
let previewBusy = false;

async function play() {
  if (playing) { stopPlayback(); return; }
  if (!S.voice && !S.videoUrl && !(S.songOn !== false && S.backing)) {
    toast('먼저 다인 영상을 올려 주세요');
    return;
  }
  if (previewBusy) return;
  previewBusy = true;
  stopAllPreviewAudio();
  try {
    const ctx = audioCtx();
    try { await ctx.resume(); } catch (e) {}
    const arr = rebuild();
    if (!arr.total) return;
    const beatBuf = S.beatOn !== false ? await getBeatBuffer(ctx, arr) : null;
    stopAllPreviewAudio();
    const speed = clampNum(S.outputSpeed, 0.25, 4, 1);
    const t0 = ctx.currentTime + 0.35;
    const mix = scheduleMix(ctx, ctx.destination, arr, t0, beatBuf, { speed });
    playState = { t0, mix, arr, start: performance.now(), started: false, speed };
    playing = true;
    el.btnPlay.textContent = '■ 정지';
    el.btnStop.hidden = false;
    el.playDot.classList.add('on');
    // 프리롤(t<0) 동안에는 영상을 틀지 않는다 — 음악이 시작되는 t=0에 맞춰 출발해야
    // 미리보기 영상이 소리보다 먼저 흘러가지 않는다(v1.6).
    engine.speed = speed;
    await engine.startAt(0, false);
    loop();
  } finally {
    previewBusy = false;
  }
}

function loop() {
  if (!playing || !playState) return;
  const ctx = audioCtx();
  const t = (ctx.currentTime - playState.t0) * (playState.speed || 1);   // 타임라인 초(배속 반영)
  const arr = playState.arr;
  if (t >= arr.total + 0.02) { stopPlayback(); return; }
  const show = Math.max(0, t);
  if (t >= 0 && playState && !playState.started) {   // 음악과 동시에 영상 출발
    playState.started = true;
    engine.playNow();
  }  if (t >= -0.001) {
    engine.sync(show);
    engine.follow(show);
  }
  const sc = sceneAt(show, engine.activeEl);
  lastDrawT = show;
  drawScene(el.previewCtx, sc);
  el.playerTime.textContent = show.toFixed(1);
  el.progressBar.style.width = `${clamp((show / arr.total) * 100, 0, 100)}%`;
  setPlayhead(show);
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
  stopAllPreviewAudio();
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
    buf = await decodeMediaFile(ctx, file, (p, msg) => { if (msg) setStatus(msg); });
  } catch (e) { err = e; }

  if (!buf) {
    S.voice = null;
    const why = (err && (err.userMessage || err.message)) || '오디오를 읽지 못했어요';
    el.voiceLoaded.hidden = false;
    el.voiceName.textContent = file.name;
    el.voiceDur.textContent = vDur ? `${vDur.toFixed(1)}초 영상 · 오디오 없음` : '오디오 없음';
    el.segList.innerHTML = '';
    el.segCount.textContent = '0';
    el.segOn.textContent = '0';
    try {
      const c = el.waveVoice.getContext('2d');
      c.clearRect(0, 0, el.waveVoice.width, el.waveVoice.height);
    } catch (e) {}
    el.segHint.textContent = `${why} · 영상은 그대로 미리보기와 렌더링에 쓸 수 있어요. 소리까지 살리려면 MP4로 변환하거나 아이폰 설정 → 카메라 → 포맷 → '호환성 우선'으로 다시 찍어 올려 주세요.`;
    el.segHint.hidden = false;
    toast(why, 3600);
    setStatus(`오디오 없음 · ${why}`);
    rebuild();
    return;
  }

  const segments = detectVoice(buf);
  // 손으로 만든 타임라인 배치는 같은 영상(이름·길이·구간 수)일 때만 이어 쓴다.
  const sig = `${file.name}|${(buf.duration || 0).toFixed(2)}|${segments.length}`;
  if (S.clipsFor !== sig) S.voiceClips = null;
  S.clipsFor = sig;
  const vp = peakOf(buf);
  const norm = clamp(0.55 / Math.max(0.01, vp), 0.6, 8);
  // 영상 길이를 못 읽었을 때(MediaRecorder WebM 등)는 오디오 길이를 쓴다 — 같은 영상의 소리
  if (!S.videoDur && buf.duration > 0) { S.videoDur = buf.duration; vDur = buf.duration; }
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
    let finished = false;
    const done = (val) => {
      if (finished) return;
      finished = true;
      const d = typeof val === 'number' ? val : v.duration;
      resolve(isFinite(d) && d > 0 ? d : 0);
    };
    v.addEventListener('loadedmetadata', () => {
      if (isFinite(v.duration) && v.duration > 0) return done(v.duration);
      // MediaRecorder로 만든 WebM 등은 duration이 Infinity/NaN으로 나온다.
      // 끝으로 한 번 시킹해 실제 길이를 받아낸 뒤 0으로 되돌린다.
      try { v.currentTime = 1e101; } catch (e) { done(0); }
      v.addEventListener('durationchange', () => { if (isFinite(v.duration) && v.duration > 0) { try { v.currentTime = 0; } catch (e) {} done(v.duration); } });
      setTimeout(() => done(0), 3000);
    }, { once: true });
    setTimeout(() => done(0), 4000);
  });
}

function renderSegments() {
  const segs = S.voice ? S.voice.segments : [];
  const list = el.segList;
  list.innerHTML = '';
  segs.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'seg' + (s.on ? '' : ' off') + (segAudio && segAudio.i === i ? ' playing' : '');
    row.dataset.i = String(i);
    row.innerHTML = `
      <button class="playseg" data-play="${i}" aria-label="${i + 1}번 구간 들어보기" title="들어보기">${segAudio && segAudio.i === i ? '■' : '▶'}</button>
      <div class="time"><b>${i + 1}</b> ${s.start.toFixed(2)}–${s.end.toFixed(2)}<em>${(s.end - s.start).toFixed(2)}초</em></div>
      <div class="nudge">
        <button class="mini" data-nudge="-1" data-i="${i}" title="시작점 50ms 앞으로" aria-label="시작 50ms 앞으로">◀</button>
        <button class="mini" data-nudge="1" data-i="${i}" title="시작점 50ms 뒤로" aria-label="시작 50ms 뒤로">▶</button>
      </div>
      <button class="usebtn ${s.on ? 'on' : ''}" data-use="${i}" aria-pressed="${s.on ? 'true' : 'false'}" title="${s.on ? '리믹스에서 빠기' : '리믹스에 넣기'}">${s.on ? '넣음' : '빠짐'}</button>`;
    list.appendChild(row);
  });
  el.segCount.textContent = String(segs.length);
  el.segOn.textContent = String(segs.filter((s) => s.on).length);
  el.segHint.hidden = segs.length > 0;
}

function nudgeSeg(i, dir) {
  const s = S.voice && S.voice.segments[i];
  if (!s) return;
  stopSegAudio();
  const d = 0.05 * dir;
  const len = s.end - s.start;
  s.start = clamp(s.start + d, 0, Math.max(0, S.voice.duration - len - 0.01));
  s.end = s.start + len;
  renderSegments();
  drawWave(el.waveVoice, S.voice.peaks, { markers: S.voice.segments, color: 'rgba(255,255,255,.5)' });
  rebuild();
}

// 한 번에 하나만 — 다른 구간을 누르면 이전 재생은 자동으로 멈춘다
function stopSegAudio() {
  if (segAudio) {
    const a = segAudio;
    segAudio = null;
    try { a.src.onended = null; } catch (e) {}
    try { a.src.stop(); } catch (e) {}
    try { a.src.disconnect(); } catch (e) {}
    try { a.g.disconnect(); } catch (e) {}
    if (a.chain) for (const f of a.chain) { try { f.disconnect(); } catch (e) {} }
  }
  if (el.segList) {
    el.segList.querySelectorAll('.seg.playing').forEach((r) => r.classList.remove('playing'));
    el.segList.querySelectorAll('[data-play]').forEach((b) => { b.textContent = '▶'; });
  }
}

function playSegment(i) {
  if (segAudio && segAudio.i === i) { stopSegAudio(); return; }
  stopAllPreviewAudio();
  const s = S.voice && S.voice.segments[i];
  if (!s) return;
  const ctx = audioCtx();
  try { ctx.resume(); } catch (e) {}
  const src = ctx.createBufferSource();
  src.buffer = S.voice.buffer;
  const g = ctx.createGain();
  g.gain.value = clampNum(S.mix.voiceVol * clampNum(S.voiceTrack && S.voiceTrack.vol, 0, 1.5, 1), 0.0001, 2);
  const chain = voiceFxChain(ctx, src, g);
  g.connect(ctx.destination);
  const dur = Math.min(s.end - s.start, 10);
  src.start(0, s.start, dur);
  segAudio = { i, src, g, chain };
  src.onended = () => { if (segAudio && segAudio.src === src) stopSegAudio(); };
  renderSegments();
  toast(`${i + 1}번 구간 ${dur.toFixed(2)}초 · ${S.voiceFx === 'baby' ? '아기 고음 위주' : '전체 목소리'}`);
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

// ── 가져온 음원의 첫 박(다운비트)을 자동으로 찾아 박자 그리드에 맞춘다 (v1.5)
let gridTimer = 0;

function applyGrid(silent) {
  if (!S.backing) {
    if (!silent) toast('먼저 음원을 올려 주세요');
    return;
  }
  let res = { offset: S.offsetBack || 0, confidence: 0, beats: 0 };
  try { res = detectGridOffset(S.backing.buffer, S.trim.start, S.trim.end, S.bpm || 128); } catch (e) {}
  if (res.confidence >= 0.08 || !S.offsetBack) {
    S.offsetBack = clamp(res.offset, 0, 60 / (S.bpm || 128));
  }
  S.gridConf = res.confidence;
  if (el.offsetBack) el.offsetBack.value = S.offsetBack.toFixed(2);
  if (el.gridInfo) {
    el.gridInfo.innerHTML = `첫 박 <b>+${S.offsetBack.toFixed(2)}초</b> · 신뢰도 ${Math.round(res.confidence * 100)}%<br>옹알이 조각이 이 박자 그리드에 맞춰 썰려서 들어가요.`;
  }
  rebuild();
  saveState();
  if (!silent) toast(`🎯 첫 박을 ${S.offsetBack.toFixed(2)}초로 맞췄어요`);
}

function scheduleGrid() {
  clearTimeout(gridTimer);
  gridTimer = setTimeout(() => { if (S.backing) applyGrid(true); }, 260);
}

async function onBackFile(file, opts = {}) {
  if (!file) return false;
  stopAllPreviewAudio();
  setStatus('배경노래를 분석하는 중…');
  el.songUrlMsg && (el.songUrlMsg.className = 'status', el.songUrlMsg.textContent = '');
  const ctx = audioCtx();
  try {
    const buf = await decodeMediaFile(ctx, file, (p, msg) => { if (msg) setStatus(msg); });
    S.backing = {
      name: opts.name || file.name,
      buffer: buf,
      peaks: waveformPeaks(buf, 1400),
      duration: buf.duration,
      norm: clamp(0.6 / Math.max(0.01, peakOf(buf)), 0.5, 6),
      kind: opts.kind || 'file',
    };
    S.songOn = true;
    S.trim = { start: 0, end: Math.min(buf.duration, 30) };
    S.offsetBack = 0;
    S.songTrack = { ...(S.songTrack || {}), start: 0, len: 0, srcOffset: 0 };
    S.voiceClips = null;          // 노래가 바뀌면 박자 그리드도 바뀌므로 자동 배치로
    el.backLoaded.hidden = false;
    el.dropBack.style.display = 'none';
    el.backName.textContent = S.backing.name;
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
    S.songBpm = est && est.bpm ? clamp(Math.round(est.bpm), 60, 200) : 0;
    el.bpmEst.textContent = S.songBpm ? `${S.songBpm}` : '–';
    el.btnBpmApply.hidden = !S.songBpm;
    el.btnBpmApply.dataset.bpm = S.songBpm ? String(S.songBpm) : '';
    // 추정 BPM을 그대로 쓰면 박자 그리드·컷이 노래와 어긋난다 → 신뢰도가 있으면 자동 적용
    if (S.songBpm && Math.abs(S.songBpm - S.bpm) > 0.5) {
      const keepTotal = S.arr ? S.arr.total : 0;
      S.bpm = clamp(Math.round(S.songBpm), 90, 160);
      el.bpm.value = String(S.bpm);
      el.bpmOut.textContent = String(S.bpm);
      fitAutoTitles();
      if (keepTotal > 2) S.sections = fitToSeconds(S.sections, S.bpm, keepTotal);
      toast(`추정 BPM ${S.songBpm}로 박자를 자동으로 맞췄어요`);
    }
    applyGrid(true);
    syncMixMode();
    rebuild();
    saveState();
    setStatus(`${S.backing.name} · ${buf.duration.toFixed(1)}초${S.songBpm ? ` · 추정 ${S.songBpm} BPM` : ''} · 첫 박 +${(S.offsetBack || 0).toFixed(2)}초`);
    toast(opts.kind === 'url' ? '링크에서 배경노래를 불러왔어요' : '배경노래를 불러왔어요. 쓸 구간을 골라 주세요');
    return true;
  } catch (e) {
    const why = (e && (e.userMessage || e.message)) || '이 파일의 오디오를 읽지 못했어요 (MP3/M4A/WAV 권장)';
    if (opts.kind === 'url') {
      el.songUrlMsg.className = 'status err';
      el.songUrlMsg.textContent = `이 링크의 소리를 읽지 못했어요 · ${why}`;
    }
    toast(why, 3400);
    setStatus(`배경노래를 읽지 못했어요 · ${why}`);
    return false;
  }
}

// 🎵 음악·동영상 URL로 배경노래 넣기 (v1.7)
//  · 직접 오디오/비디오 주소면 fetch → 디코딩(영상이면 오디오 트랙만 추출)
//  · CORS·플랫폼(유튜브 등) 차단이면 멈추지 않고 한국어로 다음 방법을 안내한다.
function YouTubeUrl(u) {
  return /(^|\/\/)((www|m)\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(u);
}

async function loadSongFromUrl() {
  const url = (el.songUrl.value || '').trim();
  el.songUrlMsg.className = 'status';
  el.songUrlMsg.textContent = '';
  if (!/^https?:\/\//i.test(url)) {
    el.songUrlMsg.className = 'status err';
    el.songUrlMsg.textContent = 'https:// 로 시작하는 음악·동영상 주소를 넣어 주세요.';
    return;
  }
  if (YouTubeUrl(url)) {
    el.songUrlMsg.className = 'status err';
    el.songUrlMsg.innerHTML = '유튜브 링크는 브라우저가 직접 가져오지 못해요(차단). 아래 <b>유튜브 링크로 가져오기</b>를 눌러 보거나, 유튜브 화면 녹화 영상·저장한 음원 파일을 올려주세요.';
    return;
  }
  stopAllPreviewAudio();
  el.songUrlMsg.textContent = '링크에서 소리를 받는 중…';
  setStatus('배경노래를 받는 중…');
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    if (blob.size < 2048) throw new Error('파일이 너무 작아요');
    let name = '배경노래';
    try { name = decodeURIComponent((url.split('/').pop() || '').split('?')[0]) || name; } catch (e) {}
    const type = blob.type && /^(audio|video)\//.test(blob.type) ? blob.type : (/\.[a-z0-9]+$/i.test(name) ? '' : 'audio/mpeg');
    const file = new File([blob], name, { type });
    const ok = await onBackFile(file, { kind: 'url', name });
    if (ok) {
      el.songUrlMsg.className = 'status ok';
      el.songUrlMsg.textContent = '링크에서 배경노래를 불러왔어요. 구간을 골라 주세요.';
      el.songUrl.value = '';
    } else {
      el.songUrlMsg.className = 'status err';
      el.songUrlMsg.innerHTML = '링크는 열렸지만 이 형식의 소리를 브라우저가 읽지 못했어요. MP3·M4A·WAV 파일이나 MP4·MOV 영상으로 올려주세요.';
    }
  } catch (e) {
    const why = String((e && e.message) || e);
    el.songUrlMsg.className = 'status err';
    el.songUrlMsg.innerHTML = `이 링크는 보안(CORS)·접속 제한으로 직접 불러올 수 없어요. <b>폰에 저장된 파일</b>이나 <b>화면녹화 영상</b>으로 올려주세요.<br><span class="dim">${why.slice(0, 90)}</span>`;
    setStatus('링크를 직접 불러오지 못했어요 (CORS)');
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
// ──────────────────────────────────────────────────────
// 미리듣기 오디오 단일 관리 (v1.5)
//  · 구간 ▶, 내 음원 '이 구간 듣기', 타임라인 듣기, 전체 미리보기가
//    절대 겹쳐 울리지 않도록 새 소리를 내기 전에 항상 stopAllPreviewAudio()를 부른다.
const previewPool = new Set();

function stopOneShotAudio() {
  for (const rec of previewPool) {
    try { rec.src.onended = null; } catch (e) {}
    try { rec.src.stop(); } catch (e) {}
    try { rec.src.disconnect(); } catch (e) {}
    try { rec.g.disconnect(); } catch (e) {}
  }
  previewPool.clear();
}

function playOneShot(buffer, offset, dur, vol) {
  if (!buffer) return null;
  const ctx = audioCtx();
  try { ctx.resume(); } catch (e) {}
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const g = ctx.createGain();
  g.gain.value = clampNum(vol, 0.0001, 2);
  src.connect(g);
  g.connect(ctx.destination);
  const rec = { src, g };
  previewPool.add(rec);
  src.onended = () => { previewPool.delete(rec); try { g.disconnect(); } catch (e) {} };
  const off = clamp(offset, 0, Math.max(0, buffer.duration - 0.01));
  src.start(0, off, Math.max(0.01, Math.min(dur, buffer.duration - off)));
  return rec;
}

// 앱 안의 모든 미리듣기(구간 · 원본 구간 · 타임라인 · 전체 미리보기)를 즉시 정리
function stopAllPreviewAudio() {
  stopSegAudio();
  stopOneShotAudio();
  tlStop(true);
  if (playing) stopPlayback(true);
  try {
    document.querySelectorAll('audio').forEach((a) => { a.pause(); a.currentTime = 0; });
  } catch (e) {}
}

// 🎛️ 캡컷 스타일 멀티트랙 타임라인 (v1.5)
//  위: 🎙️ 옹알이 조각들 · 아래: 🎵 비트/배경 음원
//  손가락(pointer)으로 밀어 위치·길이를 바꾸고, 재생선으로 바로 들어본다.
//  여기서 만든 배치는 scheduleMix를 그대로 거쳐 미리듣기·WAV·MP4에 100% 반영된다.
function clipList() {
  return Array.isArray(S.voiceClips) ? S.voiceClips : null;
}

function clipById(id) {
  const list = clipList();
  return list ? list.find((c) => c.id === id) : null;
}

function segById(id) {
  return S.voice ? S.voice.segments.find((s) => s.id === id) : null;
}

// 지금 화면에 보이는 자동 배치를 손으로 만질 수 있는 조각(clip) 목록으로 바꿔 둔다.
function materializeClips() {
  if (clipList() || !S.arr) return;
  const off = clampNum(S.voiceTrack && S.voiceTrack.offset, -2, 6, 0);
  S.voiceClips = S.arr.voiceEvents.map((ev, i) => ({
    id: ev.id || 'c' + i,
    segId: ev.segId,
    at: +Math.max(0, ev.tStart - off).toFixed(4),
    len: +(ev.bufEnd - ev.bufStart).toFixed(4),
    vol: ev.gain == null ? 1 : ev.gain,
  }));
}

function renderTimeline() {
  const arr = S.arr;
  if (!arr || !el.tlVoiceLane) return;
  const total = Math.max(0.2, arr.total);
  const pct = (t) => `${(clamp(t, 0, total) / total) * 100}%`;

  // 눈금
  if (el.tlRuler) {
    el.tlRuler.innerHTML = '';
    const step = total <= 12 ? 1 : total <= 30 ? 2 : 5;
    for (let s = 0; s <= total + 0.001; s += step) {
      const tick = document.createElement('i');
      tick.className = 'tl-tick';
      tick.style.left = pct(s);
      tick.innerHTML = `<span>${s.toFixed(0)}</span>`;
      el.tlRuler.appendChild(tick);
    }
    const endTick = document.createElement('i');
    endTick.className = 'tl-tick end';
    endTick.style.left = '100%';
    el.tlRuler.appendChild(endTick);
  }

  // 🎙️ 옹알이 트랙
  el.tlVoiceLane.innerHTML = '';
  if (!arr.voiceEvents.length) {
    const hint = document.createElement('span');
    hint.className = 'tl-empty';
    hint.textContent = S.voice ? '넣은 구간이 없어요 · 구간을 켜 주세요' : '영상을 올리면 목소리 조각이 여기에 놓여요';
    el.tlVoiceLane.appendChild(hint);
  }
  arr.voiceEvents.forEach((ev, i) => {
    const dur = Math.max(0.04, ev.tEnd - ev.tStart);
    const w = (dur / total) * 100;
    const b = document.createElement('div');
    b.className = 'tlclip' + (w < 7.5 ? ' narrow' : '') + (tl.sel === ev.id ? ' sel' : '') + ((ev.gain == null ? 1 : ev.gain) < 0.02 ? ' mute' : '');
    b.dataset.id = ev.id;
    b.dataset.kind = 'voice';
    b.style.left = pct(ev.tStart);
    b.style.width = `${w}%`;
    b.title = `조각 ${i + 1} · ${ev.tStart.toFixed(2)}–${ev.tEnd.toFixed(2)}초 · 볼륨 ${Math.round((ev.gain == null ? 1 : ev.gain) * 100)}%`;
    b.innerHTML = `<span class="tlclip-t">🎙️${i + 1}</span><i class="tlh tlh-r" data-h="r"></i>`;
    el.tlVoiceLane.appendChild(b);
  });

  // 🎵 배경노래 트랙
  if (el.tlSongLane) {
    el.tlSongLane.innerHTML = '';
    const st = arr.songTrack || { start: 0, len: 0, vol: 1 };
    const song = document.createElement('div');
    song.dataset.id = 'song';
    song.dataset.kind = 'song';
    if (!S.backing || S.songOn === false) {
      song.className = 'tlbeat empty' + (tl.sel === 'song' ? ' sel' : '');
      song.style.left = '0%';
      song.style.width = '100%';
      song.innerHTML = `<span class="tlclip-t">${S.backing ? '🎵 배경노래 꺼짐 · 눌러서 켜기' : '🎵 배경노래를 올리면 여기에 놓여요'}</span>`;
      song.title = S.backing ? '배경노래 끄기 상태 — 눌러서 켜기' : '배경노래 없음';
    } else {
      song.className = 'tlbeat song' + (tl.sel === 'song' ? ' sel' : '');
      song.style.left = pct(st.start);
      song.style.width = `${(Math.max(0.1, st.len) / total) * 100}%`;
      const nm = (S.backing.name || '배경노래').replace(/\.[a-z0-9]+$/i, '');
      song.title = `배경노래 ${st.start.toFixed(2)}–${st.end.toFixed(2)}초 · 볼륨 ${Math.round((st.vol == null ? 1 : st.vol) * 100)}%`;
      song.innerHTML = `<span class="tlclip-t">🎵 ${nm}</span><i class="tlh tlh-l" data-h="l"></i><i class="tlh tlh-r" data-h="r"></i>`;
    }
    el.tlSongLane.appendChild(song);
  }

  // 🥁 장르 비트 트랙
  el.tlBeatLane.innerHTML = '';
  const bt = arr.beatTrack;
  const beat = document.createElement('div');
  beat.className = 'tlbeat' + (S.beatOn === false ? ' beatoff' : '') + (tl.sel === 'beat' ? ' sel' : '');
  beat.dataset.id = 'beat';
  beat.dataset.kind = 'beat';
  beat.style.left = pct(bt.start);
  beat.style.width = `${(Math.max(0.1, bt.len) / total) * 100}%`;
  const beatName = S.beatOn === false ? '장르 비트 끔' : `${(GENRES[S.genre] || GENRES.techno).label} ${S.bpm} BPM`;
  beat.title = `장르 비트 ${bt.start.toFixed(2)}–${bt.end.toFixed(2)}초 · 볼륨 ${Math.round((bt.vol == null ? 1 : bt.vol) * 100)}%`;
  beat.innerHTML = `<span class="tlclip-t">${S.beatOn === false ? '🔇' : '🥁'} ${beatName}</span><i class="tlh tlh-l" data-h="l"></i><i class="tlh tlh-r" data-h="r"></i>`;
  el.tlBeatLane.appendChild(beat);

  if (el.tlInfo) {
    const on = [];
    if (S.backing && S.songOn !== false) on.push('노래');
    if (S.beatOn !== false) on.push('비트');
    on.push('옹알이');
    el.tlInfo.textContent = `${on.join('+')} · 총 ${total.toFixed(1)}초 · 조각 ${arr.voiceEvents.length}개`;
  }
  if (el.tlAuto) el.tlAuto.hidden = !clipList();
  syncTlSliders();
  setPlayhead(tl.t);
  updateTlPanel();
}

function syncTlSliders() {
  const arr = S.arr;
  if (!arr || !el.vtOffset) return;
  const total = Math.max(0.2, arr.total);
  const vt = S.voiceTrack || {};
  const bt = S.beatTrack || {};
  el.vtOffset.max = '3';
  el.vtOffset.value = String(clampNum(vt.offset, 0, 3, 0));
  el.vtOffsetOut.textContent = `${clampNum(vt.offset, 0, 3, 0).toFixed(2)}초`;
  el.vtVol.value = String(clampNum(vt.vol, 0, 1.5, 1));
  el.vtVolOut.textContent = `${Math.round(clampNum(vt.vol, 0, 1.5, 1) * 100)}%`;

  el.btStart.max = total.toFixed(1);
  el.btStart.value = String(clampNum(bt.start, 0, total, 0));
  el.btStartOut.textContent = `${clampNum(bt.start, 0, total, 0).toFixed(2)}초`;
  el.btLen.max = total.toFixed(1);
  const len = clampNum(bt.len, 0, total, 0);
  el.btLen.value = String(len > 0.05 ? len : total);
  el.btLenOut.textContent = len > 0.05 ? `${len.toFixed(2)}초` : '끝까지';
  el.btVol.value = String(clampNum(bt.vol, 0, 1.5, 1));
  el.btVolOut.textContent = `${Math.round(clampNum(bt.vol, 0, 1.5, 1) * 100)}%`;
  el.btFadeIn.value = String(clampNum(bt.fadeIn, 0, 5, 0));
  el.btFadeInOut.textContent = `${clampNum(bt.fadeIn, 0, 5, 0).toFixed(2)}초`;
  el.btFadeOut.value = String(clampNum(bt.fadeOut, 0, 5, 0));
  el.btFadeOutOut.textContent = `${clampNum(bt.fadeOut, 0, 5, 0).toFixed(2)}초`;
  // 🎵 배경노래 트랙
  const st = (arr.songTrack || {});
  if (el.stStart) {
    el.stStart.max = total.toFixed(1);
    el.stStart.value = String(clampNum(st.start, 0, total, 0));
    el.stStartOut.textContent = `${clampNum(st.start, 0, total, 0).toFixed(2)}초`;
    el.stLen.max = total.toFixed(1);
    const slen = clampNum(st.len, 0, total, 0);
    el.stLen.value = String(slen > 0.05 ? slen : total);
    el.stLenOut.textContent = slen > 0.05 ? `${slen.toFixed(2)}초` : '끝까지';
    el.stVol.value = String(clampNum(st.vol, 0, 1.5, 1));
    el.stVolOut.textContent = `${Math.round(clampNum(st.vol, 0, 1.5, 1) * 100)}%`;
    el.stFadeIn.value = String(clampNum(st.fadeIn, 0, 5, 0));
    el.stFadeInOut.textContent = `${clampNum(st.fadeIn, 0, 5, 0).toFixed(2)}초`;
    el.stFadeOut.value = String(clampNum(st.fadeOut, 0, 5, 0));
    el.stFadeOutOut.textContent = `${clampNum(st.fadeOut, 0, 5, 0).toFixed(2)}초`;
  }
  if (el.songVol && S.songTrack) {
    el.songVol.value = String(clampNum(S.songTrack.vol, 0, 1.5, 1));
    el.songVolOut.textContent = `${Math.round(clampNum(S.songTrack.vol, 0, 1.5, 1) * 100)}%`;
  }
  if (el.btDuck) {
    const d = clampNum(S.beatDuck, 0, 10, 0);
    el.btDuck.value = String(d);
    el.btDuckOut.textContent = d < 0.2 ? '끔' : `-${d.toFixed(1)}dB`;
  }
  if (el.gridInfo) {
    el.gridInfo.innerHTML = S.backing
      ? `첫 박 <b>+${(S.offsetBack || 0).toFixed(2)}초</b> · 신뢰도 ${Math.round((S.gridConf || 0) * 100)}%<br>옹알이 조각이 이 박자 그리드에 맞춰 썰려서 들어가요.`
      : '음원을 올리면 첫 박을 자동으로 찾아 맞춰요.';
  }
}

function setPlayhead(t) {
  const arr = S.arr;
  if (!el.tlHeadLine || !arr || !el.tlVoiceLane || !el.tlBody) return;
  const total = Math.max(0.2, arr.total);
  const lane = el.tlVoiceLane;
  const body = el.tlBody;
  const left = (lane.offsetLeft || 0) + (clamp(t, 0, total) / total) * (lane.clientWidth || 1);
  el.tlHeadLine.style.left = `${left}px`;
  el.tlHeadLine.style.opacity = '1';
  if (el.tlPos) el.tlPos.textContent = `${clamp(t, 0, total).toFixed(1)} / ${total.toFixed(1)}초`;
  if (el.tlRuler) el.tlRuler.style.setProperty('--head', `${(clamp(t, 0, total) / total) * 100}%`);
  void body;
}

function updateTlPanel() {
  const panel = el.tlClipPanel;
  if (!panel) return;
  const arr = S.arr;
  if (!arr || !tl.sel) { panel.hidden = true; return; }
  if (tl.sel === 'beat' || tl.sel === 'song') {
    // 비트·노래 블록은 아래 '트랙 슬라이더'로 조절하므로 조각 패널은 띄우지 않는다.
    panel.hidden = true;
    return;
  }
  const ev = arr.voiceEvents.find((e) => e.id === tl.sel);
  if (!ev) { panel.hidden = true; return; }
  const idx = arr.voiceEvents.indexOf(ev);
  const clip = clipById(ev.id);
  const seg = segById(ev.segId);
  const maxLen = seg ? (seg.end - seg.start) / (ev.rate || 1) : 5;
  panel.hidden = false;
  el.tlpTitle.textContent = `🎙️ 조각 ${idx + 1} · ${ev.tStart.toFixed(2)}–${ev.tEnd.toFixed(2)}초`;
  el.tlpAt.max = Math.max(0.1, arr.total - 0.1).toFixed(2);
  el.tlpAt.value = String(clampNum(ev.tStart - clampNum(S.voiceTrack && S.voiceTrack.offset, -2, 6, 0), 0, arr.total, 0));
  el.tlpAtOut.textContent = `${(+el.tlpAt.value).toFixed(2)}초`;
  el.tlpLen.max = maxLen.toFixed(2);
  el.tlpLen.value = String(Math.min(maxLen, (ev.bufEnd - ev.bufStart) / (ev.rate || 1)));
  el.tlpLenOut.textContent = `${(+el.tlpLen.value).toFixed(2)}초`;
  el.tlpVol.value = String(clampNum(ev.gain, 0, 1.5, 1));
  el.tlpVolOut.textContent = `${Math.round(clampNum(ev.gain, 0, 1.5, 1) * 100)}%`;
  el.tlpPlay.textContent = '▶ 이 조각 들어보기';
  el.tlpOff.hidden = false;
  el.tlpOff.textContent = '이 구간 빼기';
  void clip;
}

// ── 타임라인 미리듣기(오디오) + 재생선
async function tlPlayToggle() {
  if (tl.playing) { tlStop(); return; }
  if (previewBusy) return;
  previewBusy = true;
  stopAllPreviewAudio();
  try {
    const ctx = audioCtx();
    try { await ctx.resume(); } catch (e) {}
    const arr = rebuild();
    if (!arr.total) return;
    const from = clampNum(tl.t, 0, Math.max(0, arr.total - 0.15), 0);
    const beatBuf = S.beatOn !== false ? await getBeatBuffer(ctx, arr) : null;
    stopAllPreviewAudio();
    const speed = clampNum(S.outputSpeed, 0.25, 4, 1);
    const t0 = ctx.currentTime + 0.18;
    const mix = scheduleMix(ctx, ctx.destination, arr, t0, beatBuf, { from, speed });
    tl.state = { t0, from, arr, mix, speed };
    tl.playing = true;
    el.tlPlay.textContent = '■ 멈춤';
    loopTl();
  } finally {
    previewBusy = false;
  }
}

function loopTl() {
  if (!tl.playing || !tl.state) return;
  const ctx = audioCtx();
  const t = tl.state.from + (ctx.currentTime - tl.state.t0) * (tl.state.speed || 1);
  if (t >= tl.state.arr.total - 0.01) { tlStop(true); return; }
  if (t >= 0) {
    tl.t = Math.max(0, t);
    setPlayhead(tl.t);
    el.playerTime.textContent = tl.t.toFixed(1);
    el.progressBar.style.width = `${clamp((tl.t / tl.state.arr.total) * 100, 0, 100)}%`;
    drawScene(el.previewCtx, sceneAt(tl.t, engine.activeEl));
  }
  tl.raf = requestAnimationFrame(loopTl);
}

function tlStop(silent) {
  const was = tl.playing;
  tl.playing = false;
  cancelAnimationFrame(tl.raf);
  if (tl.state) { try { tl.state.mix.stop(); } catch (e) {} }
  tl.state = null;
  if (el.tlPlay) el.tlPlay.textContent = '▶ 타임라인 듣기';
  if (was && !silent) setPlayhead(tl.t);
  if (was && silent) { el.progressBar.style.width = '0%'; tl.t = 0; setPlayhead(0); el.playerTime.textContent = '0.0'; }
}

// ── 타임라인 조작 (포인터 드래그 + 보조 슬라이더)
function laneSec(clientX) {
  const arr = S.arr;
  const lane = el.tlVoiceLane;
  if (!arr || !lane) return 0;
  const r = lane.getBoundingClientRect();
  return clamp(((clientX - r.left) / Math.max(1, r.width)) * arr.total, 0, arr.total);
}

function beginDrag(e, block) {
  const arr = S.arr;
  if (!arr) return;
  if (tl.playing) tlStop();
  const id = block.dataset.id;
  tl.sel = id;
  const kind = block.dataset.kind;
  const handle = e.target.closest('.tlh');
  const t = laneSec(e.clientX);
  if (kind === 'voice') {
    if (!clipList()) { materializeClips(); rebuild(); }
    const clip = clipById(id);
    if (!clip) return;
    tl.drag = {
      id, kind, mode: handle ? (handle.dataset.h === 'l' ? 'resize-l' : 'resize-r') : 'move',
      x0: e.clientX, t0: t, at0: clip.at, len0: clip.len, block,
    };
  } else if (kind === 'song') {
    if (!S.backing) { el.fileBack.click(); return; }
    if (S.songOn === false) {
      S.songOn = true;
      syncMixMode(); rebuild(); saveState(); renderTimeline();
      toast('🎵 배경노래를 켰어요');
      return;
    }
    const st = S.songTrack || (S.songTrack = {});
    const start = clampNum(st.start, 0, arr.total, 0);
    const len = clampNum(st.len, 0, arr.total, 0) || Math.max(0.2, arr.total - start);
    tl.drag = {
      id: 'song', kind: 'song', mode: handle ? (handle.dataset.h === 'l' ? 'resize-l' : 'resize-r') : 'move',
      x0: e.clientX, t0: t, at0: start, len0: len, block,
    };
  } else {
    const bt = S.beatTrack;
    const start = clampNum(bt.start, 0, arr.total, 0);
    const len = clampNum(bt.len, 0, arr.total, 0) || Math.max(0.2, arr.total - start);
    tl.drag = {
      id: 'beat', kind: 'beat', mode: handle ? (handle.dataset.h === 'l' ? 'resize-l' : 'resize-r') : 'move',
      x0: e.clientX, t0: t, at0: start, len0: len, block,
    };
  }
  try { block.setPointerCapture(e.pointerId); } catch (err) {}
  block.classList.add('drag');
  [el.tlVoiceLane, el.tlSongLane, el.tlBeatLane].forEach((ln) => {
    if (ln) ln.querySelectorAll('.tlclip.sel, .tlbeat.sel').forEach((n) => n.classList.remove('sel'));
  });
  block.classList.add('sel');
  showTlPanel();
  e.preventDefault();
}

function moveDrag(e) {
  const d = tl.drag;
  const arr = S.arr;
  if (!d || !arr) return;
  const lane = el.tlVoiceLane;
  const w = Math.max(1, lane.getBoundingClientRect().width);
  const dt = ((e.clientX - d.x0) / w) * arr.total;
  const snap = (v) => Math.round(v * 20) / 20;   // 0.05초 단위
  const total = arr.total;
  if (d.kind === 'voice') {
    const clip = clipById(d.id);
    if (!clip) return;
    const seg = segById(clip.segId);
    const maxLen = seg ? (seg.end - seg.start) / (S.mix.pitch || 1) : d.len0;
    if (d.mode === 'move') {
      clip.at = +clamp(snap(d.at0 + dt), 0, Math.max(0, total - 0.15)).toFixed(3);
      d.block.style.left = `${(clip.at / total) * 100}%`;
      const off = clampNum(S.voiceTrack && S.voiceTrack.offset, -2, 6, 0);
      const dur = (S.arr && S.arr.voiceEvents.find((x) => x.id === d.id));
      const span = dur ? dur.tEnd - dur.tStart : clip.len;
      if (el.tlpTitle) el.tlpTitle.textContent = `🎙️ 조각 · ${(clip.at + off).toFixed(2)}–${(clip.at + off + span).toFixed(2)}초`;
    } else if (d.mode === 'resize-r') {
      clip.len = +clamp(snap(d.len0 + dt), 0.1, Math.max(0.1, maxLen)).toFixed(3);
      d.block.style.width = `${((clip.len / (S.mix.pitch || 1)) / total) * 100}%`;
    }
    if (el.tlpAt) el.tlpAt.value = String(clip.at);
    if (el.tlpAtOut) el.tlpAtOut.textContent = `${clip.at.toFixed(2)}초`;
    if (el.tlpLen) el.tlpLen.value = String(Math.min(clip.len, +el.tlpLen.max));
    if (el.tlpLenOut) el.tlpLenOut.textContent = `${Math.min(clip.len, +el.tlpLen.max).toFixed(2)}초`;
  } else {
    const tr = d.kind === 'song' ? S.songTrack : S.beatTrack;
    if (d.mode === 'move') {
      tr.start = +clamp(snap(d.at0 + dt), 0, Math.max(0, total - 0.2)).toFixed(3);
      tr.len = +Number(d.len0).toFixed(3);
      d.block.style.left = `${(tr.start / total) * 100}%`;
    } else if (d.mode === 'resize-r') {
      tr.len = +clamp(snap(d.len0 + dt), 0.2, Math.max(0.2, total - tr.start)).toFixed(3);
      d.block.style.width = `${(tr.len / total) * 100}%`;
    } else if (d.mode === 'resize-l') {
      const start = clamp(snap(d.at0 + dt), 0, d.at0 + d.len0 - 0.2);
      tr.start = +start.toFixed(3);
      tr.len = +(d.len0 - (start - d.at0)).toFixed(3);
      d.block.style.left = `${(tr.start / total) * 100}%`;
      d.block.style.width = `${(tr.len / total) * 100}%`;
    }
    syncTlSliders();
    if (el.tlInfo) {
      el.tlInfo.textContent = `${d.kind === 'song' ? '🎵 노래' : '🥁 비트'} ${tr.start.toFixed(2)}–${(tr.start + tr.len).toFixed(2)}초`;
    }
  }
  e.preventDefault();
}

function endDrag() {
  const d = tl.drag;
  if (!d) return;
  tl.drag = null;
  try { d.block.classList.remove('drag'); } catch (e) {}
  rebuild();
  saveState();
  renderTimeline();
}

function scrubTo(clientX) {
  const t = laneSec(clientX);
  tl.t = t;
  staticT = t;
  setPlayhead(t);
  el.playerTime.textContent = t.toFixed(1);
  engine.showStatic(t);
  scheduleDraw();
}

function showTlPanel() {
  if (!el.tlClipPanel) return;
  el.tlClipPanel.hidden = false;
  updateTlPanel();
}

function bindTimeline() {
  const lanes = [el.tlVoiceLane, el.tlSongLane, el.tlBeatLane].filter(Boolean);
  lanes.forEach((lane) => {
    lane.addEventListener('pointerdown', (e) => {
      const block = e.target.closest('.tlclip, .tlbeat');
      if (!block) { tl.sel = null; renderTimeline(); scrubTo(e.clientX); return; }
      beginDrag(e, block);
    });
    lane.addEventListener('pointermove', (e) => { if (tl.drag) moveDrag(e); });
    lane.addEventListener('pointerup', endDrag);
    lane.addEventListener('pointercancel', endDrag);
  });
  if (el.tlRuler) {
    el.tlRuler.addEventListener('pointerdown', (e) => {
      if (tl.playing) tlStop();
      scrubTo(e.clientX);
      el.tlRuler.setPointerCapture(e.pointerId);
    });
    el.tlRuler.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') scrubTo(e.clientX); });
  }
  if (el.tlPlay) el.tlPlay.addEventListener('click', () => tlPlayToggle());
  if (el.tlAuto) el.tlAuto.addEventListener('click', () => {
    S.voiceClips = null;
    tl.sel = null;
    rebuild(); saveState(); renderTimeline();
    toast('자동 배치로 돌아왔어요');
  });

  // 트랙 보조 슬라이더
  const onRange = (node, out, apply, fmt) => {
    if (!node) return;
    node.addEventListener('input', () => {
      apply(+node.value);
      if (out) out.textContent = fmt(+node.value);
      if (tl.playing) { tlStop(); tlPlayToggle(); }
      rebuild();
    });
    node.addEventListener('change', saveState);
  };
  onRange(el.vtOffset, el.vtOffsetOut,
    (v) => { S.voiceTrack = { ...(S.voiceTrack || {}), offset: v }; },
    (v) => `${v.toFixed(2)}초`);
  onRange(el.vtVol, el.vtVolOut,
    (v) => { S.voiceTrack = { ...(S.voiceTrack || {}), vol: v }; },
    (v) => `${Math.round(v * 100)}%`);
  onRange(el.btStart, el.btStartOut,
    (v) => { S.beatTrack = { ...(S.beatTrack || {}), start: v }; },
    (v) => `${v.toFixed(2)}초`);
  // 🎵 배경노래 트랙 슬라이더
  onRange(el.stStart, el.stStartOut,
    (v) => { S.songTrack = { ...(S.songTrack || {}), start: v }; },
    (v) => `${v.toFixed(2)}초`);
  onRange(el.stLen, el.stLenOut,
    (v) => { S.songTrack = { ...(S.songTrack || {}), len: v }; },
    (v) => `${v.toFixed(2)}초`);
  onRange(el.stVol, el.stVolOut,
    (v) => { S.songTrack = { ...(S.songTrack || {}), vol: v }; },
    (v) => `${Math.round(v * 100)}%`);
  onRange(el.stFadeIn, el.stFadeInOut,
    (v) => { S.songTrack = { ...(S.songTrack || {}), fadeIn: v }; },
    (v) => `${v.toFixed(2)}초`);
  onRange(el.stFadeOut, el.stFadeOutOut,
    (v) => { S.songTrack = { ...(S.songTrack || {}), fadeOut: v }; },
    (v) => `${v.toFixed(2)}초`);
  onRange(el.btLen, el.btLenOut,
    (v) => { S.beatTrack = { ...(S.beatTrack || {}), len: v }; },
    (v) => `${v.toFixed(2)}초`);
  onRange(el.btVol, el.btVolOut,
    (v) => { S.beatTrack = { ...(S.beatTrack || {}), vol: v }; },
    (v) => `${Math.round(v * 100)}%`);
  onRange(el.btFadeIn, el.btFadeInOut,
    (v) => { S.beatTrack = { ...(S.beatTrack || {}), fadeIn: v }; },
    (v) => `${v.toFixed(2)}초`);
  onRange(el.btFadeOut, el.btFadeOutOut,
    (v) => { S.beatTrack = { ...(S.beatTrack || {}), fadeOut: v }; },
    (v) => `${v.toFixed(2)}초`);
  onRange(el.btDuck, el.btDuckOut,
    (v) => { S.beatDuck = v; },
    (v) => (v < 0.2 ? '끔' : `-${v.toFixed(1)}dB`));

  // 선택한 조각 패널
  if (el.tlpAt) {
    el.tlpAt.addEventListener('input', () => {
      if (tl.sel === 'beat' || !tl.sel) return;
      const clip = clipById(tl.sel);
      if (!clip) return;
      clip.at = +el.tlpAt.value;
      el.tlpAtOut.textContent = `${clip.at.toFixed(2)}초`;
      if (tl.playing) tlStop();
      rebuild();
      scheduleDraw();
    });
    el.tlpAt.addEventListener('change', () => { saveState(); renderTimeline(); });
    el.tlpLen.addEventListener('input', () => {
      const clip = clipById(tl.sel);
      if (!clip) return;
      clip.len = +el.tlpLen.value;
      el.tlpLenOut.textContent = `${clip.len.toFixed(2)}초`;
      if (tl.playing) tlStop();
      rebuild();
    });
    el.tlpLen.addEventListener('change', () => { saveState(); renderTimeline(); });
    el.tlpVol.addEventListener('input', () => {
      const clip = clipById(tl.sel);
      if (!clip) return;
      clip.vol = +el.tlpVol.value;
      el.tlpVolOut.textContent = `${Math.round(clip.vol * 100)}%`;
    });
    el.tlpVol.addEventListener('change', () => {
      saveState();
      if (tl.playing) { tlStop(); tlPlayToggle(); }
      rebuild(); renderTimeline();
    });
    el.tlpClose.addEventListener('click', () => { tl.sel = null; updateTlPanel(); renderTimeline(); });
    el.tlpPlay.addEventListener('click', () => {
      if (tl.sel === 'beat' || tl.sel === 'song') {
        const tr = tl.sel === 'song' ? S.songTrack : S.beatTrack;
        tl.t = clampNum(tr.start, 0, Math.max(0, (S.arr ? S.arr.total : 1) - 0.2), 0);
        setPlayhead(tl.t);
        tlPlayToggle();
        return;
      }
      const ev = S.arr && S.arr.voiceEvents.find((x) => x.id === tl.sel);
      if (ev) {
        tl.t = ev.tStart;
        setPlayhead(tl.t);
        tlPlayToggle();
      }
    });
    el.tlpOff.addEventListener('click', () => {
      const clip = clipById(tl.sel);
      if (!clip) return;
      const seg = segById(clip.segId);
      if (!seg) return;
      stopSegAudio();
      seg.on = false;
      tl.sel = null;
      if (clipList()) S.voiceClips = S.voiceClips.filter((c) => c.segId !== seg.id);
      renderSegments();
      drawWave(el.waveVoice, S.voice.peaks, { markers: S.voice.segments, color: 'rgba(255,255,255,.5)' });
      rebuild(); saveState(); renderTimeline();
      toast('이 구간을 리믹스에서 뺐어요');
    });
  }
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
  const sp = clampNum(S.outputSpeed, 0.5, 2, 1);
  el.totalLen.textContent = arr.total.toFixed(1);   // HUD는 타임라인(편집) 초 — 최종 길이는 내보내기에 표시
  el.totalLen2.textContent = arr.total.toFixed(1);
  if (el.finalLen) el.finalLen.textContent = (arr.total / sp).toFixed(1);
  if (el.finalLenWrap) el.finalLenWrap.hidden = sp === 1;
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
  renderTimeline();
  syncSpeed();
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
      genre: S.genre, bpm: S.bpm, beatOn: S.beatOn,
      sections: S.sections, mix: S.mix,
      fmtId: S.fmtId, fmt: S.fmt,
      fitMode: S.fitMode, renderRes: S.renderRes, stateVer: 3,
      fxMode: S.fxMode, fx: S.fx,
      autoEdit: S.autoEdit, cutBeats: S.cutBeats, punch: S.punch, flash: S.flash, pulse: S.pulse, fitY: S.fitY,
      title1: S.title1, title2: S.title2, lenUnit: S.lenUnit,
      trim: S.trim, offsetBack: S.offsetBack,
      voiceFx: S.voiceFx, voiceTrack: S.voiceTrack, voiceClips: S.voiceClips, beatTrack: S.beatTrack,
      songTrack: S.songTrack, songOn: S.songOn, outputSpeed: S.outputSpeed,
      remixPattern: S.remixPattern, beatDuck: S.beatDuck, gridConf: S.gridConf, clipsFor: S.clipsFor,
    };
    localStorage.setItem(LS_STATE, JSON.stringify(data));
  } catch (e) {}
}

function loadState() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(LS_STATE) || 'null'); } catch (e) {}
  if (!d) return;
  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
  S.genre = GENRES[d.genre] ? d.genre : 'techno';
  S.beatOn = d.beatOn !== false;
  if (typeof d.beatMode === 'string') S.beatOn = d.beatMode === 'file' ? d.beatOn !== false : S.beatOn;   // v1.6 저장값 호환
  S.songOn = d.songOn !== false;
  S.outputSpeed = clamp(num(d.outputSpeed, 1), 0.5, 2);
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
  // v1.6: 기본을 '음원 싱크 믹싱'으로 바꿨다. 예전 저장값의 기본(smooth)은 sync로 옮기고,
  //       비트컷을 직접 고른 경우만 그대로 둔다.
  S.fitMode = d.fitMode === 'beatcut' ? 'beatcut'
    : d.fitMode === 'sync' ? 'sync'
      : (d.stateVer === 2 ? 'smooth' : 'sync');
  S.renderRes = d.renderRes === '1080' ? '1080' : d.renderRes === '720' ? '720' : null;
  S.fxMode = d.fxMode === 'manual' ? 'manual' : 'auto';
  if (d.fx && typeof d.fx === 'object') {
    S.fx = {
      shake: [0, 1, 2].includes(d.fx.shake) ? d.fx.shake : 1,
      color: ['none', 'vivid', 'warm', 'neon', 'mono'].includes(d.fx.color) ? d.fx.color : 'vivid',
      edge: d.fx.edge !== false,
      psy: [0, 1, 2].includes(d.fx.psy) ? d.fx.psy : 2,
    };
  }
  S.cutBeats = [1, 2, 4, 8].includes(d.cutBeats) ? d.cutBeats : 4;
  S.punch = num(d.punch, 0.045);
  S.flash = num(d.flash, 0.1);
  S.pulse = d.pulse !== false;
  S.fitY = clamp(num(d.fitY, 0.42), 0, 1);
  if (typeof d.title1 === 'string') S.title1 = d.title1;
  if (typeof d.title2 === 'string') S.title2 = d.title2;
  S.lenUnit = d.lenUnit === 'bar' ? 'bar' : 'sec';
  if (d.trim) S.trim = d.trim;
  S.offsetBack = num(d.offsetBack, 0);
  S.voiceFx = d.voiceFx === 'baby' ? 'baby' : 'all';
  if (d.voiceTrack && typeof d.voiceTrack === 'object') {
    S.voiceTrack = {
      offset: clamp(num(d.voiceTrack.offset, 0), -2, 6),
      vol: clamp(num(d.voiceTrack.vol, 1), 0, 1.5),
    };
  }
  if (Array.isArray(d.voiceClips)) {
    S.voiceClips = d.voiceClips.filter((c) => c && typeof c.segId === 'number').map((c, i) => ({
      id: typeof c.id === 'string' ? c.id : 'c' + i,
      segId: c.segId,
      at: Math.max(0, num(c.at, 0)),
      len: Math.max(0.04, num(c.len, 0.2)),
      vol: clamp(num(c.vol, 1), 0, 1.5),
    }));
  } else S.voiceClips = null;
  S.clipsFor = typeof d.clipsFor === 'string' ? d.clipsFor : null;
  S.remixPattern = d.remixPattern !== false;
  S.beatDuck = clamp(num(d.beatDuck, 5), 0, 10);
  S.gridConf = clamp(num(d.gridConf, 0), 0, 1);
  if (d.beatTrack && typeof d.beatTrack === 'object') {
    S.beatTrack = {
      start: Math.max(0, num(d.beatTrack.start, 0)),
      len: Math.max(0, num(d.beatTrack.len, 0)),
      vol: clamp(num(d.beatTrack.vol, 1), 0, 1.5),
      fadeIn: clamp(num(d.beatTrack.fadeIn, 0), 0, 5),
      fadeOut: clamp(num(d.beatTrack.fadeOut, 0), 0, 5),
      srcOffset: Math.max(0, num(d.beatTrack.srcOffset, 0)),
    };
  }
  if (d.songTrack && typeof d.songTrack === 'object') {
    S.songTrack = {
      start: Math.max(0, num(d.songTrack.start, 0)),
      len: Math.max(0, num(d.songTrack.len, 0)),
      vol: clamp(num(d.songTrack.vol, 1), 0, 1.5),
      fadeIn: clamp(num(d.songTrack.fadeIn, 0), 0, 5),
      fadeOut: clamp(num(d.songTrack.fadeOut, 0), 0, 5),
      srcOffset: Math.max(0, num(d.songTrack.srcOffset, 0)),
    };
  }
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

// 저장 화질 — 720p(모바일에서 끊김 적음·추천) / 1080p(고화질)
function renderRes() {
  if (S.renderRes === '1080') {
    return { w: 1080, h: 1920, scale: 1, vbps: 6000000, abps: 192000, label: '1080×1920' };
  }
  return { w: 720, h: 1280, scale: 2 / 3, vbps: 4000000, abps: 160000, label: '720×1280' };
}

// ① 고정 30fps(WebCodecs) 렌더 → ② 안 되면 실시간 MediaRecorder 녹화
async function renderAll() {
  if (playing) stopPlayback();
  tlStop(true);
  stopSegAudio();
  stopOneShotAudio();
  const arr = rebuild();
  if (!arr.total) return;
  if (!S.voice && !S.videoUrl && !(S.songOn !== false && S.backing)) { toast('먼저 영상을 올려 주세요'); return; }
  const sp = clampNum(S.outputSpeed, 0.5, 2, 1);
  const outDur = Math.max(0.05, arr.total / sp);
  el.btnRender.disabled = true;
  el.renderBox.hidden = false;
  el.outList.innerHTML = '';
  if (el.saveHint) el.saveHint.hidden = true;
  el.renderMsg.className = 'status';
  el.renderMsg.textContent = '렌더링 준비 중…';
  el.renderBar.style.width = '2%';

  const ctx = audioCtx();
  try { await ctx.resume(); } catch (e) {}

  const rc = el.renderCanvas;
  const RES = renderRes();
  rc.width = RES.w; rc.height = RES.h;
  const rctx = rc.getContext('2d', { alpha: false });
  const stamp = new Date();
  const name = `daini-remix_${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}_${outDur.toFixed(1)}s`;

  let videoDone = false;
  let audioSilent = false;
  let frameInfo = '';
  const addThumb = () => {
    try {
      const thumbBlob = dataURItoBlob(rc.toDataURL('image/jpeg', 0.9));
      addOut('썸네일 (JPG)', `${rc.width}×${rc.height}`, URL.createObjectURL(thumbBlob), `${name}_thumb.jpg`, thumbBlob, 'image/jpeg');
    } catch (e) {}
  };

  // ── ① 30fps 고정 렌더: 1/30초마다 원본을 seek해 한 장씩 인코딩 (프레임 드랍 0%) ──
  //     오디오는 AudioEncoder가 있으면 직접(A), 없으면(iOS 17/18) 따로 녹음해 합친다(B).
  if (webCodecsVideoSupported()) {
    try {
      el.renderMsg.textContent = '30fps 고정 렌더 준비 중… (오디오 믹스)';
      el.renderBar.style.width = '3%';
      const mixBuf = await renderMixBuffer(arr);
      let lastPaint = 0;
      const hybridMode = !webCodecsAudioSupported();
      const out = await encodeMp4({
        canvas: rc,
        res: RES,
        total: outDur,
        shots: shotsForSpeed(arr.shots, sp),
        videoDur: S.videoDur,
        videoUrl: S.videoUrl,
        audioBuffer: mixBuf,
        audioContext: ctx,
        draw: (t, videoEl) => drawScene(rctx, sceneAt(t * sp, videoEl, { scale: RES.scale })),
        onProgress: (p) => {
          const now = performance.now();
          if (p.phase === 'video') {
            el.renderBar.style.width = `${clamp(3 + (p.i / p.frames) * 95, 3, 99).toFixed(1)}%`;
            if (now - lastPaint > 200 || p.i === p.frames) {
              lastPaint = now;
              el.renderMsg.textContent = `30fps 고정 렌더링 중… ${p.i} / ${p.frames}프레임 (${p.t.toFixed(1)}초)`;
            }
          } else if (p.phase === 'audio-record') {
            el.renderBar.style.width = `${clamp(3 + (p.t / Math.max(0.1, p.total)) * 40, 3, 45).toFixed(1)}%`;
            if (now - lastPaint > 200) {
              lastPaint = now;
              el.renderMsg.textContent = `소리 녹음 중… ${p.t.toFixed(1)} / ${p.total.toFixed(1)}초 (iOS 하이브리드)`;
            }
          } else if (p.phase === 'audio-demux' || p.phase === 'audio-mux-start') {
            if (now - lastPaint > 200) {
              lastPaint = now;
              el.renderMsg.textContent = '녹음한 소리를 영상과 합치는 중…';
            }
          } else if (now - lastPaint > 200) {
            lastPaint = now;
            el.renderMsg.textContent = hybridMode ? '오디오를 준비하는 중…' : '오디오 인코딩 중…';
          }
        },
      });
      if (out && out.blob && out.blob.size > 1000) {
        const hybridTag = out.audioPath === 'hybrid' ? ' (iOS 하이브리드)' : out.audioPath === 'silent' ? ' (무음)' : '';
        addOut('영상 (MP4 · 30fps 고정)',
          `${(out.blob.size / 1048576).toFixed(1)}MB · ${out.duration.toFixed(1)}초 · ${out.frames}프레임 @30fps${hybridTag}`,
          URL.createObjectURL(out.blob), `${name}.mp4`, out.blob, 'video/mp4');
        videoDone = true;
        frameInfo = `${out.frames}프레임 @30fps${hybridTag}`;
        el.renderBar.style.width = '100%';
        addThumb();
        if (out.audioPath === 'silent') {
          audioSilent = true;
          el.renderMsg.className = 'status err';
          el.renderMsg.textContent = '영상은 30fps로 만들었지만 소리를 넣지 못해 무음이에요. WAV 오디오를 함께 저장해 주세요.';
        }
      }
    } catch (e) {
      console.warn('30fps 고정 인코딩 실패 → 실시간 녹화로 전환', e);
      el.renderMsg.textContent = '30fps 인코딩이 안 돼 실시간 녹화로 다시 시도해요…';
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // ── ② 폴백: 실시간 MediaRecorder (DOM 갱신은 200ms에 한 번만 — 사파리 리플로우 부담 제거) ──
  if (!videoDone) {
    const canVideo = typeof rc.captureStream === 'function' && !!window.MediaRecorder;
    if (canVideo) {
      try {
        const mime = pickMime();
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const stream = rc.captureStream(30);
        const dest = ctx.createMediaStreamDestination();
        stream.addTrack(dest.stream.getAudioTracks()[0]);

        const rec = new MediaRecorder(stream, mime
          ? { mimeType: mime, videoBitsPerSecond: RES.vbps, audioBitsPerSecond: RES.abps }
          : { videoBitsPerSecond: RES.vbps });
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise((r) => { rec.onstop = r; });

        const beatBuf = S.beatOn !== false ? await getBeatBuffer(ctx, arr) : null;
        const t0 = ctx.currentTime + 0.4;
        const mix = scheduleMix(ctx, dest, arr, t0, beatBuf, { speed: sp });
        engine.speed = sp;
        await engine.startAt(0, false);   // 프리롤: 재생 준비만, 1배속 시작은 녹화와 동시에
        el.renderMsg.textContent = `렌더링 중… 0.0 / ${outDur.toFixed(1)}초 (실시간)`;

        let started = false;
        let lastPaint = 0;
        await new Promise((resolve) => {
          const step = () => {
            const t = (ctx.currentTime - t0) * sp;   // 타임라인 초(배속 반영)
            if (t < 0) { requestAnimationFrame(step); return; }
            if (!started) { started = true; try { rec.start(250); } catch (e) {} engine.playNow(); }
            if (t >= arr.total + 0.01) { resolve(); return; }
            engine.sync(t);
            engine.follow(t);
            drawScene(rctx, sceneAt(t, engine.activeEl, { scale: RES.scale }));
            const now = performance.now();
            if (now - lastPaint > 200) {           // 매 프레임 DOM 갱신 → 200ms에 1번
              lastPaint = now;
              el.renderBar.style.width = `${clamp((t / arr.total) * 100, 2, 100).toFixed(1)}%`;
              el.renderMsg.textContent = `렌더링 중… ${(t / sp).toFixed(1)} / ${outDur.toFixed(1)}초 (실시간)`;
            }
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
          addOut(`영상 (${ext.toUpperCase()})`, `${(blob.size / 1048576).toFixed(1)}MB · ${outDur.toFixed(1)}초`, vidUrl, `${name}.${ext}`, blob, (mime || 'video/webm').split(';')[0]);
          videoDone = true;
          frameInfo = '실시간 녹화(가변 프레임)';
        } else {
          el.renderMsg.className = 'status err';
          el.renderMsg.textContent = '영상 녹화가 비어 있어요. 오디오(WAV)로 저장해 주세요.';
        }
        addThumb();
      } catch (e) {
        console.error(e);
        el.renderMsg.className = 'status err';
        el.renderMsg.textContent = '이 브라우저에서는 영상 녹화가 막혔어요. 오디오(WAV)는 계속 만들 수 있어요.';
      }
    } else {
      el.renderMsg.className = 'status err';
      el.renderMsg.textContent = '이 브라우저는 영상 녹화(MediaRecorder)를 지원하지 않아요. 고음질 WAV로 저장해 주세요.';
    }
  }

  // WAV는 항상 만든다
  el.renderMsg.textContent = videoDone ? '영상 완료 · 오디오(WAV) 만드는 중…' : '오디오(WAV) 만드는 중…';
  await new Promise((r) => setTimeout(r, 60));
  try {
    const wav = await renderWav(arr);
    addOut('오디오 (WAV 48kHz)', `${(wav.size / 1048576).toFixed(1)}MB · 어디서나 재생`, URL.createObjectURL(wav), `${name}.wav`);
    if (videoDone) {
      el.renderMsg.className = audioSilent ? 'status err' : 'status ok';
      const spTag = sp === 1 ? '' : ` · ⏩${sp.toFixed(2)}x`;
      el.renderMsg.textContent = `완료! ${outDur.toFixed(1)}초${spTag} · ${frameInfo} · 목소리 ${S.voice ? S.voice.segments.filter((x) => x.on).length : 0}구간 · ${arr.cutCount}컷`;
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

// ── 사진첩 저장(Web Share API) ─────────────────────────
// iOS Safari는 <a download>로 사진첩 저장을 막지만, 클릭(사용자 제스처) 안에서
// navigator.share({ files })를 호출하면 공유 시트의 '비디오 저장'으로 사진첩에 바로 들어간다.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_TOUCH = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } })();

function canShareFile(file) {
  if (!navigator.share || !navigator.canShare) return false;
  try { return !!navigator.canShare({ files: [file] }); } catch (e) { return false; }
}

// 파일을 만들기 전에 같은 형식으로 지원 여부만 확인
function fileShareSupported(type) {
  if (!navigator.share || !navigator.canShare || typeof File !== 'function') return false;
  try {
    const probe = new File([new Blob(['0'], { type })], 'probe', { type });
    return canShareFile(probe);
  } catch (e) { return false; }
}

function downloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function addOut(title, meta, url, filename, blob, mime) {
  const card = document.createElement('div');
  card.className = 'outcard';
  card.innerHTML = `<div class="oc-l"><b>${title}</b><span>${meta}</span></div>
    <div class="oc-r"></div>`;
  const right = card.querySelector('.oc-r');
  const type = mime || (blob && blob.type) || '';
  const shareable = !!blob && /^(video|image)\//.test(type);
  const supported = shareable && fileShareSupported(type);
  const highlight = IS_IOS || IS_TOUCH; // 모바일에서는 사진첩 저장을 기본 강조
  // 모바일에서는 공유 시트가 없어도 버튼을 보이고, 실패 시 파일 다운로드로 대체한다.
  const showShare = shareable && (supported || highlight);

  if (showShare) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = highlight ? 'primary sm' : 'ghost sm';
    btn.textContent = '📱 사진첩에 저장';
    btn.addEventListener('click', () => {
      // 클릭 제스처 안에서 바로 File을 만들어야 iOS 공유 시트가 열린다(await 금지)
      let file = null;
      try { file = new File([blob], filename, { type }); } catch (e) {}
      if (!file || !canShareFile(file)) {
        downloadUrl(url, filename);
        toast("공유 시트를 열 수 없어 파일로 저장했어요. 공유 시트에서 '비디오 저장'을 누르면 사진첩에 들어갑니다.", 4200);
        return;
      }
      btn.disabled = true;
      const done = () => { btn.disabled = false; };
      navigator.share({ files: [file] }).then(done).catch((e) => {
        done();
        if (e && e.name === 'AbortError') return; // 사용자가 공유 시트를 닫음
        downloadUrl(url, filename);
        toast("공유 시트를 열 수 없어 파일로 저장했어요. 공유 시트에서 '비디오 저장'을 누르면 사진첩에 들어갑니다.", 4200);
      });
    });
    right.appendChild(btn);
  }

  const link = document.createElement('a');
  link.className = (showShare && !highlight) ? 'primary sm' : 'ghost sm';
  link.download = filename;
  link.href = url;
  link.textContent = '파일로 저장';
  right.appendChild(link);

  el.outList.appendChild(card);
  if (showShare && el.saveHint) el.saveHint.hidden = false;
}

// 48kHz 스테레오 최종 믹스 (WAV · AAC 인코딩 공용) — 최종 배속까지 반영한 길이로 렌더
async function renderMixBuffer(arr) {
  const sr = 48000;
  const sp = clampNum(S.outputSpeed, 0.5, 2, 1);
  const outDur = Math.max(0.05, arr.total / sp);
  const oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(outDur * sr)), sr);
  const beatBuf = S.beatOn !== false
    ? buildBeat(oc, {
        genre: S.genre, bpm: S.bpm, total: arr.total,
        sections: arr.beatPlan.map((b) => ({ start: b.start, dur: b.dur, kind: b.kind, beatOn: b.beatOn })),
      })
    : null;
  scheduleMix(oc, oc.destination, arr, 0, beatBuf, { speed: sp });
  return await oc.startRendering();
}

// 최종 배속용 샷 변환 — 타임라인 초를 출력 초로 눌러, 저장 영상이 미리보기와 같은 프레임을 보게 한다.
// t_out에서 보여야 하는 원본 시점 = srcStart + (t_out*sp - tStart)*rate 이므로
//   tStart/sp, rate*sp 로 바꿔 두면 sourceTimeAt()이 그대로 맞는다.
function shotsForSpeed(shots, sp) {
  if (!Array.isArray(shots)) return [];
  if (Math.abs(sp - 1) < 1e-6) return shots;
  return shots.map((s) => {
    const o = { ...s, tStart: +(s.tStart / sp).toFixed(4), tEnd: +(s.tEnd / sp).toFixed(4) };
    if (shotMoves(s)) o.rate = +(shotRate(s) * sp).toFixed(4);
    return o;
  });
}

async function renderWav(arr) {
  const rendered = await renderMixBuffer(arr);
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
    S.backing = { name: 'YouTube 오디오', buffer: buf, peaks: waveformPeaks(buf, 1400), duration: buf.duration, norm: clamp(0.6 / Math.max(0.01, peakOf(buf)), 0.5, 6), kind: 'url' };
    S.trim = { start: 0, end: Math.min(buf.duration, 30) };
    S.songOn = true;
    S.offsetBack = 0;
    S.songTrack = { ...(S.songTrack || {}), start: 0, len: 0, srcOffset: 0 };
    S.voiceClips = null;
    const est = (() => { try { return estimateBpm(buf); } catch (e) { return null; } })();
    S.songBpm = est && est.bpm ? clamp(Math.round(est.bpm), 60, 200) : 0;
    el.bpmEst.textContent = S.songBpm ? `${S.songBpm}` : '–';
    applyGrid(true);
    syncMixMode();
    el.backLoaded.hidden = false;
    el.dropBack.style.display = 'none';
    el.backName.textContent = 'YouTube 오디오';
    el.backDur.textContent = `${buf.duration.toFixed(1)}초`;
    el.trimEndNum.value = S.trim.end.toFixed(1);
    drawBackWave();
    rebuild();
    saveState();
    el.ytMsg.className = 'status ok';
    el.ytMsg.textContent = '가져왔어요! 배경노래에서 구간을 골라 주세요.';
  } catch (e) {
    el.ytMsg.className = 'status err';
    el.ytMsg.innerHTML = `오디오 주소는 받았지만 브라우저가 내려받기를 막았어요(CORS). 아래 링크를 열어 저장한 뒤 <b>내 음원</b>에 올려 주세요.<br><a href="${res.url}" target="_blank" rel="noopener">${res.url.slice(0, 80)}…</a>`;
  }
}

// ──────────────────────────────────────────────────────
// 이벤트 연결
// 3단 믹싱 스택(🎵 배경노래 · 🥁 장르 비트 · 🎙️ 옹알이)의 상태를 한곳에서 그린다 (v1.7)
function genreLabel() {
  return (GENRES[S.genre] || GENRES.techno).label;
}

function syncMixMode() {
  const hasSong = !!(S.backing && S.backing.buffer);
  const songOn = hasSong && S.songOn !== false;
  const beatOn = S.beatOn !== false;
  // 🎵 배경노래 행
  if (el.mixSongName) {
    el.mixSongName.textContent = !hasSong
      ? '배경노래 없음'
      : `${(S.backing.name || '배경노래').replace(/\.[a-z0-9]+$/i, '')}${songOn ? '' : ' · 꺼짐'}`;
  }
  if (el.mixSongMeta) {
    el.mixSongMeta.textContent = !hasSong
      ? '노래 · 다른 동영상 파일 또는 음악 URL'
      : `${S.backing.duration.toFixed(1)}초${S.songBpm ? ` · 추정 ${S.songBpm} BPM` : ''}${songOn ? ' · 옹알이가 터질 때 살짝 줄어요' : ' · 다시 켜면 박자에 맞춰 깔려요'}`;
  }
  if (el.btnSongOn) {
    el.btnSongOn.disabled = !hasSong;
    el.btnSongOn.textContent = songOn ? '켬' : '끔';
    el.btnSongOn.classList.toggle('on', songOn);
    el.btnSongOn.setAttribute('aria-pressed', songOn ? 'true' : 'false');
  }
  const songRow = el.mixStack && el.mixStack.querySelector('.mixrow[data-layer="song"]');
  if (songRow) songRow.classList.toggle('off', !songOn);
  // 🥁 장르 비트 행
  if (el.mixBeatName) el.mixBeatName.textContent = beatOn ? `${genreLabel()} 비트 · ${S.bpm} BPM` : '장르 비트 끔';
  if (el.mixBeatMeta) {
    el.mixBeatMeta.textContent = beatOn
      ? (hasSong ? `배경노래 ${S.bpm} BPM 박자에 맞춰 쪼개 얹어요` : '노래 없이 이 비트만으로도 리믹스돼요')
      : '끔 — 배경노래·옹알이만으로 믹스해요';
  }
  if (el.btnBeatOn) {
    el.btnBeatOn.textContent = beatOn ? '켬' : '끔';
    el.btnBeatOn.classList.toggle('on', beatOn);
    el.btnBeatOn.setAttribute('aria-pressed', beatOn ? 'true' : 'false');
  }
  const beatRow = el.mixStack && el.mixStack.querySelector('.mixrow[data-layer="beat"]');
  if (beatRow) beatRow.classList.toggle('off', !beatOn);
  if (el.beatBlock) el.beatBlock.classList.toggle('off', !beatOn);
  // 🎙️ 옹알이 행
  if (el.mixVoiceName) el.mixVoiceName.textContent = S.voice ? (S.voice.name || '옹알이 트랙') : '옹알이 트랙';
  if (el.mixVoiceMeta) {
    const n = S.voice ? S.voice.segments.filter((s) => s.on).length : 0;
    el.mixVoiceMeta.textContent = S.voice ? `구간 ${n}개 · 박자에 맞춰 썰어서 얹어요` : '영상에서 찾은 옹알이를 박자에 맞춰 얹어요';
  }
  // 장르 칩
  if (el.genreChips) {
    el.genreChips.querySelectorAll('button').forEach((b) => {
      const g = b.dataset.genre;
      const on = g === 'off' ? !beatOn : (beatOn && g === S.genre);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  if (el.beatHintSmall) el.beatHintSmall.textContent = hasSong ? `배경노래 ${S.songBpm || S.bpm} BPM에 맞춰요` : '배경노래를 올리면 BPM을 자동으로 맞춰요';
  if (el.bpmMatchInfo) {
    el.bpmMatchInfo.textContent = !hasSong ? '저작권 없는 내장 신스예요.'
      : S.songBpm && S.songBpm !== S.bpm ? `노래는 ${S.songBpm} BPM이에요 — 지금 비트는 ${S.bpm} BPM`
        : `배경노래 박자(${S.bpm} BPM)에 맞춰져 있어요`;
  }
  if (el.btnBpmSong) {
    el.btnBpmSong.hidden = !(hasSong && S.songBpm && Math.abs(S.songBpm - S.bpm) > 0.5);
    el.btnBpmSong.dataset.bpm = S.songBpm ? String(S.songBpm) : '';
  }
}

// ⏩ 최종 배속 UI (v1.7)
function syncSpeed() {
  const sp = clampNum(S.outputSpeed, 0.5, 2, 1);
  const arr = S.arr;
  if (el.speedOut) el.speedOut.textContent = `${sp.toFixed(2)}x`;
  if (el.speedRange) el.speedRange.value = String(sp);
  if (el.speedChips) {
    el.speedChips.querySelectorAll('button').forEach((b) => {
      const on = Math.abs(+b.dataset.speed - sp) < 0.001;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  if (el.speedDur && arr) {
    const out = arr.total / sp;
    el.speedDur.textContent = sp === 1 ? `${arr.total.toFixed(1)}초` : `${arr.total.toFixed(1)}초 → ${out.toFixed(1)}초`;
  }
  if (el.speedHint) {
    el.speedHint.innerHTML = sp === 1
      ? '영상·배경노래·비트·옹알이가 <b>같이</b> 빨라지거나 느려져서 입모양과 박자가 어긋나지 않아요. 소리 피치도 함께 올라가요.'
      : `<b>${sp.toFixed(2)}배속</b> — 영상 프레임·배경노래·장르 비트·옹알이가 모두 같은 배율로 흘러 입모양·박자가 그대로 맞아요. 저장 영상도 ${arr ? (arr.total / sp).toFixed(1) : '-'}초로 나와요.`;
  }
}

function setOutputSpeed(v) {
  const sp = clampNum(v, 0.5, 2, 1);
  S.outputSpeed = +sp.toFixed(2);
  if (playing) stopPlayback(true);
  if (tl.playing) tlStop(true);
  engine.speed = S.outputSpeed;
  syncSpeed();
  scheduleDraw();
  saveState();
}

// 영상 맞춤 방식(음원 싱크 믹싱 / 1배속 부드럽게 / 비트컷) UI
function syncFitMode() {
  if (el.fitModes) {
    el.fitModes.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.mode === S.fitMode;
      b.classList.toggle('on', on);
      b.classList.toggle('primary', on);
      b.classList.toggle('ghost', !on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  if (el.fitHint) {
    el.fitHint.innerHTML = S.fitMode === 'sync'
      ? '<b>🎯 음원 싱크 믹싱</b> — 음악에 섞인 옹알이 조각이 나올 때마다 영상도 <b>그 소리의 원본 순간(입모양·표정)</b>으로 정확히 점프·반복해요. 소리가 없는 비트 구간은 화면이 멈추지 않고 비트에 맞춰 이어지고, 저장한 MP4도 미리보기와 똑같이 움직여요.'
      : S.fitMode === 'smooth'
        ? '원본 영상을 <b>1배속</b> 그대로 이어 재생해요. 영상이 짧으면 끝에서 자연스럽게 다시 이어 붙여(루프) 음원 길이에 딱 맞추고, 드롭에서는 영상 처음부터 다시 시작해 비트와 맞춰요. 슬로우모션이 생기지 않아요.'
        : '목소리 구간을 박자마다 점프컷해요(기존 방식). 영상이 짧으면 반복 컷으로 채우고, 1배속보다 화면 전환이 잦아요.';
  }
  // 싱크·1배속 모드에서는 컷 설정이 필요 없어 숨김
  const noCuts = S.fitMode !== 'beatcut';
  if (el.autoEdit) el.autoEdit.closest('.switchrow').hidden = noCuts;
  if (el.cutBeats) el.cutBeats.closest('.selrow').hidden = noCuts;
  if (el.editOpts) el.editOpts.classList.toggle('off', false);
}

// ── 영상 효과: 알아서 편집 / 직접 편집 ──────────────────
const FX_COLOR_LABEL = { none: '원본', vivid: '선명하게', warm: '빈티지 웜', neon: '클럽 네온', mono: '흑백' };

function autoFxCfg() {
  const presets = {
    techno: { punch: 0.045, flash: 0.1, shake: 1, color: 'vivid', edge: true, psy: 2, cutBeats: 4 },
    house: { punch: 0.035, flash: 0.08, shake: 1, color: 'warm', edge: true, psy: 1, cutBeats: 4 },
    trap: { punch: 0.06, flash: 0.12, shake: 2, color: 'neon', edge: true, psy: 2, cutBeats: 2 },
    lofi: { punch: 0.02, flash: 0.05, shake: 0, color: 'warm', edge: true, psy: 0, cutBeats: 8 },
  };
  const c = { ...(presets[S.genre] || presets.techno) };
  if (S.bpm >= 150) { c.flash = Math.min(0.18, +(c.flash * 1.2).toFixed(3)); c.shake = Math.min(2, c.shake + 1); c.psy = Math.min(2, (c.psy || 0) + 1); }
  if (S.bpm <= 100) { c.flash = +(c.flash * 0.6).toFixed(3); c.shake = 0; c.cutBeats = 8; c.psy = 0; }
  return c;
}

function applyAutoFx(silent) {
  const c = autoFxCfg();
  S.punch = c.punch;
  S.flash = c.flash;
  S.cutBeats = c.cutBeats;
  S.fx = { ...S.fx, shake: c.shake, color: c.color, edge: c.edge, psy: c.psy };
  syncFxControls();
  rebuild();
  saveState();
  scheduleDraw();
  if (!silent) toast('✨ 장르·BPM에 맞춰 효과를 자동으로 맞췄어요');
}

function fxSummaryText() {
  const lv = (v, arr) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), arr[0]);
  const punch = { 0: '끔', 0.022: '약', 0.045: '중', 0.08: '강' }[lv(S.punch, [0, 0.022, 0.045, 0.08])];
  const flash = { 0: '끔', 0.05: '약', 0.1: '중', 0.18: '강' }[lv(S.flash, [0, 0.05, 0.1, 0.18])];
  const shake = ['끔', '약', '강'][S.fx.shake || 0];
  const color = FX_COLOR_LABEL[S.fx.color] || '원본';
  const psy = ['끔', '약', '강'][S.fx.psy || 0];
  return `줌 펀치 ${punch} · 플래시 ${flash} · 쉐이크 ${shake} · ${color} · 테두리 ${S.fx.edge ? 'ON' : 'OFF'} · 🪩 싸이키 ${psy}`;
}

function syncFxControls() {
  const auto = S.fxMode !== 'manual';
  if (!auto) {
    // 자동값(예: 0.12)을 직접 편집 선택지 중 가장 가까운 값으로 맞춘다
    const near = (v, arr) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), arr[0]);
    S.punch = near(S.punch, [0, 0.022, 0.045, 0.08]);
    S.flash = near(S.flash, [0, 0.05, 0.1, 0.18]);
  }
  if (el.fxPunch) el.fxPunch.value = String(S.punch);
  if (el.fxFlash) el.fxFlash.value = String(S.flash);
  if (el.fxShake) el.fxShake.value = String(S.fx.shake || 0);
  if (el.fxColor) el.fxColor.value = S.fx.color || 'none';
  if (el.fxEdge) el.fxEdge.checked = !!S.fx.edge;
  if (el.fxPsy) el.fxPsy.value = String(S.fx.psy || 0);
  if (el.fxSummary) el.fxSummary.textContent = fxSummaryText();
  if (el.fxModes) {
    el.fxModes.querySelectorAll('button').forEach((b) => {
      const on = (b.dataset.fxmode === 'manual') !== auto;
      b.classList.toggle('on', on);
      b.classList.toggle('primary', on && b.dataset.fxmode === 'auto');
      b.classList.toggle('ghost', !(on && b.dataset.fxmode === 'auto'));
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  if (el.fxAutoBlock) el.fxAutoBlock.hidden = !auto;
  if (el.fxManualBlock) el.fxManualBlock.hidden = auto;
}

// 저장 화질 UI
// 내보내기 안내 — 이 기기가 30fps 고정 인코딩을 할 수 있는지에 맞춰 문구를 바꾼다
function syncEncodeHint() {
  const node = document.getElementById('renderHint');
  if (!node) return;
  if (webCodecsVideoSupported()) {
    if (webCodecsAudioSupported()) {
      node.innerHTML = '영상은 <b>30fps 고정</b>으로 한 장씩 인코딩해요(길이의 2~6배 정도 걸립니다). 슬라이드처럼 끊기지 않고 사진첩에서도 부드럽게 재생돼요. 오디오는 WAV로도 받을 수 있어요.';
    } else if (hybridAudioSupported()) {
      node.innerHTML = '아이폰 iOS 17/18 Safari에서도 <b>30fps 고정 + 소리</b>로 저장돼요. 소리는 따로 녹음해 영상에 합쳐요(길이의 2~7배 정도 걸립니다). 렌더 중에는 화면을 끄지 마세요.';
    } else {
      node.innerHTML = '이 브라우저는 <b>30fps 고정</b>으로 영상을 만들 수 있지만 소리를 넣지 못해 <b>무음</b>로 저장돼요. WAV 오디오를 함께 받아 두면 편해요.';
    }
  } else {
    node.innerHTML = '이 브라우저는 30fps 고정 인코딩(WebCodecs)을 지원하지 않아 실시간 녹화로 저장돼요. 아이폰 Safari(iOS 16.4+)나 최신 크롬에서 30fps 고정 저장이 켜집니다.';
  }
}

function syncRes() {
  if (el.resChips) {
    const cur = S.renderRes === '1080' ? '1080' : '720';
    el.resChips.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.res === cur;
      b.classList.toggle('on', on);
      b.classList.toggle('primary', on);
      b.classList.toggle('ghost', !on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  if (el.resHint) {
    const cur = S.renderRes === '1080' ? '1080' : '720';
    el.resHint.innerHTML = cur === '720'
      ? '아이폰에서 <b>끊기지 않고 부드럽게</b> 저장되는 화질이에요(720×1280 · 4Mbps). 화질이 아쉬울 때만 1080×1920으로 올려 보세요.'
      : '<b>1080×1920 고화질</b>(6Mbps)이에요. 기기가 느리면 프레임이 끊기거나 렌더가 버벅일 수 있어요.';
  }
}

// ⚡ 인트로 없이 바로 하이라이트: 인트로를 빼고 그 길이를 첫 드롭에 더해 총 길이 유지
function applyHighlightStart() {
  const intros = S.sections.filter((s) => s.kind === 'intro');
  if (!intros.length) { toast('이미 인트로 없이 바로 드롭으로 시작해요'); return; }
  if (playing) stopPlayback();
  const lost = intros.reduce((a, s) => a + Math.max(0, s.beats || 0), 0);
  S.sections = S.sections.filter((s) => s.kind !== 'intro');
  if (!S.sections.length) S.sections = defaultSections().filter((s) => s.kind !== 'intro');
  const firstDrop = S.sections.find((s) => s.kind === 'drop') || S.sections[0];
  if (firstDrop) firstDrop.beats = Math.min(128, (firstDrop.beats || 0) + lost);
  rebuild(); saveState();
  toast('⚡ 인트로 없이 0.0초부터 바로 하이라이트로 시작해요');
}

function syncVoiceFx() {
  if (!el.voiceFxChips) return;
  el.voiceFxChips.querySelectorAll('button').forEach((b) => {
    const on = (b.dataset.vfx || 'all') === S.voiceFx;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if (el.voiceFxHint) {
    el.voiceFxHint.innerHTML = S.voiceFx === 'baby'
      ? '성인 <b>저음(350Hz 아래)</b>을 줄이고 <b>700Hz 웅웅대는 소리</b>를 깎아 아기 옹알이·웃음이 잘 들리게 해요. 미리듣기·저장 영상에 똑같이 적용됩니다.'
      : '원본 목소리 그대로예요. 어른 목소리가 섞인 구간은 <b>▶</b>로 들어보고 <b>빠기</b>를 눌러 빼세요.';
  }
}

function syncControls() {
  el.genreChips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.genre === S.genre));
  el.bpm.value = String(S.bpm);
  el.bpmOut.textContent = String(S.bpm);  el.voiceVol.value = String(S.mix.voiceVol);
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
  el.fitY.value = String(S.fitY);
  el.fitYOut.textContent = `${Math.round(S.fitY * 100)}%`;
  syncFitMode();
  syncRes();
  syncEncodeHint();
  syncFxControls();
  el.lenUnit.dataset.unit = S.lenUnit;
  syncMixMode();
  syncSpeed();
  syncFormatInputs();
  syncVoiceFx();
  if (el.remixPattern) el.remixPattern.checked = S.remixPattern !== false;
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
    if (b.dataset.play != null) { playSegment(+b.dataset.play); return; }
    if (b.dataset.nudge) { nudgeSeg(+b.dataset.i, +b.dataset.nudge); return; }
    if (b.dataset.use != null) {
      const i = +b.dataset.use;
      const s = S.voice && S.voice.segments[i];
      if (!s) return;
      s.on = !s.on;
      if (!s.on) {
        if (segAudio && segAudio.i === i) stopSegAudio();
        if (clipList()) S.voiceClips = S.voiceClips.filter((c) => c.segId !== s.id);
      }
      renderSegments();
      drawWave(el.waveVoice, S.voice.peaks, { markers: S.voice.segments, color: 'rgba(255,255,255,.5)' });
      rebuild();
      saveState();
      toast(s.on ? `${i + 1}번 구간을 리믹스에 넣었어요` : `${i + 1}번 구간을 뺐어요`);
    }
  });

  // 목소리 음역 필터 (전체 / 👶 아기 고음 위주)
  if (el.voiceFxChips) {
    el.voiceFxChips.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const next = b.dataset.vfx === 'baby' ? 'baby' : 'all';
      if (next === S.voiceFx) return;
      S.voiceFx = next;
      stopSegAudio();
      if (tl.playing) { tlStop(); tlPlayToggle(); }
      syncVoiceFx();
      saveState();
      toast(next === 'baby' ? '👶 아기 고음 위주로 들어요' : '전체 목소리로 들어요');
    });
  }
  bindTimeline();

  // 🎵 배경노래 · 🥁 장르 비트 켜고 끄기 (v1.7 3단 믹싱)
  if (el.btnSongOn) {
    el.btnSongOn.addEventListener('click', () => {
      if (!S.backing) return;
      S.songOn = !(S.songOn !== false);
      syncMixMode(); rebuild(); saveState(); renderTimeline();
      if (S.songOn) { if (S.voiceClips) { S.voiceClips = null; rebuild(); } toast('🎵 배경노래를 켰어요 — 박자에 맞춰 깔려요'); }
      else toast('배경노래를 껐어요');
    });
  }
  if (el.btnBeatOn) {
    el.btnBeatOn.addEventListener('click', () => {
      S.beatOn = !(S.beatOn !== false);
      if (!S.beatOn) { S.voiceClips = null; }
      syncMixMode(); rebuild(); saveState(); renderTimeline();
      toast(S.beatOn ? '🥁 장르 비트를 켰어요' : '장르 비트를 껐어요 — 노래·옹알이만 믹스해요');
    });
  }

  // 장르 비트 고르기(+ 끄기)
  el.genreChips.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.genre === 'off') {
      S.beatOn = false;
      S.voiceClips = null;
      syncMixMode(); rebuild(); saveState(); renderTimeline();
      toast('장르 비트를 껐어요');
      return;
    }
    const wasOff = S.beatOn === false;
    S.genre = b.dataset.genre;
    S.beatOn = true;
    // 노래가 있으면 노래 BPM을 그대로 쓴다 — 장르를 바꿔도 박자가 어긋나지 않게.
    if (!S.bpmLocked && !S.backing) {
      const def = GENRES[S.genre].bpm;
      S.bpm = def;
      el.bpm.value = String(def);
      el.bpmOut.textContent = String(def);
      fitAutoTitles();
    }
    if (wasOff) S.voiceClips = null;
    if (S.fxMode === 'auto') applyAutoFx(true);
    if (S.backing) scheduleGrid();
    syncMixMode();
    rebuild();
    saveState();
    renderTimeline();
  });
  el.bpm.addEventListener('input', () => {
    S.bpm = +el.bpm.value;
    S.bpmLocked = true;
    el.bpmOut.textContent = String(S.bpm);
    if (S.fxMode === 'auto') applyAutoFx(true);
    fitAutoTitles();
    syncMixMode();
    rebuild();
  });
  el.bpm.addEventListener('change', () => { saveState(); if (S.backing) applyGrid(true); });

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
    scheduleGrid();
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
  if (el.btnGridAuto) {
    el.btnGridAuto.addEventListener('click', () => applyGrid(false));
  }
  if (el.remixPattern) {
    el.remixPattern.checked = S.remixPattern !== false;
    el.remixPattern.addEventListener('change', () => {
      S.remixPattern = el.remixPattern.checked;
      S.voiceClips = null;   // 패턴을 다시 만들거나, 끄면 기존 자동 배치로
      rebuild(); saveState();
      toast(S.remixPattern ? '박자 그리드 리믹스로 썰어 넣어요' : '박자 그리드 리믹스를 껐어요(기존 자동 배치)');
    });
  }
  el.btnBpmApply.addEventListener('click', () => {
    const b = +el.btnBpmApply.dataset.bpm;
    if (!b) return;
    S.bpm = b;
    S.bpmLocked = true;
    el.bpm.value = String(b);
    el.bpmOut.textContent = String(b);
    if (S.backing) applyGrid(true);
    syncMixMode();
    rebuild(); saveState();
    toast(`BPM ${b}로 맞췄어요`);
  });
  // 🎯 노래 BPM에 비트를 맞추기 (v1.7)
  if (el.btnBpmSong) {
    el.btnBpmSong.addEventListener('click', () => {
      const b = +el.btnBpmSong.dataset.bpm;
      if (!b) return;
      S.bpm = clamp(Math.round(b), 90, 160);
      S.bpmLocked = true;
      el.bpm.value = String(S.bpm);
      el.bpmOut.textContent = String(S.bpm);
      fitAutoTitles();
      if (S.backing) applyGrid(true);
      S.voiceClips = null;
      syncMixMode();
      rebuild(); saveState(); renderTimeline();
      toast(`장르 비트를 노래 BPM ${S.bpm}에 맞췄어요`);
    });
  }

  // ⏩ 최종 배속 (v1.7)
  if (el.speedChips) {
    el.speedChips.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.speed) return;
      setOutputSpeed(+b.dataset.speed);
      renderTimeline();
      toast(`최종 배속 ${(+b.dataset.speed).toFixed(2)}x`);
    });
  }
  if (el.speedRange) {
    el.speedRange.addEventListener('input', () => {
      S.outputSpeed = clampNum(+el.speedRange.value, 0.5, 2, 1);
      syncSpeed();
    });
    el.speedRange.addEventListener('change', () => { setOutputSpeed(S.outputSpeed); renderTimeline(); });
  }

  // 🎵 배경노래 URL · 노래 볼륨
  if (el.btnSongUrl) el.btnSongUrl.addEventListener('click', () => loadSongFromUrl());
  if (el.songUrl) {
    el.songUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); loadSongFromUrl(); }
    });
  }
  if (el.songVol) {
    el.songVol.addEventListener('input', () => {
      S.songTrack = { ...(S.songTrack || {}), vol: clampNum(+el.songVol.value, 0, 1.5, 1) };
      el.songVolOut.textContent = `${Math.round(S.songTrack.vol * 100)}%`;
      if (el.stVol) { el.stVol.value = String(S.songTrack.vol); el.stVolOut.textContent = el.songVolOut.textContent; }
    });
    el.songVol.addEventListener('change', () => {
      saveState();
      if (tl.playing) { tlStop(); tlPlayToggle(); }
      renderTimeline();
    });
  }
  // 두 손잡이 트림 슬라이더 — 손가락으로 트랙 아무 곳이나 눌러 가까운 손잡이를 끌 수 있게(v1.5)
  (function bindDualTrim() {
    const box = document.querySelector('#songBlock .dualslider');
    if (!box || !el.trimStart || !el.trimEnd) return;
    let drag = null;
    const syncNum = () => {
      el.trimStartNum.value = S.trim.start.toFixed(1);
      el.trimEndNum.value = S.trim.end.toFixed(1);
      const dur = S.backing ? S.backing.duration : 1;
      el.trimStart.value = String((S.trim.start / dur) * 1000);
      el.trimEnd.value = String((S.trim.end / dur) * 1000);
    };
    const applyX = (clientX) => {
      if (!S.backing) return;
      const r = el.trimStart.getBoundingClientRect();
      const ratio = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
      const dur = S.backing.duration;
      const t = ratio * dur;
      if (!drag) drag = Math.abs(t - S.trim.start) <= Math.abs(t - S.trim.end) ? 'start' : 'end';
      if (drag === 'start') S.trim.start = clamp(t, 0, Math.max(0, S.trim.end - 0.2));
      else S.trim.end = clamp(t, S.trim.start + 0.2, dur);
      syncNum();
      drawBackWave();
      scheduleGrid();
      rebuild();
    };
    box.addEventListener('pointerdown', (e) => {
      if (!S.backing) return;
      drag = null;
      try { box.setPointerCapture(e.pointerId); } catch (err) {}
      applyX(e.clientX);
      e.preventDefault();
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      applyX(e.clientX);
      e.preventDefault();
    });
    const end = () => { drag = null; saveState(); };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  })();

  el.btnTrimPlay.addEventListener('click', () => {
    if (!S.backing) return;
    stopAllPreviewAudio();
    const dur = Math.min(S.backing.duration - S.trim.start, S.trim.end - S.trim.start);
    playOneShot(S.backing.buffer, S.trim.start + (S.offsetBack || 0), dur, clampNum(S.songTrack && S.songTrack.vol, 0, 1.5, 1) * (S.backing.norm || 1));
    toast('선택 구간을 재생해요 — 다시 누르면 새로 시작해요');
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
  el.btnHighlight.addEventListener('click', applyHighlightStart);
  el.btnResetSec.addEventListener('click', () => { S.sections = defaultSections(); rebuild(); saveState(); toast('기본 구성으로 돌아왔어요'); });

  // 영상 맞춤 방식
  if (el.fitModes) {
    el.fitModes.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.mode) return;
      const mode = b.dataset.mode === 'beatcut' ? 'beatcut' : b.dataset.mode === 'smooth' ? 'smooth' : 'sync';
      S.fitMode = mode;
      syncFitMode(); rebuild(); saveState();
      toast(mode === 'sync' ? '🎯 음원 싱크 믹싱 — 옹알이 입모양에 맞춰 영상도 같이 움직여요'
        : mode === 'smooth' ? '🎬 1배속 부드럽게로 맞췄어요' : '✂️ 비트컷으로 바꿨어요');
    });
  }

  // 저장 화질
  if (el.resChips) {
    el.resChips.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.res) return;
      S.renderRes = b.dataset.res === '1080' ? '1080' : '720';
      syncRes(); saveState();
      toast(S.renderRes === '720' ? '720×1280 · 부드러운 저장' : '1080×1920 · 고화질');
    });
  }

  // 영상 효과: 알아서 / 직접
  if (el.fxModes) {
    el.fxModes.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !b.dataset.fxmode) return;
      S.fxMode = b.dataset.fxmode === 'manual' ? 'manual' : 'auto';
      if (S.fxMode === 'auto') applyAutoFx(true);
      syncFxControls(); saveState(); scheduleDraw();
      toast(S.fxMode === 'auto' ? '✨ 알아서 편집으로 맞췄어요' : '🎛️ 직접 편집 — 효과를 골라 보세요');
    });
  }
  if (el.btnFxAuto) el.btnFxAuto.addEventListener('click', () => applyAutoFx());
  const manualFx = () => {
    S.fxMode = 'manual';
    syncFxControls(); saveState(); scheduleDraw();
  };
  if (el.fxPunch) el.fxPunch.addEventListener('change', () => { S.punch = +el.fxPunch.value; manualFx(); });
  if (el.fxFlash) el.fxFlash.addEventListener('change', () => { S.flash = +el.fxFlash.value; manualFx(); });
  if (el.fxShake) el.fxShake.addEventListener('change', () => { S.fx.shake = +el.fxShake.value; manualFx(); });
  if (el.fxColor) el.fxColor.addEventListener('change', () => { S.fx.color = el.fxColor.value; manualFx(); });
  if (el.fxEdge) el.fxEdge.addEventListener('change', () => { S.fx.edge = el.fxEdge.checked; S.pulse = el.fxEdge.checked; manualFx(); });
  if (el.fxPsy) el.fxPsy.addEventListener('change', () => { S.fx.psy = +el.fxPsy.value; manualFx(); });

  // 자동 편집
  el.autoEdit.addEventListener('change', () => {
    S.autoEdit = el.autoEdit.checked;
    el.editOpts.classList.toggle('off', !S.autoEdit);
    rebuild(); saveState();
  });
  el.cutBeats.addEventListener('change', () => { S.cutBeats = +el.cutBeats.value; rebuild(); saveState(); });
  el.punchLevel && 0;

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

  window.addEventListener('resize', () => { scheduleDraw(); setPlayhead(tl.t); if (S.voice) { drawWave(el.waveVoice, S.voice.peaks, { markers: S.voice.segments, color: 'rgba(255,255,255,.5)' }); drawBackWave(); } });
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
    beatTabs: null, paneSynth: null, paneFile: null, paneYt: null,
    mixStack: 'mixStack', mixSongName: 'mixSongName', mixSongMeta: 'mixSongMeta',
    mixBeatName: 'mixBeatName', mixBeatMeta: 'mixBeatMeta', mixVoiceName: 'mixVoiceName', mixVoiceMeta: 'mixVoiceMeta',
    btnSongOn: 'btnSongOn', btnBeatOn: 'btnBeatOn', songBlock: 'songBlock', beatBlock: 'beatBlock',
    beatHintSmall: 'beatHintSmall', bpmMatchInfo: 'bpmMatchInfo', btnBpmSong: 'btnBpmSong',
    songUrl: 'songUrl', btnSongUrl: 'btnSongUrl', songUrlMsg: 'songUrlMsg', songVol: 'songVol', songVolOut: 'songVolOut',
    speedChips: 'speedChips', speedRange: 'speedRange', speedOut: 'speedOut', speedDur: 'speedDur', speedHint: 'speedHint',
    finalLen: 'finalLen', finalLenWrap: 'finalLenWrap',
    genreChips: 'genreChips', bpm: 'bpm', bpmOut: 'bpmOut',
    fileBack: 'fileBack', dropBack: 'dropBack', backLoaded: 'backLoaded', backName: 'backName', backDur: 'backDur',
    waveBack: 'waveBack', trimStart: 'trimStart', trimEnd: 'trimEnd', trimStartNum: 'trimStartNum',
    trimEndNum: 'trimEndNum', btnTrimPlay: 'btnTrimPlay', bpmEst: 'bpmEst', btnBpmApply: 'btnBpmApply',
    offsetBack: 'offsetBack',
    ytUrl: 'ytUrl', btnYt: 'btnYt', ytMsg: 'ytMsg', ytProxy: 'ytProxy', btnYtProxySave: 'btnYtProxySave',
    lenPresets: 'lenPresets', lenCustom: 'lenCustom', lenUnit: 'lenUnit', lenUnitLabel: 'lenUnitLabel', btnFit: 'btnFit',
    totalLen2: 'totalLen2', totalBars: 'totalBars', cutCount: 'cutCount', bpmLabel: 'bpmLabel', tlBar: 'tlBar',
    secList: 'secList', btnAddDrop: 'btnAddDrop', btnAddBreak: 'btnAddBreak', btnAddIntro: 'btnAddIntro', btnResetSec: 'btnResetSec',
    autoEdit: 'autoEdit', editOpts: 'editOpts', cutBeats: 'cutBeats',
    fxModes: 'fxModes', fxAutoBlock: 'fxAutoBlock', fxManualBlock: 'fxManualBlock',
    fxSummary: 'fxSummary', btnFxAuto: 'btnFxAuto', fxPunch: 'fxPunch', fxFlash: 'fxFlash',
    fxShake: 'fxShake', fxColor: 'fxColor', fxEdge: 'fxEdge', fxPsy: 'fxPsy',
    fitModes: 'fitModes', fitHint: 'fitHint', btnHighlight: 'btnHighlight',
    fitY: 'fitY', fitYOut: 'fitYOut',
    fmtChips: 'fmtChips', fmtBg: 'fmtBg', fmtAccent: 'fmtAccent', fmtFont: 'fmtFont', fmtFontOut: 'fmtFontOut',
    badgeLogo: 'badgeLogo', badgeText: 'badgeText', dropLogo: 'dropLogo', fileLogo: 'fileLogo',
    btnSaveFmt: 'btnSaveFmt', btnDelFmt: 'btnDelFmt',
    title1: 'title1', title2: 'title2',
    voiceVol: 'voiceVol', voiceVolOut: 'voiceVolOut', beatVol: 'beatVol', beatVolOut: 'beatVolOut',
    reverb: 'reverb', reverbOut: 'reverbOut', pitch: 'pitch', pitchOut: 'pitchOut',
    btnRender: 'btnRender', renderBox: 'renderBox', renderBar: 'renderBar', renderMsg: 'renderMsg',
    resChips: 'resChips', resHint: 'resHint',
    outList: 'outList', saveHint: 'saveHint', thumb: 'thumb', btnHelp: 'btnHelp', toast: 'toast',
    voiceFxChips: 'voiceFxChips', voiceFxHint: 'voiceFxHint',
    tlBody: 'tlBody', tlRuler: 'tlRuler', tlVoiceLane: 'tlVoiceLane', tlSongLane: 'tlSongLane', tlBeatLane: 'tlBeatLane',
    tlHeadLine: 'tlHeadLine', tlInfo: 'tlInfo', tlPlay: 'tlPlay', tlAuto: 'tlAuto', tlPos: 'tlPos',
    tlClipPanel: 'tlClipPanel', tlpTitle: 'tlpTitle', tlpAt: 'tlpAt', tlpAtOut: 'tlpAtOut',
    tlpLen: 'tlpLen', tlpLenOut: 'tlpLenOut', tlpVol: 'tlpVol', tlpVolOut: 'tlpVolOut',
    tlpPlay: 'tlpPlay', tlpOff: 'tlpOff', tlpClose: 'tlpClose',
    vtOffset: 'vtOffset', vtOffsetOut: 'vtOffsetOut', vtVol: 'vtVol', vtVolOut: 'vtVolOut',
    btStart: 'btStart', btStartOut: 'btStartOut', btLen: 'btLen', btLenOut: 'btLenOut',
    btVol: 'btVol', btVolOut: 'btVolOut', btFadeIn: 'btFadeIn', btFadeInOut: 'btFadeInOut',
    btFadeOut: 'btFadeOut', btFadeOutOut: 'btFadeOutOut',
    btDuck: 'btDuck', btDuckOut: 'btDuckOut', btnGridAuto: 'btnGridAuto', gridInfo: 'gridInfo', remixPattern: 'remixPattern',
    stStart: 'stStart', stStartOut: 'stStartOut', stLen: 'stLen', stLenOut: 'stLenOut',
    stVol: 'stVol', stVolOut: 'stVolOut', stFadeIn: 'stFadeIn', stFadeInOut: 'stFadeInOut',
    stFadeOut: 'stFadeOut', stFadeOutOut: 'stFadeOutOut',
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
  // 화질 기본값: 아이폰·모바일은 720p(끊김 적음), 넓은 화면은 1080p
  S.renderRes = S.renderRes || ((IS_IOS || IS_TOUCH) ? '720' : '1080');
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
  engine.speed = clampNum(S.outputSpeed, 0.5, 2, 1);
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
  window.__remix = {
    S, engine, rebuild, get arr() { return S.arr; }, tl, playSegment, materializeClips,
    renderWav, renderMixBuffer, scheduleMix, setPlayhead, syncVoiceFx, syncFitMode,
    syncMixMode, syncSpeed, setOutputSpeed, shotsForSpeed, loadSongFromUrl, onBackFile,
    sourceTimeAt, shotSourceAt: (t) => engine.shotSourceTime(engine.shots[engine.indexAt(t)], t),
    get nowT() { return playState ? audioCtx().currentTime - playState.t0 : NaN; },
    get lastDrawT() { return lastDrawT; },
    get clipList() { return clipList(); },
    get previewCount() { return previewPool.size + (segAudio ? 1 : 0) + (tl.playing ? 1 : 0) + (playing ? 1 : 0); },
    stopAllPreviewAudio,
  };
  document.documentElement.dataset.ready = '1';
}

init().catch((e) => {
  console.error(e);
  setStatus('초기화 오류: ' + e.message);
});

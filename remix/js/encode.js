// 30fps 고정 인코딩 — WebCodecs(VideoEncoder) + 내장 mp4-muxer
// 실시간 MediaRecorder 녹화 대신, 타임라인의 1/30초 지점마다 원본 영상을 seek해
// 한 장씩 캔버스에 그린 뒤 인코딩한다. 그래서 아이폰에서도 프레임 드랍 없이 진짜 30fps가 나온다.
//
// 오디오 두 갈래:
//   A) AudioEncoder가 있으면(v1.3과 동일) AAC/Opus로 직접 인코딩.
//   B) iOS 17/18 Safari처럼 AudioEncoder가 없으면(v1.4 하이브리드) 완성된 믹스를
//      MediaRecorder로 '소리만' 녹음해 그 MP4에서 AAC 프레임을 꺼내 비디오와 합친다.
import { Muxer, ArrayBufferTarget } from './mp4-muxer.js?v=1.7.0';
import {
  audioRecorderSupported,
  pickAudioRecorderMime,
  recordAudioMp4,
  measureAudioStart,
  demuxAudioMp4,
} from './audio-mp4.js?v=1.7.0';

export const FPS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 아이폰은 VideoEncoder가 Safari 16.4+ / AudioEncoder(AAC)는 Safari 26+ 에서 지원된다.
export function webCodecsVideoSupported() {
  return typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';
}

export function webCodecsAudioSupported() {
  return typeof window.AudioEncoder === 'function' && typeof window.AudioData === 'function';
}

// 영상 인코딩이 가능하면 v1.4 경로(필요하면 하이브리드 오디오)로 간다.
export function webCodecsSupported() {
  return webCodecsVideoSupported();
}

// iOS 17/18 Safari: VideoEncoder는 있고 AudioEncoder는 없다. MediaRecorder(오디오 전용)로 소리를 채운다.
export function hybridAudioSupported() {
  return webCodecsVideoSupported() && !webCodecsAudioSupported() && audioRecorderSupported();
}

export { pickAudioRecorderMime };

// ── 인코더 설정 고르기 ────────────────────────────────────
function videoCandidates(res) {
  const base = { width: res.w, height: res.h, bitrate: res.vbps, framerate: FPS };
  // 720p = 레벨 3.1, 1080p = 레벨 4.0. 아이폰 하드웨어가 가장 잘 받는 순서대로.
  const codecs = res.h > 1280
    ? ['avc1.420028', 'avc1.4d0028', 'avc1.640028']
    : ['avc1.42001f', 'avc1.4d001f', 'avc1.64001f'];
  return codecs.map((codec) => ({ ...base, codec, avc: { format: 'avc' }, latencyMode: 'quality' }));
}

export async function pickVideoConfig(res) {
  for (const cfg of videoCandidates(res)) {
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r && r.supported) return r.config || cfg;
    } catch (e) { /* 다음 후보 */ }
  }
  return null;
}

// AAC(아이폰/사파리) → Opus(크롬 등) 순서.
export async function pickAudioConfig(sampleRate = 48000) {
  const cands = [
    { codec: 'mp4a.40.2', mux: 'aac', chunk: 1024, bitrate: 192000 },
    { codec: 'opus', mux: 'opus', chunk: 960, bitrate: 160000 },
  ];
  for (const c of cands) {
    const cfg = { codec: c.codec, sampleRate, numberOfChannels: 2, bitrate: c.bitrate };
    try {
      const r = await AudioEncoder.isConfigSupported(cfg);
      if (r && r.supported) return { ...c, cfg: r.config || cfg };
    } catch (e) { /* 다음 후보 */ }
  }
  return null;
}

// ── 원본 영상에서 원하는 시점의 프레임을 꺼내는 도구 ──────────
// display:none 이면 iOS 사파리가 백그라운드 비디오 디코딩을 스로틀링하므로,
// 화면 밖 2px 크기로 DOM에 붙여 둔다.
export class FrameGrabber {
  constructor() {
    this.el = null;
    this.url = null;
    this.pending = null;
  }

  async setSource(url) {
    if (!url) { this.el = null; this.url = null; return; }
    if (this.url === url && this.el) return;
    if (!this.el) {
      const v = document.createElement('video');
      v.muted = true;
      v.defaultMuted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:.01;pointer-events:none';
      document.body.appendChild(v);
      this.el = v;
    }
    const v = this.el;
    this.url = url;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener('loadeddata', fin); v.removeEventListener('error', fin); resolve(); };
      v.addEventListener('loadeddata', fin);
      v.addEventListener('error', fin);
      v.src = url;
      try { v.load(); } catch (e) {}
      setTimeout(fin, 8000);
    });
  }

  // video 요소를 해당 원본 시점으로 이동 (같은 구간이면 seek 생략)
  async seekTo(time) {
    const v = this.el;
    if (!v) return;
    const t = Math.max(0, time);
    const target = Math.min(t, Math.max(0, (v.duration || t) - 0.001));
    if (v.readyState >= 2 && Math.abs(v.currentTime - target) < 1 / 90) return;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        v.removeEventListener('seeked', fin);
        resolve();
      };
      v.addEventListener('seeked', fin);
      try { v.currentTime = target; } catch (e) { fin(); return; }
      setTimeout(fin, 120);           // 무한 대기 방지 (사파리 seek 지연)
    });
    // seeked 뒤에도 사파리는 한 프레임 늦게 그려질 수 있어, 새 프레임이 올라올 때까지 살짝 기다린다.
    if (typeof v.requestVideoFrameCallback === 'function') {
      await new Promise((resolve) => {
        let done = false;
        const fin = () => { if (done) return; done = true; resolve(); };
        const to = setTimeout(fin, 80);
        try { v.requestVideoFrameCallback(() => { clearTimeout(to); fin(); }); } catch (e) { clearTimeout(to); fin(); }
      });
    }
  }

  destroy() {
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
    this.url = null;
  }
}

// 샷이 흘러가는 속도(배속). 값이 없으면 1배속.
export function shotRate(shot) {
  const r = shot && shot.rate;
  return (typeof r === 'number' && isFinite(r) && r > 0.05) ? r : 1;
}

// 샷이 '시간이 흐르는' 샷인지 — sync(음원 싱크) · continuous · smooth,
// 또는 rate가 지정된 샷(비트컷도 정지 화면이 아니라 1배속으로 흐른다)은 모두 흐른다.
export function shotMoves(shot) {
  if (!shot) return false;
  return !!(shot.sync || shot.continuous || shot.smooth || (typeof shot.rate === 'number' && isFinite(shot.rate)));
}

// 타임라인 t초에 보여야 하는 원본 시점 (샷 목록 + 배속 + 루프 반영)
// v1.6: 음원 싱크 샷은 원본의 bufStart에서 시작해 오디오와 같은 배속으로 흐른다.
//       → t초에 들리는 옹알이와 화면 속 입모양이 정확히 같은 원본 시점이 된다.
export function sourceTimeAt(shots, videoDur, t) {
  if (!shots || !shots.length || !(videoDur > 0.05)) return 0;
  let shot = shots[shots.length - 1];
  for (let i = 0; i < shots.length; i++) {
    if (t < shots[i].tEnd) { shot = shots[i]; break; }
  }
  if (!shot) return 0;
  if (shotMoves(shot)) {
    const x = shot.srcStart + Math.max(0, t - shot.tStart) * shotRate(shot);
    return ((x % videoDur) + videoDur) % videoDur;      // 영상보다 길면 처음으로 자연 루프
  }
  return Math.max(0, Math.min(videoDur - 0.01, shot.srcStart));
}

// ── 오디오 A: 이미 렌더된 오프라인 믹스(AudioBuffer)를 AAC/Opus로 ──
async function encodeAudioTrack(audioBuffer, acfg, muxer, onProgress) {
  const srcRate = audioBuffer.sampleRate;
  const totalFrames = audioBuffer.length;
  const L = audioBuffer.getChannelData(0);
  const R = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : L;
  let error = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => { try { muxer.addAudioChunk(chunk, meta); } catch (e) { if (!error) error = e; } },
    error: (e) => { error = e; },
  });
  enc.configure({ ...acfg.cfg, sampleRate: srcRate, numberOfChannels: 2 });
  const block = acfg.chunk;
  for (let off = 0; off < totalFrames; off += block) {
    if (error) break;
    const n = Math.min(block, totalFrames - off);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(off, off + n), 0);
    data.set(R.subarray(off, off + n), n);
    const ad = new AudioData({
      format: 'f32-planar',
      sampleRate: srcRate,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((off * 1e6) / srcRate),
      data,
    });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 24) await sleep(2);
    if (onProgress && off % (block * 40) === 0) onProgress({ phase: 'audio', done: off, total: totalFrames });
  }
  if (!error) {
    try { await enc.flush(); } catch (e) { error = e; }
  }
  try { enc.close(); } catch (e) {}
  if (error) throw error;
}

// ── 오디오 B: MediaRecorder(오디오 전용) → AAC/Opus 프레임 추출 ──
// 믹스 원본에서 '첫 소리' 지점을 찾는다(녹음본과 비교해 녹음 시작 지연을 알아내는 용도).
function bufferFirstSound(audioBuffer) {
  const L = audioBuffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < L.length; i += 13) peak = Math.max(peak, Math.abs(L[i]));
  if (peak < 1e-4) return null;
  const thr = Math.max(1e-4, peak * 0.02);
  const n = Math.min(L.length, Math.floor(audioBuffer.sampleRate * 0.8));
  for (let i = 0; i < n; i += 16) {
    let m = 0;
    const e = Math.min(i + 16, L.length);
    for (let j = i; j < e; j++) m = Math.max(m, Math.abs(L[j]));
    if (m > thr) return i / audioBuffer.sampleRate;
  }
  return null;
}

async function prepareHybridAudio(audioBuffer, audioContext, total, onProgress) {
  if (!audioBuffer || !audioRecorderSupported()) return null;
  const mixFirstSound = bufferFirstSound(audioBuffer);
  let rec = null;
  try {
    onProgress && onProgress({ phase: 'audio-record', t: 0, total: audioBuffer.duration });
    rec = await recordAudioMp4(audioBuffer, { audioContext, onProgress });
    if (!rec) return null;
    onProgress && onProgress({ phase: 'audio-demux' });
    const raw = await rec.blob.arrayBuffer();
    const src = demuxAudioMp4(raw);
    if (!src || !src.samples.length) return null;

    // 녹음은 실시간이라 '녹음 시작 → 실제 소리' 사이에 지연이 생긴다. 그만큼 당겨서 0초에 맞춘다.
    // (편집 리스트가 있으면 재생기가 건너뛰는 프라이밍만큼도 함께 당긴다.)
    const start = await measureAudioStart(rec, audioContext, src.samples[0].ts, rec.intendedOffset, mixFirstSound) + (src.editStart || 0);
    const samples = [];
    for (const s of src.samples) {
      let ts = s.ts - start;
      let dur = s.dur;
      if (ts + dur <= 0) continue;
      if (ts >= total - 0.002) continue;
      if (ts < 0) { dur += ts; ts = 0; }
      dur = Math.min(dur, total - ts);
      if (!(dur > 0)) continue;
      samples.push({ data: s.data, ts, dur });
    }
    if (!samples.length) return null;
    return {
      codec: src.codec,
      sampleRate: src.sampleRate,
      channels: src.channels,
      description: src.description,
      samples,
    };
  } catch (e) {
    console.warn('하이브리드 오디오를 만들지 못했어요 → 무음 30fps 영상으로 저장', e);
    return null;
  } finally {
    rec = null;
  }
}

function addHybridAudio(muxer, hyb, onProgress) {
  const dec = {
    codec: hyb.codec === 'aac' ? 'mp4a.40.2' : 'opus',
    sampleRate: hyb.sampleRate,
    numberOfChannels: hyb.channels,
  };
  if (hyb.description) dec.description = hyb.description;
  const meta = { decoderConfig: dec };
  for (let i = 0; i < hyb.samples.length; i++) {
    const s = hyb.samples[i];
    muxer.addAudioChunkRaw(
      s.data,
      'key',
      Math.round(s.ts * 1e6),
      Math.round(s.dur * 1e6),
      i === 0 ? meta : undefined,
    );
    if (onProgress && i % 64 === 0) onProgress({ phase: 'audio-mux', done: i, total: hyb.samples.length });
  }
}

/**
 * 고정 30fps MP4 인코딩.
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas  렌더 캔버스 (VideoFrame 소스)
 * @param {(t:number, videoEl:HTMLVideoElement|null)=>void} o.draw  t초 장면을 캔버스에 그리는 콜백
 * @param {number} o.total 전체 길이(초)
 * @param {{w:number,h:number,vbps:number,scale:number}} o.res 저장 화질
 * @param {Array} o.shots arrange 샷 목록
 * @param {number} o.videoDur 원본 영상 길이
 * @param {string|null} o.videoUrl 원본 영상 URL
 * @param {AudioBuffer|null} o.audioBuffer 오프라인으로 렌더한 48kHz 믹스
 * @param {AudioContext|null} [o.audioContext] 앱이 쓰는 오디오 컨텍스트(하이브리드 녹음용)
 * @param {(p:object)=>void} [o.onProgress]
 */
export async function encodeMp4(o) {
  const { canvas, draw, total, res, shots, videoDur, videoUrl, audioBuffer, audioContext, onProgress } = o;
  if (!webCodecsVideoSupported()) return null;
  const vcfg = await pickVideoConfig(res);
  if (!vcfg) return null;

  const frames = Math.max(1, Math.round(total * FPS));

  // 오디오 경로 결정: A(AudioEncoder) → B(iOS 하이브리드) → 무음
  let acfg = null;
  let hybrid = null;
  if (audioBuffer) {
    if (webCodecsAudioSupported()) {
      acfg = await pickAudioConfig(audioBuffer.sampleRate);
    }
    if (!acfg) hybrid = await prepareHybridAudio(audioBuffer, audioContext, frames / FPS, onProgress);
  }
  const audioTrack = acfg
    ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: audioBuffer.sampleRate }
    : hybrid
      ? { codec: hybrid.codec, numberOfChannels: hybrid.channels, sampleRate: hybrid.sampleRate }
      : undefined;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: res.w, height: res.h, frameRate: FPS },
    audio: audioTrack,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let vError = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { if (!vError) vError = e; } },
    error: (e) => { vError = e; },
  });
  venc.configure(vcfg);

  // 오디오 먼저(경로 A는 빠른 오프라인 인코딩, 경로 B는 실시간 녹음) — 영상 seek 전에 끝낸다.
  if (acfg) {
    onProgress && onProgress({ phase: 'audio-start', frames });
    await encodeAudioTrack(audioBuffer, acfg, muxer, onProgress);
  } else if (hybrid) {
    onProgress && onProgress({ phase: 'audio-mux-start', total: hybrid.samples.length });
    addHybridAudio(muxer, hybrid, onProgress);
  }
  if (vError) throw vError;

  const grabber = new FrameGrabber();
  try {
    if (videoUrl) await grabber.setSource(videoUrl);
    const keyEvery = FPS * 2;           // 2초마다 키프레임(사진첩·플레이어 탐색 대비)
    for (let i = 0; i < frames; i++) {
      if (vError) break;
      const t = Math.min(total, i / FPS);
      // v1.7: 프레임 경계(1/30초)를 그대로 seek하면 디코더가 직전 프레임을 올리는 경우가 있다
      //       → 반 프레임(1/60초) 앞을 목표로 잡아 '그 순간에 가장 가까운 프레임'을 그린다.
      if (videoUrl) await grabber.seekTo(sourceTimeAt(shots, videoDur, t) + 0.5 / FPS);
      draw(t, grabber.el);
      const ts = Math.round((i * 1e6) / FPS);
      const frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(1e6 / FPS) });
      venc.encode(frame, { keyFrame: i % keyEvery === 0 });
      frame.close();
      while (venc.encodeQueueSize > 6 && !vError) await sleep(4);
      if (onProgress && (i % 3 === 0 || i === frames - 1)) onProgress({ phase: 'video', i: i + 1, frames, t });
    }
    if (vError) throw vError;
    await venc.flush();
    if (vError) throw vError;
    muxer.finalize();
  } finally {
    try { venc.close(); } catch (e) {}
    grabber.destroy();
  }

  const buf = target.buffer;
  if (!buf || buf.byteLength < 1024) return null;
  return {
    blob: new Blob([buf], { type: 'video/mp4' }),
    frames,
    fps: FPS,
    width: res.w,
    height: res.h,
    videoCodec: vcfg.codec,
    audioCodec: acfg ? acfg.codec : hybrid ? hybrid.codec : null,
    audioPath: acfg ? 'full' : hybrid ? 'hybrid' : 'silent',
    audioSamples: hybrid ? hybrid.samples.length : 0,
    duration: frames / FPS,
  };
}

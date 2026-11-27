// 30fps 고정 인코딩 — WebCodecs(VideoEncoder + AudioEncoder) + 내장 mp4-muxer
// 실시간 MediaRecorder 녹화 대신, 타임라인의 1/30초 지점마다 원본 영상을 seek해
// 한 장씩 캔버스에 그린 뒤 인코딩한다. 그래서 아이폰에서도 프레임 드랍 없이 진짜 30fps가 나온다.
import { Muxer, ArrayBufferTarget } from './mp4-muxer.js';

export const FPS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function webCodecsSupported() {
  return typeof window.VideoEncoder === 'function'
    && typeof window.VideoFrame === 'function'
    && typeof window.AudioEncoder === 'function'
    && typeof window.AudioData === 'function';
}

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

// AAC(아이폰/사파리) → Opus(크롬 등) 순서. 둘 다 안 되면 영상 인코딩도 포기하고 MediaRecorder로.
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

// 타임라인 t초에 보여야 하는 원본 시점 (샷 목록 + 루프 반영)
export function sourceTimeAt(shots, videoDur, t) {
  if (!shots || !shots.length || !(videoDur > 0.05)) return 0;
  let shot = shots[shots.length - 1];
  for (let i = 0; i < shots.length; i++) {
    if (t < shots[i].tEnd) { shot = shots[i]; break; }
  }
  if (!shot) return 0;
  if (shot.smooth) {
    const x = shot.srcStart + Math.max(0, t - shot.tStart);
    return ((x % videoDur) + videoDur) % videoDur;
  }
  return Math.max(0, Math.min(videoDur - 0.01, shot.srcStart));
}

// ── 오디오: 이미 렌더된 오프라인 믹스(AudioBuffer)를 AAC/Opus로 ──
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
  const rateScale = 1; // 오프라인 렌더는 48kHz 고정
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
      timestamp: Math.round((off * rateScale * 1e6) / srcRate),
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
 * @param {(p:object)=>void} [o.onProgress]
 */
export async function encodeMp4(o) {
  const { canvas, draw, total, res, shots, videoDur, videoUrl, audioBuffer, onProgress } = o;
  if (!webCodecsSupported()) return null;
  const vcfg = await pickVideoConfig(res);
  if (!vcfg) return null;
  const acfg = audioBuffer ? await pickAudioConfig(audioBuffer.sampleRate) : null;
  if (audioBuffer && !acfg) return null;   // 소리 없는 영상은 만들지 않는다 → MediaRecorder로

  const frames = Math.max(1, Math.round(total * FPS));
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: res.w, height: res.h, frameRate: FPS },
    audio: acfg ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: audioBuffer.sampleRate } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let vError = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { if (!vError) vError = e; } },
    error: (e) => { vError = e; },
  });
  venc.configure(vcfg);

  // 오디오 먼저 인코딩(빠름) — 영상 프레임을 하나씩 그리는 동안 기다릴 필요가 없다.
  if (acfg) {
    onProgress && onProgress({ phase: 'audio-start', frames });
    await encodeAudioTrack(audioBuffer, acfg, muxer, onProgress);
  }
  if (vError) throw vError;

  const grabber = new FrameGrabber();
  try {
    if (videoUrl) await grabber.setSource(videoUrl);
    const keyEvery = FPS * 2;           // 2초마다 키프레임(사진첩·플레이어 탐색 대비)
    for (let i = 0; i < frames; i++) {
      if (vError) break;
      const t = Math.min(total, i / FPS);
      if (videoUrl) await grabber.seekTo(sourceTimeAt(shots, videoDur, t));
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
    audioCodec: acfg ? acfg.codec : null,
    duration: frames / FPS,
  };
}

// iOS 17/18 Safari 하이브리드 오디오 — MediaRecorder(오디오 전용) → MP4 안의 AAC/Opus 샘플 추출
//
// 사파리는 VideoEncoder(H.264)는 iOS 16.4+부터 있지만 AudioEncoder(AAC)는 iOS 26+에야 있다.
// 그래서 iOS 17/18에서는 소리를 WebCodecs로 못 만든다. 대신 MediaRecorder는 iOS 14.5+부터
// audio/mp4(AAC)를 지원하므로, 완성된 오프라인 믹스(AudioBuffer)를 실시간으로 재생하면서
// '소리만' 녹음하고, 그 MP4 컨테이너에서 AAC 프레임과 AudioSpecificConfig(esds)를 꺼내
// mp4-muxer로 비디오와 한 파일로 합친다. (MediaRecorder MP4는 조각(moof) 구조와
// 일반(moov/stbl) 구조 둘 다 나올 수 있다.)
//
// 컨테이너가 Opus인 경우(크롬 등 AudioEncoder가 없는 환경 시험용)도 같은 방식으로 읽는다.

const AUDIO_MIMES = [
  'audio/mp4;codecs=mp4a.40.2', // 사파리(14.5~18.3): AAC-LC
  'audio/mp4',                  // 사파리·크롬(크롬은 Opus로 들어감)
];

function readU32(u8, o) {
  return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
}
function readI32(u8, o) {
  return (u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3];
}
function readU16(u8, o) {
  return (u8[o] << 8) | u8[o + 1];
}
function readI16(u8, o) {
  const v = readU16(u8, o);
  return v > 0x7fff ? v - 0x10000 : v;
}
function readU64(u8, o) {
  return readU32(u8, o) * 4294967296 + readU32(u8, o + 4);
}
function fourcc(u8, o) {
  return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
}
function writeU16LE(a, o, v) {
  a[o] = v & 0xff; a[o + 1] = (v >>> 8) & 0xff;
}
function writeI16LE(a, o, v) {
  writeU16LE(a, o, v < 0 ? v + 0x10000 : v);
}
function writeU32LE(a, o, v) {
  a[o] = v & 0xff; a[o + 1] = (v >>> 8) & 0xff; a[o + 2] = (v >>> 16) & 0xff; a[o + 3] = (v >>> 24) & 0xff;
}

// ── MP4 박스 훑기 ────────────────────────────────────────────
function nextBox(u8, off, end) {
  if (off + 8 > end) return null;
  let size = readU32(u8, off);
  const type = fourcc(u8, off + 4);
  let hdr = 8;
  if (size === 1) {
    if (off + 16 > end) return null;
    size = readU64(u8, off + 8);
    hdr = 16;
  } else if (size === 0) {
    size = end - off;
  }
  if (!(size >= hdr) || off + size > end) return null;
  return { type, start: off, end: off + size, hdr, size, data: off + hdr };
}
function childrenOf(u8, box) {
  const out = [];
  let off = box.start + box.hdr;
  while (off + 8 <= box.end) {
    const b = nextBox(u8, off, box.end);
    if (!b) break;
    out.push(b);
    off = b.end;
  }
  return out;
}
function findBox(list, type) {
  for (const b of list) if (b.type === type) return b;
  return null;
}
function pathBox(u8, box, names) {
  let cur = box;
  for (const name of names) {
    if (!cur) return null;
    cur = findBox(childrenOf(u8, cur), name);
  }
  return cur;
}

// ── esds → AudioSpecificConfig ──────────────────────────────
function parseEsds(box, u8) {
  const p0 = box.data;
  let p = p0 + 4; // version/flags
  const end = box.end;
  const readDesc = () => {
    if (p >= end) return null;
    const tag = u8[p++];
    let len = 0;
    for (let i = 0; i < 4 && p < end; i++) {
      const c = u8[p++];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { tag, len, start: p };
  };
  const es = readDesc();
  if (!es || es.tag !== 0x03) return null;
  p = es.start + 2; // ES_ID
  const flags = u8[p++];
  if (flags & 0x80) p += 2;                 // dependsOn_ES_ID
  if (flags & 0x40) p += 1 + (u8[p] || 0);  // URL
  if (flags & 0x20) p += 2;                 // OCR_ES_ID
  const dcd = readDesc();
  if (!dcd || dcd.tag !== 0x04) return null;
  const oti = u8[dcd.start];
  p = dcd.start + 1 + 1 + 3 + 4 + 4;        // OTI, streamType, bufferSize, max/avg bitrate
  const dsi = readDesc();
  let asc = null;
  if (dsi && dsi.tag === 0x05 && dsi.len > 0) asc = u8.slice(dsi.start, Math.min(dsi.start + dsi.len, end));
  return { oti, asc };
}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function parseAsc(asc) {
  if (!asc || !asc.length) return null;
  let bit = 0;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((asc[bit >> 3] >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  try {
    let objectType = read(5);
    if (objectType === 31) objectType = 32 + read(6);
    const fi = read(4);
    const sampleRate = fi === 15 ? read(24) : AAC_RATES[fi];
    const channels = read(4);
    return { objectType, sampleRate, channels };
  } catch (e) {
    return null;
  }
}

// ── 오디오 트랙(stsd) 읽기 ─────────────────────────────────
function readAudioEntry(u8, trak) {
  const stbl = pathBox(u8, trak, ['mdia', 'minf', 'stbl']);
  if (!stbl) return null;
  const stsd = findBox(childrenOf(u8, stbl), 'stsd');
  if (!stsd) return null;
  const entry = nextBox(u8, stsd.data + 8, stsd.end); // version/flags(4)+entry_count(4)
  if (!entry) return null;
  const kind = entry.type;
  // 오디오 샘플 엔트리 고정부 28바이트 뒤에 자식 박스
  const kids = childrenOf(u8, { ...entry, start: entry.start, hdr: entry.hdr + 28 });
  let codec = null;
  let sampleRate = 0;
  let channels = 0;
  let description = null;
  if (kind === 'mp4a' || kind === 'enca') {
    codec = 'aac';
    channels = readU16(u8, entry.data + 16) || 2;
    sampleRate = readU32(u8, entry.data + 24) >>> 16;
    const esds = findBox(kids, 'esds');
    if (esds) {
      const info = parseEsds(esds, u8);
      if (info) {
        if (info.asc) {
          description = info.asc;
          const a = parseAsc(info.asc);
          if (a) {
            if (a.sampleRate) sampleRate = a.sampleRate;
            if (a.channels && a.channels !== 0) channels = a.channels;
          }
        }
      }
    }
    if (!sampleRate) sampleRate = 48000;
  } else if (kind === 'Opus') {
    codec = 'opus';
    const dops = findBox(kids, 'dOps');
    channels = readU16(u8, entry.data + 16) || 2;
    sampleRate = readU32(u8, entry.data + 24) >>> 16;
    if (dops) {
      const p = dops.data;
      channels = u8[p + 1] || channels;
      const preskip = readU16(u8, p + 2);
      const rate = readU32(u8, p + 4);
      const gain = readI16(u8, p + 8);
      if (rate) sampleRate = rate;
      // mp4-muxer는 OpusHead(19바이트)를 기대한다.
      const head = new Uint8Array(19);
      head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
      head[8] = 1;
      head[9] = channels;
      writeU16LE(head, 10, preskip);
      writeU32LE(head, 12, sampleRate);
      writeI16LE(head, 16, gain);
      head[18] = 0;
      description = head;
    }
    if (!sampleRate) sampleRate = 48000;
  } else {
    return null;
  }
  return { kind, codec, sampleRate, channels, description, stbl };
}

// stbl(비조각 MP4)에서 샘플 뽑기
function samplesFromStbl(u8, stbl, timescale, defaults) {
  const kids = childrenOf(u8, stbl);
  const stts = findBox(kids, 'stts');
  const stsz = findBox(kids, 'stsz');
  const stsc = findBox(kids, 'stsc');
  const stco = findBox(kids, 'stco');
  const co64 = findBox(kids, 'co64');
  const sampleSizeTable = [];
  let fixedSize = 0;
  if (stsz) {
    const p = stsz.data;
    fixedSize = readU32(u8, p + 4);
    const count = readU32(u8, p + 8);
    if (fixedSize) {
      for (let i = 0; i < count; i++) sampleSizeTable.push(fixedSize);
    } else {
      for (let i = 0; i < count; i++) sampleSizeTable.push(readU32(u8, p + 12 + i * 4));
    }
  }
  if (!sampleSizeTable.length && defaults.size) {
    // 조각 파일이면 위에서 이미 처리되므로 여기서는 종료
    return [];
  }
  const deltas = [];
  if (stts) {
    const p = stts.data;
    const n = readU32(u8, p + 4);
    for (let i = 0; i < n; i++) {
      const count = readU32(u8, p + 8 + i * 8);
      const delta = readU32(u8, p + 12 + i * 8);
      for (let k = 0; k < count && deltas.length < sampleSizeTable.length; k++) deltas.push(delta);
    }
  }
  const chunkOffsets = [];
  if (stco) {
    const p = stco.data;
    const n = readU32(u8, p + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(readU32(u8, p + 8 + i * 4));
  } else if (co64) {
    const p = co64.data;
    const n = readU32(u8, p + 4);
    for (let i = 0; i < n; i++) chunkOffsets.push(readU64(u8, p + 8 + i * 8));
  }
  const runs = [];
  if (stsc) {
    const p = stsc.data;
    const n = readU32(u8, p + 4);
    for (let i = 0; i < n; i++) {
      runs.push({
        firstChunk: readU32(u8, p + 8 + i * 12),
        perChunk: readU32(u8, p + 12 + i * 12),
      });
    }
  }
  if (!chunkOffsets.length || !runs.length) return [];

  const out = [];
  let si = 0;
  let acc = 0;
  for (let ci = 0; ci < chunkOffsets.length && si < sampleSizeTable.length; ci++) {
    let per = runs[0].perChunk;
    for (const r of runs) if (r.firstChunk <= ci + 1) per = r.perChunk;
    let off = chunkOffsets[ci];
    for (let k = 0; k < per && si < sampleSizeTable.length; k++) {
      const size = sampleSizeTable[si];
      if (size > 0) {
        const durUnits = deltas[si] || defaults.duration || 0;
        out.push({
          data: u8.subarray(off, Math.min(off + size, u8.length)),
          ts: acc / timescale,
          dur: durUnits / timescale,
        });
      }
      off += size;
      acc += deltas[si] || defaults.duration || 0;
      si++;
    }
  }
  return out;
}

// moof(조각 MP4)에서 샘플 뽑기
function samplesFromMoofs(u8, moofs, trackId, timescale, trexByTrack) {
  const out = [];
  const def = trexByTrack[trackId] || {};
  let prevEnd = 0;
  for (const moof of moofs) {
    const moofStart = moof.start;
    for (const traf of childrenOf(u8, moof)) {
      if (traf.type !== 'traf') continue;
      const kids = childrenOf(u8, traf);
      const tfhd = findBox(kids, 'tfhd');
      if (!tfhd) continue;
      let p = tfhd.data;
      const flags = readU32(u8, p) & 0xffffff;
      p += 4;
      const id = readU32(u8, p);
      p += 4;
      if (id !== trackId) continue;
      let base = prevEnd || moofStart;
      if (flags & 0x000001) { base = readU64(u8, p); p += 8; }
      else if (flags & 0x020000) { base = moofStart; }
      if (flags & 0x000002) p += 4;
      let defDur = def.duration || 0;
      let defSize = def.size || 0;
      if (flags & 0x000008) { defDur = readU32(u8, p); p += 4; }
      if (flags & 0x000010) { defSize = readU32(u8, p); p += 4; }
      if (flags & 0x000020) p += 4;

      const tfdt = findBox(kids, 'tfdt');
      let baseTime = 0;
      let tfdtVersion = 0;
      if (tfdt) {
        const vf = readU32(u8, tfdt.data);
        tfdtVersion = vf >>> 24;
        baseTime = tfdtVersion === 1 ? readU64(u8, tfdt.data + 4) : readU32(u8, tfdt.data + 4);
      }
      let accUnits = baseTime;
      let dataPos = null;
      let runBytes = 0;

      for (const trun of kids) {
        if (trun.type !== 'trun') continue;
        let q = trun.data;
        const tflags = readU32(u8, q) & 0xffffff;
        q += 4;
        const count = readU32(u8, q); q += 4;
        let dataOffset = null;
        if (tflags & 0x000001) { dataOffset = readI32(u8, q); q += 4; }
        if (tflags & 0x000004) q += 4; // first_sample_flags
        let pos;
        if (dataOffset !== null) pos = base + dataOffset;
        else if (dataPos !== null) pos = dataPos + runBytes;
        else pos = base;
        dataPos = pos;
        runBytes = 0;
        for (let i = 0; i < count; i++) {
          let dur = defDur;
          let size = defSize;
          let cto = 0;
          if (tflags & 0x000100) { dur = readU32(u8, q); q += 4; }
          if (tflags & 0x000200) { size = readU32(u8, q); q += 4; }
          if (tflags & 0x000400) q += 4;
          if (tflags & 0x000800) { cto = readI32(u8, q); q += 4; }
          if (size > 0 && pos >= 0 && pos + size <= u8.length) {
            out.push({
              data: u8.subarray(pos, pos + size),
              ts: accUnits / timescale,
              dur: dur / timescale,
            });
          }
          pos += size;
          runBytes += size;
          accUnits += dur;
        }
      }
      prevEnd = Math.max(prevEnd, dataPos !== null ? dataPos + runBytes : prevEnd);
    }
  }
  return out;
}

/**
 * MediaRecorder가 만든 오디오 MP4에서 압축 오디오 샘플과 디코더 설정을 꺼낸다.
 * @param {ArrayBuffer} buffer
 * @returns {{codec:'aac'|'opus', sampleRate:number, channels:number, description:Uint8Array|null, samples:Array}}
 */
export function demuxAudioMp4(buffer) {
  const u8 = new Uint8Array(buffer);
  const top = [];
  let off = 0;
  while (off + 8 <= u8.length) {
    const b = nextBox(u8, off, u8.length);
    if (!b) break;
    top.push(b);
    off = b.end;
  }
  const moov = findBox(top, 'moov');
  if (!moov) throw new Error('오디오 MP4(moov)를 읽지 못했어요');

  const traks = childrenOf(u8, moov).filter((b) => b.type === 'trak');
  let picked = null;
  for (const trak of traks) {
    const hdlr = pathBox(u8, trak, ['mdia', 'hdlr']);
    if (!hdlr || fourcc(u8, hdlr.data + 8) !== 'soun') continue;
    const mdhd = pathBox(u8, trak, ['mdia', 'mdhd']);
    let timescale = 48000;
    if (mdhd) {
      const v = u8[mdhd.data];
      timescale = v === 1 ? readU32(u8, mdhd.data + 20) : readU32(u8, mdhd.data + 12);
      if (!timescale) timescale = 48000;
    }
    const tkhd = findBox(childrenOf(u8, trak), 'tkhd');
    let trackId = 1;
    if (tkhd) {
      const v = u8[tkhd.data];
      trackId = v === 1 ? readU32(u8, tkhd.data + 20) : readU32(u8, tkhd.data + 12);
    }
    const entry = readAudioEntry(u8, trak);
    if (!entry) continue;
    picked = { timescale, trackId, ...entry };
    break;
  }
  if (!picked) throw new Error('오디오 트랙을 찾지 못했어요');

  const mvex = findBox(childrenOf(u8, moov), 'mvex');
  const trexByTrack = {};
  if (mvex) {
    for (const trex of childrenOf(u8, mvex)) {
      if (trex.type !== 'trex') continue;
      const p = trex.data;
      trexByTrack[readU32(u8, p + 4)] = {
        duration: readU32(u8, p + 12),
        size: readU32(u8, p + 16),
      };
    }
  }

  const moofs = top.filter((b) => b.type === 'moof');
  let samples = [];
  if (moofs.length) {
    samples = samplesFromMoofs(u8, moofs, picked.trackId, picked.timescale, trexByTrack);
  }
  if (!samples.length) {
    samples = samplesFromStbl(u8, picked.stbl, picked.timescale, { duration: 0, size: 0 });
  }
  if (!samples.length) throw new Error('오디오 샘플이 비어 있어요');

  // 빈 샘플 제거 + 시간순 정렬
  samples = samples.filter((s) => s.data && s.data.length && Number.isFinite(s.ts)).sort((a, b) => a.ts - b.ts);
  if (!samples.length) throw new Error('오디오 샘플이 비어 있어요');

  // 마지막 샘플에 길이가 없으면 앞 샘플들의 중간값으로 채운다.
  const durs = samples.map((s) => s.dur).filter((d) => d > 0).sort((a, b) => a - b);
  const med = durs.length ? durs[Math.floor(durs.length / 2)] : 0.021333;
  for (let i = 0; i < samples.length; i++) {
    if (!(samples[i].dur > 0)) {
      const next = samples[i + 1];
      samples[i].dur = next ? Math.max(0.001, next.ts - samples[i].ts) : med;
    }
  }
  return {
    codec: picked.codec,
    sampleRate: picked.sampleRate || picked.timescale,
    channels: picked.channels || 2,
    description: picked.description || null,
    samples,
  };
}

// ── MediaRecorder(오디오 전용) ─────────────────────────────
export function pickAudioRecorderMime() {
  if (typeof window === 'undefined' || typeof window.MediaRecorder !== 'function') return '';
  for (const m of AUDIO_MIMES) {
    try { if (window.MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* 다음 후보 */ }
  }
  return '';
}

export function audioRecorderSupported() {
  return !!pickAudioRecorderMime();
}

/**
 * 완성된 48kHz 믹스를 '소리만' 실시간 녹음한다. (영상 트랙 없음)
 * @returns {Promise<{blob:Blob, mime:string, intendedOffset:number}|null>}
 */
export async function recordAudioMp4(audioBuffer, opts = {}) {
  const { audioContext, onProgress } = opts;
  const mime = pickAudioRecorderMime();
  if (!mime || !audioBuffer) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = audioContext;
  let own = false;
  if (!ctx) { ctx = new AC({ sampleRate: audioBuffer.sampleRate }); own = true; }
  try { if (ctx.state !== 'running') await ctx.resume(); } catch (e) { /* 무시 */ }

  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(dest);

  let rec;
  try { rec = new window.MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 192000 }); }
  catch (e) { try { rec = new window.MediaRecorder(dest.stream); } catch (e2) { return null; } }

  const chunks = [];
  let recError = null;
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onerror = (e) => { recError = e; };

  const total = audioBuffer.duration;
  const lead = 0.06;                       // 녹음 시작과 소리 시작 사이 여유
  const t0 = ctx.currentTime + lead;
  try {
    rec.start(250);
    src.start(t0);
  } catch (e) {
    try { rec.stop(); } catch (e2) {}
    return null;
  }

  const endAt = t0 + total + 0.28;
  await new Promise((resolve) => {
    const tick = () => {
      if (recError) { resolve(); return; }
      const now = ctx.currentTime;
      if (onProgress) onProgress({ phase: 'audio-record', t: Math.min(total, Math.max(0, now - t0)), total });
      if (now >= endAt) { resolve(); return; }
      setTimeout(tick, 100);
    };
    tick();
  });

  try { src.stop(); } catch (e) { /* 이미 끝남 */ }
  try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { /* 무시 */ }
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 1500))]);
  if (own) { try { ctx.close(); } catch (e) {} }

  const blob = new Blob(chunks, { type: (rec && rec.mimeType) || mime });
  if (!blob.size) return null;
  return { blob, mime: blob.type || mime, intendedOffset: lead };
}

/**
 * 녹음된 소리에서 실제 '소리 시작' 지점을 찾는다(녹음 시작 지연 + AAC 프라이밍 보정).
 * 믹스 원본에서도 같은 방식으로 첫 소리 지점을 찾아 빼면, 조용한 인트로가 있어도
 * 녹음 타임라인이 믹스보다 얼마나 늦게 시작했는지(L)를 정확히 알 수 있다.
 * 실패하면 예상값(첫 샘플 + 예약 오프셋)을 돌려준다.
 */
export async function measureAudioStart(rec, audioContext, firstSampleTs, intendedOffset, mixFirstSound = null) {
  const expected = firstSampleTs + (intendedOffset || 0);
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = audioContext || new AC();
    const buf = await ctx.decodeAudioData(await rec.blob.arrayBuffer());
    const ch = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < ch.length; i += 13) peak = Math.max(peak, Math.abs(ch[i]));
    if (peak < 1e-4) return expected;
    const thr = Math.max(1e-4, peak * 0.02);
    let first = -1;
    for (let i = 0; i < ch.length; i += 16) {
      let m = 0;
      const e = Math.min(i + 16, ch.length);
      for (let j = i; j < e; j++) m = Math.max(m, Math.abs(ch[j]));
      if (m > thr) { first = i; break; }
    }
    if (first < 0) return expected;
    const lead = first / buf.sampleRate;
    if (mixFirstSound !== null && mixFirstSound !== undefined) {
      // 녹음 지연 L = (녹음에서 첫 소리) - (믹스에서 첫 소리)
      const latency = lead - mixFirstSound;
      if (latency > -0.15 && latency < 0.8) return firstSampleTs + latency;
    }
    if (lead > 0.002 && lead < 0.4) return firstSampleTs + lead;
    return expected;
  } catch (e) {
    return expected;
  }
}

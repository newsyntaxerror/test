// 오디오 디코딩 · 파형 · 목소리 구간 감지 · BPM 추정
// + ISO BMFF(MP4/MOV) 오디오 트랙 디먹서 — 아이폰 기본 동영상(.mov) 지원

export async function decodeMedia(ctx, arrayBuffer) {
  const ab = arrayBuffer.slice(0); // decodeAudioData가 버퍼를 detach 하므로 복사본 사용
  return await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve).catch(reject);
  });
}

// ──────────────────────────────────────────────────────────────
// ISO BMFF(QuickTime .mov / MP4) 오디오 트랙 디먹서
//  · decodeAudioData(파일 전체)가 실패하면 moov→trak→mdia→hdlr('soun')→minf→stbl을
//    해석해 오디오 샘플만 뽑아낸다. AAC는 ADTS 헤더 → 순수 AAC 스트림,
//    PCM(lpcm/sowt/twos…)은 WAV 헤더를 붙여 디코딩한다.
//  · File.slice() 로 moov와 오디오 샘플 구간만 읽어 100MB+ 영상도 메모리를 적게 쓴다.
// ──────────────────────────────────────────────────────────────

export class MediaDecodeError extends Error {
  constructor(code, userMessage, detail) {
    super(userMessage);
    this.name = 'MediaDecodeError';
    this.code = code;
    this.userMessage = userMessage;
    this.detail = detail || '';
  }
}

const DIRECT_DECODE_LIMIT = 48 * 1024 * 1024; // 이보다 크면 통째로 디코딩하지 않고 바로 디먹서 사용
const MOOV_LIMIT = 96 * 1024 * 1024;          // moov가 이보다 크면 처리 포기(비정상 파일)
const RUN_GAP = 96 * 1024;                     // 오디오 샘플 사이 빈 구간이 이보다 작으면 한 번에 읽는다
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf', 'wave', 'chan']);
const PCM_CODECS = new Set(['lpcm', 'sowt', 'twos', 'in24', 'in32', 'fl32', 'fl64', 'raw ', 'ulaw', 'alaw', 'ipcm', 'fpcm']);
const CODEC_NAMES = {
  mp4a: 'AAC', 'ac-3': 'AC-3', 'ec-3': 'E-AC-3', alac: 'Apple 무손실(ALAC)', opus: 'Opus', 'Opus': 'Opus',
  samr: 'AMR', sawb: 'AMR-WB', mp3: '.mp3', '.mp3': 'MP3', lpcm: 'PCM', sowt: 'PCM', twos: 'PCM',
  in24: 'PCM', in32: 'PCM', fl32: 'PCM', fl64: 'PCM', 'raw ': 'PCM', ulaw: 'PCM(μ-law)', alaw: 'PCM(A-law)',
};

function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function u64(b, o) { return u32(b, o) * 4294967296 + u32(b, o + 4); }
function f64(b, o) {
  const dv = new DataView(b.buffer, b.byteOffset + o, 8);
  return dv.getFloat64(0);
}
function tagOf(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

// 박스 목록 순회. fn이 false를 돌려주면 중단.
function eachBox(b, start, end, fn) {
  let p = start;
  let guard = 0;
  while (p + 8 <= end && guard++ < 500000) {
    let size = u32(b, p);
    const type = tagOf(b, p + 4);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(b, p + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < hdr || p + size > end) break;
    if (fn(type, p, p + hdr, p + size, type) === false) return;
    p += size;
  }
}

function childBox(b, start, end, type) {
  let found = null;
  eachBox(b, start, end, (t, boxStart, body, boxEnd) => {
    if (t === type) { found = { start: boxStart, body, end: boxEnd }; return false; }
  });
  return found;
}

function findBoxDeep(b, start, end, type, depth = 3) {
  let found = null;
  const walk = (s, e, d) => {
    if (found || d < 0) return;
    eachBox(b, s, e, (t, boxStart, body, boxEnd) => {
      if (found) return false;
      if (t === type) { found = { start: boxStart, body, end: boxEnd }; return false; }
      if (CONTAINER_BOXES.has(t)) walk(body, boxEnd, d - 1);
    });
  };
  walk(start, end, depth);
  return found;
}

async function readRange(blob, start, end) {
  const s = Math.max(0, Math.min(start, blob.size));
  const e = Math.max(s, Math.min(end, blob.size));
  if (typeof blob.slice === 'function') {
    const ab = await blob.slice(s, e).arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new MediaDecodeError('no-slice', '파일을 읽지 못했어요');
}

// 파일 앞에서부터 최상위 박스 헤더만 훑어 moov를 찾는다(대용량 파일도 헤더 읽기만).
async function readMoov(blob) {
  let p = 0;
  let guard = 0;
  while (p + 8 <= blob.size && guard++ < 4000) {
    const head = await readRange(blob, p, Math.min(blob.size, p + 16));
    if (head.length < 8) break;
    let size = u32(head, 0);
    const type = tagOf(head, 4);
    let hdr = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = u64(head, 8);
      hdr = 16;
    } else if (size === 0) {
      size = blob.size - p;
    }
    if (size < hdr) break;
    if (type === 'moov') {
      if (size > MOOV_LIMIT) throw new MediaDecodeError('moov-big', '영상 정보가 너무 커서 읽지 못했어요');
      const end = Math.min(blob.size, p + size);
      const buf = await readRange(blob, p, end);
      return { buf, offset: p, fragmented: false };
    }
    if (type === 'moof') return { buf: null, offset: p, fragmented: true };
    p += size;
  }
  return null;
}

// esds 안의 AudioSpecificConfig(AAC) 파싱
function parseEsdsAsc(b, esds) {
  const end = esds.end;
  let p = esds.body + 4; // version/flags
  const TAG = (q) => {
    if (q + 2 > end) return null;
    const tag = b[q];
    let r = q + 1, len = 0, n = 0;
    while (r < end && n++ < 4) {
      const v = b[r++];
      len = (len << 7) | (v & 0x7f);
      if (!(v & 0x80)) break;
    }
    return { tag, len, body: r, end: Math.min(end, r + len) };
  };
  let d = TAG(p);
  let guard = 0;
  while (d && d.tag !== 0x03 && d.tag !== 0x04 && d.tag !== 0x05 && guard++ < 8) {
    p = d.end;
    d = TAG(p);
  }
  if (!d) return null;
  if (d.tag === 0x05) return { asc: b.subarray(d.body, d.end) };
  if (d.tag === 0x03) {
    const flags = b[d.body + 2];
    let q = d.body + 3;
    if (flags & 0x80) q += 2;
    if (flags & 0x40) { if (q >= end) return null; q += 1 + b[q]; }
    if (flags & 0x20) q += 2;
    const dc = TAG(q);
    if (!dc || dc.tag !== 0x04) return null;
    const dsi = TAG(dc.body + 13); // objectTypeIndication(1)+streamType(1)+bufferSize(3)+maxBitrate(4)+avgBitrate(4)
    if (dsi && dsi.tag === 0x05) return { asc: b.subarray(dsi.body, dsi.end) };
    return null;
  }
  // 0x04가 먼저 나온 경우
  const dsi = TAG(d.body + 13);
  if (dsi && dsi.tag === 0x05) return { asc: b.subarray(dsi.body, dsi.end) };
  return null;
}

function parseAsc(asc) {
  if (!asc || asc.length < 2) return null;
  let aot = asc[0] >> 3;
  let sf = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  let ch = (asc[1] >> 3) & 0x0f;
  if (aot === 31 && asc.length > 2) aot = 32 + ((asc[0] & 7) << 3) + (asc[1] >> 5);
  return { aot, sf, ch };
}

// 샘플 테이블(stsc·stsz·stco/co64)로 오디오 샘플 위치/크기 목록을 만든다.
function buildSampleList(b, stbl) {
  const stsz = childBox(b, stbl.body, stbl.end, 'stsz');
  const stsc = childBox(b, stbl.body, stbl.end, 'stsc');
  const stco = childBox(b, stbl.body, stbl.end, 'stco');
  const co64 = stco ? null : childBox(b, stbl.body, stbl.end, 'co64');
  const chunks = stco || co64;
  if (!stsz || !stsc || !chunks) return null;

  const uniform = u32(b, stsz.body + 4);
  const count = u32(b, stsz.body + 8);
  if (!count || count > 20000000) return null;
  const sizes = new Uint32Array(count);
  if (uniform === 0) {
    for (let i = 0; i < count; i++) sizes[i] = u32(b, stsz.body + 12 + i * 4);
  } else {
    sizes.fill(uniform);
  }

  const chunkCount = u32(b, chunks.body + 4);
  if (!chunkCount || chunkCount > 20000000) return null;
  const chunkOffset = new Float64Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    chunkOffset[i] = stco ? u32(b, chunks.body + 8 + i * 4) : u64(b, chunks.body + 8 + i * 8);
  }

  const entryCount = u32(b, stsc.body + 4);
  const entries = [];
  for (let i = 0; i < Math.min(entryCount, 100000); i++) {
    const o = stsc.body + 8 + i * 12;
    entries.push({ first: u32(b, o), per: u32(b, o + 4) });
  }
  if (!entries.length) return null;

  const offsets = new Float64Array(count);
  let sample = 0;
  for (let e = 0; e < entries.length && sample < count; e++) {
    const cur = entries[e];
    const nextFirst = e + 1 < entries.length ? entries[e + 1].first : chunkCount + 1;
    for (let chunk = cur.first; chunk < nextFirst && chunk <= chunkCount && sample < count; chunk++) {
      let off = chunkOffset[chunk - 1];
      if (off === undefined) break;
      for (let k = 0; k < cur.per && sample < count; k++) {
        offsets[sample] = off;
        off += sizes[sample];
        sample++;
      }
    }
  }
  let total = 0;
  let last = 0;
  for (let i = 0; i < sample; i++) {
    total += sizes[i];
    last = Math.max(last, offsets[i] + sizes[i]);
  }
  return { count: sample, offsets, sizes, total, end: last };
}

// moov에서 오디오 트랙(hdlr 'soun') 하나를 찾아 설명·샘플 테이블을 뽑는다.
function parseAudioTrack(moovBuf) {
  let track = null;
  // 넘어온 버퍼는 moov 박스 자체이므로 본문 안의 trak을 순회한다.
  const root = childBox(moovBuf, 0, moovBuf.length, 'moov');
  const rootStart = root ? root.body : 0;
  const rootEnd = root ? root.end : moovBuf.length;
  eachBox(moovBuf, rootStart, rootEnd, (type, bs, body, be) => {
    if (track || type !== 'trak') return;
    const mdia = childBox(moovBuf, body, be, 'mdia');
    if (!mdia) return;
    const hdlr = childBox(moovBuf, mdia.body, mdia.end, 'hdlr');
    if (!hdlr || tagOf(moovBuf, hdlr.body + 8) !== 'soun') return;
    const minf = childBox(moovBuf, mdia.body, mdia.end, 'minf');
    if (!minf) return;
    const stbl = childBox(moovBuf, minf.body, minf.end, 'stbl');
    if (!stbl) return;
    const stsd = childBox(moovBuf, stbl.body, stbl.end, 'stsd');
    if (!stsd) return;

    const entryStart = stsd.body + 8;
    if (entryStart + 36 > stsd.end) return;
    const entrySize = u32(moovBuf, entryStart);
    const codec = tagOf(moovBuf, entryStart + 4);
    const entryEnd = Math.min(stsd.end, entryStart + entrySize);
    const p = entryStart + 8;
    const ver = u16(moovBuf, p + 8);
    let channels = u16(moovBuf, p + 16);
    let bits = u16(moovBuf, p + 18);
    let sampleRate = u32(moovBuf, p + 24) / 65536;
    let formatFlags = 0;
    let bytesPerFrame = 0;
    if (ver === 2 && p + 64 <= entryEnd) {
      sampleRate = f64(moovBuf, p + 32) || sampleRate;
      channels = u32(moovBuf, p + 40) || channels;
      bits = u32(moovBuf, p + 48) || bits;
      formatFlags = u32(moovBuf, p + 52);
      bytesPerFrame = u32(moovBuf, p + 56);
    }
    const childStart = Math.min(entryEnd, p + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0));

    let asc = null;
    const esds = findBoxDeep(moovBuf, childStart, entryEnd, 'esds', 3);
    if (esds) {
      const parsed = parseEsdsAsc(moovBuf, esds);
      if (parsed && parsed.asc) asc = parseAsc(parsed.asc);
    }

    const samples = buildSampleList(moovBuf, stbl);
    const mdhd = childBox(moovBuf, mdia.body, mdia.end, 'mdhd');
    let timescale = 0;
    if (mdhd) timescale = moovBuf[mdhd.body] === 1 ? u32(moovBuf, mdhd.body + 20) : u32(moovBuf, mdhd.body + 12);

    track = {
      codec,
      fragmented: !!childBox(moovBuf, rootStart, rootEnd, 'mvex'),
      ver,
      channels: channels || (asc && asc.ch),
      bits: bits || 16,
      sampleRate: sampleRate || (asc && ADTS_RATES[asc.sf]) || 0,
      asc,
      formatFlags,
      bytesPerFrame,
      timescale,
      samples,
      boxes: {
        tkhd: childBox(moovBuf, body, be, 'tkhd'),
        mdhd,
        hdlr,
        smhd: childBox(moovBuf, minf.body, minf.end, 'smhd'),
        dinf: childBox(moovBuf, minf.body, minf.end, 'dinf'),
        stsd,
        stts: childBox(moovBuf, stbl.body, stbl.end, 'stts'),
        stsz: childBox(moovBuf, stbl.body, stbl.end, 'stsz'),
      },
    };
  });
  if (!track) return null;
  return track;
}

function codecLabel(codec) {
  return CODEC_NAMES[codec] || codec;
}

// 샘플 구간을 읽어 ADTS(AAC) 스트림을 만든다.
async function buildAdtsStream(blob, samples, asc, onProgress) {
  const { count, offsets, sizes, total } = samples;
  const sf = asc && asc.sf >= 0 && asc.sf <= 12 ? asc.sf : 4;
  const channels = Math.max(1, Math.min(7, (asc && asc.ch) || 2));
  const aot = asc && asc.aot > 0 && asc.aot <= 4 ? asc.aot : 2;
  const profile = aot - 1;
  const out = new Uint8Array(total + count * 7);
  const runs = mergeRuns(samples);
  let written = 0;
  let pos = 0;
  for (const run of runs) {
    const buf = await readRange(blob, run.start, run.end);
    for (const i of run.items) {
      const size = sizes[i];
      if (!size) continue;
      const rel = offsets[i] - run.start;
      if (rel < 0 || rel + size > buf.length) continue;
      const len = size + 7;
      out[pos] = 0xff;
      out[pos + 1] = 0xf1;
      out[pos + 2] = ((profile & 3) << 6) | ((sf & 0x0f) << 2) | ((channels >> 2) & 1);
      out[pos + 3] = ((channels & 3) << 6) | ((len >> 11) & 3);
      out[pos + 4] = (len >> 3) & 0xff;
      out[pos + 5] = ((len & 7) << 5) | 0x1f;
      out[pos + 6] = 0xfc;
      out.set(buf.subarray(rel, rel + size), pos + 7);
      pos += len;
      written++;
    }
    if (onProgress) onProgress(run.end / Math.max(1, samples.end));
  }
  if (!written) return null;
  return pos === out.length ? out : out.subarray(0, pos);
}

function mergeRuns(samples) {
  const { count, offsets, sizes } = samples;
  const runs = [];
  let cur = null;
  for (let i = 0; i < count; i++) {
    const size = sizes[i];
    if (!size) continue;
    const off = offsets[i];
    if (cur && off >= cur.start && off - cur.end <= RUN_GAP) {
      cur.end = Math.max(cur.end, off + size);
      cur.items.push(i);
    } else {
      cur = { start: off, end: off + size, items: [i] };
      runs.push(cur);
    }
  }
  return runs;
}

// 샘플 구간을 읽어 WAV(비압축 PCM) 스트림을 만든다.
async function buildWavStream(blob, samples, track, onProgress) {
  const { count, offsets, sizes, total } = samples;
  const channels = Math.max(1, Math.min(8, track.channels || 1));
  let bits = track.bits || 16;
  if (![8, 16, 24, 32].includes(bits)) bits = 16;
  const byteOrderLittle = track.codec !== 'twos' && !(track.formatFlags & 2);
  const isFloat = track.codec === 'fl32' || track.codec === 'fl64' || !!(track.formatFlags & 1);
  const bytesPerSample = bits / 8;
  let dataLen = total;
  // WAV는 인터리브 PCM만 담는다. 샘플 하나가 채널 프레임 경계와 맞지 않으면 잘라낸다.
  const block = channels * bytesPerSample;
  dataLen = Math.floor(dataLen / block) * block;

  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const w = (s, o) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  w('RIFF', 0);
  dv.setUint32(4, 36 + dataLen, true);
  w('WAVE', 8);
  w('fmt ', 12);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, isFloat ? 3 : 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, track.sampleRate || 44100, true);
  dv.setUint32(28, (track.sampleRate || 44100) * block, true);
  dv.setUint16(32, block, true);
  dv.setUint16(34, bits, true);
  w('data', 36);
  dv.setUint32(40, dataLen, true);

  const runs = mergeRuns(samples);
  let pos = 44;
  let swap = bits === 16 && !byteOrderLittle;
  let swap4 = bits === 32 && !byteOrderLittle;
  for (const run of runs) {
    if (pos >= out.length) break;
    const buf = await readRange(blob, run.start, run.end);
    for (const i of run.items) {
      const size = sizes[i];
      if (!size || pos >= out.length) continue;
      const rel = offsets[i] - run.start;
      if (rel < 0 || rel + size > buf.length) continue;
      const room = Math.min(size, out.length - pos);
      if (swap || swap4) {
        const step = swap ? 2 : 4;
        for (let k = 0; k + step <= room; k += step) {
          for (let j = 0; j < step; j++) out[pos + k + j] = buf[rel + k + step - 1 - j];
        }
      } else {
        out.set(buf.subarray(rel, rel + room), pos);
      }
      pos += room;
    }
    if (onProgress) onProgress(run.end / Math.max(1, samples.end));
  }
  return pos === out.length ? out : out.subarray(0, 44 + Math.floor((pos - 44) / block) * block);
}

// ── AAC를 감싼 최소 MP4 만들기 (ADTS 디코딩이 실패할 때의 2차 수단) ──
function mkBox(type, parts) {
  let len = 8;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

function sliceBox(moovBuf, box) {
  return moovBuf.subarray(box.start, box.end);
}

async function buildAudioOnlyMp4(blob, samples, track, moovBuf, onProgress) {
  const { count, offsets, sizes, total } = samples;
  const boxed = track.boxes;
  if (!boxed.stsd || !boxed.stts || !boxed.stsz || !boxed.mdhd || !boxed.hdlr || !boxed.tkhd || !boxed.dinf || !boxed.smhd) return null;
  const mvhd = childBox(moovBuf, (childBox(moovBuf, 0, moovBuf.length, 'moov') || { body: 0 }).body, moovBuf.length, 'mvhd');
  if (!mvhd) return null;

  const data = new Uint8Array(total);
  const runs = mergeRuns(samples);
  let pos = 0;
  for (const run of runs) {
    const buf = await readRange(blob, run.start, run.end);
    for (const i of run.items) {
      const size = sizes[i];
      if (!size) continue;
      const rel = offsets[i] - run.start;
      if (rel < 0 || rel + size > buf.length) continue;
      data.set(buf.subarray(rel, rel + size), pos);
      pos += size;
    }
    if (onProgress) onProgress(run.end / Math.max(1, samples.end));
  }

  // stsc: 한 샘플 = 한 청크
  const stscBody = new Uint8Array(8 + 12);
  const sv = new DataView(stscBody.buffer);
  sv.setUint32(0, 0);            // version/flags
  sv.setUint32(4, 1);            // entry_count
  sv.setUint32(8, 1);            // first_chunk
  sv.setUint32(12, 1);           // samples_per_chunk
  sv.setUint32(16, 1);           // sample_description_index
  const stscBox = mkBox('stsc', [stscBody]);

  const useCo64 = total > 0xffffffff;
  const stcoBoxLen = 8 + 8 + (useCo64 ? count * 8 : count * 4);
  const stsdLen = sliceBox(moovBuf, boxed.stsd).length;
  const sttsLen = sliceBox(moovBuf, boxed.stts).length;
  const stszLen = sliceBox(moovBuf, boxed.stsz).length;
  const stblLen = 8 + stsdLen + sttsLen + stscBox.length + stszLen + stcoBoxLen;
  const minfLen = 8 + sliceBox(moovBuf, boxed.smhd).length + sliceBox(moovBuf, boxed.dinf).length + stblLen;
  const mdiaLen = 8 + sliceBox(moovBuf, boxed.mdhd).length + sliceBox(moovBuf, boxed.hdlr).length + minfLen;
  const trakLen = 8 + sliceBox(moovBuf, boxed.tkhd).length + mdiaLen;
  const moovLen = 8 + sliceBox(moovBuf, mvhd).length + trakLen;

  const ftyp = mkBox('ftyp', [new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d])]);
  const mdatStart = ftyp.length + moovLen + 8;

  const stcoBody = new Uint8Array(8 + (useCo64 ? count * 8 : count * 4));
  const cv = new DataView(stcoBody.buffer);
  cv.setUint32(0, 0);
  cv.setUint32(4, count);
  let off = mdatStart;
  for (let i = 0; i < count; i++) {
    if (useCo64) {
      const hi = Math.floor(off / 4294967296);
      cv.setUint32(8 + i * 8, hi);
      cv.setUint32(12 + i * 8, off >>> 0);
    } else {
      cv.setUint32(8 + i * 4, off >>> 0);
    }
    off += sizes[i];
  }
  const stcoBox = mkBox(useCo64 ? 'co64' : 'stco', [stcoBody]);

  const stbl = mkBox('stbl', [sliceBox(moovBuf, boxed.stsd), sliceBox(moovBuf, boxed.stts), stscBox, sliceBox(moovBuf, boxed.stsz), stcoBox]);
  const minf = mkBox('minf', [sliceBox(moovBuf, boxed.smhd), sliceBox(moovBuf, boxed.dinf), stbl]);
  const mdia = mkBox('mdia', [sliceBox(moovBuf, boxed.mdhd), sliceBox(moovBuf, boxed.hdlr), minf]);
  const trak = mkBox('trak', [sliceBox(moovBuf, boxed.tkhd), mdia]);
  const moov = mkBox('moov', [sliceBox(moovBuf, mvhd), trak]);
  const mdat = mkBox('mdat', [data]);

  if (stbl.length !== stblLen || moov.length !== moovLen) {
    // 길이 계산이 어긋나면 조용히 포기(ADTS 결과를 그대로 사용)
    return null;
  }
  const out = new Uint8Array(ftyp.length + moov.length + mdat.length);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  out.set(mdat, ftyp.length + moov.length);
  return out;
}

// 파일(Blob)에서 오디오만 뽑아 디코딩한다. 실패하면 MediaDecodeError.
export async function decodeMediaFile(ctx, file, onProgress) {
  const report = (p, msg) => { if (onProgress) onProgress(p, msg); };
  let directErr = null;

  if (file.size <= DIRECT_DECODE_LIMIT) {
    report(0.02, '오디오를 읽는 중…');
    try {
      const buffer = await decodeMedia(ctx, await file.arrayBuffer());
      return buffer;
    } catch (e) {
      directErr = e;
    }
  }

  // ISO BMFF(QuickTime .mov / MP4)인지 확인
  let head = null;
  try { head = await readRange(file, 0, Math.min(file.size, 16)); } catch (e) { /* 무시 */ }
  const sniff = head && head.length >= 8 ? tagOf(head, 4) : '';
  const isBmff = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'jP  '].includes(sniff);
  if (!isBmff) {
    const ext = (file.name.split('.').pop() || '').toUpperCase();
    throw new MediaDecodeError(
      'not-bmff',
      `${ext || '이'} 파일은 브라우저가 오디오를 읽지 못해요`,
      directErr ? String(directErr) : ''
    );
  }

  report(0.04, '아이폰 영상에서 오디오만 뽑는 중…');
  const moov = await readMoov(file);
  if (!moov) throw new MediaDecodeError('no-moov', '영상 구조(moov)를 찾지 못했어요', directErr ? String(directErr) : '');
  if (moov.fragmented) throw new MediaDecodeError('fragmented', '조각난 MP4(fMP4)는 아직 지원하지 않아요', '');

  const track = parseAudioTrack(moov.buf);
  if (!track) throw new MediaDecodeError('no-audio', '이 영상에는 오디오 트랙이 없어요', '');
  if (!track.samples || !track.samples.count) {
    if (track.fragmented) throw new MediaDecodeError('fragmented', '조각난 MP4(fMP4)는 아직 지원하지 않아요', '');
    throw new MediaDecodeError('no-samples', '오디오 샘플을 찾지 못했어요', '');
  }

  const label = codecLabel(track.codec);
  const isAac = track.codec === 'mp4a';
  const isPcm = PCM_CODECS.has(track.codec);

  if (!isAac && !isPcm) {
    throw new MediaDecodeError('codec', `이 소리는 ${label}라서 브라우저가 못 읽어요`, `codec=${track.codec}`);
  }

  let stream = null;
  try {
    if (isAac) {
      stream = await buildAdtsStream(file, track.samples, track.asc, (p) => report(0.1 + p * 0.6, '오디오만 뽑는 중…'));
      if (!stream) throw new MediaDecodeError('empty', '오디오 데이터가 비어 있어요', '');
      try {
        return await decodeMedia(ctx, stream.buffer.slice(stream.byteOffset, stream.byteOffset + stream.byteLength));
      } catch (e) {
        // ADTS를 못 읽는 브라우저 → 최소 MP4로 다시 담아 한 번 더 시도
        const mp4 = await buildAudioOnlyMp4(file, track.samples, track, moov.buf, (p) => report(0.7 + p * 0.2, '다시 담는 중…'));
        if (mp4) {
          try {
            return await decodeMedia(ctx, mp4.buffer);
          } catch (e2) { directErr = e2; }
        }
        throw new MediaDecodeError('aac-decode', `${label} 소리를 풀지 못했어요`, `${e && e.message} / ${directErr && directErr.message}`);
      }
    }
    if (isPcm) {
      stream = await buildWavStream(file, track.samples, track, (p) => report(0.1 + p * 0.7, '오디오만 뽑는 중…'));
      if (!stream) throw new MediaDecodeError('empty', '오디오 데이터가 비어 있어요', '');
      return await decodeMedia(ctx, stream.buffer.slice(stream.byteOffset, stream.byteOffset + stream.byteLength));
    }
  } catch (e) {
    if (e instanceof MediaDecodeError) throw e;
    throw new MediaDecodeError('demux', `영상에서 오디오를 뽑지 못했어요(${label})`, String(e && e.message || e));
  }
  throw new MediaDecodeError('codec', `이 소리는 ${label}라서 브라우저가 못 읽어요`, `codec=${track.codec}`);
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

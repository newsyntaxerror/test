// 타임라인 설계 — 구간(파트) · 목소리 배치 · 자동 비트싱크 컷(샷) 목록

export const SECTION_KINDS = {
  intro: { label: '인트로', tag: 'INTRO' },
  drop: { label: '드롭', tag: 'DROP' },
  break: { label: '브레이크', tag: 'BREAK' },
  outro: { label: '아웃트로', tag: 'OUTRO' },
};

let uid = 1;
export const newSection = (kind = 'drop', beats = 4, extra = {}) => ({
  id: 's' + uid++ + '-' + Math.random().toString(36).slice(2, 6),
  kind,
  beats,
  voice: kind !== 'intro' && kind !== 'outro',
  beat: true,
  ...extra,
});

// beats = 4분음표 박 수 (UI의 '마디'는 beats/4)
export function defaultSections() {
  return [
    newSection('intro', 8, { voice: false }),
    newSection('drop', 16, { voice: true }),
    newSection('break', 8, { voice: true, beat: false }),
    newSection('drop', 16, { voice: true }),
  ];
}

export function labelFor(sections, index) {
  const s = sections[index];
  const kind = SECTION_KINDS[s.kind] || SECTION_KINDS.drop;
  if (s.kind === 'drop') {
    const n = sections.slice(0, index + 1).filter((x) => x.kind === 'drop').length;
    return n === 1 ? '1차 드롭' : n === 2 ? '2차 드롭' : `${n}차 드롭`;
  }
  return kind.label;
}

// sections(마디 beats) → 실제 초 타임라인
// beats가 0 이하인 구간(예: 인트로 없이 바로 하이라이트)은 타임라인에서 길이 0으로 둔다.
export function layoutSections(sections, bpm) {
  const beat = 60 / bpm;
  let t = 0;
  return sections.map((s, i) => {
    const dur = s.beats <= 0 ? 0 : Math.max(0.5, s.beats) * beat;
    const o = { ...s, index: i, start: +t.toFixed(4), dur: +dur.toFixed(4), end: +(t + dur).toFixed(4), label: labelFor(sections, i) };
    t += dur;
    return o;
  });
}

export function totalBeats(sections) {
  return sections.reduce((a, s) => a + (s.beats > 0 ? Math.max(0.5, s.beats) : 0), 0);
}

// 목표 길이(초)에 맞춰 구간 길이를 비율 배분 (마디=4박 단위, 짧으면 2박 단위)
export function fitToSeconds(sections, bpm, targetSec) {
  const beat = 60 / bpm;
  const targetBeats = Math.max(2, targetSec / beat);
  const unit = targetBeats >= 10 ? 4 : 2;          // 4박(1마디) / 2박(반마디)
  const total = Math.max(unit, Math.round(targetBeats / unit) * unit);
  const cur = totalBeats(sections) || 1;
  const out = sections.map((s) => ({
    ...s,
    beats: Math.max(unit, Math.round((Math.max(0.5, s.beats) / cur) * total / unit) * unit),
  }));
  let sum = out.reduce((a, s) => a + s.beats, 0);
  let guard = 0;
  while (sum !== total && guard++ < 300) {
    const diff = total - sum;
    const dir = diff > 0 ? 1 : -1;
    const idx = out
      .map((s, i) => ({ i, b: s.beats }))
      .filter((x) => (dir > 0 ? true : x.b - unit >= unit))
      .sort((a, b) => (dir > 0 ? a.b - b.b : b.b - a.b))[0];
    if (!idx) break;
    out[idx.i].beats += dir * unit;
    sum += dir * unit;
  }
  return out;
}

const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
const clampNum = (v, a, b, fallback = a) => Math.max(a, Math.min(b, num(v, fallback)));

// ── 가져온 음원 모드의 옹알이 리믹스 패턴 (v1.5) ─────────────────────
// 내장 신스처럼 "비트에 맞춰 썰린" 느낌을 내기 위해, 구간 종류별로
//  · 드롭: 1·3박 → 한 박씩 → 마지막 1마디 8분음표 하이퍼 스터터
//  · 브레이크: 한 마디에 길게 하나
//  · 인트로/아웃트로: 시작 한 번 + (다음이 드롭이면) 마지막 마디 빌드업 스터터
// 로 배치한다. 조각은 항상 슬롯 길이 안에서 잘라 써서 원본이 통으로 흐르지 않는다.
function remixPattern(segs, sections, beat, rate) {
  const out = [];
  if (!segs.length) return out;
  const byLen = segs.slice().sort((a, b) => (a.end - a.start) - (b.end - b.start));
  const shortest = byLen[0];
  const longest = byLen[byLen.length - 1];
  let cursor = 0;
  const pick = (maxDur) => {
    const maxSrc = Math.max(0.08, maxDur * rate);
    for (let k = 0; k < segs.length; k++) {
      const s = segs[(cursor + k) % segs.length];
      if (s.end - s.start <= maxSrc) { cursor += k + 1; return s; }
    }
    cursor++;
    return segs[(cursor - 1) % segs.length];
  };
  const put = (seg, t, maxDur, tag) => {
    if (!seg) return;
    const len = Math.min(seg.end - seg.start, Math.max(0.08, maxDur * rate));
    out.push({ seg, tStart: t, len, id: `p${seg.id}-${tag}-${out.length}` });
  };
  const bar = beat * 4;
  sections.forEach((sec, si) => {
    if (!sec.voice || sec.dur <= 0.1) return;
    const next = sections[si + 1];
    const lastBar = sec.dur > bar * 1.4 ? sec.start + sec.dur - bar : sec.start;
    if (sec.kind === 'drop') {
      const half = sec.start + (lastBar - sec.start) / 2;
      let t = sec.start;
      let guard = 0;
      while (t < lastBar - 0.03 && guard++ < 200) {
        const step = t < half ? beat * 2 : beat;
        put(pick(beat * 0.85), t, beat * 0.85, 'd');
        t += step;
      }
      // 마지막 마디: 짧은 조각을 8분음표로 하이퍼 반복
      let k = 0;
      while (lastBar + (k * beat) / 2 < sec.end - 0.03 && k < 16) {
        put(shortest, lastBar + (k * beat) / 2, beat * 0.45, 'h' + k);
        k++;
      }
    } else if (sec.kind === 'break') {
      let t = sec.start;
      while (t < sec.end - 0.06) {
        put(pick(beat * 3.4) || longest, t, beat * 3.4, 'b');
        t += bar;
      }
    } else {
      put(pick(beat * 1.6) || longest, sec.start, beat * 1.6, 'i');
      if (next && next.kind === 'drop') {
        let k = 0;
        while (lastBar + (k * beat) / 2 < sec.end - 0.03 && k < 16) {
          put(shortest, lastBar + (k * beat) / 2, beat * 0.45, 'u' + k);
          k++;
        }
      }
    }
  });
  return out;
}

// 전체 편곡 만들기
export function buildArrangement(S) {
  const bpm = S.bpm || 140;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const sections = layoutSections(S.sections, bpm);
  const total = sections.length ? sections[sections.length - 1].end : 0;
  const rate = Math.max(0.5, Math.min(2, S.mix.pitch || 1));

  // ── 목소리 구간 배치 ─────────────────────────────────
  const segs = (S.voice && S.voice.segments ? S.voice.segments : []).filter((s) => s.on && s.end - s.start > 0.04);
  const byId = new Map(segs.map((s) => [s.id, s]));
  const vTrack = S.voiceTrack || {};
  const vOffset = clampNum(vTrack.offset, -2, 6, 0);
  const vVol = clampNum(vTrack.vol, 0, 1.5, 1);
  const voiceEvents = [];

  // v1.5: 타임라인에서 손으로 옮긴 조각(voiceClips)이 있으면 그 배치를 그대로 쓴다.
  //        없으면 기존 자동 배치(구간·박자 슬롯 채우기)를 쓴다.
  const pushEvent = (seg, tStart, len, gain, id) => {
    const srcLen = seg.end - seg.start;
    const useLen = Math.max(0.04, Math.min(srcLen, num(len, srcLen)));
    const dur = useLen / rate;
    if (tStart < -0.001 || tStart >= total - 0.02) return;
    voiceEvents.push({
      id,
      segId: seg.id,
      tStart: +Math.max(0, tStart).toFixed(4),
      tEnd: +(Math.max(0, tStart) + dur).toFixed(4),
      bufStart: seg.start,
      bufEnd: +(seg.start + useLen).toFixed(4),
      rate,
      gain: clampNum(gain, 0, 1.5, 1),
      sectionKind: (sections.find((s) => tStart >= s.start && tStart < s.end) || {}).kind,
    });
  };

  const manual = Array.isArray(S.voiceClips) ? S.voiceClips : null;
  let matched = 0;
  if (manual) {
    manual.forEach((c, k) => {
      const seg = byId.get(c && c.segId);
      if (!seg) return;
      matched++;
      pushEvent(seg, num(c.at, 0) + vOffset, c.len, c.vol, c.id || 'c' + k);
    });
  }
  // 손으로 만든 배치가 이 영상의 구간과 하나도 맞지 않으면(다른 영상·재분석) 자동 배치로 돌아간다.
  if (!manual || (manual.length > 0 && matched === 0 && segs.length > 0)) {
    if (segs.length) {
      if (S.beatMode === 'file' && S.remixPattern !== false) {
        // v1.5: 가져온 음원 모드 — 노래의 박자 그리드에 맞춰 옹알이를 리듬 있게 썰어 넣는다.
        for (const p of remixPattern(segs, sections, beat, rate)) {
          pushEvent(p.seg, p.tStart, p.len, 1, p.id);
        }
      } else {
        let cursor = 0;
        for (const sec of sections) {
          if (!sec.voice) continue;
          let t = sec.start;
          let guard = 0;
          while (guard++ < 400) {
            const seg = segs[cursor % segs.length];
            const dur = (seg.end - seg.start) / rate;
            if (t + dur > sec.end + 0.02) break;
            const slotBeats = Math.max(1, Math.ceil(dur / beat - 0.02));
            pushEvent(seg, t, seg.end - seg.start, 1, `a${seg.id}-${cursor}`);
            t += slotBeats * beat;
            cursor++;
          }
        }
      }
    }
  }

  // ── 비트/배경 음원 트랙 (v1.5) ───────────────────────
  //  시작 지점 · 사용 길이 · 볼륨 · 페이드 인/아웃을 타임라인에서 직접 조절한 값을 그대로 쓴다.
  const bt = S.beatTrack || {};
  const beatStart = clampNum(bt.start, 0, Math.max(0, total - 0.2), 0);
  const lenRaw = num(bt.len, 0);
  let beatEnd = lenRaw > 0.05 ? Math.min(total, beatStart + lenRaw) : total;
  if (beatEnd <= beatStart + 0.02) beatEnd = total;
  const beatTrack = {
    start: +beatStart.toFixed(4),
    end: +beatEnd.toFixed(4),
    len: +(beatEnd - beatStart).toFixed(4),
    vol: clampNum(bt.vol, 0, 1.5, 1),
    fadeIn: clampNum(bt.fadeIn, 0, 5, 0),
    fadeOut: clampNum(bt.fadeOut, 0, 5, 0),
    srcOffset: clampNum(bt.srcOffset, 0, 30, 0),
  };

  // ── 자동 비트싱크 영상 컷 ────────────────────────────
  const shots = [];
  const vDur = Math.max(0.2, S.videoDur || 0);
  const fitMode = S.fitMode === 'beatcut' ? 'beatcut' : 'smooth';
  if (fitMode === 'smooth') {
    // 1배속 부드럽게: 원본 속도(1.0x) 그대로 이어 재생하고, 모자란 길이는 자연 루프로 채운다.
    shots.push(...buildSmoothShots(sections, total, vDur));
  } else if (!S.autoEdit) {
    shots.push({ tStart: 0, tEnd: total, srcStart: 0, continuous: true });
  } else {
    const pool = (S.voice && S.voice.segments ? S.voice.segments : [])
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((s) => Math.max(0, s.start - 0.12));
    const fallback = [];
    for (let i = 0; i < 8; i++) fallback.push((vDur * i) / 8 + 0.01);
    const src = pool.length ? pool : fallback;
    const cutSec = Math.max(0.4, (S.cutBeats || 4) * beat);
    let k = 0;
    for (const sec of sections) {
      const isBreak = sec.kind === 'break';
      if (isBreak) {
        // 브레이크다운은 컷 없이 자연스럽게 재생
        const dur = sec.dur;
        const start = pickSource(src, k++, vDur, dur);
        shots.push({ tStart: sec.start, tEnd: sec.end, srcStart: start, continuous: true, slow: true });
        continue;
      }
      let t = sec.start;
      let guard = 0;
      while (t < sec.end - 0.02 && guard++ < 300) {
        const dur = Math.min(cutSec, sec.end - t);
        const start = pickSource(src, k++, vDur, dur);
        shots.push({ tStart: +t.toFixed(4), tEnd: +(t + dur).toFixed(4), srcStart: start });
        t += dur;
      }
    }
  }

  return {
    bpm, beat, bar, total, sections, voiceEvents, shots, fitMode, beatTrack,
    voiceTrack: { offset: vOffset, vol: vVol },
    beatPlan: sections.map((s) => ({ start: s.start, dur: s.dur, kind: s.kind, beatOn: !!s.beat })),
    cutCount: shots.filter((s) => !s.continuous).length,
  };
}

// 1배속 연속 재생 샷 — 원본을 1.0x로 죽 이어 재생하고, 영상이 짧으면
// 엘리먼트 루프로 처음부터 자연스럽게 다시 이어진다(슬로우모션 없음).
// 드롭에 들어갈 때만 시작점을 0으로 되돌려 비트에 맞춘다(1배속 유지).
function buildSmoothShots(sections, total, vDur) {
  const shots = [];
  if (!(total > 0.05) || !(vDur > 0.05)) return shots;
  let runStart = 0;
  let runSrc = 0;
  const flush = (endT) => {
    if (endT - runStart > 0.06) {
      shots.push({
        tStart: +runStart.toFixed(4),
        tEnd: +endT.toFixed(4),
        srcStart: +runSrc.toFixed(3),
        continuous: true,
        smooth: true,
      });
    }
  };
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    if (sec.dur <= 0.02) continue;
    if (i > 0 && sec.kind === 'drop' && sec.start > 0.02) {
      flush(sec.start);   // 직전까지 1배속으로 재생한 뒤
      runStart = sec.start;
      runSrc = 0;         // 드롭은 영상 처음부터 (비트에 맞춘 재시작)
    }
  }
  flush(total);
  return shots;
}

function permute(n, seed) {
  const arr = Array.from({ length: n }, (_, i) => i);
  let s = (seed * 9301 + 49297) % 233280;
  for (let i = n - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

function pickSource(pool, i, vDur, dur) {
  const n = pool.length;
  if (!n) return 0;
  // 한 바퀴마다 소스 순서를 섞어 같은 컷이 반복되지 않게
  const cycle = Math.floor(i / n);
  const order = permute(n, cycle + 1);
  const idx = order[i % n];
  let start = pool[idx] || 0;
  // 같은 구간을 다시 쓸 때는 살짝 다른 지점부터
  if (cycle > 0) start += Math.min(0.35, 0.08 * (cycle % 4));
  if (vDur > 0) {
    if (dur >= vDur) start = start % Math.max(0.2, vDur - 0.2);
    else start = Math.min(start, Math.max(0, vDur - dur - 0.03));
  }
  return +start.toFixed(3);
}

export function fmtSec(t, digits = 1) {
  if (!isFinite(t)) return '0.0';
  return t.toFixed(digits);
}

export function fmtClock(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

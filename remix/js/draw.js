// Canvas 장면 렌더러 — Ver.1 / 풀스크린 / 화이트 미니멀 / 클럽 네온 + 사용자 포맷
export const W = 1080, H = 1920;

const FONT = 'Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif';

const assets = { cat: null, dog: null, custom: null };
let fontReady = false;

function loadImage(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

export async function loadAssets() {
  const [cat, dog] = await Promise.all([loadImage('assets/daini-cat.jpg'), loadImage('assets/daini-dog.jpg')]);
  assets.cat = cat; assets.dog = dog;
  try {
    if (document.fonts && document.fonts.load) {
      await document.fonts.load(`800 100px Pretendard`);
      fontReady = document.fonts.check(`800 100px Pretendard`);
    }
  } catch (e) { fontReady = false; }
  return assets;
}

export function setCustomLogo(img) { assets.custom = img; }
export function getLogoImage(key) {
  if (key === 'dog') return assets.dog;
  if (key === 'custom') return assets.custom;
  if (key === 'none') return null;
  return assets.cat;
}

const font = (size, weight = 800) => `${weight} ${Math.round(size)}px ${FONT}`;

// *강조* 표시 파싱
function runs(text, baseColor, accentColor) {
  const out = [];
  let buf = '';
  let accent = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '*') {
      if (buf) out.push({ text: buf, color: accent ? accentColor : baseColor });
      buf = '';
      accent = !accent;
      while (s[i + 1] === '*') i++; // ** 도 한 번만 토글
    } else buf += ch;
  }
  if (buf) out.push({ text: buf, color: accent ? accentColor : baseColor });
  return out;
}
const plain = (t) => String(t || '').replace(/\*/g, '');

function lineMetrics(c, text, size) {
  c.font = font(size);
  const m = c.measureText(plain(text) || ' ');
  const asc = m.actualBoundingBoxAscent || size * 0.78;
  const desc = m.actualBoundingBoxDescent || size * 0.22;
  return { w: m.width, asc, desc, h: asc + desc };
}

function fitLines(c, lines, maxW, maxH, gap, scale = 1, start = 178) {
  for (let size = Math.round(start * scale); size >= 26; size -= 2) {
    let w = 0, h = 0;
    lines.forEach((l, i) => {
      const m = lineMetrics(c, l, size);
      w = Math.max(w, m.w);
      h += m.h + (i ? gap : 0);
    });
    if (w <= maxW && h <= maxH) return size;
  }
  return 26;
}

function drawLines(c, lines, size, cx, top, gap, maxW) {
  let y = top;
  for (const line of lines) {
    const m = lineMetrics(c, line, size);
    c.font = font(size);
    const rs = runs(line, c.__baseColor, c.__accentColor);
    const totalW = rs.reduce((a, r) => a + c.measureText(r.text).width, 0);
    let x = cx - totalW / 2;
    for (const r of rs) {
      c.fillStyle = r.color;
      c.fillText(r.text, x, y + m.asc);
      x += c.measureText(r.text).width;
    }
    y += m.h + gap;
  }
  return y - gap;
}

function modeLayout(fmt) {
  const box = fmt.box || { x: 70, y: 470, w: 940, h: 1000 };
  if (fmt.mode === 'full') {
    return {
      video: { x: 0, y: 0, w: W, h: H },
      radius: 0,
      title: { inkBottom: 372, maxW: 930, maxH: 300, overlay: true, gap: 10 },
      badge: { cy: 1772, scale: 0.78 },
      vignette: true,
    };
  }
  if (fmt.mode === 'neon') {
    return {
      video: box,
      radius: 18,
      title: { inkBottom: box.y - 34, maxW: box.w * 0.94, maxH: 260, overlay: false, gap: 8 },
      badge: { cy: box.y + box.h + 96, scale: 0.9 },
      trackLabel: true,
      vignette: false,
    };
  }
  return {
    video: box,
    radius: fmt.mode === 'cream' ? 26 : 0,
    title: { inkBottom: box.y - 28, maxW: Math.min(box.w * 0.9, 900), maxH: 240, overlay: false, gap: 8 },
    badge: { cy: box.y + box.h + 88, scale: 1 },
    vignette: false,
  };
}

function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function drawVideoCover(c, el, box, zoom = 1, fitY = 0.42, radius = 0, opts = {}) {
  const dx = opts.dx || 0, dy = opts.dy || 0;
  c.save();
  if (radius) { roundRect(c, box.x, box.y, box.w, box.h, radius); c.clip(); }
  else { c.beginPath(); c.rect(box.x, box.y, box.w, box.h); c.clip(); }
  if (el && (el.videoWidth || el.videoHeight)) {
    const vw = el.videoWidth, vh = el.videoHeight;
    const ar = box.w / box.h;
    let sw = vw, sh = vw / ar;
    if (sh > vh) { sh = vh; sw = vh * ar; }
    sw /= zoom; sh /= zoom;
    const sx = Math.max(0, Math.min(vw - sw, (vw - sw) / 2));
    const maxSy = Math.max(0, vh - sh);
    const sy = maxSy * Math.max(0, Math.min(1, fitY));
    const gx = box.x + dx, gy = box.y + dy;
    c.drawImage(el, sx, sy, sw, sh, gx, gy, box.w, box.h);
    applyColorFx(c, el, box, sx, sy, sw, sh, gx, gy, opts.color);
  } else {
    const g = c.createLinearGradient(box.x, box.y, box.x + box.w, box.y + box.h);
    g.addColorStop(0, '#141418'); g.addColorStop(0.5, '#1d1d24'); g.addColorStop(1, '#101014');
    c.fillStyle = g; c.fillRect(box.x, box.y, box.w, box.h);
    c.fillStyle = 'rgba(255,255,255,.32)';
    c.font = font(box.h * 0.10, 700);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('영상 업로드', box.x + box.w / 2, box.y + box.h / 2 - box.h * 0.02);
    c.font = font(box.h * 0.045, 500 + 200);
    c.fillStyle = 'rgba(255,255,255,.18)';
    c.fillText('MP4 · MOV · WebM', box.x + box.w / 2, box.y + box.h / 2 + box.h * 0.075);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  }
  c.restore();
}

// 색감 필터 — 합성 모드만 사용해서 아이폰 Safari에서도 가볍게 동작
function applyColorFx(c, el, box, sx, sy, sw, sh, gx, gy, mode) {
  if (!mode || mode === 'none') return;
  c.save();
  if (mode === 'mono') {
    c.globalCompositeOperation = 'saturation';
    c.fillStyle = 'hsl(0, 0%, 50%)';
    c.fillRect(box.x, box.y, box.w, box.h);
  } else if (mode === 'vivid') {
    c.globalCompositeOperation = 'overlay';
    c.globalAlpha = 0.42;
    c.drawImage(el, sx, sy, sw, sh, gx, gy, box.w, box.h);
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.03;
    c.fillStyle = '#ffffff';
    c.fillRect(box.x, box.y, box.w, box.h);
  } else if (mode === 'warm') {
    c.globalCompositeOperation = 'soft-light';
    c.globalAlpha = 0.55;
    c.fillStyle = '#ff9a4d';
    c.fillRect(box.x, box.y, box.w, box.h);
    c.globalCompositeOperation = 'multiply';
    c.globalAlpha = 0.10;
    c.fillStyle = '#ffe0c2';
    c.fillRect(box.x, box.y, box.w, box.h);
  } else if (mode === 'neon') {
    const g = c.createLinearGradient(box.x, box.y, box.x + box.w, box.y + box.h);
    g.addColorStop(0, '#ff2a85');
    g.addColorStop(0.55, '#7a4dff');
    g.addColorStop(1, '#00f5d4');
    c.globalCompositeOperation = 'overlay';
    c.globalAlpha = 0.38;
    c.fillStyle = g;
    c.fillRect(box.x, box.y, box.w, box.h);
    c.globalCompositeOperation = 'screen';
    c.globalAlpha = 0.10;
    c.fillRect(box.x, box.y, box.w, box.h);
  }
  c.restore();
}

// ── 🪩 싸이키 조명 — 박자마다 클럽 컬러 스포트라이트가 교차 ────────────
const PSY_COLORS = ['#FF2A85', '#00F5D4', '#8B5CF6', '#FFE600'];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// 색마다 세기 보정 — 노랑은 밝은 영상에서 세피아처럼 들러붙어 약하게, 바이올렛은 살짝 약하게
const PSY_WEIGHT = [1, 1, 0.85, 0.55];

function hexRgb(hex) {
  const h = String(hex || '#FF2A85').replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const n = parseInt(v, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function withAlpha(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

// 영상 영역 안에서만 그린다. screen/overlay 합성만 써서 아이 얼굴을 가리지 않고 색만 얹는다.
function drawPsyLighting(c, box, S) {
  const lv = S.psy || 0;              // 0 끔 · 1 약 · 2 강
  if (!lv || !box || !(box.w > 0) || !(box.h > 0)) return;
  const t = S.t || 0;
  const beat = Math.max(0.14, S.beat || 0.43);
  const env = Math.max(0, Math.min(1, S.env || 0));
  const strong = lv >= 2;
  const pos = t / beat;
  const bi = Math.floor(pos);
  const ph = pos - bi;                // 한 박 안에서의 위치 0..1
  const A = PSY_COLORS[((bi % 4) + 4) % 4];                 // 이번 박의 주조색
  const B = PSY_COLORS[(((bi + 1) % 4) + 4) % 4];           // 다음 박의 색(박 끝에서 교차)
  const mixT = clamp01((ph - 0.62) / 0.38);                 // 박 뒤쪽 38%에서 다음 색으로 넘어감
  const wA = PSY_WEIGHT[((bi % 4) + 4) % 4];
  const wB = PSY_WEIGHT[(((bi + 1) % 4) + 4) % 4];
  const pulse = 0.62 + 0.38 * env;    // 박자마다 밝아짐
  const k = strong ? 1 : 0.55;        // 강/약 배율

  c.save();
  c.beginPath();
  c.rect(box.x, box.y, box.w, box.h);
  c.clip();

  // 1) 컬러 틴트 — 밝기(luminance)는 그대로 두고 색상만 옅게 입힌다(얼굴이 하얗게 타지 않음)
  c.globalCompositeOperation = 'color';
  c.globalAlpha = (strong ? 0.20 : 0.15) * pulse * wA;
  c.fillStyle = A;
  c.fillRect(box.x, box.y, box.w, box.h);
  if (mixT > 0.001) {
    c.globalAlpha = (strong ? 0.18 : 0.13) * pulse * mixT * wB;
    c.fillStyle = B;
    c.fillRect(box.x, box.y, box.w, box.h);
  }

  // 2) 화면 전체를 적시는 클럽 컬러 워시
  const wash = c.createLinearGradient(box.x, box.y, box.x + box.w * 0.4, box.y + box.h);
  wash.addColorStop(0, withAlpha(A, (strong ? 0.09 : 0.07) * pulse * wA));
  wash.addColorStop(0.6, withAlpha(A, (strong ? 0.05 : 0.04) * pulse * wA));
  wash.addColorStop(1, withAlpha(B, (strong ? 0.08 : 0.06) * pulse * mixT * wB));
  c.globalCompositeOperation = 'screen';
  c.globalAlpha = 1;
  c.fillStyle = wash;
  c.fillRect(box.x, box.y, box.w, box.h);

  // 3) 스포트라이트 — 테두리 쪽에서 돌며 번쩍이는 클럽 조명(얼굴 가운데는 비켜 감)
  const spots = strong ? 4 : 3;
  for (let i = 0; i < spots; i++) {
    const col = (i % 2 === 0) ? A : B;
    const w = (i % 2 === 0) ? wA : wB;
    const ang = t * (0.9 + i * 0.17) + (i * Math.PI * 2) / spots;
    const edge = 0.40 + 0.06 * Math.sin(ang * 0.7 + i);
    const cx = box.x + box.w * (0.5 + edge * Math.cos(ang));
    const cy = box.y + box.h * (0.5 + (edge + 0.03) * Math.sin(ang * 1.07 + i * 1.3));
    const rad = Math.min(box.w, box.h) * (strong ? 0.36 : 0.34) * (0.92 + 0.14 * Math.sin(ang * 0.8));
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, rad);
    const a0 = (strong ? 0.85 : 0.58) * pulse * w * (i === 0 ? 1 : 0.85);
    g.addColorStop(0, withAlpha(col, a0));
    g.addColorStop(0.2, withAlpha(col, a0 * 0.52));
    g.addColorStop(0.55, withAlpha(col, a0 * 0.14));
    g.addColorStop(1, withAlpha(col, 0));
    c.fillStyle = g;
    c.fillRect(box.x, box.y, box.w, box.h);
  }

  // 3-2) 빛 자체가 번쩍이는 광량(color-dodge) — 스포트라이트 코어를 밝게
  if (typeof c.globalCompositeOperation === 'string') {
    for (let i = 0; i < 2; i++) {
      const ang = t * (0.62 + i * 0.19) + i * 2.9;
      const cx = box.x + box.w * (0.5 + 0.38 * Math.cos(ang));
      const cy = box.y + box.h * (0.42 + 0.30 * Math.sin(ang * 1.11 + i));
      const rad = Math.min(box.w, box.h) * (strong ? 0.30 : 0.28);
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, rad);
      const a0 = (strong ? 0.34 : 0.23) * pulse * (i ? wB : wA);
      g.addColorStop(0, withAlpha(i ? B : A, a0));
      g.addColorStop(0.35, withAlpha(i ? B : A, a0 * 0.35));
      g.addColorStop(1, withAlpha(i ? B : A, 0));
      c.globalCompositeOperation = 'color-dodge';
      c.fillStyle = g;
      c.fillRect(box.x, box.y, box.w, box.h);
    }
  }

  // 4) 강: 화면을 쓸고 도는 가느다란 빛줄기
  if (strong && typeof c.createConicGradient === 'function') {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h * 0.46;
    const cg = c.createConicGradient(t * 1.15, cx, cy);
    const beams = 8;
    for (let j = 0; j < beams; j++) {
      const col = j % 4 === 3 ? B : A;
      cg.addColorStop(j / beams, withAlpha(col, 0));
      cg.addColorStop((j + 0.5) / beams, withAlpha(col, 0.10 * pulse * (j % 4 === 3 ? wB : wA)));
    }
    c.fillStyle = cg;
    c.fillRect(box.x, box.y, box.w, box.h);
  }

  // 5) 박마다 가장자리로 퍼지는 컬러 글로우
  if (env > 0.02) {
    const g2 = c.createRadialGradient(
      box.x + box.w / 2, box.y + box.h * 0.5, Math.min(box.w, box.h) * 0.22,
      box.x + box.w / 2, box.y + box.h * 0.5, Math.max(box.w, box.h) * 0.8,
    );
    g2.addColorStop(0, withAlpha(A, 0));
    g2.addColorStop(1, withAlpha(B, (strong ? 0.34 : 0.20) * env * wB));
    c.fillStyle = g2;
    c.fillRect(box.x, box.y, box.w, box.h);
  }
  c.restore();
}

function drawBadge(c, fmt, lay, env, pulseOn) {
  const b = fmt.badge || {};
  if (!b.show) return;
  const scale = (lay.badge.scale || 1) * (pulseOn ? 1 + 0.07 * env : 1);
  const d = (b.size || 128) * scale;
  const cy = lay.badge.cy;
  const text = b.text != null ? b.text : '다인이네';
  const textSize = (b.textSize || 58) * (lay.badge.scale || 1);
  const logo = getLogoImage(b.logo || 'cat');
  const gap = 26 * (lay.badge.scale || 1);

  c.font = font(textSize, 800);
  const tw = text ? c.measureText(text).width : 0;
  const groupW = (logo ? d : 0) + (text ? gap + tw : 0);
  const x0 = W / 2 - groupW / 2;

  if (logo) {
    const cx = x0 + d / 2;
    c.save();
    c.beginPath();
    c.arc(cx, cy, d / 2, 0, Math.PI * 2);
    c.closePath();
    const cream = fmt.mode === 'cream';
    c.fillStyle = cream ? '#FFFFFF' : '#FFFFFF';
    if (cream) { c.shadowColor = 'rgba(20,16,10,.16)'; c.shadowBlur = 14; c.shadowOffsetY = 4; }
    c.fill();
    c.restore();
    c.save();
    c.beginPath(); c.arc(cx, cy, d / 2 - 3, 0, Math.PI * 2); c.clip();
    const pad = d * 0.06;
    c.drawImage(logo, cx - d / 2 + pad, cy - d / 2 + pad, d - pad * 2, d - pad * 2);
    c.restore();
  }
  if (text) {
    c.font = font(textSize, 800);
    c.fillStyle = fmt.badgeTextColor || (fmt.mode === 'cream' ? '#141414' : '#FFFFFF');
    c.textBaseline = 'middle';
    c.fillText(text, x0 + (logo ? d + gap : 0), cy + textSize * 0.04);
    c.textBaseline = 'alphabetic';
  }
}

export function drawScene(c, S) {
  const fmt = S.fmt;
  const lay = modeLayout(fmt);
  const t = S.t || 0;
  const env = S.env || 0;            // 0..1 비트 엔벨로프
  const punch = S.punch || 0;
  const flash = S.flash || 0;
  const zoom = 1 + punch * env + (S.dropPunch || 0);
  const dark = fmt.mode !== 'cream';
  const shake = S.shake || 0;
  const shx = shake ? Math.sin(t * 37.7) * shake : 0;
  const shy = shake ? Math.cos(t * 41.3) * shake : 0;
  const zoomShake = shake ? zoom * 1.035 : zoom;

  const sc = S.scale || 1;
  c.save();
  c.setTransform(sc, 0, 0, sc, 0, 0);
  c.globalAlpha = 1;
  c.fillStyle = fmt.bg || '#000000';
  c.fillRect(0, 0, W, H);
  c.__baseColor = fmt.titleColor || (dark ? '#FFFFFF' : '#111111');
  c.__accentColor = fmt.accent || '#FF2A85';

  // 배경 그라데이션 (크림/네온은 은은하게)
  if (dark) {
    const g = c.createRadialGradient(W / 2, lay.video.y + lay.video.h / 2, 80, W / 2, lay.video.y + lay.video.h / 2, W * 0.95);
    g.addColorStop(0, 'rgba(255,255,255,0.045)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
  }

  // 싸이키 조명의 배경 번짐 (영상 뒤쪽 테두리로 새어 나오는 빛)
  if (S.psy && dark) {
    const beatSec = Math.max(0.14, S.beat || 0.43);
    const bi2 = Math.floor(Math.max(0, t) / beatSec);
    const col = PSY_COLORS[((bi2 % 4) + 4) % 4];
    const w = PSY_WEIGHT[((bi2 % 4) + 4) % 4];
    const g = c.createRadialGradient(W / 2, H * 0.5, W * 0.18, W / 2, H * 0.5, W * 0.92);
    g.addColorStop(0, withAlpha(col, 0));
    g.addColorStop(1, withAlpha(col, (S.psy >= 2 ? 0.12 : 0.09) * (0.45 + 0.55 * env) * w));
    c.save();
    c.globalCompositeOperation = 'screen';
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    c.restore();
  }

  // 영상
  drawVideoCover(c, S.video, lay.video, zoomShake, S.fitY == null ? 0.42 : S.fitY, lay.radius, { dx: shx, dy: shy, color: S.colorFx });

  // 🪩 싸이키 조명 (영상 영역 안에서 은은~화려하게)
  if (S.psy) drawPsyLighting(c, lay.video, S);

  // 모서리·테두리 비트 반응
  if (S.edgeOn && lay.video.w > 0) {
    const accent = fmt.accent || '#FF2A85';
    c.save();
    c.strokeStyle = accent;
    c.globalAlpha = 0.30 + 0.70 * env;
    c.lineWidth = 3 + 5 * env;
    c.shadowColor = accent;
    c.shadowBlur = 8 + 36 * env;
    roundRect(c, lay.video.x - 4, lay.video.y - 4, lay.video.w + 8, lay.video.h + 8, (lay.radius || 0) + 4);
    c.stroke();
    c.restore();
  }

  // Ver.1 얇은 프레임 라인 (영상 경계를 살짝 정돈)
  if (fmt.mode === 'ver1') {
    c.strokeStyle = 'rgba(255,255,255,.10)';
    c.lineWidth = 2;
    c.strokeRect(lay.video.x + 1, lay.video.y + 1, lay.video.w - 2, lay.video.h - 2);
  }

  // 네온 테두리 (비트 반응)
  if (fmt.neon) {
    const glow = 18 + 34 * env;
    c.save();
    c.shadowColor = fmt.accent;
    c.shadowBlur = glow;
    c.strokeStyle = fmt.accent;
    c.lineWidth = 7;
    roundRect(c, lay.video.x - 6, lay.video.y - 6, lay.video.w + 12, lay.video.h + 12, (lay.radius || 12) + 6);
    c.stroke();
    c.shadowColor = '#FF2A85';
    c.shadowBlur = glow * 0.75;
    c.strokeStyle = 'rgba(255,42,133,.85)';
    c.lineWidth = 3;
    roundRect(c, lay.video.x - 15, lay.video.y - 15, lay.video.w + 30, lay.video.h + 30, (lay.radius || 12) + 14);
    c.stroke();
    c.restore();
    // 외곽 라인
    c.strokeStyle = 'rgba(0,245,212,.22)';
    c.lineWidth = 3;
    c.strokeRect(24, 24, W - 48, H - 48);
  }

  // 제목
  const t1 = (S.title1 || '').trim();
  const t2 = (S.title2 || '').trim();
  const lines = [t1, t2].filter((x) => x.length);
  if (lines.length) {
    const maxW = lay.title.maxW;
    const maxH = lay.title.maxH;
    const gap = lay.title.gap;
    const size = fitLines(c, lines, maxW, maxH, gap, fmt.fontScale || 1, 176);
    const metrics = lines.map((l) => lineMetrics(c, l, size));
    const blockH = metrics.reduce((a, m, i) => a + m.h + (i ? gap : 0), 0);
    const top = lay.title.inkBottom - blockH;

    if (lay.title.overlay) {
      const g = c.createLinearGradient(0, 0, 0, lay.title.inkBottom + 120);
      g.addColorStop(0, 'rgba(0,0,0,.62)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, W, lay.title.inkBottom + 120);
    }
    c.save();
    c.textAlign = 'left';
    if (dark) {
      c.shadowColor = 'rgba(0,0,0,.62)';
      c.shadowBlur = fmt.neon ? 26 : 0;
      c.shadowOffsetY = 6;
      if (fmt.neon) c.shadowColor = 'rgba(0,245,212,.35)';
    }
    drawLines(c, lines, size, W / 2, top, gap, maxW);
    c.restore();
  }

  // 트랙 라벨 (네온 전용)
  if (lay.trackLabel) {
    c.save();
    c.font = font(34, 700);
    c.textAlign = 'center';
    c.fillStyle = 'rgba(0,245,212,.9)';
    c.shadowColor = 'rgba(0,245,212,.8)';
    c.shadowBlur = 16;
    c.fillText(`${S.bpm || 140} BPM · ${(S.genreLabel || 'TECHNO').toUpperCase()}`, W / 2, lay.badge.cy + 118);
    c.restore();
  }

  drawBadge(c, fmt, lay, env, S.pulse !== false);

  // 비트 플래시
  if (flash > 0.001) {
    c.fillStyle = fmt.neon ? `rgba(0,245,212,${(flash * 0.55).toFixed(3)})` : `rgba(255,255,255,${flash.toFixed(3)})`;
    c.fillRect(0, 0, W, H);
  }

  // 풀스크린 하단 그라데이션
  if (lay.vignette) {
    const g = c.createLinearGradient(0, H - 420, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,.55)');
    c.fillStyle = g; c.fillRect(0, H - 420, W, 420);
  }
  c.restore();
}

// ── UI 파형 (편집 화면용) ────────────────────────────────
export function drawWave(canvas, peaks, opts = {}) {
  if (!canvas) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = canvas.clientWidth || 600;
  const ch = canvas.clientHeight || 88;
  if (canvas.width !== Math.round(cw * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cw, ch);
  c.fillStyle = opts.bg || 'rgba(255,255,255,.04)';
  c.fillRect(0, 0, cw, ch);
  if (!peaks) return;
  const { mins, maxs, duration } = peaks;
  const n = mins.length;
  const mid = ch / 2;
  const color = opts.color || 'rgba(255,255,255,.55)';

  // 선택 영역 밖 어둡게
  const sel = opts.selection;
  if (sel) {
    c.fillStyle = 'rgba(0,0,0,.55)';
    const x0 = (sel.start / duration) * cw;
    const x1 = (sel.end / duration) * cw;
    c.fillRect(0, 0, x0, ch);
    c.fillRect(x1, 0, cw - x1, ch);
    c.fillStyle = 'rgba(255,42,133,.10)';
    c.fillRect(x0, 0, x1 - x0, ch);
  }

  // 구간 표시는 파형 뒤에 깔고, 시작선만 위에 얹는다
  if (opts.markers && opts.markers.length) {
    for (const m of opts.markers) {
      const x = (m.start / duration) * cw;
      const x2 = (m.end / duration) * cw;
      c.fillStyle = m.on ? 'rgba(255,42,133,.20)' : 'rgba(255,255,255,.05)';
      c.fillRect(x, 0, Math.max(2, x2 - x), ch);
    }
  }

  c.fillStyle = color;
  for (let i = 0; i < n; i++) {
    const x = (i / n) * cw;
    const y0 = mid + mins[i] * mid * 0.94;
    const y1 = mid + maxs[i] * mid * 0.94;
    const h = Math.max(1, y1 - y0);
    c.fillRect(x, y0, Math.max(1, cw / n - 0.6), h);
  }

  if (opts.markers && opts.markers.length) {
    for (const m of opts.markers) {
      const x = (m.start / duration) * cw;
      const x2 = (m.end / duration) * cw;
      c.fillStyle = m.on ? 'rgba(255,42,133,.9)' : 'rgba(255,255,255,.25)';
      c.fillRect(x, 0, 2, ch);
      c.fillRect(x2 - 1, 0, 1, ch);
    }
  }
  if (opts.playhead != null && duration) {
    const x = (opts.playhead / duration) * cw;
    c.fillStyle = '#00F5D4';
    c.fillRect(x, 0, 2, ch);
  }
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

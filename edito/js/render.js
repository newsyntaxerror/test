/* ---------------------------------------------------------------
   Edito · render.js
   Canvas 매거진 렌더러 (표지 / 속지 / 비교표 / 체크리스트 / 마지막 장)
   - 화면 미리보기와 PNG 내보내기가 같은 함수를 씁니다 (WYSIWYG)
--------------------------------------------------------------- */
(function () {
  'use strict';
  const E = window.Edito;
  const R = (E.Render = {});

  const mctx = document.createElement('canvas').getContext('2d');

  /* ---------- 기본 유틸 ---------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  R.pad2 = pad2;

  function fontStr(family, weight, size) {
    return weight + ' ' + size + 'px ' + E.fontStack(family);
  }

  function setFont(ctx, family, weight, size) {
    ctx.font = fontStr(family, weight, size);
  }

  function isDark(hex) {
    if (!hex) return false;
    const m = String(hex).trim();
    if (m[0] !== '#') return false;
    let h = m.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b < 118;
  }
  R.isDark = isDark;

  /* ---------- 기하 ---------- */
  R.geom = function (ratio) {
    if (ratio === '9:16') {
      return { W: 1080, H: 1920, padX: 92, top: 214, bot: 214, footY: 1770 };
    }
    return { W: 1080, H: 1350, padX: 88, top: 104, bot: 100, footY: 1294 };
  };

  /* ---------- 텍스트 런 파싱 (**굵게/형광펜**, ==형광==) ---------- */
  R.parseRuns = function (text) {
    const src = String(text == null ? '' : text);
    const runs = [];
    let i = 0, buf = '';
    const push = (t, style) => {
      if (!t) return;
      const last = runs[runs.length - 1];
      if (last && last.bold === style.bold && last.hl === style.hl) last.text += t;
      else runs.push({ text: t, bold: !!style.bold, hl: !!style.hl });
    };
    while (i < src.length) {
      if (src.startsWith('**', i)) {
        push(buf, {}); buf = '';
        const end = src.indexOf('**', i + 2);
        if (end === -1) { buf += '**'; i += 2; continue; }
        push(src.slice(i + 2, end), { bold: true, hl: true });
        i = end + 2;
      } else if (src.startsWith('==', i)) {
        push(buf, {}); buf = '';
        const end = src.indexOf('==', i + 2);
        if (end === -1) { buf += '=='; i += 2; continue; }
        push(src.slice(i + 2, end), { hl: true });
        i = end + 2;
      } else if (src[i] === '\n') {
        push(buf, {}); buf = '';
        if (runs.length && runs[runs.length - 1].text.slice(-1) !== '\n') runs.push({ text: '\n', br: true });
        i += 1;
      } else {
        buf += src[i]; i += 1;
      }
    }
    push(buf, {});
    return runs;
  };

  /* ---------- 레이아웃 ---------- */
  function flatten(runs, spec) {
    const out = [];
    const trackPx = spec.tracking ? spec.size * spec.tracking : 0;
    for (const run of runs) {
      if (run.br) { out.push({ br: true, w: 0, run }); continue; }
      setFont(mctx, spec.family, run.bold ? Math.max(700, spec.weight) : spec.weight, spec.size);
      for (const ch of run.text) {
        out.push({ ch, run, w: mctx.measureText(ch).width + (ch === ' ' ? 0 : trackPx) });
      }
    }
    return out;
  }

  /**
   * rich text를 줄 단위로 배치. 반환: [{chars:[{ch,w,x,run}], w}]
   */
  R.layout = function (text, maxW, spec) {
    const runs = Array.isArray(text) ? text : R.parseRuns(text);
    const chars = flatten(runs, spec);
    const lines = [];
    let line = { chars: [], w: 0 };
    const pushLine = () => { lines.push(line); line = { chars: [], w: 0 }; };
    const appendChar = (c) => {
      if (c.w === 0 && !c.ch) return;
      c.x = line.w;
      line.chars.push(c);
      line.w += c.w;
    };

    // 토큰화 (공백 / 단어)
    let tokens = [];
    let word = null;
    for (const c of chars) {
      if (c.br) { tokens.push({ br: true }); word = null; continue; }
      if (c.ch === ' ') { tokens.push({ space: true, w: c.w, chars: [c] }); word = null; }
      else {
        if (!word) { word = { w: 0, chars: [] }; tokens.push(word); }
        word.chars.push(c); word.w += c.w;
      }
    }

    for (const tk of tokens) {
      if (tk.br) { pushLine(); continue; }
      if (tk.space) {
        if (line.chars.length === 0) continue;
        tk.chars.forEach(appendChar);
        continue;
      }
      if (line.w + tk.w <= maxW || line.chars.length === 0) {
        if (tk.w <= maxW || line.chars.length === 0) {
          tk.chars.forEach(appendChar);
          if (line.w > maxW) {
            // 한 글자가 넘친 경우 그대로 두고 다음 토큰에서 줄바꿈
          }
          continue;
        }
      }
      if (tk.w > maxW) {
        // 단어가 한 줄보다 길면 글자 단위로 쪼갬
        if (line.chars.length) pushLine();
        for (const c of tk.chars) {
          if (line.w + c.w > maxW && line.chars.length) pushLine();
          appendChar(c);
        }
      } else {
        pushLine();
        tk.chars.forEach(appendChar);
      }
    }
    if (line.chars.length || lines.length === 0) pushLine();
    // 트레일링 공백 정리
    for (const ln of lines) {
      while (ln.chars.length && ln.chars[ln.chars.length - 1].ch === ' ') {
        ln.w -= ln.chars.pop().w;
      }
    }
    return lines;
  };

  R.lineText = (line) => line.chars.map((c) => c.ch).join('');

  R.countLines = function (text, maxW, spec) {
    return R.layout(text, maxW, spec).length;
  };

  /* ---------- 그리기 ---------- */
  function drawLines(ctx, lines, opts) {
    const { x, y, maxW, spec, color, align, highlight, boldColor } = opts;
    const lineH = spec.size * spec.lineHeight;
    let cy = y;
    for (const ln of lines) {
      let ox = 0;
      if (align === 'center') ox = (maxW - ln.w) / 2;
      else if (align === 'right') ox = maxW - ln.w;
      // 형광펜
      if (highlight) {
        let i = 0;
        while (i < ln.chars.length) {
          const c = ln.chars[i];
          if (c.run.hl && c.ch !== ' ') {
            let j = i, x0 = c.x, x1 = c.x + c.w;
            while (j + 1 < ln.chars.length && ln.chars[j + 1].run.hl) {
              j += 1;
              if (ln.chars[j].ch !== ' ') x1 = ln.chars[j].x + ln.chars[j].w;
            }
            ctx.fillStyle = highlight;
            const hh = spec.size * 1.03;
            const ry = cy - spec.size * 0.80;
            const rr = Math.min(6, hh / 4);
            roundRect(ctx, x + ox + x0 - 4, ry, (x1 - x0) + 8, hh, rr);
            ctx.fill();
            i = j + 1;
          } else i += 1;
        }
      }
      for (const c of ln.chars) {
        if (c.ch === ' ') continue;
        const bold = !!c.run.bold;
        setFont(ctx, spec.family, bold ? Math.max(700, spec.weight) : spec.weight, spec.size);
        ctx.fillStyle = (bold && boldColor) ? boldColor : color;
        ctx.fillText(c.ch, x + ox + c.x, cy);
      }
      cy += lineH;
    }
    return cy;
  }
  R.drawLines = drawLines;

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  R.roundRect = roundRect;

  function label(ctx, text, x, y, o) {
    const opt = o || {};
    const size = opt.size || 22;
    const maxW = opt.maxW || 900;
    const spec = { family: opt.family || 'pretendard', weight: opt.weight || 700, size, tracking: opt.tracking == null ? 0.18 : opt.tracking, lineHeight: 1.2 };
    const lines = R.layout(text, maxW, spec);
    // 오른쪽 정렬은 x를 '오른쪽 끝'으로 받습니다
    const left = (opt.align === 'right') ? x - maxW : x;
    drawLines(ctx, lines, {
      x: left, y, maxW, spec,
      color: opt.color || '#888', align: opt.align || 'left',
    });
  }
  R.label = label;

  /* ---------- 배경 ---------- */
  const tileCache = new Map();
  function noiseTile(kind, color) {
    const key = kind + '|' + color;
    if (tileCache.has(key)) return tileCache.get(key);
    const c = document.createElement('canvas');
    c.width = c.height = 220;
    const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, 220, 220);
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    if (kind === 'grain' || kind === 'paper') {
      const n = kind === 'grain' ? 2600 : 1100;
      for (let i = 0; i < n; i++) {
        const a = kind === 'grain' ? rnd() * 0.20 : rnd() * 0.07;
        const light = rnd() > 0.5;
        x.fillStyle = light ? 'rgba(255,255,255,' + a.toFixed(3) + ')' : 'rgba(0,0,0,' + (a * 0.9).toFixed(3) + ')';
        const s = kind === 'grain' ? (rnd() > 0.9 ? 2 : 1) : 1;
        x.fillRect(Math.floor(rnd() * 220), Math.floor(rnd() * 220), s, s);
      }
      if (kind === 'paper') {
        for (let i = 0; i < 90; i++) {
          x.strokeStyle = 'rgba(120,95,60,' + (0.02 + rnd() * 0.03).toFixed(3) + ')';
          x.lineWidth = 1;
          const yy = rnd() * 220;
          x.beginPath(); x.moveTo(0, yy); x.lineTo(220, yy + rnd() * 2 - 1); x.stroke();
        }
      }
    } else if (kind === 'dots') {
      x.fillStyle = 'rgba(0,0,0,.10)';
      for (let gy = 10; gy < 220; gy += 22) {
        for (let gx = 10; gx < 220; gx += 22) {
          x.beginPath(); x.arc(gx, gy, 1.1, 0, Math.PI * 2); x.fill();
        }
      }
    }
    tileCache.set(key, c);
    return c;
  }

  function drawBackground(ctx, s, g) {
    const bg = s.bg || { kind: 'solid', color: '#ffffff' };
    const W = g.W, H = g.H;
    if (bg.kind === 'gradient') {
      const grd = ctx.createLinearGradient(0, 0, W * 0.35, H);
      grd.addColorStop(0, bg.from || '#20202a');
      grd.addColorStop(1, bg.to || '#08080a');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(W * 0.82, -H * 0.08, 40, W * 0.82, -H * 0.08, H * 0.75);
      glow.addColorStop(0, bg.glow || 'rgba(255,120,70,.32)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    } else {
      ctx.fillStyle = bg.color || '#ffffff';
      ctx.fillRect(0, 0, W, H);
    }
    if (bg.kind === 'grid') {
      ctx.strokeStyle = 'rgba(20,20,25,.075)';
      ctx.lineWidth = 1.4;
      const step = 54;
      for (let x = step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    } else if (bg.kind === 'dots' || bg.kind === 'grain' || bg.kind === 'paper') {
      const tile = noiseTile(bg.kind, bg.color || '#ffffff');
      const pat = ctx.createPattern(tile, 'repeat');
      if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H); }
    }
    if (bg.kind === 'grain') {
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,.45)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    }
    if (s.headerBand) {
      ctx.fillStyle = s.accent;
      ctx.fillRect(0, 0, W, 168);
      ctx.fillStyle = 'rgba(255,255,255,.14)';
      ctx.fillRect(0, 168, W, 6);
    }
  }

  /* ---------- 사진 ---------- */
  const imgCache = new Map();
  R.imgCache = imgCache;

  R.getImage = function (src) {
    if (!src) return null;
    let rec = imgCache.get(src);
    if (rec) return rec.img;
    const img = new Image();
    const rec2 = { img, loaded: false };
    imgCache.set(src, rec2);
    img.onload = () => {
      rec2.loaded = true;
      // 다운스케일 본 준비
      try {
        const max = 1600;
        const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * sc);
        c.height = Math.round(img.naturalHeight * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        rec2.small = c;
      } catch (e) { /* noop */ }
      if (E.onImageLoad) E.onImageLoad(src);
    };
    img.onerror = () => { rec2.failed = true; if (E.onImageLoad) E.onImageLoad(src); };
    img.src = src;
    return img;
  };

  function filterCanvas(srcCanvas, filter) {
    if (!filter || filter === 'none') return srcCanvas;
    const key = 'fx:' + filter;
    if (srcCanvas[key]) return srcCanvas[key];
    const c = document.createElement('canvas');
    c.width = srcCanvas.width; c.height = srcCanvas.height;
    const x = c.getContext('2d');
    x.drawImage(srcCanvas, 0, 0);
    let data;
    try { data = x.getImageData(0, 0, c.width, c.height); } catch (e) { return srcCanvas; }
    const p = data.data;
    const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let i = 0; i < p.length; i += 4) {
      let r = p[i], gg = p[i + 1], b = p[i + 2];
      const lum = 0.299 * r + 0.587 * gg + 0.114 * b;
      switch (filter) {
        case 'mono': r = gg = b = lum * 1.04 - 4; break;
        case 'film': {
          r = cl(r * 0.90 + lum * 0.14 + 8);
          gg = cl(gg * 0.90 + lum * 0.12 + 4);
          b = cl(b * 0.92 + lum * 0.08 - 4);
          break;
        }
        case 'vintage': {
          const s1 = lum;
          r = cl(s1 * 0.62 + r * 0.42 + 18);
          gg = cl(s1 * 0.56 + gg * 0.40 + 8);
          b = cl(s1 * 0.46 + b * 0.34);
          break;
        }
        case 'cool': r = cl(r - 8); gg = cl(gg + 2); b = cl(b + 16); break;
        case 'warm': r = cl(r + 14); gg = cl(gg + 4); b = cl(b - 10); break;
        case 'fade': r = cl(28 + r * 0.80); gg = cl(26 + gg * 0.80); b = cl(24 + b * 0.80); break;
        default: break;
      }
      p[i] = r; p[i + 1] = gg; p[i + 2] = b;
    }
    x.putImageData(data, 0, 0);
    srcCanvas[key] = c;
    return c;
  }

  function drawPhoto(ctx, photo, rect) {
    const img = R.getImage(photo.src);
    if (!img || !img.complete || !img.naturalWidth) return false;
    const rec = imgCache.get(photo.src);
    const srcCanvas = (rec && rec.small) ? rec.small : img;
    const painted = filterCanvas(srcCanvas, photo.filter || 'none');
    const iw = painted.width, ih = painted.height;
    const base = Math.max(rect.w / iw, rect.h / ih);
    const sc = base * (photo.zoom || 1);
    const dw = iw * sc, dh = ih * sc;
    const ox = (photo.x || 0) * (dw - rect.w) / 2;
    const oy = (photo.y || 0) * (dh - rect.h) / 2;
    const cx = rect.x + rect.w / 2 + ox;
    const cy = rect.y + rect.h / 2 + oy;
    ctx.save();
    ctx.beginPath(); ctx.rect(rect.x, rect.y, rect.w, rect.h); ctx.clip();
    ctx.drawImage(painted, cx - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
    return true;
  }
  R.drawPhoto = drawPhoto;

  /* ---------- 스타일 토큰 ---------- */
  R.bodySpec = function (s, ratio, sizeOverride) {
    const base = ratio === '9:16' ? 54 : 46;
    return {
      family: s.bodyFont, weight: 400,
      size: Math.round((sizeOverride || base) * s.bodyScale),
      tracking: 0, lineHeight: s.lineHeight,
    };
  };
  R.titleSpec = function (s, ratio) {
    const base = ratio === '9:16' ? 84 : 72;
    return { family: s.titleFont, weight: s.titleWeight, size: Math.round(base * s.titleScale), tracking: s.tracking, lineHeight: 1.2 };
  };

  R.bodyBox = function (s, ratio, titleLines) {
    const g = R.geom(ratio);
    const labelH = s.headerBand ? 176 : 92;
    const ts = R.titleSpec(s, ratio);
    let top = g.top + labelH;
    if (titleLines) top += Math.round(titleLines * ts.size * 1.2 + 34);
    const bottom = g.H - g.bot - 74;
    return { x: g.padX, y: top, w: g.W - 2 * g.padX, h: Math.max(80, bottom - top) };
  };

  R.capacity = function (s, ratio, titleLines) {
    const box = R.bodyBox(s, ratio, titleLines);
    const spec = R.bodySpec(s, ratio);
    const lineH = spec.size * spec.lineHeight;
    return Math.max(2, Math.floor((box.h * 0.96) / lineH));
  };

  R.bodyLines = function (text, maxW, spec) {
    const paras = String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const gap = Math.round(spec.size * spec.lineHeight * 0.42);
    let total = 0;
    const blocks = [];
    paras.forEach((p, i) => {
      const lines = R.layout(p, maxW, spec);
      total += lines.length;
      if (i) total += gap / (spec.size * spec.lineHeight);
      blocks.push(lines);
    });
    return { blocks, lines: Math.ceil(total), gap };
  };

  /* ---------- 공통 크롬 ---------- */
  function chapterTag(ctx, card, s, g, pageNo, total) {
    const text = card.label || 'PART 01';
    const y = s.headerBand ? 112 : g.top + 30;
    const light = isDark(s.bg && s.bg.color);
    if (s.headerBand) {
      label(ctx, text, g.padX, y, { size: 22, color: 'rgba(255,255,255,.82)', tracking: 0.22, weight: 800, family: s.bodyFont });
      label(ctx, 'CARD NEWS', g.W - g.padX, y, { size: 20, color: 'rgba(255,255,255,.55)', tracking: 0.24, weight: 700, align: 'right', maxW: 400 });
      return;
    }
    if (s.label === 'block') {
      const size = 20;
      setFont(ctx, s.bodyFont, 800, size);
      const tw = mctx.measureText(text).width + size * 0.9;
      ctx.fillStyle = s.accent;
      roundRect(ctx, g.padX, y - size - 4, tw + 20, size + 22, 4);
      ctx.fill();
      label(ctx, text, g.padX + 12, y + 4, { size, color: '#fff', tracking: 0.16, weight: 800, family: s.bodyFont });
    } else if (s.label === 'caps') {
      ctx.fillStyle = s.accent;
      ctx.fillRect(g.padX, y - 20, 26, 3);
      label(ctx, text, g.padX + 40, y, { size: 20, color: light ? s.accent : s.accent, tracking: 0.24, weight: 800, family: s.bodyFont });
    } else {
      label(ctx, text, g.padX, y, { size: 23, color: s.accent, tracking: 0.2, weight: 800, family: s.bodyFont });
      ctx.strokeStyle = s.rule;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(g.padX, y + 24); ctx.lineTo(g.W - g.padX, y + 24); ctx.stroke();
      if (pageNo) {
        label(ctx, pad2(pageNo), g.W - g.padX, y, { size: 22, color: s.sub, tracking: 0.12, weight: 700, align: 'right', maxW: 300 });
      }
    }
  }

  function footer(ctx, card, s, g, state, pageNo, total) {
    const acct = E.activeAccount(state);
    const handle = (acct && acct.handle) || '';
    const light = isDark(s.bg && s.bg.color);
    const c = light ? 'rgba(255,255,255,.5)' : s.sub;
    ctx.strokeStyle = light ? 'rgba(255,255,255,.16)' : s.rule;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(g.padX, g.footY - 34); ctx.lineTo(g.W - g.padX, g.footY - 34); ctx.stroke();
    if (handle) label(ctx, handle, g.padX, g.footY, { size: 23, color: c, tracking: 0.06, weight: 600, family: s.bodyFont, maxW: 600 });
    if (pageNo) label(ctx, pad2(pageNo) + ' / ' + pad2(total), g.W - g.padX, g.footY, { size: 23, color: c, tracking: 0.08, weight: 700, align: 'right', maxW: 300, family: s.bodyFont });
  }

  /* ---------- 표지 ---------- */
  function drawCover(ctx, card, s, g, state, pageNo, total) {
    const W = g.W, H = g.H, pad = g.padX;
    const acct = E.activeAccount(state);
    let onPhoto = false;
    if (card.photo && card.photo.src) {
      const band = card.photo.band === 'band' ? { x: 0, y: 0, w: W, h: Math.round(H * 0.52) } : { x: 0, y: 0, w: W, h: H };
      onPhoto = drawPhoto(ctx, card.photo, band);
      if (onPhoto) {
        const dark = card.photo.dark == null ? 0.30 : card.photo.dark;
        ctx.fillStyle = 'rgba(0,0,0,' + dark + ')';
        ctx.fillRect(band.x, band.y, band.w, band.h);
        if (band.h < H) {
          const grd = ctx.createLinearGradient(0, band.h - 120, 0, band.h + 60);
          grd.addColorStop(0, 'rgba(0,0,0,0)');
          grd.addColorStop(1, 'rgba(0,0,0,.0)');
          ctx.fillStyle = grd;
          ctx.fillRect(0, band.h - 120, W, 180);
        }
        const br = card.photo.brightness || 0;
        if (br) {
          ctx.fillStyle = br > 0 ? 'rgba(255,255,255,' + (br * 0.5) + ')' : 'rgba(0,0,0,' + (-br * 0.6) + ')';
          ctx.fillRect(band.x, band.y, band.w, band.h);
        }
        // 아래쪽 어둡게 (텍스트 가독성)
        const topScrim = ctx.createLinearGradient(0, 0, 0, H * 0.24);
        topScrim.addColorStop(0, 'rgba(0,0,0,.42)');
        topScrim.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = topScrim; ctx.fillRect(0, 0, W, H * 0.28);
        const grd2 = ctx.createLinearGradient(0, H * 0.45, 0, H);
        grd2.addColorStop(0, 'rgba(0,0,0,0)');
        grd2.addColorStop(1, 'rgba(0,0,0,' + (band.h === H ? 0.18 : 0.42) + ')');
        ctx.fillStyle = grd2; ctx.fillRect(0, 0, W, H);
      }
    }
    const ink = onPhoto ? '#ffffff' : s.ink;
    const subC = onPhoto ? 'rgba(255,255,255,.80)' : s.sub;
    const accent = onPhoto ? '#ffffff' : s.accent;

    if (s.frame) {
      ctx.strokeStyle = onPhoto ? 'rgba(255,255,255,.45)' : 'rgba(120,100,70,.35)';
      ctx.lineWidth = 2;
      ctx.strokeRect(36, 36, W - 72, H - 72);
    }

    if (s.cover === 'band') {
      ctx.fillStyle = onPhoto ? 'rgba(255,90,31,.92)' : s.accent;
      ctx.fillRect(0, 0, W, 214);
      label(ctx, (card.kicker || (acct && acct.handle) || 'MAGAZINE'), pad, 132, { size: 24, color: '#fff', tracking: 0.2, weight: 800, family: s.bodyFont, maxW: W - pad * 2 });
      label(ctx, 'CARD NEWS', W - pad, 132, { size: 20, color: 'rgba(255,255,255,.72)', tracking: 0.22, weight: 700, align: 'right', maxW: 400 });
    } else if (s.cover === 'box') {
      ctx.fillStyle = s.accent;
      ctx.fillRect(0, 0, W, 214);
      label(ctx, 'MAGAZINE', pad, 96, { size: 20, color: 'rgba(255,255,255,.7)', tracking: 0.26, weight: 800 });
      label(ctx, (card.kicker || '오늘의 카드뉴스'), pad, 150, { size: 34, color: '#fff', tracking: -0.01, weight: 800, family: s.bodyFont, maxW: W - pad * 2 });
    } else {
      const kicker = card.kicker || (acct && acct.handle) || 'MAGAZINE';
      label(ctx, kicker, pad, g.top + 14, { size: 22, color: onPhoto ? 'rgba(255,255,255,.85)' : accent, tracking: 0.16, weight: 700, family: s.bodyFont, maxW: W - pad * 2 });
      if (s.cover === 'rule') {
        ctx.strokeStyle = onPhoto ? 'rgba(255,255,255,.32)' : s.rule;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(pad, g.top + 54); ctx.lineTo(W - pad, g.top + 54); ctx.stroke();
      } else if (s.cover === 'bar') {
        ctx.fillStyle = accent;
        ctx.fillRect(pad - 30, g.top + 8, 8, 40);
      }
    }

    // 제목
    const maxW = W - pad * 2;
    const titleSizeBase = (g.H > 1500 ? 132 : 118) * s.titleScale;
    let size = titleSizeBase;
    const titleText = card.title || '제목을 입력하세요';
    const maxTitleLines = g.H > 1500 ? 5 : 4;
    let lines = [];
    for (; size >= 50; size -= 3) {
      const spec = { family: s.titleFont, weight: s.titleWeight, size, tracking: s.tracking, lineHeight: 1.16 };
      lines = R.layout(titleText, maxW, spec);
      const hUsed = lines.length * size * 1.16;
      if (lines.length <= maxTitleLines && hUsed <= (g.H > 1500 ? 820 : 580)) break;
    }
    const titleSpec = { family: s.titleFont, weight: s.titleWeight, size, tracking: s.tracking, lineHeight: 1.16 };
    const subSpec = { family: s.bodyFont, weight: 400, size: g.H > 1500 ? 34 : 31, tracking: 0, lineHeight: 1.6 };
    const subLines = card.subtitle ? R.layout(card.subtitle, maxW * 0.94, subSpec).slice(0, 3) : [];
    const blockH = lines.length * size * 1.16 + (subLines.length ? 46 + subLines.length * subSpec.size * 1.6 : 0);
    const areaTop = (s.cover === 'band' || s.cover === 'box') ? 330 : 292;
    const areaBottom = g.footY - 74;
    let titleTop = Math.round((areaTop + areaBottom) / 2 - blockH / 2);
    titleTop = Math.max(areaTop, Math.min(titleTop, areaBottom - blockH));

    // 제목 위 포인트
    if (s.cover === 'rule' || s.cover === 'ornament') {
      ctx.fillStyle = onPhoto ? 'rgba(255,255,255,.9)' : accent;
      ctx.fillRect(pad, titleTop - 66, 48, 6);
    }
    const firstBaseline = titleTop + size * 0.80;
    const afterTitle = drawLines(ctx, lines, {
      x: pad, y: firstBaseline, maxW, spec: titleSpec, color: ink, align: s.align || 'left',
      highlight: null, boldColor: ink,
    });

    // 부제
    if (subLines.length) {
      drawLines(ctx, subLines, {
        x: pad, y: afterTitle + 46, maxW: maxW * 0.94, spec: subSpec,
        color: subC, align: s.align || 'left',
      });
    }

    // 하단
    if (s.cover === 'frame') {
      label(ctx, (acct && acct.handle) || '', pad, g.footY, { size: 20, color: subC, tracking: 0.1, weight: 600, family: s.bodyFont, maxW: 500 });
      label(ctx, total > 1 ? '밀어서 보기  →' : '', W - pad, g.footY, { size: 20, color: subC, tracking: 0.06, weight: 600, align: 'right', maxW: 400 });
    } else {
      ctx.strokeStyle = onPhoto ? 'rgba(255,255,255,.28)' : s.rule;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(pad, g.footY - 40); ctx.lineTo(W - pad, g.footY - 40); ctx.stroke();
      label(ctx, (acct && acct.name) || 'MY MAGAZINE', pad, g.footY - 6, { size: 22, color: onPhoto ? 'rgba(255,255,255,.8)' : s.sub, tracking: 0.02, weight: 700, family: s.bodyFont, maxW: 600 });
      label(ctx, total > 1 ? '밀어서 보기  →' : '', W - pad, g.footY - 6, { size: 20, color: onPhoto ? 'rgba(255,255,255,.8)' : s.accent, tracking: 0.04, weight: 700, align: 'right', maxW: 400 });
    }
  }

  /* ---------- 속지 ---------- */
  function drawBody(ctx, card, s, g, state, pageNo, total) {
    const W = g.W;
    let onPhoto = false;
    if (card.photo && card.photo.src) {
      const bandH = Math.round(g.H * (card.photo.band === 'full' ? 1 : 0.46));
      const rect = { x: 0, y: 0, w: W, h: bandH };
      onPhoto = drawPhoto(ctx, card.photo, rect);
      if (onPhoto) {
        const dark = card.photo.dark == null ? (card.photo.band === 'full' ? 0.34 : 0.10) : card.photo.dark;
        ctx.fillStyle = 'rgba(0,0,0,' + dark + ')';
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        const br = card.photo.brightness || 0;
        if (br) {
          ctx.fillStyle = br > 0 ? 'rgba(255,255,255,' + (br * 0.5) + ')' : 'rgba(0,0,0,' + (-br * 0.6) + ')';
          ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        }
        if (card.photo.band !== 'full') {
          const grd = ctx.createLinearGradient(0, bandH - 140, 0, bandH + 80);
          grd.addColorStop(0, 'rgba(0,0,0,0)');
          grd.addColorStop(1, 'rgba(0,0,0,.28)');
          ctx.fillStyle = grd; ctx.fillRect(0, bandH - 140, W, 220);
        }
      }
    }
    const onFullPhoto = onPhoto && card.photo.band === 'full';
    const ink = onFullPhoto ? '#ffffff' : s.ink;
    const bodyC = onFullPhoto ? 'rgba(255,255,255,.92)' : s.body;
    const accent = onFullPhoto ? '#ffffff' : s.accent;

    const tag = { ...s, ink, accent };

    if (onFullPhoto) {
      // 사진 위 텍스트는 하단 그라데이션 위에
      const grd = ctx.createLinearGradient(0, g.H * 0.25, 0, g.H);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(0.55, 'rgba(0,0,0,.55)');
      grd.addColorStop(1, 'rgba(0,0,0,.85)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, W, g.H);
    }

    chapterTag(ctx, { ...card, label: card.label }, tag, g, pageNo, total);

    const ts = R.titleSpec(s, g.H > 1500 ? '9:16' : '4:5');
    let titleLines = [];
    const box0 = R.bodyBox(s, g.H > 1500 ? '9:16' : '4:5', 0);
    if (card.title) {
      titleLines = R.layout(card.title, box0.w, { ...ts, size: Math.round(ts.size) });
      if (titleLines.length > 3) titleLines = titleLines.slice(0, 3);
    }
    const titleTop = g.top + (s.headerBand ? 176 : 92);
    const box = R.bodyBox(s, g.H > 1500 ? '9:16' : '4:5', titleLines.length);

    // 본문 (자동 축소 → 그래도 넘치면 말줄임 + 경고)
    const text = card.body || '';
    let spec = R.bodySpec(s, g.H > 1500 ? '9:16' : '4:5');
    let plan = R.bodyLines(text, box.w, spec);
    let guard = 0;
    while (plan.lines * spec.size * spec.lineHeight > box.h && spec.size > 26 && guard < 24) {
      spec = { ...spec, size: spec.size - 1.5 };
      plan = R.bodyLines(text, box.w, spec);
      guard += 1;
    }
    let overflow = false;
    let blocks = plan.blocks;
    let lineH = spec.size * spec.lineHeight;
    let used = 0;
    const gap = plan.gap;
    const fit = [];
    for (const b of blocks) {
      const need = b.length * lineH + (fit.length ? gap : 0);
      if (used + need > box.h) {
        const remain = Math.max(0, Math.floor((box.h - used - (fit.length ? gap : 0)) / lineH));
        if (remain > 0) fit.push(b.slice(0, remain));
        overflow = true;
        break;
      }
      fit.push(b);
      used += need;
    }
    if (fit.length === 0 && text.trim()) { fit.push([]); overflow = true; }

    // 짧은 카드는 글이 위에 몰리지 않도록 살짝 아래로 균형을 잡습니다
    const contentBottom = g.H - g.bot - 74;
    const totalH = (titleLines.length ? titleLines.length * ts.size * 1.2 + 34 : 0) + used;
    const free = (contentBottom - titleTop) - totalH;
    const shiftMax = g.H > 1500 ? 420 : 170;
    const shift = free > 0 ? Math.min(free * (g.H > 1500 ? 0.44 : 0.3), shiftMax) : 0;
    if (titleLines.length) {
      drawLines(ctx, titleLines, {
        x: box0.x, y: titleTop + shift + ts.size * 0.84, maxW: box0.w, spec: ts, color: ink,
        align: s.align, highlight: onFullPhoto ? 'rgba(255,255,255,.26)' : s.highlight,
        boldColor: ink,
      });
    }

    let y = box.y + shift + spec.size * 0.86;
    fit.forEach((b, i) => {
      if (i) y += gap;
      y = drawLines(ctx, b, {
        x: box.x, y, maxW: box.w, spec, color: bodyC, align: s.align,
        highlight: onFullPhoto ? 'rgba(255,255,255,.26)' : s.highlight, boldColor: ink,
      });
    });
    if (overflow) {
      const last = fit[fit.length - 1];
      if (last && last.length) {
        const lastLine = last[last.length - 1];
        setFont(ctx, spec.family, spec.weight, spec.size);
        const tx = box.x + (s.align === 'center' ? (box.w - lastLine.w) / 2 : s.align === 'right' ? box.w - lastLine.w : 0);
        ctx.fillStyle = bodyC;
        ctx.fillText('…', tx + lastLine.w + 2, y - lineH);
      }
    }
    card._overflow = overflow;
    footer(ctx, { ...card }, { ...s, sub: onFullPhoto ? 'rgba(255,255,255,.6)' : s.sub, rule: onFullPhoto ? 'rgba(255,255,255,.2)' : s.rule }, g, state, pageNo, total);
  }

  /* ---------- 비교표 ---------- */
  function drawTable(ctx, card, s, g, state, pageNo, total) {
    chapterTag(ctx, card, s, g, pageNo, total);
    const rows = (card.rows && card.rows.length) ? card.rows : [['항목', '내용']];
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const ts = R.titleSpec(s, g.H > 1500 ? '9:16' : '4:5');
    let titleLines = [];
    const w = g.W - g.padX * 2;
    const titleTop = g.top + (s.headerBand ? 176 : 92);
    if (card.title) {
      titleLines = R.layout(card.title, w, momentSpec(ts)).slice(0, 2);
      drawLines(ctx, titleLines, { x: g.padX, y: titleTop + ts.size * 0.84, maxW: w, spec: momentSpec(ts), color: s.ink, align: s.align, highlight: s.highlight, boldColor: s.ink });
    }
    const top0 = titleTop + (titleLines.length ? titleLines.length * ts.size * 1.2 + 40 : 0) + 8;
    const bottom = g.H - g.bot - 90;
    const availH0 = bottom - top0;
    const rowH = clamp(Math.floor(availH0 / rows.length), 56, 168);
    const headH = Math.min(rowH, 96);
    const tableH = headH + rowH * (rows.length - 1);
    const top = top0 + Math.max(0, (availH0 - tableH) * 0.15);
    const cellPad = 20;
    const colW = [];
    for (let c = 0; c < cols; c++) colW.push(1);
    if (cols >= 3) colW[0] = 1.25;
    const totalW = colW.reduce((a, b) => a + b, 0);
    const widths = colW.map((v) => (v / totalW) * w);

    let y = top;
    ctx.save();
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const isHead = ri === 0;
      const h = isHead ? headH : rowH;
      if (isHead) {
        ctx.fillStyle = s.accent;
        roundRect(ctx, g.padX, y, w, h, 6);
        ctx.fill();
      } else if (ri % 2 === 0) {
        ctx.fillStyle = isDark(s.bg && s.bg.color) ? 'rgba(255,255,255,.05)' : 'rgba(20,20,25,.035)';
        ctx.fillRect(g.padX, y, w, h);
      }
      const cellSize = isHead ? 29 : (cols > 3 ? 26 : 31);
      const spec = { family: s.bodyFont, weight: isHead ? 800 : 500, size: cellSize, tracking: 0, lineHeight: 1.32 };
      let x = g.padX;
      for (let ci = 0; ci < cols; ci++) {
        const cw = widths[ci] || widths[widths.length - 1];
        const val = String((row && row[ci]) || '');
        const lines = R.layout(val, cw - cellPad * 2, spec).slice(0, 2);
        const lineH = spec.size * spec.lineHeight;
        const startY = y + (h - lines.length * lineH) / 2 + spec.size * 0.86;
        drawLines(ctx, lines, {
          x: x + cellPad, y: startY, maxW: cw - cellPad * 2, spec,
          color: isHead ? '#fff' : s.body, align: 'left',
        });
        if (ci > 0) {
          ctx.strokeStyle = isHead ? 'rgba(255,255,255,.25)' : s.rule;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x, y + (isHead ? 12 : 8)); ctx.lineTo(x, y + h - (isHead ? 12 : 8)); ctx.stroke();
        }
        x += cw;
      }
      y += h;
      ctx.strokeStyle = isHead ? 'rgba(0,0,0,.12)' : s.rule;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(g.padX, y); ctx.lineTo(g.padX + w, y); ctx.stroke();
    }
    ctx.restore();
    footer(ctx, card, s, g, state, pageNo, total);
  }

  function momentSpec(ts) { return { ...ts, lineHeight: 1.2 }; }

  /* ---------- 체크리스트 ---------- */
  function drawCheck(ctx, card, s, g, state, pageNo, total) {
    chapterTag(ctx, card, s, g, pageNo, total);
    const items = (card.items && card.items.length) ? card.items : [{ text: '항목', done: false }];
    const w = g.W - g.padX * 2;
    const ts = R.titleSpec(s, g.H > 1500 ? '9:16' : '4:5');
    let titleLines = [];
    const titleTop = g.top + (s.headerBand ? 176 : 92);
    if (card.title) {
      titleLines = R.layout(card.title, w, momentSpec(ts)).slice(0, 2);
      drawLines(ctx, titleLines, { x: g.padX, y: titleTop + ts.size * 0.84, maxW: w, spec: momentSpec(ts), color: s.ink, align: s.align, highlight: s.highlight, boldColor: s.ink });
    }
    const top = titleTop + (titleLines.length ? titleLines.length * ts.size * 1.2 + 42 : 0);
    const bottom = g.H - g.bot - 90;
    const few = items.length <= 4;
    const box = few ? 58 : 38;
    const rowH = clamp(Math.floor((bottom - top) * (few ? 0.88 : 0.95) / items.length), 78, few ? 220 : 150);
    let y = top + (few ? 18 : Math.max(0, (bottom - top - rowH * items.length) * 0.4));
    const spec = { family: s.bodyFont, weight: 500, size: few ? 47 : 31, tracking: 0, lineHeight: 1.34 };
    for (const it of items) {
      const cy = y + rowH / 2;
      ctx.lineWidth = 2;
      if (it.done) {
        ctx.fillStyle = s.accent;
        roundRect(ctx, g.padX, cy - box / 2, box, box, 7);
        ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(g.padX + box * 0.26, cy + 1);
        ctx.lineTo(g.padX + box * 0.44, cy + box * 0.2);
        ctx.lineTo(g.padX + box * 0.76, cy - box * 0.18);
        ctx.stroke();
      } else {
        ctx.strokeStyle = isDark(s.bg && s.bg.color) ? 'rgba(255,255,255,.35)' : 'rgba(20,20,25,.28)';
        roundRect(ctx, g.padX, cy - box / 2, box, box, 7);
        ctx.stroke();
      }
      const lines = R.layout(it.text || '', w - box - 30, spec).slice(0, 2);
      const lh = spec.size * spec.lineHeight;
      const startY = cy - (lines.length * lh) / 2 + spec.size * 0.84;
      drawLines(ctx, lines, {
        x: g.padX + box + 30, y: startY, maxW: w - box - 30, spec,
        color: it.done ? s.sub : s.body, align: 'left',
      });
      y += rowH;
    }
    footer(ctx, card, s, g, state, pageNo, total);
  }

  /* ---------- 마지막 장 ---------- */
  function drawEnd(ctx, card, s, g, state, pageNo, total) {
    const W = g.W, H = g.H, pad = g.padX;
    const acct = E.activeAccount(state) || { handle: '@my_magazine', name: '내 매거진', bio: '' };
    let onPhoto = false;
    if (card.photo && card.photo.src) {
      onPhoto = drawPhoto(ctx, card.photo, { x: 0, y: 0, w: W, h: H });
      if (onPhoto) {
        ctx.fillStyle = 'rgba(0,0,0,' + (card.photo.dark == null ? 0.55 : card.photo.dark) + ')';
        ctx.fillRect(0, 0, W, H);
      }
    }
    const ink = onPhoto ? '#fff' : s.ink;
    const sub = onPhoto ? 'rgba(255,255,255,.72)' : s.sub;

    if (s.frame) {
      ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 2;
      ctx.strokeRect(36, 36, W - 72, H - 72);
    }

    const cx = W / 2;
    label(ctx, 'THANK YOU', pad, g.top + 24, { size: 22, color: s.accent, tracking: 0.3, weight: 800, align: 'center', maxW: W - pad * 2 });
    const big = g.H > 1500;
    const k = big ? 1.32 : 1;
    const avatarR = Math.round(104 * k);
    const nameSize = Math.round(62 * k);
    const nameSpec = { family: s.titleFont, weight: s.titleWeight, size: nameSize, tracking: -0.02, lineHeight: 1.2 };
    const bioSpec = { family: s.bodyFont, weight: 400, size: Math.round(31 * k), tracking: 0, lineHeight: 1.56 };
    const bioLines = acct.bio ? R.layout(acct.bio, W - pad * 2 - 80, bioSpec).slice(0, 3) : [];
    const noteSpec = { family: s.bodyFont, weight: 500, size: Math.round(25 * k), tracking: 0, lineHeight: 1.5 };
    const noteLines = R.layout(card.body || '저장해두면 나중에 다시 보기 좋아요', W - pad * 2 - 40, noteSpec).slice(0, 2);
    const btnW = Math.round(348 * k), btnH = Math.round(96 * k);

    const hAvatar = avatarR * 2 + Math.round(82 * k);
    const hName = nameSize * 1.2 + Math.round(26 * k);
    const hHandle = Math.round(32 * k) * 1.3 + Math.round(30 * k);
    const hBio = bioLines.length ? bioLines.length * bioSpec.size * 1.56 + Math.round(42 * k) : 0;
    const hBtn = btnH + Math.round(64 * k);
    const hNote = noteLines.length * noteSpec.size * 1.5 + Math.round(20 * k);
    const totalH = hAvatar + hName + hHandle + hBio + hBtn + hNote;
    let cursor = Math.max(g.top + 6, (H - totalH) / 2 - (big ? 10 : 10));
    const avatarY = cursor + avatarR;

    // 아바타
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, avatarY, avatarR, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
    if (acct.avatar) {
      const img = R.getImage(acct.avatar);
      if (img && img.complete && img.naturalWidth) {
        const sc = Math.max((avatarR * 2) / img.naturalWidth, (avatarR * 2) / img.naturalHeight);
        ctx.drawImage(img, cx - img.naturalWidth * sc / 2, avatarY - img.naturalHeight * sc / 2, img.naturalWidth * sc, img.naturalHeight * sc);
      } else {
        ctx.fillStyle = s.accent; ctx.fillRect(cx - avatarR, avatarY - avatarR, avatarR * 2, avatarR * 2);
      }
    } else {
      ctx.fillStyle = onPhoto ? 'rgba(255,255,255,.92)' : s.accent;
      ctx.fillRect(cx - avatarR, avatarY - avatarR, avatarR * 2, avatarR * 2);
      const letter = (acct.logo || (acct.name || 'M').trim().charAt(0) || 'M').toUpperCase();
      setFont(ctx, s.titleFont, 800, avatarR * 0.92);
      ctx.fillStyle = isDark(s.accent) || onPhoto ? '#111111' : '#ffffff';
      ctx.textAlign = 'center';
      ctx.fillText(letter, cx, avatarY + avatarR * 0.32);
      ctx.textAlign = 'left';
    }
    ctx.restore();
    ctx.strokeStyle = onPhoto ? 'rgba(255,255,255,.5)' : s.accent;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(cx, avatarY, avatarR + 6, 0, Math.PI * 2); ctx.stroke();
    cursor += hAvatar;

    drawLines(ctx, R.layout(acct.name || '내 매거진', W - pad * 2, nameSpec), {
      x: pad, y: cursor + nameSize * 0.9, maxW: W - pad * 2, spec: nameSpec, color: ink, align: 'center',
    });
    cursor += hName;

    label(ctx, acct.handle || '@my_magazine', pad, cursor + Math.round(26 * k), { size: Math.round(32 * k), color: s.accent, tracking: 0.04, weight: 700, align: 'center', maxW: W - pad * 2, family: s.bodyFont });
    cursor += hHandle;

    if (bioLines.length) {
      drawLines(ctx, bioLines, {
        x: pad + 40, y: cursor + 24, maxW: W - pad * 2 - 80, spec: bioSpec, color: sub, align: 'center',
      });
      cursor += hBio;
    }

    // 팔로우 버튼
    const by = cursor;
    ctx.fillStyle = onPhoto ? '#fff' : s.accent;
    roundRect(ctx, cx - btnW / 2, by, btnW, btnH, btnH / 2);
    ctx.fill();
    setFont(ctx, s.bodyFont, 800, Math.round(34 * k));
    ctx.fillStyle = isDark(s.accent) || onPhoto ? '#111111' : '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('팔로우  +', cx, by + btnH / 2 + Math.round(12 * k));
    ctx.textAlign = 'left';
    cursor += hBtn;

    drawLines(ctx, noteLines, {
      x: pad + 20, y: cursor + 22, maxW: W - pad * 2 - 40, spec: noteSpec, color: sub, align: 'center',
    });
  }

  /* ---------- 카드 페인트 ---------- */
  R.paint = function (canvas, card, state, scale) {
    const g = R.geom(state.ratio);
    const sc = scale || 1;
    const pxW = Math.round(g.W * sc), pxH = Math.round(g.H * sc);
    if (canvas.width !== pxW || canvas.height !== pxH) { canvas.width = pxW; canvas.height = pxH; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    ctx.clearRect(0, 0, g.W, g.H);
    const s = E.resolveStyle(state, card);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    drawBackground(ctx, s, g);

    const idx = state.cards.indexOf(card);
    const pageNo = idx + 1;
    const total = state.cards.length;

    if (card.type === 'cover') drawCover(ctx, card, s, g, state, pageNo, total);
    else if (card.type === 'table') drawTable(ctx, card, s, g, state, pageNo, total);
    else if (card.type === 'check') drawCheck(ctx, card, s, g, state, pageNo, total);
    else if (card.type === 'end') drawEnd(ctx, card, s, g, state, pageNo, total);
    else drawBody(ctx, card, s, g, state, pageNo, total);

    return { overflow: !!card._overflow };
  };

  /* ---------- 폰트 준비 ---------- */
  R.ensureFonts = async function (state) {
    const fams = new Set();
    const fontId = state.fontId;
    E.TEMPLATES.forEach((t) => { fams.add(t.titleFont); fams.add(t.bodyFont); });
    if (fontId) fams.add(fontId);
    const jobs = [];
    fams.forEach((f) => {
      const stack = E.fontStack(f);
      [400, 500, 700, 800, 900].forEach((w) => {
        try { jobs.push(document.fonts.load(w + ' 40px ' + stack, '가나다 한글 Aa 0123')); } catch (e) { /* noop */ }
      });
    });
    try { await Promise.all(jobs); await document.fonts.ready; } catch (e) { /* noop */ }
  };
})();

/* ---------------------------------------------------------------
   Edito · core.js
   데이터 모델 / 템플릿 / 원고 파싱 / 카드 자동 생성 / 캡션 / 점검
--------------------------------------------------------------- */
(function () {
  'use strict';
  const E = (window.Edito = window.Edito || {});

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  let seq = 0;
  const uid = (p) => (p || 'id') + '_' + Date.now().toString(36) + '_' + (seq++).toString(36);
  E.uid = uid;

  /* ---------- 글꼴 ---------- */
  E.FONTS = {
    pretendard: { label: '프리텐다드', stack: "'Pretendard', -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif", display: false },
    serif: { label: '고운바탕', stack: "'Noto Serif KR', 'Nanum Myeongjo', 'Apple SD Gothic Neo', serif", display: false },
    black: { label: '블랙한산스', stack: "'Black Han Sans', 'Pretendard', sans-serif", display: true },
    dohyeon: { label: '도현', stack: "'Do Hyeon', 'Pretendard', sans-serif", display: true },
  };
  E.fontStack = (id) => (E.FONTS[id] || E.FONTS.pretendard).stack;

  /* ---------- 매거진 템플릿 ---------- */
  E.TEMPLATES = [
    {
      id: 'editorial', name: '에디토리얼', note: '화이트 · 산세리프',
      bg: { kind: 'solid', color: '#ffffff', tone: 'light' },
      ink: '#121212', body: '#2c2b29', sub: '#8d8983', rule: '#e5e1da',
      accent: '#e8462a', highlight: 'rgba(255,212,94,.75)',
      titleFont: 'pretendard', bodyFont: 'pretendard', titleWeight: 800, tracking: -0.035,
      cover: 'rule', label: 'plain', frame: false,
    },
    {
      id: 'dark', name: '다크 매거진', note: '블랙 · 라임',
      bg: { kind: 'solid', color: '#0f0f13', tone: 'dark' },
      ink: '#ffffff', body: '#dededf', sub: '#85858f', rule: '#2a2a31',
      accent: '#d8ff3e', highlight: 'rgba(216,255,62,.28)',
      titleFont: 'pretendard', bodyFont: 'pretendard', titleWeight: 800, tracking: -0.04,
      cover: 'bar', label: 'caps', frame: false,
    },
    {
      id: 'cream', name: '크림 페이퍼', note: '베이지 · 명조',
      bg: { kind: 'paper', color: '#f4ecdc', tone: 'light' },
      ink: '#2b2218', body: '#4c3d2d', sub: '#9a8a76', rule: '#ded1bb',
      accent: '#a6602c', highlight: 'rgba(196,138,72,.30)',
      titleFont: 'serif', bodyFont: 'serif', titleWeight: 700, tracking: -0.015,
      cover: 'ornament', label: 'plain', frame: false,
    },
    {
      id: 'orange', name: '오렌지 포인트', note: '아이보리 · 오렌지',
      bg: { kind: 'solid', color: '#fff7f0', tone: 'light' },
      ink: '#171310', body: '#3f342c', sub: '#a5907f', rule: '#f1ded0',
      accent: '#ff5a1f', highlight: 'rgba(255,148,80,.34)',
      titleFont: 'pretendard', bodyFont: 'pretendard', titleWeight: 900, tracking: -0.045,
      cover: 'band', label: 'block', frame: false,
    },
    {
      id: 'news', name: '뉴스 브리핑', note: '화이트 · 네이비',
      bg: { kind: 'solid', color: '#ffffff', tone: 'light' },
      ink: '#0b1b33', body: '#26364a', sub: '#7c8ba0', rule: '#dfe6ef',
      accent: '#12408c', highlight: 'rgba(18,64,140,.14)',
      titleFont: 'pretendard', bodyFont: 'pretendard', titleWeight: 800, tracking: -0.03,
      cover: 'box', label: 'box', headerBand: true, frame: false,
    },
    {
      id: 'film', name: '사진 무드', note: '다크 · 그레인',
      bg: { kind: 'grain', color: '#141318', tone: 'dark' },
      ink: '#f7f4ef', body: '#e3ded6', sub: '#9c978f', rule: 'rgba(255,255,255,.18)',
      accent: '#ffcf6b', highlight: 'rgba(255,207,107,.26)',
      titleFont: 'serif', bodyFont: 'pretendard', titleWeight: 700, tracking: -0.01,
      cover: 'frame', label: 'caps', frame: true,
    },
  ];

  /* ---------- 배경 ---------- */
  E.BACKGROUNDS = [
    { id: 'template', name: '템플릿 기본' },
    { id: 'white', name: '화이트' },
    { id: 'cream', name: '크림' },
    { id: 'grid', name: '모눈' },
    { id: 'dots', name: '도트' },
    { id: 'film', name: '다크 필름' },
    { id: 'gradient', name: '그라데이션' },
  ];

  function bgFromPreset(id, t) {
    switch (id) {
      case 'white': return { kind: 'solid', color: '#ffffff', tone: 'light' };
      case 'cream': return { kind: 'paper', color: '#f6efe2', tone: 'light' };
      case 'grid': return { kind: 'grid', color: '#fbfaf7', tone: 'light' };
      case 'dots': return { kind: 'dots', color: '#fbfaf7', tone: 'light' };
      case 'film': return { kind: 'grain', color: '#0f0f13', tone: 'dark' };
      case 'gradient': return { kind: 'gradient', from: '#1c1c26', to: '#07070a', glow: 'rgba(255,110,70,.30)', tone: 'dark' };
      default: return t.bg;
    }
  }

  /* ---------- 스타일 계산 ---------- */
  function isDark(hex) {
    if (!hex || typeof hex !== 'string') return false;
    const s = hex.trim();
    if (s[0] !== '#') return false;
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b < 118;
  }
  E.isDark = isDark;

  E.resolveStyle = function (state, card) {
    const t = E.TEMPLATES.find((x) => x.id === state.templateId) || E.TEMPLATES[0];
    const bg = (state.backgroundId && state.backgroundId !== 'template') ? bgFromPreset(state.backgroundId, t) : t.bg;
    const bgDark = bg.tone === 'dark' || bg.kind === 'grain' || bg.kind === 'gradient';
    const s = {
      template: t,
      bg: bg,
      ink: t.ink, body: t.body, sub: t.sub, rule: t.rule,
      accent: t.accent, highlight: t.highlight,
      titleFont: t.titleFont, bodyFont: t.bodyFont, titleWeight: t.titleWeight,
      tracking: t.tracking,
      align: state.align || 'left',
      titleScale: state.titleScale || 1,
      bodyScale: (state.bodyScale || 1) * (state.density === 'tight' ? 0.90 : 1.06),
      lineHeight: (state.lineHeight || 1.62) * (state.density === 'tight' ? 0.94 : 1.04),
      density: state.density,
      cover: t.cover, label: t.label, frame: t.frame, headerBand: t.headerBand,
      bgDark: bgDark,
    };
    if (bgDark === isDark(t.ink)) {
      if (bgDark) { s.ink = '#ffffff'; s.body = '#e9e5de'; s.sub = '#a5a09a'; s.rule = 'rgba(255,255,255,.18)'; }
      else { s.ink = '#161513'; s.body = '#35322e'; s.sub = '#8b8780'; s.rule = 'rgba(0,0,0,.13)'; }
    }
    if (bgDark && isDark(t.accent)) s.accent = '#ffcf6b';
    if (!bgDark && !isDark(t.accent) && t.accent.toLowerCase() === '#d8ff3e') s.accent = '#e8462a';
    if (bgDark && t.id !== 'dark' && t.id !== 'film') s.highlight = 'rgba(255,255,255,.24)';

    if (state.fontId) {
      const f = E.FONTS[state.fontId];
      if (f) {
        s.titleFont = state.fontId;
        s.bodyFont = f.display ? t.bodyFont : state.fontId;
      }
    }
    if (state.ink) s.ink = state.ink;
    if (state.bodyColor) s.body = state.bodyColor;
    if (state.accent) s.accent = state.accent;
    if (state.highlight) s.highlight = state.highlight;
    if (state.tracking != null) s.tracking = state.tracking;

    const ov = card && card.ov ? card.ov : null;
    if (ov) {
      ['ink', 'bodyColor', 'accent', 'highlight', 'align', 'fontId', 'titleScale', 'bodyScale', 'tracking'].forEach((k) => {
        if (ov[k] != null) {
          if (k === 'bodyColor') s.body = ov[k];
          else if (k === 'fontId') {
            const f = E.FONTS[ov[k]];
            if (f) { s.titleFont = ov[k]; s.bodyFont = f.display ? t.bodyFont : ov[k]; }
          } else if (k === 'align') s.align = ov[k];
          else s[k] = ov[k];
        }
      });
    }
    return s;
  };

  /* ---------- 상태 ---------- */
  const KEY = 'edito.state.v1';
  E.DEFAULT_STATE = {
    v: 1,
    ratio: '4:5',
    density: 'loose',
    addCTA: true,
    templateId: 'editorial',
    backgroundId: 'template',
    fontId: null,
    align: 'left',
    titleScale: 1,
    bodyScale: 1,
    lineHeight: 1.62,
    tracking: null,
    ink: null, bodyColor: null, accent: null, highlight: null,
    accounts: [{ id: 'acc_main', handle: '@my_magazine', name: '내 매거진', bio: '기록하고 싶은 것들을 모읍니다', logo: 'M', avatar: null }],
    accountId: 'acc_main',
    savedStyles: [],
    source: '',
    cards: [],
    caption: null,
    cardIndex: 0,
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  E.freshState = function () {
    const s = clone(E.DEFAULT_STATE);
    s.accounts = clone(E.DEFAULT_STATE.accounts);
    return s;
  };

  E.loadState = function () {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return E.freshState();
      const saved = JSON.parse(raw);
      const s = Object.assign(E.freshState(), saved || {});
      if (!Array.isArray(s.accounts) || !s.accounts.length) s.accounts = clone(E.DEFAULT_STATE.accounts);
      if (!Array.isArray(s.cards)) s.cards = [];
      if (!Array.isArray(s.savedStyles)) s.savedStyles = [];
      return s;
    } catch (e) {
      return E.freshState();
    }
  };

  let saveTimer = null;
  E.saveState = function (state, immediate) {
    clearTimeout(saveTimer);
    const doSave = () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
        return true;
      } catch (e) {
        E.lastSaveError = e;
        return false;
      }
    };
    if (immediate) return doSave();
    saveTimer = setTimeout(doSave, 500);
    return true;
  };

  E.activeAccount = function (state) {
    if (!state || !state.accounts || !state.accounts.length) return null;
    return state.accounts.find((a) => a.id === state.accountId) || state.accounts[0];
  };

  /* ---------- 원고 파싱 ---------- */
  E.parseSource = function (raw) {
    const lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const text = buf.join('\n').trim();
      if (text) blocks.push({ type: 'para', text });
      buf = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) { flush(); continue; }

      if (/^(?:[-*_=]\s*){3,}$/.test(t) || /^[-*_]{3,}$/.test(t)) { flush(); blocks.push({ type: 'break' }); continue; }

      const h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flush(); blocks.push({ type: h[1].length >= 2 ? 'h2' : 'h1', text: h[2].trim() }); continue; }

      const num = t.match(/^(\d{1,2})[.)]\s+(.{1,40})$/);
      if (num && !/[.!?。]$/.test(t)) {
        // 앞뒤로 이어지는 번호가 있으면 제목이 아니라 목록으로 봅니다 (1. 2. 3.)
        let isList = false;
        let prevNum = null;
        for (let k = i - 1; k >= 0 && k >= i - 2; k--) {
          const pt = lines[k].trim();
          if (!pt) continue;
          const pm = pt.match(/^(\d{1,2})[.)]\s+/);
          if (pm) prevNum = Number(pm[1]);
          break;
        }
        if (prevNum !== null && Number(num[1]) === prevNum + 1) isList = true;
        for (let k = i + 1; k < Math.min(lines.length, i + 3); k++) {
          const nt = lines[k].trim();
          if (!nt) continue;
          const nm = nt.match(/^(\d{1,2})[.)]\s+/);
          if (nm && Number(nm[1]) === Number(num[1]) + 1) isList = true;
          break;
        }
        if (!isList) { flush(); blocks.push({ type: 'h2', text: num[2].trim(), num: num[1] }); continue; }
      }

      if (t[0] === '|') {
        flush();
        const rows = [];
        let j = i;
        while (j < lines.length && lines[j].trim()[0] === '|') {
          const cells = lines[j].trim().split('|').map((c) => c.trim());
          if (cells.length && cells[0] === '') cells.shift();
          if (cells.length && cells[cells.length - 1] === '') cells.pop();
          if (cells.length && !cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
          j += 1;
        }
        i = j - 1;
        if (rows.length) blocks.push({ type: 'table', rows: rows });
        continue;
      }

      if (/^[-*+]\s+\[[ xX]\]/.test(t) || /^[□☐☑✔✓]/.test(t)) {
        flush();
        const items = [];
        let j = i;
        while (j < lines.length) {
          const tt = lines[j].trim();
          const m1 = tt.match(/^[-*+]\s+\[([ xX])\]\s*(.+)$/);
          const m2 = tt.match(/^([□☐☑✔✓])\s*(.+)$/);
          if (m1) items.push({ text: m1[2].trim(), done: /[xX]/.test(m1[1]) });
          else if (m2) items.push({ text: m2[2].trim(), done: '☑✔✓'.indexOf(m2[1]) >= 0 });
          else break;
          j += 1;
        }
        i = j - 1;
        if (items.length) blocks.push({ type: 'check', items: items });
        continue;
      }

      if (/^>\s?/.test(t)) { flush(); blocks.push({ type: 'quote', text: t.replace(/^>\s?/, '') }); continue; }

      buf.push(t);
    }
    flush();
    return blocks;
  };

  /* ---------- 카드 자동 생성 ---------- */
  E.buildCards = function (state) {
    const R = E.Render;
    if (!R) return [];
    const ratio = state.ratio;
    const g = R.geom(ratio);
    const style = E.resolveStyle(state, null);
    const maxW = g.W - g.padX * 2;
    const bodySpec = R.bodySpec(style, ratio);
    const titleSpec = R.titleSpec(style, ratio);
    const count = (t) => R.countLines(t, maxW, bodySpec);
    const titleLinesOf = (t) => (t ? Math.min(3, R.countLines(t, maxW, titleSpec)) : 0);

    const blocks = E.parseSource(state.source);
    if (!blocks.length) return [];

    const cards = [];
    const old = state.cards || [];
    let ci = 0;
    const addCard = (card) => {
      const prev = old[ci];
      card.id = uid('card');
      if (prev) {
        if (prev.photo && card.type !== 'table' && card.type !== 'check') card.photo = prev.photo;
        if (prev.ov) card.ov = prev.ov;
        if (prev.kicker && card.type === 'cover') card.kicker = prev.kicker;
      }
      cards.push(card);
      ci += 1;
    };

    /* 표지 */
    let i = 0;
    while (i < blocks.length && blocks[i].type === 'break') i++;
    if (i >= blocks.length) return [];
    let coverTitle = '', coverSub = '';
    const first = blocks[i];
    if (first.type === 'h1' || first.type === 'h2') {
      coverTitle = first.text;
      i += 1;
      if (i < blocks.length && blocks[i].type === 'para' && blocks[i].text.length <= 140) {
        coverSub = blocks[i].text.replace(/\n+/g, ' ');
        i += 1;
      }
    } else if (first.type === 'para') {
      const ls = first.text.split('\n');
      coverTitle = ls[0];
      coverSub = ls.slice(1).join(' ');
      i += 1;
    } else {
      coverTitle = '카드뉴스';
    }
    addCard({ type: 'cover', title: coverTitle, subtitle: coverSub, kicker: '' });

    /* 본문 */
    let chapterNo = 0;
    let curLabel = 'PART 01';
    let cur = null;
    const flushGroup = () => {
      if (!cur) return;
      const tLines = titleLinesOf(cur.title);
      const capFirst = R.capacity(style, ratio, tLines);
      const capNext = R.capacity(style, ratio, 0);
      const packed = packParagraphs(cur.paras, capFirst, capNext, count);
      if (!packed.length && cur.title) {
        addCard({ type: 'body', label: cur.label, title: cur.title, body: '' });
      }
      packed.forEach((text, k) => {
        addCard({ type: 'body', label: cur.label, title: k === 0 ? cur.title : '', body: text });
      });
      cur = null;
    };
    const newGroup = (title) => {
      flushGroup();
      chapterNo += 1;
      curLabel = 'PART ' + pad2(chapterNo);
      cur = { label: curLabel, title: title || '', paras: [] };
    };

    for (; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.type === 'break') { flushGroup(); continue; }
      if (b.type === 'h1' || b.type === 'h2') { newGroup(b.text); continue; }
      if (b.type === 'para' || b.type === 'quote') {
        if (!cur) newGroup(null);
        cur.paras.push(b.text);
        continue;
      }
      if (b.type === 'table' || b.type === 'check') {
        // 바로 앞 소제목은 표/체크 카드의 제목이 됩니다 (빈 속지 카드를 만들지 않음)
        let cardTitle = '';
        if (cur && !cur.paras.length) {
          cardTitle = cur.title || '';
          cur = null;
        } else {
          flushGroup();
        }
        const card = { type: b.type, label: curLabel || 'PART 01', title: cardTitle };
        if (b.type === 'table') card.rows = b.rows;
        else card.items = b.items;
        addCard(card);
        continue;
      }
    }
    flushGroup();

    if (state.addCTA) addCard({ type: 'end', title: '', body: '' });

    return cards;
  };

  function sentenceSpans(text) {
    const spans = [];
    let start = 0;
    const re = /[.!?…]["'”’)\]]?\s+/g;
    let m;
    while ((m = re.exec(text))) {
      spans.push([start, m.index + 1]);
      start = m.index + m[0].length;
    }
    if (start < text.length) spans.push([start, text.length]);
    return spans;
  }

  function takeFitting(text, avail, count) {
    if (avail < 1) return { head: '', tail: text };
    const spans = sentenceSpans(text);
    let cut = -1;
    for (const sp of spans) {
      const t = text.slice(0, sp[1]);
      if (count(t.trim()) <= avail) cut = sp[1];
      else break;
    }
    if (cut > 0) {
      return { head: text.slice(0, cut).trim(), tail: text.slice(cut).trim() };
    }
    // 문장 단위로 안 되면 단어 단위
    const parts = text.split(/(\s+)/);
    let acc = '';
    for (const p of parts) {
      const test = acc + p;
      if (count(test.trim()) <= avail) acc = test;
      else break;
    }
    if (acc.trim()) {
      return { head: acc.trim(), tail: text.slice(acc.length).trim() };
    }
    // 그래도 안 되면 글자 단위
    let n = 0;
    for (let k = 1; k <= text.length; k++) {
      if (count(text.slice(0, k).trim()) <= avail) n = k;
      else break;
    }
    if (n > 1) return { head: text.slice(0, n).trim(), tail: text.slice(n).trim() };
    return { head: '', tail: text };
  }

  function packParagraphs(paras, capFirst, capNext, count) {
    const out = [];
    let cur = { texts: [], lines: 0, cap: capFirst };
    const flush = () => {
      if (cur.texts.length) out.push(cur.texts.join('\n\n'));
      cur = { texts: [], lines: 0, cap: capNext };
    };
    for (const pRaw of paras) {
      let rest = String(pRaw || '').trim();
      let guard = 0;
      while (rest && guard < 60) {
        guard += 1;
        const gap = cur.texts.length ? 1 : 0;
        const avail = cur.cap - cur.lines - gap;
        const lc = count(rest);
        if (lc <= avail) {
          cur.texts.push(rest);
          cur.lines += lc + gap;
          rest = '';
        } else if (avail <= 1) {
          flush();
        } else {
          const piece = takeFitting(rest, avail, count);
          if (!piece.head) { flush(); continue; }
          cur.texts.push(piece.head);
          flush();
          rest = piece.tail;
        }
      }
      if (guard >= 60 && rest) {
        // 안전장치: 남은 텍스트는 그대로 붙임
        cur.texts.push(rest);
      }
    }
    flush();
    return out.filter((t) => t && t.trim());
  }

  /* ---------- 캡션 초안 ---------- */
  const STOP = ['그리고', '하지만', '그래서', '그러면', '합니다', '했습니다', '있습니다', '없습니다', '이렇게', '저렇게', '때문에', '위해서', '여러분', '오늘은', '이번에', '정말', '너무', '아주', '많이', '다시', '우리', '저는', '제가', '것이', '것을', '하는', '있는', '되는', '대한', '모두', '조금', '바로', '함께', '이런', '그런', '저런', '보다', '부터', '까지', '에서', '으로', '라고', '하고', '하면', '한번'];

  function plain(text) {
    return String(text || '')
      .replace(/\*\*/g, '')
      .replace(/==/g, '')
      .replace(/^#+\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  E.plain = plain;

  E.keywords = function (state) {
    const text = [state.source || ''].concat((state.cards || []).map((c) => (c.title || '') + ' ' + (c.body || ''))).join(' ');
    const words = plain(text).replace(/[^가-힣a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const freq = new Map();
    for (const w of words) {
      if (w.length < 2 || w.length > 9) continue;
      if (/^\d+$/.test(w)) continue;
      if (STOP.indexOf(w) >= 0) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, 5)
      .map((x) => x[0]);
  };

  E.hashtags = function (state) {
    const base = ['카드뉴스', '인스타카드뉴스', '매거진', '기록'];
    const keys = E.keywords(state);
    const acct = E.activeAccount(state);
    const tags = base.concat(keys).map((t) => '#' + t.replace(/\s+/g, ''));
    if (acct && acct.handle) {
      const h = acct.handle.replace(/^@/, '').replace(/[^0-9a-zA-Z가-힣._]/g, '');
      if (h) tags.unshift('#' + h);
    }
    return Array.from(new Set(tags)).slice(0, 12).join(' ');
  };

  E.caption = function (state) {
    const cards = state.cards || [];
    const cover = cards.find((c) => c.type === 'cover') || {};
    const body = cards.filter((c) => c.type === 'body');
    const acct = E.activeAccount(state);
    const title = plain(cover.title) || '오늘의 카드뉴스';
    const sub = plain(cover.subtitle);
    const points = [];
    body.forEach((c) => {
      if (c.title && points.length < 4) points.push('· ' + plain(c.title));
    });
    const first = body.find((c) => c.body);
    let lead = sub;
    if (!lead && first) {
      const s = plain(first.body).split(/(?<=[.!?])\s/)[0];
      lead = s.slice(0, 90);
    }
    const lines = [title];
    if (lead) lines.push('', lead);
    if (points.length) lines.push('', points.join('\n'));
    lines.push('', '저장해두고 필요할 때 꺼내보세요.');
    if (acct && acct.handle) lines.push('더 많은 카드뉴스는 ' + acct.handle);
    lines.push('', E.hashtags(state));
    return lines.join('\n');
  };

  /* ---------- 글 점검 ---------- */
  E.fixQuotes = function (text) {
    let out = '';
    let open = true;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') { out += open ? '“' : '”'; open = !open; }
      else if (ch === "'") { out += '’'; }
      else out += ch;
    }
    return out;
  };

  E.fixSpaces = function (text) {
    return String(text || '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.!?…·、])/g, '$1')
      .replace(/([(\[{])\s+/g, '$1')
      .replace(/\s+([)\]}])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
      .trim();
  };

  E.textIssues = function (state) {
    const list = [];
    const src = state.source || '';
    const straight = (src.match(/["']/g) || []).length;
    if (straight) {
      list.push({ level: 'warn', code: 'quotes', text: '곧은 따옴표가 ' + straight + '개 있어요. 둥근 따옴표로 바꾸면 훨씬 자연스러워요.', action: 'quotes' });
    }
    const dbl = (src.match(/[ \t]{2,}/g) || []).length;
    if (dbl) {
      list.push({ level: 'warn', code: 'spaces', text: '중복 공백이 ' + dbl + '곳 있어요. 한 칸으로 정리할 수 있어요.', action: 'spaces' });
    }
    const beforePunct = (src.match(/[ \t]+[,.!?]/g) || []).length;
    if (beforePunct) {
      list.push({ level: 'warn', code: 'punct', text: '문장부호 앞 공백이 ' + beforePunct + '곳 있어요.', action: 'spaces' });
    }
    (state.cards || []).forEach((c, idx) => {
      if (c._overflow) {
        list.push({ level: 'warn', code: 'overflow', text: '카드 ' + (idx + 1) + '의 글이 길어서 일부가 잘렸어요. 문장을 줄이거나 원고에서 장을 나눠보세요.', cardIndex: idx });
      }
      if (c.type === 'cover' && c.title && c.title.length > 34) {
        list.push({ level: 'warn', code: 'coverTitle', text: '표지 제목이 ' + c.title.length + '자로 깁니다. 20자 안팎이면 표지에서 가장 잘 보여요.', cardIndex: idx });
      }
    });
    if (!list.length) {
      list.push({ level: 'ok', code: 'clean', text: '따옴표, 공백, 넘침 모두 깔끔해요.' });
    }
    const hasHl = /(\*\*|==)/.test(src);
    if (!hasHl) {
      list.push({ level: 'tip', code: 'hl', text: '**이렇게** 쓰면 형광펜 강조가 들어가요. 카드마다 한 곳만 강조하면 눈에 잘 들어옵니다.' });
    }
    return list;
  };

  /* ---------- 카드 타입 변환 도우미 ---------- */
  E.cardToText = function (card) {
    if (card.type === 'table') {
      return (card.rows || []).map((r) => r.join(' | ')).join('\n');
    }
    if (card.type === 'check') {
      return (card.items || []).map((it) => (it.done ? '- [x] ' : '- [ ] ') + it.text).join('\n');
    }
    return card.body || '';
  };

  E.textToCard = function (card, text) {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (card.type === 'table') {
      card.rows = lines.map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      if (!card.rows.length) card.rows = [['항목', '내용']];
    } else if (card.type === 'check') {
      card.items = lines.map((l) => {
        const m = l.match(/^(?:[-*+]\s*)?\[([ xX])\]\s*(.*)$/);
        if (m) return { text: m[2], done: /[xX]/.test(m[1]) };
        return { text: l.replace(/^[□☐☑✔✓]\s*/, ''), done: /^[☑✔✓]/.test(l) };
      });
      if (!card.items.length) card.items = [{ text: '할 일', done: false }];
    } else {
      card.body = text;
    }
  };

  /* ---------- 데모 원고 ---------- */
  E.DEMO_TEXT = [
    '기록이 어려운 진짜 이유',
    '완벽을 버리면 첫 장이 쉬워집니다',
    '',
    '# 왜 첫 장에서 멈출까',
    '노트를 새로 사고 펜을 고르는 데 하루를 썼습니다. 정작 첫 줄을 쓰는 데는 5분도 걸리지 않는데 말이죠.',
    '기록은 남에게 보여주기 위한 것이 아니라 **지난 나를 다시 만나는 일**에 가깝습니다. 그래서 잘 쓰는 것보다 다시 꺼내보는 게 중요합니다.',
    '',
    '# 오늘 바로 쓰는 3가지',
    '1. 오늘 가장 오래 붙잡고 있던 생각 한 줄',
    '2. 마음에 남은 사진 한 장과 짧은 설명',
    '3. 내일의 나에게 남기는 메모 한 문장',
    '',
    '---',
    '# 방식별 비교',
    '| 방식 | 걸리는 시간 | 추천하는 사람 |',
    '| 메모 앱 | 1분 | 검색이 필요한 사람 |',
    '| 종이 노트 | 5분 | 손으로 정리하는 사람 |',
    '| 카드뉴스 | 10분 | 공유하고 싶은 사람 |',
    '',
    '# 시작 전 체크리스트',
    '- [x] 기록할 시간 정하기',
    '- [ ] 쓰고 싶은 주제 3개 적기',
    '- [ ] 오늘 첫 장 남겨보기',
  ].join('\n');
})();

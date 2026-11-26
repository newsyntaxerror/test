/* ---------------------------------------------------------------
   Edito · app.js
   화면 · 시트 UI · 사진 편집 · 내보내기(PNG/ZIP) · PWA
--------------------------------------------------------------- */
(function () {
  'use strict';
  const E = window.Edito;
  const R = E.Render;
  const $ = (id) => document.getElementById(id);
  const pad2 = (n) => String(n).padStart(2, '0');

  let state = E.loadState();
  let currentSheet = null;
  let coverGuideOn = false;
  let photoMode = false;
  let pendingUpload = null;      // {kind:'photo'|'avatar', cardIndex, accountId}
  let drag = null;
  let modalUrl = null;
  let busyDepth = 0;
  let saveTimerForUi = null;

  const track = $('track');
  const stage = $('stage');
  const toastEl = $('toast');

  const TITLES = { source: '원고', design: '디자인', card: '카드 편집', check: '점검', save: '저장 · 내보내기' };

  /* =========================================================
     유틸
  ========================================================= */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const raf = (fn) => { let id = null; return function () { if (id) return; id = requestAnimationFrame(() => { id = null; fn(); }); }; };

  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), ms || 2200);
  }

  function save() {
    const ok = E.saveState(state);
    if (ok) { clearTimeout(saveTimerForUi); saveTimerForUi = setTimeout(() => { E.saveState(state, true); }, 450); }
    return ok;
  }

  function showBusy(text) {
    busyDepth += 1;
    $('busyText').textContent = text || '만드는 중…';
    $('busy').hidden = false;
  }
  function hideBusy() {
    busyDepth = Math.max(0, busyDepth - 1);
    if (!busyDepth) $('busy').hidden = true;
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 20000);
  }

  function activeCard() { return state.cards[state.cardIndex] || null; }

  /* =========================================================
     레이아웃 · 카드 트랙
  ========================================================= */
  function layout() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const ar = state.ratio === '9:16' ? 9 / 16 : 4 / 5;
    const maxW = Math.max(180, Math.min(w * 0.9, (h - 18) * ar));
    document.documentElement.style.setProperty('--card-w', Math.round(maxW) + 'px');
  }

  function buildTrack() {
    track.innerHTML = '';
    state.cards.forEach((card, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'card';
      wrap.dataset.i = String(i);
      const inner = document.createElement('div');
      inner.className = 'card-inner';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', (i + 1) + '번째 카드');
      inner.appendChild(canvas);
      const badge = document.createElement('span');
      badge.className = 'card-badge';
      badge.hidden = true;
      badge.textContent = '글 넘침';
      inner.appendChild(badge);
      wrap.appendChild(inner);
      track.appendChild(wrap);
      bindCard(wrap, inner, canvas, card);
    });
    layout();
    renderAll();
    goTo(state.cardIndex, false);
    updateMeter();
    updateGuide();
    showEmpty(!state.cards.length);
  }

  function paintCard(canvas, card) {
    try {
      R.paint(canvas, card, state, 0.62);
    } catch (e) {
      console.error(e);
    }
  }

  function renderAll() {
    const cans = track.querySelectorAll('.card-inner canvas');
    state.cards.forEach((card, i) => { if (cans[i]) paintCard(cans[i], card); });
    updateBadges();
    updateMiniStrip();
    updateGuide();
  }
  const renderSoon = raf(renderAll);

  function updateBadges() {
    state.cards.forEach((card, i) => {
      const wrap = track.children[i];
      if (!wrap) return;
      const badge = wrap.querySelector('.card-badge');
      if (badge) badge.hidden = !card._overflow;
    });
  }

  function goTo(i, smooth) {
    const idx = Math.max(0, Math.min(state.cards.length - 1, i));
    state.cardIndex = idx;
    const left = idx * track.clientWidth;
    if (smooth === false) track.scrollLeft = left;
    else track.scrollTo({ left: left, behavior: 'smooth' });
    updateMeter();
    updateGuide();
  }

  function updateMeter() {
    const total = state.cards.length;
    $('cardNo').textContent = total ? String(state.cardIndex + 1) : '0';
    $('cardTotal').textContent = String(total);
    const dots = $('dots');
    if (dots.children.length !== total) {
      dots.innerHTML = '';
      for (let i = 0; i < total; i++) {
        const d = document.createElement('span');
        d.className = 'dot' + (i === state.cardIndex ? ' on' : '');
        dots.appendChild(d);
      }
    } else {
      Array.from(dots.children).forEach((d, i) => d.classList.toggle('on', i === state.cardIndex));
    }
    const card = activeCard();
    const labels = { cover: '표지', body: '속지', table: '비교표', check: '체크리스트', end: '마지막 장' };
    $('cardLabel').textContent = card ? (labels[card.type] || '속지') : '—';
  }

  function showEmpty(on) {
    $('empty').hidden = !on;
    $('meter').style.visibility = on ? 'hidden' : '';
  }

  /* =========================================================
     카드 상호작용 (탭 → 편집, 사진 드래그)
  ========================================================= */
  function bindCard(wrap, inner, canvas, card) {
    let tapStart = null;
    canvas.addEventListener('pointerdown', (ev) => {
      tapStart = { x: ev.clientX, y: ev.clientY, t: Date.now() };
      if (photoMode && card.photo) {
        ev.preventDefault();
        drag = { x: ev.clientX, y: ev.clientY, px: card.photo.x || 0, py: card.photo.y || 0, card, canvas, moved: false };
        canvas.style.cursor = 'grabbing';
        try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* noop */ }
      }
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!drag || drag.canvas !== canvas) return;
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const dx = (ev.clientX - drag.x) / Math.max(1, rect.width);
      const dy = (ev.clientY - drag.y) / Math.max(1, rect.width);
      card.photo.x = Math.max(-1, Math.min(1, drag.px + dx * 2));
      card.photo.y = Math.max(-1, Math.min(1, drag.py + dy * 2));
      drag.moved = true;
      paintCard(canvas, card);
    });
    const endDrag = () => {
      if (drag) {
        canvas._moved = drag.moved;
        drag = null;
        canvas.style.cursor = '';
        save();
        updateMiniStrip();
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('click', (ev) => {
      if (tapStart && (Math.abs(ev.clientX - tapStart.x) > 12 || Math.abs(ev.clientY - tapStart.y) > 12)) return;
      if (photoMode && canvas._moved) { canvas._moved = false; return; }
      const i = state.cards.indexOf(card);
      if (i < 0) return;
      state.cardIndex = i;
      updateMeter();
      openSheet('card');
    });
  }

  /* 스크롤 → 현재 카드 */
  let scrollT = null;
  track.addEventListener('scroll', () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const w = track.clientWidth || 1;
      const i = Math.round(track.scrollLeft / w);
      if (i !== state.cardIndex) {
        state.cardIndex = Math.max(0, Math.min(state.cards.length - 1, i));
        updateMeter();
        updateGuide();
        if (currentSheet === 'card') refreshCardSheet();
      }
    }, 70);
  }, { passive: true });

  window.addEventListener('resize', () => { layout(); updateGuide(); });
  window.addEventListener('orientationchange', () => setTimeout(() => { layout(); updateGuide(); }, 250));

  /* =========================================================
     표지 점검 가이드
  ========================================================= */
  function setGuide(on) {
    coverGuideOn = on;
    updateGuide();
  }
  function updateGuide() {
    const el = $('coverGuide');
    if (!coverGuideOn) { el.hidden = true; return; }
    const card = activeCard();
    const inner = track.children[state.cardIndex] && track.children[state.cardIndex].querySelector('.card-inner');
    if (!card || card.type !== 'cover' || !inner) { el.hidden = true; return; }
    const r = inner.getBoundingClientRect();
    el.hidden = false;
    el.style.left = r.left + 'px';
    el.style.top = r.top + 'px';
    el.style.width = r.width + 'px';
    el.style.height = r.height + 'px';
    const band = Math.max(0, (r.height - r.width) / 2);
    el.querySelector('.top').style.height = band + 'px';
    el.querySelector('.bottom').style.height = band + 'px';
    const lab = el.querySelector('.cover-guide-label');
    lab.style.display = band > 30 ? 'block' : 'none';
  }

  /* =========================================================
     시트
  ========================================================= */
  const SHEETS = {};

  function openSheet(name) {
    const sheet = SHEETS[name];
    if (!sheet) return;
    currentSheet = name;
    $('sheetTitle').textContent = TITLES[name] || name;
    $('sheetBody').innerHTML = sheet.html();
    $('sheetWrap').hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => $('sheetWrap').classList.add('open'));
    const body = $('sheetBody');
    body.scrollTop = 0;
    if (sheet.bind) sheet.bind(body);
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.sheet === name));
  }

  function closeSheet() {
    $('sheetWrap').classList.remove('open');
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
    currentSheet = null;
    document.body.style.overflow = '';
    setTimeout(() => {
      if (!$('sheetWrap').classList.contains('open')) {
        $('sheetWrap').hidden = true;
        $('sheetBody').innerHTML = '';
      }
    }, 300);
    updateGuide();
  }

  $('sheetClose').addEventListener('click', closeSheet);
  $('scrim').addEventListener('click', closeSheet);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => openSheet(t.dataset.sheet)));

  /* 시트 드래그로 닫기 */
  (function () {
    let sy = null, dy = 0;
    const sheet = $('sheet');
    const grab = $('grabber');
    const start = (ev) => {
      sy = ev.clientY; dy = 0;
      sheet.style.transition = 'none';
    };
    const move = (ev) => {
      if (sy == null) return;
      dy = Math.max(0, ev.clientY - sy);
      sheet.style.transform = 'translateY(' + dy + 'px)';
    };
    const end = () => {
      if (sy == null) return;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 120) closeSheet();
      sy = null;
    };
    grab.addEventListener('pointerdown', (ev) => { start(ev); try { grab.setPointerCapture(ev.pointerId); } catch (e) { } });
    grab.addEventListener('pointermove', move);
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
  })();

  /* ---------- 공통 컨트롤 헬퍼 ---------- */
  function bindSeg(body, key, onChange) {
    body.querySelectorAll('[data-seg="' + key + '"] button').forEach((b) => {
      b.addEventListener('click', () => {
        body.querySelectorAll('[data-seg="' + key + '"] button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onChange(b.dataset.v);
      });
    });
  }

  /* =========================================================
     시트 · 원고
  ========================================================= */
  SHEETS.source = {
    html() {
      return `
      <div class="block">
        <div class="block-title">원고 <small>${state.cards.length}장 · 자동 저장</small></div>
        <textarea class="field code-area" id="srcText" placeholder="첫 줄: 표지 제목&#10;&#10;# 소제목&#10;본문을 쓰고 **강조**할 곳은 별표로 감싸요.&#10;&#10;---&#10;# 다음 장">${esc(state.source)}</textarea>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn primary" data-act="build">카드 만들기</button>
          <button class="btn" data-act="demo">예시 채우기</button>
        </div>
        <p class="hint">빈 줄 = 문단 &nbsp;·&nbsp; <b># 소제목</b> 또는 <b>1. 소제목</b> = 장 제목 &nbsp;·&nbsp; <b>**강조**</b> = 형광펜<br>
        <b>---</b> = 강제로 장 나누기 &nbsp;·&nbsp; <b>| 표 |</b> 와 <b>- [ ] 체크</b>도 카드가 됩니다.</p>
      </div>
      <div class="block">
        <div class="block-title">밀도</div>
        <div class="segmented" data-seg="density">
          <button data-v="loose" class="${state.density === 'loose' ? 'on' : ''}">여유 있게</button>
          <button data-v="tight" class="${state.density === 'tight' ? 'on' : ''}">꽉 채워</button>
        </div>
        <p class="hint">바꾸면 카드가 다시 나뉘고, 한 장에 들어가는 줄 수가 달라져요.</p>
      </div>
      <div class="block">
        <div class="block-title">마지막 장</div>
        <div class="checkline"><span>프로필 · 팔로우 카드 넣기</span><span class="switch ${state.addCTA ? 'on' : ''}" role="switch" aria-label="마지막 장 프로필 카드" tabindex="0" data-act="cta"></span></div>
      </div>`;
    },
    bind(body) {
      const ta = body.querySelector('#srcText');
      if (ta) ta.addEventListener('input', () => { state.source = ta.value; save(); });
      body.querySelector('[data-act="build"]').addEventListener('click', () => {
        if (ta) state.source = ta.value;
        if (!state.source.trim()) { toast('원고를 먼저 붙여넣어 주세요'); return; }
        rebuild();
        closeSheet();
        toast(state.cards.length + '장의 카드를 만들었어요');
      });
      body.querySelector('[data-act="demo"]').addEventListener('click', () => {
        if (ta) ta.value = E.DEMO_TEXT;
        state.source = E.DEMO_TEXT;
        state.cards = [];
        rebuild();
        closeSheet();
        toast('예시 원고로 만들었어요');
      });
      bindSeg(body, 'density', (v) => {
        state.density = v;
        state.cards = [];
        rebuild();
        toast(v === 'tight' ? '꽉 채워 담았어요' : '여유 있게 나눴어요');
      });
      body.querySelector('[data-act="cta"]').addEventListener('click', (ev) => {
        state.addCTA = !state.addCTA;
        ev.currentTarget.classList.toggle('on', state.addCTA);
        state.cards = [];
        rebuild();
      });
    },
  };

  function rebuild() {
    state.cards = E.buildCards(state);
    if (state.cardIndex >= state.cards.length) state.cardIndex = Math.max(0, state.cards.length - 1);
    buildTrack();
    save(true);
    updateMeter();
  }

  /* =========================================================
     시트 · 디자인
  ========================================================= */
  function bgCss(bg) {
    if (!bg) return '#fff';
    if (bg.kind === 'gradient') return 'linear-gradient(150deg,' + bg.from + ',' + bg.to + ')';
    return bg.color || '#fff';
  }

  SHEETS.design = {
    html() {
      const tpl = E.TEMPLATES.map((t) => `
        <button class="tpl ${t.id === state.templateId ? 'on' : ''}" data-tpl="${t.id}" type="button">
          <div class="tpl-swatch" style="background:${bgCss(t.bg)}">
            <div class="l1" style="background:${t.ink}"></div>
            <div>
              <div class="l2" style="background:${t.ink}"></div>
              <div class="l3" style="background:${t.accent}"></div>
            </div>
          </div>
          <div class="tpl-name">${t.name}</div>
        </button>`).join('');

      const bgs = E.BACKGROUNDS.map((b) => `<button class="chip ${state.backgroundId === b.id ? 'on' : ''}" data-bg="${b.id}" type="button">${b.name}</button>`).join('');

      const fonts = [['', '템플릿'], ['pretendard', '프리텐다드'], ['serif', '고운바탕'], ['black', '블랙한산스'], ['dohyeon', '도현']]
        .map(([id, name]) => `<button class="chip ${(state.fontId || '') === id ? 'on' : ''}" data-font="${id}" type="button">${name}</button>`).join('');

      const titleColors = [null, '#111111', '#ffffff', '#e8462a', '#12408c'].map((c) => swatch(c, state.ink, 'ink')).join('') +
        `<input type="color" class="color-input" data-color="ink" value="${state.ink || '#111111'}" aria-label="제목 색 직접 고르기">`;
      const accentColors = [null, '#e8462a', '#12408c', '#a6602c', '#d8ff3e'].map((c) => swatch(c, state.accent, 'accent')).join('') +
        `<input type="color" class="color-input" data-color="accent" value="${state.accent || '#e8462a'}" aria-label="강조 색 직접 고르기">`;

      const saved = (state.savedStyles || []).length ? state.savedStyles.map((s) => `
        <div class="profile-card">
          <div class="avatar" style="background:${bgCss(E.TEMPLATES.find((t) => t.id === s.style.templateId)?.bg || { color: '#eee' })};color:#111">${esc((s.name || 'S').charAt(0))}</div>
          <div class="profile-meta"><b>${esc(s.name)}</b><span>${esc((E.TEMPLATES.find((t) => t.id === s.style.templateId) || {}).name || '')}</span></div>
          <button class="mini-btn" data-apply-style="${s.id}" type="button">적용</button>
          <button class="mini-btn" data-del-style="${s.id}" type="button">삭제</button>
        </div>`).join('') : '<p class="hint">아직 저장한 스타일이 없어요.</p>';

      const accounts = (state.accounts || []).map((a) => `
        <div class="profile-card ${a.id === state.accountId ? 'on' : ''}">
          <div class="avatar">${a.avatar ? '<img src="' + a.avatar + '" alt="">' : esc((a.logo || (a.name || 'M').charAt(0)).toUpperCase())}</div>
          <div class="profile-meta"><b>${esc(a.name || '이름 없음')}</b><span>${esc(a.handle || '')} · ${esc(a.bio || '')}</span></div>
          <button class="mini-btn" data-use-acc="${a.id}" type="button">${a.id === state.accountId ? '사용 중' : '전환'}</button>
          <button class="mini-btn" data-edit-acc="${a.id}" type="button">편집</button>
        </div>`).join('');

      return `
      <div class="block">
        <div class="block-title">비율</div>
        <div class="segmented" data-seg="ratio">
          <button data-v="4:5" class="${state.ratio === '4:5' ? 'on' : ''}">4:5 피드</button>
          <button data-v="9:16" class="${state.ratio === '9:16' ? 'on' : ''}">9:16 릴스·스토리</button>
        </div>
      </div>

      <div class="block">
        <div class="block-title">매거진 템플릿 <small>${(E.TEMPLATES.find((t) => t.id === state.templateId) || {}).note || ''}</small></div>
        <div class="templates">${tpl}</div>
      </div>

      <div class="block">
        <div class="block-title">배경 · 질감</div>
        <div class="chips">${bgs}</div>
      </div>

      <div class="block">
        <div class="block-title">글꼴</div>
        <div class="chips">${fonts}</div>
        <p class="hint">블랙한산스·도현은 제목에만 적용되고 본문은 읽기 편한 서체로 유지돼요.</p>
      </div>

      <div class="block">
        <div class="block-title">정렬</div>
        <div class="segmented" data-seg="align">
          <button data-v="left" class="${state.align === 'left' ? 'on' : ''}">왼쪽</button>
          <button data-v="center" class="${state.align === 'center' ? 'on' : ''}">가운데</button>
          <button data-v="right" class="${state.align === 'right' ? 'on' : ''}">오른쪽</button>
        </div>
      </div>

      <div class="block">
        <div class="block-title">크기 · 행간</div>
        ${slider('titleScale', '제목', 0.7, 1.35, 0.05, state.titleScale, (v) => Math.round(v * 100) + '%')}
        ${slider('bodyScale', '본문', 0.8, 1.25, 0.05, state.bodyScale, (v) => Math.round(v * 100) + '%')}
        ${slider('lineHeight', '행간', 1.3, 2.0, 0.02, state.lineHeight, (v) => v.toFixed(2))}
      </div>

      <div class="block">
        <div class="block-title">색</div>
        <p class="hint" style="margin:0 0 8px">제목 색</p>
        <div class="swatches">${titleColors}</div>
        <p class="hint" style="margin:14px 0 8px">포인트 색</p>
        <div class="swatches">${accentColors}</div>
      </div>

      <div class="block">
        <div class="block-title">내 스타일</div>
        <div class="btn-row" style="margin-bottom:10px">
          <button class="btn" data-act="save-style" type="button">현재 스타일 저장</button>
        </div>
        ${saved}
      </div>

      <div class="block">
        <div class="block-title">프로필 계정</div>
        ${accounts}
        <div class="btn-row"><button class="btn" data-act="add-acc" type="button">계정 추가</button></div>
        <p class="hint">표지의 이름과 마지막 장 프로필에 쓰여요. 여러 계정을 만들어 두고 전환할 수 있어요.</p>
      </div>`;
    },

    bind(body) {
      body.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', () => {
        state.templateId = b.dataset.tpl;
        state.fontId = null;
        state.ink = null; state.accent = null; state.highlight = null; state.bodyColor = null;
        body.querySelectorAll('[data-tpl]').forEach((x) => x.classList.toggle('on', x === b));
        renderSoon(); save();
        body.querySelector('.block-title small').textContent = (E.TEMPLATES.find((t) => t.id === state.templateId) || {}).note || '';
      }));

      body.querySelectorAll('[data-bg]').forEach((b) => b.addEventListener('click', () => {
        state.backgroundId = b.dataset.bg;
        body.querySelectorAll('[data-bg]').forEach((x) => x.classList.toggle('on', x === b));
        renderSoon(); save();
      }));

      body.querySelectorAll('[data-font]').forEach((b) => b.addEventListener('click', () => {
        state.fontId = b.dataset.font || null;
        body.querySelectorAll('[data-font]').forEach((x) => x.classList.toggle('on', x === b));
        renderSoon(); save();
      }));

      bindSeg(body, 'ratio', (v) => {
        if (v === state.ratio) return;
        state.ratio = v;
        updateRatioBtn();
        rebuild();
        toast(v === '9:16' ? '9:16으로 바꿨어요' : '4:5로 바꿨어요');
      });
      bindSeg(body, 'align', (v) => { state.align = v; renderSoon(); save(); });

      body.querySelectorAll('input[type="range"]').forEach((r) => {
        r.addEventListener('input', () => {
          const k = r.dataset.k;
          const v = parseFloat(r.value);
          state[k] = v;
          const out = r.parentElement.querySelector('output');
          if (out) out.textContent = (k === 'lineHeight') ? v.toFixed(2) : Math.round(v * 100) + '%';
          renderSoon(); save();
        });
      });

      body.querySelectorAll('[data-color]').forEach((inp) => {
        inp.addEventListener('input', () => {
          const k = inp.dataset.color;
          state[k] = inp.value;
          body.querySelectorAll('.swatch[data-key="' + k + '"]').forEach((s) => s.classList.remove('on'));
          renderSoon(); save();
        });
      });
      body.querySelectorAll('.swatch').forEach((s) => s.addEventListener('click', () => {
        const k = s.dataset.key;
        const v = s.dataset.val === 'auto' ? null : s.dataset.val;
        state[k] = v;
        body.querySelectorAll('.swatch[data-key="' + k + '"]').forEach((x) => x.classList.toggle('on', x === s));
        renderSoon(); save();
      }));

      body.querySelector('[data-act="save-style"]').addEventListener('click', () => {
        const name = '스타일 ' + ((state.savedStyles || []).length + 1);
        state.savedStyles = state.savedStyles || [];
        state.savedStyles.push({
          id: 'st_' + Date.now().toString(36),
          name: name,
          style: {
            templateId: state.templateId, backgroundId: state.backgroundId, fontId: state.fontId,
            align: state.align, titleScale: state.titleScale, bodyScale: state.bodyScale, lineHeight: state.lineHeight,
            ink: state.ink, bodyColor: state.bodyColor, accent: state.accent, highlight: state.highlight,
          },
          at: Date.now(),
        });
        save(true);
        openSheet('design');
        toast('현재 스타일을 저장했어요');
      });
      body.querySelectorAll('[data-apply-style]').forEach((b) => b.addEventListener('click', () => {
        const s = (state.savedStyles || []).find((x) => x.id === b.dataset.applyStyle);
        if (!s) return;
        Object.assign(state, s.style);
        save(true);
        openSheet('design');
        toast('"' + s.name + '" 스타일을 적용했어요');
      }));
      body.querySelectorAll('[data-del-style]').forEach((b) => b.addEventListener('click', () => {
        state.savedStyles = (state.savedStyles || []).filter((x) => x.id !== b.dataset.delStyle);
        save(true);
        openSheet('design');
      }));

      body.querySelectorAll('[data-use-acc]').forEach((b) => b.addEventListener('click', () => {
        state.accountId = b.dataset.useAcc;
        save(true); renderSoon(); openSheet('design');
      }));
      body.querySelectorAll('[data-edit-acc]').forEach((b) => b.addEventListener('click', () => {
        openAccountForm(b.dataset.editAcc);
      }));
      body.querySelector('[data-act="add-acc"]').addEventListener('click', () => {
        const acc = { id: 'acc_' + Date.now().toString(36), handle: '@new_account', name: '새 계정', bio: '', logo: 'N', avatar: null };
        state.accounts.push(acc);
        state.accountId = acc.id;
        save(true);
        openAccountForm(acc.id);
      });
    },
  };

  function swatch(color, current, key) {
    const on = (current || null) === color;
    if (!color) {
      return `<button class="swatch auto ${on ? 'on' : ''}" data-key="${key}" data-val="auto" type="button" aria-label="템플릿 기본">A</button>`;
    }
    return `<button class="swatch ${on ? 'on' : ''}" data-key="${key}" data-val="${color}" style="background:${color}" type="button" aria-label="${color}"></button>`;
  }

  function slider(key, label, min, max, step, val, fmt) {
    return `<div class="slider-row">
      <label>${label}</label>
      <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${val}">
      <output>${fmt(val)}</output>
    </div>`;
  }

  /* ---------- 계정 편집 ---------- */
  function openAccountForm(id) {
    const acc = (state.accounts || []).find((a) => a.id === id);
    if (!acc) return;
    $('sheetTitle').textContent = '프로필 계정';
    $('sheetBody').innerHTML = `
      <div class="block">
        <div class="block-title">계정 정보</div>
        <div class="field-row" style="margin-bottom:8px">
          <input class="field" id="accName" placeholder="이름" value="${esc(acc.name || '')}">
          <input class="field" id="accHandle" placeholder="@handle" value="${esc(acc.handle || '')}">
        </div>
        <input class="field" id="accBio" placeholder="한 줄 소개" value="${esc(acc.bio || '')}" style="margin-bottom:8px">
        <div class="field-row">
          <input class="field" id="accLogo" placeholder="로고 글자 (1자)" maxlength="2" value="${esc(acc.logo || '')}">
          <button class="btn" id="accAvatarBtn" type="button">프로필 사진</button>
        </div>
        <p class="hint">프로필 사진을 올리면 마지막 장에 사진이, 없으면 로고 글자가 표시돼요.</p>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="accSave" type="button">저장</button>
        <button class="btn" id="accCancel" type="button">취소</button>
        <button class="btn danger" id="accDel" type="button">계정 삭제</button>
      </div>`;
    $('accAvatarBtn').addEventListener('click', () => {
      pendingUpload = { kind: 'avatar', accountId: acc.id };
      $('avatarInput').click();
    });
    $('accSave').addEventListener('click', () => {
      acc.name = $('accName').value.trim();
      acc.handle = $('accHandle').value.trim() || '@handle';
      if (acc.handle[0] !== '@') acc.handle = '@' + acc.handle;
      acc.bio = $('accBio').value.trim();
      acc.logo = $('accLogo').value.trim().slice(0, 2);
      save(true);
      renderSoon();
      openSheet('design');
      toast('프로필을 저장했어요');
    });
    $('accCancel').addEventListener('click', () => openSheet('design'));
    $('accDel').addEventListener('click', (ev) => {
      const btn = ev.currentTarget;
      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1'; btn.textContent = '정말 삭제할까요?';
        setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = '계정 삭제'; } }, 3000);
        return;
      }
      state.accounts = state.accounts.filter((a) => a.id !== acc.id);
      if (!state.accounts.length) state.accounts = [E.freshState().accounts[0]];
      if (!state.accounts.some((a) => a.id === state.accountId)) state.accountId = state.accounts[0].id;
      save(true);
      renderSoon();
      openSheet('design');
    });
  }

  /* =========================================================
     시트 · 카드 편집
  ========================================================= */
  function refreshCardSheet() {
    if (currentSheet === 'card') openSheet('card');
  }

  SHEETS.card = {
    html() {
      const card = activeCard();
      if (!card) return '<div class="block"><p class="hint">카드가 없어요. 원고를 먼저 만들어 주세요.</p></div>';
      const idx = state.cardIndex;
      const total = state.cards.length;
      const ov = card.ov || {};
      const typeNames = { cover: '표지', body: '속지', table: '비교표', check: '체크', end: '마지막' };
      const types = Object.keys(typeNames).map((k) =>
        `<button data-type="${k}" class="${card.type === k ? 'on' : ''}">${typeNames[k]}</button>`).join('');
      const isText = card.type === 'body' || card.type === 'cover' || card.type === 'end';
      const content = card.type === 'table'
        ? `<textarea class="field code-area" id="cardText" placeholder="항목 | A | B&#10;첫 줄은 표 머리글">${esc(E.cardToText(card))}</textarea>
           <p class="hint">한 줄에 한 행, 칸은 <b>|</b> 로 구분해요. 첫 줄은 진한 머리글.</p>`
        : card.type === 'check'
          ? `<textarea class="field code-area" id="cardText">${esc(E.cardToText(card))}</textarea>
             <p class="hint"><b>- [x]</b> 완료, <b>- [ ]</b> 미완료로 표시돼요.</p>`
          : `<textarea class="field" id="cardBody" rows="7" placeholder="본문">${esc(card.body || '')}</textarea>`;
      const photo = card.photo && card.photo.src;
      const filters = [['none', '원본'], ['mono', '흑백'], ['film', '필름'], ['vintage', '빈티지'], ['warm', '따뜻하게'], ['cool', '차갑게'], ['fade', '페이드']]
        .map(([k, n]) => `<button class="chip ${(card.photo && card.photo.filter || 'none') === k ? 'on' : ''}" data-filter="${k}" type="button">${n}</button>`).join('');

      const ovTitleScale = ov.titleScale != null ? ov.titleScale : 1;
      const ovBodyScale = ov.bodyScale != null ? ov.bodyScale : 1;

      return `
      <div class="block" style="padding-top:0">
        <div class="block-title">카드 <small>${idx + 1} / ${total}</small></div>
        <div class="btn-row">
          <button class="btn" data-act="prev" type="button" ${idx === 0 ? 'disabled' : ''}>← 이전</button>
          <button class="btn" data-act="next" type="button" ${idx >= total - 1 ? 'disabled' : ''}>다음 →</button>
        </div>
        <div class="segmented" style="margin-top:10px" data-seg="ctype">${types}</div>
      </div>

      <div class="block">
        <div class="block-title">내용</div>
        <input class="field" id="cardTitle" placeholder="제목" value="${esc(card.title || '')}" ${card.type === 'end' ? 'style="display:none"' : ''}>
        ${card.type === 'cover' ? `<input class="field" id="cardSub" placeholder="부제" value="${esc(card.subtitle || '')}" style="margin-top:8px">` : ''}
        ${card.type === 'cover' ? '' : card.type === 'end' ? `<textarea class="field" id="cardBody" rows="3" placeholder="마지막 한마디">${esc(card.body || '')}</textarea>` : `<div style="margin-top:8px">${content}</div>`}
      </div>

      <div class="block">
        <div class="block-title">사진 <small>${photo ? '적용됨' : '없음'}</small></div>
        <div class="btn-row">
          <button class="btn" data-act="photo" type="button">${photo ? '사진 바꾸기' : '사진 넣기'}</button>
          ${photo ? '<button class="btn danger" data-act="del-photo" type="button">삭제</button>' : ''}
        </div>
        ${photo ? `
          <div class="chips" style="margin-top:10px">${filters}</div>
          <p class="hint" style="margin:10px 0 0">사진 영역</p>
          <div class="segmented" data-seg="band" style="margin-top:6px">
            <button data-v="full" class="${(card.photo.band || 'full') === 'full' ? 'on' : ''}">전체</button>
            <button data-v="top" class="${card.photo.band === 'top' ? 'on' : ''}">위쪽 절반</button>
          </div>
          ${slider('zoom', '확대', 1, 2.4, 0.02, card.photo.zoom || 1, (v) => v.toFixed(2) + '×')}
          ${slider('brightness', '밝기', -0.5, 0.5, 0.02, card.photo.brightness || 0, (v) => (v > 0 ? '+' : '') + Math.round(v * 100))}
          ${slider('dark', '어둡게', 0, 0.8, 0.02, card.photo.dark == null ? 0.3 : card.photo.dark, (v) => Math.round(v * 100))}
          <div class="checkline"><span>사진 위치 조정</span><span class="switch ${photoMode ? 'on' : ''}" role="switch" aria-label="사진 위치 조정" tabindex="0" data-act="photomode"></span></div>
          <p class="hint">켜두면 카드 위를 끌어서 사진을 움직일 수 있어요.</p>
        ` : '<p class="hint">카드 한 장에 사진 한 장을 넣을 수 있어요. 세로 사진이 가장 예뻐요.</p>'}
      </div>

      <div class="block">
        <div class="block-title">카드 스타일</div>
        <p class="hint" style="margin:0 0 8px">글꼴</p>
        <div class="chips">
          ${[['', '템플릿'], ['pretendard', '프리텐다드'], ['serif', '고운바탕'], ['black', '블랙한산스'], ['dohyeon', '도현']].map(([k, n]) =>
            `<button class="chip ${(ov.fontId || '') === k ? 'on' : ''}" data-ofont="${k}" type="button">${n}</button>`).join('')}
        </div>
        <p class="hint" style="margin:14px 0 8px">정렬</p>
        <div class="segmented" data-seg="oalign">
          <button data-v="" class="${!ov.align ? 'on' : ''}">기본</button>
          <button data-v="left" class="${ov.align === 'left' ? 'on' : ''}">왼쪽</button>
          <button data-v="center" class="${ov.align === 'center' ? 'on' : ''}">가운데</button>
          <button data-v="right" class="${ov.align === 'right' ? 'on' : ''}">오른쪽</button>
        </div>
        ${slider('ovTitleScale', '제목', 0.7, 1.5, 0.05, ovTitleScale, (v) => Math.round(v * 100) + '%')}
        ${slider('ovBodyScale', '본문', 0.75, 1.4, 0.05, ovBodyScale, (v) => Math.round(v * 100) + '%')}
      </div>

      <div class="block">
        <div class="btn-row">
          <button class="btn" data-act="dup" type="button">카드 복제</button>
          <button class="btn danger" data-act="del" type="button">카드 삭제</button>
        </div>
      </div>`;
    },

    bind(body) {
      const card = activeCard();
      if (!card) return;
      const touch = () => { renderSoon(); save(); };

      const titleEl = body.querySelector('#cardTitle');
      if (titleEl) titleEl.addEventListener('input', () => { card.title = titleEl.value; touch(); });
      const subEl = body.querySelector('#cardSub');
      if (subEl) subEl.addEventListener('input', () => { card.subtitle = subEl.value; touch(); });
      const bodyEl = body.querySelector('#cardBody');
      if (bodyEl) bodyEl.addEventListener('input', () => { card.body = bodyEl.value; touch(); });
      const textEl = body.querySelector('#cardText');
      if (textEl) textEl.addEventListener('input', () => { E.textToCard(card, textEl.value); touch(); });

      body.querySelector('[data-act="prev"]').addEventListener('click', () => {
        goTo(state.cardIndex - 1); refreshCardSheet();
      });
      body.querySelector('[data-act="next"]').addEventListener('click', () => {
        goTo(state.cardIndex + 1); refreshCardSheet();
      });

      bindSeg(body, 'ctype', (v) => {
        if (v === card.type) return;
        const text = E.cardToText(card);
        const wasTitle = card.title;
        card.type = v;
        if (v === 'body' || v === 'cover' || v === 'end') {
          card.body = v === 'cover' ? '' : text;
          delete card.rows; delete card.items;
          if (v === 'cover') { card.title = wasTitle || '제목'; card.subtitle = text.slice(0, 120); }
        } else {
          E.textToCard(card, text);
        }
        save(true); renderAll(); refreshCardSheet();
      });

      body.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
        if (!card.photo) return;
        card.photo.filter = b.dataset.filter;
        body.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('on', x === b));
        touch();
      }));
      bindSeg(body, 'band', (v) => { if (card.photo) { card.photo.band = v; touch(); } });

      body.querySelectorAll('input[type="range"]').forEach((r) => {
        r.addEventListener('input', () => {
          if (!card.photo) return;
          const k = r.dataset.k;
          const v = parseFloat(r.value);
          if (k === 'ovTitleScale' || k === 'ovBodyScale') {
            card.ov = card.ov || {};
            card.ov[k === 'ovTitleScale' ? 'titleScale' : 'bodyScale'] = v;
          } else {
            card.photo[k] = v;
          }
          const out = r.parentElement.querySelector('output');
          if (out) {
            if (k === 'zoom') out.textContent = v.toFixed(2) + '×';
            else if (k === 'ovTitleScale' || k === 'ovBodyScale') out.textContent = Math.round(v * 100) + '%';
            else if (k === 'brightness') out.textContent = (v > 0 ? '+' : '') + Math.round(v * 100);
            else out.textContent = Math.round(v * 100);
          }
          renderSoon(); save();
        });
      });

      body.querySelectorAll('[data-ofont]').forEach((b) => b.addEventListener('click', () => {
        card.ov = card.ov || {};
        card.ov.fontId = b.dataset.ofont || null;
        body.querySelectorAll('[data-ofont]').forEach((x) => x.classList.toggle('on', x === b));
        touch();
      }));
      bindSeg(body, 'oalign', (v) => {
        card.ov = card.ov || {};
        card.ov.align = v || null;
        touch();
      });

      body.querySelector('[data-act="photo"]').addEventListener('click', () => {
        pendingUpload = { kind: 'photo', cardIndex: state.cardIndex };
        $('photoInput').click();
      });
      const del = body.querySelector('[data-act="del-photo"]');
      if (del) del.addEventListener('click', () => {
        card.photo = null; photoMode = false;
        save(true); renderAll(); refreshCardSheet();
      });
      body.querySelector('[data-act="photomode"]').addEventListener('click', (ev) => {
        photoMode = !photoMode;
        ev.currentTarget.classList.toggle('on', photoMode);
        $('dragHint').hidden = !photoMode;
        track.querySelectorAll('.card').forEach((c, i) => c.classList.toggle('photomode', photoMode && i === state.cardIndex));
        if (photoMode) closeSheet();
      });

      body.querySelector('[data-act="dup"]').addEventListener('click', () => {
        const copy = JSON.parse(JSON.stringify(card));
        copy.id = E.uid('card');
        state.cards.splice(state.cardIndex + 1, 0, copy);
        buildTrack(); save(true); goTo(state.cardIndex + 1);
        toast('카드를 복제했어요');
      });
      body.querySelector('[data-act="del"]').addEventListener('click', (ev) => {
        const btn = ev.currentTarget;
        if (btn.dataset.armed !== '1') {
          btn.dataset.armed = '1'; btn.textContent = '정말 삭제할까요?';
          setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = '카드 삭제'; } }, 3000);
          return;
        }
        state.cards.splice(state.cardIndex, 1);
        state.cardIndex = Math.max(0, Math.min(state.cardIndex, state.cards.length - 1));
        photoMode = false;
        buildTrack(); save(true);
        if (state.cards.length) refreshCardSheet(); else closeSheet();
      });
    },
  };

  /* =========================================================
     시트 · 점검
  ========================================================= */
  SHEETS.check = {
    html() {
      if (!state.cards.length) return '<div class="block"><p class="hint">카드를 먼저 만들어 주세요.</p></div>';
      const issues = E.textIssues(state);
      const list = issues.map((it, i) => {
        const cls = it.level === 'ok' ? 'ok' : '';
        const btn = it.action ? ` <button data-fix="${it.action}" type="button">바로 고치기</button>` : '';
        const go = it.cardIndex != null ? ` <button data-goto="${it.cardIndex}" type="button">카드 보기</button>` : '';
        return `<div class="issue ${cls}"><span class="dotmark"></span><span>${esc(it.text)}${btn}${go}</span></div>`;
      }).join('');
      const caption = state.caption != null ? state.caption : E.caption(state);
      return `
      <div class="block" style="padding-top:0">
        <div class="block-title">표지 점검</div>
        <div class="checkline"><span>인스타 그리드 1:1 잘림 가이드</span><span class="switch ${coverGuideOn ? 'on' : ''}" role="switch" aria-label="표지 잘림 가이드" tabindex="0" data-act="guide"></span></div>
        <p class="hint">표지에서 위아래로 잘리는 영역을 어둡게 보여줘요. 제목이 가운데 정사각형 안에 들어오면 프로필 그리드에서도 잘 보입니다.</p>
      </div>
      <div class="block">
        <div class="block-title">글 점검 <small>${issues.filter((i) => i.level === 'warn').length}개 항목</small></div>
        ${list}
        <div class="btn-row" style="margin-top:10px">
          <button class="btn" data-act="requote" type="button">따옴표 교정</button>
          <button class="btn" data-act="respace" type="button">공백 정리</button>
        </div>
      </div>
      <div class="block">
        <div class="block-title">캡션 초안</div>
        <textarea class="field tall" id="capText">${esc(caption)}</textarea>
        <div class="btn-row" style="margin-top:10px">
          <button class="btn primary" data-act="copy" type="button">캡션 복사</button>
          <button class="btn" data-act="regen" type="button">다시 생성</button>
        </div>
        <p class="hint">해시태그는 원고에서 자주 나온 단어로 자동 구성했어요. 그대로 쓰거나 고쳐 쓰세요.</p>
      </div>`;
    },
    bind(body) {
      body.querySelector('[data-act="guide"]').addEventListener('click', (ev) => {
        setGuide(!coverGuideOn);
        ev.currentTarget.classList.toggle('on', coverGuideOn);
        if (coverGuideOn) {
          const card = activeCard();
          if (!card || card.type !== 'cover') {
            const ci = state.cards.findIndex((c) => c.type === 'cover');
            if (ci >= 0) { goTo(ci); closeSheet(); toast('표지 카드로 이동했어요'); }
          } else { closeSheet(); }
        }
      });
      body.querySelectorAll('[data-fix]').forEach((b) => b.addEventListener('click', () => {
        applyFix(b.dataset.fix);
        openSheet('check');
      }));
      body.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
        goTo(parseInt(b.dataset.goto, 10));
        closeSheet();
      }));
      const cap = body.querySelector('#capText');
      if (cap) cap.addEventListener('input', () => { state.caption = cap.value; save(); });
      body.querySelector('[data-act="copy"]').addEventListener('click', async () => {
        const text = cap ? cap.value : E.caption(state);
        try {
          await navigator.clipboard.writeText(text);
          toast('캡션을 복사했어요');
        } catch (e) {
          const ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); toast('캡션을 복사했어요'); } catch (e2) { toast('복사가 안 됐어요. 길게 눌러 복사해 주세요'); }
          ta.remove();
        }
      });
      body.querySelector('[data-act="regen"]').addEventListener('click', () => {
        state.caption = E.caption(state);
        if (cap) cap.value = state.caption;
        save();
        toast('캡션을 다시 만들었어요');
      });
      body.querySelector('[data-act="requote"]').addEventListener('click', () => { applyFix('quotes'); openSheet('check'); });
      body.querySelector('[data-act="respace"]').addEventListener('click', () => { applyFix('spaces'); openSheet('check'); });
    },
  };

  function applyFix(code) {
    const fix = code === 'quotes' ? E.fixQuotes : E.fixSpaces;
    state.source = fix(state.source || '');
    state.cards.forEach((c) => {
      if (c.title) c.title = fix(c.title);
      if (c.subtitle) c.subtitle = fix(c.subtitle);
      if (c.body) c.body = fix(c.body);
      if (c.rows) c.rows = c.rows.map((r) => r.map((x) => fix(x)));
      if (c.items) c.items = c.items.map((it) => ({ ...it, text: fix(it.text) }));
    });
    state.caption = null;
    save(true);
    renderAll();
    if (currentSheet === 'card') refreshCardSheet();
    toast(code === 'quotes' ? '따옴표를 둥근 모양으로 바꿨어요' : '공백을 정리했어요');
  }

  /* =========================================================
     시트 · 저장 / 내보내기
  ========================================================= */
  SHEETS.save = {
    html() {
      const n = state.cards.length;
      const res = state.ratio === '9:16' ? '1080 × 1920' : '1080 × 1350';
      return `
      <div class="block" style="padding-top:0">
        <div class="block-title">내보내기 <small>${n}장 · ${res}px</small></div>
        <div class="btn-row">
          <button class="btn primary wide" data-act="png" type="button" ${n ? '' : 'disabled'}>현재 카드 PNG 저장</button>
        </div>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn wide" data-act="zip" type="button" ${n ? '' : 'disabled'}>전체 카드 ZIP으로 저장</button>
        </div>
        <p class="hint">저장하면 미리보기가 열려요. 이미지를 꾹 눌러 사진에 저장하거나, 공유 버튼으로 사진 앱에 저장할 수 있어요.</p>
      </div>
      <div class="block">
        <div class="block-title">카드 목록</div>
        <div class="card-strip" id="miniStrip"></div>
      </div>
      <div class="block">
        <div class="block-title">홈 화면에 추가</div>
        <p class="hint">Safari 하단 <b>공유 → 홈 화면에 추가</b>를 누르면 앱처럼 전체 화면으로 열려요. 한 번 열어두면 오프라인에서도 실행됩니다.</p>
      </div>
      <div class="block">
        <div class="block-title">데이터</div>
        <p class="hint">모든 작업은 이 기기 브라우저에 자동 저장돼요. 서버로 보내지 않습니다.</p>
        <div class="btn-row"><button class="btn danger" data-act="reset" type="button">모든 데이터 지우기</button></div>
      </div>`;
    },
    bind(body) {
      body.querySelector('[data-act="png"]').addEventListener('click', async () => {
        const card = activeCard();
        if (!card) return;
        try {
          const { blob, name } = await cardToBlob(card, state.cardIndex);
          showPreview(blob, name);
        } catch (e) {
          console.error(e);
          toast('이미지를 만들지 못했어요. 다시 시도해 주세요');
        }
      });
      body.querySelector('[data-act="zip"]').addEventListener('click', () => exportZip());
      body.querySelector('[data-act="reset"]').addEventListener('click', (ev) => {
        const btn = ev.currentTarget;
        if (btn.dataset.armed !== '1') {
          btn.dataset.armed = '1'; btn.textContent = '정말 지울까요? 한 번 더 누르세요';
          setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = '모든 데이터 지우기'; } }, 3500);
          return;
        }
        localStorage.removeItem('edito.state.v1');
        state = E.freshState();
        photoMode = false;
        closeSheet();
        buildTrack();
        goTo(0, false);
        toast('처음 상태로 돌아갔어요');
      });
      renderMiniStrip();
    },
  };

  function updateMiniStrip() {
    const strip = $('miniStrip');
    if (!strip) return;
    renderMiniStrip();
  }

  function renderMiniStrip() {
    const strip = $('miniStrip');
    if (!strip) return;
    strip.innerHTML = '';
    state.cards.forEach((card, i) => {
      const b = document.createElement('button');
      b.className = 'mini' + (i === state.cardIndex ? ' on' : '');
      b.type = 'button';
      const c = document.createElement('canvas');
      try { R.paint(c, card, state, 0.18); } catch (e) { /* noop */ }
      const s = document.createElement('span');
      s.textContent = String(i + 1);
      b.appendChild(c); b.appendChild(s);
      b.addEventListener('click', () => { goTo(i); });
      strip.appendChild(b);
    });
  }

  /* =========================================================
     내보내기
  ========================================================= */
  function loadImageEl(src) {
    return new Promise((resolve) => {
      const img = new Image();
      const done = () => resolve(img);
      img.onload = done;
      img.onerror = done;
      img.src = src;
      setTimeout(done, 5000);
    });
  }

  async function prepareExport(card) {
    showBusy('고해상도로 그리는 중…');
    try {
      await R.ensureFonts(state);
      const jobs = [];
      if (card && card.photo && card.photo.src) jobs.push(loadImageEl(card.photo.src));
      const acct = E.activeAccount(state);
      if (card && card.type === 'end' && acct && acct.avatar) jobs.push(loadImageEl(acct.avatar));
      await Promise.all(jobs);
      const canvas = document.createElement('canvas');
      R.paint(canvas, card, state, 1);
      return canvas;
    } finally {
      hideBusy();
    }
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      if (canvas.toBlob) {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
      } else {
        try {
          const data = canvas.toDataURL('image/png');
          const bin = atob(data.split(',')[1]);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: 'image/png' }));
        } catch (e) { reject(e); }
      }
    });
  }

  async function cardToBlob(card, index) {
    const canvas = await prepareExport(card);
    const blob = await canvasToBlob(canvas);
    const tag = state.ratio === '9:16' ? 'story' : 'feed';
    return { blob, name: 'edito_' + tag + '_' + pad2(index + 1) + '.png', canvas };
  }

  function showPreview(blob, name) {
    if (modalUrl) URL.revokeObjectURL(modalUrl);
    modalUrl = URL.createObjectURL(blob);
    $('modalTitle').textContent = name;
    $('modalImg').innerHTML = '<img src="' + modalUrl + '" alt="카드 미리보기">';
    const actions = $('modalActions');
    actions.innerHTML = '';
    const shareBtn = document.createElement('button');
    shareBtn.className = 'btn primary';
    shareBtn.type = 'button';
    shareBtn.textContent = '사진 앱으로 저장';
    shareBtn.addEventListener('click', async () => {
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: '카드뉴스' });
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      downloadBlob(blob, name);
      toast('다운로드를 시작했어요. 안 되면 이미지를 길게 눌러 저장하세요');
    });
    const dl = document.createElement('button');
    dl.className = 'btn'; dl.type = 'button'; dl.textContent = '파일로 저장';
    dl.addEventListener('click', () => downloadBlob(blob, name));
    const close = document.createElement('button');
    close.className = 'btn'; close.type = 'button'; close.textContent = '닫기';
    close.addEventListener('click', closeModal);
    actions.appendChild(shareBtn);
    actions.appendChild(dl);
    actions.appendChild(close);
    $('modal').hidden = false;
  }

  function closeModal() {
    $('modal').hidden = true;
    $('modalImg').innerHTML = '';
    if (modalUrl) { URL.revokeObjectURL(modalUrl); modalUrl = null; }
  }
  $('modalClose').addEventListener('click', closeModal);

  async function exportZip() {
    const n = state.cards.length;
    if (!n) return;
    showBusy('전체 카드를 만드는 중… 0 / ' + n);
    try {
      await R.ensureFonts(state);
      const acct = E.activeAccount(state);
      const jobs = [];
      state.cards.forEach((c) => { if (c.photo && c.photo.src) jobs.push(loadImageEl(c.photo.src)); });
      if (acct && acct.avatar) jobs.push(loadImageEl(acct.avatar));
      await Promise.all(jobs);

      const files = [];
      const tag = state.ratio === '9:16' ? 'story' : 'feed';
      for (let i = 0; i < n; i++) {
        $('busyText').textContent = '전체 카드를 만드는 중… ' + (i + 1) + ' / ' + n;
        const canvas = document.createElement('canvas');
        R.paint(canvas, state.cards[i], state, 1);
        const blob = await canvasToBlob(canvas);
        files.push({ name: 'edito_' + tag + '_' + pad2(i + 1) + '.png', blob: blob });
      }
      $('busyText').textContent = 'ZIP으로 묶는 중…';
      const zipBlob = await makeZip(files);
      downloadBlob(zipBlob, 'edito_cards_' + tag + '.zip');
      hideBusy();
      toast(n + '장을 ZIP으로 저장했어요');
    } catch (e) {
      console.error(e);
      hideBusy();
      toast('ZIP을 만들지 못했어요. 카드별로 저장해 주세요');
    }
  }

  async function makeZip(files) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
      if (window.JSZip) {
        const zip = new window.JSZip();
        for (const f of files) zip.file(f.name, f.blob);
        return await zip.generateAsync({ type: 'blob' });
      }
    } catch (e) {
      console.warn('JSZip CDN 실패, 내장 압축으로 진행', e);
    }
    const buffers = [];
    for (const f of files) {
      const ab = await f.blob.arrayBuffer();
      buffers.push({ name: f.name, data: new Uint8Array(ab) });
    }
    return storeZip(buffers);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('load failed: ' + src));
      document.head.appendChild(s);
    });
  }

  /* JSZip이 없을 때를 위한 무압축 ZIP 작성기 */
  function storeZip(files) {
    const enc = new TextEncoder();
    const table = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })();
    const crc32 = (buf) => {
      let c = 0xffffffff;
      for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() / 2)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, f.data.length, true);
      dv.setUint32(22, f.data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      chunks.push(local, f.data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cd.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, dosTime, true);
      cdv.setUint16(14, dosDate, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, f.data.length, true);
      cdv.setUint32(24, f.data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint16(30, 0, true);
      cdv.setUint16(32, 0, true);
      cdv.setUint16(34, 0, true);
      cdv.setUint16(36, 0, true);
      cdv.setUint32(38, 0, true);
      cdv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);
      offset += local.length + f.data.length;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = new Uint8Array(22);
    const edv = new DataView(end.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, files.length, true);
    edv.setUint16(10, files.length, true);
    edv.setUint32(12, cdSize, true);
    edv.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [end]), { type: 'application/zip' });
  }

  /* =========================================================
     사진 업로드
  ========================================================= */
  function compressImage(file, maxSize, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read failed'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode failed'));
        img.onload = () => {
          const sc = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * sc));
          c.height = Math.max(1, Math.round(img.naturalHeight * sc));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          try { resolve(c.toDataURL('image/jpeg', quality)); } catch (e) { reject(e); }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  $('photoInput').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file || !pendingUpload || pendingUpload.kind !== 'photo') return;
    const card = state.cards[pendingUpload.cardIndex];
    pendingUpload = null;
    if (!card) return;
    try {
      showBusy('사진을 준비하는 중…');
      const src = await compressImage(file, 1440, 0.86);
      card.photo = Object.assign({ x: 0, y: 0, zoom: 1, filter: 'none', brightness: 0, dark: card.type === 'cover' ? 0.30 : 0.10, band: card.type === 'cover' || card.type === 'end' ? 'full' : 'top' }, card.photo || {}, { src: src });
      save(true);
      renderAll();
      if (currentSheet === 'card') refreshCardSheet();
      toast('사진을 넣었어요');
    } catch (e) {
      console.error(e);
      toast('이 사진은 열 수 없어요. 다른 사진으로 시도해 주세요');
    } finally {
      hideBusy();
    }
  });

  $('avatarInput').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file || !pendingUpload || pendingUpload.kind !== 'avatar') return;
    const acc = (state.accounts || []).find((a) => a.id === pendingUpload.accountId);
    pendingUpload = null;
    if (!acc) return;
    try {
      showBusy('프로필 사진을 준비하는 중…');
      acc.avatar = await compressImage(file, 480, 0.88);
      save(true);
      renderAll();
      openAccountForm(acc.id);
      toast('프로필 사진을 넣었어요');
    } catch (e) {
      toast('이 사진은 열 수 없어요');
    } finally {
      hideBusy();
    }
  });

  /* =========================================================
     상단 · 비율 · 도움말
  ========================================================= */
  function updateRatioBtn() {
    $('btnRatio').textContent = state.ratio;
  }

  $('btnRatio').addEventListener('click', () => {
    state.ratio = state.ratio === '4:5' ? '9:16' : '4:5';
    updateRatioBtn();
    rebuild();
    toast(state.ratio === '9:16' ? '9:16 · 릴스/스토리 비율' : '4:5 · 피드 비율');
  });

  $('btnHelp').addEventListener('click', () => {
    openSheet('source');
  });

  $('btnStart').addEventListener('click', () => openSheet('source'));
  $('btnDemo').addEventListener('click', () => {
    state.source = E.DEMO_TEXT;
    state.cards = [];
    rebuild();
    goTo(0);
    toast('예시로 만든 카드예요. 원고를 눌러 바꿔보세요');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('modal').hidden) closeModal();
      else if (currentSheet) closeSheet();
    }
  });

  /* =========================================================
     이미지 로드시 다시 그리기
  ========================================================= */
  let imgRaf = null;
  E.onImageLoad = function () {
    if (imgRaf) return;
    imgRaf = requestAnimationFrame(() => {
      imgRaf = null;
      renderAll();
    });
  };

  /* =========================================================
     시작
  ========================================================= */
  function boot() {
    if (!state.cards.length && state.source.trim()) {
      state.cards = E.buildCards(state);
    }
    updateRatioBtn();
    buildTrack();
    layout();
    if (!state.cards.length) showEmpty(true);

    R.ensureFonts(state).then(() => {
      renderAll();
    }).catch(() => { renderAll(); });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') E.saveState(state, true);
    });
    window.addEventListener('beforeunload', () => E.saveState(state, true));
    window.addEventListener('pagehide', () => E.saveState(state, true));

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  }

  boot();

  /* 개발용 상태 훅 (최종 배포 전 제거) */
  window.__edito = {
    get state() { return state; },
    rebuild: rebuild,
    goTo: goTo,
  };
})();

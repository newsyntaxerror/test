/* ─────────────────────────────────────────────────────────────
   달콩 비서실 — 화면
   회의실 · 작업실 · 비서현황 · 메모
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const S = window.OfficeStore;
  const AI = window.OfficeAI;
  const CFG = window.OFFICE_CONFIG;

  /* 진단용 (검증할 때 콘솔 오류를 읽습니다) */
  window.__officeErrors = window.__officeErrors || [];
  window.addEventListener('error', (e) => window.__officeErrors.push('error: ' + (e.message || e.type)));
  window.addEventListener('unhandledrejection', (e) => window.__officeErrors.push('reject: ' + String(e.reason && e.reason.message || e.reason)));

  /* ── 유틸 ───────────────────────────────────────────────── */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ap = h < 12 ? '오전' : '오후';
    h = h % 12 || 12;
    return `${ap} ${h}:${m}`;
  }
  function dayKey(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date();
    const yest = new Date(); yest.setDate(today.getDate() - 1);
    const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    if (same(d, today)) return `오늘 ${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
    if (same(d, yest)) return `어제 ${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
    return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
  }
  function timeAgo(iso) {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const diff = Date.now() - t;
    if (diff < 60e3) return '방금';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)}분 전`;
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}시간 전`;
    if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)}일 전`;
    const d = new Date(iso);
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { el.hidden = true; }, 220);
    }, 2200);
  }

  const ICON = {
    send: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l15-7-4.2 15-3.6-5.4-7.2-2.6z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3.5 3.5H6.5L10 10z"/><path d="M12 13.5V21"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 6.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v8.5A1.5 1.5 0 0 0 5 15h1.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7L11.6 6.7"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 1 0 5.7 5.7l1.2-1.2"/></svg>',
  };

  /* ── UI 상태 ────────────────────────────────────────────── */
  const ui = {
    tab: localStorage.getItem('dalkong.office.tab') || 'room',
    channel: localStorage.getItem('dalkong.office.channel') || 'general',
    filter: 'all',
    draft: '',
    debateMode: false,
    typing: [],         // [{id,name,emoji}]
    busy: false,
    stickBottom: true,
    openNote: new Set(),
    settingsTab: 'ai',
    editingMember: null,
  };

  const isMobile = () => window.matchMedia('(max-width: 899px)').matches;

  /* ── 테마 ───────────────────────────────────────────────── */
  const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const pref = S.settings.theme;
    const dark = pref === 'dark' || (!pref && mqDark.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#17120E' : '#FBF7F0');
  }
  mqDark.addEventListener('change', () => { if (!S.settings.theme) applyTheme(); });

  /* ── 렌더 ───────────────────────────────────────────────── */
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; paint(); });
  }

  function paint() {
    const main = $('#main');
    if (!main) return;

    const active = document.activeElement;
    const focusId = active && active.id ? active.id : null;
    const selStart = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;

    const chatLog = $('#chatLog');
    const nearBottom = chatLog ? (chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 120) : true;
    const prevTop = chatLog ? chatLog.scrollTop : 0;

    main.innerHTML = ui.tab === 'room' ? roomMarkup()
      : ui.tab === 'tasks' ? tasksMarkup()
      : ui.tab === 'team' ? teamMarkup()
      : memosMarkup();

    document.body.classList.remove('lock-scroll');
    sizeRoom();
    paintChrome();

    const log = $('#chatLog');
    if (log) {
      if (ui.stickBottom || nearBottom) log.scrollTop = log.scrollHeight;
      else log.scrollTop = prevTop;
      log.addEventListener('scroll', () => {
        ui.stickBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
      }, { passive: true });
    }
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) {
        el.focus({ preventScroll: true });
        if (selStart != null && typeof el.setSelectionRange === 'function') {
          try { el.setSelectionRange(selStart, selStart); } catch (e) { /* number input 등 */ }
        }
      }
    }
  }

  function paintChrome() {
    $$('.tab').forEach((b) => {
      const on = b.dataset.tab === ui.tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const badge = $('#taskBadge');
    const open = S.state.tasks.filter((t) => t.status !== 'done').length;
    if (badge) { badge.textContent = open; badge.hidden = !open; }

    const conn = $('#connBadge');
    const label = $('#connLabel');
    if (!conn || !label) return;
    conn.classList.remove('is-live', 'is-local');
    if (S.sync.mode === 'live') {
      conn.classList.add('is-live');
      label.textContent = S.sync.realtime === 'on' ? '실시간 동기화' : '동기화 중';
    } else if (S.sync.status === 'connecting') {
      label.textContent = '연결 확인 중';
    } else {
      conn.classList.add('is-local');
      label.textContent = '로컬 모드';
    }
    const sub = $('#brandSub');
    if (sub) {
      const helpers = S.state.members.filter((m) => m.kind !== 'leader').length;
      const linked = S.state.members.filter((m) => AI.isConnected(m)).length;
      sub.textContent = `비서 ${helpers}명 · AI 연결 ${linked}`;
    }
  }

  function sizeRoom() {
    const grid = $('#roomGrid');
    if (!grid) { document.body.classList.remove('lock-scroll'); return; }
    const rect = grid.getBoundingClientRect();
    const appPad = parseFloat(getComputedStyle(document.querySelector('.app')).paddingBottom) || 0;
    const avail = window.innerHeight - rect.top - appPad - 4;
    const fits = avail >= (isMobile() ? 430 : 470);
    grid.style.height = Math.max(isMobile() ? 380 : 460, avail) + 'px';
    document.body.classList.toggle('lock-scroll', fits);
  }
  window.addEventListener('resize', () => {
    if (ui.tab === 'room') sizeRoom();
  });
  window.addEventListener('orientationchange', () => setTimeout(sizeRoom, 260));

  /* ── 회의실 ─────────────────────────────────────────────── */
  function channelOf(id) {
    return S.state.channels.find((c) => c.id === id) || S.state.channels[0];
  }

  function channelMarkup(ch) {
    const count = S.state.messages.filter((m) => m.channel === ch.id).length;
    return `
      <button class="channel ${ch.id === ui.channel ? 'is-active' : ''}" data-act="channel" data-ch="${esc(ch.id)}">
        <span class="ch-emoji">${esc(ch.emoji)}</span>
        <span class="ch-text">
          <span class="ch-name">#${esc(ch.name)}</span>
          <span class="ch-desc">${esc(ch.desc || '새 채널')}</span>
        </span>
        <span class="ch-count">${count}</span>
      </button>`;
  }

  function msgMarkup(m) {
    const member = S.memberById(m.authorId);
    const emoji = (member && member.emoji) || (m.authorKind === 'leader' ? '👑' : '🤖');
    const out = m.authorKind === 'leader';
    const role = member ? member.role : '';
    const src = m.meta && m.meta.source;
    const tags = [];
    if (src === 'api') tags.push(`<span class="tag api" title="${esc(m.meta.model || '')}">실제 응답</span>`);
    if (src === 'sim') tags.push('<span class="tag">시뮬레이션</span>');
    if (m.meta && m.meta.round) tags.push(`<span class="tag round">${m.meta.round}R</span>`);
    if (m.authorKind === 'system') {
      return `<div class="sys-line">${esc(m.body)}</div>`;
    }
    return `
      <div class="msg ${out ? 'out' : 'in'}">
        <div class="avatar">${esc(emoji)}</div>
        <div class="msg-main">
          <div class="msg-meta">
            <span class="msg-name">${esc(m.authorName)}</span>
            ${role ? `<span class="msg-role">${esc(role)}</span>` : ''}
            <span>${fmtTime(m.createdAt)}</span>
          </div>
          <div class="bubble">${esc(m.body)}${tags.join('')}</div>
        </div>
      </div>`;
  }

  function messagesMarkup(channelId) {
    const list = S.messagesFor(channelId);
    if (!list.length) {
      return `<div class="empty">
        <div class="emoji">🗂</div>
        <h4>아직 대화가 없어요</h4>
        <p>아래 입력창에 지시를 적고 <b>@전체</b>나 <b>@복님이</b>를 눌러 불러 보세요.</p>
      </div>`;
    }
    const out = [];
    let lastDay = '';
    let lastAuthor = '';
    list.forEach((m) => {
      const dk = dayKey(m.createdAt);
      if (dk !== lastDay) {
        out.push(`<div class="day-divider"><span>${dayLabel(m.createdAt)}</span></div>`);
        lastDay = dk;
        lastAuthor = '';
      }
      out.push(msgMarkup(m));
      lastAuthor = m.authorId;
    });
    return out.join('');
  }

  function typingMarkup() {
    return ui.typing.map((m) => `
      <div class="msg in">
        <div class="avatar">${esc(m.emoji)}</div>
        <div class="msg-main">
          <div class="msg-meta"><span class="msg-name">${esc(m.name)}</span><span class="msg-role">답장 작성 중</span></div>
          <div class="bubble typing"><i></i><i></i><i></i></div>
        </div>
      </div>`).join('');
  }

  function roomMarkup() {
    const ch = channelOf(ui.channel);
    if (!ch) return '<div class="empty"><h4>채널이 없습니다</h4></div>';
    const chMembers = S.state.members.filter((m) => m.kind !== 'leader' && (m.channels || []).includes(ch.id));
    const who = (chMembers.length ? chMembers : S.state.members.filter((m) => m.kind !== 'leader')).slice(0, 5);

    return `
    <section class="view">
      <div class="room" id="roomGrid">
        <aside class="rail">
          <div class="rail-head"><span>채널</span><button data-act="chan-add" aria-label="새 채널">${ICON.plus}</button></div>
          ${S.state.channels.map(channelMarkup).join('')}
          <button class="channel ch-add" data-act="chan-add" aria-label="새 채널">
            <span class="ch-emoji">＋</span>
            <span class="ch-text"><span class="ch-name">새 채널</span></span>
          </button>
          <div class="rail-foot">
            <span>${S.sync.mode === 'live' ? '🟢' : '🟡'}</span>
            <span>${S.sync.mode === 'live' ? '두 기기가 같은 비서실을 봅니다' : '이 브라우저에만 저장 중'}</span>
          </div>
        </aside>

        <div class="chat">
          <div class="chat-head">
            <span class="ch-emoji">${esc(ch.emoji)}</span>
            <div>
              <h3>#${esc(ch.name)}</h3>
              <p>${esc(ch.desc || '')}${chMembers.length ? ' · ' + chMembers.map((m) => m.name).slice(0, 3).join(' · ') : ''}</p>
            </div>
            <div class="who">${who.map((m) => `<span class="mini" title="${esc(m.name)}">${esc(m.emoji)}</span>`).join('')}</div>
          </div>

          <div class="chat-log" id="chatLog">
            <div class="chat-log-inner" id="chatInner">
              ${messagesMarkup(ch.id)}
              ${typingMarkup()}
            </div>
          </div>

          <div class="chat-foot">
            <div class="chips">
              <button class="chip" data-act="mention" data-name="전체">@전체</button>
              ${S.state.members.filter((m) => m.kind !== 'leader').map((m) => `<button class="chip" data-act="mention" data-name="${esc(m.name)}">@${esc(m.name)}</button>`).join('')}
              <button class="chip debate ${ui.debateMode ? 'is-on' : ''}" data-act="debate">💬 토론(2바퀴)</button>
            </div>
            <div class="composer">
              <textarea id="composerInput" rows="1" placeholder="${ui.debateMode ? '토론 주제를 적고 보내면 2바퀴 토론이 시작돼요' : '지시를 한 줄로 (@전체 · @복님이 · @GPT …)'}" ${ui.busy ? 'disabled' : ''}>${esc(ui.draft)}</textarea>
              <button class="send-btn" data-act="send" aria-label="보내기" ${ui.busy ? 'disabled' : ''}>${ICON.send}</button>
            </div>
            <div class="composer-note">🔒 대화는 ${S.sync.mode === 'live' ? '비서실 서버와 이 기기에' : '이 기기에만'} 저장됩니다${S.settings.simulate ? ' · 키 없는 비서는 시뮬레이션' : ''}</div>
          </div>
        </div>
      </div>
    </section>`;
  }

  /* ── 메시지 전송 · AI 호출 ──────────────────────────────── */
  function resolveTargets(text) {
    const helpers = S.state.members.filter((m) => m.kind !== 'leader');
    if (/@\s*전체/.test(text) || /전체\s*(불러|소집|호출)/.test(text)) return helpers;
    const lower = text.toLowerCase();
    return helpers.filter((m) => {
      const name = m.name.toLowerCase();
      if (lower.includes('@' + name)) return true;
      const short = name.replace(/(비서|님)$/, '').trim();
      if (short.length >= 2) {
        const safe = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(^|\\s)@?${safe}(\\s|$|[,?!.])`, 'i').test(text)) return true;
      }
      if (m.provider === 'openai' && /(^|\s)@?gpt(\s|$|[,?!.])/i.test(text)) return true;
      if (m.provider === 'anthropic' && /클로드/.test(text)) return true;
      if (m.provider === 'gemini' && /제미나이|제미니/.test(text)) return true;
      return false;
    });
  }

  function transcriptOf(channelId) {
    return S.messagesFor(channelId).filter((m) => m.authorKind !== 'system').slice(-14)
      .map((m) => ({ authorName: m.authorName, authorKind: m.authorKind, body: m.body }));
  }

  function addSystem(channelId, body) {
    S.addMessage({ channel: channelId, authorId: 'system', authorName: '비서실', authorKind: 'system', body, kind: 'system', meta: {} });
  }

  async function respondAs(member, ctx) {
    if (!AI.isConnected(member) && !S.settings.simulate) {
      addSystem(ctx.channelId, `${member.name}은(는) API 키가 없어 답하지 않았습니다. 설정 → AI 연결에서 연결해 주세요.`);
      return null;
    }
    ui.typing = [...ui.typing, { id: member.id, name: member.name, emoji: member.emoji }];
    ui.stickBottom = true;
    scheduleRender();

    const res = await AI.ask(member, {
      channelName: (channelOf(ctx.channelId) || {}).name || '종합',
      topic: ctx.topic,
      transcript: transcriptOf(ctx.channelId),
      mode: ctx.mode || 'chat',
      round: ctx.round,
      round1: ctx.round1,
    });

    ui.typing = ui.typing.filter((t) => t.id !== member.id);
    if (res.error) {
      addSystem(ctx.channelId, `${member.name} 응답 실패 — ${res.error}`);
      scheduleRender();
      return null;
    }
    const saved = S.addMessage({
      channel: ctx.channelId,
      authorId: member.id,
      authorName: member.name,
      authorKind: member.kind,
      body: res.text,
      kind: ctx.mode === 'debate' ? 'debate' : 'chat',
      meta: { source: res.source, model: res.model || '', round: ctx.round || null },
    });
    ui.stickBottom = true;
    scheduleRender();
    return saved;
  }

  async function sendLeader(text, opts) {
    const channelId = ui.channel;
    const body = String(text || '').trim();
    if (!body || ui.busy) return;

    S.addMessage({ channel: channelId, authorId: 'dalkong', authorName: '달콩', authorKind: 'leader', body, kind: 'chat', meta: {} });
    ui.draft = '';
    ui.stickBottom = true;

    const textarea = $('#composerInput');
    if (textarea) textarea.value = '';

    if (opts && opts.debate) {
      await runDebate(body, channelId);
      return;
    }
    const targets = resolveTargets(body);
    if (!targets.length) { scheduleRender(); return; }

    ui.busy = true;
    scheduleRender();
    try {
      for (const m of targets) {
        // eslint-disable-next-line no-await-in-loop
        await respondAs(m, { channelId, topic: body, mode: 'chat' });
      }
    } finally {
      ui.busy = false;
      ui.typing = [];
      scheduleRender();
    }
  }

  function debateParticipants() {
    const helpers = S.state.members.filter((m) => m.kind !== 'leader');
    const real = helpers.filter((m) => AI.isConnected(m));
    if (real.length) return [...real, ...helpers.filter((m) => !AI.isConnected(m))].slice(0, 3);
    if (!S.settings.simulate) return [];
    return ['boknim', 'gpt', 'claude'].map((id) => S.memberById(id)).filter(Boolean).slice(0, 3);
  }

  async function runDebate(topic, channelId) {
    const parts = debateParticipants();
    if (!parts.length) { toast('연결된 AI가 없어요. 설정 → AI 연결에서 키를 넣어 주세요.'); return; }

    ui.busy = true;
    ui.debateMode = false;
    ui.stickBottom = true;
    addSystem(channelId, `💬 토론 시작 — ${parts.map((p) => p.name).join(' · ')} / 2바퀴`);
    scheduleRender();

    const round1 = [];
    try {
      for (const round of [1, 2]) {
        addSystem(channelId, `${round}라운드`);
        for (const m of parts) {
          // eslint-disable-next-line no-await-in-loop
          const saved = await respondAs(m, { channelId, topic, mode: 'debate', round, round1 });
          if (saved && round === 1) round1.push({ name: m.name, text: saved.body.slice(0, 400) });
        }
      }
    } finally {
      ui.busy = false;
      ui.typing = [];
      scheduleRender();
    }
  }

  /* ── 작업실 ─────────────────────────────────────────────── */
  const STATUS_LABEL = { todo: '대기', doing: '진행', done: '완료' };

  function tasksMarkup() {
    const counts = { all: S.state.tasks.length, todo: 0, doing: 0, done: 0 };
    S.state.tasks.forEach((t) => { counts[t.status] = (counts[t.status] || 0) + 1; });
    const list = S.state.tasks.filter((t) => ui.filter === 'all' || t.status === ui.filter);

    return `
    <section class="view">
      <div class="page-head">
        <div>
          <h2>작업실</h2>
          <p>지시를 카드로 만들고 담당 비서에게 넘기세요.</p>
        </div>
      </div>

      <div class="toolbar">
        ${['all', 'todo', 'doing', 'done'].map((k) => `
          <button class="filter ${ui.filter === k ? 'is-on' : ''}" data-act="task-filter" data-f="${k}">
            ${k === 'all' ? '전체' : STATUS_LABEL[k]} <b>${counts[k] || 0}</b>
          </button>`).join('')}
      </div>

      <form class="task-form card" id="taskForm">
        <input type="text" id="taskTitle" placeholder="새 지시 — 예: 다인이네 숏츠 3편 이번 주 업로드" maxlength="300" autocomplete="off">
        <select id="taskAssignee" aria-label="담당자">
          ${S.state.members.filter((m) => m.kind !== 'leader').map((m) => `<option value="${esc(m.id)}">${esc(m.emoji)} ${esc(m.name)}</option>`).join('')}
        </select>
        <button class="add-btn" type="submit">추가</button>
      </form>

      ${list.length ? `<div class="task-grid">${list.map(taskMarkup).join('')}</div>` : `
        <div class="empty">
          <div class="emoji">📋</div>
          <h4>${ui.filter === 'all' ? '아직 지시가 없어요' : `${STATUS_LABEL[ui.filter]} 상태인 일이 없어요`}</h4>
          <p>위 입력창에 할 일을 적고 담당 비서를 골라 추가해 보세요.</p>
        </div>`}
    </section>`;
  }

  function taskMarkup(t) {
    const m = S.memberById(t.assignee);
    const open = ui.openNote.has(t.id);
    return `
      <article class="task" data-status="${esc(t.status)}">
        <div class="task-top">
          <span class="task-avatar">${esc(m ? m.emoji : '🗒')}</span>
          <span class="task-who">${esc(m ? m.name : '미지정')}</span>
          <span class="task-when">${timeAgo(t.createdAt)}</span>
          <button class="task-del" data-act="task-del" data-id="${esc(t.id)}" aria-label="삭제">${ICON.trash}</button>
        </div>
        <p class="task-title">${esc(t.title)}</p>
        <div class="seg">
          ${['todo', 'doing', 'done'].map((s) => `
            <button data-act="task-status" data-id="${esc(t.id)}" data-s="${s}" class="${t.status === s ? 'is-on' : ''}">${STATUS_LABEL[s]}</button>
          `).join('')}
        </div>
        ${open
          ? `<div class="task-note"><textarea id="note-${esc(t.id)}" data-note="${esc(t.id)}" placeholder="진행 메모 (자동 저장)">${esc(t.note)}</textarea></div>`
          : `<div class="task-note editable" data-act="task-note" data-id="${esc(t.id)}">${esc(t.note)}</div>`}
      </article>`;
  }

  /* ── 비서현황 ───────────────────────────────────────────── */
  function teamMarkup() {
    const helpers = S.state.members.filter((m) => m.kind !== 'leader');
    return `
    <section class="view">
      <div class="page-head">
        <div>
          <h2>비서현황</h2>
          <p>${helpers.length}명의 비서가 이 비서실에서 일합니다.</p>
        </div>
        <button class="btn sm" data-act="settings" data-settings-tab="members">${ICON.plus} 멤버 관리</button>
      </div>

      <div class="team-grid">
        ${S.state.members.map(memberMarkup).join('')}
      </div>

      <div class="guide">
        <div class="guide-head">
          <span style="font-size:18px">🔌</span>
          <div>
            <h3>서브폰 피클 · 다른 AI 연결 가이드</h3>
            <span>한 번만 해 두면 이 비서실이 '합동 비서실'이 됩니다.</span>
          </div>
        </div>
        <div class="guide-cols">
          <div class="guide-col">
            <h4>🥒 서브폰 피클 연결</h4>
            <ol>
              <li>서브폰에 <b>Pickle 앱</b>을 설치하고 새 프로필을 만듭니다.</li>
              <li>복님이 Pickle에서 <b>서브피클을 친구 추가</b>합니다(핸들 교환).</li>
              <li>서브피클에게 <b>"복님이 비서실에 연결해줘"</b>라고 말합니다.</li>
              <li>이 페이지 주소와 아래 SQL을 서브피클에게 전달합니다.</li>
            </ol>
          </div>
          <div class="guide-col">
            <h4>⚡ 실시간 합동 비서실 켜기</h4>
            <ol>
              <li>Supabase → 프로젝트 <b>qqaogodxzfiuxhkkfjwt</b> → <b>SQL Editor</b>.</li>
              <li><b>SQL 복사</b>를 눌러 붙여넣고 <b>RUN</b>.</li>
              <li>이 페이지를 새로고침하면 배지가 <b>실시간 동기화</b>로 바뀝니다.</li>
            </ol>
          </div>
        </div>
        <div class="guide-actions">
          <button class="btn sm primary" data-act="copy-sql">${ICON.copy} SQL 복사</button>
          <a class="btn sm" href="https://supabase.com/dashboard/project/qqaogodxzfiuxhkkfjwt/sql/new" target="_blank" rel="noopener">${ICON.link} Supabase SQL 열기</a>
          <button class="btn sm ghost" data-act="settings" data-settings-tab="ai">AI 키 넣기</button>
        </div>
      </div>
    </section>`;
  }

  function memberMarkup(m) {
    const isLeader = m.kind === 'leader';
    const linked = AI.isConnected(m);
    const statusPill = isLeader
      ? '<span class="pill brand"><span class="dot"></span>대장님</span>'
      : m.kind === 'pickle'
        ? '<span class="pill brand"><span class="dot"></span>Pickle</span>'
        : linked
          ? '<span class="pill ok"><span class="dot"></span>연결됨</span>'
          : '<span class="pill warn"><span class="dot"></span>키 없음</span>';
    return `
      <article class="member card ${isLeader ? 'is-leader' : ''}">
        <div class="member-top">
          <div class="member-avatar">${esc(m.emoji)}</div>
          <div class="member-id">
            <div class="member-name">${esc(m.name)}</div>
            <div class="member-role">${esc(m.role)}</div>
          </div>
          <button class="member-edit" data-act="member-edit" data-id="${esc(m.id)}" aria-label="편집">${ICON.edit}</button>
        </div>
        <div class="member-row">
          ${statusPill}
          <span class="pill">${esc(m.model || '모델 미지정')}</span>
          <span class="pill">${esc(m.status || '대기')}</span>
        </div>
        <div class="member-chans">
          ${(m.channels || []).map((cid) => {
            const c = S.state.channels.find((x) => x.id === cid);
            return c ? `<span class="pill">${esc(c.emoji)} ${esc(c.name)}</span>` : '';
          }).join('') || '<span class="pill">담당 채널 없음</span>'}
        </div>
      </article>`;
  }

  /* ── 메모 ───────────────────────────────────────────────── */
  function memosMarkup() {
    const list = [...S.state.memos].sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (a.updatedAt < b.updatedAt ? 1 : -1));
    return `
    <section class="view">
      <div class="page-head">
        <div>
          <h2>메모</h2>
          <p>비서들과 공유하는 짧은 기록. 중요한 건 상단에 고정하세요.</p>
        </div>
      </div>

      <form class="memo-form card" id="memoForm">
        <div class="row">
          <input type="text" id="memoTitle" placeholder="제목 (없어도 됩니다)" maxlength="120" autocomplete="off">
          <button class="btn primary" type="submit">${ICON.plus} 추가</button>
        </div>
        <textarea id="memoBody" placeholder="내용을 적어 두세요. 예: 이번 주 쇼츠 소재 3개, 병원 예약 시간…" maxlength="4000"></textarea>
      </form>

      ${list.length ? `<div class="memo-grid">${list.map(memoMarkup).join('')}</div>` : `
        <div class="empty">
          <div class="emoji">📝</div>
          <h4>메모가 비어 있어요</h4>
          <p>위에서 바로 적어 추가할 수 있습니다.</p>
        </div>`}
    </section>`;
  }

  function memoMarkup(m) {
    return `
      <article class="memo card ${m.pinned ? 'is-pinned' : ''}">
        <div class="memo-top">
          <div class="memo-title">${m.title ? esc(m.title) : '<span class="muted">제목 없음</span>'}</div>
          <button class="memo-btn ${m.pinned ? 'is-on' : ''}" data-act="memo-pin" data-id="${esc(m.id)}" aria-label="상단 고정" title="상단 고정">${ICON.pin}</button>
        </div>
        <div class="memo-body">${esc(m.body)}</div>
        <div class="memo-foot">
          <span class="small muted">${timeAgo(m.updatedAt)}</span>
          <button class="memo-btn" data-act="memo-edit" data-id="${esc(m.id)}" aria-label="편집">${ICON.edit}</button>
          <button class="memo-btn danger" data-act="memo-del" data-id="${esc(m.id)}" aria-label="삭제">${ICON.trash}</button>
        </div>
      </article>`;
  }

  /* ── 모달 공통 ──────────────────────────────────────────── */
  function openSheet(html, opts) {
    closeSheet();
    const root = $('#modalRoot');
    root.innerHTML = `<div class="sheet" data-sheet-backdrop>${html}</div>`;
    document.body.classList.add('sheet-open');
    const backdrop = $('[data-sheet-backdrop]', root);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop && (!opts || opts.dismissible !== false)) closeSheet();
    });
    const panel = $('.sheet-panel', root);
    if (panel) panel.addEventListener('mousedown', (e) => e.stopPropagation());
    const focusable = panel && panel.querySelector('input, textarea, select, button');
    if (focusable && (!opts || opts.autofocus !== false)) setTimeout(() => focusable.focus({ preventScroll: true }), 60);
  }
  function closeSheet() {
    $('#modalRoot').innerHTML = '';
    document.body.classList.remove('sheet-open');
  }

  /* ── 설정 ───────────────────────────────────────────────── */
  const PROVIDERS = [
    { id: 'openai', emoji: '🧠', name: 'OpenAI · GPT', desc: 'gpt-4o-mini · 유료(아주 저렴)', link: 'https://platform.openai.com/api-keys', hint: 'platform.openai.com → API keys' },
    { id: 'anthropic', emoji: '🍊', name: 'Anthropic · 클로드', desc: 'claude-sonnet-4-5 · 유료', link: 'https://console.anthropic.com/settings/keys', hint: 'console.anthropic.com → API keys' },
    { id: 'gemini', emoji: '✨', name: 'Google · 제미나이', desc: 'gemini-2.5-flash · 무료 등급 있음', link: 'https://aistudio.google.com/apikey', hint: 'aistudio.google.com → Get API key' },
  ];

  function settingsMarkup(tab) {
    return `
      <div class="sheet-panel">
        <div class="sheet-head">
          <div>
            <h3>비서실 설정</h3>
            <p>입력한 값은 이 브라우저(localStorage)에만 저장됩니다.</p>
          </div>
          <button class="sheet-close" data-act="sheet-close" aria-label="닫기">${ICON.close}</button>
        </div>
        <div class="sheet-body">
          <nav class="sheet-nav">
            <button data-act="settings-pane" data-pane="ai" class="${tab === 'ai' ? 'is-on' : ''}">🔑 AI 연결</button>
            <button data-act="settings-pane" data-pane="sync" class="${tab === 'sync' ? 'is-on' : ''}">🔄 동기화</button>
            <button data-act="settings-pane" data-pane="members" class="${tab === 'members' ? 'is-on' : ''}">👥 멤버</button>
            <button data-act="settings-pane" data-pane="device" class="${tab === 'device' ? 'is-on' : ''}">🎛 화면·데이터</button>
          </nav>
          <div class="sheet-content">
            <div class="pane ${tab === 'ai' ? 'is-on' : ''}" data-pane-body="ai">${paneAI()}</div>
            <div class="pane ${tab === 'sync' ? 'is-on' : ''}" data-pane-body="sync">${paneSync()}</div>
            <div class="pane ${tab === 'members' ? 'is-on' : ''}" data-pane-body="members">${paneMembers()}</div>
            <div class="pane ${tab === 'device' ? 'is-on' : ''}" data-pane-body="device">${paneDevice()}</div>
          </div>
        </div>
        <div class="sheet-foot">
          <button class="btn ghost" data-act="sheet-close">닫기</button>
          <button class="btn primary" data-act="settings-save">${ICON.check} 저장</button>
        </div>
      </div>`;
  }

  function paneAI() {
    return `
      <div>
        <div class="pane-title">AI 비서 키 연결</div>
        <p class="pane-desc">키를 넣은 비서만 실제 모델로 답합니다. 키가 없으면 '시뮬레이션'으로 답하고 답변에 표시가 붙습니다. 키는 서버로 보내지 않고 각 AI 회사로만 직접 전송됩니다.</p>
      </div>
      ${PROVIDERS.map((p) => {
        const key = S.settings.keys[p.id] || '';
        const model = S.settings.models[p.id] || '';
        return `
        <div class="provider" data-provider="${p.id}">
          <div class="provider-head">
            <div class="provider-mark">${p.emoji}</div>
            <div>
              <h4>${p.name}</h4>
              <p>${p.desc}</p>
            </div>
            <span class="pill ${key ? 'ok' : ''}" data-key-state="${p.id}">${key ? '키 있음' : '키 없음'}</span>
          </div>
          <div class="field">
            <label>API 키</label>
            <div class="key-row">
              <input class="input secret" type="password" data-key="${p.id}" value="${esc(key)}" placeholder="sk-… / AIza…" autocomplete="off" spellcheck="false">
              <button class="key-eye" data-act="key-eye" data-target="key-${p.id}" aria-label="키 보기">${ICON.eye}</button>
            </div>
            <span class="hint">${p.hint} · <a href="${p.link}" target="_blank" rel="noopener">키 발급 페이지</a></span>
          </div>
          <div class="provider-grid">
            <div class="field">
              <label>모델</label>
              <input class="input" type="text" data-model="${p.id}" value="${esc(model)}" autocomplete="off" spellcheck="false">
            </div>
            <div class="field">
              <label>연결 확인</label>
              <button class="btn sm" data-act="test-key" data-provider="${p.id}">테스트</button>
            </div>
          </div>
          <details>
            <summary class="hint" style="cursor:pointer">고급 — 프록시 주소 (보통은 비워 두세요)</summary>
            <div class="field" style="margin-top:8px">
              <input class="input" type="text" data-proxy="${p.id}" value="${esc((S.settings.proxy || {})[p.id] || '')}" placeholder="https://내-프록시.workers.dev" autocomplete="off" spellcheck="false">
              <span class="hint">${p.id === 'openai'
                ? 'OpenAI는 브라우저에서 직접 호출하면 CORS로 막히는 경우가 있습니다. 그때만 내 프록시 주소를 넣으세요. 제미나이·클로드는 그대로 동작합니다.'
                : '브라우저 직접 호출이 막히는 환경에서만 쓰세요.'}</span>
            </div>
          </details>
        </div>`;
      }).join('')}
      <div class="provider">
        <div class="provider-head">
          <div class="provider-mark">🥒</div>
          <div>
            <h4>Pickle 비서 (복님이 · 서브피클)</h4>
            <p>Pickle은 앱 안에서 대화합니다. 이 웹앱은 지시를 모아 두고, 복님이가 앱에서 이어받습니다.</p>
          </div>
        </div>
        <p class="pane-desc">서브피클을 붙이려면 Pickle 앱에서 복님이와 서브피클이 서로 친구가 된 뒤, 서브피클에게 이 페이지 주소를 알려 주세요.</p>
      </div>`;
  }

  function paneSync() {
    const live = S.sync.mode === 'live';
    return `
      <div class="sync-state ${live ? 'is-live' : ''}">
        <span class="dot"></span>
        <div>
          <h4>${live ? '실시간 동기화' : '로컬 모드'}</h4>
          <p>${live
            ? `Realtime ${S.sync.realtime === 'on' ? '연결됨' : '연결 중'} · 5초 백업 폴링 · 마지막 동기화 ${S.sync.lastSyncAt ? timeAgo(new Date(S.sync.lastSyncAt).toISOString()) : '—'}`
            : '이 브라우저에만 저장 중입니다. 아래 SQL을 한 번 실행하면 기기끼리 같은 비서실을 씁니다.'}</p>
        </div>
      </div>
      ${S.sync.detail ? `<p class="pane-desc">${esc(S.sync.detail)}</p>` : ''}

      <div class="field">
        <label>비서실 방 코드</label>
        <div class="key-row">
          <input class="input" type="text" id="roomCode" value="${esc(S.room())}" readonly>
          <button class="key-eye" data-act="copy-room" aria-label="복사">${ICON.copy}</button>
        </div>
        <span class="hint">두 기기가 같은 방 코드를 쓰면 같은 비서실이 됩니다. 바꾸려면 config.js의 ROOM 값을 고쳐 주세요.</span>
      </div>

      <div class="divider"></div>

      <div class="field">
        <label>1회 설정 — Supabase SQL</label>
        <span class="hint">office_messages · office_tasks · office_memos · office_members 표와 RLS·Realtime을 만듭니다. 기존 '우리끼리' 표는 건드리지 않고, 여러 번 실행해도 안전합니다.</span>
        <div class="key-row">
          <button class="btn sm primary" data-act="copy-sql">${ICON.copy} SQL 복사</button>
          <button class="btn sm" data-act="reconnect">연결 다시 확인</button>
          <a class="btn sm ghost" href="https://supabase.com/dashboard/project/qqaogodxzfiuxhkkfjwt/sql/new" target="_blank" rel="noopener">${ICON.link} SQL Editor</a>
        </div>
        <details>
          <summary class="hint" style="cursor:pointer;margin-top:4px">SQL 미리 보기</summary>
          <div class="code-box" id="sqlPreview" style="margin-top:8px">불러오는 중…</div>
        </details>
      </div>

      <div class="divider"></div>
      <div class="field">
        <label>주의</label>
        <span class="hint">이 비서실은 개인용입니다. 표를 만든 뒤에는 주소를 아는 사람이 접근할 수 있으니, 비밀번호·주민번호 같은 민감한 내용은 대화·메모에 적지 마세요.</span>
      </div>`;
  }

  function paneMembers() {
    return `
      <div>
        <div class="pane-title">멤버 · 담당</div>
        <p class="pane-desc">이름·역할·이모지를 바꾸면 회의실과 작업실에 바로 반영됩니다.</p>
      </div>
      <div class="member-list">
        ${S.state.members.map((m) => `
          <div class="member-row-edit">
            <input class="member-emoji-input" type="text" data-m-emoji="${esc(m.id)}" value="${esc(m.emoji)}" maxlength="4">
            <input type="text" data-m-name="${esc(m.id)}" value="${esc(m.name)}" placeholder="이름">
            <input type="text" data-m-role="${esc(m.id)}" value="${esc(m.role)}" placeholder="역할">
            <button class="btn sm ghost" data-act="member-edit" data-id="${esc(m.id)}">상세</button>
          </div>`).join('')}
      </div>
      <button class="btn" data-act="member-add">${ICON.plus} 새 비서 추가</button>
      <p class="pane-desc">새로 추가한 비서는 '시뮬레이션'으로 답합니다. OpenAI·Anthropic·Gemini 중 하나를 고르고 키를 넣으면 실제 모델로 바뀝니다.</p>`;
  }

  function paneDevice() {
    const t = S.settings.theme;
    return `
      <div>
        <div class="pane-title">화면</div>
        <div class="field">
          <label>테마</label>
          <select class="input" id="themeSelect">
            <option value="" ${t === '' ? 'selected' : ''}>시스템 설정 따르기</option>
            <option value="light" ${t === 'light' ? 'selected' : ''}>라이트 (크림)</option>
            <option value="dark" ${t === 'dark' ? 'selected' : ''}>다크 (밤)</option>
          </select>
        </div>
        <label class="switch" style="margin-top:8px">
          <input type="checkbox" id="simulateToggle" ${S.settings.simulate ? 'checked' : ''}>
          <span class="track"></span>
          <span class="label"><b>시뮬레이션 모드</b><span>키가 없는 비서도 예시 답변으로 회의를 이어갑니다.</span></span>
        </label>
      </div>

      <div class="divider"></div>

      <div>
        <div class="pane-title">화면 잠금 (PIN)</div>
        <p class="pane-desc">4자리 PIN을 켜면 앱을 열 때 한 번 물어봅니다. 기기 자체의 잠금은 아닙니다.</p>
        <div class="provider-grid">
          <div class="field"><label>새 PIN</label><input class="input" type="password" inputmode="numeric" maxlength="4" id="pinNew" placeholder="••••" autocomplete="off"></div>
          <div class="field"><label>한 번 더</label><input class="input" type="password" inputmode="numeric" maxlength="4" id="pinConfirm" placeholder="••••" autocomplete="off"></div>
        </div>
        <div class="key-row" style="margin-top:8px">
          <button class="btn sm" data-act="pin-save">PIN ${S.settings.pin ? '변경' : '켜기'}</button>
          ${S.settings.pin ? '<button class="btn sm danger" data-act="pin-clear">PIN 끄기</button>' : ''}
        </div>
      </div>

      <div class="divider"></div>

      <div>
        <div class="pane-title">데이터 · 앱 설치</div>
        <div class="key-row">
          <button class="btn sm" data-act="export">JSON 내보내기</button>
          <button class="btn sm danger" data-act="reset-local">이 기기 데이터 초기화</button>
        </div>
        <p class="pane-desc" style="margin-top:8px">아이폰은 <b>공유 → 홈 화면에 추가</b>, 안드로이드는 Chrome 메뉴의 <b>앱 설치</b>를 누르면 앱처럼 열립니다.<br>달콩 비서실 · v1 · ${S.sync.mode === 'live' ? '실시간' : '로컬'} 모드<br>대화 ${S.state.messages.length} · 작업 ${S.state.tasks.length} · 메모 ${S.state.memos.length}</p>
      </div>`;
  }

  function openSettings(tab) {
    ui.settingsTab = tab || ui.settingsTab || 'ai';
    openSheet(settingsMarkup(ui.settingsTab), { autofocus: false });
    if (ui.settingsTab === 'sync') loadSqlPreview();
    if (ui.settingsTab === 'members') loadSqlPreview();
  }

  async function loadSqlPreview() {
    const box = $('#sqlPreview');
    if (!box) return;
    try {
      const res = await fetch('./supabase_office.sql', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      box.textContent = text;
      box.dataset.sql = text;
    } catch (e) {
      box.textContent = 'supabase_office.sql 을 불러오지 못했습니다. 주소를 직접 열어 복사해 주세요.';
    }
  }

  function readSettingsForm() {
    const keys = { ...S.settings.keys };
    const models = { ...S.settings.models };
    const proxy = { ...(S.settings.proxy || {}) };
    $$('[data-key]').forEach((el) => { keys[el.dataset.key] = el.value.trim(); });
    $$('[data-model]').forEach((el) => { models[el.dataset.model] = el.value.trim(); });
    $$('[data-proxy]').forEach((el) => { proxy[el.dataset.proxy] = el.value.trim(); });
    S.saveSettings({ keys, models, proxy });
    $$('[data-key-state]').forEach((pill) => {
      const id = pill.dataset.keyState;
      const has = !!keys[id];
      pill.className = 'pill' + (has ? ' ok' : '');
      pill.textContent = has ? '키 있음' : '키 없음';
    });
  }

  /* ── 멤버 편집 시트 ─────────────────────────────────────── */
  function openMemberEditor(id) {
    const m = id ? S.memberById(id) : null;
    if (id && !m) return;
    const isNew = !m;
    const data = m || { emoji: '🙂', name: '', role: '', model: '', status: '대기', provider: 'none', kind: 'ai', channels: [] };
    openSheet(`
      <div class="sheet-panel narrow">
        <div class="sheet-head">
          <div><h3>${isNew ? '새 비서 추가' : '비서 편집'}</h3><p>${isNew ? '이름과 역할을 정해 주세요.' : esc(data.name)}</p></div>
          <button class="sheet-close" data-act="sheet-close" aria-label="닫기">${ICON.close}</button>
        </div>
        <div class="sheet-content" style="display:flex;flex-direction:column;gap:14px">
          <div class="provider-grid">
            <div class="field"><label>이모지</label><input class="input" id="edEmoji" type="text" maxlength="4" value="${esc(data.emoji)}"></div>
            <div class="field"><label>이름</label><input class="input" id="edName" type="text" maxlength="24" value="${esc(data.name)}" placeholder="예: 클로드"></div>
          </div>
          <div class="field"><label>역할</label><input class="input" id="edRole" type="text" maxlength="40" value="${esc(data.role)}" placeholder="예: 글쓰기 · 기획 검토"></div>
          <div class="provider-grid">
            <div class="field"><label>모델</label><input class="input" id="edModel" type="text" value="${esc(data.model)}" placeholder="예: gpt-4o-mini"></div>
            <div class="field"><label>상태 문구</label><input class="input" id="edStatus" type="text" maxlength="20" value="${esc(data.status)}" placeholder="온라인"></div>
          </div>
          <div class="field">
            <label>AI 연결</label>
            <select class="input" id="edProvider" ${data.kind === 'leader' ? 'disabled' : ''}>
              <option value="none" ${data.provider === 'none' ? 'selected' : ''}>연결 안 함 (Pickle · 시뮬레이션)</option>
              <option value="openai" ${data.provider === 'openai' ? 'selected' : ''}>OpenAI (GPT)</option>
              <option value="anthropic" ${data.provider === 'anthropic' ? 'selected' : ''}>Anthropic (클로드)</option>
              <option value="gemini" ${data.provider === 'gemini' ? 'selected' : ''}>Google (제미나이)</option>
            </select>
          </div>
          <div class="field">
            <label>담당 채널</label>
            <div class="member-chans">
              ${S.state.channels.map((c) => `
                <label class="pill" style="cursor:pointer;gap:6px">
                  <input type="checkbox" data-ed-chan="${esc(c.id)}" ${(data.channels || []).includes(c.id) ? 'checked' : ''} style="accent-color:var(--brand)">
                  ${esc(c.emoji)} ${esc(c.name)}
                </label>`).join('')}
            </div>
          </div>
        </div>
        <div class="sheet-foot">
          ${isNew ? '' : (data.kind === 'leader' ? '' : '<button class="btn danger" data-act="member-del" data-id="' + esc(data.id) + '">삭제</button>')}
          <button class="btn ghost" data-act="sheet-close">취소</button>
          <button class="btn primary" data-act="member-save" data-id="${esc(data.id || '')}">저장</button>
        </div>
      </div>`);
  }

  function saveMember(id) {
    const emoji = ($('#edEmoji') || {}).value || '🙂';
    const name = (($('#edName') || {}).value || '').trim();
    const role = (($('#edRole') || {}).value || '').trim();
    const model = (($('#edModel') || {}).value || '').trim();
    const status = (($('#edStatus') || {}).value || '대기').trim();
    const provider = ($('#edProvider') || {}).value || 'none';
    const channels = $$('[data-ed-chan]').filter((el) => el.checked).map((el) => el.dataset.edChan);
    if (!name) { toast('이름을 적어 주세요.'); return; }
    if (id) {
      S.updateMember(id, { emoji, name, role, model, status, provider, channels });
      toast('비서 정보를 저장했습니다.');
    } else {
      S.addMember({ emoji, name, role, model, provider, channels, kind: provider === 'none' ? 'pickle' : 'ai' });
      toast(`${name} 비서를 추가했습니다.`);
    }
    closeSheet();
  }

  /* ── 채널 추가 시트 ─────────────────────────────────────── */
  function openChannelSheet() {
    openSheet(`
      <div class="sheet-panel narrow">
        <div class="sheet-head">
          <div><h3>새 채널</h3><p>주제별로 대화를 나눠 보세요.</p></div>
          <button class="sheet-close" data-act="sheet-close" aria-label="닫기">${ICON.close}</button>
        </div>
        <div class="sheet-content" style="display:flex;flex-direction:column;gap:14px">
          <div class="provider-grid">
            <div class="field"><label>이모지</label><input class="input" id="chEmoji" type="text" maxlength="4" value="💬"></div>
            <div class="field"><label>채널 이름</label><input class="input" id="chName" type="text" maxlength="24" placeholder="예: 아이디어"></div>
          </div>
          <div class="field"><label>설명</label><input class="input" id="chDesc" type="text" maxlength="40" placeholder="예: 떠오르는 소재 모아두기"></div>
        </div>
        <div class="sheet-foot">
          <button class="btn ghost" data-act="sheet-close">취소</button>
          <button class="btn primary" data-act="channel-save">만들기</button>
        </div>
      </div>`);
  }

  /* ── 메모 편집 시트 ─────────────────────────────────────── */
  function openMemoEditor(id) {
    const m = S.state.memos.find((x) => x.id === id);
    if (!m) return;
    openSheet(`
      <div class="sheet-panel narrow">
        <div class="sheet-head">
          <div><h3>메모 편집</h3><p>${timeAgo(m.updatedAt)} 수정</p></div>
          <button class="sheet-close" data-act="sheet-close" aria-label="닫기">${ICON.close}</button>
        </div>
        <div class="sheet-content" style="display:flex;flex-direction:column;gap:12px">
          <div class="field"><label>제목</label><input class="input" id="memoEditTitle" type="text" maxlength="120" value="${esc(m.title)}"></div>
          <div class="field"><label>내용</label><textarea class="input" id="memoEditBody" style="height:190px;padding:10px 12px;line-height:1.6">${esc(m.body)}</textarea></div>
          <label class="switch">
            <input type="checkbox" id="memoEditPinned" ${m.pinned ? 'checked' : ''}>
            <span class="track"></span><span class="label"><b>상단에 고정</b><span>늘 맨 위에 보입니다.</span></span>
          </label>
        </div>
        <div class="sheet-foot">
          <button class="btn ghost" data-act="sheet-close">취소</button>
          <button class="btn primary" data-act="memo-save" data-id="${esc(m.id)}">저장</button>
        </div>
      </div>`);
  }

  /* ── PIN ────────────────────────────────────────────────── */
  let pinBuffer = '';
  function pinStart() {
    if (!S.settings.pin) return;
    if (sessionStorage.getItem('dalkong.office.unlocked') === '1') return;
    const gate = $('#pinGate');
    gate.hidden = false;
    pinBuffer = '';
    renderPin();
    document.body.classList.add('lock-scroll');
  }
  function renderPin() {
    $$('#pinDots i').forEach((d, i) => d.classList.toggle('on', i < pinBuffer.length));
    $('#pinError').hidden = true;
  }
  function pinPress(v) {
    if (v === 'del') pinBuffer = pinBuffer.slice(0, -1);
    else if (v === 'clear') pinBuffer = '';
    else if (pinBuffer.length < 4) pinBuffer += v;
    renderPin();
    if (pinBuffer.length === 4) {
      if (pinBuffer === String(S.settings.pin)) {
        sessionStorage.setItem('dalkong.office.unlocked', '1');
        $('#pinGate').hidden = true;
        document.body.classList.remove('lock-scroll');
      } else {
        $('#pinError').hidden = false;
        pinBuffer = '';
        renderPin();
        $('#pinError').hidden = false;
        setTimeout(() => { pinBuffer = ''; renderPin(); }, 550);
      }
    }
  }

  /* ── 이벤트 ─────────────────────────────────────────────── */
  document.addEventListener('click', async (e) => {
    const pinBtn = e.target.closest('[data-pin]');
    if (pinBtn) { pinPress(pinBtn.dataset.pin); return; }

    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;

    switch (act) {
      case 'tab': {
        ui.tab = el.dataset.tab;
        localStorage.setItem('dalkong.office.tab', ui.tab);
        ui.stickBottom = true;
        paint();
        break;
      }
      case 'theme': {
        const cur = document.documentElement.getAttribute('data-theme');
        const next = cur === 'dark' ? 'light' : 'dark';
        S.saveSettings({ theme: next });
        applyTheme();
        break;
      }
      case 'channel': {
        ui.channel = el.dataset.ch;
        localStorage.setItem('dalkong.office.channel', ui.channel);
        ui.stickBottom = true;
        paint();
        break;
      }
      case 'mention': {
        insertMention(el.dataset.name);
        break;
      }
      case 'debate': {
        const ta = $('#composerInput');
        const text = ta ? ta.value.trim() : ui.draft.trim();
        if (text) {
          ui.debateMode = false;
          sendLeader(text, { debate: true });
        } else {
          ui.debateMode = !ui.debateMode;
          paint();
        }
        break;
      }
      case 'send': {
        sendLeader(ui.draft, { debate: ui.debateMode });
        break;
      }
      case 'task-filter': {
        ui.filter = el.dataset.f;
        paint();
        break;
      }
      case 'task-status': {
        S.updateTask(el.dataset.id, { status: el.dataset.s });
        break;
      }
      case 'task-del': {
        if (confirm('이 지시를 삭제할까요?')) { S.deleteTask(el.dataset.id); toast('삭제했습니다.'); }
        break;
      }
      case 'task-note': {
        ui.openNote.add(el.dataset.id);
        paint();
        const ta = document.getElementById('note-' + el.dataset.id);
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        break;
      }
      case 'member-edit': {
        openMemberEditor(el.dataset.id);
        break;
      }
      case 'member-save': {
        saveMember(el.dataset.id || '');
        break;
      }
      case 'member-add': {
        openMemberEditor(null);
        break;
      }
      case 'member-del': {
        if (confirm('이 비서를 목록에서 삭제할까요? (대화는 남습니다)')) {
          S.deleteMember(el.dataset.id);
          closeSheet();
          toast('삭제했습니다.');
        }
        break;
      }
      case 'memo-edit': openMemoEditor(el.dataset.id); break;
      case 'memo-pin': {
        const m = S.state.memos.find((x) => x.id === el.dataset.id);
        if (m) S.updateMemo(m.id, { pinned: !m.pinned });
        break;
      }
      case 'memo-del': {
        if (confirm('이 메모를 삭제할까요?')) { S.deleteMemo(el.dataset.id); toast('삭제했습니다.'); }
        break;
      }
      case 'memo-save': {
        const title = ($('#memoEditTitle') || {}).value || '';
        const body = ($('#memoEditBody') || {}).value || '';
        const pinned = !!($('#memoEditPinned') || {}).checked;
        S.updateMemo(el.dataset.id, { title: title.trim(), body, pinned });
        closeSheet();
        toast('메모를 저장했습니다.');
        break;
      }
      case 'chan-add': openChannelSheet(); break;
      case 'channel-save': {
        const ch = S.addChannel({
          emoji: ($('#chEmoji') || {}).value || '💬',
          name: ($('#chName') || {}).value || '',
          desc: ($('#chDesc') || {}).value || '',
        });
        if (!ch) { toast('채널 이름을 확인해 주세요.'); break; }
        ui.channel = ch.id;
        localStorage.setItem('dalkong.office.channel', ch.id);
        closeSheet();
        toast(`#${ch.name} 채널을 만들었습니다.`);
        paint();
        break;
      }
      case 'settings': {
        openSettings(el.dataset.settingsTab);
        break;
      }
      case 'settings-pane': {
        $$('.sheet-nav button').forEach((b) => b.classList.toggle('is-on', b === el));
        $$('[data-pane-body]').forEach((p) => p.classList.toggle('is-on', p.dataset.paneBody === el.dataset.pane));
        if (el.dataset.pane === 'sync' || el.dataset.pane === 'members') loadSqlPreview();
        break;
      }
      case 'settings-save': {
        readSettingsForm();
        const th = $('#themeSelect');
        if (th) S.saveSettings({ theme: th.value });
        const sim = $('#simulateToggle');
        if (sim) S.saveSettings({ simulate: sim.checked });
        applyTheme();
        closeSheet();
        toast('저장했습니다.');
        paint();
        break;
      }
      case 'sheet-close': closeSheet(); break;
      case 'key-eye': {
        const target = el.parentElement.querySelector('input');
        if (target) {
          const show = target.type === 'password';
          target.type = show ? 'text' : 'password';
          el.style.color = show ? 'var(--brand)' : '';
        }
        break;
      }
      case 'test-key': {
        const p = el.dataset.provider;
        readSettingsForm();
        el.disabled = true;
        const prev = el.textContent;
        el.textContent = '확인 중…';
        const res = await AI.testKey(p);
        el.disabled = false;
        el.textContent = prev;
        toast(res.ok ? `${p.toUpperCase()} 연결됐습니다 ✓` : `${p.toUpperCase()} 실패 — ${res.message}`);
        paintChrome();
        break;
      }
      case 'copy-sql': {
        await copySql();
        break;
      }
      case 'copy-room': {
        await copyText(S.room(), '방 코드를 복사했습니다. 다른 기기의 config.js ROOM 값에 넣어 주세요.');
        break;
      }
      case 'reconnect': {
        toast('연결을 다시 확인합니다…');
        await S.reconnect();
        toast(S.sync.mode === 'live' ? '실시간 동기화로 연결됐습니다.' : '아직 표가 없어 로컬 모드입니다.');
        const body = $('[data-pane-body="sync"]');
        if (body) { body.innerHTML = paneSync(); loadSqlPreview(); }
        paintChrome();
        break;
      }
      case 'pin-save': {
        const a = ($('#pinNew') || {}).value || '';
        const b = ($('#pinConfirm') || {}).value || '';
        if (!/^\d{4}$/.test(a)) { toast('숫자 4자리로 정해 주세요.'); break; }
        if (a !== b) { toast('두 번 입력한 PIN이 다릅니다.'); break; }
        S.saveSettings({ pin: a });
        toast('PIN을 켰습니다.');
        const body = $('[data-pane-body="device"]');
        if (body) body.innerHTML = paneDevice();
        break;
      }
      case 'pin-clear': {
        S.saveSettings({ pin: '' });
        sessionStorage.removeItem('dalkong.office.unlocked');
        toast('PIN을 껐습니다.');
        const body = $('[data-pane-body="device"]');
        if (body) body.innerHTML = paneDevice();
        break;
      }
      case 'export': {
        const data = JSON.stringify({
          exportedAt: new Date().toISOString(),
          channels: S.state.channels, members: S.state.members,
          messages: S.state.messages, tasks: S.state.tasks, memos: S.state.memos,
        }, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dalkong-office-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        break;
      }
      case 'reset-local': {
        if (confirm('이 기기의 비서실 데이터를 모두 지울까요? (서버에 있는 데이터는 남습니다)')) {
          S.resetLocal();
          location.reload();
        }
        break;
      }
      default: break;
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'taskForm') {
      e.preventDefault();
      const title = ($('#taskTitle') || {}).value || '';
      const assignee = ($('#taskAssignee') || {}).value || '';
      const t = S.addTask({ title, assignee });
      if (t) {
        $('#taskTitle').value = '';
        toast(`${(S.memberById(assignee) || {}).name || '비서'}에게 넘겼습니다.`);
        setTimeout(() => { const input = $('#taskTitle'); if (input) input.focus({ preventScroll: true }); }, 80);
      } else toast('내용을 적어 주세요.');
      return;
    }
    if (e.target.id === 'memoForm') {
      e.preventDefault();
      const title = ($('#memoTitle') || {}).value || '';
      const body = ($('#memoBody') || {}).value || '';
      const m = S.addMemo({ title, body });
      if (m) {
        $('#memoTitle').value = '';
        $('#memoBody').value = '';
        toast('메모를 추가했습니다.');
      } else toast('내용을 적어 주세요.');
      return;
    }
  });

  /* 입력 이벤트 */
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'composerInput') {
      ui.draft = t.value;
      t.style.height = 'auto';
      t.style.height = Math.min(132, t.scrollHeight) + 'px';
      return;
    }
    if (t.dataset && t.dataset.note) {
      S.updateTask(t.dataset.note, { note: t.value }, { silent: true });
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.id === 'composerInput') {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendLeader(ui.draft, { debate: ui.debateMode });
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && e.target && e.target.id === 'taskTitle') {
      const form = $('#taskForm');
      if (form) form.requestSubmit();
    }
    if (e.key === 'Escape') closeSheet();
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.dataset && t.dataset.key) {
      readSettingsForm();
    }
    if (t.dataset && t.dataset.mName) {
      const id = t.dataset.mName;
      const name = t.value.trim();
      const roleEl = document.querySelector(`[data-m-role="${CSS.escape(id)}"]`);
      const emojiEl = document.querySelector(`[data-m-emoji="${CSS.escape(id)}"]`);
      S.updateMember(id, { name: name || '비서', role: roleEl ? roleEl.value.trim() : undefined, emoji: emojiEl ? emojiEl.value || '🙂' : undefined });
      paint();
    }
    if (t.dataset && t.dataset.mRole) {
      const id = t.dataset.mRole;
      const nameEl = document.querySelector(`[data-m-name="${CSS.escape(id)}"]`);
      S.updateMember(id, { role: t.value.trim(), name: nameEl ? nameEl.value.trim() || '비서' : undefined });
      paint();
    }
    if (t.dataset && t.dataset.mEmoji) {
      S.updateMember(t.dataset.mEmoji, { emoji: t.value || '🙂' });
      paint();
    }
    if (t.id === 'themeSelect') {
      S.saveSettings({ theme: t.value });
      applyTheme();
    }
    if (t.id === 'simulateToggle') {
      S.saveSettings({ simulate: t.checked });
      paintChrome();
      toast(t.checked ? '시뮬레이션 모드를 켰습니다.' : '시뮬레이션을 껐습니다. 키 없는 비서는 답하지 않습니다.');
    }
  });

  function insertMention(name) {
    const ta = $('#composerInput');
    const mention = name === '전체' ? '@전체 ' : `@${name} `;
    if (!ta) { ui.draft += mention; return; }
    const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
    const end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const glue = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + glue + mention + after;
    ui.draft = ta.value;
    const pos = (before + glue + mention).length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    ta.style.height = 'auto';
    ta.style.height = Math.min(132, ta.scrollHeight) + 'px';
  }

  async function copySql() {
    let text = '';
    const box = $('#sqlPreview');
    if (box && box.dataset.sql) text = box.dataset.sql;
    if (!text) {
      try {
        const res = await fetch('./supabase_office.sql', { cache: 'no-store' });
        if (res.ok) text = await res.text();
      } catch (e) { /* 아래에서 안내 */ }
    }
    if (!text) { toast('SQL 파일을 불러오지 못했습니다. supabase_office.sql 을 직접 열어 주세요.'); return; }
    await copyText(text, 'SQL을 복사했습니다. Supabase SQL Editor에 붙여넣고 RUN 하세요.');
  }

  async function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(okMsg || '복사했습니다.');
    } catch (e) {
      toast('복사에 실패했습니다. 직접 선택해 복사해 주세요.');
    }
  }

  /* ── 구독 · 시작 ────────────────────────────────────────── */
  S.subscribe((reason) => {
    if (reason === 'sync') { paintChrome(); scheduleRender(); }
    else if (reason === 'sync-tick') { paintChrome(); }
    else if (reason === 'sync-data') { scheduleRender(); }
    else { scheduleRender(); }
  });

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  function init() {
    applyTheme();
    const params = new URLSearchParams(location.search);
    const qt = params.get('tab');
    if (['room', 'tasks', 'team', 'memos'].includes(qt)) ui.tab = qt;
    if (!channelOf(ui.channel)) ui.channel = (S.state.channels[0] || {}).id || 'general';
    if (!['room', 'tasks', 'team', 'memos'].includes(ui.tab)) ui.tab = 'room';
    paint();
    pinStart();
    S.detect().then(() => paintChrome());
    window.addEventListener('beforeunload', () => S.flushPersist());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

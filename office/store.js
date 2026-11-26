/* ─────────────────────────────────────────────────────────────
   달콩 비서실 — 저장소 & 동기화
   · 로컬(localStorage)이 항상 1차 저장소입니다. 앱은 절대 멈추지 않습니다.
   · Supabase office_* 표가 있으면 실시간(Realtime) + 5초 폴링으로
     기기끼리 같은 비서실을 씁니다.
   ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  const CFG = window.OFFICE_CONFIG;
  const K_SET = 'dalkong.office.settings.v1';
  const K_DATA = 'dalkong.office.data.v1';

  const uid = () => (window.crypto && crypto.randomUUID
    ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));

  const nowISO = () => new Date().toISOString();

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 저장 공간 부족 등 */ }
  }

  const DEFAULT_SETTINGS = {
    keys: { openai: '', anthropic: '', gemini: '' },
    models: { openai: CFG.MODELS.openai, anthropic: CFG.MODELS.anthropic, gemini: CFG.MODELS.gemini },
    proxy: { openai: '', anthropic: '', gemini: '' },
    simulate: true,
    theme: '',
    pin: '',
    room: CFG.ROOM,
  };

  function loadSettings() {
    const saved = readJSON(K_SET, {}) || {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      keys: { ...DEFAULT_SETTINGS.keys, ...(saved.keys || {}) },
      models: { ...DEFAULT_SETTINGS.models, ...(saved.models || {}) },
      proxy: { ...DEFAULT_SETTINGS.proxy, ...(saved.proxy || {}) },
    };
  }

  const settings = loadSettings();

  const state = {
    channels: [],
    members: [],
    messages: [],
    tasks: [],
    memos: [],
  };

  /* ── 구독 ───────────────────────────────────────────────── */
  const listeners = new Set();
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(reason) { listeners.forEach((fn) => { try { fn(reason); } catch (e) { console.warn(e); } }); }

  /* ── 최초 데이터 ────────────────────────────────────────── */
  function seed() {
    state.channels = CFG.CHANNELS.map((c) => ({ ...c }));
    state.members = CFG.MEMBERS.map((m) => ({ ...m, channels: [...m.channels] }));
    const t = Date.now();
    state.messages = [{
      id: uid(),
      channel: 'general',
      authorId: 'boknim',
      authorName: '복님이',
      authorKind: 'pickle',
      body: '대장님, 「달콩 비서실」 문 열었습니다 🥒\n' +
            '여기서 저랑 서브피클, GPT · 클로드 · 제미나이가 한 채널에 모여 일합니다.\n\n' +
            '· 부르고 싶은 비서는 아래 칩으로 @멘션하거나 그냥 이름을 불러 주세요.\n' +
            '· 설정(⚙️) → AI 연결에 키를 넣으면 GPT·클로드·제미나이가 진짜로 답합니다. 지금은 시뮬레이션 모드예요.\n' +
            '· 두 대 이상에서 같이 쓰려면 설정 → 동기화에서 SQL을 한 번 실행해 주세요.',
      kind: 'chat',
      meta: {},
      createdAt: new Date(t - 60 * 1000).toISOString(),
    }];
    state.tasks = [
      { id: uid(), title: '다인이네 숏츠 Ver.1 포맷으로 이번 주 3편 올리기', assignee: 'boknim', status: 'doing', note: 'K덕톡 스타일 하이라이트 + 140BPM 테크노 리믹스', createdAt: new Date(t - 3 * 3600e3).toISOString(), updatedAt: new Date(t - 3600e3).toISOString() },
      { id: uid(), title: '이 비서실 슬랙 #회의실에 프로젝트로 등록', assignee: 'boknim', status: 'done', note: 'C0CKSPC209M', createdAt: new Date(t - 5 * 3600e3).toISOString(), updatedAt: new Date(t - 2 * 3600e3).toISOString() },
      { id: uid(), title: '서브폰 피클 친구 추가하고 서브피클 연결하기', assignee: 'subpickle', status: 'todo', note: '서브폰 Pickle 앱 → 친구 추가 → 복님이에게 핸들 전달', createdAt: new Date(t - 30 * 60e3).toISOString(), updatedAt: new Date(t - 30 * 60e3).toISOString() },
    ];
    state.memos = [
      { id: uid(), title: '비서실 사용법', body: '· @전체 → 다섯 비서가 차례로 답합니다.\n· 💬 토론(2바퀴) → 연결된 AI끼리 서로 의견을 주고받습니다.\n· 작업실에서 지시를 카드로 만들고 대기 → 진행 → 완료로 넘기세요.\n· 메모는 상단 고정해 두면 늘 맨 위에 있습니다.', pinned: true, createdAt: new Date(t - 90 * 60e3).toISOString(), updatedAt: new Date(t - 90 * 60e3).toISOString() },
    ];
  }

  function normalizeMember(m) {
    return {
      id: m.id, emoji: m.emoji || '🙂', name: m.name || '비서', role: m.role || '',
      model: m.model || '', status: m.status || '대기', provider: m.provider || 'none',
      kind: m.kind || 'ai', channels: Array.isArray(m.channels) ? m.channels : [],
      sort: typeof m.sort === 'number' ? m.sort : 99,
    };
  }

  function load() {
    const data = readJSON(K_DATA, null);
    if (!data || !Array.isArray(data.channels) || !data.channels.length) {
      seed();
      persist();
      return;
    }
    state.channels = data.channels.map((c) => ({ ...c }));
    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    state.memos = Array.isArray(data.memos) ? data.memos : [];
    state.messages = Array.isArray(data.messages) ? data.messages : [];

    // 기본 멤버는 항상 보장하고, 사용자가 고친 값은 그대로 둡니다.
    const saved = new Map((Array.isArray(data.members) ? data.members : []).map((m) => [m.id, normalizeMember(m)]));
    CFG.MEMBERS.forEach((m) => { if (!saved.has(m.id)) saved.set(m.id, normalizeMember(m)); });
    state.members = [...saved.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'ko'));
  }

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      writeJSON(K_DATA, {
        channels: state.channels,
        members: state.members,
        messages: state.messages.slice(-CFG.MAX_MESSAGES),
        tasks: state.tasks,
        memos: state.memos,
        savedAt: nowISO(),
      });
    }, 200);
  }
  function flushPersist() {
    clearTimeout(saveTimer);
    writeJSON(K_DATA, {
      channels: state.channels,
      members: state.members,
      messages: state.messages.slice(-CFG.MAX_MESSAGES),
      tasks: state.tasks,
      memos: state.memos,
      savedAt: nowISO(),
    });
  }

  /* ── 동기화 ─────────────────────────────────────────────── */
  const pending = new Map(); // id -> { table, type, row?, id }
  let client = null;
  let pullTimer = null;
  let pollTimer = null;
  let rtChannel = null;
  let pulling = false;

  const sync = {
    mode: 'local',          // 'local' | 'live'
    status: 'connecting',   // 'connecting' | 'live' | 'local' | 'error'
    detail: '',
    realtime: 'off',        // 'off' | 'subscribing' | 'on'
    lastSyncAt: 0,
  };

  function room() { return settings.room || CFG.ROOM; }

  function rowToMessage(r) {
    return {
      id: r.id, channel: r.channel, authorId: r.author_id || '', authorName: r.author_name || '비서',
      authorKind: r.author_kind || 'ai', body: r.body, kind: r.kind || 'chat',
      meta: r.meta || {}, createdAt: r.created_at,
    };
  }
  function messageToRow(m) {
    return {
      id: m.id, room: room(), channel: m.channel, author_id: m.authorId || '', author_name: m.authorName,
      author_kind: m.authorKind || 'ai', body: m.body, kind: m.kind || 'chat', meta: m.meta || {},
      created_at: m.createdAt,
    };
  }
  function rowToTask(r) {
    return { id: r.id, title: r.title, assignee: r.assignee || '', status: r.status || 'todo', note: r.note || '', createdAt: r.created_at, updatedAt: r.updated_at };
  }
  function taskToRow(t) {
    return { id: t.id, room: room(), title: t.title, assignee: t.assignee || '', status: t.status, note: t.note || '', created_at: t.createdAt, updated_at: t.updatedAt };
  }
  function rowToMemo(r) {
    return { id: r.id, title: r.title || '', body: r.body || '', pinned: !!r.pinned, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  function memoToRow(m) {
    return { id: m.id, room: room(), title: m.title || '', body: m.body, pinned: !!m.pinned, created_at: m.createdAt, updated_at: m.updatedAt };
  }
  function rowToMember(r) {
    return normalizeMember({
      id: r.id, emoji: r.emoji, name: r.name, role: r.role, model: r.model, status: r.status,
      provider: r.provider, kind: r.kind, channels: r.channels || [], sort: r.sort,
    });
  }
  function memberToRow(m) {
    return {
      id: m.id, room: room(), emoji: m.emoji, name: m.name, role: m.role, model: m.model,
      status: m.status, provider: m.provider, kind: m.kind, channels: m.channels || [], sort: m.sort || 0,
    };
  }

  function queueUpsert(table, row, id) {
    pending.set(id, { table, type: 'upsert', row, id });
    flushQueue();
  }
  function queueDelete(table, id) {
    pending.set(id, { table, type: 'delete', id });
    flushQueue();
  }

  let flushing = false;
  async function flushQueue() {
    if (sync.mode !== 'live' || !client || flushing) return;
    flushing = true;
    try {
      for (const [id, op] of [...pending.entries()]) {
        try {
          let res;
          if (op.type === 'upsert') res = await client.from(op.table).upsert(op.row, { onConflict: 'id' });
          else res = await client.from(op.table).delete().eq('id', op.id).eq('room', room());
          if (res && res.error) throw res.error;
          pending.delete(id);
        } catch (e) {
          // 다음 폴링에서 다시 시도합니다. (오프라인·일시 오류)
          console.warn('[office] 전송 대기', op.table, e && e.message ? e.message : e);
        }
      }
    } finally { flushing = false; }
  }

  function sigOf(list, fields) {
    return list.map((x) => fields.map((f) => x[f]).join('~')).join('|');
  }

  async function pull() {
    if (sync.mode !== 'live' || !client || pulling) return;
    pulling = true;
    try {
      const roomCode = room();
      const [msgRes, taskRes, memoRes, memRes] = await Promise.all([
        client.from('office_messages').select('*').eq('room', roomCode).order('created_at', { ascending: false }).limit(CFG.MAX_MESSAGES),
        client.from('office_tasks').select('*').eq('room', roomCode).order('created_at', { ascending: true }),
        client.from('office_memos').select('*').eq('room', roomCode).order('created_at', { ascending: true }),
        client.from('office_members').select('*').eq('room', roomCode).order('sort', { ascending: true }),
      ]);
      if (msgRes.error) throw msgRes.error;

      let dirty = false;

      // messages
      const remoteMsgs = (msgRes.data || []).map(rowToMessage).reverse();
      const localPendingMsg = new Set([...pending.values()].filter((p) => p.table === 'office_messages').map((p) => p.id));
      const mMap = new Map(remoteMsgs.map((m) => [m.id, m]));
      state.messages.filter((m) => localPendingMsg.has(m.id)).forEach((m) => mMap.set(m.id, m));
      const mergedMsgs = [...mMap.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)).slice(-CFG.MAX_MESSAGES);
      if (sigOf(mergedMsgs, ['id']) !== sigOf(state.messages, ['id'])) { state.messages = mergedMsgs; dirty = true; }
      else { state.messages = mergedMsgs; }

      // tasks
      if (taskRes.error) throw taskRes.error;
      const remoteTasks = (taskRes.data || []).map(rowToTask);
      const pendingTasks = [...pending.values()].filter((p) => p.table === 'office_tasks');
      const tMap = new Map(remoteTasks.map((t) => [t.id, t]));
      state.tasks.filter((t) => pendingTasks.some((p) => p.id === t.id && p.type === 'upsert')).forEach((t) => tMap.set(t.id, t));
      pendingTasks.filter((p) => p.type === 'delete').forEach((p) => tMap.delete(p.id));
      const mergedTasks = [...tMap.values()];
      if (sigOf(mergedTasks, ['id', 'status', 'updatedAt']) !== sigOf(state.tasks, ['id', 'status', 'updatedAt'])) { state.tasks = mergedTasks; dirty = true; }

      // memos
      if (memoRes.error) throw memoRes.error;
      const remoteMemos = (memoRes.data || []).map(rowToMemo);
      const pendingMemos = [...pending.values()].filter((p) => p.table === 'office_memos');
      const memoMap = new Map(remoteMemos.map((m) => [m.id, m]));
      state.memos.filter((m) => pendingMemos.some((p) => p.id === m.id && p.type === 'upsert')).forEach((m) => memoMap.set(m.id, m));
      pendingMemos.filter((p) => p.type === 'delete').forEach((p) => memoMap.delete(p.id));
      const mergedMemos = [...memoMap.values()];
      if (sigOf(mergedMemos, ['id', 'pinned', 'updatedAt']) !== sigOf(state.memos, ['id', 'pinned', 'updatedAt'])) { state.memos = mergedMemos; dirty = true; }

      // members
      if (!memRes.error) {
        const remoteMembers = (memRes.data || []).map(rowToMember);
        if (remoteMembers.length) {
          const pendingMembers = [...pending.values()].filter((p) => p.table === 'office_members');
          const mm = new Map(remoteMembers.map((m) => [m.id, m]));
          state.members.filter((m) => pendingMembers.some((p) => p.id === m.id)).forEach((m) => mm.set(m.id, m));
          const mergedMembers = [...mm.values()].sort((a, b) => a.sort - b.sort);
          if (sigOf(mergedMembers, ['id', 'name', 'role', 'status', 'provider']) !== sigOf(state.members, ['id', 'name', 'role', 'status', 'provider'])) {
            state.members = mergedMembers; dirty = true;
          }
        } else {
          state.members.forEach((m) => queueUpsert('office_members', memberToRow(m), m.id));
        }
      }

      sync.lastSyncAt = Date.now();
      if (dirty) { persist(); emit('sync-data'); }
      else emit('sync-tick');
    } catch (e) {
      sync.detail = e && e.message ? e.message : String(e);
      emit('sync-tick');
    } finally { pulling = false; }
  }

  function schedulePull() {
    clearTimeout(pullTimer);
    pullTimer = setTimeout(pull, 350);
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(() => {
      if (document.hidden) return;
      pull();
      flushQueue();
    }, CFG.POLL_MS);
  }
  function stopPoll() { clearInterval(pollTimer); pollTimer = null; }

  function subscribeRealtime() {
    if (!client) return;
    try {
      if (rtChannel) client.removeChannel(rtChannel);
      sync.realtime = 'subscribing';
      const tables = ['office_messages', 'office_tasks', 'office_memos', 'office_members'];
      let ch = client.channel('office-room-' + room());
      tables.forEach((table) => {
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: 'room=eq.' + room() }, schedulePull);
      });
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') { sync.realtime = 'on'; emit('sync-tick'); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { sync.realtime = 'off'; emit('sync-tick'); }
      });
      rtChannel = ch;
    } catch (e) {
      sync.realtime = 'off';
    }
  }

  async function detect() {
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
      sync.mode = 'local'; sync.status = 'local'; sync.detail = 'config.js 에 서버 주소가 없습니다.'; emit('sync'); return;
    }
    sync.status = 'connecting'; emit('sync');
    if (!client) {
      if (!window.supabase || !window.supabase.createClient) {
        sync.mode = 'local'; sync.status = 'local'; sync.detail = 'Supabase 라이브러리를 불러오지 못했습니다.'; emit('sync'); return;
      }
      client = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 8 } },
      });
    }
    try {
      const status = await probeTables();
      if (status !== 200) {
        // 표가 아직 없음(404) · 권한 없음(401) 등 → 로컬 모드로 조용히 전환
        sync.mode = 'local';
        sync.status = 'local';
        sync.detail = status === 404
          ? 'office_* 표가 아직 없습니다. 설정 → 동기화에서 SQL을 한 번 실행하면 실시간으로 바뀝니다.'
          : status === 0
            ? '동기화 서버에 연결하지 못했습니다. 오프라인이거나 주소를 확인해 주세요.'
            : `동기화 서버가 응답했습니다(HTTP ${status}). SQL과 권한을 확인해 주세요.`;
        emit('sync');
        return;
      }
      sync.mode = 'live';
      sync.status = 'live';
      sync.detail = '';
      emit('sync');
      await pull();
      subscribeRealtime();
      startPoll();
    } catch (e) {
      sync.mode = 'local';
      sync.status = 'local';
      sync.detail = (e && e.message) || '연결 확인 실패';
      emit('sync');
    }
  }

  /* 표 존재 확인 — 콘솔에 404 를 남기지 않도록 서비스 워커에서 먼저 확인합니다. */
  async function probeTables() {
    const url = `${CFG.SUPABASE_URL}/rest/v1/office_messages?select=id&room=eq.${encodeURIComponent(room())}&limit=1`;
    const key = CFG.SUPABASE_ANON_KEY;
    let worker = null;
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('./sw.js', { scope: './' });
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((r) => setTimeout(() => r(null), 5000)),
        ]);
        worker = reg && reg.active ? reg.active : null;
      } catch (e) { worker = null; }
    }
    if (worker) {
      const reply = await new Promise((resolve) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 6000);
        ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
        try { worker.postMessage({ type: 'office-probe', url, key }, [ch.port2]); }
        catch (e) { clearTimeout(timer); resolve(null); }
      });
      if (reply && typeof reply.status === 'number') return reply.status;
    }
    try {
      const res = await fetch(url, { headers: { apikey: key, authorization: `Bearer ${key}` }, cache: 'no-store' });
      return res.status;
    } catch (e) { return 0; }
  }

  async function reconnect() {
    stopPoll();
    if (rtChannel && client) { try { client.removeChannel(rtChannel); } catch (e) {} rtChannel = null; }
    await detect();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sync.mode === 'live') { pull(); flushQueue(); }
  });
  window.addEventListener('online', () => { if (sync.mode === 'live') { pull(); flushQueue(); } });

  /* ── 쓰기 API ───────────────────────────────────────────── */
  function addMessage(msg) {
    const full = {
      id: msg.id || uid(),
      channel: msg.channel,
      authorId: msg.authorId || '',
      authorName: msg.authorName || '비서',
      authorKind: msg.authorKind || 'ai',
      body: String(msg.body || '').slice(0, 4000),
      kind: msg.kind || 'chat',
      meta: msg.meta || {},
      createdAt: msg.createdAt || nowISO(),
    };
    state.messages.push(full);
    if (state.messages.length > CFG.MAX_MESSAGES * 1.5) state.messages = state.messages.slice(-CFG.MAX_MESSAGES);
    persist();
    if (sync.mode === 'live') queueUpsert('office_messages', messageToRow(full), full.id);
    emit('messages');
    return full;
  }

  function addTask({ title, assignee, note }) {
    const t = {
      id: uid(), title: String(title || '').trim().slice(0, 300), assignee: assignee || '',
      status: 'todo', note: note || '', createdAt: nowISO(), updatedAt: nowISO(),
    };
    if (!t.title) return null;
    state.tasks.unshift(t);
    persist();
    if (sync.mode === 'live') queueUpsert('office_tasks', taskToRow(t), t.id);
    emit('tasks');
    return t;
  }

  function updateTask(id, patch, opts) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch, { updatedAt: nowISO() });
    persist();
    if (sync.mode === 'live') queueUpsert('office_tasks', taskToRow(t), t.id);
    if (!opts || !opts.silent) emit('tasks');
  }

  function deleteTask(id) {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    persist();
    if (sync.mode === 'live') queueDelete('office_tasks', id);
    emit('tasks');
  }

  function addMemo({ id, title, body, pinned }) {
    const m = {
      id: id || uid(), title: String(title || '').trim().slice(0, 120),
      body: String(body || '').slice(0, 4000), pinned: !!pinned,
      createdAt: nowISO(), updatedAt: nowISO(),
    };
    if (!m.body.trim() && !m.title.trim()) return null;
    state.memos.unshift(m);
    persist();
    if (sync.mode === 'live') queueUpsert('office_memos', memoToRow(m), m.id);
    emit('memos');
    return m;
  }

  function updateMemo(id, patch) {
    const m = state.memos.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, patch, { updatedAt: nowISO() });
    persist();
    if (sync.mode === 'live') queueUpsert('office_memos', memoToRow(m), m.id);
    emit('memos');
  }

  function deleteMemo(id) {
    state.memos = state.memos.filter((m) => m.id !== id);
    persist();
    if (sync.mode === 'live') queueDelete('office_memos', id);
    emit('memos');
  }

  function updateMember(id, patch) {
    const m = state.members.find((x) => x.id === id);
    if (!m) return;
    Object.assign(m, patch);
    persist();
    if (sync.mode === 'live') queueUpsert('office_members', memberToRow(m), m.id);
    emit('members');
  }

  function addMember(data) {
    const list = state.members.filter((m) => m.kind !== 'leader');
    const m = normalizeMember({
      id: uid(), emoji: data.emoji || '🙂', name: data.name || '새 비서', role: data.role || '비서',
      model: data.model || '', status: '대기', provider: data.provider || 'none', kind: data.kind || 'ai',
      channels: data.channels || [], sort: Math.max(0, ...list.map((x) => x.sort)) + 1,
    });
    state.members.push(m);
    state.members.sort((a, b) => a.sort - b.sort);
    persist();
    if (sync.mode === 'live') queueUpsert('office_members', memberToRow(m), m.id);
    emit('members');
    return m;
  }

  function deleteMember(id) {
    const m = state.members.find((x) => x.id === id);
    if (!m || m.kind === 'leader') return;
    state.members = state.members.filter((x) => x.id !== id);
    persist();
    if (sync.mode === 'live') queueDelete('office_members', id);
    emit('members');
  }

  function addChannel({ emoji, name, desc }) {
    const clean = String(name || '').trim().replace(/^#/, '').slice(0, 24);
    if (!clean) return null;
    const id = 'ch-' + clean.replace(/[^0-9a-zA-Z가-힣]/g, '').slice(0, 12) || uid();
    if (state.channels.some((c) => c.name === clean)) return null;
    const ch = { id, emoji: emoji || '💬', name: clean, desc: desc || '' };
    state.channels.push(ch);
    persist();
    emit('channels');
    return ch;
  }

  function saveSettings(patch) {
    Object.assign(settings, patch);
    writeJSON(K_SET, settings);
    emit('settings');
  }

  function resetLocal() {
    localStorage.removeItem(K_DATA);
    localStorage.removeItem(K_SET);
  }

  load();

  window.OfficeStore = {
    state, settings, sync,
    subscribe, emit,
    addMessage, addTask, updateTask, deleteTask,
    addMemo, updateMemo, deleteMemo,
    addMember, updateMember, deleteMember,
    addChannel, saveSettings, resetLocal,
    detect, reconnect, pull, room,
    flushPersist,
    uid,
    messagesFor(channelId) { return state.messages.filter((m) => m.channel === channelId); },
    memberById(id) { return state.members.find((m) => m.id === id); },
    memberByName(name) {
      const n = String(name || '').replace(/^@/, '').replace(/\s*(비서|님)$/, '');
      return state.members.find((m) => m.name === name || m.name === n || m.name.replace(/\s*(비서|님)$/, '') === n);
    },
    isLive() { return sync.mode === 'live'; },
  };
})();

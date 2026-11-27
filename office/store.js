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

  /* v1.1 — 기본 데이터 버전과 옛 멤버 id 이전 */
  const SEED_VERSION = '1.1';
  const LEGACY_MEMBER_IDS = { subpickle: 'sub1' };
  /* v7 — 서브1 표시 이름·역할 변경. 예전 기본값('서브1')으로 저장된 값만
     새 값으로 옮기고, 사용자가 직접 바꾼 다른 이름·역할은 그대로 둡니다. */
  const LEGACY_MEMBER_FIELDS = {
    sub1: {
      nameFrom: '서브1', nameTo: '달콩이sub1',
      roleFrom: '서브피클 1호 · 이동·현장', roleTo: '서브피클 1호(@leesuho13) · 이동·현장',
    },
  };
  const renamedRemote = new Set();   // 서버 행 이전은 세션당 한 번만 시도

  /* 옛 기본값을 새 기본값으로 바꿉니다. 바뀐 게 있으면 true. */
  function migrateMemberFields(m) {
    const mig = m && LEGACY_MEMBER_FIELDS[m.id];
    if (!mig) return false;
    let changed = false;
    if (m.name === mig.nameFrom) { m.name = mig.nameTo; changed = true; }
    if (m.role === mig.roleFrom) { m.role = mig.roleTo; changed = true; }
    return changed;
  }

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
    seedVersion: '',
  };

  /* ── 구독 ───────────────────────────────────────────────── */
  const listeners = new Set();
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(reason) { listeners.forEach((fn) => { try { fn(reason); } catch (e) { console.warn(e); } }); }

  /* ── 인수인계 기본 카드 (v1.1) ────────────────────────────
     진행 중 프로젝트 4종. id 를 고정해 두어 여러 번 실행해도
     같은 카드가 두 장 생기지 않고, 앱을 새로 깔지 않은 기존
     데이터에도 한 번만 합쳐집니다. */
  const SEED_TASKS = [
    {
      id: 'seed-v11-edito',
      title: '에디토(Edito) v1.0 — 카드뉴스 웹앱 운영·개선',
      assignee: 'boknim', status: 'done',
      note: '원고 → 카드 분할 → 6종 템플릿 → PNG/ZIP 내보내기까지 동작. 실제 1편 검수만 남음.',
      handoff: {
        project: '에디토(Edito) v1.0',
        repo: 'newsyntaxerror/test',
        branch: 'gh-pages',
        path: 'edito/',
        live: 'https://newsyntaxerror.github.io/test/edito/',
        extra: '',
        done: '· 원고를 붙여넣으면 카드(장) 단위로 자동 분할\n' +
              '· 매거진 템플릿 6종 — 에디토리얼 · 다크 · 크림 페이퍼 · 오렌지 포인트 · 뉴스 브리핑 · 사진 무드\n' +
              '· 표지 카드, 9:16 타이포 스케일, 세로 균형 조정\n' +
              '· PNG 낱장 저장 + ZIP 묶음 내보내기\n' +
              '· 카드 시트 상단 실시간 미니 프리뷰, 사용법 시트, 저장 실패 안내\n' +
              '· 해시태그·표지 제목 정리',
        next: '1. 실제 원고 1편으로 폰에서 끝까지 제작 → PNG/ZIP 내보내기 검수\n' +
              '2. 인스타 업로드용 해시태그 세트 저장 기능이 필요한지 결정\n' +
              '3. 계절·이벤트용 템플릿 변형을 추가할지 결정',
        notes: '· newsyntaxerror/test 의 edito/ 폴더만 고칩니다. office/ · daily-trend-viewer/ · 루트(our-map 테스트)는 건드리지 않습니다.\n' +
               '· 고친 뒤 index.html 과 sw.js 의 ?v= 값을 함께 올려 캐시를 갱신합니다.\n' +
               '· 공개 저장소입니다. 개인 사진·실명·연락처를 코드나 예시 데이터에 넣지 않습니다.',
        log: [],
      },
    },
    {
      id: 'seed-v11-ourmap',
      title: '우리끼리(our-map) v23 반영 검토',
      assignee: 'boknim', status: 'doing',
      note: '테스트 서버 v23 벡터 지도 검수 → 라이브(v21) 반영 여부 결정 대기.',
      handoff: {
        project: '우리끼리(our-map) v23 반영 검토',
        repo: 'newsyntaxerror/test · newsyntaxerror/our-map',
        branch: 'main / gh-pages',
        path: 'test 저장소 루트(테스트) · our-map 저장소 루트(라이브)',
        live: 'https://newsyntaxerror.github.io/our-map/',
        extra: '테스트: https://newsyntaxerror.github.io/test/ · Supabase 프로젝트 qqaogodxzfiuxhkkfjwt · 상세 HANDOFF.md 는 our-map 저장소 main',
        done: '· 테스트 서버 v23: MapLibre GL 4.7.1 + OpenFreeMap 벡터 지도 4종(파스텔 Liberty · 미니멀 Positron · 밝게 Bright · 다크 fiord) 적용 — 확대 해상도 문제 해결\n' +
              '· WebGL 실패 시 OSM 자동 폴백\n' +
              '· 라이브는 v21로 정상 운영 중(실사용자 데이터 있음)',
        next: '1. 테스트 서버 v23를 폰(사파리·크롬)에서 검수 — 지도 확대, 동선, 채팅, 알림\n' +
              '2. 문제 없으면 라이브(our-map) 반영 여부를 대장님께 확인\n' +
              '3. 반영 시 실사용자 데이터(친구·위치·채팅) 보존을 확인하고 배포',
        notes: '· 라이브에는 실제 사용자 데이터가 있습니다. 검증용 테스트 데이터는 확인 뒤 반드시 삭제합니다.\n' +
               '· DB 조회·수정은 SECURITY DEFINER RPC로만 합니다. 표를 직접 만지지 않습니다.\n' +
               '· 공개 저장소입니다. 개인정보·거주 구·비밀키를 코드에 넣지 않습니다.\n' +
               '· 수정할 때마다 버전을 적어 보고합니다(v21 → v22 …).',
        log: [],
      },
    },
    {
      id: 'seed-v11-daini',
      title: '다인이네 숏츠 Ver.1 제작',
      assignee: 'sub2', status: 'doing',
      note: '규격 확정 · 기준본 있음. 새 영상 1편 검수 남음.',
      handoff: {
        project: '다인이네 숏츠 Ver.1',
        repo: '— (영상 작업 · 저장소 없음)',
        branch: '—',
        path: '작업 파일 downloads/ · 기준본은 슬랙 #다인이네',
        live: '슬랙 오브누아 #다인이네 (C0CLYT9KL5R)',
        extra: '기준본: downloads/daini_ppuae.mp4 (9.62초) · 테크노 리믹스: downloads/daini_ppuae_techno_20s.mp4 (20.57초)',
        done: '· Ver.1 포맷 확정 — 1080×1920 순수 검정 배경, 중앙 영상 940×1000\n' +
              '· 상단 제목: Pretendard ExtraBold, 흰색 + 형광핑크 #FF2A85\n' +
              '· 하단: 엄지척 치즈냥이 + 「다인이네」\n' +
              '· 기준본(다인 뿌애 9.62초)과 140BPM 테크노 리믹스 20.57초본 전달',
        next: '1. 새 영상 1편을 Ver.1 포맷으로 제작해 검수받기\n' +
              '2. 이번 주 3편 업로드 계획(제목·썸네일 문구 포함) 세우기\n' +
              '3. 테크노 리믹스 반응을 확인한 뒤 다음 곡 진행 여부 결정',
        notes: '· 규격은 임의로 바꾸지 않습니다(비율·색·폰트·하단 캐릭터).\n' +
               '· 아이 영상·이름은 이 채널 밖으로 공유하지 않습니다.\n' +
               '· 원본 영상은 downloads/ 에 그대로 두고 덮어쓰지 않습니다.',
        log: [],
      },
    },
    {
      id: 'seed-v11-trend',
      title: '데일리 트렌드 뷰어 — 자동 갱신 붙이기',
      assignee: 'sub3', status: 'doing',
      note: '웹 커스텀 버전 배포 완료. 지금은 11/25 01:13 수집본 고정.',
      handoff: {
        project: '데일리 트렌드 뷰어',
        repo: 'newsyntaxerror/test',
        branch: 'gh-pages',
        path: 'daily-trend-viewer/ (소스는 daily-trend-viewer 브랜치)',
        live: 'https://newsyntaxerror.github.io/test/daily-trend-viewer/',
        extra: '원본: lmorejh/daily-trend-viewer (MIT)',
        done: '· ⚙️ 내 분야 시트 — 분야 켜기/끄기, 순서 변경, 새 분야+키워드 추가\n' +
              '· 「★ 내 키워드만」 필터, 검색, JSON/텍스트 내보내기, localStorage 저장\n' +
              '· 기본 칩: 전체 · 육아 · 살림 · 쿠파스 · 쇼핑템 · 예짜 · 밈 · AI\n' +
              '· 2026-11-25 01:13 수집본 탑재(유튜브·쇼츠 84조합, 스레드 11건, 틱톡 7건, AI 뉴스 40건 등)',
        next: '1. 자동 재수집(매일 1회)을 붙일 방법 결정 — GitHub Actions 또는 Pickle 정기 실행\n' +
              '2. 릴스 탭이 2026-09-15 데이터에 멈춰 있는 문제 확인\n' +
              '3. 정식 저장소(newsyntaxerror/daily-trend-viewer)로 옮길지 결정',
        notes: '· newsyntaxerror/test 의 daily-trend-viewer/ 폴더만 고칩니다. office/ · edito/ · 루트는 건드리지 않습니다.\n' +
               '· 공개된 게시물만 수집합니다. 비공개 계정·개인정보를 저장하지 않습니다.\n' +
               '· 원본 MIT 라이선스 — 출처 표기를 유지합니다.',
        log: [],
      },
    },
  ];

  const SEED_MEMOS = [
    {
      id: 'seed-v11-memo-handoff',
      title: '🤝 바통터치 사용법 (v1.1)',
      body: '작업실 카드마다 인수인계 상세가 붙어 있습니다.\n' +
            '· 카드의 「🤝 인수인계 상세」를 펼치면 저장소·브랜치·라이브 URL, 한 일, 이어서 할 일, 주의사항이 보입니다.\n' +
            '· 🤝 넘기기 → 받을 비서(서브1·2·3, GPT, 클로드, 제미나이, 복님이)를 고르고 한 줄 코멘트를 남기면 담당자가 바뀌고 회의실 #종합에 「📌 [바통터치]」 기록이 올라갑니다.\n' +
            '· 📋 바통터치 복사 → 다른 피클이나 AI 채팅창에 그대로 붙여넣으면 바로 이어받을 수 있는 완성된 프롬프트가 복사됩니다.\n' +
            '· 상세 내용은 ✏️ 로 직접 고칠 수 있습니다. 빈 칸이 있어도 복사는 됩니다(있는 내용만 정리).',
      pinned: true,
    },
    {
      id: 'seed-v11-memo-projects',
      title: '진행 중 프로젝트 4종 (v1.1 기준)',
      body: '1. 에디토(Edito) v1.0 — newsyntaxerror/test · gh-pages · /edito/ · 완료, 실제 1편 검수만 남음\n' +
            '2. 우리끼리(our-map) v23 — 테스트 서버 검수 뒤 라이브(v21) 반영 여부 결정 대기\n' +
            '3. 다인이네 숏츠 Ver.1 — 규격 확정, 새 영상 1편 제작·검수 대기\n' +
            '4. 데일리 트렌드 뷰어 — 웹 커스텀 배포 완료, 자동 재수집이 남음',
      pinned: false,
    },
  ];

  function normalizeHandoff(h) {
    const src = h && typeof h === 'object' ? h : {};
    const str = (v) => (typeof v === 'string' ? v : '');
    return {
      project: str(src.project), repo: str(src.repo), branch: str(src.branch), path: str(src.path),
      live: str(src.live), extra: str(src.extra),
      done: str(src.done), next: str(src.next), notes: str(src.notes),
      log: Array.isArray(src.log) ? src.log.slice(-20) : [],
    };
  }
  function normalizeTask(t) {
    return {
      id: t.id, title: t.title || '', assignee: LEGACY_MEMBER_IDS[t.assignee] || t.assignee || '',
      status: ['todo', 'doing', 'done'].includes(t.status) ? t.status : 'todo',
      note: t.note || '', handoff: normalizeHandoff(t.handoff),
      createdAt: t.createdAt || nowISO(), updatedAt: t.updatedAt || t.createdAt || nowISO(),
    };
  }
  function cloneTask(t) {
    return normalizeTask({
      ...t, handoff: { ...normalizeHandoff(t.handoff), log: [] },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
  function cloneMemo(m) {
    const at = new Date().toISOString();
    return { id: m.id, title: m.title || '', body: m.body || '', pinned: !!m.pinned, createdAt: at, updatedAt: at };
  }

  /* ── 최초 데이터 ────────────────────────────────────────── */
  function seed() {
    state.channels = CFG.CHANNELS.map((c) => ({ ...c }));
    state.members = CFG.MEMBERS.map((m) => ({ ...m, channels: [...m.channels] }));
    const t = Date.now();
    // v8 — 첫 안내 메시지는 고정 id 를 써서 기기끼리 같은 대화로 합쳐지게 합니다.
    state.messages = [Object.assign(bootstrapMessage(), { createdAt: new Date(t - 60 * 1000).toISOString() })];
    state.tasks = [
      ...SEED_TASKS.map(cloneTask),
      { id: uid(), title: '서브폰 Pickle 3대를 서브1·2·3에 연결하기', assignee: 'sub1', status: 'todo', note: '서브폰 Pickle 앱 → 복님이와 친구 → 각 폰의 핸들을 비서현황에서 이름에 맞춰 정리', handoff: normalizeHandoff({}), createdAt: new Date(t - 30 * 60e3).toISOString(), updatedAt: new Date(t - 30 * 60e3).toISOString() },
      { id: uid(), title: '이 비서실 슬랙 #회의실에 프로젝트로 등록', assignee: 'boknim', status: 'done', note: 'C0CKSPC209M', handoff: normalizeHandoff({}), createdAt: new Date(t - 5 * 3600e3).toISOString(), updatedAt: new Date(t - 2 * 3600e3).toISOString() },
    ];
    state.memos = [
      ...SEED_MEMOS.map(cloneMemo),
      { id: uid(), title: '비서실 사용법', body: '· @전체 → 모든 비서가 차례로 답합니다.\n· 💬 토론(2바퀴) → 연결된 AI끼리 서로 의견을 주고받습니다.\n· 작업실에서 지시를 카드로 만들고 대기 → 진행 → 완료로 넘기세요.\n· 메모는 상단 고정해 두면 늘 맨 위에 있습니다.', pinned: true, createdAt: new Date(t - 90 * 60e3).toISOString(), updatedAt: new Date(t - 90 * 60e3).toISOString() },
    ];
    state.seedVersion = SEED_VERSION;
  }

  /* 기존 데이터에 v1.1 기본 카드·메모를 한 번만 합칩니다. */
  function mergeSeed() {
    let added = 0;
    SEED_TASKS.forEach((st) => {
      if (!state.tasks.some((t) => t.id === st.id)) { state.tasks.push(cloneTask(st)); added += 1; }
    });
    SEED_MEMOS.forEach((sm) => {
      if (!state.memos.some((m) => m.id === sm.id)) { state.memos.push(cloneMemo(sm)); added += 1; }
    });
    state.seedVersion = SEED_VERSION;
    return added;
  }

  /* ── v8 — 완전히 빈 서버에 처음 연결할 때의 초기화 ───────────
     Supabase office_* 표를 새로 만들어 처음 연결하면 서버가 0건이라
     pull() 이 빈 배열로 로컬을 덮어써 '작업실 0 · 빈 회의실'이 되었습니다.
     이 방의 카드·메모·대화가 모두 0건인 '완전 빈 서버'일 때는 빈 배열로
     덮어쓰지 않고, 지금 이 기기의 데이터(기기 데이터도 비었으면 기본 시드)
     를 서버에 한 번 올려 초기 상태를 만듭니다.

     · 한 번 올라간 뒤에는 대화(안내 메시지)가 서버에 남으므로 다시 시드하지
       않습니다. 사용자가 카드·메모를 모두 지운 상태와 구분됩니다.
     · 올리는 순서는 카드 → 메모 → 멤버 → 대화입니다. 대화가 마지막에 올라가야
       중간에 실패해도 '대화 0건'이 유지되어 다음 동기화에서 다시 시도합니다.
     · 여러 기기가 동시에 처음 열려도 시드 카드·메모는 id 가 고정이라 같은 행을
       덮어쓸 뿐 중복으로 생기지 않습니다. */
  const BOOTSTRAP_MESSAGE_ID = 'seed-v8-welcome';
  let bootstrapping = false;
  let bootstrapDone = false;

  function bootstrapMessage() {
    return {
      id: BOOTSTRAP_MESSAGE_ID,
      channel: 'general',
      authorId: 'boknim',
      authorName: '복님이',
      authorKind: 'pickle',
      body: '대장님, 「달콩 비서실」을 Supabase 실시간 서버에 연결했습니다 🥒\n' +
            '작업실 카드와 메모를 서버에 한 번 올려 두었습니다. 이제 폰·PC 어느 기기에서 열어도 같은 비서실이 보입니다.\n\n' +
            '· 작업실 — 진행 중 프로젝트 4종(에디토 · 우리끼리 v23 · 다인이네 숏츠 · 데일리 트렌드 뷰어) 인수인계 카드\n' +
            '· 메모 — 🤝 바통터치 사용법, 진행 중 프로젝트 4종 목록\n' +
            '· 카드의 「🤝 인수인계 상세」를 펼치면 저장소·라이브 URL, 한 일, 이어서 할 일이 보입니다.\n' +
            '· 한 번 올린 데이터는 스스로 다시 채우지 않습니다. 카드·메모를 지우면 서버에서도 함께 사라집니다.\n' +
            '· 부르고 싶은 비서는 아래 칩으로 @멘션하거나 그냥 이름을 불러 주세요.',
      kind: 'chat',
      meta: { v: '8' },
      createdAt: nowISO(),
    };
  }

  /* 시드로 올릴 내용을 준비합니다. 기기 데이터가 통째로 비어 있으면 기본 시드로 되살립니다. */
  function ensureBootstrapContent() {
    let changed = false;
    if (!state.tasks.length && !state.memos.length && !state.messages.length) {
      mergeSeed();          // 기본 인수인계 카드 4종 + 메모 2장 (id 고정)
      changed = true;
    }
    if (!state.messages.length) { state.messages.push(bootstrapMessage()); changed = true; }
    if (changed) persist();
  }

  async function pushRows(table, rows) {
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 100) {
      const res = await client.from(table).upsert(rows.slice(i, i + 100), { onConflict: 'id' });
      if (res && res.error) throw res.error;
    }
  }

  async function pushAll() {
    if (bootstrapDone || bootstrapping || sync.mode !== 'live' || !client) return false;
    bootstrapping = true;
    try {
      ensureBootstrapContent();
      // 카드 → 메모 → 멤버 → 대화. 대화를 마지막에 올려 도중 실패 시 다시 시도할 수 있게 합니다.
      await pushRows('office_tasks', state.tasks.map(taskToRow));
      await pushRows('office_memos', state.memos.map(memoToRow));
      await pushRows('office_members', state.members.map(memberToRow));
      await pushRows('office_messages', state.messages.map(messageToRow));
      bootstrapDone = true;
      sync.seededAt = Date.now();
      console.info('[office] 빈 서버에 초기 데이터를 올렸습니다 — 카드 ' + state.tasks.length +
        '장 · 메모 ' + state.memos.length + '장 · 대화 ' + state.messages.length + '건');
      return true;
    } catch (e) {
      // 실패하면 대기열에 넣어 다음 폴링에서 이어서 올립니다.
      state.tasks.forEach((t) => queueUpsert('office_tasks', taskToRow(t), t.id));
      state.memos.forEach((m) => queueUpsert('office_memos', memoToRow(m), m.id));
      state.messages.forEach((m) => queueUpsert('office_messages', messageToRow(m), m.id));
      console.warn('[office] 초기 데이터 업로드 실패 — 다시 시도합니다', (e && (e.message || e.details)) || e);
      return false;
    } finally { bootstrapping = false; }
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
    state.tasks = (Array.isArray(data.tasks) ? data.tasks : []).map(normalizeTask);
    state.memos = Array.isArray(data.memos) ? data.memos : [];
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    state.seedVersion = data.seedVersion || '';

    // 기본 멤버는 항상 보장하고, 사용자가 고친 값은 그대로 둡니다.
    const saved = new Map((Array.isArray(data.members) ? data.members : []).map((m) => [m.id, normalizeMember(m)]));
    // v1.0 의 단일 '서브피클' → 서브1 (이름을 직접 바꿨다면 그 이름은 유지)
    if (saved.has('subpickle')) {
      const legacy = saved.get('subpickle');
      saved.delete('subpickle');
      if (!saved.has('sub1')) {
        const keepName = legacy.name && legacy.name !== '서브피클';
        saved.set('sub1', normalizeMember({
          ...legacy, id: 'sub1',
          name: keepName ? legacy.name : '달콩이sub1',
          emoji: legacy.emoji && legacy.emoji !== '🌿' ? legacy.emoji : '🌱',
          role: legacy.role && legacy.role !== '서브폰 비서 · Pickle' ? legacy.role : '서브피클 1호 · 이동·현장',
          sort: 2,
        }));
      }
    }
    // v7 — 이 기기에 옛 기본값으로 저장된 서브1 이름·역할을 새 값으로 한 번만 옮깁니다.
    let nameMigrated = false;
    saved.forEach((m) => { if (migrateMemberFields(m)) nameMigrated = true; });
    CFG.MEMBERS.forEach((m) => { if (!saved.has(m.id)) saved.set(m.id, normalizeMember(m)); });
    // 기본 멤버의 줄 순서는 config 를 따릅니다(서브1·2·3 이 나란히 오도록).
    CFG.MEMBERS.forEach((m) => { const cur = saved.get(m.id); if (cur) cur.sort = m.sort; });
    state.members = [...saved.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'ko'));
    if (nameMigrated) persist();

    // v1.1 기본 카드·메모를 한 번만 합칩니다.
    if (data.seedVersion !== SEED_VERSION) {
      const added = mergeSeed();
      if (added) {
        state.messages.push({
          id: uid(),
          channel: 'general',
          authorId: 'system',
          authorName: '비서실',
          authorKind: 'system',
          body: '📣 비서실 v1.1 업데이트 — 서브피클이 🌱 서브1 · 🌿 서브2 · 🍀 서브3 로 나뉘었습니다.\n' +
                '· 작업실 카드마다 🤝 인수인계 상세(저장소·라이브 URL, 한 일, 이어서 할 일, 주의사항)가 붙었습니다.\n' +
                '· 🤝 넘기기로 담당을 넘기면 회의실 #종합에 기록이 올라가고, 📋 바통터치 복사로 다른 AI에 바로 붙여넣을 인수인계문을 복사합니다.\n' +
                '· 진행 중 프로젝트 4종(에디토 · 우리끼리 v23 · 다인이네 숏츠 · 데일리 트렌드 뷰어) 인수인계 카드를 작업실에 넣어 두었습니다.',
          kind: 'system',
          meta: { v: '1.1' },
          createdAt: nowISO(),
        });
      }
      if (added) persist();
    }
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
        seedVersion: state.seedVersion || SEED_VERSION,
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
      seedVersion: state.seedVersion || SEED_VERSION,
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
    noHandoff: false,       // 서버 office_tasks 에 handoff 컬럼이 없을 때
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
    return normalizeTask({
      id: r.id, title: r.title, assignee: r.assignee || '', status: r.status || 'todo',
      note: r.note || '', handoff: r.handoff || {},
      createdAt: r.created_at, updatedAt: r.updated_at,
    });
  }
  function taskToRow(t) {
    const row = { id: t.id, room: room(), title: t.title, assignee: t.assignee || '', status: t.status, note: t.note || '', created_at: t.createdAt, updated_at: t.updatedAt };
    // 서버 표에 handoff 컬럼이 아직 없으면(SQL 미실행) 이 키만 빼고 보냅니다.
    if (!sync.noHandoff) row.handoff = t.handoff || {};
    return row;
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
  let retrySoon = false;
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
          const msg = (e && (e.message || e.details || e.hint)) || '';
          // handoff 컬럼이 없는 예전 표면 그 칸만 빼고 다시 보낸다.
          if (op.table === 'office_tasks' && /handoff/i.test(String(msg)) && !sync.noHandoff) {
            sync.noHandoff = true;
            const { handoff, ...rest } = op.row;
            pending.set(id, { ...op, row: rest });
            retrySoon = true;
            continue;
          }
          // 다음 폴링에서 다시 시도합니다. (오프라인·일시 오류)
          console.warn('[office] 전송 대기', op.table, msg || e);
        }
      }
    } finally { flushing = false; }
    if (retrySoon) { retrySoon = false; setTimeout(flushQueue, 0); }
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

      /* v8 — 이 방의 카드·메모·대화가 모두 0건인 완전 빈 서버면,
         빈 배열로 로컬을 덮어쓰지 않고 로컬(없으면 기본 시드)을 서버에 올립니다. */
      const remoteEmpty = !(msgRes.data || []).length
        && !(taskRes.error ? [] : (taskRes.data || [])).length
        && !(memoRes.error ? [] : (memoRes.data || [])).length;
      if (remoteEmpty && !bootstrapDone) {
        // 카드·메모 조회가 실패했다면 '빈 서버'로 단정하지 않고 다음 동기화로 미룹니다.
        if (taskRes.error) throw taskRes.error;
        if (memoRes.error) throw memoRes.error;
        const seeded = await pushAll();
        sync.lastSyncAt = Date.now();
        if (seeded) {
          emit('sync-seed');
          schedulePull();          // 올린 데이터를 서버에서 다시 읽어 화면과 맞춥니다.
          return;
        }
        emit('sync-tick');
        return;                    // 업로드 실패 시 로컬은 그대로 두고 다음 폴링에서 다시 시도
      }

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
        const remoteMembers = (memRes.data || [])
          .map(rowToMember)
          .map((m) => {
            // 서버에 옛 기본값이 남아 있으면 새 값으로 바꿔 한 번 올립니다.
            if (!renamedRemote.has(m.id) && LEGACY_MEMBER_FIELDS[m.id] && migrateMemberFields(m)) {
              renamedRemote.add(m.id);
              queueUpsert('office_members', memberToRow(m), m.id);
            }
            return m;
          })
          .filter((m) => {
            // v1.0 의 단일 '서브피클' 행은 지우고 서브1~3 으로 옮깁니다.
            if (LEGACY_MEMBER_IDS[m.id]) { queueDelete('office_members', m.id); return false; }
            return true;
          });
        if (remoteMembers.length) {
          const pendingMembers = [...pending.values()].filter((p) => p.table === 'office_members');
          const mm = new Map(remoteMembers.map((m) => [m.id, m]));
          state.members.filter((m) => pendingMembers.some((p) => p.id === m.id)).forEach((m) => mm.set(m.id, m));
          // 새 기본 멤버(서브1·2·3 등)가 서버에 없으면 여기서 추가합니다.
          CFG.MEMBERS.forEach((cm) => {
            if (mm.has(cm.id)) { mm.get(cm.id).sort = cm.sort; return; }
            const added = normalizeMember(cm);
            mm.set(cm.id, added);
            queueUpsert('office_members', memberToRow(added), added.id);
          });
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

  function addTask({ title, assignee, note, handoff }) {
    const t = normalizeTask({
      id: uid(), title: String(title || '').trim().slice(0, 300), assignee: assignee || '',
      status: 'todo', note: note || '', handoff: handoff || {},
      createdAt: nowISO(), updatedAt: nowISO(),
    });
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
    const clean = { ...patch };
    if ('handoff' in clean) clean.handoff = normalizeHandoff(clean.handoff);
    if ('assignee' in clean) clean.assignee = LEGACY_MEMBER_IDS[clean.assignee] || clean.assignee;
    Object.assign(t, clean, { updatedAt: nowISO() });
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
    normalizeHandoff,
    messagesFor(channelId) { return state.messages.filter((m) => m.channel === channelId); },
    memberById(id) { const real = LEGACY_MEMBER_IDS[id] || id; return state.members.find((m) => m.id === real); },
    memberByName(name) {
      const n = String(name || '').replace(/^@/, '').replace(/\s*(비서|님)$/, '');
      return state.members.find((m) => m.name === name || m.name === n || m.name.replace(/\s*(비서|님)$/, '') === n);
    },
    isLive() { return sync.mode === 'live'; },
  };
})();

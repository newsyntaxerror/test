/* ─────────────────────────────────────────────────────────────
   달콩 비서실 — 설정 파일
   ─────────────────────────────────────────────────────────────
   · SUPABASE_URL / SUPABASE_ANON_KEY 는 '우리끼리'와 같은 프로젝트입니다.
     (anon 공개 키입니다. 비밀 키가 아닙니다.)
   · 아래 office_* 표가 아직 없으면 앱은 자동으로 '로컬 모드'로 뜹니다.
     설정 → 동기화 → 'SQL 복사' 로 supabase_office.sql 을 한 번 실행하면
     새로고침 뒤 '실시간 동기화'로 바뀝니다.
   · AI API 키는 절대 여기에 넣지 마세요. 설정 화면에서 입력하면
     이 브라우저의 localStorage 에만 저장됩니다.
   ───────────────────────────────────────────────────────────── */

window.OFFICE_CONFIG = {
  SUPABASE_URL: "https://qqaogodxzfiuxhkkfjwt.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_6ZKzRAvNXXC0VJCrPkWhOg_a7e56eTx",

  ROOM: "dalkong",        // 비서실 방 코드 (기기끼리 같은 값을 써야 같은 방)
  POLL_MS: 5000,          // 실시간이 끊겨도 5초마다 백업 동기화
  MAX_MESSAGES: 400,      // 브라우저에 보관할 최근 대화 수

  MODELS: {
    openai: "gpt-4o-mini",
    anthropic: "claude-sonnet-4-5",
    gemini: "gemini-2.5-flash",
  },

  CHANNELS: [
    { id: "general",  emoji: "💬", name: "종합",        desc: "다섯 비서가 모두 모이는 기본 채널" },
    { id: "content",  emoji: "🎬", name: "콘텐츠·수익화", desc: "쇼츠 · 쓰레드 · 쿠파스" },
    { id: "dev",      emoji: "🛠", name: "웹앱·개발",    desc: "GitHub · Supabase · 배포" },
    { id: "life",     emoji: "🍼", name: "육아·생활",    desc: "다인이 · 집안일 · 생활정보" },
  ],

  MEMBERS: [
    { id: "dalkong",    emoji: "👑", name: "달콩",     role: "대장님",              model: "사람",              status: "지시 중",  provider: "none",      kind: "leader",  channels: ["general", "content", "dev", "life"], sort: 0 },
    { id: "boknim",     emoji: "🥒", name: "복님이",   role: "메인 비서 · Pickle",  model: "Pickle (메인)",      status: "온라인",   provider: "none",      kind: "pickle",  channels: ["general", "dev"], sort: 1 },
    { id: "subpickle",  emoji: "🌿", name: "서브피클", role: "서브폰 비서 · Pickle", model: "Pickle (서브폰)",   status: "대기",     provider: "none",      kind: "pickle",  channels: ["life"], sort: 2 },
    { id: "gpt",        emoji: "🧠", name: "GPT",      role: "아이디어 · 리서치",    model: "gpt-4o-mini",        status: "키 대기",  provider: "openai",    kind: "ai",      channels: ["general", "content"], sort: 3 },
    { id: "claude",     emoji: "🍊", name: "클로드",   role: "글쓰기 · 기획 검토",   model: "claude-sonnet-4-5",  status: "키 대기",  provider: "anthropic", kind: "ai",      channels: ["general", "content", "dev"], sort: 4 },
    { id: "gemini",     emoji: "✨", name: "제미나이", role: "요약 · 검색 정리",     model: "gemini-2.5-flash",   status: "키 대기",  provider: "gemini",    kind: "ai",      channels: ["general", "life"], sort: 5 },
  ],
};

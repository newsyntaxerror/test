/* ─────────────────────────────────────────────────────────────
   우리끼리 — 설정 파일
   ─────────────────────────────────────────────────────────────

   · 아래 두 값이 채워져 있으면 실제 서버(Supabase)와 연결됩니다.
   · 비워 두면 앱이 시작되지 않으니, 새 프로젝트를 쓸 때는
     Supabase 대시보드 → Project Settings → API 의 값으로 바꿔 주세요.
   · 표 구조는 supabase_schema.sql 을 SQL Editor 에 붙여넣고 RUN 하면
     만들어집니다(프로필 · 친구 관계 · 위치 · 이동 기록 · 1:1 메시지).
   · 지도는 OpenFreeMap 벡터 지도(무료·키 없음)를 씁니다. 따로 넣을 키가 없습니다.
   ───────────────────────────────────────────────────────────── */

window.APP_CONFIG = {
  SUPABASE_URL: "https://qqaogodxzfiuxhkkfjwt.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_6ZKzRAvNXXC0VJCrPkWhOg_a7e56eTx",

  REFRESH_SECONDS: 10,     // 자동 갱신 주기(초)
};

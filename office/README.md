# 달콩 비서실

달콩 님의 개인 AI 멀티 비서실. 회의실 · 작업실 · 비서현황 · 메모 네 화면으로 이루어진 정적 웹앱(PWA)입니다.

- 주소: https://newsyntaxerror.github.io/test/office/
- 폴더만 배포합니다. 저장소 루트(`our-map` v23 테스트) · `daily-trend-viewer/` · `edito/` 는 건드리지 않습니다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `index.html` | 껍데기 · 헤더 · 탭 · 스크립트 로드 |
| `styles.css` | 크림/브라운 테마, 다크 모드, 모바일·데스크톱 레이아웃 |
| `config.js` | Supabase 주소·방 코드·기본 채널·기본 멤버 |
| `store.js` | localStorage 저장, Supabase 실시간/폴링 동기화, 데이터 API |
| `ai.js` | GPT · 클로드 · 제미나이 호출, 시뮬레이션, 오류 문구 |
| `app.js` | 화면 렌더링, 이벤트, 설정·멤버·메모 시트, 토론 진행 |
| `sw.js` | 오프라인 캐시(앱 껍데기) + 표 존재 확인 프록시 |
| `supabase_office.sql` | Supabase에 한 번 실행하는 표·정책·Realtime 설정 |
| `vendor/supabase.js` | supabase-js v2 (UMD) |

## 동기화

앱은 시작할 때 `office_messages` 표가 있는지 확인합니다.
- 있으면: Realtime 구독 + 5초 폴링으로 기기끼리 같은 비서실
- 없으면: 이 브라우저(localStorage)만 사용하는 '로컬 모드'로 조용히 전환

표를 만들려면 Supabase → SQL Editor 에서 `supabase_office.sql` 을 한 번 실행하고 새로고침하세요.
기존 `our-map` 표는 건드리지 않으며, 여러 번 실행해도 안전합니다.

## AI 연결

설정(⚙️) → AI 연결에서 키를 넣으면 브라우저에서 각 AI로 직접 요청합니다.
키는 `localStorage` 에만 저장되고 코드·저장소에는 들어가지 않습니다.

- 제미나이(무료 등급), 클로드: 브라우저 직접 호출 확인됨
- GPT: 브라우저 직접 호출이 CORS로 막히는 경우가 있습니다. 설정 → AI 연결의 **OpenRouter로 설정**을 누르고 OpenRouter 키(`sk-or-…`)를 넣으면 프록시 서버 없이 동작합니다(직접 확인: 브라우저 호출 허용). 필요하면 '프록시 주소'에 내 프록시를 넣을 수도 있습니다.

## 고칠 때

`index.html` 의 `?v=` 값을 올리고, `sw.js` 의 `CACHE` 이름도 함께 올리면 캐시가 갱신됩니다.

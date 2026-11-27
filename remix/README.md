# 다인이 리믹스 스튜디오

아기(다인) 영상을 올리면 **목소리(옹알이) 구간을 자동으로 찾아** 비트에 맞춰 컷 편집·리믹스하는 모바일 퍼스트 웹앱(PWA)입니다.
서버 없이 브라우저 안에서만 동작하며(Web Audio / Canvas / MediaRecorder), 업로드한 영상은 어디에도 전송되지 않습니다.

- 주소: https://newsyntaxerror.github.io/test/remix/

## 기능

1. **영상 → 목소리 자동 추출**
   - MP4/MOV/WebM(또는 오디오) 업로드 → `decodeAudioData`로 디코딩
   - **아이폰 기본 동영상(.mov QuickTime, H.264/HEVC + AAC) 지원(v1.1)**: `decodeAudioData`가 실패하면 `js/analyze.js`의 순수 JS ISO BMFF 디먹서가 `moov→trak→mdia→hdlr('soun')→minf→stbl`(stsd/esds·stsc·stsz·stco/co64)을 해석해 오디오만 뽑아냅니다. AAC는 ADTS 헤더(또는 최소 MP4 재포장)로, `lpcm/sowt/twos`는 WAV로 디코딩하고, `File.slice()`로 샘플 구간만 읽어 100MB+ 영상도 가볍게 처리합니다.
   - 프리엠퍼시스 에너지 피크 감지로 최대 12개 구간 자동 슬라이스
   - 구간별 미리듣기 · 사용 on/off · 시작점 50ms 미세조정, 균등 분할 백업
2. **배경 비트 3가지 소스**
   - 내장 DSP 신스 4종(테크노 140 / 하우스 128 / 트랩 145 / Lo-fi 90) + BPM 90~160
   - 내 음원·화면녹화 영상 업로드(영상이면 오디오만 자동 추출) + **시작~끝 구간 선택** + BPM 추정/수동 + 박자 오프셋
   - 유튜브 링크(실험실): Cobalt 호환 API/프록시 시도, 차단 시 안내
3. **구성 · 길이**
   - 출력 길이 프리셋 10/15/20/30/45/60초 + 초·마디 직접 입력
   - 인트로 / 드롭 / 브레이크 / 아웃트로 구간별 마디·초 지정, 목소리·비트 on/off
4. **자동 비트싱크 영상 편집**
   - 목소리 피크를 소스로 비트 경계에서 자동 점프컷(컷 길이 1박~2마디)
   - 브레이크다운은 컷 없이 자연 재생
   - 줌 펀치(약/중/강) · 비트 플래시 · 비트 펄스, 3중 video 엘리먼트 프리시킹으로 끊김 없는 컷
5. **출력 포맷**
   - 기본 `Ver.1 다인이네`(1080×1920 검정, 중앙 940×1000, 상단 2줄 후킹+형광핑크 `#FF2A85`, 하단 치즈냥이+`다인이네`)
   - 풀스크린 9:16 / 화이트 미니멀 / 클럽 네온 EDM
   - 배경·강조색·로고(치즈냥이/검은 강아지/내 이미지)·배지 문구·글자 크기 조정 후 **내 포맷 저장**(localStorage)
6. **내보내기**
   - Canvas + `MediaRecorder` 실시간 렌더 → MP4(지원 시) / WebM
   - `OfflineAudioContext` 렌더 → 48kHz 16bit WAV (iOS 대비)
   - 썸네일 JPG

## 파일

- `index.html`, `css/app.css`
- `js/app.js` (UI·재생·내보내기), `js/draw.js` (Canvas 레이아웃), `js/dsp.js` (신스·WAV), `js/analyze.js` (구간 감지·BPM·MOV/MP4 오디오 디먹서), `js/arrange.js` (타임라인·컷), `js/formats.js` (포맷 프리셋), `js/yt.js`
- `assets/` 로고 2종 + Pretendard ExtraBold 서브셋, `manifest.json`, `sw.js`, `icons/`

## 참고

- 첫 방문 후 오프라인에서도 실행됩니다(SW 캐시). 새 버전 배포 시 `sw.js`의 `VERSION`을 올리세요.
- 미리보기는 실시간 재생, 내보내기도 실시간(길이만큼 소요)입니다.

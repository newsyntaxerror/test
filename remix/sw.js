/* 옹알이 리믹스 — 오프라인 앱 셸 */
const VERSION = 'remix-v1.7.0';
const ASSETS = [
  './',
  './index.html',
  './css/app.css?v=1.7.0',
  './js/app.js?v=1.7.0',
  './js/analyze.js?v=1.7.0',
  './js/draw.js?v=1.7.0',
  './js/encode.js?v=1.7.0',
  './js/audio-mp4.js?v=1.7.0',
  './js/mp4-muxer.js?v=1.7.0',
  './js/dsp.js?v=1.7.0',
  './js/arrange.js?v=1.7.0',
  './js/formats.js?v=1.7.0',
  './js/yt.js?v=1.7.0',
  './assets/Pretendard-ExtraBold.subset.woff2',
  './assets/daini-cat.jpg',
  './assets/daini-dog.jpg',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // HTTP 캐시를 건너뛰고 새 파일을 받아 둔다(버전 올릴 때 옛 파일이 남지 않게)
    await Promise.all(ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res);
      } catch (err) { /* 오프라인 설치 시도 등은 무시 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 외부 API는 그대로 통과
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone())).catch(() => {});
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

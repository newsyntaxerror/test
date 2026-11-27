/* 다인이 리믹스 스튜디오 — 오프라인 앱 셸 */
const VERSION = 'remix-v1.0.1';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/draw.js',
  './js/dsp.js',
  './js/analyze.js',
  './js/arrange.js',
  './js/formats.js',
  './js/yt.js',
  './assets/Pretendard-ExtraBold.subset.woff2',
  './assets/daini-cat.jpg',
  './assets/daini-dog.jpg',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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

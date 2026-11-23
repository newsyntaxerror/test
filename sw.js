/* 우리끼리 서비스 워커 — 앱 껍데기만 캐시해서 홈 화면 앱처럼 빠르게 뜨게 합니다.
   지도 타일(OpenStreetMap)·Supabase 요청은 캐시하지 않고 그대로 네트워크로 보냅니다. */
const CACHE = 'urikkiri-v22';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=22',
  './app.js?v=22',
  './config.js?v=22',
  './manifest.json',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;   // 지도 타일·서버 API는 건드리지 않음

  // 화면(HTML)·설정 파일: 네트워크 우선, 실패하면 캐시
  if (req.mode === 'navigate' || url.pathname.endsWith('/config.js')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // 정적 파일: 캐시 먼저 주고, 뒤에서 조용히 새 버전으로 갱신
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});

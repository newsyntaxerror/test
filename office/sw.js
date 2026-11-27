/* 달콩 비서실 서비스 워커 — 앱 껍데기만 캐시합니다.
   Supabase · AI API 요청은 캐시하지 않고 그대로 네트워크로 보냅니다. */
const CACHE = 'dalkong-office-v7';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=7',
  './app.js?v=7',
  './store.js?v=7',
  './ai.js?v=7',
  './config.js?v=7',
  './manifest.json',
  './vendor/supabase.js?v=7',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './supabase_office.sql',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
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

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'office-probe' || !data.url) return;
  const port = event.ports && event.ports[0];
  fetch(data.url, {
    headers: { apikey: data.key, authorization: 'Bearer ' + data.key },
    cache: 'no-store',
  })
    .then((res) => { if (port) port.postMessage({ status: res.status }); })
    .catch((err) => { if (port) port.postMessage({ status: 0, error: String(err) }); });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;      // Supabase · AI API 는 그대로 통과
  if (url.pathname.endsWith('/sw.js')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});

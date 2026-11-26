/* 비서 통합 회의실 — offline shell
   정책: HTML/CSS/JS 는 네트워크 우선(항상 최신), 실패 시 캐시.
   이미지·매니페스트는 캐시 우선.
   v9: 📊 AI-API-사용량 방의 '실시간 실측 새로고침' 버튼 → Supabase Edge Function(check-api-quotas) (v1.3.0) */
const CACHE = 'pickle-meeting-room-v14';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=1.3.0',
  './config.js?v=1.3.0',
  './vendor/supabase.js',
  './app.js?v=1.3.0',
  './manifest.webmanifest?v=1.3.0',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
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
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 문서: 네트워크 우선, 오프라인이면 캐시된 셸
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // 이미지/아이콘: 캐시 우선
  if (req.destination === 'image') {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // 스크립트/스타일/매니페스트: 네트워크 우선 → 실패 시 캐시
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

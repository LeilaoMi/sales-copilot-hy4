/* 销冠助手 · Service Worker：离线缓存静态资源，PWA 可添加到主屏幕
 *
 * 重要：只缓存本站静态资源。
 *   - /api/ 开头的请求绝不缓存（否则云同步会一直读到旧快照）
 *   - 跨域请求（AI 接口、Supabase、自建同步服务）不拦截，直接走网络
 */
const CACHE = 'sales-copilot-v2';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './store.js',
  './charts.js',
  './views.js',
  './ui.js',
  './ai.js',
  './sync.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // PUT 同步请求不拦

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // 跨域：AI / 同步接口直接放行
  if (url.pathname.indexOf('/api/') === 0) return;        // 同步接口永不缓存

  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        const c = resp.clone();
        caches.open(CACHE).then(cc => cc.put(req, c).catch(() => {}));
        return resp;
      }).catch(() => cached);
    })
  );
});

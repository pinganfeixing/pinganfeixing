/* service-worker.js — 伞迹 H5 离线 PWA
 *
 * 策略：预缓存应用外壳（index.html / css / js / manifest），
 * 运行时先网络、失败回退缓存（CDN 的 Cesium/ECharts 与卫星瓦片仍需联网）。
 * 版本号变更即清理旧缓存，避免更新后加载到过期外壳。
 */
var CACHE_NAME = 'sanji-h5-v1';
var APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/demo-data.js',
  './js/app-core.js',
  './js/storage.js',
  './js/main.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  // 只拦截同源 GET（CDN 资源交给浏览器默认行为，避免跨域缓存污染）
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then(function (resp) {
        // 网络成功 → 更新缓存副本（保持离线可用为最新外壳）
        if (resp && resp.ok) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put(e.request, clone); });
        }
        return resp;
      })
      .catch(function () {
        // 离线 → 回退缓存
        return caches.match(e.request, { ignoreSearch: true })
          .then(function (hit) { return hit || caches.match('./index.html'); });
      })
  );
});

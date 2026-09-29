/* 车间生产工作台 Service Worker —— 离线缓存与版本更新
 * 设计要点：
 *  - 安装时逐个缓存外壳资源，单个资源失败（如某图标缺失）不再导致整个 SW 无法激活；
 *  - 无论如何确保 index.html 一定进缓存，这是离线可用的核心；
 *  - 导航请求优先联网取最新，失败则回退到任意已缓存的 HTML；
 *  - 支持页面主动发 CACHE_SHELL 消息，随时补充预缓存离线包。
 */
var CACHE = 'cpw-shell-v5';
var SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

function cacheAll(cache, list) {
  // 逐个缓存：用 allSettled，单个失败不影响整体
  return Promise.allSettled(list.map(function (u) {
    return cache.add(u).catch(function () { /* 忽略单个失败 */ });
  }));
}

self.addEventListener('install', function (ev) {
  ev.waitUntil((async function () {
    var c = await caches.open(CACHE);
    await cacheAll(c, SHELL);
    // 关键：强制把 index.html 再缓存一次，确保离线核心可用
    try { await c.add('./index.html'); } catch (e) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.map(function (k) {
      if (k !== CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', function (ev) {
  var data = ev.data || {};
  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (data.type === 'CACHE_SHELL') {
    caches.open(CACHE).then(function (c) {
      return cacheAll(c, SHELL).then(function () {
        return c.add('./index.html').catch(function () {});
      });
    }).then(function () {
      if (ev.ports && ev.ports[0]) ev.ports[0].postMessage({ ok: true });
    });
  }
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  // 页面导航：优先联网取最新并刷新缓存，离线则回退任意已缓存 HTML
  if (req.mode === 'navigate') {
    ev.respondWith((async function () {
      try {
        var net = await fetch(req);
        var c = await caches.open(CACHE);
        c.put('./index.html', net.clone());
        c.put('./', net.clone());
        return net;
      } catch (e) {
        var hit = await caches.match(req)
          || await caches.match('./index.html')
          || await caches.match('./');
        if (hit) return hit;
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>离线资源未就绪</title>' +
          '<body style="font-family:sans-serif;padding:24px;line-height:1.8;">' +
          '<h3>暂时无法离线打开</h3><p>请先联网打开本应用一次（让系统缓存离线包），之后断网也能正常使用。</p></body>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  // 静态资源：缓存优先，未命中再联网并补缓存
  ev.respondWith((async function () {
    var hit = await caches.match(req);
    if (hit) return hit;
    try {
      var res = await fetch(req);
      if (res && res.status === 200 && (res.type === 'basic' || res.type === 'default')) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    } catch (e) {
      return hit || new Response('', { status: 504 });
    }
  })());
});

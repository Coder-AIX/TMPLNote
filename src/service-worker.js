/// <reference lib="webworker" />
/**
 * TMPLNote Service Worker（injectManifest 策略）
 *
 * 职责：
 *  1. 立即接管客户端（skipWaiting + clientsClaim），首次访问后刷新即可进入跨域隔离态。
 *  2. 预缓存构建产物并清理过期缓存（precacheAndRoute + cleanupOutdatedCaches）。
 *  3. 【核心】为同源「文档 / 导航」响应注入跨域隔离响应头：
 *       Cross-Origin-Opener-Policy:  same-origin
 *       Cross-Origin-Embedder-Policy: credentialless
 *     从而使 self.crossOriginIsolated === true，解锁 @wllama/wllama 的多线程推理（SharedArrayBuffer）。
 *  4. 运行时缓存 haronix 图标（jsdelivr CDN 上的 .svg）。
 *
 * 为什么必须由 Service Worker 注入响应头？
 *  生产环境托管在 GitHub Pages（纯静态），无法自定义 HTTP 响应头。
 *  COOP/COEP 属于响应头，只能由服务端下发；在无法控制服务端头的前提下，
 *  唯一可行使浏览器以「跨域隔离」方式加载文档的办法，就是让 SW 拦截文档响应并「重新包装」头部。
 *  注意：SW 注入的头对 SW 自身的脚本请求等场景生效，且需要页面在受控后才能进入隔离态——
 *  因此配合 skipWaiting + clientsClaim，让用户首次访问后刷新即进入隔离态。
 *
 * 构建说明：
 *  - 本文件由 vite-plugin-pwa 以 injectManifest 策略打包，`self.__WB_MANIFEST` 会被插件替换为预缓存清单，
 *    因此该字面量必须保留，不可重命名或手动赋值。
 */

import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';

// ── 1) 立即接管 ─────────────────────────────────────────────
// 不等待旧版本 SW 释放；配合下面的 fetch 注入，让页面尽快进入跨域隔离态。
self.skipWaiting();
clientsClaim();

// ── 2) 预缓存 + 清理旧缓存 ─────────────────────────────────
// 注意：本行必须出现在下方 fetch 监听器「之后」的注册顺序上，
// 见第 3) 节说明——这里先声明 fetch 监听器，再调用 precacheAndRoute。
// 为满足「fetch 先注册」的约束，precacheAndRoute 放到 fetch 监听器之后调用（见文件后半部分）。

// ── 3) 跨域隔离：为文档响应注入 COOP / COEP（核心） ────────
// 必须在 precacheAndRoute(...) 之前注册：先注册者先 respondWith，
// 确保导航/文档请求由本处理器接管；非文档请求直接 return，交给 workbox 路由处理。
const COOP = 'Cross-Origin-Opener-Policy';
const COEP = 'Cross-Origin-Embedder-Policy';

/**
 * 复制响应并追加跨域隔离头。
 * @param {Response} res
 * @returns {Response}
 */
function withCrossOriginIsolationHeaders(res) {
  // 复制 headers 后「追加」隔离头；用 credentialless 而非 require-corp，
  // 以免拦截 haronix-wc 从 cdn.jsdelivr.net 加载的跨域图标（无 CORP 头也不会被挡）。
  const headers = new Headers(res.headers);
  headers.set(COOP, 'same-origin');
  headers.set(COEP, 'credentialless');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理同源的 GET 导航 / 文档请求，其余直接放行给 workbox 路由。
  if (req.method !== 'GET') return;
  if (req.mode !== 'navigate' && req.destination !== 'document') return;

  let sameOrigin = false;
  try {
    sameOrigin = new URL(req.url).origin === self.location.origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return;

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        return withCrossOriginIsolationHeaders(res);
      } catch (err) {
        // 离线回退：网络失败时回退到预缓存的 index.html，并同样注入隔离头。
        // 用 self.registration.scope 解析相对路径，规避 GitHub Pages 子路径（如 /repo/）问题。
        try {
          const fallbackUrl = new URL('index.html', self.registration.scope).href;
          const cached = await matchPrecache(fallbackUrl);
          if (cached) return withCrossOriginIsolationHeaders(cached);
        } catch {
          // 忽略回退过程中的次级错误，向下抛出原始错误。
        }
        throw err;
      }
    })()
  );
});

// ── 2)（续）预缓存 + 清理旧缓存 ────────────────────────────
// 注册顺序要求：fetch 监听器必须先于 precacheAndRoute 注册，故此处调用。
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ── 4) 运行时缓存：haronix 图标 ─────────────────────────────
// 迁移自原 generateSW 配置的 runtimeCaching（CacheFirst + CacheableResponse + Expiration）。
registerRoute(
  ({ url }) => url.origin === 'https://cdn.jsdelivr.net' && url.pathname.endsWith('.svg'),
  new CacheFirst({
    cacheName: 'haronix-icons',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 31536000 }),
    ],
  })
);

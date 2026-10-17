import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * dev / preview 的跨域隔离头：
 * - Safari / iOS 不支持 credentialless，使用 require-corp；
 * - 其它浏览器使用 credentialless，避免拦截无 CORP 头的跨域图标。
 * 生产环境由 service-worker.js 按 UA 注入同样的头。
 */
function crossOriginIsolationHeaders() {
    /** @param {import('node:http').IncomingMessage} req */
    const pickCoep = (req) => {
        const ua = String(req.headers['user-agent'] || '');
        const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua));
        const safari = /Safari/i.test(ua) && !/Chrome|CriOS|Edg|OPR|Firefox|FxiOS/i.test(ua);
        return ios || safari ? 'require-corp' : 'credentialless';
    };
    /** @type {import('node:http').RequestListener} */
    const middleware = (req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', pickCoep(req));
        next();
    };
    return {
        name: 'coi-headers',
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        }
    };
}

// Cloudflare Pages 构建时自动注入 CF_PAGES=1；此时部署在根路径。
// 未设置时保持 GitHub Pages 项目子路径，兼容旧部署。
const isCloudflarePages = Boolean(process.env.CF_PAGES);
const base = isCloudflarePages ? '/' : '/TMPLNote/';

export default defineConfig({
    base,
    plugins: [
        crossOriginIsolationHeaders(),
        tailwindcss(),
        svelte(),
        VitePWA({
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'service-worker.js',
            registerType: 'autoUpdate',
            injectRegister: 'auto',
            includeAssets: ['icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'],
            manifest: {
                name: 'TMPLNote',
                short_name: 'TMPLNote',
                description: '基于 Svelte + PWA 的响应式笔记模板（左侧导航栏 + 右侧内容区）',
                lang: 'zh-CN',
                start_url: base,
                scope: base,
                display: 'standalone',
                theme_color: '#F6BF33',
                background_color: '#ffffff',
                icons: [
                    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
                    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
                    { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                    { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
                ],
            },
            injectManifest: {
                // 预缓存 wasm（推理引擎离线可用）；模型 GGUF 文件不入预缓存，由业务代码写入 Cache Storage 'ai-models'
                globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,wasm}'],
                // 允许预缓存大文件（wllama.wasm 约 8.7MB，默认上限仅 2MiB）
                maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
                // 说明：cleanupOutdatedCaches / navigateFallback / runtimeCaching 已移除，
                // 改由 src/service-worker.js 使用 workbox API 实现。
            },
            devOptions: {
                enabled: false,
            },
        }),
    ],
    server: {
        allowedHosts: [
            'nkziolmd.beesnat.com'
        ]
    },
});

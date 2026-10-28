import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { handleBridge } from './functions/_lib/bridge.js';

/**
 * dev / preview 的跨域隔离头：
 * - Safari / iOS 不支持 credentialless，使用 require-corp；
 * - 其它浏览器使用 credentialless，避免拦截无 CORP 头的跨域图标。
 * 生产环境由 service-worker.js 按 UA 注入同样的头。
 */
/**
 * dev / preview 的百度网盘桥接中间件：
 * 生产环境由 Cloudflare Pages Function 提供 /api/baidu，
 * 本地开发时用同一份 handleBridge 逻辑，方便完整联调上传/下载。
 */
function baiduBridgeDev() {
    /** @type {import('node:http').RequestListener} */
    const middleware = async (req, res, next) => {
        let pathname = '';
        try {
            pathname = new URL(req.url || '/', 'http://localhost').pathname;
        } catch {
            pathname = '';
        }
        if (pathname !== '/api/baidu') {
            next();
            return;
        }

        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

            const headers = new Headers();
            for (const [key, value] of Object.entries(req.headers)) {
                if (value === undefined) continue;
                if (Array.isArray(value)) headers.set(key, value.join(', '));
                else headers.set(key, value);
            }

            const request = new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
                method: req.method || 'GET',
                headers,
                body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
            });

            const response = await handleBridge(request);
            res.statusCode = response.status;
            response.headers.forEach((value, key) => {
                // 让 Node 自行计算长度，避免上游压缩后长度不一致。
                if (key.toLowerCase() === 'content-length') return;
                res.setHeader(key, value);
            });
            res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=UTF-8');
            res.end(
                JSON.stringify({
                    error: error?.message || '桥接服务内部错误。'
                })
            );
        }
    };

    return {
        name: 'baidu-bridge-dev',
        configureServer(server) {
            server.middlewares.use(middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(middleware);
        }
    };
}

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
        baiduBridgeDev(),
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
                // 允许预缓存大文件（默认上限仅 2MiB）：
                // - wllama.wasm 约 8.7MB（常规推理引擎）
                // - Safari/iOS 兼容构建的 compat wasm 约 16MB，需一并缓存以保障离线能力
                // 因此上限设为 20MiB，需大于最大的 compat wasm。
                maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
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

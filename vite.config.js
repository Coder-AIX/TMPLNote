import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    // GitHub Pages 项目页子路径：https://<user>.github.io/TMPLNote/
    base: '/TMPLNote/',
    plugins: [
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
                start_url: '/TMPLNote/',
                scope: '/TMPLNote/',
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
        headers: {
            // 启用跨域隔离以解锁 wllama 多线程（SharedArrayBuffer）。
            // 用 credentialless 避免拦截跨域图标（haronix-wc 从 jsdelivr 加载）。
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless',
        },
        allowedHosts: [
            'nkziolmd.beesnat.com'
        ]
    },
    preview: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless',
        },
    }
});

import { mount } from 'svelte';
import 'haronix-wc';
import 'haronix-wc/lucide';
import { setCollectionConfig } from 'haronix-wc/registry';
import App from './App.svelte';
import { loadSettings } from './lib/stores/settings.js';
import './app.css';
import '@opentiny/fluent-editor/style.css';
import './editor-overrides.css';

// 让 haronix 的 lucide 图标从本地 public/icons/lucide/ 加载，
// 避免 require-corp 下被跨域 CDN 拦截，同时支持离线。
setCollectionConfig('lucide', {
    baseUrl: `${import.meta.env.BASE_URL}icons/lucide/`
});

const app = mount(App, { target: document.getElementById('app') });

// 载入持久化设置并应用主题（异步，不阻塞首屏）
loadSettings();

export default app;

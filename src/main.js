import { mount } from 'svelte';
import 'haronix-wc';
import 'haronix-wc/lucide';
import App from './App.svelte';
import { loadSettings } from './lib/stores/settings.js';
import './app.css';
import '@opentiny/fluent-editor/style.css';
import './editor-overrides.css';

const app = mount(App, { target: document.getElementById('app') });

// 载入持久化设置并应用主题（异步，不阻塞首屏）
loadSettings();

export default app;
